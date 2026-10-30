// Content script: injected on demand by the background context, never
// declared in the manifest, so pages pay nothing until a translation is asked
// for. All provider traffic goes through the background context.

namespace AT.content {
  /** at/batch's reply. `translations` is what the success path reads; the
   *  other fields describe the failure the background reported instead. */
  export type BatchReply = {
    ok: boolean;
    translations: string[];
    detected?: string | null;
    engine?: string;
    error?: string;
    code?: AT.engines.EngineErrorCode | null;
  };

  /** A rejected batch keeps the engine's code when the background had one. */
  export type BatchError = Error & { code?: AT.engines.EngineErrorCode | null };

  /** at/content-translate: the background's verdict plus what we may know. */
  export type TranslateRequest = {
    decision?: AT.background.Plan;
    settings?: AT.settings.ContentSnapshot;
  };

  /** at/content-translate-selection. */
  export type SelectionRequest = {
    text?: string;
    settings?: AT.settings.ContentSnapshot;
  };

  /** One at/state-changed report about ourselves. */
  export type Patch = {
    status?: string;
    translated?: number;
    error?: string | null;
  };

  /** Everything the script keeps between messages. */
  export type State = {
    /** The page translation engine: planning, batching, write-back. */
    pipeline: AT.pipeline.PageTranslator | null;
    settings: AT.settings.ContentSnapshot | null;
    /** Whether the scroll listener that translates newly visible text is on. */
    scrollBound: boolean;
    /** Debounce for the scroll pass, apart from the mutation one. */
    scrollTimer: number;
    /** A scheduled re-check for a page whose content had not rendered yet. */
    pendingCheck: number;
    /** Mutations arrived while a pass was already running. */
    dirty: boolean;
    /** Regions the last mutations touched, waiting for the next tick. */
    roots: Element[];
    /** The queue overflowed: the next tick reads the whole page instead. */
    full: boolean;
    /** A pass is in flight; a tick must not start a second one. */
    working: boolean;
    observer: MutationObserver | null;
    timer: number;
    card: HTMLElement | null;
    busy: Promise<AT.MessageResult | undefined>;
  };

  /** The handle on globalThis that makes a second injection a no-op. */
  export type Boot = {
    version: string;
    state: State;
  };
}

// The marker this script leaves behind for the page and for its own re-entry
// guard; declared here so `globalThis.__autotranslate` needs no cast.
declare var __autotranslate: AT.content.Boot | undefined;

(() => {
  if (globalThis.__autotranslate) return;

  const C = AT.C;

  const state: AT.content.State = {
    pipeline: null,
    settings: null,
    scrollBound: false,
    scrollTimer: 0,
    pendingCheck: 0,
    dirty: false,
    roots: [],
    full: false,
    working: false,
    observer: null,
    timer: 0,
    card: null,
    busy: Promise.resolve(undefined)
  };

  globalThis.__autotranslate = {
    version: AT.runtime?.getManifest?.().version ?? 'dev',
    state
  };

  async function requestBatch(
    batch: Pick<AT.pipeline.Batch, 'texts' | 'role' | 'context'>,
    settings: AT.settings.ContentSnapshot
  ): Promise<string[]> {
    const texts = batch.texts;
    const response = (await AT.sendMessage({
      type: C.MSG.BATCH,
      texts,
      targetLang: settings.targetLang,
      sourceLang: settings.sourceLang,
      url: location.href,
      // Read once per pass. Only a context that would actually change the
      // prompt is sent: an unidentified page adds nothing to a request.
      context: AT.pagecontext.hint(batch.context) ? batch.context : null,
      role: batch.role
    })) as AT.content.BatchReply | undefined;
    if (!response?.ok) {
      const error = new Error(response?.error ?? 'the background context rejected the batch') as AT.content.BatchError;
      error.code = response?.code ?? null;
      throw error;
    }
    return response.translations;
  }

  /** One engine per page: it keeps the records restore() needs. */
  function ensurePipeline(settings: AT.settings.ContentSnapshot): AT.pipeline.PageTranslator {
    if (!state.pipeline) {
      state.pipeline = AT.pipeline.create({
        doc: document,
        settings: () => {
          const current = state.settings ?? settings;
          // The on-device engine is bounded by tokens, not characters: its
          // batches should be as large as the model allows, and the engine
          // packs them by counting tokens. The character budget is what a cloud
          // provider bills, so it stays for them.
          const local = current.engine === 'local';
          return {
            maxNodes: current.maxNodes,
            batchChars: local ? Math.max(current.batchChars, C.LOCAL_BATCH_CHARS) : current.batchChars
          };
        },
        // Read settings from state so a later target-language change applies
        // without re-injecting the script.
        translate: (batch) => requestBatch(batch, state.settings ?? settings),
        // A long paragraph is several sentences; sending it whole either
        // overflows the model's context or gets cut mid-clause by the char
        // chunker. Split first, rejoin in place.
        sentences: { split: AT.targets.sentences, maxChars: C.SENTENCE_MAX_CHARS }
      });
    }
    return state.pipeline;
  }

  // 'translate' always, 'skip' never, 'detect' compares the declared page
  // language with the target language.
  /**
   * The page's own words, for the detector: title, headings and the first
   * paragraphs of the main content. `html[lang]` alone is not enough — YouTube
   * serves a localised shell around a foreign title, description and comments.
   */
  function contentSample(): string {
    const pick = (selector: string, limit: number): string[] => {
      const out: string[] = [];
      for (const node of Array.from(document.querySelectorAll(selector))) {
        const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (text.length >= 20) out.push(text);
        if (out.length >= limit) break;
      }
      return out;
    };
    const chosen = [
      document.title,
      ...pick('h1, h2', 3),
      ...pick('#description-inline-expander, article p, main p, [itemprop="description"], p', 3)
    ].filter((part) => typeof part === 'string' && part.trim().length > 0);
    // Nothing content-bearing yet. The shell of a localised site is in the
    // target language while the article is not, so this is the last resort,
    // never a substitute for text the page actually offers.
    if (chosen.length === 0) {
      const body = (document.body?.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (body) chosen.push(body.slice(0, 200));
    }
    return chosen.join(' ').slice(0, 400);
  }

  /**
   * Translate, skip, or wait for the page to render.
   *
   * `wait` exists because of single-page apps: YouTube is already `complete` and
   * claims `ko-KR` before its video title, description and comments exist. Judging
   * an empty page says "already in the target language", and nothing ever
   * translates afterwards. Waiting for actual content is the difference between
   * "not translated" and "translated once the page is there".
   */
  type Verdict = 'translate' | 'skip' | 'wait';

  async function decideTranslation(
    decision: AT.background.Plan,
    settings: AT.settings.ContentSnapshot
  ): Promise<Verdict> {
    if (!settings.enabled) return 'skip';
    if (decision.action === 'translate') return 'translate';
    if (decision.action === 'skip') return 'skip';
    if (settings.sourceLang && settings.sourceLang !== 'auto') return 'translate';
    const declared = (document.documentElement?.lang ?? '').trim();
    if (declared && !C.sameLanguage(declared, settings.targetLang)) return 'translate';
    const sample = contentSample();
    // Nothing to judge yet: the app has not rendered its content.
    if (sample.replace(/\s+/g, '').length < 12) return 'wait';
    // The page claims to be in the target language. Ask the browser's detector
    // about the content itself before believing it.
    const detected = await AT.detectLanguage(sample);
    if (!detected) {
      // No detector answer: trust a declaration, and translate when there is
      // none, because an untagged page is the one most likely to need it.
      return declared ? 'skip' : 'translate';
    }
    return C.sameLanguage(detected.code, settings.targetLang) ? 'skip' : 'translate';
  }

  /** How often and how long to wait for a page that renders after load. */
  const CONTENT_RETRY_DELAYS = [400, 1200, 3000, 6000];

  function scheduleContentCheck(settings: AT.settings.ContentSnapshot): void {
    const attempt = (index: number): void => {
      if (index >= CONTENT_RETRY_DELAYS.length) {
        state.pendingCheck = 0;
        // Still nothing to judge: leave the page alone rather than guess.
        return;
      }
      state.pendingCheck = globalThis.setTimeout(() => {
        state.pendingCheck = 0;
        decideTranslation({ action: 'detect', reason: 'auto' }, state.settings ?? settings)
          .then((verdict) => {
            if (verdict === 'translate') return runTranslation(state.settings ?? settings);
            if (verdict === 'wait') attempt(index + 1);
          })
          .catch((error) => AT.warn('content check failed', error));
      }, CONTENT_RETRY_DELAYS[index] ?? 1000);
    };
    attempt(0);
  }

  function report(patch: AT.content.Patch): Promise<AT.Response | void> {
    return AT.sendMessage({
      type: C.MSG.STATE_CHANGED,
      status: patch.status,
      translated: patch.translated ?? 0,
      error: patch.error ?? null
    }).catch(() => {});
  }

  function stopObserver(): void {
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    clearTimeout(state.timer);
    state.timer = 0;
  }

  function scheduleTick(): void {
    if (state.timer !== 0) {
      // A busy page - video progress, ads, live counters - mutates faster than
      // the debounce. Resetting the timer every time meant it never fired and
      // nothing new was ever translated. Keep the pending tick and remember
      // that another one is due.
      state.dirty = true;
      return;
    }
    state.timer = setTimeout(() => {
      state.timer = 0;
      state.dirty = false;
      runTick()
        .catch((error) => AT.warn('dynamic translation failed', error))
        .finally(() => {
          if (state.dirty) scheduleTick();
        });
    }, C.OBSERVER_DEBOUNCE_MS);
  }

  /** How many changed regions one tick may visit before it reads the page. */
  const MAX_TICK_ROOTS = 32;

  /**
   * Where the browser just changed something worth translating.
   *
   * A MutationObserver that ignores its records has to assume the whole page
   * changed, which on a feed means re-reading thousands of nodes many times a
   * second. The records say where the text appeared: an insertion is a new
   * subtree, a text edit is one node. Our own write-back is dropped (the node
   * already holds its translation), so a pass never schedules work for itself.
   *
   * `null` means "too much changed to be specific": the caller reads the page.
   */
  function changedRegions(records: MutationRecord[]): Element[] | null {
    const roots: Element[] = [];
    let whole = false;
    const add = (candidate: Element | null | undefined): void => {
      if (whole || !candidate || candidate.isConnected === false) return;
      if (candidate === document.body || candidate === document.documentElement) {
        whole = true;
        return;
      }
      if (AT.dom.isIgnoredElement(candidate)) return;
      if (roots.some((known) => known.contains(candidate))) return;
      for (let index = roots.length - 1; index >= 0; index -= 1) {
        const known = roots[index];
        if (known && candidate.contains(known)) roots.splice(index, 1);
      }
      roots.push(candidate);
      if (roots.length > MAX_TICK_ROOTS) whole = true;
    };
    for (const record of records) {
      if (record.type === 'characterData') {
        const node = record.target as Text;
        if (!AT.dom.hasText(node.nodeValue)) continue;
        // Our own write: already translated, nothing to read.
        if (state.pipeline?.isTranslated(node)) continue;
        add(node.parentElement);
        continue;
      }
      if (record.type !== 'childList') continue;
      // A removal leaves nothing to translate.
      for (const node of Array.from(record.addedNodes ?? [])) {
        if (node.nodeType === 3) {
          if (AT.dom.hasText((node as Text).nodeValue)) add((node as Text).parentElement);
        } else if (node.nodeType === 1) {
          add(node as Element);
        }
      }
    }
    return whole ? null : roots;
  }

  /** Merge the new regions into the queue, keeping only the outer ones. */
  function enqueue(regions: Element[] | null): void {
    if (state.full) return;
    if (regions === null) {
      state.full = true;
      state.roots = [];
      return;
    }
    for (const region of regions) {
      if (state.roots.some((known) => known.contains(region))) continue;
      for (let index = state.roots.length - 1; index >= 0; index -= 1) {
        const known = state.roots[index];
        if (known && region.contains(known)) state.roots.splice(index, 1);
      }
      state.roots.push(region);
      if (state.roots.length > MAX_TICK_ROOTS) {
        state.full = true;
        state.roots = [];
        return;
      }
    }
  }

  function onMutations(records: MutationRecord[]): void {
    enqueue(changedRegions(records));
    if (!state.full && state.roots.length === 0) return;
    scheduleTick();
  }

  /** What this tick should read: specific regions, or the page. */
  function takeQueue(): Element[] | 'full' | null {
    const whole = state.full;
    const regions = state.roots;
    state.full = false;
    state.roots = [];
    if (whole) return 'full';
    return regions.length > 0 ? regions : null;
  }

  function startObserver(): void {
    if (state.observer || !state.pipeline) return;
    state.observer = new MutationObserver(onMutations);
    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  /** A page is longer than a screen: translate what scrolls into view. */
  function scheduleViewportPass(): void {
    if (!state.settings?.enabled || !state.pipeline) return;
    if (state.scrollTimer) return;
    state.scrollTimer = globalThis.setTimeout(() => {
      state.scrollTimer = 0;
      state.pipeline
        ?.refresh(document.documentElement, C.OBSERVER_BATCH_NODES)
        .catch((error) => AT.warn('viewport translation failed', error));
    }, C.OBSERVER_DEBOUNCE_MS);
  }

  type ScrollTarget = {
    addEventListener?: (type: string, listener: () => void, options?: { passive?: boolean }) => void;
    removeEventListener?: (type: string, listener: () => void) => void;
  };

  function startViewportPass(): void {
    if (state.scrollBound) return;
    const target = globalThis as unknown as ScrollTarget;
    if (typeof target.addEventListener !== 'function') return;
    target.addEventListener('scroll', scheduleViewportPass, { passive: true });
    state.scrollBound = true;
  }

  function stopViewportPass(): void {
    if (!state.scrollBound) return;
    const target = globalThis as unknown as ScrollTarget;
    if (typeof target.removeEventListener === 'function') target.removeEventListener('scroll', scheduleViewportPass);
    state.scrollBound = false;
  }

  async function runTick(): Promise<void> {
    const pipeline = state.pipeline;
    if (!pipeline || !state.settings?.enabled) return;
    if (state.working) {
      // A pass is already running. Ask for another tick when it finishes
      // instead of interleaving two passes over the same nodes.
      state.dirty = true;
      return;
    }
    const queue = takeQueue();
    if (!queue) return;
    const regions = queue === 'full' ? [document.body ?? document.documentElement] : queue;
    state.working = true;
    // Background passes take a small slice: a page that keeps mutating (a video
    // site re-rendering its feed) must not hold the single model for minutes.
    let left = C.OBSERVER_BATCH_NODES;
    let requested = 0;
    let translated = 0;
    let more = false;
    try {
      for (const region of regions) {
        if (left <= 0) {
          more = true;
          break;
        }
        // The page may have removed the region between the mutation and now.
        if (region.isConnected === false) continue;
        const result = await pipeline.refresh(region, left);
        requested += result.requested;
        translated = result.translated;
        left -= Math.min(result.requested, left);
        if (result.requested >= C.OBSERVER_BATCH_NODES) more = true;
      }
    } finally {
      state.working = false;
      if (state.dirty) {
        state.dirty = false;
        scheduleTick();
      }
    }
    // A tick that found nothing new must not move the badge or the status.
    if (requested === 0) return;
    await report({ status: 'translated', translated });
    // The budget was spent, so there is more to do. Waiting for the page to
    // change again would leave a quiet page half translated.
    if (more) requestFullPass();
  }

  /** Ask for one pass over the whole page (the queue has no regions). */
  function requestFullPass(): void {
    state.full = true;
    scheduleTick();
  }

  /** One full pass over the page, then keep up with what changes. */
  async function runTranslation(settings: AT.settings.ContentSnapshot): Promise<AT.MessageResult> {
    const pipeline = ensurePipeline(settings);
    // More nodes than one pass may translate: carry on by ourselves.
    const result = await pipeline.translate();
    startObserver();
    startViewportPass();
    if (result.requested >= settings.maxNodes) requestFullPass();
    // A partly translated page is still worth showing; say what went wrong
    // instead of failing the whole pass.
    await report({ status: 'translated', translated: result.translated, error: result.error });
    return {
      status: 'translated',
      translated: result.translated,
      requested: result.requested,
      failed: result.failed,
      error: result.error
    };
  }

  async function translate(message: AT.content.TranslateRequest): Promise<AT.MessageResult> {
    const settings = message.settings;
    if (!settings) throw new Error('translate request without settings');
    state.settings = settings;
    const decision = message.decision ?? { action: 'translate' };
    const verdict = await decideTranslation(decision, settings);
    if (verdict === 'wait') {
      // A single-page app has not rendered its content yet. Do not answer "skip"
      // and forget: look again when the page has something to judge.
      scheduleContentCheck(settings);
      await report({ status: 'idle' });
      return { status: 'idle', reason: 'waiting-for-content' };
    }
    if (verdict === 'skip') {
      await report({ status: 'idle' });
      return { status: 'idle', reason: decision.reason ?? 'language-matches-target' };
    }
    try {
      return await runTranslation(settings);
    } catch (error: unknown) {
      // Nobody is listening for the reply on an automatic pass; record the
      // failure so the popup and badge can say what happened.
      await report({ status: 'error', error: String((error as { message?: unknown })?.message ?? error) });
      throw error;
    }
  }

  async function restore(): Promise<AT.MessageResult> {
    stopObserver();
    stopViewportPass();
    const restored = state.pipeline ? state.pipeline.restore().restored : 0;
    await report({ status: 'idle' });
    return { status: 'idle', restored };
  }

  function closeCard(): void {
    if (state.card) {
      state.card.remove();
      state.card = null;
    }
  }

  function showCard(text: string, settings?: AT.settings.ContentSnapshot): void {
    closeCard();
    const card = document.createElement('div');
    card.setAttribute('data-no-translate', '');
    card.setAttribute(
      'dir',
      // Indexed, not `.has()`: RTL_LANGS is a plain table, so an inherited key
      // must not read as RTL.
      C.RTL_LANGS[settings?.targetLang ?? ''] === true ? 'rtl' : 'ltr'
    );
    card.setAttribute(
      'style',
      [
        'all:initial',
        'position:fixed',
        'z-index:2147483647',
        'inset:auto 16px 16px auto',
        'max-width:22rem',
        'padding:12px 14px',
        'border-radius:10px',
        'border:1px solid rgba(0,0,0,.18)',
        'background:#fffff8',
        'color:#1c1c1c',
        'font:14px/1.5 system-ui,sans-serif',
        'box-shadow:0 6px 24px rgba(0,0,0,.22)',
        'white-space:pre-wrap'
      ].join(';')
    );
    const body = document.createElement('p');
    body.setAttribute(
      'style',
      'all:unset;display:block;max-height:14rem;overflow:auto;white-space:pre-wrap'
    );
    body.textContent = text;
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '\u00d7';
    close.setAttribute('aria-label', AT.i18n.msg('content_close'));
    close.setAttribute(
      'style',
      'all:unset;position:absolute;inset:4px 6px auto auto;cursor:pointer;padding:2px 6px;font:16px/1 system-ui,sans-serif'
    );
    close.addEventListener('click', closeCard);
    card.append(body, close);
    document.documentElement.appendChild(card);
    state.card = card;
  }

  async function translateSelection(message: AT.content.SelectionRequest): Promise<AT.MessageResult> {
    const settings = message.settings ?? state.settings;
    if (!settings) throw new Error('selection request without settings');
    state.settings = settings;
    const selected = String(message.text ?? globalThis.getSelection?.()?.toString() ?? '').trim();
    if (selected.length < 2) {
      showCard(AT.i18n.msg('content_noSelection'), settings);
      return { status: 'empty' };
    }
    const [translated] = await requestBatch({ texts: [selected], role: 'unknown', context: null }, settings);
    showCard(translated || selected, settings);
    return { status: 'selection' };
  }

  // The message bodies cross contexts: the table narrows each one to the shape
  // its handler reads, once.
  AT.onMessage({
    [C.MSG.CONTENT_PING]: () => ({ pong: true }),
    [C.MSG.CONTENT_TRANSLATE]: (message) => {
      const request = message as AT.content.TranslateRequest;
      state.busy = state.busy.then(() => translate(request), () => translate(request));
      return state.busy;
    },
    [C.MSG.CONTENT_RESTORE]: () => {
      state.busy = state.busy.then(() => restore(), () => restore());
      return state.busy;
    },
    [C.MSG.CONTENT_TRANSLATE_SELECTION]: (message) => translateSelection(message as AT.content.SelectionRequest)
  });
})();

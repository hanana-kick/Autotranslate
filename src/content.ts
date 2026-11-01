// Content script: injected on demand by the background context, never
// declared in the manifest, so pages pay nothing until a translation is asked
// for. Every model call goes through the background context.

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
    /** Monotonic session identity: an old result can never join a new session. */
    epoch: number;
    settingsKey: string | null;
    commandPending: boolean;
    /** Mutations arrived while a pass was already running. */
    dirty: boolean;
    /** Regions the last mutations touched, waiting for the next tick. */
    roots: Element[];
    /** The queue overflowed: the next tick reads the whole page instead. */
    full: boolean;
    /** Known pending work is not a new mutation and needs no debounce. */
    continuation: boolean;
    immediateTimer: boolean;
    /** A pass is in flight; a tick must not start a second one. */
    working: boolean;
    observer: MutationObserver | null;
    timer: number;
    card: HTMLElement | null;
    busy: Promise<AT.MessageResult | undefined>;
    /** Set by restore(): a pass in flight stops writing its answers. */
    stopped: boolean;
    /** The target language the current pipeline was built for. */
    targetLang: string | null;
    /** Last progress report, so a long pass is not silent in the UI. */
    lastReport: number;
    /** What the last report said, so a tab can answer for itself. */
    lastStatus: string;
    lastTranslated: number;
    lastError: string | null;
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
    epoch: 0,
    settingsKey: null,
    commandPending: false,
    dirty: false,
    roots: [],
    full: false,
    continuation: false,
    immediateTimer: false,
    working: false,
    observer: null,
    timer: 0,
    card: null,
    busy: Promise.resolve(undefined),
    stopped: false,
    targetLang: null,
    lastReport: 0,
    lastStatus: 'idle',
    lastTranslated: 0,
    lastError: null
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
      type: C.MSG.BATCH, ...(settings.tabEpoch === undefined ? {} : { tabEpoch: settings.tabEpoch }),
      texts,
      targetLang: settings.targetLang,
      sourceLang: settings.sourceLang,
      ...(settings.translationKey ? { translationKey: settings.translationKey } : {}),
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
      const epoch = state.epoch;
      const snapshot = { ...settings };
      state.pipeline = AT.pipeline.create({
        doc: document,
        settings: () => ({ maxNodes: snapshot.maxNodes }),
        // A pass owns an immutable settings snapshot, not mutable global state.
        translate: (batch) => requestBatch(batch, snapshot),
        // Each paragraph is one unit; token splitting stays in the engine.
        sentences: { split: AT.targets.sentences, maxChars: C.SENTENCE_MAX_CHARS, always: true },
        // A restore in another task owns the page: stop writing.
        shouldAbort: () => state.stopped || state.epoch !== epoch,
        // A pass over a long page takes a minute; say so while it works.
        onProgress: ({ translated }) => {
          if (state.stopped || state.epoch !== epoch) return;
          const now = Date.now();
          if (now - state.lastReport < 700) return;
          state.lastReport = now;
          void report({ status: 'translating', translated });
        }
      });
    }
    return state.pipeline;
  }

  function report(patch: AT.content.Patch): Promise<AT.Response | void> {
    state.lastStatus = patch.status ?? state.lastStatus;
    state.lastTranslated = patch.translated ?? state.lastTranslated;
    state.lastError = patch.error ?? null;
    return AT.sendMessage({
      type: C.MSG.STATE_CHANGED,
      ...(state.settings?.tabEpoch === undefined ? {} : { tabEpoch: state.settings.tabEpoch }),
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

  function scheduleTick(immediate = false): void {
    if (state.stopped || !state.pipeline) return;
    if (state.working) { state.dirty = true; return; }
    if (state.timer !== 0 && immediate && !state.immediateTimer) {
      clearTimeout(state.timer);
      state.timer = 0;
    }
    if (state.timer !== 0) {
      // A busy page - video progress, ads, live counters - mutates faster than
      // the debounce. Resetting the timer every time meant it never fired and
      // nothing new was ever translated. Keep the pending tick and remember
      // that another one is due.
      state.dirty = true;
      return;
    }
    state.immediateTimer = immediate;
    state.timer = setTimeout(() => {
      state.timer = 0;
      state.immediateTimer = false;
      state.dirty = false;
      runTick()
        .catch(async (error) => {
          AT.warn('dynamic translation failed', error);
          state.full = false; state.continuation = false; state.dirty = false; state.roots = [];
          await report({ status: 'error', translated: state.pipeline?.stats().translated ?? 0,
            error: String((error as Error)?.message ?? error) });
        })
        .finally(() => {
          if (state.dirty || state.continuation) scheduleTick(state.continuation);
        });
    }, immediate ? 0 : C.OBSERVER_DEBOUNCE_MS);
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
      if (record.type === 'attributes') {
        add(record.target as Element);
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
    const regions = changedRegions(records);
    if (regions === null || regions.length) state.pipeline?.invalidatePlan();
    enqueue(regions);
    if (!state.full && state.roots.length === 0) return;
    scheduleTick();
  }

  /** What this tick should read: specific regions, or the page. */
  function takeQueue(): Element[] | 'full' | 'continue' | null {
    const whole = state.full;
    const regions = state.roots;
    state.full = false;
    state.roots = [];
    if (whole) return 'full';
    if (regions.length) return regions;
    if (state.continuation) { state.continuation = false; return 'continue'; }
    return null;
  }

  function startObserver(): void {
    if (state.observer || !state.pipeline) return;
    state.observer = new MutationObserver(onMutations);
    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['hidden', 'open', 'style', 'class', 'aria-hidden', 'translate']
    });
  }

  /** A page is longer than a screen: translate what scrolls into view. */
  function scheduleViewportPass(): void {
    if (!state.settings?.enabled || !state.pipeline || state.stopped) return;
    // Scroll and mutations share a scheduler. Separate promise queues could
    // accumulate obsolete full-page passes behind a slow generation.
    requestFullPass();
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
    target.addEventListener('resize', scheduleViewportPass, { passive: true });
    state.scrollBound = true;
  }

  function stopViewportPass(): void {
    if (!state.scrollBound) return;
    const target = globalThis as unknown as ScrollTarget;
    if (typeof target.removeEventListener === 'function') {
      target.removeEventListener('scroll', scheduleViewportPass);
      target.removeEventListener('resize', scheduleViewportPass);
    }
    state.scrollBound = false;
  }

  async function runTick(): Promise<void> {
    const pipeline = state.pipeline;
    const epoch = state.epoch;
    if (!pipeline || !state.settings?.enabled || state.stopped) return;
    if (state.working) {
      // A pass is already running. Ask for another tick when it finishes
      // instead of interleaving two passes over the same nodes.
      state.dirty = true;
      return;
    }
    const queue = takeQueue();
    if (!queue) return;
    const continuing = queue === 'continue';
    const regions = queue === 'full' || continuing ? [document.documentElement] : queue;
    state.working = true;
    // Background passes take a small slice: a page that keeps mutating (a video
    // site re-rendering its feed) must not hold the single model for minutes.
    let left = C.OBSERVER_BATCH_NODES;
    let processed = 0;
    let translated = 0;
    let more = false;
    let failure: string | null = null;
    try {
      for (const region of regions) {
        if (epoch !== state.epoch || state.stopped) break;
        if (left <= 0) {
          more = true;
          break;
        }
        // The page may have removed the region between the mutation and now.
        if (region.isConnected === false) continue;
        const result = continuing ? await pipeline.resume(left) : await pipeline.refresh(region, left);
        if (epoch !== state.epoch || state.stopped) break;
        processed += result.processedNodes;
        translated = result.translated;
        if (result.failed || result.error) failure ??= result.error ?? 'translation incomplete';
        left -= Math.min(result.processedNodes, left);
        if (result.hasMore) more = true;
      }
    } finally {
      if (epoch === state.epoch) {
        state.working = false;
        if (state.dirty) { state.dirty = false; scheduleTick(state.continuation); }
      }
    }
    if (epoch !== state.epoch || state.stopped) return;
    // Cached work may make no model requests at all, but still has DOM work
    // left. Continuation is the planner's decision, not a request-count guess.
    if (more) requestContinuation();
    if (processed > 0) await report({ status: failure ? 'error' : (more ? 'translating' : 'translated'), translated, error: failure });
  }

  /** Ask for one pass over the whole page (the queue has no regions). */
  function requestContinuation(): void {
    state.continuation = true;
    scheduleTick(true);
  }

  function requestFullPass(): void {
    state.pipeline?.invalidatePlan();
    state.full = true;
    scheduleTick();
  }

  function sessionKey(settings: AT.settings.ContentSnapshot): string {
    return JSON.stringify([settings.translationKey ?? '', settings.tabEpoch, settings.targetLang, settings.sourceLang, settings.maxNodes]);
  }

  /** Control commands bypass the work queue. This is synchronous up to the UI report. */
  function invalidate(): number {
    state.epoch++;
    state.stopped = true;
    state.commandPending = false;
    state.dirty = false;
    state.full = false;
    state.continuation = false;
    state.roots = [];
    state.working = false;
    state.targetLang = null;
    state.settingsKey = null;
    stopObserver();
    stopViewportPass();
    const restored = state.pipeline?.restore().restored ?? 0;
    state.pipeline = null;
    return restored;
  }

  /** Observe before the first asynchronous generation: a page may render late. */
  async function runTranslation(settings: AT.settings.ContentSnapshot): Promise<AT.MessageResult> {
    const key = sessionKey(settings);
    if (!state.pipeline || state.stopped || state.settingsKey !== key) {
      invalidate();
      state.settings = Object.freeze({ ...settings });
      state.settingsKey = key;
      state.targetLang = settings.targetLang;
      state.stopped = false;
    }
    const epoch = state.epoch;
    const pipeline = ensurePipeline(settings);
    state.working = true;
    startObserver();
    startViewportPass();
    try {
      // Yield the initial pass too: a large feed must not pin an obsolete
      // viewport plan while newly inserted, visible text waits behind it.
      const result = await pipeline.translate(C.OBSERVER_BATCH_NODES);
      if (epoch !== state.epoch || state.stopped) return { status: 'cancelled' };
      if (result.hasMore) requestContinuation();
      const status = result.failed || result.error ? 'error' : (result.hasMore ? 'translating' : 'translated');
      await report({ status, translated: result.translated, error: result.error });
      return { status, translated: result.translated, requested: result.requested,
        failed: result.failed, error: result.error };
    } finally {
      if (epoch === state.epoch) {
        state.working = false;
        if (state.dirty || state.full || state.roots.length || state.continuation) {
          state.dirty = false;
          scheduleTick(state.continuation);
        }
      }
    }
  }

  async function translate(message: AT.content.TranslateRequest): Promise<AT.MessageResult> {
    const settings = message.settings;
    if (!settings) throw new Error('translate request without settings');
    const decision = message.decision ?? { action: 'translate' };
    if (!settings.enabled || decision.action === 'skip') {
      await restore();
      return { status: 'idle', reason: decision.reason ?? 'disabled' };
    }
    const task = runTranslation(settings);
    const epoch = state.epoch;
    try {
      return await task;
    } catch (error: unknown) {
      if (epoch !== state.epoch || state.stopped) return { status: 'cancelled' };
      // A wholly failed pass must not retry the same broken configuration on
      // every page mutation. Keep completed records for an explicit retry.
      stopObserver();
      stopViewportPass();
      state.dirty = false;
      state.full = false;
      state.continuation = false;
      state.roots = [];
      await report({ status: 'error', error: String((error as { message?: unknown })?.message ?? error) });
      throw error;
    }
  }

  async function restore(): Promise<AT.MessageResult> {
    const restored = invalidate();
    closeCard();
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

  /** A selection longer than this is cut at a sentence boundary, not sent whole. */
  const SELECTION_MAX_PARTS = 12;

  async function translateSelection(message: AT.content.SelectionRequest): Promise<AT.MessageResult> {
    const settings = message.settings ?? state.settings;
    if (!settings) throw new Error('selection request without settings');
    state.settings = settings;
    const selected = String(message.text ?? globalThis.getSelection?.()?.toString() ?? '').trim();
    if (selected.length < 2) {
      showCard(AT.i18n.msg('content_noSelection'), settings);
      return { status: 'empty' };
    }
    // A Ctrl+A selection is a whole page in one prompt: split it like a long
    // paragraph and cap it, or the model works for minutes on one generation.
    const parts = AT.targets.sentences(selected).slice(0, SELECTION_MAX_PARTS);
    const gap = /\s/.test(selected) ? ' ' : '';
    const texts = parts.length > 1 ? parts : [selected.slice(0, C.SENTENCE_MAX_CHARS)];
    const epoch = state.epoch;
    const translated = await requestBatch({ texts, role: 'unknown', context: null }, settings);
    if (epoch !== state.epoch) return { status: 'cancelled' };
    showCard(translated.filter((text) => text).join(gap) || selected, settings);
    return { status: 'selection' };
  }

  // The message bodies cross contexts: the table narrows each one to the shape
  // its handler reads, once.
  AT.onMessage({
    [C.MSG.CONTENT_PING]: () => ({ pong: true }),
    // The worker may have been suspended since it last heard from this tab.
    [C.MSG.CONTENT_STATE]: () => ({
      status: state.lastStatus,
      translated: state.lastTranslated,
      error: state.lastError
    }),
    [C.MSG.CONTENT_TRANSLATE]: (message) => {
      const request = message as AT.content.TranslateRequest;
      if (state.commandPending && request.settings?.enabled && request.decision?.action !== 'skip' &&
          state.settingsKey === sessionKey(request.settings)) return state.busy;
      const task = translate(request);
      const epoch = state.epoch;
      state.commandPending = true;
      state.busy = task.finally(() => { if (epoch === state.epoch) state.commandPending = false; });
      return state.busy;
    },
    [C.MSG.CONTENT_RESTORE]: () => restore(),
    [C.MSG.CONTENT_TRANSLATE_SELECTION]: (message) => translateSelection(message as AT.content.SelectionRequest)
  });
})();

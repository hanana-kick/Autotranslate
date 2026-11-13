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
    /** Where a local batch spent its time; absent for a server engine. */
    timing?: { countMs: number; hostMs: number; chunks: number };
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

  /** One model request as the page measured it. The reader's latency unit:
   *  asking for a batch and getting its translations back. */
  export type BenchEntry = {
    index: number;
    /** Milliseconds from the first request of the session to this one starting. */
    at: number;
    ms: number;
    texts: number;
    role: string;
    /** Token counting before the generation, when the host reported it. */
    countMs?: number;
    /** The generation itself, host side. */
    hostMs?: number;
    /** Chunks the engine split the batch into. */
    chunks?: number;
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
    /** Debug overlay: the outline layer, its panel, the regions it draws, and
     *  the two handles that keep them in place while the page scrolls. */
    overlay: HTMLElement | null;
    overlayPanel: HTMLElement | null;
    overlayRegions: AT.pipeline.DebugRegion[];
    overlayPass: AT.pipeline.DebugPass | null;
    overlayTimer: number;
    overlayBound: boolean;
    /** Coalesced next-task continuation after a viewport change. */
    viewportTimer: number;
    /** Model requests of this session, oldest first, for the speed report. */
    bench: BenchEntry[];
    benchStarted: number;
    /** The user closed the panel on this page; keep it closed. */
    overlayClosed: boolean;
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
    lastError: null,
    overlay: null,
    overlayPanel: null,
    overlayRegions: [],
    overlayPass: null,
    overlayTimer: 0,
    overlayBound: false,
    overlayClosed: false,
    viewportTimer: 0,
    bench: [],
    benchStarted: 0
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
    const started = Date.now();
    const response = (await AT.sendMessage({
      type: C.MSG.BATCH,
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
    // The round trip a reader waits for: request out, translations back. The
    // first one of a session carries the model load, later ones do not.
    const ms = Date.now() - started;
    if (state.benchStarted === 0) state.benchStarted = started;
    state.bench.push({
      index: state.bench.length + 1,
      at: started - state.benchStarted,
      ms,
      texts: texts.length,
      role: batch.role,
      ...(response?.timing ? { countMs: response.timing.countMs, hostMs: response.timing.hostMs, chunks: response.timing.chunks } : {})
    });
    if (state.bench.length > 200) state.bench.shift();
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
        presentation: AT.translationtext.create(document),
        settings: () => ({ maxNodes: snapshot.maxNodes, engine: snapshot.engine }),
        shouldTranslate: (text) => !AT.isTargetLanguage(text, snapshot.targetLang),
        // A pass owns an immutable settings snapshot, not mutable global state.
        translate: (batch) => requestBatch(batch, snapshot),
        // Keep short semantic units intact. The executor sends a small leading
        // chunk, packs short neighbours, and progressively applies long prose.
        sentences: { split: AT.targets.sentences, maxChars: C.SENTENCE_MAX_CHARS, always: false },
        // A restore in another task owns the page: stop writing.
        shouldAbort: () => state.stopped || state.epoch !== epoch,
        // A pass over a long page takes a minute; say so while it works.
        onProgress: ({ translated }) => {
          if (state.stopped || state.epoch !== epoch) return;
          const now = Date.now();
          if (now - state.lastReport < 700) return;
          state.lastReport = now;
          // The overlay is redrawn on the same throttle: a pass over a watch
          // page runs for minutes, and boxes that only appear when it ends tell
          // the reader nothing about what it is doing.
          updateDebug(state.pipeline);
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
      status: patch.status,
      translated: patch.translated ?? 0,
      error: patch.error ?? null
    }).catch(() => {});
  }

  // --- The debug overlay. A page that "does nothing" is one of three facts:
  // the plan is somewhere else, the region was classified as the site's chrome,
  // or the model refused it. The overlay draws all three where they happen,
  // because a screenshot of the page is worth more than a console line.

  /** One hue per region kind; a failed region is red and dashed instead. */
  const OVERLAY_ROLE_COLORS: { [role: string]: string } = {
    comment: '#f59e0b',
    article: '#22d3ee',
    heading: '#34d399',
    list: '#a78bfa',
    metadata: '#cbd5e1',
    navigation: '#818cf8',
    form: '#f472b6',
    aside: '#fbbf24',
    footer: '#64748b',
    unknown: '#94a3b8'
  };
  /** Past this the page is a wall of boxes, which diagnoses nothing. */
  const OVERLAY_MAX_BOXES = 300;

  /** The switch is read per pass, so turning it on applies without a reload. */
  function debugOn(): boolean {
    return state.settings?.debug === true && !state.overlayClosed;
  }

  function overlayLayer(): HTMLElement {
    if (state.overlay?.isConnected) return state.overlay;
    const layer = document.createElement('div');
    layer.setAttribute('data-no-translate', '');
    layer.setAttribute('data-at-overlay', '');
    layer.setAttribute('aria-hidden', 'true');
    layer.setAttribute(
      'style',
      [
        'all:initial',
        'position:absolute',
        'top:0',
        'left:0',
        'width:0',
        'height:0',
        'z-index:2147483646',
        'pointer-events:none',
        'contain:layout style'
      ].join(';')
    );
    document.documentElement.appendChild(layer);
    state.overlay = layer;
    return layer;
  }

  /** Boxes in page coordinates: the layer sits at the document's origin, so a
   *  viewport rect has to be shifted by the scroll offset to stay on its text. */
  function paintOverlay(): void {
    const layer = state.overlay;
    if (!layer) return;
    layer.textContent = '';
    const scrollX = globalThis.scrollX || 0;
    const scrollY = globalThis.scrollY || 0;
    let painted = 0;
    for (const region of state.overlayRegions) {
      if (painted >= OVERLAY_MAX_BOXES) break;
      const element = region.node.isConnected === false ? null : region.node.parentElement;
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      if (!(rect.width > 1 && rect.height > 1)) continue;
      const failed = region.status === 'failed';
      const color = failed ? '#ef4444' : OVERLAY_ROLE_COLORS[region.role] ?? OVERLAY_ROLE_COLORS.unknown;
      const outline = document.createElement('div');
      outline.setAttribute('data-no-translate', '');
      outline.setAttribute(
        'style',
        [
          'position:absolute',
          `top:${Math.round(rect.top + scrollY)}px`,
          `left:${Math.round(rect.left + scrollX)}px`,
          `width:${Math.round(rect.width)}px`,
          `height:${Math.round(rect.height)}px`,
          `border:1px ${failed ? 'dashed' : 'solid'} ${color}`,
          `background:${failed ? 'rgba(239,68,68,.08)' : 'transparent'}`,
          'border-radius:3px',
          'box-sizing:border-box',
          'pointer-events:none'
        ].join(';')
      );
      layer.appendChild(outline);
      painted += 1;
    }
  }

  function debugPanel(): HTMLElement {
    if (state.overlayPanel?.isConnected) return state.overlayPanel;
    const panel = document.createElement('div');
    panel.setAttribute('data-no-translate', '');
    panel.setAttribute('data-at-overlay-panel', '');
    panel.setAttribute(
      'style',
      [
        'all:initial',
        'position:fixed',
        'z-index:2147483647',
        'inset:12px 12px auto auto',
        'max-width:24rem',
        'padding:10px 12px',
        'border-radius:10px',
        'border:1px solid rgba(0,0,0,.2)',
        'background:#fffff8',
        'color:#1c1c1c',
        'font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace',
        'box-shadow:0 6px 24px rgba(0,0,0,.22)',
        'white-space:pre-wrap'
      ].join(';')
    );
    const body = document.createElement('p');
    body.setAttribute('data-at-overlay-body', '');
    body.setAttribute('style', 'all:unset;display:block;white-space:pre-wrap');
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '\u00d7';
    close.setAttribute('aria-label', AT.i18n.msg('content_close'));
    close.setAttribute(
      'style',
      'all:unset;position:absolute;inset:2px 6px auto auto;cursor:pointer;padding:0 4px;font:14px/1.2 system-ui,sans-serif'
    );
    close.addEventListener('click', () => {
      // Closing is a choice for this page session, not a settings change.
      state.overlayClosed = true;
      closeDebug();
    });
    panel.append(body, close);
    document.documentElement.appendChild(panel);
    state.overlayPanel = panel;
    return panel;
  }

  /** One line per fact: what the plan took, from where, and what failed. */
  function debugSummary(pass: AT.pipeline.DebugPass | null): string {
    const head = [
      AT.i18n.msg('content_debugTitle'),
      `${pass?.context?.site ?? location.host} · ${pass?.context?.kind ?? 'page'} → ${state.settings?.targetLang ?? ''}`
    ];
    // No productive pass yet: a page with nothing to translate never has one,
    // and an age counted from zero would read as a number from the year 1970.
    if (!pass || pass.at === 0) return head.concat(AT.i18n.msg('content_debugNone')).join('\n');
    const counts: { [role: string]: number } = {};
    for (const region of pass.regions) counts[region.role] = (counts[region.role] ?? 0) + 1;
    const roles = Object.entries(counts)
      .sort((left, right) => right[1] - left[1])
      .map(([role, count]) => `${role} ${count}`)
      .join(' · ');
    // How much of what was translated was actually in front of the reader. A low
    // share with a long queue is the shape of "it never gets to my comments".
    const onScreen = pass.regions.filter((region) => region.priority === 'visible').length;
    const seconds = Math.max(0, Math.round((Date.now() - pass.at) / 1000));
    // What the page offered, and how much of it the reader can see: a role with
    // a large total and no visible share is text this pass will not reach soon.
    const planned = pass.roles
      .map((row) => `${row.role} ${row.total}${row.visible ? ` (${row.visible} on screen)` : ''}`)
      .join(' · ');
    const lines = [
      ...head,
      AT.i18n.msg('content_debugPass', [
        String(pass.processed),
        String(pass.translated),
        String(pass.failed),
        String(pass.planned)
      ]),
      planned || AT.i18n.msg('content_debugNone'),
      roles || AT.i18n.msg('content_debugNone'),
      AT.i18n.msg('content_debugScreen', [String(onScreen), String(pass.regions.length)]),
      AT.i18n.msg('content_debugAge', [String(seconds)])
    ];
    if (pass.error) lines.push(pass.error.slice(0, 160));
    return lines.join('\n');
  }

  function requestOverlayPaint(): void {
    if (state.overlayTimer !== 0) return;
    state.overlayTimer = setTimeout(() => {
      state.overlayTimer = 0;
      paintOverlay();
    }, 80) as unknown as number;
  }

  function bindOverlayPosition(): void {
    if (state.overlayBound) return;
    const target = globalThis as unknown as ScrollTarget;
    if (typeof target.addEventListener !== 'function') return;
    target.addEventListener('scroll', requestOverlayPaint, { passive: true });
    target.addEventListener('resize', requestOverlayPaint, { passive: true });
    state.overlayBound = true;
  }

  function unbindOverlayPosition(): void {
    if (!state.overlayBound) return;
    const target = globalThis as unknown as ScrollTarget;
    target.removeEventListener?.('scroll', requestOverlayPaint);
    target.removeEventListener?.('resize', requestOverlayPaint);
    state.overlayBound = false;
  }

  function closeDebug(): void {
    clearTimeout(state.overlayTimer);
    state.overlayTimer = 0;
    unbindOverlayPosition();
    state.overlay?.remove();
    state.overlayPanel?.remove();
    state.overlay = null;
    state.overlayPanel = null;
    state.overlayRegions = [];
    state.overlayPass = null;
  }

  /** Draw what the last pass did. Called after every pass, never during one. */
  function updateDebug(pipeline: AT.pipeline.PageTranslator | null): void {
    if (!pipeline || !debugOn()) {
      closeDebug();
      return;
    }
    const pass = pipeline.debug();
    state.overlayPass = pass;
    state.overlayRegions = pass ? pass.regions.slice() : [];
    overlayLayer();
    paintOverlay();
    bindOverlayPosition();
    const panel = debugPanel();
    const body = panel.querySelector('[data-at-overlay-body]');
    if (body) body.textContent = debugSummary(pass);
  }

  function stopObserver(): void {
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    clearTimeout(state.timer);
    state.timer = 0;
  }

  function stopViewportTimer(): void {
    clearTimeout(state.viewportTimer);
    state.viewportTimer = 0;
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
      if (state.pipeline?.ownsMutation(record)) continue;
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

  /** A page is longer than a screen: finish what is on screen, then the rest,
   *  and jump to whatever scrolls back into view. */
  function scheduleViewportPass(): void {
    if (!state.settings?.enabled || !state.pipeline || state.stopped) return;
    // Stop refilling the active inference window immediately. Geometry is read
    // once by the next pass, not on every scroll event.
    state.pipeline.invalidatePlan();
    if (state.viewportTimer) return;
    state.viewportTimer = setTimeout(() => {
      state.viewportTimer = 0;
      if (state.stopped || !state.pipeline) return;
      requestContinuation();
    }, 0) as unknown as number;
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
    stopViewportTimer();
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
    // Multiple changed regions (or an unfinished page) compete in one visual
    // plan. Mutation delivery order must not put a counter ahead of new replies.
    // A lone insertion on an otherwise completed page can retain the subtree scan.
    const regions = queue === 'full' || continuing || state.continuation || queue.length > 1
      ? [document.documentElement] : queue;
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
    updateDebug(pipeline);
  }

  /** Ask for one pass over the whole page (the queue has no regions). */
  function requestContinuation(): void {
    state.continuation = true;
    scheduleTick(true);
  }

  function sessionKey(settings: AT.settings.ContentSnapshot): string {
    return JSON.stringify([settings.translationKey ?? '', settings.targetLang, settings.sourceLang, settings.maxNodes]);
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
    state.bench = [];
    state.benchStarted = 0;
    state.targetLang = null;
    state.settingsKey = null;
    stopObserver();
    stopViewportPass();
    closeDebug();
    state.overlayClosed = false;
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
    } else if (state.settings && state.settings.debug !== settings.debug) {
      // The overlay switch is not page content: apply it to what is already
      // translated instead of rebuilding a session to draw a box.
      const snapshot: AT.settings.ContentSnapshot = { ...state.settings, debug: settings.debug };
      state.settings = Object.freeze(snapshot);
      if (settings.debug) state.overlayClosed = false;
      updateDebug(state.pipeline);
    }
    const epoch = state.epoch;
    const pipeline = ensurePipeline(settings);
    state.working = true;
    startObserver();
    startViewportPass();
    try {
      // Yield the initial pass: a large feed must not pin an obsolete viewport
      // plan while newly inserted, visible text waits behind it.
      const result = await pipeline.translate(C.OBSERVER_BATCH_NODES);
      if (epoch !== state.epoch || state.stopped) return { status: 'cancelled' };
      if (result.hasMore) requestContinuation();
      const status = result.failed || result.error ? 'error' : (result.hasMore ? 'translating' : 'translated');
      await report({ status, translated: result.translated, error: result.error });
      updateDebug(pipeline);
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
      error: state.lastError,
      // Every model request this session, for the speed report: #1 is cold.
      bench: state.bench
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

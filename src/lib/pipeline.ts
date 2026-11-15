// The page translation engine: it ties the two decision modules together.
//
//   pagecontext  what kind of page this is (site, section, subjects)
//   targets      which region a text is in and how visible it is
//   dom          the executor that writes translations back into the page
//
// One pass is: read the page's metadata once, take a snapshot of its text, ask
// `targets` for a plan (visible reading order, adjacent texts of the same role), and hand
// each group to the batch callback. Page structure remains local to scheduling.
// The callback is the only thing this module knows about the outside world, so
// the whole flow is testable without a browser or a model.
// Load after lib/constants.js, lib/pagecontext.js, lib/targets.js and lib/dom.js.
namespace AT.pipeline {
  /** The settings the engine needs; the rest belong to the UI. */
  export type Settings = {
    maxNodes: number;
    translationConcurrency?: 1 | 2 | 4 | 8;
  };

  /** One request to the translation layer: texts, the region, the page. */
  export type Batch = {
    texts: string[];
    role: AT.targets.TextRole;
    onProgress?: AT.TranslationProgress | undefined;
    signal?: AbortSignal | undefined;
    /** Shares the page's selected slots between units and their fragments. */
    fragmentConcurrency?: 1 | 2 | 4 | 8;
  };

  export type Request = {
    /** The document to translate; a stub satisfies `AT.dom.DocumentRoot`. */
    doc: AT.dom.DocumentRoot;
    /** Read on every pass, so a settings change applies without a reload. */
    settings: () => Settings;
    /** Sends one batch and returns its translations, in order. */
    translate: (batch: Batch) => Promise<string[]>;
    /** Bound work to the visible/next-screen reading window, yielding after
     * each inference quantum. Omit for explicit whole-document processing. */
    readingWindow?: boolean;
    /** Keep source segmentation independent of viewport admission policy. */
    workLimit?: AT.dom.Options['workLimit'];
    sentences?: AT.dom.Sentences | undefined;
    presentation?: AT.translationtext.Presentation | undefined;
    shouldTranslate?: ((text: string) => boolean) | undefined;
    /** Viewport height; the browser's own when omitted. */
    viewportHeight?: () => number;
    /** Checked between groups, so a restore can drop a pass it no longer owns. */
    shouldAbort?: (() => boolean) | undefined;
    /** Called after every group, so the UI can show progress instead of silence. */
    onProgress?: ((progress: { translated: number; requested: number }) => void) | undefined;
    /** Test seams; a real DOM provides both when omitted. */
    describe?: ((node: Text) => AT.targets.NodeInfo) | undefined;
    measure?: ((node: Text) => { top: number; bottom: number; left?: number; right?: number; inlineStart?: number }) | undefined;
  };

  export type Result = {
    requested: number;
    translated: number;
    runs: number;
    batches: number;
    /** Groups that failed, and why; the rest of the page still went through. */
    failed: number;
    error: string | null;
    /** DOM nodes visited, not deduplicated model inputs. */
    processedNodes: number;
    /** Unvisited planned work; failures alone do not create an infinite retry. */
    hasMore: boolean;
  };

  /** One text node a pass took, and what became of it. The debug overlay reads
   *  these; nothing else does. */
  export type DebugRegion = {
    node: Text;
    role: AT.targets.TextRole;
    status: 'translated' | 'partial' | 'failed';
    /** How visible the region was when it was taken. */
    priority: AT.targets.Priority;
  };

  /** One role's share of the plan: how many nodes, and how many of them the
   *  reader can see right now. The difference is why a page "does nothing". */
  export type DebugRolePlan = { role: AT.targets.TextRole; total: number; visible: number };

  /** What the last pass did, so a page can show *where* it translated and why
   *  a region did not go through. `planned` counts what the whole page offered,
   *  `processed` only what this pass took: the two differ on every budgeted tick. */
  export type DebugPass = {
    at: number;
    context: AT.pagecontext.PageContext | null;
    planned: number;
    processed: number;
    translated: number;
    failed: number;
    error: string | null;
    hasMore: boolean;
    regions: DebugRegion[];
    roles: DebugRolePlan[];
  };

  export type PageTranslator = {
    /** First pass over the page: metadata, plan, translate. */
    translate: (budget?: number) => Promise<Result>;
    /** Another pass over what is still untranslated (scroll, mutations).
     *  `budget` caps how many nodes this pass may take, so background work on a
     *  page that keeps mutating cannot hold the model for minutes. */
    refresh: (root?: Element | Document | null, budget?: number) => Promise<Result>;
    /** Continue an unchanged plan without collecting/measuring the page again. */
    resume: (budget?: number) => Promise<Result>;
    /** One idle quantum outside the viewport; caller owns the stability delay. */
    prefetch: () => Promise<Result>;
    /** External DOM/viewport changes invalidate geometry, never restore records. */
    invalidatePlan: (viewportChanged?: boolean) => void;
    /** Re-rank the queue by what the reader can see *now*, without re-collecting
     *  the page. The caller uses it when the viewport moves. */
    reprioritize: () => { visible: number; queued: number };
    /** Grant two inference quanta to a trusted reader-selected subtree. */
    engage: (region: Element) => void;
    restore: () => { restored: number };
    /** Whether this node currently holds a translation of its own source text.
     *  The observer uses it to ignore the writes the pass itself made. */
    isTranslated: (node: Text) => boolean;
    /** Exact structural writes made by the inline presentation, not site edits. */
    ownsMutation: (record: MutationRecord) => boolean;
    stats: () => { translated: number; batches: number; requested: number };
    context: () => AT.pagecontext.PageContext | null;
    /** The last pass, for the region overlay. Null before the first one. */
    debug: () => DebugPass | null;
  };

  const NO_MEASUREMENT = { top: Number.POSITIVE_INFINITY, bottom: Number.POSITIVE_INFINITY };

  /** The plan, by region: what a page offered and how much of it is on screen. */
  function summarizePlan(
    candidates: AT.targets.Candidate[],
    entries: { id: string; role: AT.targets.TextRole }[]
  ): DebugRolePlan[] {
    if (!candidates.length || !entries.length) return [];
    const visible = new Set(candidates.filter((candidate) => candidate.priority === 'visible').map((candidate) => candidate.id));
    const counts = new Map<AT.targets.TextRole, { total: number; visible: number }>();
    for (const entry of entries) {
      const row = counts.get(entry.role) ?? { total: 0, visible: 0 };
      row.total += 1;
      if (visible.has(entry.id)) row.visible += 1;
      counts.set(entry.role, row);
    }
    return [...counts.entries()]
      .map(([role, row]) => ({ role, ...row }))
      .sort((left, right) => right.total - left.total)
      .slice(0, 5);
  }

  /** What the planner needs about one text node's place in the page. */
  function describeFromDom(node: Text): AT.targets.NodeInfo {
    const parent = node.parentElement;
    const element = parent?.localName === 'at-translation-text' ? parent.parentElement : parent;
    const flags = {
      inArticle: false,
      inComment: false,
      inNav: false,
      inForm: false,
      inFooter: false,
      inAside: false,
      inList: false,
      inHeading: false
    };
    let ariaRole: string | null = null;
    const markers: string[] = [];
    let commentBody = false, commentMetadata = false;
    let current: Element | null = element;
    while (current) {
      const name = current.tagName.toLowerCase();
      const marker = `${current.getAttribute('class') ?? ''} ${current.id ?? ''}`.toLowerCase().trim();
      if (!flags.inComment) {
        if (current.id === 'content-text' || current.getAttribute('itemprop') === 'text' ||
            /(^|[\s_-])(?:comment|reply)-(?:body|content|text)([\s_-]|$)/.test(marker)) commentBody = true;
        if (!commentBody && (name === 'time' || name === 'address' ||
            /(^|[\s_-])(author|byline|dateline|timestamp|published|vote-count)([\s_-]|$)/.test(marker) ||
            /^(authorText|datePublished|author)$/i.test(current.getAttribute('itemprop') ?? ''))) commentMetadata = true;
        if (name === 'p' || name === 'blockquote') commentBody = true;
      }
      // Custom elements and div layouts use the same structural evidence as
      // semantic HTML; no site-specific page mode changes queue behavior.
      const region = `${name} ${marker}`;
      if (/(^|[\s_-])(comments?|replies|responses)([\s_-]|$)/.test(region)) flags.inComment = true;
      if (/(^|[\s_-])(primary|main-content|article-body|story-body|post-body|entry-content)([\s_-]|$)/.test(marker)) flags.inArticle = true;
      if (/(^|[\s_-])(sidebar|secondary|recommendations|related-content)([\s_-]|$)/.test(marker)) flags.inAside = true;
      // `<main>` is the page's own content in practice (Wikipedia, MDN, most
      // documentation), so it counts as the article region without <article>.
      if (name === 'article' || name === 'main') flags.inArticle = true;
      if (name === 'nav') flags.inNav = true;
      if (name === 'form' || name === 'button') flags.inForm = true;
      if (name === 'footer') flags.inFooter = true;
      if (name === 'aside') flags.inAside = true;
      if (name === 'ul' || name === 'ol') flags.inList = true;
      if (/^h[1-6]$/.test(name)) flags.inHeading = true;
      const role = current.getAttribute('role');
      if (role && !ariaRole) ariaRole = role;
      const landmark = (role ?? '').toLowerCase();
      if (['main', 'article'].includes(landmark)) flags.inArticle = true;
      if (['navigation', 'menu', 'menubar'].includes(landmark)) flags.inNav = true;
      if (['form', 'search', 'button'].includes(landmark)) flags.inForm = true;
      if (landmark === 'heading') flags.inHeading = true;
      if (landmark === 'contentinfo') flags.inFooter = true;
      if (landmark === 'complementary') flags.inAside = true;
      if ((role ?? '').toLowerCase() === 'comment') flags.inComment = true;
      // schema.org marks a comment thread as itemtype="…Comment".
      if (/comment/i.test(current.getAttribute('itemtype') ?? '')) flags.inComment = true;
      if (marker) markers.push(marker);
      current = current.parentElement;
    }
    return {
      tag: element?.tagName.toLowerCase() ?? '',
      ariaRole,
      ...flags,
      inCommentMetadata: flags.inComment && commentMetadata,
      markers: markers.join(' ')
    };
  }

  // Reuse a single live Range per document. Thousands of retained Ranges make
  // subsequent Text.nodeValue mutations quadratic in Chromium.
  const measurementRanges = new WeakMap<Document, Range>();

  /** Where a text sits, in viewport coordinates. */
  function measureFromDom(node: Text): { top: number; bottom: number; left?: number; right?: number; inlineStart?: number } {
    // An element box can span thousands of pixels, or have no box at all
    // (display:contents). Measure the text's actual line rectangles first.
    const doc = node.ownerDocument;
    const rtl = node.parentElement && doc?.defaultView?.getComputedStyle(node.parentElement).direction === 'rtl';
    if (typeof doc?.createRange === 'function') {
      let range = measurementRanges.get(doc);
      if (!range) { range = doc.createRange(); measurementRanges.set(doc, range); }
      range.selectNodeContents(node);
      let rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
      // A preview may suppress the light-DOM slot while its host still paints
      // the source/translation. That owned surface is not invisible page text.
      if (!rects.length && node.parentElement?.localName === 'at-translation-text') {
        rects = Array.from(node.parentElement.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
      }
      range.selectNodeContents(doc.documentElement);
      range.collapse(true);
      let clipTop = -Infinity, clipBottom = Infinity, clipLeft = -Infinity, clipRight = Infinity;
      for (let element = node.parentElement; element && element !== doc.documentElement && element !== doc.body;
        element = element.parentElement) {
        const style = doc.defaultView?.getComputedStyle(element);
        if (!style) continue;
        const clipsX = /^(auto|scroll|hidden|clip)$/.test(style.overflowX);
        const clipsY = /^(auto|scroll|hidden|clip)$/.test(style.overflowY);
        if ((!clipsX && !clipsY) || style.display === 'inline' || style.display === 'contents') continue;
        const box = element.getBoundingClientRect();
        const html = element as HTMLElement;
        const scaleX = html.offsetWidth ? box.width / html.offsetWidth : 1;
        const scaleY = html.offsetHeight ? box.height / html.offsetHeight : 1;
        const left = box.left + element.clientLeft * scaleX;
        const top = box.top + element.clientTop * scaleY;
        if (clipsX) {
          clipLeft = Math.max(clipLeft, left);
          clipRight = Math.min(clipRight, left + element.clientWidth * scaleX);
        }
        if (clipsY) {
          clipTop = Math.max(clipTop, top);
          clipBottom = Math.min(clipBottom, top + element.clientHeight * scaleY);
        }
      }
      const height = globalThis.innerHeight || 800, width = globalThis.innerWidth || 1200;
      let nearest: { top: number; bottom: number; left: number; right: number; inlineStart: number } | undefined;
      let distance = Infinity;
      for (const rect of rects) {
        const top = Math.max(rect.top, clipTop), bottom = Math.min(rect.bottom, clipBottom);
        const left = Math.max(rect.left, clipLeft), right = Math.min(rect.right, clipRight);
        if (bottom <= top || right <= left) continue;
        const next = Math.max(0, top - height, -bottom, -right, left - width);
        if (next >= distance) continue;
        distance = next;
        nearest = { top, bottom, left, right, inlineStart: rtl ? -right : left };
        if (next === 0) break;
      }
      if (nearest) return nearest;
      return NO_MEASUREMENT;
    }
    // The non-browser unit-test adapter only supplies element geometry.
    const rect = node.parentElement?.getBoundingClientRect?.();
    if (!rect || (rect.width === 0 && rect.height === 0)) return NO_MEASUREMENT;
    return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right,
      inlineStart: rtl ? -rect.right : rect.left };
  }

  /**
   * Snapshot conservative reading regions, caching ancestor/style work per pass.
   * Landmarks anchor prose; only substantial side-by-side flex/grid branches
   * split it into columns. Unmarked pages retain one ordinary visual flow.
   */
  function readingRegions(): (node: Text, order: number) => AT.targets.ReadingRegion | undefined {
    type Region = { root: Element; documentFlow: boolean };
    const ancestors = new Map<Element, Region>();
    const regions = new Map<Element, AT.targets.ReadingRegion>();
    const columns = new Map<Element, Set<Element>>();
    function resolve(element: Element): Region {
      const known = ancestors.get(element);
      if (known) return known;
      const parent = element.parentElement;
      const inherited = parent ? resolve(parent) : { root: element, documentFlow: false };
      const view = element.ownerDocument?.defaultView;
      const style = view?.getComputedStyle(element);
      let region = inherited;
      if (!inherited.documentFlow && style) {
        const multicolumn = Number.parseInt(style.columnCount, 10) > 1 ||
          (style.columnWidth !== 'auto' && Number.parseFloat(style.columnWidth) > 0);
        if (multicolumn) region = { root: element, documentFlow: true };
        else if (parent) {
          let branches = columns.get(parent);
          if (!branches) {
            branches = new Set<Element>();
            columns.set(parent, branches);
            const layout = view?.getComputedStyle(parent).display;
            if (layout === 'grid' || layout === 'flex' || layout === 'inline-grid' || layout === 'inline-flex') {
              const boxes = Array.from(parent.children)
                .map(child => ({ child, box: child.getBoundingClientRect() }))
                .filter(({ box }) => box.width >= 100 && box.height >= 48)
                .sort((a, b) => a.box.left - b.box.left);
              for (let index = 1; index < boxes.length; index++) {
                const a = boxes[index - 1]!, b = boxes[index]!;
                if (a.box.right <= b.box.left + 1 && Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top) >= 48) {
                  branches.add(a.child); branches.add(b.child);
                }
              }
            }
          }
          if (branches.has(element)) region = { root: element, documentFlow: false };
        }
      }
      // A nested article/heading must not detach from an already identified
      // column. Landmarks help only while the inherited region is the page.
      if (region === inherited && /^(html|body)$/i.test(inherited.root.tagName) &&
          (/^(main|article|aside|nav|footer)$/i.test(element.tagName) ||
           /^(main|article|complementary|navigation|contentinfo)$/.test(element.getAttribute('role') ?? ''))) {
        region = { root: element, documentFlow: false };
      }
      ancestors.set(element, region);
      return region;
    }
    return (node, order) => {
      const parent = node.parentElement;
      if (!parent) return undefined;
      const { root, documentFlow } = resolve(parent);
      let region = regions.get(root);
      if (!region) {
        const box = root.getBoundingClientRect?.();
        const rtl = root.ownerDocument?.defaultView?.getComputedStyle(root).direction === 'rtl';
        region = { id: regions.size, top: box?.top ?? 0,
          inlineStart: (rtl ? -(box?.right ?? 0) : box?.left) ?? 0, order, documentFlow };
        regions.set(root, region);
      }
      return region;
    };
  }

  export function create(request: Request): PageTranslator {
    if (!request || typeof request.translate !== 'function') {
      throw new TypeError('AT.pipeline.create: translate(batch) is required');
    }
    const describe = request.describe ?? describeFromDom;
    const measure = request.measure ?? measureFromDom;
    const viewportHeight = request.viewportHeight ?? (() => globalThis.innerHeight || 800);

    const done = new Set<Text>();
    // A successful unrelated mutation must not erase an earlier segment failure.
    const failures = new Map<Text, { value: string | null; error: string }>();
    /** What the last pass did, for the region overlay in the page. */
    let lastPass: DebugPass | null = null;
    /** Every node this translator has written or refused, for the overlay. It
     *  outlives one pass: the interesting regions were translated minutes ago
     *  and the overlay is expected to show them when it is switched on. */
    const debugRegions = new Map<Text, DebugRegion>();
    /** Bounds the overlay's bookkeeping: a page can plan thousands of nodes and
     *  the overlay is capped anyway. */
    const DEBUG_REGIONS = 400;
    let generation = 0;
    /** A pass owns the translator's run table: two of them must not interleave. */
    let passes: Promise<unknown> = Promise.resolve();
    const once = <T>(job: () => Promise<T>): Promise<T> => {
      const next = passes.then(job, job);
      passes = next.catch(() => undefined);
      return next;
    };
    /** Nodes a background pass has already reached this round. A page that
     *  keeps rewriting its own top (a video site re-rendering its feed) would
     *  otherwise spend every tick there and never reach the comments below. */
    let swept = new Set<Text>();
    let context: AT.pagecontext.PageContext | null = null;
    let translator: AT.dom.Translator | null = null;
    let batches = 0;
    type Plan = { nodes: Text[]; entries: { id: string; role: AT.targets.TextRole; priority: AT.targets.Priority }[]; cursor: number };
    let savedPlan: Plan | null = null;
    const activeNodes = new Set<Text>();
    /** A re-rank replaced the plan while a pass was working through it. */
    let replanned = false;
    // Viewport changes affect future dispatch, never the answer in flight.
    const viewportMode = request.readingWindow === true;
    const viewportWork = { maxChars: AT.C.PACKED_TEXT_CHARS, maxTexts: 1 };
    let engagement: { root: Element; remaining: number; until: number } | null = null;
    // Ordinary reading units finish before switching. Extremely long units
    // yield after 32 bounded DOM quanta; the host splits each by source tokens.
    const UNIT_QUANTA = 32;
    const continuity = new Map<Element | Text, number>();
    function unitOf(node: Text): Element | Text {
      let block: Element | null = null;
      for (let element = node.parentElement; element; element = element.parentElement) {
        const marker = `${element.tagName.toLowerCase()} ${element.getAttribute?.('class') ?? ''} ${element.id ?? ''}`;
        if (element.getAttribute?.('role') === 'comment' ||
            /(?:^|[\s_-])(?:comment|reply|card)(?:$|[\s_-])/.test(marker)) return element;
        if (!block && (/^(P|LI|BLOCKQUOTE|ARTICLE|DIV)$/.test(element.tagName) ||
            (!viewportMode && /^(ADDRESS|ASIDE|BODY|CAPTION|DD|DETAILS|DIALOG|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|MAIN|NAV|OL|PRE|SECTION|SUMMARY|TABLE|TBODY|TD|TFOOT|TH|THEAD|TR|UL)$/.test(element.tagName)))) {
          block = element;
        }
      }
      return block ?? node;
    }

    /** Both initial collection and viewport re-ranking use this exact snapshot. */
    function candidatesFor(nodes: Text[], viewport: { top: number; height: number; width: number }): AT.targets.Candidate[] {
      const regionOf = readingRegions();
      if (engagement && (engagement.remaining <= 0 || engagement.until < Date.now() || engagement.root.isConnected === false)) engagement = null;
      return nodes.map((node, order): AT.targets.Candidate => {
        const rect = measure(node);
        const quanta = continuity.get(unitOf(node));
        return {
          id: String(order), order, role: AT.targets.roleOf(describe(node)),
          priority: AT.targets.priorityOf(rect, viewport),
          deferred: translator?.deferred(node) ?? false,
          top: rect.top, inlineStart: rect.inlineStart ?? rect.left ?? 0,
          region: regionOf(node, order),
          engaged: engagement?.root.contains(node) ?? false,
          continuation: quanta ? (quanta >= UNIT_QUANTA ? 'yielding' : 'preferred') : undefined
        };
      });
    }
    const ordinaryWork = { maxChars: 0, maxTexts: AT.C.PACKED_TEXT_NODES };

    function executor(): AT.dom.Translator {
      if (translator) return translator;
      const settings = request.settings();
      translator = AT.dom.createTranslator({
        doc: request.doc,
        maxNodes: settings.maxNodes,
        sentences: request.sentences,
        presentation: request.presentation,
        shouldTranslate: request.shouldTranslate,
        workLimit: request.workLimit ?? (() => viewportMode ? viewportWork : ordinaryWork),
        shouldAbort: request.shouldAbort,
        onApply: (translated) => request.onProgress?.({ translated, requested: 0 }),
        translate: (texts, onProgress, signal) => request.translate({ texts, role: 'unknown', onProgress, signal })
      });
      return translator;
    }

    /**
     * One pass: collect, plan, translate in plan order. `reset` makes it a fresh
     * pass (new page context, everything eligible again).
     */
    async function run(
      root: Element | Document | null | undefined,
      reset: boolean,
      budget?: number,
      epoch = generation,
      resume = false,
      prefetch = false
    ): Promise<Result> {
      const dom = executor();
      const cancelled = () => epoch !== generation || request.shouldAbort?.() === true;
      const empty = (): Result => ({ requested: 0, translated: dom.stats().translated, runs: 0,
        batches: 0, failed: failures.size, error: failures.values().next().value?.error ?? null, processedNodes: 0, hasMore: false });
      if (cancelled()) return empty();
      for (const node of done) if (node.isConnected === false) done.delete(node);
      for (const node of swept) if (node.isConnected === false) swept.delete(node);
      for (const node of debugRegions.keys()) if (node.isConnected === false) debugRegions.delete(node);
      for (const [node, failure] of failures) {
        if (node.isConnected === false || node.nodeValue !== failure.value || dom.has(node)) failures.delete(node);
      }
      if (reset) {
        failures.clear();
        context = AT.pagecontext.analyze(AT.pagecontext.collect(request.doc as AT.pagecontext.MetaDocument));
        done.clear();
        swept = new Set<Text>();
      }
      const start = root ?? request.doc.documentElement;
      if (!start) {
        return empty();
      }
      // `maxNodes` bounds how much one pass *translates*, not how much it looks
      // at: collection follows DOM order, and a page's sidebar often precedes
      // its body, so capping the walk would translate the menu and never see the
      // article. Look at a wide window, then let the plan pick.
      const settings = request.settings();
      // A translation budget must not truncate discovery: the reader may be at
      // node 50,000. Dynamic updates already use affected subtrees. Full scans
      // collect all eligible pending nodes and cap inference only after sorting.
      const previousPlan = resume && !prefetch ? savedPlan : null;
      if (!resume) savedPlan = null;
      // Consumed: this pass reads the fresh plan, a later re-rank interrupts it.
      replanned = false;
      const collected = previousPlan ? previousPlan.nodes : dom.collect(start,
        prefetch ? Math.max(1, settings.maxNodes) : Number.POSITIVE_INFINITY);
      // `done` is a memory aid, not the truth: a page that rewrites a node's
      // text in place puts it back in play (`dom.has` is false again).
      const pending = previousPlan ? collected : collected.filter((node) => !done.has(node) || !dom.has(node));
      if (pending.length === 0) {
        return empty();
      }

      const height = viewportHeight();
      const viewport = { top: 0, height, width: globalThis.innerWidth || 1200 };
      const limit = Number(budget) > 0 ? Math.min(settings.maxNodes, Number(budget)) : settings.maxNodes;
      // A budgeted pass is background work: it takes what the round has not
      // reached yet, so text below the fold is paid for even while the page
      // rewrites its own headings. When everything has been reached the round
      // starts over, which is what picks up nodes the page rewrote.
      const budgeted = Number(budget) > 0;
      const remaining = budgeted ? pending.filter((node) => !swept.has(node)) : pending;
      if (budgeted && remaining.length === 0) swept = new Set<Text>();
      const ordered = previousPlan ? previousPlan.nodes : budgeted && remaining.length > 0 ? remaining : pending;
      const candidates = previousPlan ? [] : candidatesFor(ordered, viewport);
      // Park work outside the reading window without starting model requests or
      // scheduling empty continuations. Scroll/expansion invalidation rediscovers
      // it; no source is discarded or marked translated.
      const eligible = candidates.filter((candidate) =>
        !failures.has(ordered[Number(candidate.id)]!) && !candidate.deferred && Number.isFinite(candidate.top));
      const visible = eligible.filter((candidate) => candidate.priority === 'visible');
      const offscreen = eligible.filter((candidate) => candidate.priority !== 'visible' &&
        Number.isFinite(candidate.top) && Number(candidate.top) >= height && AT.targets.isContent(candidate.role))
        .sort((left, right) => Number(left.top) - Number(right.top) || left.order - right.order);
      const admitted = viewportMode ? (prefetch && !visible.length ? offscreen.slice(0, 1) : visible) : eligible;
      const plan: Plan = previousPlan ?? { nodes: ordered, cursor: 0,
        entries: AT.targets.plan(admitted, { band: height }).flatMap((group) =>
          group.ids.map((id) => ({ id, role: group.role, priority: group.priority }))) };
      const groups: AT.targets.Group[] = [];
      const count = Number.isFinite(limit) && limit > 0 ? limit : plan.entries.length;
      const concurrency = settings.translationConcurrency ?? 1;
      const width = Math.min(count, prefetch ? 1 : concurrency);
      const selectedUnits = new Set<Element | Text>();
      let groupChars = 0;
      // A wave is bounded as well as each model pack: scrolling must not wait
      // for an entire article role bucket to finish before it can re-rank.
      const waveNodes = viewportMode ? 1 : AT.C.PACKED_TEXT_NODES * Math.max(1, AT.C.PAGE_PACKS);
      const waveChars = AT.C.PACKED_TEXT_CHARS * Math.max(1, AT.C.PAGE_PACKS);
      for (const entry of plan.entries.slice(plan.cursor, viewportMode ? undefined : plan.cursor + count)) {
        if (viewportMode) {
          const node = ordered[Number(entry.id)];
          if (!node || dom.has(node)) continue;
          const unit = unitOf(node);
          if (selectedUnits.has(unit)) continue;
          if (selectedUnits.size >= width) break;
          selectedUnits.add(unit);
        }
        let group = groups[groups.length - 1];
        const chars = ordered[Number(entry.id)]?.nodeValue?.length ?? 0;
        if (!group || group.role !== entry.role || group.priority !== entry.priority ||
            (!viewportMode && unitOf(ordered[Number(group.ids[0])]!) !== unitOf(ordered[Number(entry.id)]!)) ||
            group.ids.length >= waveNodes || groupChars + chars > waveChars) {
          group = { role: entry.role, priority: entry.priority, ids: [] };
          groups.push(group);
          groupChars = 0;
        }
        group.ids.push(entry.id);
        groupChars += chars;
      }
      // Subtree edits cannot replace a saved whole-page plan. The caller will
      // rediscover once after such an edit, then reuse its remaining queue.
      const wholePage = root == null || start === request.doc.documentElement;
      if (wholePage && !prefetch) savedPlan = plan;
      const before = batches;
      let requested = 0;
      let runs = 0;
      let failed = 0;
      /** Groups that threw outright; a group can also fail in part. */
      let groupFailures = 0;
      let attempted = 0;
      let processedNodes = 0;
      let error: string | null = null;
      let firstError: unknown = null;
      /** Set when a re-rank cut this pass short, so the fresh plan survives. */
      let yielded = false;
      const pass: DebugPass = {
        at: Date.now(),
        context,
        planned: plan.entries.length,
        processed: 0,
        translated: dom.stats().translated,
        failed: 0,
        error: null,
        hasMore: plan.cursor < plan.entries.length,
        regions: [],
        roles: summarizePlan(candidates, plan.entries)
      };
      lastPass = pass;
      let committed = Promise.resolve();
      const inFlight: Promise<void>[] = [];
      const reservedUnits = new Set<Element | Text>();
      let dispatched = 0;
      const perform = async (group: AT.targets.Group, ready: Promise<void>): Promise<void> => {
        if (cancelled()) return;
        // Reserve only the active wave; reprioritize retains every later node.
        // Whole-page work consumes its cursor; viewport waves rebuild so a
        // reserved second unit can skip siblings of the first safely.
        if (!viewportMode) plan.cursor += group.ids.length;
        const subset = group.ids
          .map((id) => ordered[Number(id)])
          .filter((node): node is Text => node !== undefined && node.isConnected !== false && !dom.has(node));
        if (subset.length === 0) return;
        const jobEngagement = engagement && subset.some(node => engagement!.root.contains(node)) ? engagement : null;
        let jobRequests = 0;
        const unit = unitOf(subset[0]!);
        if (!continuity.has(unit)) {
          for (const [previous, count] of continuity) if (count >= UNIT_QUANTA) continuity.delete(previous);
        }
        continuity.set(unit, (continuity.get(unit) ?? 0) + 1);
        const execution: AT.dom.Execution = {
          cacheScope: '',
          ready,
          shouldYield: () => replanned || (viewportMode && jobRequests > 0),
          translate: (texts, onProgress, signal) => {
            batches++;
            jobRequests++;
            dispatched++;
            return request.translate({ texts, role: group.role, onProgress, signal,
              fragmentConcurrency: prefetch ? 1 : concurrency });
          }
        };
        subset.forEach((node) => activeNodes.add(node));
        attempted += 1;
        processedNodes += subset.length;
        if (budgeted) subset.forEach((node) => swept.add(node));
        try {
          const result = await dom.translateNodes(subset, execution);
          if (cancelled()) return;
          requested += result.requested;
          runs += result.runs;
          const pendingNodes = result.pending;
          if (result.failed > 0) {
            failed += result.failed;
            error ??= result.error ?? 'a batch was refused';
          }
          // Only what the translator actually wrote is done. A heading the model
          // answered with nothing stays eligible, so the next pass retries it
          // instead of leaving the page half English forever.
          for (const node of subset) {
            if (pendingNodes?.includes(node)) {
              swept.delete(node);
              failures.delete(node);
              debugRegions.delete(node);
              if (dom.holds(node)) debugRegions.set(node, {
                node, role: group.role, status: 'partial', priority: group.priority
              });
              continue;
            }
            const written = dom.has(node);
            if (written) { done.add(node); failures.delete(node); }
            else if (result.failed > 0) failures.set(node, { value: node.nodeValue, error: result.error ?? 'translation incomplete' });
            if (budgeted) swept.add(node);
            debugRegions.delete(node);
            debugRegions.set(node, { node, role: group.role, status: written ? 'translated' : 'failed', priority: group.priority });
            if (debugRegions.size > DEBUG_REGIONS) {
              const oldest = debugRegions.keys().next();
              if (!oldest.done) debugRegions.delete(oldest.value);
            }
          }
          pass.processed = processedNodes;
          pass.translated = dom.stats().translated;
          pass.failed = failed;
          pass.error = error;
          pass.hasMore = plan.cursor < plan.entries.length;
          request.onProgress?.({ translated: dom.stats().translated, requested });
          if (pendingNodes?.length) {
            // The active wave reserved these nodes, but did not consume them.
            // Rediscover to merge its continuations with new replies/viewport
            // work. Completed sources remain owned by the DOM executor.
            savedPlan = null;
            yielded = true;
            return;
          }
        } catch (caught: unknown) {
          if (cancelled()) return;
          // A generation that fails must not take the rest of the page with it. Those nodes stay eligible; the caller is
          // told what happened.
          failed += 1;
          groupFailures += 1;
          if (!firstError) firstError = caught;
          error ??= String((caught as { message?: unknown })?.message ?? caught);
          for (const node of subset) {
            if (dom.has(node)) failures.delete(node);
            else failures.set(node, { value: node.nodeValue, error });
          }
          AT.warn('translation batch failed', group.role, caught);
        } finally {
          subset.forEach((node) => activeNodes.delete(node));
          if (!cancelled() && jobEngagement && engagement === jobEngagement && --jobEngagement.remaining <= 0) {
            engagement = null; savedPlan = null; replanned = true;
          }
        }
      };
      if (viewportMode) {
        for (const group of groups) {
          if (cancelled()) break;
          if (replanned || inFlight.length >= width) { yielded = true; break; }
          const node = ordered[Number(group.ids[0])];
          if (node) {
            const unit = unitOf(node);
            if (reservedUnits.has(unit)) { yielded = true; continue; }
            reservedUnits.add(unit);
          }
          const ready = committed;
          const job = perform(group, ready);
          committed = job.then(() => ready);
          inFlight.push(committed);
        }
        await Promise.all(inFlight);
      } else {
        // Independent units commit as soon as ready. Only fragments belonging
        // to the same unit serialize; a slow paragraph cannot hold another's
        // completed translation or prevent a free slot from being refilled.
        const active = new Set<Promise<void>>();
        const ready = Promise.resolve();
        while (groups.length && !cancelled() && !replanned) {
          const next = groups.findIndex(group => !reservedUnits.has(unitOf(ordered[Number(group.ids[0])]!)));
          if (active.size >= width || next < 0) {
            await Promise.race(active);
            continue;
          }
          const group = groups.splice(next, 1)[0]!;
          const unit = unitOf(ordered[Number(group.ids[0])]!);
          reservedUnits.add(unit);
          const job = perform(group, ready).finally(() => {
            active.delete(job);
            reservedUnits.delete(unit);
          });
          active.add(job);
        }
        await Promise.all(active);
      }
      if (viewportMode && (processedNodes || dispatched)) savedPlan = null;
      // Invalidation may arrive during the final admitted request too. Wake a
      // fresh pass even when there was no later old-plan group to interrupt.
      if (replanned) yielded = true;
      // A pass that was re-ranked mid-way must not write its stale order back
      // over the fresh one; it stops at the next batch boundary instead.
      if (!yielded && savedPlan === plan) savedPlan = wholePage && (viewportMode || plan.cursor < plan.entries.length) ? plan : null;
      failed = Math.max(failed, failures.size);
      error ??= failures.values().next().value?.error ?? null;
      pass.at = Date.now();
      pass.processed = processedNodes;
      pass.translated = dom.stats().translated;
      pass.failed = failed;
      pass.error = error;
      const unfinished = plan.entries.some((entry) => {
        const node = ordered[Number(entry.id)];
        return node && node.isConnected !== false && !dom.has(node) && !failures.has(node) && !dom.deferred(node);
      });
      if (viewportMode && !prefetch && !unfinished && !replanned) {
        savedPlan = { nodes: ordered, entries: [], cursor: 0 };
      }
      const liveUnits = new Set(ordered.filter((node) => !dom.has(node) && !failures.has(node)).map(unitOf));
      for (const unit of continuity.keys()) if (!liveUnits.has(unit)) continuity.delete(unit);
      pass.hasMore = !cancelled() && (viewportMode
        ? replanned || unfinished || (prefetch && offscreen.length > 1)
        : replanned || unfinished);
      // Nothing got through: fail the pass so the caller shows the host's own
      // error instead of a silent no-op. A partial pass returns normally.
      if (!cancelled() && attempted > 0 && groupFailures === attempted && !pass.hasMore) throw firstError;
      return { requested, translated: dom.stats().translated, runs, batches: batches - before, failed, error,
        processedNodes, hasMore: pass.hasMore };
    }

    function schedule(root: Element | Document | null, reset: boolean, budget?: number): Promise<Result> {
      const epoch = generation;
      return once(() => run(root, reset, budget, epoch));
    }

    /**
     * The queue, re-ranked against the viewport as it is now.
     *
     * A plan is geometry: it says "this text is on screen, that text is two
     * screens down". The reader scrolls, and the geometry is stale within a
     * second - text that was below the fold is now in front of them while the
     * queue still works through what scrolled away. Re-measuring the queue and
     * re-planning it fixes that without re-collecting the page: what is on
     * screen is taken first, the rest keeps its place behind it.
     */
    function reprioritize(): { visible: number; queued: number } {
      continuity.clear();
      const plan = savedPlan;
      if (!plan) return { visible: 0, queued: 0 };
      const nodes: Text[] = [];
      const index = new Map<Text, number>();
      // Retain parked sources too: scrolling can promote a node that had no
      // admitted entry in the previous viewport.
      for (const node of plan.nodes) {
        if (!node || node.isConnected === false || activeNodes.has(node) || translator?.has(node) || index.has(node)) continue;
        index.set(node, nodes.length);
        nodes.push(node);
      }
      if (nodes.length === 0) {
        savedPlan = { nodes: [], entries: [], cursor: 0 };
        return { visible: 0, queued: 0 };
      }
      const viewport = { top: 0, height: viewportHeight(), width: globalThis.innerWidth || 1200 };
      const candidates = candidatesFor(nodes, viewport);
      const admitted = candidates.filter((candidate) =>
        !failures.has(nodes[Number(candidate.id)]!) && !candidate.deferred && Number.isFinite(candidate.top) &&
        (!viewportMode || candidate.priority === 'visible'));
      const entries = AT.targets.plan(admitted, { band: viewport.height }).flatMap((group) =>
        group.ids.map((id) => ({ id, role: group.role, priority: group.priority })));
      savedPlan = { nodes, entries, cursor: 0 };
      // A pass already working through the old order yields at its next batch.
      replanned = true;
      return { visible: candidates.filter((candidate) => candidate.priority === 'visible').length, queued: nodes.length };
    }

    return {
      translate: (budget) => schedule(null, true, budget),
      refresh: (root, budget) => schedule(root ?? null, false, budget),
      resume: (budget) => { const epoch = generation; return once(() => run(null, false, budget, epoch, true)); },
      prefetch: () => { const epoch = generation; return once(() => run(null, false, 1, epoch, false, true)); },
      invalidatePlan: (viewportChanged = false) => {
        savedPlan = null; replanned = true;
        if (viewportChanged) continuity.clear();
      },
      reprioritize,
      engage: (root) => {
        if (root.isConnected === false || /^(html|body)$/i.test(root.tagName)) return;
        engagement = { root, remaining: 2, until: Date.now() + 8000 };
        savedPlan = null;
        replanned = true;
      },
      ownsMutation: (record) => request.presentation?.ownsMutation(record) ?? false,
      isTranslated(node: Text) {
        return translator ? translator.holds(node) : false;
      },
      restore() {
        generation++;
        savedPlan = null;
        engagement = null;
        continuity.clear();
        const restored = translator ? translator.restore(request.doc.documentElement).restored : 0;
        done.clear();
        failures.clear();
        swept.clear();
        debugRegions.clear();
        lastPass = null;
        return { restored };
      },
      stats() {
        const stats = translator?.stats() ?? { translated: 0 };
        return { translated: stats.translated, batches, requested: 0 };
      },
      context: () => context,
      // The numbers are the last productive pass; the regions are everything the
      // overlay can draw right now, including work from earlier passes.
      debug: () => ({
        at: lastPass?.at ?? 0,
        context,
        planned: lastPass?.planned ?? 0,
        processed: lastPass?.processed ?? 0,
        translated: translator?.stats().translated ?? 0,
        failed: lastPass?.failed ?? failures.size,
        error: lastPass?.error ?? null,
        hasMore: lastPass?.hasMore ?? false,
        regions: [...debugRegions.values()],
        roles: lastPass?.roles ?? []
      })
    };
  }
}

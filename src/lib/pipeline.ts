// The page translation engine: it ties the two decision modules together.
//
//   pagecontext  what kind of page this is (site, section, subjects)
//   targets      which region a text is in and how visible it is
//   dom          the executor that writes translations back into the page
//
// One pass is: read the page's metadata once, take a snapshot of its text, ask
// `targets` for a plan (visible regions first, one group per region), and hand
// each group to the batch callback with the page context and the group's role.
// The callback is the only thing this module knows about the outside world, so
// the whole flow is testable without a browser or a model.
// Load after lib/constants.js, lib/pagecontext.js, lib/targets.js and lib/dom.js.
namespace AT.pipeline {
  /** The settings the engine needs; the rest belong to the UI. */
  export type Settings = {
    maxNodes: number;
  };

  /** One request to the translation layer: texts, the region, the page. */
  export type Batch = {
    texts: string[];
    role: AT.targets.TextRole;
    context: AT.pagecontext.PageContext | null;
  };

  export type Request = {
    /** The document to translate; a stub satisfies `AT.dom.DocumentRoot`. */
    doc: AT.dom.DocumentRoot;
    /** Read on every pass, so a settings change applies without a reload. */
    settings: () => Settings;
    /** Sends one batch and returns its translations, in order. */
    translate: (batch: Batch) => Promise<string[]>;
    sentences?: AT.dom.Sentences | undefined;
    /** Viewport height; the browser's own when omitted. */
    viewportHeight?: () => number;
    /** Checked between groups, so a restore can drop a pass it no longer owns. */
    shouldAbort?: (() => boolean) | undefined;
    /** Called after every group, so the UI can show progress instead of silence. */
    onProgress?: ((progress: { translated: number; requested: number }) => void) | undefined;
    /** Test seams; a real DOM provides both when omitted. */
    describe?: ((node: Text) => AT.targets.NodeInfo) | undefined;
    measure?: ((node: Text) => { top: number; bottom: number }) | undefined;
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

  export type PageTranslator = {
    /** First pass over the page: metadata, plan, translate. */
    translate: () => Promise<Result>;
    /** Another pass over what is still untranslated (scroll, mutations).
     *  `budget` caps how many nodes this pass may take, so background work on a
     *  page that keeps mutating cannot hold the model for minutes. */
    refresh: (root?: Element | Document | null, budget?: number) => Promise<Result>;
    restore: () => { restored: number };
    /** Whether this node currently holds a translation of its own source text.
     *  The observer uses it to ignore the writes the pass itself made. */
    isTranslated: (node: Text) => boolean;
    stats: () => { translated: number; batches: number; requested: number };
    context: () => AT.pagecontext.PageContext | null;
  };

  const NO_MEASUREMENT = { top: Number.POSITIVE_INFINITY, bottom: Number.POSITIVE_INFINITY };

  /** What the planner needs about one text node's place in the page. */
  function describeFromDom(node: Text): AT.targets.NodeInfo {
    const element = node.parentElement;
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
    let current: Element | null = element;
    while (current) {
      const name = current.tagName.toLowerCase();
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
      const marker = `${current.getAttribute('class') ?? ''} ${current.id}`.toLowerCase().trim();
      if (marker) markers.push(marker);
      current = current.parentElement;
    }
    return {
      tag: element?.tagName.toLowerCase() ?? '',
      ariaRole,
      ...flags,
      markers: markers.join(' ')
    };
  }

  // Reuse a single live Range per document. Thousands of retained Ranges make
  // subsequent Text.nodeValue mutations quadratic in Chromium.
  const measurementRanges = new WeakMap<Document, Range>();

  /** Where a text sits, in viewport coordinates. */
  function measureFromDom(node: Text): { top: number; bottom: number; left?: number; right?: number } {
    // An element box can span thousands of pixels, or have no box at all
    // (display:contents). Measure the text's actual line rectangles first.
    const doc = node.ownerDocument;
    if (typeof doc?.createRange === 'function') {
      let range = measurementRanges.get(doc);
      if (!range) { range = doc.createRange(); measurementRanges.set(doc, range); }
      range.selectNodeContents(node);
      const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
      range.selectNodeContents(doc.documentElement);
      range.collapse(true);
      const height = globalThis.innerHeight || 800, width = globalThis.innerWidth || 1200;
      const visible = rects.find((r) => r.bottom >= 0 && r.top <= height && r.right >= 0 && r.left <= width);
      const rect = visible ?? rects.sort((a, b) =>
        Math.max(0, a.top - height, -a.bottom, -a.right, a.left - width) -
        Math.max(0, b.top - height, -b.bottom, -b.right, b.left - width))[0];
      if (rect) return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
      return NO_MEASUREMENT;
    }
    // The non-browser unit-test adapter only supplies element geometry.
    const rect = node.parentElement?.getBoundingClientRect?.();
    if (!rect || (rect.width === 0 && rect.height === 0)) return NO_MEASUREMENT;
    return { top: rect.top, bottom: rect.bottom };
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
    let role: AT.targets.TextRole | null = null;
    let translator: AT.dom.Translator | null = null;
    let batches = 0;

    function executor(): AT.dom.Translator {
      if (translator) return translator;
      const settings = request.settings();
      translator = AT.dom.createTranslator({
        doc: request.doc,
        maxNodes: settings.maxNodes,
        sentences: request.sentences,
        shouldAbort: request.shouldAbort,
        cacheScope: () => JSON.stringify([context, role]),
        onApply: (translated) => request.onProgress?.({ translated, requested: 0 }),
        translate: async (texts) => {
          batches += 1;
          // The region is set per group by the plan below; a batch that arrives
          // outside a pass is a selection or a retry and has no region.
          return await request.translate({ texts, role: role ?? 'unknown', context });
        }
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
      epoch = generation
    ): Promise<Result> {
      const dom = executor();
      const cancelled = () => epoch !== generation || request.shouldAbort?.() === true;
      const empty = (): Result => ({ requested: 0, translated: dom.stats().translated, runs: 0,
        batches: 0, failed: failures.size, error: failures.values().next().value?.error ?? null, processedNodes: 0, hasMore: false });
      if (cancelled()) return empty();
      for (const node of done) if (node.isConnected === false) done.delete(node);
      for (const node of swept) if (node.isConnected === false) swept.delete(node);
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
      const collected = dom.collect(start, Number.POSITIVE_INFINITY);
      // `done` is a memory aid, not the truth: a page that rewrites a node's
      // text in place puts it back in play (`dom.has` is false again).
      const pending = collected.filter((node) => !done.has(node) || !dom.has(node));
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
      const ordered = budgeted && remaining.length > 0 ? remaining : pending;
      const candidates: AT.targets.Candidate[] = ordered.map((node, index) => {
        const rect = measure(node);
        return {
          id: String(index),
          role: AT.targets.roleOf(describe(node)),
          priority: AT.targets.priorityOf(rect, viewport),
          order: index,
          // Banded by one screen of the reader's own viewport.
          top: rect.top
        };
      });
      const groups = AT.targets.plan(candidates, { limit, band: height });
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
      for (const group of groups) {
        if (cancelled()) break;
        const subset = group.ids
          .map((id) => ordered[Number(id)])
          .filter((node): node is Text => node !== undefined);
        if (subset.length === 0) continue;
        role = group.role;
        attempted += 1;
        processedNodes += subset.length;
        if (budgeted) subset.forEach((node) => swept.add(node));
        try {
          const result = await dom.translateNodes(subset);
          if (cancelled()) break;
          requested += result.requested;
          runs += result.runs;
          if (result.failed > 0) {
            failed += result.failed;
            error ??= result.error ?? 'a batch was refused';
          }
          // Only what the translator actually wrote is done. A heading the model
          // answered with nothing stays eligible, so the next pass retries it
          // instead of leaving the page half English forever.
          for (const node of subset) {
            if (dom.has(node)) { done.add(node); failures.delete(node); }
            else if (result.failed > 0) failures.set(node, { value: node.nodeValue, error: result.error ?? 'translation incomplete' });
            if (budgeted) swept.add(node);
          }
          request.onProgress?.({ translated: dom.stats().translated, requested });
        } catch (caught: unknown) {
          if (cancelled()) break;
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
        }
      }
      role = null;
      // Nothing got through: fail the pass so the caller shows the host's own
      // error instead of a silent no-op. A partial pass returns normally.
      if (!cancelled() && attempted > 0 && groupFailures === attempted) throw firstError;
      failed = Math.max(failed, failures.size);
      error ??= failures.values().next().value?.error ?? null;
      return { requested, translated: dom.stats().translated, runs, batches: batches - before, failed, error,
        processedNodes, hasMore: !cancelled() && ordered.length > processedNodes };
    }

    function schedule(root: Element | Document | null, reset: boolean, budget?: number): Promise<Result> {
      const epoch = generation;
      return once(() => run(root, reset, budget, epoch));
    }

    return {
      translate: () => schedule(null, true),
      refresh: (root, budget) => schedule(root ?? null, false, budget),
      isTranslated(node: Text) {
        return translator ? translator.holds(node) : false;
      },
      restore() {
        generation++;
        const restored = translator ? translator.restore(request.doc.documentElement).restored : 0;
        done.clear();
        failures.clear();
        swept.clear();
        role = null;
        return { restored };
      },
      stats() {
        const stats = translator?.stats() ?? { translated: 0 };
        return { translated: stats.translated, batches, requested: 0 };
      },
      context: () => context
    };
  }
}

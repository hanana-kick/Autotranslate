// DOM text extraction and in-place replacement. Content-context only.
// Compiled as a classic script: MV3 content scripts cannot be ES modules, so
// every source file contributes to the single global AT namespace.
namespace AT.dom {
  const EDITABLE_SELECTOR = '[contenteditable=""], [contenteditable="true"]';

  // A merged run never crosses one of these: the page broke the text there on
  // purpose, so the pieces must not be glued into a single sentence.
  const BLOCK_TAGS: Record<string, true | undefined> = {
    ADDRESS: true, ARTICLE: true, ASIDE: true, BLOCKQUOTE: true, BR: true, CAPTION: true,
    DD: true, DETAILS: true, DIALOG: true, DIV: true, DL: true, DT: true, FIELDSET: true,
    FIGCAPTION: true, FIGURE: true, FOOTER: true, FORM: true, H1: true, H2: true, H3: true,
    H4: true, H5: true, H6: true, HEADER: true, HR: true, LI: true, MAIN: true, NAV: true,
    OL: true, OPTGROUP: true, P: true, PRE: true, SECTION: true, SUMMARY: true, TABLE: true,
    TBODY: true, TD: true, TFOOT: true, TH: true, THEAD: true, TR: true, UL: true
  };

  // Replaced or inert elements: nothing to walk into.
  const LEAF_TAGS: Record<string, true | undefined> = {
    AUDIO: true, CANVAS: true, EMBED: true, IFRAME: true, IMG: true, INPUT: true, MATH: true,
    NOSCRIPT: true, OBJECT: true, PROGRESS: true, SCRIPT: true, SELECT: true, SOURCE: true,
    STYLE: true, TEMPLATE: true, TEXTAREA: true, TRACK: true, VIDEO: true
  };

  export type Provider = (texts: string[]) => Promise<string[]>;

  /** Only what the engine touches; tests inject a duck-typed document. */
  export type DocumentRoot = { nodeType: number; documentElement: Element | null };

  /** Cut long text nodes into sentences; the translations are rejoined. */
  export type Sentences = {
    split: (text: string) => string[];
    /** A text shorter than this is sent whole: one sentence is not a batch. */
    maxChars: number;
    /** Split every multi-sentence text, however short: one answer per sentence. */
    always?: boolean;
  };

  export type Options = {
    doc: DocumentRoot;
    maxNodes?: number;
    translate: Provider;
    /** Send a sentence split across inline elements as one request. Default true. */
    mergeInline?: boolean;
    /** Split long text nodes into sentences. Off when absent. */
    sentences?: Sentences | undefined;
    /** Checked between jobs: a restore in another task can drop a queued answer. */
    shouldAbort?: (() => boolean) | undefined;
    /** Yield queued work without cancelling replies already in flight. */
    shouldYield?: (() => boolean) | undefined;
    /** Per-request source budget; zero maxChars preserves the ordinary limit. */
    workLimit?: (() => { maxChars: number; maxTexts: number }) | undefined;
    /** Source-fragment eligibility, checked before presentation or dispatch. */
    shouldTranslate?: ((text: string) => boolean) | undefined;
    /** Called after each chunk's answers are written, so a pass can report progress. */
    onApply?: ((translated: number) => void) | undefined;
    /** Page/region context; model and language are scoped by the page session. */
    cacheScope?: (() => string) | undefined;
    /** How many packs may be in flight at once. Replies are committed in input
     *  reading order even when concurrent inference finishes out of order. */
    concurrency?: (() => number) | undefined;
    /** Optional inline presentation; translation and source ownership stay here. */
    presentation?: AT.translationtext.Presentation | undefined;
  };

  export type Item = {
    node: Text;
    source: string;
    lead: string;
    core: string;
    trail: string;
  };

  /** `text` is what the node held before we touched it; `applied` what we wrote. */
  export type Original = { source: string; text: string | null; applied: string; complete: boolean };

  export type Result = {
    requested: number;
    translated: number;
    runs: number;
    /** Chunks the model refused; the ones around them still landed. */
    failed: number;
    error: string | null;
    /** Unattempted yielded work and resumable suffixes, never failed jobs. */
    pending?: Text[];
  };

  export type Translator = {
    collect(root: Node | null | undefined, limit?: number): Text[];
    translateRoot(root?: Node | null | undefined, options?: { limit?: number }): Promise<Result>;
    translateNodes(nodes: Iterable<Text> | ArrayLike<Text>): Promise<Result>;
    /** Whether this node currently holds a translation of its own text. A node
     *  the model failed to answer for is not "done", so a later pass retries
     *  it instead of skipping it forever. */
    has(node: Text): boolean;
    /** Whether the node still shows the text we wrote. A page that put its own
     *  text back has a record here too, so this is what the observer asks. */
    holds(node: Text): boolean;
    /** Whether the next source fragment is behind a CSS clipping boundary. */
    deferred(node: Text): boolean;
    restore(root?: Node | null | undefined): { restored: number };
    stats(): { translated: number; cached: number; runs: number };
  };

  export function hasText(text: unknown): boolean {
    return typeof text === 'string' && text.trim().length > 1 && /[\p{L}\p{N}]/u.test(text);
  }

  export function isIgnoredElement(element: Element | null | undefined): boolean {
    if (!element || element.nodeType !== 1) return true;
    if (isEditable(element)) return true;
    return Boolean(element.closest(AT.C.IGNORE_SELECTOR));
  }

  function isEditable(element: Element): boolean {
    return Boolean((element as HTMLElement).isContentEditable) || Boolean(element.closest(EDITABLE_SELECTOR));
  }

  /**
   * Whitespace around a run is layout, not content: the model trims it, and an
   * inline element often carries the only space separating it from its
   * neighbour. Take it off before the request, put it back afterwards.
   */
  export function splitWhitespace(text: unknown): { lead: string; core: string; trail: string } {
    if (typeof text !== 'string') return { lead: '', core: text == null ? '' : String(text), trail: '' };
    const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
    return match
      ? { lead: match[1] ?? '', core: match[2] ?? '', trail: match[3] ?? '' }
      : { lead: '', core: text, trail: '' };
  }

  /** Exact boundaries only. Missing, reordered, duplicated or empty segments
   *  are unsafe, particularly for links; the caller falls back to fragments. */
  export function splitRun(reply: string, count: number): string[] | null {
    const matches = [...reply.matchAll(/\uE000(\d+)\uE001/g)];
    if (matches.length !== count - 1 || matches.some((match, index) => Number(match[1]) !== index + 1)) return null;
    if (/[\uE000\uE001]/u.test(reply.replace(/\uE000\d+\uE001/g, ''))) return null;
    const parts: string[] = [];
    let offset = 0;
    for (const match of matches) {
      parts.push(reply.slice(offset, match.index).trim());
      offset = match.index! + match[0].length;
    }
    parts.push(reply.slice(offset).trim());
    return parts.length === count && parts.every(Boolean) ? parts : null;
  }

  export function createTranslator(options: Options): Translator {
    const {
      doc,
      maxNodes = AT.C.DEFAULT_MAX_NODES,
      translate,
      mergeInline = true,
      sentences,
      shouldAbort,
      shouldYield,
      workLimit,
      shouldTranslate,
      onApply,
      cacheScope,
      concurrency,
      presentation
    } = options;

    if (typeof translate !== 'function') {
      throw new TypeError('AT.dom.createTranslator: translate(texts) is required');
    }

    // A restore record and a completed translation are different states.
    const originals = new Map<Text, Original>();
    // Offsets refer to the original core, never the translated DOM value.
    const progress = new Map<Text, { source: string; value: string; offset: number; prefix: string; chunk: number }>();
    let completed = 0;
    /** Answers written back unchanged: a real failure with no exception of its
     *  own, counted so a pass that changed nothing cannot report success. */
    let echoed = 0;
    const cache = new Map<string, { answers: string[]; bytes: number }>();
    let cacheBytes = 0;
    let generation = 0;
    const MAX_CACHE_BYTES = 4 * 1024 * 1024;
    const MAX_CACHE_ENTRIES = 2048;

    function cached(key: string): string[] | null {
      const value = cache.get(key);
      if (!value) return null;
      cache.delete(key);
      cache.set(key, value);
      return value.answers;
    }

    function remember(key: string, answers: string[]): void {
      if (answers.some((answer) => AT.outputIssue(key, answer))) return;
      const bytes = 2 * (key.length + answers.reduce((sum, answer) => sum + answer.length, 0));
      if (bytes > MAX_CACHE_BYTES) return;
      const old = cache.get(key);
      if (old) { cacheBytes -= old.bytes; cache.delete(key); }
      cache.set(key, { answers, bytes });
      cacheBytes += bytes;
      while (cache.size > MAX_CACHE_ENTRIES || cacheBytes > MAX_CACHE_BYTES) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cacheBytes -= cache.get(oldest)!.bytes;
        cache.delete(oldest);
      }
    }

    function forget(node: Text): void {
      presentation?.forget(node);
      if (originals.get(node)?.complete) completed--;
      originals.delete(node);
      progress.delete(node);
    }

    function prune(): void {
      for (const node of originals.keys()) if (node.isConnected === false) forget(node);
      for (const node of progress.keys()) if (node.isConnected === false) progress.delete(node);
    }

    function stats(): { translated: number; cached: number; runs: number } {
      prune();
      return { translated: completed,
        cached: cache.size, runs: mergedRuns };
    }
    // Filled in by collect(): node -> run id, run id -> items.
    const runOf = new Map<Text, string>();
    const runs = new Map<string, Item[]>();
    let runSeq = 0;
    let mergedRuns = 0;

    function itemFor(node: Text): Item {
      const known = originals.get(node);
      const state = progress.get(node);
      if (state && state.value !== node.nodeValue) progress.delete(node);
      const source = known && known.applied === node.nodeValue ? known.source : (node.nodeValue ?? '');
      if (known && known.applied !== node.nodeValue) forget(node);
      return { node, source, ...splitWhitespace(source) };
    }

    const eligible = (text: string): boolean => hasText(text) && shouldTranslate?.(text) !== false;

    /** Range rects include text beyond a line clamp. Intersect them with every
     * clipping ancestor's padding box, not with the viewport or the text box.
     * Suffix-range intersection stays monotonic even for bidi runs and newlines,
     * where testing individual character rects with binary search does not. */
    function visibleEnd(node: Text, start = 0): number {
      const length = node.nodeValue?.length ?? 0;
      const document = node.ownerDocument;
      const view = document?.defaultView;
      if (!document?.createRange || !view?.getComputedStyle) return length;
      let left = -Infinity, right = Infinity, top = -Infinity, bottom = Infinity;
      let clipped = false;
      for (let element = node.parentElement; element; element = element.parentElement) {
        // Root overflow, and body overflow propagated through a visible root,
        // belong to the viewport, not to an element-local clipping rectangle.
        // Watch pages can have a zero-height body with visible overflowing content.
        if (element === document.documentElement || element === document.scrollingElement) continue;
        if (element === document.body && document.documentElement) {
          const rootStyle = view.getComputedStyle(document.documentElement);
          if (rootStyle.overflowX === 'visible' && rootStyle.overflowY === 'visible') continue;
        }
        const css = view.getComputedStyle(element);
        const clamp = Number.parseInt(css.getPropertyValue('-webkit-line-clamp'), 10) > 0;
        const clipX = /^(hidden|clip|auto|scroll)$/.test(css.overflowX);
        const clipY = clamp || /^(hidden|clip|auto|scroll)$/.test(css.overflowY);
        if (!clipX && !clipY) continue;
        // Inline and display:contents elements establish no clipping box.
        if (css.display === 'inline' || css.display === 'contents') continue;
        const box = element.getBoundingClientRect();
        const html = element as HTMLElement;
        const scaleX = html.offsetWidth ? box.width / html.offsetWidth : 1;
        const scaleY = html.offsetHeight ? box.height / html.offsetHeight : 1;
        const x = box.left + element.clientLeft * scaleX;
        const y = box.top + element.clientTop * scaleY;
        if (clipX) { left = Math.max(left, x); right = Math.min(right, x + element.clientWidth * scaleX); }
        if (clipY) { top = Math.max(top, y); bottom = Math.min(bottom, y + element.clientHeight * scaleY); }
        clipped = true;
      }
      if (!clipped) return length;
      const range = document.createRange();
      range.setEnd(node, length);
      const intersects = (offset: number): boolean => {
        range.setStart(node, offset);
        return Array.from(range.getClientRects()).some((rect) =>
          rect.width > 0 && rect.height > 0 && rect.right > left && rect.left < right &&
          rect.bottom > top && rect.top < bottom);
      };
      if (start >= length || !intersects(start)) return start;
      let low = start, high = length;
      while (low + 1 < high) {
        const middle = Math.floor((low + high) / 2);
        if (intersects(middle)) low = middle;
        else high = middle;
      }
      return high;
    }

    function deferred(node: Text): boolean {
      const known = originals.get(node);
      if (known && known.applied !== node.nodeValue) { forget(node); return false; }
      if (known?.complete) return false;
      const state = progress.get(node);
      if (state && state.value !== node.nodeValue) { progress.delete(node); return false; }
      const start = state ? splitWhitespace(known?.source ?? state.source).lead.length + state.prefix.length : 0;
      return visibleEnd(node, start) <= start && start < (node.nodeValue?.length ?? 0);
    }

    /** Keep a visible word whole when possible; never cut a surrogate pair. */
    function boundary(text: string, end: number): number {
      if (end >= text.length) return text.length;
      if (end > 0 && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end--;
      if (end > 0 && /[\p{L}\p{N}]/u.test(text[end - 1]!) && /[\p{L}\p{N}]/u.test(text[end]!)) {
        const space = text.slice(end).search(/\s/u);
        if (space >= 0) end += space;
      }
      return end;
    }

    /** Prefer complete sentences or words inside the quantum, not beyond it.
     * A code point is indivisible even when the budget is one UTF-16 unit. */
    function quantumBoundary(text: string, end: number): number {
      if (end >= text.length) return text.length;
      if (end > 0 && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end--;
      if (!end) return text.codePointAt(0)! > 0xFFFF ? 2 : 1;
      const prefix = text.slice(0, end);
      let sentence = 0;
      for (const match of prefix.matchAll(/[.!?。！？](?=\s|$)|\n+/gu)) {
        sentence = match.index! + match[0].length;
      }
      if (sentence && /\S/u.test(prefix.slice(0, sentence))) return sentence;
      let word = 0;
      for (const match of prefix.matchAll(/\s+/gu)) word = match.index! + match[0].length;
      return word && /\S/u.test(prefix.slice(0, word)) ? word : end;
    }

    function fragment(item: Item): { item: Item; offset: number; bounded: boolean } {
      const state = progress.get(item.node);
      const offset = state?.offset ?? 0;
      const remaining = item.core.slice(offset);
      const domStart = item.lead.length + (state?.prefix.length ?? 0);
      const visible = Math.max(0, visibleEnd(item.node, domStart) - domStart);
      let size = remaining.length;
      if (visible < remaining.length) {
        const hiddenSentence = !visible ? sentenceJob({ ...item, core: remaining })?.ends[0] : undefined;
        size = boundary(remaining, visible || hiddenSentence || state?.chunk || sentences?.maxChars || AT.C.PACKED_TEXT_CHARS);
        // A leading zero-width/newline or a single surrogate must not stall.
        if (!size) size = remaining.codePointAt(0)! > 0xFFFF ? 2 : 1;
      }
      const maxChars = workLimit?.().maxChars ?? 0;
      if (maxChars > 0 && size > maxChars) size = quantumBoundary(remaining, maxChars);
      return { item: { ...item, core: remaining.slice(0, size) }, offset, bounded: size < remaining.length };
    }

    function hasEligibleFragment(item: Item): boolean {
      if (progress.has(item.node)) return true;
      return (sentenceJob(item)?.parts ?? [item.core]).some(eligible);
    }
    function accepted(node: Text): boolean {
      if (node.isConnected === false || !hasText(node.nodeValue)) return false;
      const parent = node.parentElement;
      if (!parent || isIgnoredElement(parent)) return false;
      const known = originals.get(node);
      // Already translated and untouched since: leave it alone. If the page
      // rewrote the text, forget the record and treat it as new.
      if (known) {
        if (known.applied === node.nodeValue) return !known.complete && hasEligibleFragment(itemFor(node));
        forget(node);
      }
      return hasEligibleFragment(itemFor(node));
    }

    /** Compare-and-swap: the page owns any value we did not request or write. */
    function owns(item: Item): boolean {
      if (item.node.isConnected === false) return false;
      const known = originals.get(item.node);
      const expected = known && known.source === item.source ? known.applied : item.source;
      return item.node.nodeValue === expected;
    }

    function apply(item: Item, translated: string, complete = true): boolean {
      const body = translated.trim();
      if (!body || !owns(item)) return false;
      // An answer identical to the source is an echo, not a translation. Writing
      // it would mark the node done and hide a failed request behind the page's
      // own words (measured: five English sentences "translated" into English,
      // the pass reported translated, and the page never changed).
      if (body === item.source.trim()) {
        echoed++;
        return false;
      }
      const issue = AT.outputIssue(item.source, body);
      if (issue) throw new Error('invalid translation output: ' + issue);
      const next = item.lead + body + item.trail;
      const wasComplete = originals.get(item.node)?.complete === true;
      if (wasComplete !== complete) completed += complete ? 1 : -1;
      originals.set(item.node, { source: item.source, text: item.source, applied: next, complete });
      if (item.node.nodeValue !== next) item.node.nodeValue = next;
      presentation?.applied(item.node, complete);
      return true;
    }

    /**
     * Group the translatable text nodes under `root` into runs: the text a
     * reader sees as one sentence, i.e. consecutive text nodes sharing a block
     * ancestor. Translating a run as a whole is what keeps a sentence that is
     * split by `<strong>`/`<a>`/`<em>` readable in the target language.
     */
    function collect(root: Node | null | undefined, limit = maxNodes): Text[] {
      prune();
      runs.clear();
      runOf.clear();
      const start = root && root.nodeType === 9 ? (root as Document).documentElement : (root as Element | null);
      const nodes: Text[] = [];
      const styles = new WeakMap<Element, CSSStyleDeclaration>();
      const hidden = new WeakMap<Element, boolean>();
      const view = (start?.ownerDocument ?? doc as unknown as Document)?.defaultView;
      const style = (e: Element): CSSStyleDeclaration | null => {
        if (!view?.getComputedStyle) return null;
        let value = styles.get(e);
        if (!value) { value = view.getComputedStyle(e); styles.set(e, value); }
        return value;
      };
      const subtreeHidden = (e: Element): boolean => {
        const cached = hidden.get(e);
        if (cached !== undefined) return cached;
        const css = style(e);
        const own = css?.display === 'none' || css?.contentVisibility === 'hidden' || css?.opacity === '0';
        const parent = e.parentElement;
        const closedDetails = parent?.tagName === 'DETAILS' && !parent.hasAttribute('open') &&
          e !== Array.from(parent.children).find((child) => child.tagName === 'SUMMARY');
        const value = own || Boolean(closedDetails) || Boolean(parent && subtreeHidden(parent));
        hidden.set(e, value);
        return value;
      };
      const rendered = (node: Text): boolean => {
        const parent = node.parentElement;
        if (!parent || subtreeHidden(parent)) return false;
        if (parent.tagName === 'DETAILS' && !parent.hasAttribute('open')) return false;
        const css = style(parent);
        return css?.visibility !== 'hidden' && css?.visibility !== 'collapse';
      };
      if (!start) return nodes;
      let current: Item[] | null = null;
      const flush = () => {
        if (current && current.length > 1) {
          const id = `r${runSeq}`;
          runSeq += 1;
          runs.set(id, current);
          for (const item of current) runOf.set(item.node, id);
        }
        current = null;
      };
      const visit = (element: Element): void => {
        for (const child of Array.from(element.childNodes)) {
          if (nodes.length >= limit) return;
          if (child.nodeType === 3) {
            const textNode = child as Text;
            if (!accepted(textNode) || !rendered(textNode)) {
              // Whitespace and punctuation between inline elements get their own
              // text node; the run's key cannot carry them, so it has to end
              // here instead of welding the words on both sides.
              flush();
              continue;
            }
            if (!current) current = [];
            current.push(itemFor(textNode));
            nodes.push(textNode);
          } else if (child.nodeType === 1) {
            const childElement = child as Element;
            if (LEAF_TAGS[childElement.tagName] || subtreeHidden(childElement)) { flush(); continue; }
            if (BLOCK_TAGS[childElement.tagName]) {
              flush();
              if (!isIgnoredElement(childElement)) visit(childElement);
              flush();
              continue;
            }
            // Do not join across protected text whose meaning was omitted.
            if (isIgnoredElement(childElement)) { flush(); continue; }
            visit(childElement);
          }
        }
      };
      visit(start);
      flush();
      return nodes;
    }

    /**
     * Sentences of one text node, or null when it is sent whole. `always` splits
     * short paragraphs too, which trades a little prompt overhead per sentence
     * for an answer that can be written back as soon as it lands.
     */
    function sentenceJob(item: Item): { parts: string[]; ends: number[]; gaps: string[] } | null {
      if (!sentences) return null;
      // Interactive comments that fit one request should land whole, even when
      // ordinary page translation opts into splitting every sentence.
      const maxChars = workLimit?.().maxChars ?? 0;
      if (maxChars > 0 && item.core.length <= maxChars && (!shouldTranslate || eligible(item.core))) return null;
      if (!sentences.always && item.core.length <= sentences.maxChars) return null;
      const parts = sentences.split(item.core).map((part) => part.trim());
      if (parts.length < 2 || parts.some((part) => !part)) return null;
      const ends: number[] = [];
      const gaps: string[] = [];
      let offset = 0;
      for (const part of parts) {
        const start = item.core.indexOf(part, offset);
        // A splitter must retain every non-whitespace source byte. Otherwise
        // the original suffix cannot safely be spliced onto a translated prefix.
        if (start < 0 || /\S/u.test(item.core.slice(offset, start))) return null;
        gaps.push(item.core.slice(offset, start));
        offset = start + part.length;
        ends.push(offset);
      }
      if (/\S/u.test(item.core.slice(offset))) return null;
      return { parts, ends, gaps };
    }

    async function run(nodes: readonly Text[]): Promise<Result> {
      const epoch = generation;
      const cancelled = () => epoch !== generation || shouldAbort?.() === true;
      const incoming = new Set(nodes);
      const claimed = new Set<Text>();
      const jobs: Item[][] = [];
      const quantum = workLimit?.();
      const maxChars = quantum && quantum.maxChars > 0 ? quantum.maxChars : AT.C.PACKED_TEXT_CHARS;
      const maxTexts = quantum?.maxTexts ?? AT.C.PACKED_TEXT_NODES;
      prune();
      for (const node of nodes) {
        if (claimed.has(node) || !accepted(node)) continue;
        const id = mergeInline ? runOf.get(node) : undefined;
        const recorded = id ? runs.get(id) : undefined;
        // Oversized interactive runs fall back per element, preserving exact
        // ownership rather than sending an unbounded semantic unit.
        if (recorded && recorded.length > 1 && recorded.every((item) => incoming.has(item.node) && accepted(item.node)) &&
            recorded.every((item) => !/[\uE000\uE001]/u.test(item.source)) &&
            (!quantum || (recorded.length <= maxTexts &&
              (quantum.maxChars <= 0 || recorded.reduce((sum, item) => sum + itemFor(item.node).core.length, 0) <= maxChars))) &&
            recorded.every((item) => {
              const current = itemFor(item.node);
              return !progress.has(item.node) && visibleEnd(item.node) >= current.lead.length + current.core.length &&
                eligible(current.core) &&
                (!shouldTranslate || (sentenceJob(current)?.parts ?? [current.core]).every(eligible));
            })) {
          const items = recorded.map((item) => itemFor(item.node));
          items.forEach((item) => claimed.add(item.node));
          jobs.push(items);
        } else {
          claimed.add(node);
          const item = itemFor(node);
          if (hasEligibleFragment(item)) jobs.push([item]);
        }
      }

      let requested = 0;
      let failed = 0;
      let error: string | null = null;
      let firstError: unknown = null;
      let wrote = 0;
      const echoesBefore = echoed;
      const pending = new Set<Text>();
      const failedNodes = new Set<Text>();
      let reported = 0;
      const report = (): void => {
        if (wrote > reported && !cancelled()) {
          reported = wrote;
          onApply?.(completed);
        }
      };
      mergedRuns = 0;
      const scope = cacheScope?.() ?? '';
      const keyFor = (kind: string, sources: string[]) => JSON.stringify([scope, kind, sources]);
      const ask = async (texts: string[]): Promise<string[]> => {
        if (cancelled()) return [];
        requested += texts.length;
        const answers = await translate(texts);
        if (!Array.isArray(answers) || answers.length !== texts.length) {
          throw new Error('the model returned an unexpected number of results');
        }
        return answers.map((answer, index) => {
          const value = typeof answer === 'string' ? answer.trim() : '';
          const issue = AT.outputIssue(texts[index] ?? '', value);
          // An empty segment can coexist with valid partial results. It remains
          // incomplete below; structural corruption must never enter any cache.
          if (issue && issue !== 'empty-output') throw new Error('invalid translation output: ' + issue);
          return value;
        });
      };
      const write = (item: Item, answer: string, complete = true): void => {
        if (!cancelled() && apply(item, answer, complete)) wrote++;
      };
      /** One segment's cache key. The pack and the single path must agree, or a
       *  node answered in a pack is asked again the next time it stands alone. */
      const textKey = (item: Item, parts: readonly string[], namespace = 'text'): string =>
        keyFor(namespace, [item.core, ...parts]);

      const single = async (item: Item, namespace = 'text'): Promise<void> => {
        if (cancelled() || !owns(item)) return;
        const work = fragment(item);
        const split = sentenceJob(work.item);
        const parts = split?.parts ?? [work.item.core];
        const whitespace = splitWhitespace(work.item.core);
        if (!split) parts[0] = whitespace.core;
        const key = textKey(work.item, parts, namespace);
        const hit = work.offset === 0 && !work.bounded ? cached(key) : null;
        const answers: string[] = [];
        let prefix = progress.get(item.node)?.prefix ?? '';
        for (let offset = 0; offset < parts.length;) {
          if (cancelled() || !owns(item)) return;
          if (shouldYield?.()) { pending.add(item.node); return; }
          let end = offset;
          let chars = 0;
          const limit = offset === 0 ? 1 : maxTexts;
          while (end < parts.length && end - offset < limit) {
            const size = parts[end]!.length;
            if (end > offset && chars + size > maxChars) break;
            chars += size;
            end++;
          }
          const indices: number[] = [];
          for (let index = offset; index < end; index++) if (eligible(parts[index]!)) indices.push(index);
          const reply = hit ? indices.map((index) => hit[index]!) :
            indices.length ? await ask(indices.map((index) => parts[index]!)) : [];
          if (cancelled() || !owns(item)) return;
          let valid = offset, replyAt = 0;
          for (; valid < end; valid++) {
            const selected = indices[replyAt] === valid;
            const answer = selected ? reply[replyAt++] : parts[valid];
            if (selected && (!answer || answer === parts[valid])) break;
            answers.push(answer ?? '');
            prefix += (split?.gaps[valid] ?? whitespace.lead) + (answer ?? '');
          }
          const sourceEnd = work.offset + (split ? split.ends[valid - 1] ?? 0 :
            valid ? Math.max(whitespace.lead.length, work.item.core.length - whitespace.trail.length) : 0);
          const complete = !/\S/u.test(item.core.slice(sourceEnd));
          if (valid > offset) {
            const next = prefix + item.core.slice(sourceEnd);
            // Advancing past ineligible source is not a translation or failure.
            if (next !== item.core) write(item, next, complete);
            if (owns(item)) {
              progress.set(item.node, { source: item.source, value: item.node.nodeValue ?? '',
                offset: sourceEnd, prefix,
                chunk: progress.get(item.node)?.chunk ?? Math.max(1, work.item.core.length) });
              if (complete) progress.delete(item.node);
            }
            if (split) report();
          }
          if (valid < end) {
            failed++;
            failedNodes.add(item.node);
            error ??= 'empty or echoed translation segment';
            firstError ??= new Error(error);
            return;
          }
          if (complete && work.offset === 0 && !work.bounded && !cancelled() && owns(item)) remember(key, answers);
          offset = end;
        }
        if (owns(item) && progress.has(item.node)) pending.add(item.node);
      };

      // A small first pack gets a readable result on screen early. Later packs
      // are bounded by both ordinary-node count and source characters.
      const packable = (items: Item[]): boolean => items.length === 1 && !progress.has(items[0]!.node) &&
        !fragment(items[0]!).bounded && !sentenceJob(items[0]!);
      const pendingTexts = new Map<string, Promise<string>>();
      const singleMany = async (items: Item[], ready: Promise<void>): Promise<void> => {
        const live = items.filter((item) => owns(item));
        if (!live.length) return;
        const keys = live.map((item) => textKey(item, [item.core]));
        const answers: string[] = new Array<string>(live.length).fill('');
        const missing: number[] = [];
        live.forEach((_item, index) => {
          const hit = cached(keys[index]!);
          if (hit && hit.length === 1 && hit[0]) answers[index] = hit[0]!;
          else missing.push(index);
        });
        if (missing.length) {
          // A sentence repeated across the page is one prompt, not one per copy.
          const order: string[] = [];
          const position = new Map<string, number>();
          const slots: number[][] = [];
          for (const slot of missing) {
            const text = live[slot]!.core;
            const at = position.get(text);
            if (at === undefined) {
              position.set(text, order.length);
              order.push(text);
              slots.push([slot]);
            } else {
              slots[at]!.push(slot);
            }
          }
          const fresh = order.filter((text) => !pendingTexts.has(text));
          if (fresh.length) {
            const request = ask(fresh);
            fresh.forEach((text, index) => {
              const answer = request.then((reply) => reply[index] ?? '');
              pendingTexts.set(text, answer);
            });
          }
          const pending = order.map((text) => pendingTexts.get(text)!);
          let reply: string[];
          try {
            reply = await Promise.all(pending);
          } finally {
            order.forEach((text, index) => {
              if (pendingTexts.get(text) === pending[index]) pendingTexts.delete(text);
            });
          }
          if (cancelled()) return;
          slots.forEach((group, at) => {
            const value = (reply[at] ?? '').trim();
            for (const slot of group) {
              answers[slot] = value;
              if (value) remember(keys[slot]!, [value]);
            }
          });
        }
        // Inference remains concurrent; only DOM commits wait for earlier jobs.
        await ready;
        if (cancelled()) return;
        live.forEach((item, index) => {
          if (!owns(item)) return;
          const value = answers[index] ?? '';
          if (!value) {
            failed++;
            error ??= 'empty translation segment';
            firstError ??= new Error(error);
            return;
          }
          write(item, value, true);
        });
      };

      // Keep a bounded inference window and a separate ordered commit chain.
      const packWindow = Math.max(1, Math.floor(concurrency?.() ?? 1));
      const inFlight: Promise<void>[] = [];
      let committed = Promise.resolve();
      let firstPack = true;
      const presented = new Set<Text>();
      const begin = (items: Item[]): void => {
        if (!presentation) return;
        for (const item of items) {
          const part = fragment(item).item;
          if (owns(item) && (sentenceJob(part)?.parts ?? [part.core]).some(eligible)) {
            presentation.begin(item.node);
            presented.add(item.node);
          }
        }
      };
      const settle = (items: Item[]): void => {
        if (!presentation) return;
        for (const item of items) {
          if (!presented.delete(item.node)) continue;
          const record = originals.get(item.node);
          const status = record && record.applied === item.node.nodeValue
            ? record.complete ? 'translated' : 'partial'
            : 'failed';
          presentation.settled(item.node, status);
        }
      };
      /** Runs one job, keeping the per-job accounting the pass reports on. */
      const perform = async (items: Item[], work: () => Promise<void>): Promise<void> => {
        // Always settle this job, including failures, to unblock later commits.
        try {
          begin(items);
          await work();
        } catch (caught: unknown) {
          if (cancelled()) return;
          failed++;
          items.forEach((item) => failedNodes.add(item.node));
          firstError ??= caught;
          error ??= String((caught as { message?: unknown })?.message ?? caught);
        } finally {
          settle(items);
        }
        report();
      };
      const drain = async (): Promise<void> => {
        const next = inFlight.shift();
        if (next) await next;
      };
      const drainAll = async (): Promise<void> => {
        while (inFlight.length) await drain();
      };

      for (let job = 0; job < jobs.length; job += 1) {
        if (cancelled()) break;
        if (shouldYield?.()) {
          for (const remaining of jobs.slice(job)) for (const item of remaining) pending.add(item.node);
          break;
        }
        const items = jobs[job]!;
        const first = items[0];
        if (!first || !items.every(owns)) continue;
        if (packable(items)) {
          const group: Item[] = [];
          let next = job;
          let chars = 0;
          const limit = firstPack ? 1 : maxTexts;
          while (next < jobs.length && group.length < limit) {
            const candidate = jobs[next]!;
            if (!packable(candidate) || !candidate.every(owns)) break;
            const size = candidate[0]!.core.length;
            if (group.length && chars + size > maxChars) break;
            chars += size;
            group.push(candidate[0]!);
            next += 1;
          }
          job = next - 1;
          firstPack = false;
          const ready = committed;
          committed = perform(group, () => singleMany(group, ready)).then(() => ready);
          inFlight.push(committed);
          while (inFlight.length >= packWindow) await drain();
          continue;
        }
        // A numbered run and a sentence split read the page's own structure, so
        // they start once every pack has landed.
        await drainAll();
        if (shouldYield?.()) {
          for (const remaining of jobs.slice(job)) for (const item of remaining) pending.add(item.node);
          break;
        }
        try {
          begin(items);
          if (items.length === 1) {
            await single(first);
          } else {
            const key = keyFor('run-numbered-v3', items.map((item) => item.source));
            let pieces = cached(key);
            if (!pieces) {
              // Use the engine's existing numbered-segment contract directly.
              // Private-use markers were normally dropped, wasting one full
              // generation before the same fragments were translated again.
              const reply = await ask(items.map((item) => item.core));
              if (cancelled() || !items.every(owns)) continue;
              pieces = reply.length === items.length && reply.every(Boolean) ? reply : null;
            }
            if (pieces) {
              // Validate the entire unit before writing any part of it.
              if (!cancelled() && items.every(owns)) {
                for (let index = 0; index < items.length; index++) {
                  const issue = AT.outputIssue(items[index]!.source, pieces[index]!);
                  if (issue) throw Object.assign(new Error(issue), { reason: 'invalid-output' });
                }
                remember(key, pieces);
                items.forEach((item, index) => write(item, pieces![index]!));
                mergedRuns++;
              }
            } else {
              // Never guess an alignment by length. Retain the element/meaning
              // association, even when this costs a less fluent fragment fallback.
              for (const item of items) {
                if (cancelled()) break;
                await single(item, JSON.stringify(['run-fallback', items.map((part) => part.source)]));
              }
              // A validated per-node fallback is also an aligned translation.
              // Cache the whole run so repeated link fragments do not repeatedly
              // spend a generation attempting markers the model already omitted.
              if (!cancelled() && items.every((item) => owns(item) && originals.get(item.node)?.complete)) {
                remember(key, items.map((item) => splitWhitespace(originals.get(item.node)!.applied).core));
              }
            }
          }
        } catch (caught: unknown) {
          if (cancelled()) break;
          items.forEach((item) => failedNodes.add(item.node));
          failed++;
          firstError ??= caught;
          error ??= String((caught as { message?: unknown })?.message ?? caught);
        } finally {
          settle(items);
        }
        report();
      }
      await drainAll();
      const remaining = [...pending].filter((node) => !failedNodes.has(node) && !originals.get(node)?.complete);
      if (!cancelled() && wrote === 0) {
        // Nothing was written: either a request threw, or every answer was the
        // page's own text. Reporting that as "translated" is how a page sat in
        // its source language with no error anywhere to read.
        // A yielded request failure must not label its unattempted neighbours
        // failed. Return those pending nodes so the planner can still admit them.
        if (failed > 0 && remaining.length === 0) throw firstError ?? new Error(error ?? 'translation failed');
        if (echoed > echoesBefore) {
          error ??= 'the model answered with the page\'s own text — check that the target language differs from the page';
          if (remaining.length === 0) throw new Error(error);
          failed++;
        }
      }
      return { requested, translated: stats().translated, runs: mergedRuns, failed, error, pending: remaining };
    }

    return {
      collect,
      deferred,
      async translateRoot(root?: Node | null | undefined, options?: { limit?: number }): Promise<Result> {
        return run(collect(root ?? doc.documentElement, options?.limit ?? maxNodes));
      },
      translateNodes(nodes: Iterable<Text> | ArrayLike<Text>): Promise<Result> {
        return run(Array.from(nodes));
      },
      has(node: Text): boolean {
        const entry = originals.get(node);
        return entry?.complete === true && entry.applied === node.nodeValue;
      },
      holds(node: Text): boolean {
        const entry = originals.get(node);
        return entry !== undefined && entry.applied === node.nodeValue;
      },
      restore(root?: Node | null | undefined): { restored: number } {
        generation++;
        prune();
        let restored = 0;
        for (const [node, entry] of [...originals]) {
          // Nodes outside the subtree keep their record: a later full restore
          // must still be able to put their text back.
          if (root && !root.contains(node)) continue;
          // The page rewrote this node after we did: it owns the text now.
          if (entry.applied === node.nodeValue) {
            node.nodeValue = entry.text;
            restored += 1;
          }
          forget(node);
        }
        for (const node of progress.keys()) if (!root || root.contains(node)) progress.delete(node);
        // Pending nodes may have a visual host without a restore record yet.
        presentation?.restore(root ?? undefined);
        // Keyed by source text alone, so it cannot survive a restore: the next
        // pass may be translating into a different language.
        cache.clear();
        cacheBytes = 0;
        runs.clear();
        runOf.clear();
        return { restored };
      },
      stats
    };
  }
}

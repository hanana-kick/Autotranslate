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
    /** Called after each chunk's answers are written, so a pass can report progress. */
    onApply?: ((translated: number) => void) | undefined;
    /** Page/region context; model and language are scoped by the page session. */
    cacheScope?: (() => string) | undefined;
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
      onApply,
      cacheScope
    } = options;

    if (typeof translate !== 'function') {
      throw new TypeError('AT.dom.createTranslator: translate(texts) is required');
    }

    // A restore record and a completed translation are different states.
    const originals = new Map<Text, Original>();
    let completed = 0;
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
      if (originals.get(node)?.complete) completed--;
      originals.delete(node);
    }

    function prune(): void {
      for (const node of originals.keys()) if (node.isConnected === false) forget(node);
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
      const source = known && known.applied === node.nodeValue ? known.source : (node.nodeValue ?? '');
      if (known && known.applied !== node.nodeValue) forget(node);
      return { node, source, ...splitWhitespace(source) };
    }

    function accepted(node: Text): boolean {
      if (node.isConnected === false || !hasText(node.nodeValue)) return false;
      const parent = node.parentElement;
      if (!parent || isIgnoredElement(parent)) return false;
      const known = originals.get(node);
      // Already translated and untouched since: leave it alone. If the page
      // rewrote the text, forget the record and treat it as new.
      if (known) {
        if (known.applied === node.nodeValue) return !known.complete;
        forget(node);
      }
      return true;
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
      const issue = AT.outputIssue(item.source, body);
      if (issue) throw new Error('invalid translation output: ' + issue);
      const next = item.lead + body + item.trail;
      const wasComplete = originals.get(item.node)?.complete === true;
      if (wasComplete !== complete) completed += complete ? 1 : -1;
      originals.set(item.node, { source: item.source, text: item.source, applied: next, complete });
      if (item.node.nodeValue !== next) item.node.nodeValue = next;
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
    function sentenceJob(item: Item): { item: Item; parts: string[]; gap: string } | null {
      if (!sentences) return null;
      if (!sentences.always && item.core.length <= sentences.maxChars) return null;
      const parts = sentences.split(item.core);
      if (parts.length < 2) return null;
      // Japanese and Chinese do not put a space between sentences; keep the
      // page's own habit instead of inventing one.
      const gap = /\s/.test(item.core) ? ' ' : '';
      return { item, parts, gap };
    }

    async function run(nodes: readonly Text[]): Promise<Result> {
      const epoch = generation;
      const cancelled = () => epoch !== generation || shouldAbort?.() === true;
      const incoming = new Set(nodes);
      const claimed = new Set<Text>();
      const jobs: Item[][] = [];
      prune();
      for (const node of nodes) {
        if (claimed.has(node)) continue;
        const id = mergeInline ? runOf.get(node) : undefined;
        const recorded = id ? runs.get(id) : undefined;
        // A merged run is an optimisation, never an exemption from the text
        // budget. Long runs fall back to sentence-split individual nodes.
        if (recorded && recorded.length > 1 && recorded.every((item) => incoming.has(item.node)) &&
            recorded.reduce((sum, item) => sum + item.source.length, 0) <= (sentences?.maxChars ?? AT.C.SENTENCE_MAX_CHARS) &&
            recorded.every((item) => !/[\uE000\uE001]/u.test(item.source))) {
          const items = recorded.map((item) => itemFor(item.node));
          items.forEach((item) => claimed.add(item.node));
          jobs.push(items);
        } else {
          claimed.add(node);
          jobs.push([itemFor(node)]);
        }
      }

      let requested = 0;
      let failed = 0;
      let error: string | null = null;
      let firstError: unknown = null;
      let wrote = 0;
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
      const single = async (item: Item, namespace = 'text'): Promise<void> => {
        if (cancelled() || !owns(item)) return;
        const split = sentenceJob(item);
        const parts = split?.parts ?? [item.core];
        const key = keyFor(namespace, [item.core, ...parts]);
        let answers = cached(key);
        if (!answers) {
          answers = await ask(parts);
          if (cancelled() || !owns(item)) return;
          if (answers.length === parts.length && answers.every(Boolean)) remember(key, answers);
        }
        if (cancelled() || !owns(item)) return;
        const complete = answers.length === parts.length && answers.every(Boolean);
        if (!complete) {
          failed++;
          error ??= 'empty translation segment';
          firstError ??= new Error(error);
        }
        if (!answers.some(Boolean)) return;
        // A partial answer owns a restore record but is NOT complete. Its next
        // request is built from item.source, never from mixed-language DOM text.
        write(item, parts.map((part, index) => answers[index] || part).join(split?.gap ?? ''), complete);
      };

      for (const items of jobs) {
        if (cancelled()) break;
        const first = items[0];
        if (!first || !items.every(owns)) continue;
        const before = wrote;
        try {
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
          failed++;
          firstError ??= caught;
          error ??= String((caught as { message?: unknown })?.message ?? caught);
        }
        if (wrote > before && !cancelled()) onApply?.(completed);
      }
      if (!cancelled() && failed > 0 && wrote === 0) throw firstError ?? new Error(error ?? 'translation failed');
      return { requested, translated: stats().translated, runs: mergedRuns, failed, error };
    }

    return {
      collect,
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

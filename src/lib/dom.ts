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
  };

  export type Item = {
    node: Text;
    source: string;
    lead: string;
    core: string;
    trail: string;
  };

  /** `text` is what the node held before we touched it; `applied` what we wrote. */
  export type Original = { source: string; text: string | null; applied?: string };

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

  /**
   * Spread one translated run back over the text nodes it came from. Markers do
   * not survive this model — measured against the vendored build, every marker
   * format (private-use, `[[n]]`, `{#n#}`, `<n>`) came back rewritten or dropped,
   * which is why the old marker round trip fell back to translating each inline
   * fragment on its own and produced word-by-word output. A run is now translated
   * as one sentence, then split by each node's share of the source, at word
   * boundaries so nothing is cut in half.
   */
  export function distributeRun(items: readonly { core: string }[], translation: string): string[] {
    const words = String(translation ?? '')
      .trim()
      .split(/\s+/)
      .filter((word) => word.length > 0);
    if (words.length === 0 || items.length === 0) return items.map(() => '');
    if (items.length === 1) return [words.join(' ')];
    const weights = items.map((item) => item.core.trim().length || item.core.length);
    const total = weights.reduce((sum, weight) => sum + weight, 0) || items.length;
    const out: string[] = [];
    let taken = 0;
    items.forEach((item, index) => {
      const last = index === items.length - 1;
      const share = weights[index] ?? 0;
      const room = words.length - taken;
      const want = last
        ? room
        : Math.min(room, Math.max(item.core.trim() ? 1 : 0, Math.round((words.length * share) / total)));
      out.push(words.slice(taken, taken + want).join(' '));
      taken += want;
    });
    // Anything the rounding left over belongs to the last node that has text.
    const rest = words.slice(taken).join(' ');
    if (rest) {
      const lastWithText = out.reduce((index, piece, position) => (piece ? position : index), out.length - 1);
      out[lastWithText] = `${out[lastWithText] ?? ''} ${rest}`.trim();
    }
    return out;
  }


  export function createTranslator(options: Options): Translator {
    const {
      doc,
      maxNodes = AT.C.DEFAULT_MAX_NODES,
      translate,
      mergeInline = true,
      sentences,
      shouldAbort,
      onApply
    } = options;

    if (typeof translate !== 'function') {
      throw new TypeError('AT.dom.createTranslator: translate(texts) is required');
    }

    // node -> record. Presence means "currently translated".
    const originals = new Map<Text, Original>();
    // what was sent -> what came back, reused across nodes and runs. A merged
    // run is keyed by its plain sentence; a single text node by its own text.
    const cache = new Map<string, string>();
    // Filled in by collect(): node -> run id, run id -> items.
    const runOf = new Map<Text, string>();
    const runs = new Map<string, Item[]>();
    let runSeq = 0;
    let mergedRuns = 0;

    function itemFor(node: Text): Item {
      const source = node.nodeValue ?? '';
      return { node, source, ...splitWhitespace(source) };
    }

    function accepted(node: Text): boolean {
      if (!hasText(node.nodeValue)) return false;
      const parent = node.parentElement;
      if (!parent || isIgnoredElement(parent)) return false;
      const known = originals.get(node);
      // Already translated and untouched since: leave it alone. If the page
      // rewrote the text, forget the record and treat it as new.
      if (known) {
        if (known.applied === node.nodeValue) return false;
        originals.delete(node);
      }
      return true;
    }

    /** Records the original text and empties the node (its sentence moved). */
    function clear(item: Item): void {
      if (item.source === '') return;
      if (!originals.has(item.node)) {
        originals.set(item.node, { source: item.source, text: item.node.nodeValue });
      }
      const entry = originals.get(item.node);
      if (!entry) return;
      entry.applied = '';
      item.node.nodeValue = '';
    }

    function apply(item: Item, translated: string | undefined): void {
      const body = typeof translated === 'string' ? translated.trim() : '';
      // No answer at all: leave the record alone so a later pass retries.
      if (!body) return;
      const next = item.lead + body + item.trail;
      if (!originals.has(item.node)) {
        originals.set(item.node, { source: item.source, text: item.node.nodeValue });
      }
      const entry = originals.get(item.node);
      if (!entry) return;
      // The model answering with the same text (a proper noun, a page already in
      // the target language) is still an answer: recording it is what stops the
      // node from being planned again on every pass.
      entry.applied = next;
      if (next !== item.source) item.node.nodeValue = next;
    }

    /**
     * Group the translatable text nodes under `root` into runs: the text a
     * reader sees as one sentence, i.e. consecutive text nodes sharing a block
     * ancestor. Translating a run as a whole is what keeps a sentence that is
     * split by `<strong>`/`<a>`/`<em>` readable in the target language.
     */
    function collect(root: Node | null | undefined, limit = maxNodes): Text[] {
      runs.clear();
      runOf.clear();
      const start = root && root.nodeType === 9 ? (root as Document).documentElement : (root as Element | null);
      const nodes: Text[] = [];
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
            if (!accepted(textNode)) {
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
            if (LEAF_TAGS[childElement.tagName]) continue;
            if (BLOCK_TAGS[childElement.tagName]) {
              flush();
              if (!isIgnoredElement(childElement)) visit(childElement);
              flush();
              continue;
            }
            // An ignored inline element (say <code> in a sentence) drops out,
            // but the sentence around it stays one run.
            if (isIgnoredElement(childElement)) continue;
            visit(childElement);
          }
        }
      };
      visit(start);
      flush();
      return nodes;
    }

    /** One request: the caller already decided what belongs together. */
    async function request(keys: readonly string[]): Promise<void> {
      if (keys.length === 0) return;
      const result = await translate([...keys]);
      if (!Array.isArray(result) || result.length !== keys.length) {
        throw new Error('the model returned an unexpected number of results');
      }
      keys.forEach((key, index) => {
        const value = result[index];
        // An empty answer is not a translation: caching it would make every
        // later pass believe the work is done and never retry the node.
        if (typeof value === 'string' && value.trim()) cache.set(key, value);
      });
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
      const incoming = new Set(nodes);
      const claimed = new Set<Text>();
      const jobs: { items: Item[]; keys: string[]; split?: { parts: string[]; gap: string } }[] = [];
      for (const node of nodes) {
        if (claimed.has(node)) continue;
        const id = mergeInline ? runOf.get(node) : undefined;
        const recorded = id ? runs.get(id) : undefined;
        if (recorded && recorded.length > 1 && recorded.every((item) => incoming.has(item.node))) {
          // Re-read anything the page touched since collect() was called.
          const items = recorded.map((item) => (item.node.nodeValue === item.source ? item : itemFor(item.node)));
          for (const item of items) claimed.add(item.node);
          // The run's own text, spaces included: `core` has its whitespace
          // stripped for the request, so gluing cores would weld words together.
          jobs.push({
            items,
            keys: [items.map((item) => item.source).join('').replace(/\s+/g, ' ').trim()]
          });
          continue;
        }
        claimed.add(node);
        const item = itemFor(node);
        const split = sentenceJob(item);
        jobs.push(split ? { items: [item], keys: split.parts, split } : { items: [item], keys: [item.core] });
      }

      // Every job is applied, including the ones answered from the cache: a page
      // that rewrites a node's text in place put the source back, and skipping
      // the write would leave it in the source language for good.
      const pending: typeof jobs = [];
      for (const job of jobs) pending.push(job);
      /**
       * One request per paragraph's sentences, and several one-sentence nodes
       * packed together: the fixed cost of a request is paid once either way,
       * and a packed request still writes its nodes as soon as it answers.
       */
      // One request per job: a paragraph's sentences travel together (the other
      // segments are the context), and a one-sentence node travels alone.
      // Measured: packing several nodes into one request saved nothing, because
      // a generation costs ~40 ms per output token and only ~0.15 s per request.
      const seen = new Set<string>();
      const unique: string[] = [];
      const work = jobs
        .map((job) => ({
          keys: job.keys.filter((key) => {
            if (cache.has(key) || seen.has(key)) return false;
            seen.add(key);
            unique.push(key);
            return true;
          })
        }))
        .filter((request) => request.keys.length > 0);
      /**
       * Writes every job whose answers are all in the cache, and reports what it
       * wrote. A job that is still waiting for one of its sentences stays in
       * `pending` for the next round.
       */
      function applyReady(): number {
        let wrote = 0;
        for (let index = 0; index < pending.length; index += 1) {
          const job = pending[index];
          if (!job) continue;
          // A restore that arrived while the model was working owns the page now.
          if (shouldAbort?.() === true) return wrote;
          const first = job.items[0];
          if (job.split && first) {
            const parts = job.split.parts;
            const pieces = parts.map((part) => cache.get(part));
            const answered = pieces.filter((piece) => piece !== undefined).length;
            if (answered === 0) continue;
            // Write what has an answer and keep the rest in the source language:
            // the page reads better sentence by sentence than blank until the end.
            apply(first, pieces.map((piece, index) => piece ?? parts[index] ?? '').join(job.split.gap));
            if (answered < parts.length) continue;
          } else if (job.items.length === 1 && first) {
            const answer = cache.get(job.keys[0] ?? '');
            if (answer === undefined) continue;
            apply(first, answer);
          } else {
            const answer = cache.get(job.keys[0] ?? '');
            if (answer === undefined) continue;
            const parts = distributeRun(job.items, answer);
            mergedRuns += 1;
            job.items.forEach((item, position) => {
              const piece = parts[position] ?? '';
              // A node that received no words must not keep its source text: the
              // sentence moved out of it.
              if (piece) apply(item, piece);
              else clear(item);
            });
          }
          pending.splice(index, 1);
          index -= 1;
          wrote += 1;
        }
        return wrote;
      }

      mergedRuns = 0;
      let failed = 0;
      let error: string | null = null;
      let firstError: unknown = null;
      let wrote = 0;
      // One request at a time, writing after each: a page of thirty paragraphs
      // would otherwise stay in the source language until the last answer.
      for (const item of work) {
        if (shouldAbort?.() === true) break;
        try {
          await request(item.keys);
        } catch (caught: unknown) {
          // A refused chunk must not discard the ones that already landed.
          failed += 1;
          firstError ??= caught;
          error ??= String((caught as { message?: unknown })?.message ?? caught);
          continue;
        }
        wrote += applyReady();
        if (wrote > 0) onApply?.(originals.size);
      }
      if (shouldAbort?.() !== true) wrote += applyReady();
      // Nothing got through at all: the caller has to see the failure, not an
      // empty success.
      if (failed > 0 && wrote === 0) throw firstError ?? new Error(error ?? 'translation failed');
      return { requested: unique.length, translated: originals.size, runs: mergedRuns, failed, error };
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
        return originals.has(node);
      },
      holds(node: Text): boolean {
        const entry = originals.get(node);
        return entry !== undefined && entry.applied === node.nodeValue;
      },
      restore(root?: Node | null | undefined): { restored: number } {
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
          originals.delete(node);
        }
        // Keyed by source text alone, so it cannot survive a restore: the next
        // pass may be translating into a different language.
        cache.clear();
        runs.clear();
        runOf.clear();
        return { restored };
      },
      stats(): { translated: number; cached: number; runs: number } {
        return { translated: originals.size, cached: cache.size, runs: mergedRuns };
      }
    };
  }
}

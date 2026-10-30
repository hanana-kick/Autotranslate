// Choosing what to translate, and in which order.
//
// The page is a document, not a bag of strings: a paragraph in an article, a
// comment under it, a menu label and a table cell all want different treatment.
// This module answers three questions and nothing else — no DOM, no network:
//
//   which region is this text in   → `roleOf`
//   is it on screen right now      → `priorityOf`
//   in what order do we send it    → `plan`
//
// The answers are mechanical: semantic elements, ARIA landmarks and the
// attributes sites use to mark comments. A text inside a comment thread is a
// comment even when the whole thread sits inside `<main>`; a list inside an
// article is article text, not a list of its own.
// Load after lib/constants.js.
namespace AT.targets {
  /** What a piece of text is, in the page's own structure. */
  export type TextRole =
    | 'article'
    | 'comment'
    | 'heading'
    | 'navigation'
    | 'list'
    | 'form'
    | 'metadata'
    | 'aside'
    | 'footer'
    | 'unknown';

  /** Everything the DOM adapter has to tell about one text node's place. */
  export type NodeInfo = {
    /** Parent element's tag name, lower case. */
    tag: string;
    /** The nearest explicit ARIA role on the ancestor chain, if any. */
    ariaRole?: string | null;
    inArticle: boolean;
    inComment: boolean;
    inNav: boolean;
    inForm: boolean;
    inFooter: boolean;
    inAside: boolean;
    inList: boolean;
    inHeading: boolean;
    /** Extra class/id evidence, already lower-cased and space-joined. */
    markers?: string;
  };

  /** How close a node is to the reader: the order translations are paid for in. */
  export type Priority = 'visible' | 'near' | 'far';

  const PRIORITY_RANK: Record<Priority, number> = { visible: 0, near: 1, far: 2 };

  /**
   * The page's own content, as opposed to its chrome. Meaningful text is
   * translated to the end first; menus, footers, forms and comment threads are
   * lower priority but still translated afterwards.
   */
  const CONTENT: Record<TextRole, boolean> = {
    article: true,
    heading: true,
    list: true,
    metadata: true,
    comment: false,
    form: false,
    navigation: false,
    aside: false,
    footer: false,
    unknown: false
  };

  export function isContent(role: TextRole): boolean {
    return CONTENT[role] === true;
  }

  /** Ties inside one priority: the part a reader is most likely to be reading. */
  const ROLE_RANK: Record<TextRole, number> = {
    heading: 0,
    article: 1,
    list: 2,
    metadata: 3,
    comment: 4,
    form: 5,
    navigation: 6,
    aside: 7,
    footer: 8,
    unknown: 9
  };

  /** Comment containers, as sites actually mark them. */
  const COMMENT_MARKERS = /(^|[\s_-])(comments?|replies|responses|discussion|thread)([\s_-]|$)/;

  /**
   * The region a text belongs to. Order is the rule: a comment inside an
   * article is a comment, a list inside an article is article text, and a
   * menu inside a footer is navigation.
   */
  export function roleOf(info: NodeInfo): TextRole {
    if (!info || typeof info !== 'object') return 'unknown';
    const role = (info.ariaRole ?? '').toLowerCase();
    if (info.inComment || role === 'comment' || COMMENT_MARKERS.test(info.markers ?? '')) return 'comment';
    if (info.inNav || role === 'navigation' || role === 'menu' || role === 'menubar') return 'navigation';
    if (info.inForm || role === 'form' || role === 'search' || role === 'button') return 'form';
    if (info.inFooter || role === 'contentinfo') return 'footer';
    if (info.inAside || role === 'complementary' || role === 'note') return 'aside';
    if (info.inHeading || info.tag === 'h1' || /^h[1-6]$/.test(info.tag) || role === 'heading') return 'heading';
    if (info.inArticle || role === 'article' || role === 'main') return 'article';
    if (info.inList || role === 'list' || role === 'listitem' || info.tag === 'li') return 'list';
    if (info.tag === 'time' || info.tag === 'address' || /(^|[\s_-])(meta|byline|dateline)([\s_-]|$)/.test(info.markers ?? '')) {
      return 'metadata';
    }
    return 'unknown';
  }

  /** On screen, near it, or neither. `slack` is how far "near" reaches. */
  export function priorityOf(
    rect: { top: number; bottom: number },
    viewport: { top: number; height: number },
    slack?: number
  ): Priority {
    const top = Number(rect?.top);
    const bottom = Number(rect?.bottom);
    const start = Number(viewport?.top) || 0;
    const height = Number(viewport?.height) || 0;
    if (!Number.isFinite(top) || !Number.isFinite(bottom)) return 'far';
    if (bottom >= start && top <= start + height) return 'visible';
    const reach = Number.isFinite(slack) ? Number(slack) : height;
    if (top <= start + height + reach && bottom >= start - reach) return 'near';
    return 'far';
  }

  /** One text node, as the planner sees it. `id` is opaque to this module. */
  export type Candidate = {
    id: string;
    role: TextRole;
    priority: Priority;
    /** Document order; ties inside a group are broken by it. */
    order: number;
    /** Vertical position in viewport coordinates (negative is above the fold). */
    top?: number;
  };

  export type Group = { role: TextRole; priority: Priority; ids: string[] };

  /**
   * The translation plan, in the order a reader moves: the band at the top of
   * the viewport first, then one screen at a time downwards, and the text above
   * the fold last. Within a band the plan is grouped by region, so a batch never
   * mixes a menu label with a comment, and inside a group it stays in document
   * order. That is what makes progress legible: everything above the cursor is
   * done before anything below it starts.
   */
  export function plan(candidates: Candidate[], options?: { limit?: number; band?: number }): Group[] {
    const limit = Number(options?.limit);
    const band = Number(options?.band) > 0 ? Number(options?.band) : 900;
    const usable = (Array.isArray(candidates) ? candidates : []).filter(
      (candidate): candidate is Candidate =>
        Boolean(candidate) && typeof candidate.id === 'string' && candidate.role in ROLE_RANK && candidate.priority in PRIORITY_RANK
    );
    const bandOf = (candidate: Candidate): number => {
      const top = Number(candidate.top);
      if (!Number.isFinite(top)) return Number.MAX_SAFE_INTEGER;
      return Math.floor(top / band);
    };
    // Bands at or below the viewport in reading order, then the ones above it.
    const bandKey = (index: number): number => (index >= 0 ? index : 1000 + -index);
    const buckets = new Map<string, Group & { key: number; first: number }>();
    for (const candidate of usable) {
      const key = bandKey(bandOf(candidate));
      const bucket = `${key}/${candidate.role}`;
      const top = Number(candidate.top);
      const first = Number.isFinite(top) ? top : Number.MAX_SAFE_INTEGER;
      const group = buckets.get(bucket) ?? { role: candidate.role, priority: candidate.priority, ids: [], key, first };
      // Where the group starts on the page decides its place inside the band, so
      // the menu at 120px is still translated before the paragraph at 300px.
      group.first = Math.min(group.first, first);
      group.ids.push(candidate.id);
      buckets.set(bucket, group);
    }
    const orderOf = new Map(usable.map((candidate) => [candidate.id, Number(candidate.order) || 0]));
    const groups = [...buckets.values()];
    for (const group of groups) {
      group.ids.sort((left, right) => (orderOf.get(left) ?? 0) - (orderOf.get(right) ?? 0));
    }
    groups.sort(
      (left, right) =>
        Number(!isContent(left.role)) - Number(!isContent(right.role)) ||
        left.key - right.key ||
        left.first - right.first ||
        ROLE_RANK[left.role] - ROLE_RANK[right.role]
    );
    if (!Number.isFinite(limit) || limit <= 0) {
      return groups.map((group) => ({ role: group.role, priority: group.priority, ids: group.ids }));
    }
    let left = limit;
    const capped: Group[] = [];
    for (const group of groups) {
      if (left <= 0) break;
      const ids = group.ids.slice(0, left);
      left -= ids.length;
      capped.push({ role: group.role, priority: group.priority, ids });
    }
    return capped;
  }


  /**
   * One line that tells the model what kind of text this is. The page context
   * already says what the page is; this says what the *batch* is, which is what
   * decides register — a menu label is not prose.
   */
  export function roleHint(role: TextRole | null | undefined): string | null {
    switch (role) {
      case 'comment':
        return 'These are reader comments.';
      case 'heading':
        return 'These are headings.';
      case 'navigation':
        return 'These are navigation labels.';
      case 'list':
        return 'These are items in a list.';
      case 'form':
        return 'These are form labels and buttons.';
      case 'metadata':
        return 'These are short metadata lines, such as dates and authors.';
      case 'aside':
        return 'These are sidebar notes.';
      case 'footer':
        return 'These are footer links.';
      default:
        return null;
    }
  }

  const ROLES: Record<string, TextRole | undefined> = {
    article: 'article',
    comment: 'comment',
    heading: 'heading',
    navigation: 'navigation',
    list: 'list',
    form: 'form',
    metadata: 'metadata',
    aside: 'aside',
    footer: 'footer',
    unknown: 'unknown'
  };

  /** A role that crossed a message boundary. */
  export function normalizeRole(raw: unknown): TextRole {
    return typeof raw === 'string' ? ROLES[raw] ?? 'unknown' : 'unknown';
  }

  /**
   * The share of the prompt that page and region lines may take, in characters
   * (~40 tokens, 8% of the input available at `localMaxTokens: 1024`). Above
   * that the policy is to drop lines, not to grow the context: measured, a
   * full metadata block (glossary, sections, entities) costs up to 382 tokens
   * on a docs page — 75% of that input budget — so it stays out of the prompt
   * and is kept for consistency work instead.
   */
  export const CONTEXT_MAX_CHARS = 240;

  /**
   * The context line for one batch: what the page is, then what this batch is.
   * The page line goes first because everything else is relative to it; the
   * region line only exists for regions where register matters (a menu label is
   * not prose). Clamped to `CONTEXT_MAX_CHARS` on a word boundary.
   */
  export function composeContext(pageHint: string | null | undefined, roleHint: string | null | undefined): string {
    const lines = [pageHint, roleHint]
      .map((line) => (typeof line === 'string' ? line.trim() : ''))
      .filter((line) => line.length > 0);
    const joined = lines.join(' ');
    if (!joined || joined.length <= CONTEXT_MAX_CHARS) return joined;
    const cut = joined.slice(0, CONTEXT_MAX_CHARS);
    const space = cut.lastIndexOf(' ');
    return (space > CONTEXT_MAX_CHARS / 2 ? cut.slice(0, space) : cut).replace(/[,;:]$/, '');
  }

  /**
   * Sentences, so a batch can be cut at a boundary instead of mid-clause.
   * `Intl.Segmenter` handles the abbreviations; the fallback splits on the
   * punctuation that ends a sentence in most scripts.
   */
  export function sentences(text: unknown): string[] {
    const value = typeof text === 'string' ? text.trim() : '';
    if (!value) return [];
    const Segmenter = (Intl as { Segmenter?: new (locale?: string, options?: { granularity: string }) => { segment: (input: string) => Iterable<{ segment: string }> } }).Segmenter;
    if (typeof Segmenter === 'function') {
      try {
        const segmenter = new Segmenter(undefined, { granularity: 'sentence' });
        const parts = [...segmenter.segment(value)]
          .map((part) => part.segment.trim())
          .filter((part) => part.length > 0);
        if (parts.length > 0) return parts;
      } catch {
        // Fall through to the punctuation split.
      }
    }
    return value
      .split(/(?<=[.!?。！？])\s+/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }
}

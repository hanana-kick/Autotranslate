// What the page says about itself, and what translation can use from it.
//
// Two levels, both read from markup the page already downloaded:
//   site   — name, host, kind of site (docs, forum, shop), its sections (the
//            labels of its own navigation);
//   page   — what kind of page this is, its title, section, declared subject
//            (`about` / `mentions`), the entities it names (people, places,
//            organisations, works, glossary terms) and a term list from `dl`,
//            `dfn` and `abbr[title]`.
//
// `collect` reads the DOM (content script only), `analyze` is pure and decides
// what the values mean, `hint` renders one bounded line for the local engine's
// prompt. Nothing here touches the network and nothing leaves the browser on
// the on-device path.
// Load after lib/constants.js.
namespace AT.pagecontext {
  /** What the page appears to be. Small on purpose: each kind changes wording. */
  export type PageKind =
    | 'article'
    | 'news'
    | 'blog'
    | 'docs'
    | 'forum'
    | 'product'
    | 'qa'
    | 'recipe'
    | 'search'
    | 'social'
    | 'video'
    | 'unknown';

  /** What an entity is, as far as its schema.org type says. */
  export type EntityKind = 'person' | 'organization' | 'place' | 'event' | 'term' | 'work' | 'other';

  export type PageEntity = { name: string; kind: EntityKind };

  /** A term the page itself defines; the seed of a translation glossary. */
  export type GlossaryTerm = { term: string; definition: string };

  /** What the markup said, before any interpretation. */
  export type PageMeta = {
    title?: string | null;
    lang?: string | null;
    siteName?: string | null;
    description?: string | null;
    ogType?: string | null;
    section?: string | null;
    tags?: string[];
    jsonLdTypes?: string[];
    /** Names the structured data declares as the subject. */
    about?: string[];
    /** Named nodes from the structured data, already classified by type. */
    entities?: PageEntity[];
    /** The page's own navigation labels: its sections, mechanically. */
    navLabels?: string[];
    /** Pairs from `dl`, `dfn` and `abbr[title]`. */
    glossary?: GlossaryTerm[];
    generator?: string | null;
    host?: string | null;
    path?: string | null;
  };

  /** The page as the translator sees it. */
  export type PageContext = {
    kind: PageKind;
    site: string | null;
    title: string | null;
    section: string | null;
    /** The site's own navigation labels, as sections of the site. */
    sections: string[];
    language: string | null;
    summary: string | null;
    tags: string[];
    entities: PageEntity[];
    glossary: GlossaryTerm[];
  };

  /** The slice of the DOM the collector needs; a real Document satisfies it. */
  export type MetaElement = {
    getAttribute: (name: string) => string | null;
    textContent?: string | null;
    tagName?: string;
    nextElementSibling?: MetaElement | null;
    querySelectorAll?: (selector: string) => ArrayLike<MetaElement>;
  };

  export type MetaDocument = {
    title?: string;
    documentElement?: { lang?: string } | null;
    querySelector?: (selector: string) => MetaElement | null;
    querySelectorAll?: (selector: string) => ArrayLike<MetaElement>;
    location?: { href?: string };
  };

  /** A fresh empty context; callers may hold on to it, so no shared arrays. */
  function empty(): PageContext {
    return {
      kind: 'unknown',
      site: null,
      title: null,
      section: null,
      sections: [],
      language: null,
      summary: null,
      tags: [],
      entities: [],
      glossary: []
    };
  }

  const MAX_TEXT = 200;
  const MAX_SITE = 80;
  const MAX_TAG = 40;
  const MAX_TAGS = 8;
  const MAX_SECTION = 40;
  const MAX_SECTIONS = 8;
  const MAX_NAV_LINKS = 40;
  const MAX_ENTITY = 80;
  const MAX_ENTITIES = 12;
  const MAX_HINT_ENTITIES = 3;
  const MAX_TERM = 60;
  const MAX_DEFINITION = 160;
  const MAX_GLOSSARY = 12;
  /** A page may carry megabytes of JSON-LD; only the head of each script is read. */
  const MAX_JSON_LD_BYTES = 120000;
  const MAX_JSON_LD_SCRIPTS = 8;
  const MAX_JSON_NODES = 400;
  const MAX_JSON_DEPTH = 6;
  /** The prompt line has a budget of its own. */
  const MAX_HINT = 240;

  /** Trims, collapses whitespace and caps; nothing untrusted survives longer. */
  function text(value: unknown, limit: number): string | null {
    if (typeof value !== 'string') return null;
    const clean = value.replace(/\s+/g, ' ').trim();
    return clean ? clean.slice(0, limit) : null;
  }

  /** A host as a reader would say it: no scheme, no `www.`, lowercase. */
  function hostOf(value: unknown): string | null {
    const raw = text(value, 300);
    if (!raw) return null;
    try {
      const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
      return url.hostname.replace(/^www\./i, '').toLowerCase() || null;
    } catch {
      return null;
    }
  }

  function pathOf(value: unknown): string | null {
    const raw = text(value, 300);
    if (!raw) return null;
    try {
      const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://example.invalid/${raw}`);
      return url.pathname.toLowerCase();
    } catch {
      return null;
    }
  }

  function readAttribute(doc: MetaDocument, selector: string, name: string): string | null {
    const node = doc.querySelector?.(selector);
    return typeof node?.getAttribute === 'function' ? node.getAttribute(name) : null;
  }

  /** "Person" → person; the type string is the only input. */
  function entityKind(type: string): EntityKind {
    const name = type.toLowerCase();
    if (name === 'person') return 'person';
    if (name.includes('organization') || name === 'corporation' || name === 'ngo' || name === 'localbusiness') {
      return 'organization';
    }
    if (name === 'place' || name === 'country' || name === 'city' || name === 'administrativearea') return 'place';
    if (name === 'event' || name.endsWith('event')) return 'event';
    if (name === 'definedterm') return 'term';
    if (
      name === 'article' ||
      name === 'newsarticle' ||
      name === 'blogposting' ||
      name === 'creativework' ||
      name === 'book' ||
      name === 'movie' ||
      name === 'product' ||
      name === 'recipe' ||
      name === 'videoobject' ||
      name === 'softwareapplication'
    ) {
      return 'work';
    }
    return 'other';
  }

  /** Depth- and count-bounded walk over parsed structured data. The budget is
   *  shared across the whole graph, so one huge array cannot keep it busy. */
  function walk(
    value: unknown,
    depth: number,
    budget: { count: number },
    visit: (node: Record<string, unknown>) => void
  ): void {
    if (!value || typeof value !== 'object' || depth > MAX_JSON_DEPTH) return;
    if (budget.count > MAX_JSON_NODES) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1, budget, visit);
      return;
    }
    const node = value as Record<string, unknown>;
    budget.count += 1;
    visit(node);
    for (const [key, child] of Object.entries(node)) {
      if (key === '@context') continue;
      if (child && typeof child === 'object') walk(child, depth + 1, budget, visit);
    }
  }

  /** A type name worth keeping: the same shape the fallback scan accepts. */
  const TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9]{1,39}$/;

  function firstType(value: unknown): string | null {
    if (typeof value === 'string') return TYPE_PATTERN.test(value) ? value : null;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && TYPE_PATTERN.test(item)) return item;
      }
    }
    return null;
  }

  /**
   * Structured data, read as data. A failed parse falls back to scanning the
   * raw text for type names, because truncated JSON-LD still names itself and
   * the kind of page is the one thing that must not depend on well-formedness.
   */
  function structuredData(doc: MetaDocument): { types: string[]; entities: PageEntity[]; about: string[] } {
    const types: string[] = [];
    const entities: PageEntity[] = [];
    const about: string[] = [];
    const scripts = doc.querySelectorAll?.('script[type="application/ld+json"]');
    if (!scripts) return { types, entities, about };
    const budget = { count: 0 };
    for (const script of Array.from(scripts).slice(0, MAX_JSON_LD_SCRIPTS)) {
      const raw = String(script.textContent ?? '').slice(0, MAX_JSON_LD_BYTES);
      if (!raw.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        for (const match of raw.matchAll(/"@type"\s*:\s*"([A-Za-z][A-Za-z0-9]{1,39})"/g)) {
          types.push(match[1] as string);
        }
        continue;
      }
      walk(parsed, 0, budget, (node) => {
        const type = firstType(node['@type']);
        if (type) types.push(type);
        const name = text(node.name, MAX_ENTITY);
        const kind = type ? entityKind(type) : 'other';
        // A graph names the publisher, the locale and every item in a listing
        // as well as the subject. Only what a translation can use is kept: the
        // subject itself, people, defined terms and events.
        if (name && type && (kind === 'person' || kind === 'term' || kind === 'event')) {
          entities.push({ name, kind });
        }
        // `about` / `mentions` may be bare strings; object forms are visited
        // above and contribute their own name.
        for (const key of ['about', 'mentions']) {
          const value = node[key];
          for (const item of Array.isArray(value) ? value : [value]) {
            const topic = text(item, MAX_ENTITY);
            if (topic) about.push(topic);
          }
        }
      });
    }
    return { types, entities, about };
  }

  /**
   * The labels the site gives its own sections. The header's navigation is the
   * site's table of contents; a page's sidebar is its own outline, so it is only
   * used when there is no header navigation at all. A section label is short —
   * a mega-menu blob ("GitHubRepository hosting, code review…") is not that.
   */
  function navLabels(doc: MetaDocument): string[] {
    const labels: string[] = [];
    const read = (selector: string): void => {
      const links = doc.querySelectorAll?.(selector);
      if (!links) return;
      for (const link of Array.from(links).slice(0, MAX_NAV_LINKS)) {
        const raw =
          link.getAttribute('aria-label') ??
          link.getAttribute('title') ??
          link.textContent;
        const label = text(raw, MAX_SECTION);
        if (!label || labels.includes(label)) continue;
        // A pure number or punctuation run is a counter, not a section name.
        if (/^[\d\s.,:;/|+-]+$/.test(label)) continue;
        if (label.length > 28 || label.split(' ').length > 4) continue;
        labels.push(label);
      }
    };
    read('header nav a, [role="banner"] nav a');
    if (labels.length < 2) read('nav a, [role="navigation"] a');
    return labels;
  }

  /** Terms the page defines itself: the seed of a glossary. */
  function glossaryTerms(doc: MetaDocument): GlossaryTerm[] {
    const terms: GlossaryTerm[] = [];
    for (const list of Array.from(doc.querySelectorAll?.('dl') ?? []).slice(0, 3)) {
      for (const item of Array.from(list.querySelectorAll?.('dt') ?? [])) {
        if (terms.length >= MAX_GLOSSARY) break;
        const definition = item.nextElementSibling;
        const term = text(item.textContent, MAX_TERM);
        const meaning = text(
          definition?.tagName?.toLowerCase() === 'dd' ? definition.textContent : null,
          MAX_DEFINITION
        );
        if (term && meaning) terms.push({ term, definition: meaning });
      }
    }
    for (const abbr of Array.from(doc.querySelectorAll?.('abbr[title], dfn[title]') ?? [])) {
      if (terms.length >= MAX_GLOSSARY) break;
      const term = text(abbr.textContent, MAX_TERM);
      const meaning = text(abbr.getAttribute('title'), MAX_DEFINITION);
      if (term && meaning) terms.push({ term, definition: meaning });
    }
    return terms;
  }

  /** Reads the markup a page publishes about itself. Bounded on every axis. */
  export function collect(doc: MetaDocument): PageMeta {
    const meta = (key: string): string | null =>
      readAttribute(doc, `meta[property="${key}"], meta[name="${key}"]`, 'content');

    const tags: string[] = [];
    const tagNodes = doc.querySelectorAll?.('meta[property="article:tag"], meta[name="keywords"]');
    for (const node of Array.from(tagNodes ?? []).slice(0, 16)) {
      const value = node.getAttribute('content');
      if (typeof value !== 'string') continue;
      for (const tag of value.split(',')) {
        const clean = text(tag, MAX_TAG);
        if (clean) tags.push(clean);
      }
    }

    const structured = structuredData(doc);
    const canonical = readAttribute(doc, 'link[rel="canonical"]', 'href');
    const href = text(doc.location?.href, 2000);
    const h1 = text(doc.querySelector?.('h1')?.textContent, MAX_TEXT);

    return {
      title: meta('og:title') ?? text(doc.title, MAX_TEXT) ?? h1,
      lang: text(doc.documentElement?.lang, 35),
      siteName: meta('og:site_name') ?? meta('application-name'),
      description: meta('og:description') ?? meta('description'),
      ogType: meta('og:type'),
      section: meta('article:section'),
      tags,
      jsonLdTypes: structured.types,
      about: structured.about,
      entities: structured.entities,
      navLabels: navLabels(doc),
      glossary: glossaryTerms(doc),
      generator: meta('generator'),
      host: hostOf(canonical) ?? hostOf(href),
      path: pathOf(href) ?? pathOf(canonical)
    };
  }

  const DOC_GENERATORS: Record<string, true | undefined> = {
    docusaurus: true,
    gitbook: true,
    mkdocs: true,
    sphinx: true,
    docsify: true,
    vitepress: true,
    nextra: true
  };

  /** Platforms that say what the whole site is, in `meta[name=generator]`. */
  const FORUM_GENERATORS: Record<string, true | undefined> = {
    discourse: true,
    flarum: true,
    xenforo: true,
    phpbb: true,
    vbulletin: true,
    nodebb: true,
    vanilla: true
  };
  const BLOG_GENERATORS: Record<string, true | undefined> = {
    wordpress: true,
    ghost: true,
    blogger: true,
    substack: true
  };
  const SHOP_GENERATORS: Record<string, true | undefined> = {
    shopify: true,
    woocommerce: true,
    magento: true,
    prestashop: true,
    bigcommerce: true
  };
  const named = (table: Record<string, true | undefined>, value: string): boolean =>
    Object.keys(table).some((name) => value.includes(name));

  function kindOf(meta: PageMeta): PageKind {
    const og = (text(meta.ogType, 60) ?? '').toLowerCase();
    const host = hostOf(meta.host) ?? '';
    const path = (text(meta.path, 300) ?? '').toLowerCase();
    const generator = (text(meta.generator, 80) ?? '').toLowerCase();
    // schema.org types are case-insensitive in practice ("NewsArticle").
    const types = new Set((meta.jsonLdTypes ?? []).map((type) => String(type).toLowerCase()));
    const has = (...names: string[]): boolean => names.some((name) => types.has(name.toLowerCase()));

    // The markup's most specific claim wins, then the site's own shape.
    if (has('QAPage', 'Question')) return 'qa';
    if (has('DiscussionForumPosting', 'SocialMediaPosting')) return 'forum';
    if (og.startsWith('product') || has('Product')) return 'product';
    if (has('Recipe')) return 'recipe';
    if (og.startsWith('video') || has('VideoObject')) return 'video';
    if (og === 'profile' || has('ProfilePage')) return 'social';
    if (has('NewsArticle', 'ReportageNewsArticle', 'AnalysisNewsArticle')) return 'news';
    if (named(DOC_GENERATORS, generator)) return 'docs';
    if (named(FORUM_GENERATORS, generator)) return 'forum';
    if (named(SHOP_GENERATORS, generator)) return 'product';
    if (named(BLOG_GENERATORS, generator)) return 'blog';
    if (host.startsWith('docs.') || path.includes('/docs/') || path.includes('/manual/')) return 'docs';
    if (has('BlogPosting', 'LiveBlogPosting') || host.startsWith('blog.')) return 'blog';
    // A plain `article` claim is kept as-is: calling a blog post "news" because
    // it has a category would put a wrong register in the prompt.
    if (og === 'article' || has('Article', 'TechArticle', 'ScholarlyArticle')) return 'article';
    if (host.startsWith('forum.')) return 'forum';
    if (path.includes('/search')) return 'search';
    return 'unknown';
  }

  /** Interprets the collected metadata. Pure: the same input gives the same page. */
  export function analyze(meta: PageMeta): PageContext {
    if (!meta || typeof meta !== 'object') return empty();
    const site = text(meta.siteName, MAX_SITE) ?? hostOf(meta.host);
    const title = text(meta.title, MAX_TEXT);

    const tags: string[] = [];
    for (const tag of Array.isArray(meta.tags) ? meta.tags : []) {
      const clean = text(tag, MAX_TAG);
      if (clean && !tags.includes(clean) && tags.length < MAX_TAGS) tags.push(clean);
    }

    // The site's own navigation, minus the page's own name and duplicates.
    const sections: string[] = [];
    for (const label of Array.isArray(meta.navLabels) ? meta.navLabels : []) {
      const clean = text(label, MAX_SECTION);
      if (!clean || sections.length >= MAX_SECTIONS) continue;
      if (clean === site || clean === title || sections.includes(clean)) continue;
      sections.push(clean);
    }

    // Declared subjects first, then named nodes: the prompt line takes the head
    // of this list, so the order is the priority.
    const entities: PageEntity[] = [];
    const seen = new Set<string>();
    const add = (name: unknown, kind: EntityKind): void => {
      const clean = text(name, MAX_ENTITY);
      if (!clean || entities.length >= MAX_ENTITIES) return;
      const key = clean.toLowerCase();
      const siteKey = (site ?? '').toLowerCase();
      if (seen.has(key) || key === siteKey || key === (title ?? '').toLowerCase()) return;
      seen.add(key);
      entities.push({ name: clean, kind });
    };
    for (const name of Array.isArray(meta.about) ? meta.about : []) add(name, 'other');
    for (const entity of Array.isArray(meta.entities) ? meta.entities : []) {
      add(entity?.name, (entity?.kind as EntityKind) ?? 'other');
    }

    const glossary: GlossaryTerm[] = [];
    for (const entry of Array.isArray(meta.glossary) ? meta.glossary : []) {
      if (glossary.length >= MAX_GLOSSARY) break;
      const term = text(entry?.term, MAX_TERM);
      const definition = text(entry?.definition, MAX_DEFINITION);
      if (term && definition) glossary.push({ term, definition });
    }

    return {
      kind: kindOf(meta),
      site,
      title,
      section: text(meta.section, MAX_SITE),
      sections,
      language: text(meta.lang, 35),
      summary: text(meta.description, MAX_TEXT),
      tags,
      entities,
      glossary
    };
  }

  /** "a, b and c" without a comma before a two-item list, and without doubling
   *  the full stop of a name like "Wikimedia Foundation, Inc.". */
  function joinNames(names: string[]): string {
    const clean = names.map((name) => name.replace(/[.;:,]+$/, ''));
    if (clean.length <= 1) return clean[0] ?? '';
    return `${clean.slice(0, -1).join(', ')} and ${clean[clean.length - 1]}`;
  }

  /**
   * One line of context for the model, or null when the page said nothing.
   * Deliberately short: the prompt has a token budget and the text itself is
   * the thing being translated. Glossary terms are not in the line — they are
   * for consistency work, not for describing the page.
   */
  export function hint(context: PageContext | null | undefined): string | null {
    if (!context || typeof context !== 'object') return null;
    const site = context.site ? ` from ${context.site}` : '';
    const section = context.section ? ` in the ${context.section} section` : '';
    let base: string | null = null;
    switch (context.kind) {
      case 'news':
        base = `This is a news article${section}${site}.`;
        break;
      case 'article':
        base = `This is an article${site}.`;
        break;
      case 'blog':
        base = `This is a blog post${site}.`;
        break;
      case 'docs':
        base = 'This is technical documentation.';
        break;
      case 'product':
        base = `This is a product page${site}.`;
        break;
      case 'recipe':
        base = `This is a recipe${site}.`;
        break;
      case 'forum':
        base = `This is a forum discussion${site}.`;
        break;
      case 'qa':
        base = 'This is a question-and-answer page.';
        break;
      case 'video':
        base = `This is the description of a video${site}.`;
        break;
      case 'social':
        base = `This is a social profile${site}.`;
        break;
      case 'search':
        base = 'This is a list of search results.';
        break;
      default:
        // A host alone is not context: every page has one, and saying so would
        // spend prompt tokens and a line of the tuned template on nothing.
        base = null;
    }

    const named: string[] = [];
    for (const entity of Array.isArray(context.entities) ? context.entities : []) {
      const name = text(entity?.name, MAX_ENTITY);
      if (name) named.push(name);
      if (named.length >= MAX_HINT_ENTITIES) break;
    }
    const topic = named.length > 0 ? `${base ? 'It mentions' : 'This text is about'} ${joinNames(named)}.` : null;
    const combined = [base, topic].filter((part): part is string => Boolean(part)).join(' ');
    if (!combined) return null;
    if (combined.length <= MAX_HINT) return combined;
    // Cut on a word boundary rather than mid-name.
    const cut = combined.slice(0, MAX_HINT);
    const space = cut.lastIndexOf(' ');
    return `${(space > MAX_HINT / 2 ? cut.slice(0, space) : cut).replace(/[,;:]$/, '')}.`;
  }

  const KINDS: Record<string, PageKind | undefined> = {
    article: 'article',
    news: 'news',
    blog: 'blog',
    docs: 'docs',
    forum: 'forum',
    product: 'product',
    recipe: 'recipe',
    search: 'search',
    social: 'social',
    video: 'video',
    unknown: 'unknown'
  };

  const ENTITY_KINDS: Record<string, EntityKind | undefined> = {
    person: 'person',
    organization: 'organization',
    place: 'place',
    event: 'event',
    term: 'term',
    work: 'work',
    other: 'other'
  };

  /** A context that crossed a message boundary: nothing in it is trusted. */
  export function normalize(raw: unknown): PageContext | null {
    if (!raw || typeof raw !== 'object') return null;
    const input = raw as Record<string, unknown>;

    const list = (value: unknown, limit: number, each: (item: unknown) => string | null): string[] => {
      const out: string[] = [];
      for (const item of Array.isArray(value) ? value.slice(0, limit) : []) {
        const clean = each(item);
        if (clean) out.push(clean);
      }
      return out;
    };

    const tags: string[] = [];
    for (const tag of list(input.tags, MAX_TAGS, (item) => text(item, MAX_TAG))) {
      if (!tags.includes(tag)) tags.push(tag);
    }
    const sections: string[] = [];
    for (const section of list(input.sections, MAX_SECTIONS, (item) => text(item, MAX_SECTION))) {
      if (!sections.includes(section)) sections.push(section);
    }

    const entities: PageEntity[] = [];
    for (const entry of Array.isArray(input.entities) ? input.entities.slice(0, MAX_ENTITIES) : []) {
      const record = (entry ?? {}) as Record<string, unknown>;
      const name = text(record.name, MAX_ENTITY);
      if (!name) continue;
      entities.push({ name, kind: ENTITY_KINDS[String(record.kind)] ?? 'other' });
    }

    const glossary: GlossaryTerm[] = [];
    for (const entry of Array.isArray(input.glossary) ? input.glossary.slice(0, MAX_GLOSSARY) : []) {
      const record = (entry ?? {}) as Record<string, unknown>;
      const term = text(record.term, MAX_TERM);
      const definition = text(record.definition, MAX_DEFINITION);
      if (term && definition) glossary.push({ term, definition });
    }

    return {
      kind: KINDS[String(input.kind)] ?? 'unknown',
      site: text(input.site, MAX_SITE),
      title: text(input.title, MAX_TEXT),
      section: text(input.section, MAX_SITE),
      sections,
      language: text(input.language, 35),
      summary: text(input.summary, MAX_TEXT),
      tags,
      entities,
      glossary
    };
  }
}

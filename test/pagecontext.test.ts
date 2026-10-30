import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.ts';

// The analyzer is pure, so the rules that decide "what page is this" are tested
// without a browser; `collect` is tested against a stand-in that only offers the
// two DOM calls it is allowed to make.
const AT = load('lib/constants.js', 'lib/pagecontext.js');
const { pagecontext } = AT;

/** A document stand-in: selectors map to one node or a list of nodes. */
function document_({ title = '', lang = '', href = '', meta = {}, nodes = {} }: {
  title?: string;
  lang?: string;
  href?: string;
  meta?: Record<string, string>;
  nodes?: Record<string, { content?: string; text?: string; href?: string; tag?: string; title?: string }[]>;
}) {
  const node = (content?: string, text?: string, link?: string, tag?: string, title_?: string) => ({
    getAttribute: (name: string) =>
      name === 'content'
        ? (content ?? null)
        : name === 'href'
          ? (link ?? null)
          : name === 'title'
            ? (title_ ?? null)
            : null,
    textContent: text ?? null,
    tagName: tag
  });
  return {
    title,
    documentElement: { lang },
    location: { href },
    querySelector(selector: string) {
      const key = selector.match(/meta\[(?:property|name)="([^"]+)"\]/)?.[1];
      if (key && meta[key] !== undefined) return node(meta[key]);
      if (selector === 'link[rel="canonical"]') return meta.canonical ? node(undefined, undefined, meta.canonical) : null;
      if (selector === 'h1') return nodes.h1?.[0] ? node(undefined, nodes.h1[0].text) : null;
      return null;
    },
    querySelectorAll(selector: string) {
      if (selector.includes('article:tag')) return (nodes.tags ?? []).map((entry) => node(entry.content));
      if (selector.includes('application/ld+json')) return (nodes.json ?? []).map((entry) => node(undefined, entry.text));
      if (selector.includes('nav a')) return (nodes.nav ?? []).map((entry) => node(undefined, entry.text));
      if (selector === 'dl') {
        if (!nodes.glossary) return [];
        // One <dl> holding the term/definition pairs of the fixture.
        return [
          {
            getAttribute: () => null,
            textContent: null,
            tagName: 'dl',
            querySelectorAll: (inner: string) =>
              inner === 'dt' ? (nodes.glossary ?? []).map((entry) => ({ ...node(undefined, entry.text), nextElementSibling: node(undefined, entry.content ?? undefined, undefined, 'dd') })) : []
          }
        ];
      }
      if (selector.includes('abbr[title]')) return (nodes.abbr ?? []).map((entry) => node(undefined, entry.text, undefined, 'abbr', entry.title));
      return [];
    }
  };
}

test('a news article is recognised, with its section and site', () => {
  const meta = pagecontext.collect(
    document_({
      title: 'Election results',
      lang: 'en-GB',
      href: 'https://www.example-news.com/politics/2026/results',
      meta: {
        'og:title': 'Election results: the full map',
        'og:site_name': 'Example News',
        'og:type': 'article',
        'article:section': 'Politics',
        description: '  Who won where,  and by how much.  ',
        canonical: 'https://example-news.com/politics/2026/results'
      },
      nodes: { json: [{ text: '{"@type": "NewsArticle", "headline": "x"}' }] }
    })
  );
  const context = pagecontext.analyze(meta);
  assert.equal(context.kind, 'news');
  assert.equal(context.site, 'Example News');
  assert.equal(context.title, 'Election results: the full map');
  assert.equal(context.section, 'Politics');
  assert.equal(context.language, 'en-GB');
  assert.equal(context.summary, 'Who won where, and by how much.', 'whitespace is collapsed');
  assert.equal(
    pagecontext.hint(context),
    'This is a news article in the Politics section from Example News.'
  );
});

test('the markup beats the URL, and the site name beats the host', () => {
  const product = pagecontext.analyze(
    pagecontext.collect(
      document_({
        href: 'https://shop.example.com/p/42',
        meta: { 'og:type': 'product', 'og:site_name': 'Example Shop' }
      })
    )
  );
  assert.equal(product.kind, 'product', 'og:type wins over the path');
  assert.equal(product.site, 'Example Shop');
  assert.equal(pagecontext.hint(product), 'This is a product page from Example Shop.');
});

test('a page with no markup is unknown, and says nothing it cannot back', () => {
  const context = pagecontext.analyze(pagecontext.collect(document_({ href: 'https://example.com/' })));
  assert.equal(context.kind, 'unknown');
  assert.equal(context.site, 'example.com', 'the host is the last resort for a site name');
  assert.equal(pagecontext.hint(context), null, 'a host alone is not worth a prompt line');

  const nothing = pagecontext.analyze(pagecontext.collect(document_({})));
  assert.equal(nothing.site, null);
  assert.equal(pagecontext.hint(nothing), null, 'a blank page adds no context line');
});

test('docs sites are recognised from the generator, not only the host', () => {
  const context = pagecontext.analyze(
    pagecontext.collect(
      document_({
        href: 'https://project.example.com/guide/start',
        meta: { generator: 'Docusaurus v3.1', 'og:site_name': 'Project Docs' }
      })
    )
  );
  assert.equal(context.kind, 'docs');
  assert.equal(pagecontext.hint(context), 'This is technical documentation.');
});

test('schema.org types are read without parsing the whole script', () => {
  const meta = pagecontext.collect(
    document_({
      href: 'https://forum.example.com/t/123',
      nodes: {
        json: [
          { text: '{"@graph": [{"@type": "Organization"}, {"@type": "DiscussionForumPosting"}]}' },
          { text: 'not json at all' },
          { text: '{"@type":"BreadcrumbList"}' }
        ]
      }
    })
  );
  assert.deepEqual(meta.jsonLdTypes, ['Organization', 'DiscussionForumPosting', 'BreadcrumbList']);
  assert.equal(pagecontext.analyze(meta).kind, 'forum');
});

test('a blog post with a category stays a blog post', () => {
  const context = pagecontext.analyze(
    pagecontext.collect(
      document_({
        href: 'https://blog.example.com/2026/notes',
        meta: { 'og:type': 'article', 'article:section': 'Engineering' },
        nodes: { json: [{ text: '{"@type": "BlogPosting"}' }] }
      })
    )
  );
  assert.equal(context.kind, 'blog', 'a category is not a claim of news reporting');
});

test('tags are bounded, de-duplicated and split on commas', () => {
  const meta = pagecontext.collect(
    document_({
      nodes: {
        tags: [
          { content: 'alpha' },
          { content: 'beta, gamma' },
          { content: 'alpha' },
          ...Array.from({ length: 10 }, (_unused, index) => ({ content: `tag-${index}` }))
        ]
      }
    })
  );
  const context = pagecontext.analyze(meta);
  assert.equal(context.tags.length, 8);
  assert.deepEqual(context.tags.slice(0, 3), ['alpha', 'beta', 'gamma']);
});

test('the collector never runs away on a hostile page', () => {
  const huge = 'x'.repeat(50000);
  const meta = pagecontext.collect(
    document_({
      title: huge,
      lang: 'en',
      href: `https://example.com/${'a'.repeat(3000)}`,
      meta: { 'og:title': huge, 'og:site_name': huge, description: huge, generator: huge },
      nodes: { json: [{ text: `{"@type": "${huge}"}` }] }
    })
  );
  const context = pagecontext.analyze(meta);
  assert.ok((context.title ?? '').length <= 200);
  assert.ok((context.site ?? '').length <= 80);
  assert.ok((context.summary ?? '').length <= 200);
  assert.deepEqual(meta.jsonLdTypes ?? [], [], 'an absurd type name is not a type');
});

test('a context that crossed a message boundary is rebuilt, not trusted', () => {
  const context = pagecontext.normalize({
    kind: 'not-a-kind',
    site: '  Example   Site ',
    title: 42,
    section: null,
    language: ' en ',
    summary: 'x'.repeat(500),
    tags: [' a ', '', 7, 'b']
  });
  assert.deepEqual(context, {
    kind: 'unknown',
    site: 'Example Site',
    title: null,
    section: null,
    sections: [],
    language: 'en',
    summary: 'x'.repeat(200),
    tags: ['a', 'b'],
    entities: [],
    glossary: []
  });
  assert.equal(pagecontext.normalize(null), null);
  assert.equal(pagecontext.normalize('nope'), null);
});

// --- the two levels, collected mechanically --------------------------------

test('structured data yields the entities the page declares', () => {
  const meta = pagecontext.collect(
    document_({
      href: 'https://example-news.com/politics/vote',
      meta: { 'og:site_name': 'Example News' },
      nodes: {
        json: [
          {
            text: JSON.stringify({
              '@context': 'https://schema.org',
              '@graph': [
                { '@type': 'NewsArticle', name: 'The vote', about: ['the budget', 'the coalition'] },
                { '@type': 'Person', name: 'Alice Smith' },
                { '@type': 'Organization', name: 'Example News' },
                { '@type': 'DefinedTerm', name: 'filibuster', description: 'a delaying tactic' },
                { '@type': 'Place', name: 'Brussels' },
                { '@type': 'WebPage', name: 'The vote' }
              ]
            })
          }
        ]
      }
    })
  );
  const context = pagecontext.analyze(meta);

  assert.equal(context.kind, 'news');
  assert.deepEqual(
    context.entities.map((entity: { name: string; kind: string }) => `${entity.kind}:${entity.name}`),
    [
      // Declared subjects first, in the order the page lists them…
      'other:the budget',
      'other:the coalition',
      // …then the people and terms the graph names. The article itself, the
      // publisher organisation and the locale are not topics: the first is the
      // title, the others are the site.
      'person:Alice Smith',
      'term:filibuster'
    ]
  );
});

test('the page names its subjects in the hint, within one line', () => {
  const context = pagecontext.analyze(
    pagecontext.collect(
      document_({
        href: 'https://example-news.com/politics/vote',
        meta: { 'og:site_name': 'Example News', 'og:type': 'article', 'article:section': 'Politics' },
        nodes: {
          json: [
            {
              text: JSON.stringify({
                '@graph': [
                  { '@type': 'NewsArticle', about: ['the budget'] },
                  { '@type': 'Person', name: 'Alice Smith' },
                  { '@type': 'Person', name: 'Bob Jones' },
                  { '@type': 'Person', name: 'Carol White' },
                  { '@type': 'Person', name: 'Dave Brown' }
                ]
              })
            }
          ]
        }
      })
    )
  );
  assert.equal(
    pagecontext.hint(context),
    'This is a news article in the Politics section from Example News. ' +
      'It mentions the budget, Alice Smith and Bob Jones.',
  );
});

test('an unnamed page still gets a topic line when it names something', () => {
  const context = pagecontext.analyze(
    pagecontext.collect(
      document_({
        href: 'https://wiki.example.com/f/1',
        nodes: { json: [{ text: JSON.stringify({ '@type': 'DefinedTerm', name: 'entropy' }) }] }
      })
    )
  );
  assert.equal(context.kind, 'unknown');
  assert.equal(pagecontext.hint(context), 'This text is about entropy.');
});

test('navigation labels become the site sections, without the page name', () => {
  const context = pagecontext.analyze(
    pagecontext.collect(
      document_({
        title: 'Latest',
        meta: { 'og:site_name': 'Example' },
        nodes: {
          nav: [
            { text: 'World' },
            { text: 'Politics' },
            { text: 'World' },
            { text: 'Latest' },
            { text: '  42 ' },
            { text: 'Business' }
          ]
        }
      })
    )
  );
  assert.deepEqual(context.sections, ['World', 'Politics', 'Business']);
  assert.equal(pagecontext.hint(context), null, 'sections alone are not a page kind');
});

test('a term list is read from dl pairs and abbr titles', () => {
  const context = pagecontext.analyze(
    pagecontext.collect(
      document_({
        nodes: {
          glossary: [
            { text: 'DRM', content: 'digital rights management' },
            { text: 'CDN', content: 'content delivery network' }
          ],
          abbr: [{ text: 'MMO', title: 'massively multiplayer online' }]
        }
      })
    )
  );
  assert.deepEqual(context.glossary, [
    { term: 'DRM', definition: 'digital rights management' },
    { term: 'CDN', definition: 'content delivery network' },
    { term: 'MMO', definition: 'massively multiplayer online' }
  ]);
});

test('a broken graph still names its type, and never throws', () => {
  const meta = pagecontext.collect(
    document_({
      nodes: { json: [{ text: '{"@graph": [{"@type": "NewsArticle", "name": "trunc' }] }
    })
  );
  assert.deepEqual(meta.jsonLdTypes, ['NewsArticle'], 'the fallback scan reads what is there');
  assert.equal(pagecontext.analyze(meta).kind, 'news');
});

test('deep or wide structured data is bounded, not traversed', () => {
  let deep: Record<string, unknown> = { '@type': 'Person', name: 'deep' };
  for (let i = 0; i < 40; i += 1) deep = { child: deep };
  const many = Array.from({ length: 1200 }, (_unused, index) => ({ '@type': 'Person', name: `p${index}` }));
  const context = pagecontext.analyze(
    pagecontext.collect(
      document_({
        nodes: {
          json: [
            { text: JSON.stringify(deep) },
            { text: JSON.stringify(many) }
          ]
        }
      })
    )
  );
  assert.ok(context.entities.length <= 12, `entities are capped, got ${context.entities.length}`);
  assert.ok(!context.entities.some((entity: { name: string }) => entity.name === 'deep'), 'the 40-deep node is not reached');
});

// --- shapes taken from real pages ------------------------------------------

test('a shop that lists every variant in JSON-LD is still one product page', () => {
  // ikea.com: og:type "product.group", a WebSite + Organization + Country and an
  // ItemList of 24 Product nodes. Only the page's kind is context; the variants
  // are a catalogue, not the subject.
  const variants = Array.from({ length: 24 }, (_unused, index) => ({
    '@type': 'Product',
    name: `BILLY, Bookcase, white, ${index} 1/2x11x79 1/2 "`
  }));
  const context = pagecontext.analyze(
    pagecontext.collect(
      document_({
        href: 'https://www.ikea.com/us/en/p/billy-bookcase-white-00263850/',
        meta: { 'og:type': 'product.group', 'og:site_name': 'IKEA' },
        nodes: {
          json: [
            {
              text: JSON.stringify({
                '@graph': [
                  { '@type': 'WebSite', name: 'IKEA' },
                  { '@type': 'Organization', name: 'IKEA' },
                  { '@type': 'Country', name: 'US' },
                  { '@type': 'ItemList', itemListElement: variants }
                ]
              })
            }
          ]
        }
      })
    )
  );
  assert.equal(context.kind, 'product');
  assert.deepEqual(context.entities, [], 'no catalogue entries, no locale marker');
  assert.equal(pagecontext.hint(context), 'This is a product page from IKEA.');
});

test('a forum is recognised from its platform alone', () => {
  // meta.discourse.org ships no JSON-LD; the generator string is the claim.
  const context = pagecontext.analyze(
    pagecontext.collect(
      document_({
        href: 'https://meta.discourse.org/t/welcome/1',
        meta: { 'og:type': 'website', 'og:site_name': 'Discourse Meta', generator: 'Discourse 2026.11.0-latest' }
      })
    )
  );
  assert.equal(context.kind, 'forum');
  assert.equal(pagecontext.hint(context), 'This is a forum discussion from Discourse Meta.');
});

test('a page whose markup claims nothing stays unknown and silent', () => {
  // github.com: og:type "object", no JSON-LD, no article metadata.
  const context = pagecontext.analyze(
    pagecontext.collect(
      document_({
        href: 'https://github.com/GoogleChrome/lighthouse',
        meta: { 'og:type': 'object', 'og:site_name': 'GitHub' }
      })
    )
  );
  assert.equal(context.kind, 'unknown');
  assert.equal(pagecontext.hint(context), null, 'the model is not told a guess');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.ts';

// The target-selection engine is pure: regions from semantics, priority from
// geometry, order from both. No DOM, so every rule is a table here.
const AT = load('lib/constants.js', 'lib/targets.js');
const { targets } = AT;

const info = (over: Record<string, unknown> = {}) => ({
  tag: 'p',
  ariaRole: null,
  inArticle: false,
  inComment: false,
  inNav: false,
  inForm: false,
  inFooter: false,
  inAside: false,
  inList: false,
  inHeading: false,
  markers: '',
  ...over
});

test('a comment inside an article is a comment', () => {
  assert.equal(targets.roleOf(info({ inArticle: true, inComment: true })), 'comment');
  // Sites that cannot use <article> still say it in the class name.
  assert.equal(targets.roleOf(info({ inArticle: true, markers: 'comment-body' })), 'comment');
  assert.equal(targets.roleOf(info({ ariaRole: 'comment' })), 'comment');
});

test('comment prose precedes author metadata and reply controls', () => {
  const roles = [
    targets.roleOf(info({ inComment: true, inForm: true, tag: 'span' })),
    targets.roleOf(info({ inComment: true, inCommentMetadata: true })),
    targets.roleOf(info({ inComment: true, tag: 'time' })),
    targets.roleOf(info({ inComment: true }))
  ];
  assert.deepEqual(roles, ['form', 'metadata', 'metadata', 'comment']);
  const order = targets.plan(roles.map((role: string, index: number) => ({
    id: String(index), role, priority: 'visible', order: index, top: 20 * index
  }))).flatMap((group: { ids: string[] }) => group.ids);
  assert.deepEqual(order, ['3', '0', '1', '2']);
});

test('hidden continuations follow ordinary work even when their element is visible', () => {
  const entries = [
    { id: 'hidden', role: 'comment', priority: 'visible', top: 10, order: 0, deferred: true },
    { id: 'reply', role: 'comment', priority: 'visible', top: 200, order: 1 },
    { id: 'author', role: 'metadata', priority: 'visible', top: 100, order: 2 },
    { id: 'later', role: 'comment', priority: 'far', top: 3000, order: 3 }
  ];
  assert.deepEqual(targets.plan(entries).flatMap((group: { ids: string[] }) => group.ids),
    ['reply', 'author', 'later', 'hidden']);
});

test('a list inside an article is article text, not a list of its own', () => {
  assert.equal(targets.roleOf(info({ inArticle: true, inList: true, tag: 'li' })), 'article');
  assert.equal(targets.roleOf(info({ inList: true, tag: 'li' })), 'list');
});

test('navigation wins over the footer it sits in, and over prose', () => {
  assert.equal(targets.roleOf(info({ inFooter: true, inNav: true })), 'navigation');
  assert.equal(targets.roleOf(info({ inForm: true })), 'form');
  assert.equal(targets.roleOf(info({ inHeading: true, tag: 'h2' })), 'heading');
  assert.equal(targets.roleOf(info({ inAside: true })), 'aside');
  assert.equal(targets.roleOf(info({ inFooter: true })), 'footer');
  assert.equal(targets.roleOf(info({ tag: 'time' })), 'metadata');
  assert.equal(targets.roleOf(info()), 'unknown');
});

test('ARIA roles are read when the elements are not semantic', () => {
  assert.equal(targets.roleOf(info({ ariaRole: 'navigation', tag: 'div' })), 'navigation');
  assert.equal(targets.roleOf(info({ ariaRole: 'main', tag: 'div' })), 'article');
  assert.equal(targets.roleOf(info({ ariaRole: 'contentinfo', tag: 'div' })), 'footer');
  assert.equal(targets.roleOf(info({ ariaRole: 'list', tag: 'div' })), 'list');
});
test('unmarked card prose is content while explicit supporting regions retain their roles', () => {
  assert.equal(targets.isContent(targets.roleOf(info({ tag: 'div' }))), true);
  assert.equal(targets.roleOf(info({ inComment: true, inAside: true })), 'aside');
  assert.equal(targets.roleOf(info({ inComment: true, inNav: true })), 'navigation');
  const candidates = [
    { id: 'sidebar', role: 'aside', priority: 'visible', order: 0, top: 0 },
    { id: 'bottom-card', role: 'unknown', priority: 'visible', order: 1, top: 300 },
    { id: 'headline', role: 'heading', priority: 'visible', order: 2, top: 10 },
    { id: 'top-card', role: 'unknown', priority: 'visible', order: 3, top: 100 },
    { id: 'next-card', role: 'unknown', priority: 'near', order: 4, top: 1000 }
  ];
  assert.deepEqual(targets.plan(candidates).flatMap((group: { ids: string[] }) => group.ids),
    ['headline', 'top-card', 'bottom-card', 'sidebar', 'next-card']);
});


test('priority is viewport first, then a ring around it', () => {
  const viewport = { top: 0, height: 800 };
  assert.equal(targets.priorityOf({ top: 100, bottom: 140 }, viewport), 'visible');
  assert.equal(targets.priorityOf({ top: -200, bottom: 0 }, viewport), 'visible', 'touching the top edge counts');
  assert.equal(targets.priorityOf({ top: 900, bottom: 940 }, viewport), 'near', 'one screen below');
  assert.equal(targets.priorityOf({ top: 5000, bottom: 5040 }, viewport), 'far');
  assert.equal(targets.priorityOf({ top: Number.NaN, bottom: 0 }, viewport), 'far', 'an unmeasured node is not urgent');
});

test('visible chrome is scheduled before distant content', () => {
  // Visibility is a hard boundary, including supporting UI versus near prose.
  const candidates = [
    { id: 'far-below', role: 'article', priority: 'far', order: 5, top: 2600 },
    { id: 'visible-body', role: 'article', priority: 'visible', order: 1, top: 300 },
    { id: 'visible-menu', role: 'navigation', priority: 'visible', order: 0, top: 120 },
    { id: 'above-fold', role: 'article', priority: 'far', order: 9, top: -700 },
    { id: 'next-band', role: 'heading', priority: 'near', order: 3, top: 1000 },
    { id: 'footer', role: 'footer', priority: 'far', order: 12, top: 4000 }
  ];
  const groups = targets.plan(candidates, { band: 900 });
  assert.deepEqual(
    groups.map((group: { role: string; ids: string[] }) => `${group.role}:${group.ids.join(',')}`),
    ['article:visible-body', 'navigation:visible-menu', 'heading:next-band', 'article:far-below', 'article:above-fold', 'footer:footer'],
    'all visible text precedes next-screen prefetch'
  );
  assert.equal(targets.isContent('article'), true);
  assert.equal(targets.isContent('heading'), true);
  assert.equal(targets.isContent('navigation'), false);
  assert.equal(targets.isContent('footer'), false);
  assert.equal(targets.isContent('comment'), true, 'a comment thread is page content, not chrome');
});

test('a lower comment never jumps ahead of the visible title and body', () => {
  const candidates = [
    { id: 'body', role: 'article', priority: 'visible', order: 0, top: 120 },
    { id: 'heading', role: 'heading', priority: 'visible', order: 1, top: 90 },
    { id: 'menu', role: 'navigation', priority: 'visible', order: 2, top: 60 },
    { id: 'comment', role: 'comment', priority: 'visible', order: 3, top: 900 }
  ];
  const groups = targets.plan(candidates, { band: 1000 });
  assert.deepEqual(
    groups.map((group: { role: string }) => group.role),
    ['heading', 'article', 'comment', 'navigation'],
    'main content follows rendered top-to-bottom order, not a comment-first role bucket'
  );
});

test('document order survives inside a group, and a limit caps the plan', () => {
  const candidates = [
    { id: 'b', role: 'article', priority: 'visible', order: 2 },
    { id: 'a', role: 'article', priority: 'visible', order: 1 },
    { id: 'c', role: 'article', priority: 'visible', order: 3 }
  ];
  assert.deepEqual(targets.plan(candidates)[0].ids, ['a', 'b', 'c']);
  assert.deepEqual(targets.plan(candidates, { limit: 2 })[0].ids, ['a', 'b']);
});

test('junk candidates are ignored instead of poisoning the plan', () => {
  const groups = targets.plan([
    null,
    { id: 42, role: 'article', priority: 'visible', order: 1 },
    { id: 'x', role: 'nonsense', priority: 'visible', order: 2 },
    { id: 'ok', role: 'article', priority: 'visible', order: 3 }
  ] as unknown as never);
  assert.deepEqual(groups.map((group: { ids: string[] }) => group.ids), [['ok']]);
});

test('visual order wins over DOM order and preserves intervening headings', () => {
  const candidates = [
    { id: 'bottom', role: 'article', priority: 'visible', order: 0, top: 500 },
    { id: 'section', role: 'heading', priority: 'visible', order: 1, top: 300 },
    { id: 'top', role: 'article', priority: 'visible', order: 2, top: 100 }
  ];
  assert.deepEqual(targets.plan(candidates).map((group: { ids: string[] }) => group.ids),
    [['top'], ['section'], ['bottom']]);
  assert.deepEqual(targets.plan(candidates, { limit: 2 }).flatMap((group: { ids: string[] }) => group.ids),
    ['top', 'section']);
});

test('same-line targets use inline geometry, with stable order when boxes tie', () => {
  const candidates = [
    { id: 'right', role: 'article', priority: 'visible', order: 0, top: 100, inlineStart: 300 },
    { id: 'left', role: 'article', priority: 'visible', order: 1, top: 100, inlineStart: 20 },
    { id: 'left-next', role: 'article', priority: 'visible', order: 2, top: 100, inlineStart: 20 }
  ];
  assert.deepEqual(targets.plan(candidates)[0].ids, ['left', 'left-next', 'right']);
  assert.deepEqual(targets.plan(candidates.map((entry) => ({ ...entry, inlineStart: -entry.inlineStart })))[0].ids,
    ['right', 'left', 'left-next']);
});

test('reading regions finish a column before crossing to the next in LTR and RTL', () => {
  for (const rtl of [false, true]) {
    const first = { id: 1, top: 0, inlineStart: rtl ? -900 : 10, order: 3, documentFlow: false };
    const second = { id: 2, top: 0, inlineStart: rtl ? -400 : 500, order: 0, documentFlow: false };
    const candidates = [
      { id: 'other-top', region: second, top: 10, order: 0 },
      { id: 'first-bottom', region: first, top: 400, order: 1 },
      { id: 'other-bottom', region: second, top: 200, order: 2 },
      { id: 'first-top', region: first, top: 20, order: 3 }
    ].map(entry => ({ ...entry, role: 'article', priority: 'visible' }));
    assert.deepEqual(targets.plan(candidates).flatMap((group: { ids: string[] }) => group.ids),
      ['first-top', 'first-bottom', 'other-top', 'other-bottom']);
  }
});

test('CSS multicolumn regions preserve authored flow instead of interleaving rows', () => {
  const region = { id: 1, top: 0, inlineStart: 0, order: 0, documentFlow: true };
  const candidates = [20, 300, 10, 200].map((top, order) =>
    ({ id: String(order), region, top, order, role: 'article', priority: 'visible' }));
  assert.deepEqual(targets.plan(candidates).flatMap((group: { ids: string[] }) => group.ids), ['0', '1', '2', '3']);
});

test('reader intent cannot promote offscreen work and visible partial units precede fresh regions', () => {
  const first = { id: 1, top: 0, inlineStart: 0, order: 0, documentFlow: false };
  const second = { id: 2, top: 0, inlineStart: 500, order: 1, documentFlow: false };
  const candidates = [
    { id: 'body', role: 'article', priority: 'visible', order: 0, region: first },
    { id: 'partial', role: 'article', priority: 'visible', order: 1, region: second, continuation: 'preferred' },
    { id: 'selected', role: 'aside', priority: 'visible', order: 2, engaged: true },
    { id: 'prefetch', role: 'article', priority: 'near', order: 3, engaged: true },
    { id: 'support', role: 'aside', priority: 'visible', order: 4 }
  ];
  assert.deepEqual(targets.plan(candidates).flatMap((group: { ids: string[] }) => group.ids),
    ['selected', 'partial', 'body', 'support', 'prefetch']);
});

test('visible continuations get a turn before fresh text but yield after their quantum allowance', () => {
  const entries = [
    { id: 'new', role: 'article', priority: 'visible', top: 10, order: 0 },
    { id: 'partial', role: 'article', priority: 'visible', top: 200, order: 1, continuation: 'preferred' }
  ];
  assert.deepEqual(targets.plan(entries).flatMap((group: { ids: string[] }) => group.ids), ['partial', 'new']);
  entries[1]!.continuation = 'yielding';
  assert.deepEqual(targets.plan(entries).flatMap((group: { ids: string[] }) => group.ids), ['new', 'partial']);
});

test('each region gets a line the prompt can use, and prose gets none', () => {
  assert.equal(targets.roleHint('navigation'), 'These are navigation labels.');
  assert.equal(targets.roleHint('comment'), 'These are reader comments.');
  assert.equal(targets.roleHint('article'), null, 'the page context already says what an article is');
  assert.equal(targets.roleHint('unknown'), null);
  assert.equal(targets.normalizeRole('comment'), 'comment');
  assert.equal(targets.normalizeRole('nope'), 'unknown');
  assert.equal(targets.normalizeRole(null), 'unknown');
});

test('sentences end at sentence punctuation', () => {
  assert.deepEqual(targets.sentences('One. Two! Three?'), ['One.', 'Two!', 'Three?']);
  // `Intl.Segmenter` is not abbreviation-aware: "Dr." becomes its own segment.
  // Good enough for cutting batches, so the limitation is pinned rather than
  // papered over.
  assert.deepEqual(targets.sentences('Dr. Smith left.'), ['Dr.', 'Smith left.']);
  assert.deepEqual(targets.sentences('한국어 문장입니다. 다음 문장입니다.'), ['한국어 문장입니다.', '다음 문장입니다.']);
  assert.deepEqual(targets.sentences(''), []);
  assert.deepEqual(targets.sentences(null), []);
  assert.deepEqual(targets.sentences('   '), []);
});

test('the context line is capped and keeps the page before the region', () => {
  assert.equal(
    targets.composeContext('This is a news article from Example News.', 'These are reader comments.'),
    'This is a news article from Example News. These are reader comments.'
  );
  assert.equal(targets.composeContext('Only the page.', null), 'Only the page.');
  assert.equal(targets.composeContext(null, 'These are navigation labels.'), 'These are navigation labels.');
  assert.equal(targets.composeContext('   ', undefined), '', 'nothing to say is an empty string');

  const long = 'word '.repeat(200);
  const composed = targets.composeContext('Page line.', long);
  assert.ok(composed.length <= targets.CONTEXT_MAX_CHARS, `capped at ${targets.CONTEXT_MAX_CHARS}, got ${composed.length}`);
  assert.ok(composed.startsWith('Page line.'), 'the page line survives the cut');
  assert.ok(!composed.endsWith(' '), 'cut on a word boundary, not mid-space');
  assert.ok(!/\s{2,}/.test(composed), 'no doubled spaces after joining');
});

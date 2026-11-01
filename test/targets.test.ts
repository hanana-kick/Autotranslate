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

test('priority is viewport first, then a ring around it', () => {
  const viewport = { top: 0, height: 800 };
  assert.equal(targets.priorityOf({ top: 100, bottom: 140 }, viewport), 'visible');
  assert.equal(targets.priorityOf({ top: -200, bottom: 0 }, viewport), 'visible', 'touching the top edge counts');
  assert.equal(targets.priorityOf({ top: 900, bottom: 940 }, viewport), 'near', 'one screen below');
  assert.equal(targets.priorityOf({ top: 5000, bottom: 5040 }, viewport), 'far');
  assert.equal(targets.priorityOf({ top: Number.NaN, bottom: 0 }, viewport), 'far', 'an unmeasured node is not urgent');
});

test('visible chrome is scheduled before distant content', () => {
  // Content (article, headings, lists) first, top to bottom; menus and footers
  // afterwards, also top to bottom. That is what "the meaningful part is fully
  // translated" means when the page is longer than the budget.
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
    'visibility first, with meaningful content first only within the same visibility class'
  );
  assert.equal(targets.isContent('article'), true);
  assert.equal(targets.isContent('heading'), true);
  assert.equal(targets.isContent('navigation'), false);
  assert.equal(targets.isContent('footer'), false);
  assert.equal(targets.isContent('comment'), false, 'a comment thread is content the reader did not ask for first');
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

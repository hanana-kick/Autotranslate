import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.ts';

const AT = load('lib/constants.js', 'lib/rules.js');
const { rules } = AT;

/** A `[pattern, action]` pair, the shape `rules.resolve` is fed in these tests. */
type Rule = [string, string];

const resolve = (list: Rule[], href: string) =>
  rules.resolve(list.map(([pattern, action]) => ({ pattern, action })), href);

test('a bare host matches the apex domain and every subdomain', () => {
  assert.equal(resolve([['example.com', 'always']], 'https://example.com/').action, 'always');
  assert.equal(resolve([['example.com', 'always']], 'https://www.example.com/a/b').action, 'always');
  assert.equal(resolve([['example.com', 'always']], 'https://shop.example.com/').action, 'always');
  assert.equal(resolve([['example.com', 'always']], 'https://notexample.com/'), null);
  assert.equal(resolve([['example.com', 'always']], 'https://example.com.evil.test/'), null);
});

test('path patterns narrow a match', () => {
  const list: Rule[] = [['example.com/news/*', 'never']];
  assert.equal(resolve(list, 'https://example.com/news/123').action, 'never');
  assert.equal(resolve(list, 'https://example.com/about'), null);
  assert.equal(resolve(list, 'https://example.com/newsroom/123'), null);
});

test('an explicit scheme is required when the pattern carries one', () => {
  const list: Rule[] = [['https://example.com/news/*', 'never']];
  assert.equal(resolve(list, 'https://example.com/news/1').action, 'never');
  assert.equal(resolve(list, 'http://example.com/news/1'), null);
});

test('the most specific matching rule wins', () => {
  const list: Rule[] = [
    ['example.com', 'always'],
    ['news.example.com', 'never']
  ];
  assert.equal(resolve(list, 'https://www.example.com/').action, 'always');
  assert.equal(resolve(list, 'https://news.example.com/').action, 'never');
  assert.equal(resolve(list, 'https://archive.news.example.com/').action, 'never');
});

test('an explicit scheme outranks a longer host', () => {
  const list: Rule[] = [
    ['news.example.com/top', 'always'],
    ['https://example.com', 'never']
  ];
  assert.equal(resolve(list, 'https://news.example.com/top-story').action, 'never');
});

test('a tie prefers never', () => {
  const list: Rule[] = [
    ['example.com', 'always'],
    ['*.example.com', 'never']
  ];
  assert.equal(resolve(list, 'https://shop.example.com/').action, 'never');
});

test('rules without a usable action or pattern are ignored', () => {
  assert.equal(rules.resolve([{ pattern: 'example.com', action: 'maybe' }], 'https://example.com/'), null);
  assert.equal(rules.resolve([{ pattern: 'not a host', action: 'never' }], 'https://example.com/'), null);
  assert.equal(rules.resolve(null, 'https://example.com/'), null);
  assert.equal(rules.resolve([['example.com', 'never']], 'not-a-url'), null);
});

test('resolve names the stored pattern, not an internal parse field', () => {
  const rule = rules.resolve([{ pattern: 'example.com/news/*', action: 'never' }], 'https://example.com/news/1');
  assert.deepEqual(rule, { action: 'never', pattern: 'example.com/news/*' });
});

test('canonical folds case, wildcards and leading www', () => {
  assert.equal(rules.canonical('  *.Example.com/News/*  '), 'example.com/news/*');
  assert.equal(rules.canonical('www.example.com'), 'example.com');
  assert.equal(rules.canonical('www.Example.com/'), 'example.com', 'a bare trailing slash is not part of the rule');
  assert.equal(rules.canonical('https://example.com'), 'https://example.com');
  assert.equal(rules.canonical(''), null);
  assert.equal(rules.canonical('   '), null);
  assert.equal(rules.canonical('exa mple.com'), null);
  assert.equal(rules.canonical('a'.repeat(300)), null);
});

test('hostPattern gives the popup a default pattern', () => {
  assert.equal(rules.hostPattern('https://www.Example.com/path'), 'example.com');
  assert.equal(rules.hostPattern('chrome://extensions'), null);
  assert.equal(rules.hostPattern(undefined), null);
});

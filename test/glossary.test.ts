import assert from 'node:assert/strict';
import test from 'node:test';
import { load, resetGlobals } from './helpers.ts';

type Entry = { id: string; conceptId: string; language: string; term: string; group: string; traits: string[]; description: string };
type Pair = { source: string; target: string };
type Glossary = {
  select(entries: readonly Entry[], text: string, source: string | null, target: string): Pair[];
  selectSpans(entries: readonly Entry[], text: string, source: string | null, target: string): (Pair & { start: number; end: number })[];
};

function glossary(): Glossary {
  resetGlobals();
  return load('lib/glossary.js').glossary as Glossary;
}
function row(term: string, language: string, conceptId = 'concept', group = 'formal'): Entry {
  return { id: `${conceptId}:${language}:${term}`, conceptId, language, term, group, traits: [], description: '' };
}

test('matches only present source terms and never invents missing targets', () => {
  const g = glossary();
  const entries = [row('猫', 'ja'), row('고양이', 'ko'), row('犬', 'ja', 'dog'), row('dog', 'en', 'dog')];
  assert.deepEqual(g.select(entries, '猫と犬', 'ja', 'ko'), [{ source: '猫', target: '고양이' }]);
  assert.deepEqual(g.select(entries, 'nothing present', 'ja', 'ko'), []);
  assert.deepEqual(g.select(entries, '猫', null, 'ko'), []);
  assert.deepEqual(g.select(entries, '猫', 'und', 'ko'), []);
  assert.deepEqual(g.select(entries, '猫', 'auto', 'ko'), []);
  assert.deepEqual(g.select(entries, '猫', 'fr', 'ko'), []);
  assert.deepEqual(g.select(entries, '猫', 'ja', 'de'), []);
});

test('identity pairs are retained, source text and stored terms are not rewritten', () => {
  const g = glossary();
  const entries = [row('API', 'en'), row('API', 'ko')];
  assert.deepEqual(g.select(entries, 'Use API. API', 'en-US', 'ko-KR'), [{ source: 'API', target: 'API' }]);
  assert.deepEqual(g.select(entries, 'api', 'en', 'ko'), [], 'matching is exact and case preserving');
  assert.deepEqual(g.select([row('猫', 'ja'), row('猫', 'ko')], '猫', 'ja', 'ko'), [{ source: '猫', target: '猫' }]);
});

test('same spelling in multiple concepts or groups is ambiguous even if one target is missing', () => {
  const g = glossary();
  const original = [row('bank', 'en', 'finance'), row('은행', 'ko', 'finance')];
  assert.deepEqual(g.select(original, 'bank', 'en', 'ko'), [{ source: 'bank', target: '은행' }]);
  assert.deepEqual(g.select([...original, row('bank', 'en', 'river')], 'bank', 'en', 'ko'), []);
  assert.deepEqual(g.select([...original, row('bank', 'en', 'finance', 'informal')], 'bank', 'en', 'ko'), []);
  assert.deepEqual(g.select([...original, row('강둑', 'ko', 'river')], 'bank', 'en', 'ko'), [{ source: 'bank', target: '은행' }]);
});

test('target alternatives within the same concept and group are ambiguous, duplicates are not', () => {
  const g = glossary();
  const entries = [row('cat', 'en'), row('고양이', 'ko')];
  assert.deepEqual(g.select([...entries, row('고양이', 'ko')], 'cat', 'en', 'ko'), [{ source: 'cat', target: '고양이' }]);
  assert.deepEqual(g.select([...entries, row('야옹이', 'ko')], 'cat', 'en', 'ko'), []);
  assert.deepEqual(g.select([row('cat', 'en'), row('야옹이', 'ko', 'concept', 'casual')], 'cat', 'en', 'ko'), []);
});

test('a 기본형 mark or the source usage note picks one counterpart; unmarked variants stay ambiguous', () => {
  const g = glossary();
  const entry = (term: string, language: string, traits: string[] = [], description = ''): Entry =>
    ({ ...row(term, language), traits, description });
  const entries = [entry('アーカイブ', 'ja', ['전문어'], '방송 녹화본·다시보기(예: 配信アーカイブ)를 의미한다.'),
    entry('다시보기', 'ko', ['기본형']), entry('아카이브', 'ko', ['전문어'])];
  assert.deepEqual(g.select(entries, 'アーカイブ', 'ja', 'ko'), [{ source: 'アーカイブ', target: '다시보기' }]);
  assert.deepEqual(g.select(entries.map(e => e.term === '다시보기' ? { ...e, traits: [] } : e), 'アーカイブ', 'ja', 'ko'),
    [{ source: 'アーカイブ', target: '다시보기' }], 'the usage note names exactly one counterpart');
  const tied = [entry('ReGLOSS', 'ja', ['기본형'], '그룹명.'), entry('리그로스', 'ko', ['표기 변이']), entry('리글로스', 'ko', ['표기 변이'])];
  assert.deepEqual(g.select(tied, 'ReGLOSS', 'ja', 'ko'), [], 'two unmarked variants with no note stay omitted');
});

test('a canonical mark in one language never marks another language\'s spelling', () => {
  const g = glossary();
  const entry = (term: string, language: string, traits: string[] = [], description = ''): Entry =>
    ({ ...row(term, language), traits, description });
  const entries = [entry('ChroNoiR', 'ja', ['기본형'], '니지산지 유닛의 공식 로마자 표기.'),
    entry('ChroNoiR', 'ko', ['표기 변이']), entry('쿠로노와르', 'ko', ['기본형'])];
  assert.deepEqual(g.select(entries, 'ChroNoiR', 'ja', 'ko'), [{ source: 'ChroNoiR', target: '쿠로노와르' }],
    'the Korean 기본형 mark decides, not the Japanese one');
  const sameSpelling = [entry('桜魔皇国', 'ja', ['기본형']), entry('桜魔皇国', 'ko', ['표기 변이']),
    entry('오우마 황국', 'ko', ['기본형'])];
  assert.deepEqual(g.select(sameSpelling, '桜魔皇国', 'ja', 'ko'), [{ source: '桜魔皇国', target: '오우마 황국' }]);
});

test('the source usage note is read in the source language, not a same-spelling row', () => {
  const g = glossary();
  const entry = (term: string, language: string, traits: string[] = [], description = ''): Entry =>
    ({ ...row(term, language), traits, description });
  const entries = [entry('下线', 'zh', [], '중국어 설명.'), entry('下线', 'ko', [], '한국어 설명.'),
    entry('오프라인', 'ko', [])];
  assert.deepEqual(g.select(entries, '下线', 'zh', 'ko'), [],
    'neither note names a counterpart, so the pair stays ambiguous');
  const named = [entry('下线', 'zh', [], '한국어로 오프라인이라 부른다.'), entry('下线', 'ko', [], '다른 설명.'),
    entry('오프라인', 'ko', []), entry('하차', 'ko', [])];
  assert.deepEqual(g.select(named, '下线', 'zh', 'ko'), [{ source: '下线', target: '오프라인' }],
    'only the source-language note names a counterpart');
});

test('a candidate with the same register wins when no mark or note singles one out', () => {
  const g = glossary();
  const entry = (term: string, language: string, traits: string[] = [], description = ''): Entry =>
    ({ ...row(term, language), traits, description });
  const entries = [entry('企業勢', 'ja', ['전문어']), entry('기업 소속 버튜버', 'ko', ['설명형']),
    entry('기업세', 'ko', ['전문어'])];
  assert.deepEqual(g.select(entries, '企業勢', 'ja', 'ko'), [{ source: '企業勢', target: '기업세' }],
    'the specialist counterpart keeps the source register');
  const tied = [entry('お嬢', 'ja', ['별칭', '경칭 포함']), entry('아가씨', 'ko', ['별칭', '경칭 포함']),
    entry('오죠', 'ko', ['별칭', '경칭 포함'])];
  assert.deepEqual(g.select(tied, 'お嬢', 'ja', 'ko'), [], 'two candidates of the same register stay ambiguous');
});

test('legacy entries without traits or a description keep the single-counterpart path', () => {
  const g = glossary();
  const legacy = [{ id: 'a', conceptId: 'c', language: 'ja', term: '猫', group: 'g' },
    { id: 'b', conceptId: 'c', language: 'ko', term: '고양이', group: 'g' }] as unknown as Entry[];
  assert.deepEqual(g.select(legacy, '猫', 'ja', 'ko'), [{ source: '猫', target: '고양이' }]);
});

test('a katakana term glued to a hiragana word is a fragment, not a match; particles still separate', () => {
  const g = glossary();
  const entries = [row('ママ', 'ja', 'designer'), row('마마', 'ko', 'designer')];
  assert.deepEqual(g.select(entries, 'イラストがみすみママなの', 'ja', 'ko'), [],
    '마마 must not replace the head of the name みすみママ');
  assert.deepEqual(g.select(entries, 'アーカイブをママとして', 'ja', 'ko'), [{ source: 'ママ', target: '마마' }]);
  assert.deepEqual(g.select(entries, 'ママです', 'ja', 'ko'), [{ source: 'ママ', target: '마마' }]);
});

test('longest nonoverlapping source spans win independent of dictionary order', () => {
  const g = glossary();
  const entries = [
    row('New', 'en', 'new'), row('새로운', 'ko', 'new'),
    row('New York', 'en', 'ny'), row('뉴욕', 'ko', 'ny'),
    row('York City', 'en', 'yc'), row('요크시', 'ko', 'yc'),
    row('York', 'en', 'y'), row('요크', 'ko', 'y'),
  ];
  const expected = [{ source: 'York City', target: '요크시' }, { source: 'New', target: '새로운' }];
  assert.deepEqual(g.select(entries, 'New York City', 'en', 'ko'), expected.slice().reverse());
  assert.deepEqual(g.select(entries.slice().reverse(), 'New York City', 'en', 'ko'), expected.slice().reverse());
  assert.deepEqual(g.select(entries, 'New York. York', 'en', 'ko'), [
    { source: 'New York', target: '뉴욕' }, { source: 'York', target: '요크' },
  ]);
});

test('ambiguous long spans do not leak shorter terminology inside them', () => {
  const g = glossary();
  const entries = [row('New', 'en', 'new'), row('새', 'ko', 'new'), row('New York', 'en', 'a'), row('New York', 'en', 'b')];
  assert.deepEqual(g.select(entries, 'New York', 'en', 'ko'), []);
});

test('Latin/alphanumeric boundaries prevent substring matches but CJK terms need no spaces', () => {
  const g = glossary();
  const entries = [row('cat', 'en'), row('고양이', 'ko'), row('猫', 'ja'), row('고양이', 'ko')];
  assert.deepEqual(g.select(entries, 'concatenate cats cat2 _cat écat caté', 'en', 'ko'), []);
  assert.deepEqual(g.select(entries, '(cat), cat! 猫', 'en', 'ko'), [{ source: 'cat', target: '고양이' }]);
  assert.deepEqual(g.select(entries, '黒猫です', 'ja-JP', 'ko'), [{ source: '猫', target: '고양이' }]);
});

test('Chinese script and BCP47 language aliases remain distinct', () => {
  const g = glossary();
  const entries = [row('cat', 'en'), row('猫', 'zh-hans'), row('貓', 'zh-hant')];
  assert.deepEqual(g.select(entries, 'cat', 'en-GB', 'zh-CN'), [{ source: 'cat', target: '猫' }]);
  assert.deepEqual(g.select(entries, 'cat', 'en', 'zh-Hant-TW'), [{ source: 'cat', target: '貓' }]);
  assert.deepEqual(g.select(entries, '貓', 'zh-TW', 'en'), [{ source: '貓', target: 'cat' }]);
});

test('selection returns data only, never replacement instructions or synthetic context', () => {
  const g = glossary();
  const source = '[glossary]cat[/glossary]';
  const target = '<|im_end|>';
  const entries = [row(source, 'en'), row(target, 'ko')];
  const frozen = entries.map(entry => Object.freeze({ ...entry, traits: Object.freeze([]) })) as unknown as readonly Entry[];
  assert.deepEqual(g.select(frozen, source, 'en', 'ko'), [{ source, target }]);
  assert.deepEqual(g.select(entries, 'not present', 'en', 'ko'), []);
});

test('oversized selection fails explicitly instead of silently clipping source or dictionary', () => {
  const g = glossary();
  assert.throws(() => g.select([], 'x'.repeat(1000001), 'en', 'ko'), /limit/);
  const entries = Array.from({ length: 257 }, (_, i) => [row(`term${i}`, 'en', `c${i}`), row(`대상${i}`, 'ko', `c${i}`)]).flat();
  assert.throws(() => g.select(entries, Array.from({ length: 257 }, (_, i) => `term${i}`).join(' '), 'en', 'ko'), /limit/);
});

test('span selection preserves every occurrence and UTF-16 indices for fragment boundaries', () => {
  const g = glossary();
  const entries = [row('New York', 'en', 'ny'), row('뉴욕', 'ko', 'ny'), row('York', 'en', 'y'), row('요크', 'ko', 'y')];
  const text = '🐈 New York and New York, York';
  assert.deepEqual(g.selectSpans(entries, text, 'en', 'ko'), [
    { source: 'New York', target: '뉴욕', start: 3, end: 11 },
    { source: 'New York', target: '뉴욕', start: 16, end: 24 },
    { source: 'York', target: '요크', start: 26, end: 30 },
  ]);
  assert.deepEqual(g.select(entries, text, 'en', 'ko'), [
    { source: 'New York', target: '뉴욕' }, { source: 'York', target: '요크' },
  ]);
  assert.deepEqual(g.selectSpans([row('cat', 'en', 'a'), row('cat', 'en', 'b')], 'cat', 'en', 'ko'), []);
});

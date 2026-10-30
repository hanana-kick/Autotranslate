import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, resetGlobals, type ATNamespace } from './helpers.ts';

// The offline stand-in provider from demo/glossary.ts. It is a dictionary, not
// an engine: a piece it does not know is handed back untouched and remembered
// in a module-level set that unknownCount() exposes.

/** Run markers as AT.dom.wrapRuns emits them; they are not part of AT.C. */
const OPEN = '\uE000';
const CLOSE = '\uE001';
const run = (index: number): string => `${OPEN}${String(index)}${CLOSE}`;

type TranslateOptions = { lossy?: boolean; latencyMs?: number };

type Demo = {
  translate(texts: readonly string[], options?: TranslateOptions): Promise<string[]>;
  unknownCount(): number;
  reset(): void;
};

/** build/ts/demo is outside BUILD_TS, so load this one by hand. */
function glossary(): Demo {
  resetGlobals();
  (0, eval)(readFileSync(join(ROOT, 'build', 'ts', 'demo', 'glossary.js'), 'utf8'));
  const host = globalThis as ATNamespace;
  const demo = (host.AT as ATNamespace | undefined)?.demo as Demo | undefined;
  assert.ok(demo, 'glossary.js must define AT.demo');
  return demo;
}

/**
 * The provider resolves its result from inside its own setTimeout; passing
 * latencyMs: 0 keeps that timer immediate and the awaited promise stays the
 * only thing the test waits on.
 */
function translate(demo: Demo, texts: readonly string[], options: TranslateOptions = {}): Promise<string[]> {
  return demo.translate(texts, { ...options, latencyMs: 0 });
}

test('known phrases come back translated and unknown text is handed back', async () => {
  const demo = glossary();
  const out = await translate(demo, ['free shipping', 'qwertyuiop zxcvbnm']);
  assert.deepEqual(out, ['무료 배송', 'qwertyuiop zxcvbnm']);
  assert.equal(demo.unknownCount(), 1, 'only the unmapped piece is remembered');
});

test('unknownCount accumulates across calls and reset() zeroes it', async () => {
  const demo = glossary();
  assert.equal(demo.unknownCount(), 0, 'a fresh module starts clean');

  await translate(demo, ['alpha beta']);
  assert.equal(demo.unknownCount(), 1);

  await translate(demo, ['gamma delta']);
  assert.equal(demo.unknownCount(), 2, 'a second call adds its own unknown piece');

  await translate(demo, ['alpha beta']);
  assert.equal(demo.unknownCount(), 2, 'the same unknown piece is counted once');

  demo.reset();
  assert.equal(demo.unknownCount(), 0);

  await translate(demo, ['epsilon']);
  assert.equal(demo.unknownCount(), 1, 'counting restarts after reset');
});

test('a known piece matches regardless of case, padding and inner spacing', async () => {
  const demo = glossary();
  const out = await translate(demo, ['FREE SHIPPING', '  free shipping  ', 'free   shipping']);
  assert.deepEqual(
    out,
    ['무료 배송', '무료 배송', '무료 배송'],
    'the dictionary value replaces the whole piece, so padding is dropped'
  );
  assert.equal(demo.unknownCount(), 0, 'case/whitespace variants are not unknown');
});

test('empty and whitespace-only pieces are returned verbatim and never counted', async () => {
  const demo = glossary();
  const out = await translate(demo, ['', '   ', '\t\n ']);
  assert.deepEqual(out, ['', '   ', '\t\n '], 'the piece comes back exactly as sent');
  assert.equal(demo.unknownCount(), 0, 'nothing to look up is not an unknown');
});

test('word fallback translates the known words and keeps the rest in place', async () => {
  const demo = glossary();
  const out = await translate(demo, ['Engine sample', 'Press the key.']);
  assert.equal(out[0], '엔진 샘플', 'both words map, spacing is preserved');
  assert.equal(out[1], '키 the key.', 'only the mapped word is swapped; punctuation stays');
  assert.equal(demo.unknownCount(), 1, 'the piece is remembered once, not once per token');
});

test('an empty dictionary entry behaves as a miss', async () => {
  const demo = glossary();
  const out = await translate(demo, ['the']);
  assert.equal(out[0], 'the', 'WORDS maps "the" to "" and the empty value is not usable');
  assert.equal(demo.unknownCount(), 1, 'so the word is counted as unknown');
});

test('a phrase matches only when the whole normalised piece is the key', async () => {
  const demo = glossary();
  // PHRASES holds 'ask the', 'team' and 'for details.' individually, yet a
  // sentence containing them is matched as one key and mostly survives.
  const out = await translate(demo, ['Ask the team for details.', 'Free shipping And two-year warranty']);
  assert.equal(out[0], 'Ask the team 위한 details.', 'only the standalone word "for" maps');
  assert.equal(out[1], 'Free shipping 그리고 two-year warranty', 'only "and" maps; the phrases do not');
  assert.equal(demo.unknownCount(), 2, 'both pieces are unknown as a whole');
});

test('phrase keys carry their punctuation', async () => {
  const withColon = glossary();
  assert.deepEqual(await translate(withColon, ['Today Only:', 'today only:']), ['오늘 하루 한정:', '오늘 하루 한정:']);
  assert.equal(withColon.unknownCount(), 0, 'the stored key itself ends in a colon');

  const withBang = glossary();
  assert.deepEqual(await translate(withBang, ['free shipping!']), ['free shipping!']);
  assert.equal(withBang.unknownCount(), 1, '"!" is not part of the phrase key, so the phrase lookup misses');
});

test('marked runs are translated piece by piece and keep their markers', async () => {
  const demo = glossary();
  const marked = `free shipping${run(1)}and${run(2)}plan`;
  const out = await translate(demo, [marked]);
  assert.equal(out[0], `무료 배송${run(1)}그리고${run(2)}요금제`);
  assert.equal(demo.unknownCount(), 0, 'each piece between markers is a dictionary entry');
});

test('lossy drops the markers and joins the pieces with nothing between them', async () => {
  const demo = glossary();
  const marked = `free shipping${run(1)}and${run(2)}plan`;
  const kept = await translate(demo, [marked]);
  const lossy = await translate(demo, [marked], { lossy: true });
  assert.ok(kept[0]!.includes(run(1)) && kept[0]!.includes(run(2)), 'the default path keeps both run boundaries');
  assert.ok(!lossy[0]!.includes(OPEN) && !lossy[0]!.includes(CLOSE), 'lossy leaves no marker characters behind');
  assert.equal(lossy[0], '무료 배송그리고요금제', 'no separator is inserted where a marker was');
});

test('a marker splitting a word defeats both dictionary tables', async () => {
  const demo = glossary();
  // 'style-safe' is a WORDS key; the markers break the token so neither half maps.
  const out = await translate(demo, [`style${run(1)}safe`]);
  assert.equal(out[0], `style${run(1)}safe`, 'both halves and the marker survive');
  assert.equal(demo.unknownCount(), 2, 'each half is recorded as its own unknown piece');
});

test('a marker that is not a run marker stays put and counts as unknown', async () => {
  const demo = glossary();
  const out = await translate(demo, [`a${OPEN}b${CLOSE}`]);
  assert.equal(out[0], `a${OPEN}b${CLOSE}`, 'the scanner needs digits between the markers');
  assert.equal(demo.unknownCount(), 1, 'the private-use characters make the piece unmappable');
});

test('every text in a batch is scanned for markers from the start', async () => {
  const demo = glossary();
  // The marker regex is module-level and global; a leaked lastIndex would make
  // the second text miss its leading marker.
  const out = await translate(demo, [`${run(1)}plan`, `${run(2)}free`, `${run(3)}plan`]);
  assert.deepEqual(out, [`${run(1)}요금제`, `${run(2)}무료`, `${run(3)}요금제`]);
  assert.equal(demo.unknownCount(), 0);
});

test('an empty batch resolves to an empty array', async () => {
  const demo = glossary();
  assert.deepEqual(await translate(demo, []), []);
  assert.equal(demo.unknownCount(), 0);
});

test('a mixed batch keeps length and order', async () => {
  const demo = glossary();
  const texts = ['free shipping', 'zzz unknown', 'plan', 'free shipping', 'nothing here at all'];
  const out = await translate(demo, texts);
  assert.equal(out.length, texts.length, 'one result per request');
  assert.deepEqual(out, ['무료 배송', 'zzz unknown', '요금제', '무료 배송', 'nothing here at all']);
  assert.equal(demo.unknownCount(), 2, 'the repeated unknown piece is counted once');
});

test('translate works without an options argument', async () => {
  const demo = glossary();
  // Default latencyMs is 120; the awaited promise is the only thing waited on.
  assert.deepEqual(await demo.translate(['plan']), ['요금제']);
});

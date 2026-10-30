import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.ts';

const AT = load('lib/constants.js', 'lib/gemma.js', 'lib/local.js');
const { local } = AT;

const OPEN = '<start_of_turn>user\n';
const CLOSE = '\n<end_of_turn>\n<start_of_turn>model\n';

/** The cheapest object that survives normalizeModel. */
const record = (over: Record<string, unknown> = {}) => ({
  id: 'model-1',
  name: 'model.task',
  size: 5_000_000,
  sourceUrl: 'https://example.test/model.task',
  createdAt: 1000,
  ...over
});

test('the translate prompt is the shape the model was tuned on', () => {
  const prompt = local.buildTranslatePrompt('en', 'ko', 'Hello world');
  assert.equal(
    prompt,
    OPEN +
      'You are a professional English (en) to Korean (ko) translator. ' +
      'Your goal is to accurately convey the meaning and nuances of the original English text ' +
      'while adhering to Korean grammar, vocabulary, and cultural sensitivities.\n' +
      'Produce only the Korean translation, without any additional explanations or commentary. ' +
      'Please translate the following English text into Korean:\n' +
      '\n\n' +
      'Hello world' +
      CLOSE,
    'the preamble, the instruction, two blank lines and the text, between the turn markers'
  );
});

test('page context travels only in the numbered batch prompt', () => {
  // Measured in the real extension: with a context line the single-text shape
  // returned the context translated instead of the text, and the auto shape
  // answered with commentary. The numbered shape keeps the line outside the
  // answer, so that is the only place it is allowed.
  const hint = 'This is a product page from Example Shop.';
  const single = local.buildTranslatePrompt('en', 'ko', 'Hello world');
  assert.ok(!single.includes('Background'), 'the single-text shape carries no context');
  assert.equal(single, local.buildTranslatePrompt('en', 'ko', 'Hello world'), 'and is stable');

  const batch = local.buildBatchPrompt('en', 'ko', ['a', 'b'], hint);
  assert.ok(
    batch.includes(`\nBackground, do not translate: ${hint}\n\nSegments:`),
    'the batch prompt holds the marked line, before the segments'
  );
  assert.equal(
    batch.split('Background, do not translate:').length - 1,
    1,
    'the marker is never doubled'
  );
  // A single *sentence* with its paragraph still needs the numbered shape: the
  // plain shape drops the context, and the plain shape with a context line is
  // what returned the context translated. Measured: the numbered answer is the
  // sentence alone.
  const one = local.buildBatchPrompt('en', 'ko', ['only'], hint);
  assert.match(one, /Background, do not translate: This is a product page/, 'the sentence keeps its paragraph');
  assert.match(one, /Segments:\n1\. only/, 'and travels as one numbered segment');
  assert.equal(one.split('Background, do not translate:').length - 1, 1, 'the marker is never doubled');
});

test('a regional code is passed through as the model spells it', () => {
  // `zh-Hans` is a table entry and `zh-CN` is not: the alias lives in AT.gemma,
  // so the prompt never carries a code the model has to guess about.
  assert.ok(local.buildTranslatePrompt('zh-Hans', 'zh-TW', '你好').includes('Chinese (zh-Hans)'));
  assert.ok(local.buildTranslatePrompt('zh-Hans', 'zh-TW', '你好').includes('Chinese (zh-TW)'));
});

test('an unknown source gets one plain instruction, not a request to infer', () => {
  const prompt = local.buildAutoPrompt('ko', 'Hi');
  assert.ok(prompt.startsWith(OPEN) && prompt.endsWith(CLOSE));
  assert.ok(prompt.includes('Korean (ko)'), 'the target is still named');
  assert.ok(prompt.includes('Produce only the Korean translation'), 'the output shape is still asked for');
  assert.ok(!/infer/i.test(prompt), 'inviting the model to infer made it narrate instead of translate');
  assert.ok(!prompt.includes('(undefined)') && !prompt.includes('()'), 'no empty code is ever shown');
});

test('a one-text batch is the plain prompt, so short pages keep the checked shape', () => {
  assert.equal(local.buildBatchPrompt('en', 'ko', ['Only one']), local.buildTranslatePrompt('en', 'ko', 'Only one'));
  assert.ok(!local.buildBatchPrompt('en', 'ko', ['Only one']).includes('Segments:'));
});

test('a multi-text batch numbers every segment', () => {
  const prompt = local.buildBatchPrompt('en', 'ko', ['alpha', 'beta gamma']);
  assert.ok(prompt.startsWith(OPEN) && prompt.endsWith(CLOSE));
  assert.ok(prompt.includes('1. alpha'));
  assert.ok(prompt.includes('2. beta gamma'));
  assert.ok(prompt.includes('Segments:'));
});

test('a batch prompt collapses the newlines it would have to re-parse', () => {
  const prompt = local.buildBatchPrompt('en', 'ko', ['line one\nline two', 'second']);
  assert.ok(prompt.includes('1. line one line two'));
  assert.ok(prompt.includes('2. second'));
});

test('numbered replies are read back in order', () => {
  assert.deepEqual(local.parseNumbered('1: hello\n2: world', 2), ['hello', 'world']);
  assert.deepEqual(local.parseNumbered('1) hello\n2) world', 2), ['hello', 'world']);
  assert.deepEqual(local.parseNumbered('1. hello\n2. world', 2), ['hello', 'world']);
});
test('a translation may contain its own newlines', () => {
  assert.deepEqual(local.parseNumbered('1: first\nstill first\n2: second', 2), ['first\nstill first', 'second']);
});

test('prose before the first marker is ignored', () => {
  assert.deepEqual(local.parseNumbered('Here you go:\n1: hello', 1), ['hello']);
});

test('an unusable numbered reply is refused rather than guessed', () => {
  assert.equal(local.parseNumbered('1: hello', 2), null, 'a missing segment must not pass');
  assert.equal(local.parseNumbered('1: hello\n1: again', 2), null, 'a duplicated index must not pass');
  assert.equal(local.parseNumbered('1: hello\n2:   ', 2), null, 'an empty translation must not pass');
  assert.equal(local.parseNumbered('hello world', 1), null, 'an unnumbered reply must not pass');
  assert.equal(local.parseNumbered('', 1), null);
  assert.equal(local.parseNumbered(undefined as unknown as string, 1), null);
});

test('token estimates follow the model tokenizer, per script', () => {
  // Measured with the vendored model's own sizeInTokens() over 600-character
  // samples: Latin 6.12 characters per token, Cyrillic 4.65, Arabic 2.75,
  // Japanese 1.76, Korean 1.82.
  assert.equal(local.estimateTokens(''), 0);
  assert.equal(local.estimateTokens('abcdef'), 1, 'six Latin characters are one token');
  assert.equal(local.estimateTokens('x'.repeat(600)), 100, 'Latin: 6.12 measured, 6 used');
  assert.equal(local.estimateTokens('인공지능'), 3, 'Hangul: four syllables cost more than two tokens');
  assert.equal(local.estimateTokens('인'.repeat(204)), 120, 'Korean: 1.7 characters per token');
  assert.equal(local.estimateTokens('あ'.repeat(204)), 120, 'Kana: measured 1.12, estimated at 1.7');
  assert.equal(local.estimateTokens('م'.repeat(100)), 40, 'Arabic: measured 2.75, estimated at 2.5');
  assert.equal(local.estimateTokens('ж'.repeat(90)), 20, 'Cyrillic: measured 4.65, estimated at 4.5');
});

test('chunking keeps one generation inside the budget', () => {
  const texts = Array.from({ length: 6 }, (_unused, index) => `text ${index} ${'x'.repeat(160)}`);
  const limit = 400;
  const cost = (list: string[]) =>
    local.PROMPT_OVERHEAD_TOKENS + list.reduce((sum, text) => sum + local.estimateTokens(text) * 2, 0);
  const chunks = local.chunkByTokens(texts, limit);
  // 170 characters are 29 tokens; a chunk pays twice that plus the 128-token
  // instruction, so four texts (128 + 232 = 360) fit in 400 and five do not.
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks.flat(), texts, 'order and content must survive');
  chunks.forEach((chunk: string[], index: number) => {
    assert.ok(cost(chunk) <= limit, `a chunk of ${chunk.length} needs ${cost(chunk)} tokens`);
    const next = chunks[index + 1]?.[0];
    if (next) assert.ok(cost([...chunk, next]) > limit, 'a chunk must be as full as the budget allows');
  });
});

test('everything fits in one chunk when the budget is generous', () => {
  const chunks = local.chunkByTokens(['a', 'b', 'c'], 4096);
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0], ['a', 'b', 'c']);
});

test('an oversized text is sent alone instead of dropped', () => {
  const huge = 'x'.repeat(20000);
  const chunks = local.chunkByTokens(['small', huge, 'small again'], 512);
  assert.deepEqual(chunks, [['small'], [huge], ['small again']]);
});

test('the chunker bounds the budget it was handed', () => {
  const texts = ['a'.repeat(600), 'b'.repeat(600)];
  assert.equal(local.chunkByTokens(texts, 1).length, 2, 'the floor still applies');
  assert.equal(local.chunkByTokens(texts, 1_000_000).length, 1, 'the ceiling still holds small text together');
});

test('no texts means no chunks', () => {
  assert.deepEqual(local.chunkByTokens([], 1024), []);
});

test('a stored record survives normalisation', () => {
  const clean = local.normalizeModel(record());
  assert.deepEqual(clean, record());
});

test('junk records are refused', () => {
  assert.equal(local.normalizeModel(null), null);
  assert.equal(local.normalizeModel('model'), null);
  assert.equal(local.normalizeModel(record({ id: '' })), null);
  assert.equal(local.normalizeModel(record({ id: '../escape' })), null);
  assert.equal(local.normalizeModel(record({ id: 'UPPER' })), null);
  assert.equal(local.normalizeModel(record({ size: 0 })), null);
  assert.equal(local.normalizeModel(record({ size: local.MIN_MODEL_BYTES - 1 })), null);
  assert.equal(local.normalizeModel(record({ size: Number.NaN })), null);
  assert.equal(local.normalizeModel(record({ size: 'not a number' })), null);
});

test('a record keeps only fields it can trust', () => {
  const clean = local.normalizeModel(
    record({ name: '   ', sourceUrl: 'javascript:alert(1)', createdAt: -5, extra: 'ignored' })
  );
  assert.equal(clean.name, clean.id, 'a blank name falls back to the id');
  assert.equal(clean.sourceUrl, '', 'a non-http source is dropped');
  assert.equal(clean.createdAt, 0);
  assert.equal('extra' in clean, false);
});

test('a list is cleaned, deduplicated and newest first', () => {
  const list = local.normalizeModels([
    record({ id: 'old', createdAt: 1, size: 2_000_000 }),
    record({ id: 'new', createdAt: 9, size: 2_000_000 }),
    record({ id: 'old', createdAt: 1, size: 2_000_000 }),
    record({ id: 'broken', size: 10 }),
    'junk'
  ]);
  assert.deepEqual(list.map((model: { id: string }) => model.id), ['new', 'old']);
  assert.equal(local.normalizeModels(undefined).length, 0);
  assert.equal(local.normalizeModels([]).length, 0);
});

test('the list is capped so one bad store cannot hang the UI', () => {
  const many = Array.from({ length: 100 }, (_unused, index) =>
    record({ id: `model-${index}`, createdAt: index, size: 2_000_000 })
  );
  assert.equal(local.normalizeModels(many).length, 32);
});

test('model ids are stable, unique and safe as file names', () => {
  const first = local.makeModelId('TranslateGemma-4B-IT.task', 'https://a.test/x', 1);
  assert.equal(first, local.makeModelId('TranslateGemma-4B-IT.task', 'https://a.test/x', 1));
  assert.notEqual(first, local.makeModelId('TranslateGemma-4B-IT.task', 'https://b.test/x', 1));
  assert.notEqual(first, local.makeModelId('TranslateGemma-4B-IT.task', 'https://a.test/x', 2));
  for (const id of [first, local.makeModelId('../../evil/../name', 'https://a.test/x', 1), local.makeModelId('', '', 1)]) {
    assert.match(id, /^[a-z0-9][a-z0-9._-]+$/, id);
    assert.ok(!id.includes('..') && !id.includes('/'));
  }
  assert.ok(first.startsWith('translategemma-4b-it-'), first);
});

test('bytes are rendered the way the storage card shows them', () => {
  assert.equal(local.formatBytes(0), '0 B');
  assert.equal(local.formatBytes(1023), '1023 B');
  assert.equal(local.formatBytes(1024), '1.0 KiB');
  assert.equal(local.formatBytes(1024 * 1024), '1.0 MiB');
  assert.equal(local.formatBytes(3_896_377_344), '3.6 GiB');
  assert.equal(local.formatBytes(-1), '0 B');
  assert.equal(local.formatBytes(Number.NaN), '0 B');
});

test('an absent model card still yields a usable status', () => {
  const status = local.normalizeStatus(undefined);
  assert.equal(status.state, 'unloaded');
  assert.equal(status.supported, false);
  assert.equal(status.modelId, null);
  assert.equal(status.loadedBytes, 0);
  assert.equal(status.loadMs, null);
  assert.equal(status.generations, 0);
  assert.equal(status.target, local.TARGET_OFFSCREEN);
});

test('a hostile status cannot smuggle an id or an unbounded string', () => {
  const status = local.normalizeStatus({
    state: 'pwned',
    modelId: '../../etc/passwd',
    modelName: 'x'.repeat(5000),
    lastError: 'y'.repeat(5000),
    loadedBytes: -3,
    loadMs: 'soon',
    generations: -1,
    reason: 'made-up'
  });
  assert.equal(status.state, 'unloaded');
  assert.equal(status.modelId, null);
  assert.ok(status.modelName === null || status.modelName.length <= 120);
  assert.ok(status.lastError === null || status.lastError.length <= 300);
  assert.equal(status.loadedBytes, 0);
  assert.equal(status.loadMs, null);
  assert.equal(status.generations, 0);
  assert.equal(status.reason, null);
});

test('a real status is read back whole', () => {
  const status = local.normalizeStatus({
    target: 'offscreen',
    supported: true,
    reason: 'no-webgpu',
    state: 'ready',
    modelId: 'translategemma-4b-1',
    modelName: 'translategemma-4b-it-int8-web.task',
    loadedBytes: 3_896_377_344,
    loadMs: 11234,
    generations: 7
  });
  assert.equal(status.state, 'ready');
  assert.equal(status.supported, true);
  assert.equal(status.reason, 'no-webgpu');
  assert.equal(status.modelId, 'translategemma-4b-1');
  assert.equal(status.loadedBytes, 3_896_377_344);
  assert.equal(status.loadMs, 11234);
  assert.equal(status.generations, 7);
});

test('a reason decides whether the user or the provider is at fault', () => {
  assert.equal(local.codeForReason('no-webgpu'), 'config');
  assert.equal(local.codeForReason('no-model'), 'config');
  assert.equal(local.codeForReason('model-missing'), 'config');
  assert.equal(local.codeForReason('runtime-load-failed'), 'config', 'a broken runtime is not retryable');
  assert.equal(local.codeForReason('generation-failed'), 'provider');
  assert.equal(local.codeForReason(null), 'provider');
});

test('only checked language pairs are advertised as verified', () => {
  assert.equal(local.isVerifiedPair('en', 'ko'), true);
  assert.equal(local.isVerifiedPair('auto', 'ko'), true);
  assert.equal(local.isVerifiedPair('ja', 'ko'), true);
  assert.equal(local.isVerifiedPair('en', 'de'), false);
  assert.equal(local.isVerifiedPair('de', 'ko'), false);
});

test('the status sentence names the model and the failure', () => {
  const say = (key: string, subs?: string | string[]) => `[${key}${subs ? `:${subs}` : ''}]`;
  assert.equal(local.describeStatus(null, false, say), '[options_localUnsupported]');
  assert.equal(local.describeStatus(null, true, say), '[options_stateUnloaded]');
  assert.equal(
    local.describeStatus(local.normalizeStatus({ state: 'error', lastError: 'boom' }), true, say),
    '[options_stateError]: boom'
  );
  const ready = local.describeStatus(
    local.normalizeStatus({ state: 'ready', modelName: 'gemma', loadMs: 250 }),
    true,
    say
  );
  assert.ok(ready.includes('gemma') && ready.includes('250 ms'), ready);
});

test('the offered model card points at a real https artefact', () => {
  assert.ok(local.MODEL_SOURCES.length > 0);
  for (const source of local.MODEL_SOURCES) {
    assert.ok(source.url.startsWith('https://'), source.url);
    assert.ok(source.size >= local.MIN_MODEL_BYTES, 'a size is needed for the capacity check');
    assert.ok(source.size <= local.MAX_MODEL_BYTES);
    assert.ok(source.label.length > 0 && source.license.length > 0);
    assert.equal(local.normalizeDownloadUrl(source.url), source.url);
  }
});

test('only https downloads are offered', () => {
  assert.equal(local.normalizeDownloadUrl('http://example.test/model.task'), null);
  assert.equal(local.normalizeDownloadUrl('javascript:alert(1)'), null);
  assert.equal(local.normalizeDownloadUrl(''), null);
  assert.equal(local.normalizeDownloadUrl(undefined), null);
});

test('no two message types collide', () => {
  const values = Object.values(AT.C.MSG);
  assert.equal(new Set(values).size, values.length, 'a duplicate type would let the wrong context answer');
});

test('callHost reaches the host in either placement with the same answer shape', async () => {
  const sent: Record<string, unknown>[] = [];
  AT.sendMessage = async (message: Record<string, unknown>) => {
    sent.push(message);
    return { ok: false, error: 'no host', code: 'config' };
  };

  local.setHostPlacement('offscreen');
  const messaged = await local.callHost({ type: 'at/local-status' });
  assert.deepEqual(
    sent,
    [{ type: 'at/local-status', to: 'offscreen' }],
    'the document is addressed exactly as the protocol expects'
  );
  assert.equal(messaged.ok, false, 'a failure crosses the realm boundary as data');
  assert.equal(messaged.code, 'config');

  const handled: string[] = [];
  AT.localhost = {
    async handle(message: { type: string }) {
      handled.push(message.type);
      if (message.type === 'at/local-load') {
        throw Object.assign(new Error('no model is selected'), { code: 'config' });
      }
      return { status: { state: 'unloaded' } };
    }
  };
  local.setHostPlacement('background');

  const inline = await local.callHost({ type: 'at/local-status' });
  assert.deepEqual(handled, ['at/local-status']);
  assert.deepEqual(inline, { ok: true, status: { state: 'unloaded' } }, 'a direct call answers like a message');
  assert.equal(sent.length, 1, 'nothing is messaged when this context is the host');

  const failed = await local.callHost({ type: 'at/local-load' });
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'no model is selected');
  assert.equal(failed.code, 'config', 'a thrown host error keeps its code');

  local.setHostPlacement('offscreen');
  delete AT.localhost;
  delete AT.sendMessage;
});

test('packing by real counts never exceeds the budget it was given', () => {
  const texts = ['one', 'two', 'three', 'four'];
  const counts = [400, 200, 90, 10];
  // overhead 90: 90 + 2x400 = 890 fits, adding 200 would be 1290.
  const chunks = local.chunkByCounts(texts, counts, 1024, 90);
  assert.deepEqual(chunks, [['one'], ['two', 'three', 'four']], 'greedy, in order, never over');

  // A count that is missing or not a number falls back to the estimate for that
  // text alone, so one bad entry cannot make the batch look oversized.
  const partial = local.chunkByCounts(['alpha', 'beta'], [400, Number.NaN], 1024, 90);
  assert.deepEqual(partial, [['alpha', 'beta']], 'beta is estimated at one token, not at 400');
  assert.equal(local.chunkByCounts([], [], 1024, 90).length, 0);
  assert.equal(local.chunkByCounts(['one'], [10], 4096, 90).length, 1, 'the budget is clamped, not trusted');
});

test('a reply without numbers is accepted when its shape is unambiguous', () => {
  // Measured: a 4B model often drops the "N:" prefix, and the old parser then
  // re-ran every segment on its own — three texts cost four generations.
  assert.deepEqual(local.parseNumbered('하나\n둘\n셋', 3), ['하나', '둘', '셋'], 'one per line');
  assert.deepEqual(local.parseNumbered('하나\n\n둘\n\n셋', 3), ['하나', '둘', '셋'], 'blank-line blocks');
  assert.equal(local.parseNumbered('하나\n둘', 3), null, 'too few lines is still a failure');
  assert.equal(local.parseNumbered('하나\n둘\n셋\n넷', 3), null, 'too many lines is still a failure');
  assert.equal(local.parseNumbered('1: 하나\n2: 둘\n2: 셋', 3), null, 'wrong numbering never falls back to lines');
});

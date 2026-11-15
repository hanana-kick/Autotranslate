import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { load, type ATNamespace } from './helpers.ts';

// lib/browser.js resolves the host API once, so the stub exists before it loads.
const detector: { answer: unknown; calls: string[] } = { answer: null, calls: [] };
const host = globalThis as Record<string, unknown>;
host.chrome = {
  runtime: { sendMessage: async () => undefined, onMessage: { addListener: () => {} }, getURL: (path: string) => path },
  i18n: {
    detectLanguage: async (text: string) => {
      detector.calls.push(text);
      return detector.answer;
    }
  }
};
// Every test starts with a clean detection log: the engine asks the detector
// for any chunk whose source is `auto`.
test.beforeEach(() => {
  detector.calls.length = 0;
  detector.answer = null;
});
const AT = load(
  'lib/constants.js',
  'lib/browser.js',
  'lib/plamo3.js',
  'lib/pagecontext.js',
  'lib/targets.js',
  'lib/rules.js',
  'lib/local.js',
  'lib/settings.js',
  'lib/engines.js'
);
const { engines } = AT;

/**
 * Rejections from engines.js arrive untyped across the eval boundary; these are
 * the members the tests below assert on (each code carries its own subset).
 */
type EngineError = Error & { code: string; detail: string; reason: string; expected: number; got: number };

const engineError = (thrown: unknown): EngineError => thrown as EngineError;

// The host is the offscreen document; the tests stand in for it so the
// contract (one message per chunk, answers mapped back to the inputs) is fixed
// without loading a 4B model.

const localModel = (overrides: ATNamespace = {}) =>
  engines.translate({ target: 'ko', texts: ['hello'], localModelId: 'plamo-0.8b', ...overrides });

let sent: ATNamespace[] = [];

function stubSend(reply: (message: ATNamespace) => unknown, counts?: (message: ATNamespace) => unknown) {
  sent = [];
  AT.sendMessage = async (message: ATNamespace) => {
    sent.push(message);
    // The host plans complete source coverage using its resident tokenizer.
    if (message.type === AT.C.MSG.LOCAL_COUNT) {
      return counts ? counts(message) : { ok: true, sourceChunks: message.texts.map((text: string) => [text]) };
    }
    return reply(message);
  };
}

/** Only the messages that ask for a translation; counting is a separate hop. */
const translates = () => sent.filter((message) => message.type === AT.C.MSG.LOCAL_TRANSLATE);

after(() => {
  delete AT.sendMessage;
});

test('local: the model is asked through the offscreen host, never fetched', async () => {
  stubSend(() => ({ ok: true, translations: ['안녕'] }));
  const result = await localModel();
  assert.deepEqual(result.translations, ['안녕']);
  assert.equal(result.requested, 1);
  assert.equal(translates().length, 1);
  const first = translates()[0] as ATNamespace;
  assert.equal(first.type, AT.C.MSG.LOCAL_TRANSLATE);
  assert.equal(first.to, AT.local.TARGET_OFFSCREEN);
  assert.equal(first.modelId, 'plamo-0.8b');
  assert.deepEqual(first.texts, ['hello']);
  assert.equal(first.source, '', 'no detector answer: the host is not told a source');
  assert.equal(first.target, 'ko');
  assert.equal(first.maxTokens, AT.local.DEFAULT_MAX_TOKENS);
  assert.equal(first.url, undefined, 'there is no endpoint to call');
});

test('local: the source comes from the browser detector when the setting says auto', async () => {
  detector.answer = { isReliable: false, languages: [{ language: 'ja', percentage: 100 }] };
  stubSend(() => ({ ok: true, translations: ['안녕'] }));
  try {
    const result = await localModel({ source: 'auto', texts: ['Guten Morgen'] });
    assert.deepEqual(detector.calls, ['Guten Morgen'], 'the detector sees the text, not the settings');
    assert.equal((translates()[0] as ATNamespace).source, 'ja', 'a code the model names goes through unchanged');
    assert.equal(result.detected, 'ja', 'and the picker is told what the page was in');
  } finally {
    detector.answer = null;
  }
});

test('local: a detected language the model cannot name leaves the source unstated', async () => {
  // The prompt only carries the five languages PLaMo was released with, so a
  // German page is translated with the target named and no source claim.
  detector.answer = { isReliable: false, languages: [{ language: 'de-AT', percentage: 100 }] };
  stubSend(() => ({ ok: true, translations: ['안녕'] }));
  try {
    const result = await localModel({ source: 'auto', texts: ['Guten Morgen'] });
    assert.equal((translates()[0] as ATNamespace).source, '', 'the model has no German to name');
    assert.equal(result.detected, null, 'a code the target picker does not offer is not reported as one');
  } finally {
    detector.answer = null;
  }
});

test('local: an undetectable source leaves the prompt without one instead of guessing', async () => {
  detector.answer = { isReliable: false, languages: [{ language: 'und', percentage: 100 }] };
  stubSend(() => ({ ok: true, translations: ['안녕'] }));
  try {
    await localModel({ source: 'auto' });
    assert.equal((translates()[0] as ATNamespace).source, '', 'the host is told nothing rather than a wrong code');
  } finally {
    detector.answer = null;
  }
});

test('local: an explicit source skips the detector', async () => {
  stubSend(() => ({ ok: true, translations: ['안녕'] }));
  await localModel({ source: 'ja' });
  assert.deepEqual(detector.calls, [], 'a chosen language is not second-guessed');
  assert.equal((translates()[0] as ATNamespace).source, 'ja');
});


test('local: the target is the model code, not the picker code', async () => {
  stubSend(() => ({ ok: true, translations: ['你好'] }));
  await localModel({ target: 'zh-CN', texts: ['hello'] });
  assert.equal((translates()[0] as ATNamespace).target, 'zh-hans', 'Simplified Chinese is zh-hans to the PLaMo model');
});

test('local: a target outside the picker is refused before the host is woken', async () => {
  stubSend(() => ({ ok: true, translations: [''] }));
  await assert.rejects(
    () => localModel({ target: 'xx-YY' }),
    (thrown: unknown) => {
      const error = engineError(thrown);
      return error.code === 'config';
    },
    'a target the extension does not offer is refused'
  );
  assert.equal(sent.length, 0, 'not even the token count is sent');
});

test('local: a picker code the model cannot express fails as no-target', async () => {
  // Every code in C.LANGS currently exists in the model table; this guard is
  // for a picker entry the model revision drops, so simulate that gap.
  const plamoKorean = AT.plamo3.LANGS.ko;
  delete AT.plamo3.LANGS.ko;
  stubSend(() => ({ ok: true, translations: [''] }));
  try {
    await assert.rejects(
      () => localModel(),
      (thrown: unknown) => {
        const error = engineError(thrown);
        return error.code === 'config' && error.detail === 'no-target';
      }
    );
  } finally {
    AT.plamo3.LANGS.ko = plamoKorean;
  }
  assert.equal(translates().length, 0, 'no generation is attempted');
});


test('local: independent prompts keep every requested source and answer in order', async () => {
  const texts = Array.from({ length: 5 }, (_unused, index) => `s${index} ${'x'.repeat(897)}`);
  stubSend((message) => ({ ok: true, translations: message.texts.map((text: string) => `[${text.slice(0, 2)}]`) }));
  const result = await localModel({ texts, localMaxTokens: 1024 });
  assert.deepEqual(
    translates().map((call) => call.texts.length),
    [1, 1, 1, 1, 1],
    'each source has an independent prompt'
  );
  assert.deepEqual(result.translations, texts.map((text) => `[${text.slice(0, 2)}]`));
});

test('local: long Korean sources retain coverage through tokenizer plans', async () => {
  const korean = Array.from({ length: 4 }, (_unused, index) => `${index}번째 ` + '인공지능 번역 모델은 문장의 의미와 뉘앙스를 정확하게 전달해야 하며, 원문의 문체와 문화적 맥락을 함께 고려해야 합니다. '.repeat(4));
  stubSend((message) => ({ ok: true, translations: message.texts.map(() => '번역') }));
  await localModel({ texts: korean, localMaxTokens: 1024, source: 'ko', target: 'en' });
  assert.equal(translates().length, korean.length);
  assert.equal(
    translates().reduce((sum, call) => sum + call.texts.length, 0),
    korean.length,
    'no text is dropped'
  );
});

test('local: repeated text is asked once and answered for both', async () => {
  stubSend(() => ({ ok: true, translations: ['안녕'] }));
  const result = await localModel({ texts: ['hello', 'hello', '', '   '] });
  assert.equal(translates().length, 1);
  assert.deepEqual(translates()[0]!.texts, ['hello']);
  assert.deepEqual(result.translations, ['안녕', '안녕', '', '   ']);
  assert.equal(result.requested, 1);
});

test('local: texts with no letters or numbers are not sent', async () => {
  stubSend((message) => ({ ok: true, translations: message.texts.map((text: string) => `[${text}]`) }));
  const texts = ['', '   ', '!!!', '😀', 'a', '42'];
  const result = await localModel({ texts });
  assert.deepEqual(translates()[0]!.texts, ['42'], 'only a text the model can translate is asked about');
  assert.deepEqual(result.translations, ['', '   ', '!!!', '😀', 'a', '[42]']);
  assert.equal(result.requested, 1);
});

test('local: Korean replies pass through without counting, detection or inference', async () => {
  stubSend(() => assert.fail('target-language text must not reach the host'));
  const texts = ['이 노래 정말 좋아요!!', '감사합니다', '네', '   '];
  const result = await localModel({ texts });
  assert.deepEqual(result.translations, texts);
  assert.equal(result.requested, 0);
  assert.deepEqual(sent, []);
  assert.deepEqual(detector.calls, []);
});

test('local: mixed batches skip only proven target fragments and retain every position', async () => {
  const korean = '이 노래 정말 좋아요!!';
  const mixed = '좋아요 Please translate this';
  detector.answer = { isReliable: true, languages: [{ language: 'ko', percentage: 99 }] };
  stubSend(
    message => ({ ok: true, translations: message.texts.map((text: string) => '번역: ' + text) }),
    message => ({ ok: true, sourceChunks: message.texts.map((text: string) => [text]) })
  );
  const texts = [korean, 'Hello', korean, mixed, 'Hello', '감사합니다', '日本語'];
  const result = await localModel({ texts });
  const eligible = ['Hello', mixed, '日本語'];
  assert.deepEqual(sent.find(message => message.type === AT.C.MSG.LOCAL_COUNT)?.texts, eligible);
  assert.deepEqual(translates().flatMap(message => message.texts), eligible);
  assert.deepEqual(result.translations, [korean, '번역: Hello', korean, '번역: ' + mixed, '번역: Hello', '감사합니다', '번역: 日本語']);
  assert.equal(result.requested, 3, 'only unique eligible fragments count, regardless of detector majority');
});

test('local: no model selected fails without waking the host', async () => {
  stubSend(() => ({ ok: true, translations: [''] }));
  await assert.rejects(
    () => localModel({ localModelId: '' }),
    (thrown) => {
      const error = engineError(thrown);
      return error.code === 'config' && error.detail === 'no-model';
    }
  );
  assert.equal(sent.length, 0);
});

test('local: the host failure code decides who is at fault', async () => {
  const cases: [ATNamespace, string][] = [
    [{ ok: false, code: 'config', error: 'this browser has no WebGPU' }, 'config'],
    [{ ok: false, code: 'timeout', error: 'the generation ran too long' }, 'timeout'],
    [{ ok: false, code: 'provider', error: 'the model crashed' }, 'provider'],
    [{ ok: false, code: 'format', error: 'the prompt was malformed' }, 'format'],
    [{ ok: false, code: 'made-up', error: 'the wasm died' }, 'provider'],
    [{}, 'provider']
  ];
  for (const [reply, expected] of cases) {
    stubSend(() => reply);
    await assert.rejects(
      () => localModel(),
      (thrown) => engineError(thrown).code === expected,
      JSON.stringify(reply)
    );
  }
});

test('local: the host explanation reaches the user', async () => {
  stubSend(() => ({ ok: false, code: 'config', error: 'the model file is missing' }));
  await assert.rejects(
    () => localModel(),
    (thrown) => engineError(thrown).detail === 'the model file is missing'
  );
});

test('local: a reply that does not match the request is refused', async () => {
  stubSend(() => ({ ok: true, translations: [] }));
  await assert.rejects(
    () => localModel({ texts: ['hello there', 'goodbye now'] }),
    (thrown) => {
      const error = engineError(thrown);
      return error.code === 'format' && error.reason === 'count' && error.expected === 1 && error.got === 0;
    }
  );
});

test('local: an empty answer rejects the operation instead of completing partial output', async () => {
  stubSend(() => ({ ok: true, translations: [''] }));
  await assert.rejects(localModel({ texts: ['hello', 'goodbye'] }), /unusable fragment/);
});

test('local: test() probes through the same host', async () => {
  stubSend(() => ({ ok: true, translations: ['확인'] }));
  const result = await engines.test({ target: 'ko', localModelId: 'plamo-0.8b' });
  assert.equal(result.output, '확인');
  assert.equal(result.detected, null);
  assert.ok(result.ms >= 0);
  assert.equal(translates().length, 1);
  assert.equal(translates()[0]!.texts.length, 1);
});

test('local: the host plans fragments and generation obeys those boundaries', async () => {
  stubSend(
    (message) => ({ ok: true, translations: message.texts.map(() => '번역') }),
    (message) => ({ ok: true, sourceChunks: message.texts.map((text: string) => [text]) })
  );
  const texts = ['alpha', 'beta', 'gamma'];
  await localModel({ texts, localMaxTokens: 1024 });

  const count = sent.find((message) => message.type === AT.C.MSG.LOCAL_COUNT) as ATNamespace;
  assert.deepEqual(count.texts, texts, 'every text is counted once, before packing');
  assert.deepEqual(
    translates().map((call) => call.texts),
    [['alpha'], ['beta'], ['gamma']],
    'the exact plan is dispatched without regrouping or numbering'
  );
});

test('local: unavailable tokenizer fails without estimated packing or generation', async () => {
  stubSend(() => assert.fail('must not generate'), () => ({ ok: false, error: 'the tokenizer did not load' }));
  await assert.rejects(localModel({ texts: ['one', 'two'] }), /tokenizer did not load/);
  assert.equal(translates().length, 0);
});

test('local: streamed indices survive counts, chunking, deduplication and skipped target text', async t => {
  const originalHost = AT.local.callHost;
  t.after(() => { AT.local.callHost = originalHost; });
  const seen: [number, string][] = [];
  const requests: ATNamespace[] = [];
  let previous: ((index: number, text: string) => void) | undefined;
  AT.local.callHost = async (message: ATNamespace, onProgress?: (index: number, text: string) => void) => {
    requests.push(message);
    assert.equal(message.onProgress, undefined);
    if (message.type === AT.C.MSG.LOCAL_COUNT) return { ok: true, sourceChunks: message.texts.map((text: string) => [text]) };
    previous?.(0, '늦은 응답');
    previous = onProgress;
    onProgress?.(0, '초안');
    onProgress?.(0, '');
    onProgress?.(0, '번역 ' + message.texts[0]);
    onProgress?.(9, '잘못된 위치');
    return { ok: true, translations: ['번역 ' + message.texts[0]] };
  };
  const result = await localModel({
    texts: ['한국어', 'alpha', '!', 'beta', 'alpha', 'gamma'], localMaxTokens: 1024,
    onProgress: (index: number, text: string) => seen.push([index, text])
  });
  previous?.(0, '완료 후 응답');
  assert.deepEqual(requests.filter(message => message.type === AT.C.MSG.LOCAL_TRANSLATE).map(message => message.texts),
    [['alpha'], ['beta'], ['gamma']]);
  assert.deepEqual(seen, [
    [1, '초안'], [4, '초안'], [1, ''], [4, ''], [1, '번역 alpha'], [4, '번역 alpha'],
    [3, '초안'], [3, ''], [3, '번역 beta'], [5, '초안'], [5, ''], [5, '번역 gamma']
  ]);
  assert.deepEqual(result.translations, ['한국어', '번역 alpha', '!', '번역 beta', '번역 alpha', '번역 gamma']);
});

test('local: an invalid final count clears streamed duplicates and rejects stale progress', async t => {
  const originalHost = AT.local.callHost;
  t.after(() => { AT.local.callHost = originalHost; });
  const seen: [number, string][] = [];
  let stale: ((index: number, text: string) => void) | undefined;
  AT.local.callHost = async (message: ATNamespace, progress?: (index: number, text: string) => void) => {
    if (message.type === AT.C.MSG.LOCAL_COUNT) return { ok: true, sourceChunks: message.texts.map((text: string) => [text]) };
    stale = progress;
    progress?.(0, '안녕');
    return { ok: true, translations: [] };
  };
  await assert.rejects(localModel({ texts: ['hello', 'hello'], onProgress: (index: number, text: string) => seen.push([index, text]) }), /result count/);
  stale?.(0, '오래된 응답');
  assert.deepEqual(seen, [[0, '안녕'], [1, '안녕'], [0, ''], [1, '']]);
});

test('local: cancellation clears previews even when the host completes later', async t => {
  const originalHost = AT.local.callHost;
  t.after(() => { AT.local.callHost = originalHost; });
  const controller = new AbortController();
  const seen: string[] = [];
  AT.local.callHost = async (message: ATNamespace, progress?: (index: number, text: string) => void) => {
    if (message.type === AT.C.MSG.LOCAL_COUNT) return { ok: true, sourceChunks: message.texts.map((text: string) => [text]) };
    progress?.(0, '안녕');
    controller.abort();
    progress?.(0, '늦은 응답');
    return { ok: true, translations: ['안녕하세요'] };
  };
  await assert.rejects(localModel({
    signal: controller.signal, onProgress: (_index: number, text: string) => seen.push(text)
  }), /cancelled/);
  assert.deepEqual(seen, ['안녕', '']);
});

test('local: cancellation during counting never packs estimates or dispatches generation', async t => {
  const originalHost = AT.local.callHost;
  t.after(() => { AT.local.callHost = originalHost; });
  const controller = new AbortController();
  const calls: string[] = [];
  AT.local.callHost = async (message: ATNamespace, _progress: unknown, signal: AbortSignal) => {
    calls.push(message.type);
    assert.equal(signal, controller.signal);
    controller.abort();
    return { ok: false, code: 'cancelled' };
  };
  await assert.rejects(localModel({ signal: controller.signal }), { code: 'cancelled' });
  assert.deepEqual(calls, [AT.C.MSG.LOCAL_COUNT]);
});

test('local: preaborted requests do not count and cancellation skips subsequent chunks', async t => {
  const originalHost = AT.local.callHost;
  t.after(() => { AT.local.callHost = originalHost; });
  const controller = new AbortController();
  const calls: string[] = [];
  AT.local.callHost = async (message: ATNamespace, _progress: unknown, signal: AbortSignal) => {
    calls.push(message.type);
    if (message.type === AT.C.MSG.LOCAL_COUNT) {
      assert.equal(signal, controller.signal);
      return { ok: true, sourceChunks: message.texts.map((text: string) => [text]) };
    }
    controller.abort();
    return { ok: true, translations: ['번역'] };
  };
  await assert.rejects(localModel({ texts: ['Hello there', 'Good morning'], localMaxTokens: 128, signal: controller.signal }), { code: 'cancelled' });
  assert.deepEqual(calls, [AT.C.MSG.LOCAL_COUNT, AT.C.MSG.LOCAL_TRANSLATE]);
  await assert.rejects(localModel({ signal: controller.signal }), { code: 'cancelled' });
  assert.equal(calls.length, 2);
});

test('interactive fragments hide out-of-order completion and preserve duplicate source order', async t => {
  const originalHost = AT.local.callHost;
  t.after(() => { AT.local.callHost = originalHost; });
  const parts = ['図書館を開きます。', '本を借りられます。', '予約もできます。'];
  const source = parts.join('');
  const gates: { progress: ((index: number, text: string) => void) | undefined; resolve: (reply: unknown) => void }[] = [];
  const seen: [number, string][] = [];
  AT.local.callHost = async (message: ATNamespace, progress?: (index: number, text: string) => void) => {
    if (message.type === AT.C.MSG.LOCAL_COUNT) return { ok: true, sourceChunks: [parts] };
    const gate = Promise.withResolvers<unknown>();
    gates.push({ progress, resolve: gate.resolve });
    return gate.promise;
  };
  const result = localModel({ texts: [source, source], source: 'ja', fragmentConcurrency: 2,
    onProgress: (index: number, text: string) => seen.push([index, text]) });
  for (let turn = 0; gates.length < 2 && turn < 30; turn++) await Promise.resolve();
  assert.equal(gates.length, 2);
  gates[1]!.progress?.(0, '책을 빌릴 수 있습니다.');
  gates[1]!.resolve({ ok: true, translations: ['책을 빌릴 수 있습니다.'] });
  for (let turn = 0; gates.length < 3 && turn < 30; turn++) await Promise.resolve();
  assert.ok(seen.every(([, text]) => !text), 'a later fragment is not a readable prefix');
  gates[0]!.progress?.(0, '도서관');
  assert.deepEqual(seen.slice(-2), [[0, '도서관'], [1, '도서관']]);
  gates[0]!.resolve({ ok: true, translations: ['도서관을 엽니다.'] });
  gates[2]!.resolve({ ok: true, translations: ['예약도 가능합니다.'] });
  const completed = await result;
  assert.deepEqual(completed.translations, Array(2).fill('도서관을 엽니다. 책을 빌릴 수 있습니다. 예약도 가능합니다.'));
  const before = [...seen];
  gates[0]!.progress?.(0, '오래된 응답');
  assert.deepEqual(seen, before);
  assert.equal(completed.timing.chunks, 3);
});

test('interactive fragment failure aborts its sibling, clears preview and never dispatches queued work', async t => {
  const originalHost = AT.local.callHost;
  t.after(() => { AT.local.callHost = originalHost; });
  const parts = ['図書館を開きます。', '本を借りられます。', '予約もできます。'];
  const gates: { signal: AbortSignal; progress: ((index: number, text: string) => void) | undefined; resolve: (reply: unknown) => void }[] = [];
  const seen: string[] = [];
  AT.local.callHost = async (message: ATNamespace, progress: ((index: number, text: string) => void) | undefined, signal: AbortSignal) => {
    if (message.type === AT.C.MSG.LOCAL_COUNT) return { ok: true, sourceChunks: [parts] };
    const gate = Promise.withResolvers<unknown>();
    gates.push({ signal, progress, resolve: gate.resolve });
    return gate.promise;
  };
  const result = localModel({ texts: [parts.join('')], source: 'ja', fragmentConcurrency: 2,
    onProgress: (_index: number, text: string) => seen.push(text) });
  const rejected = assert.rejects(result, /unusable fragment/);
  for (let turn = 0; gates.length < 2 && turn < 30; turn++) await Promise.resolve();
  gates[0]!.progress?.(0, '도서관');
  gates[1]!.resolve({ ok: true, translations: [''] });
  await rejected;
  assert.ok(gates.every(gate => gate.signal.aborted));
  gates[0]!.progress?.(0, '늦은 응답');
  gates[0]!.resolve({ ok: true, translations: ['도서관을 엽니다.'] });
  await Promise.resolve();
  assert.deepEqual(seen, ['도서관', '']);
  assert.equal(gates.length, 2);
});

test('interactive source planning never silently falls back to character estimates', async () => {
  stubSend(() => { throw new Error('must not generate'); }, () => ({ ok: false, error: 'no counts' }));
  await assert.rejects(localModel({ texts: ['図書館からのお知らせです。'] }), /no counts/);
  assert.equal(translates().length, 0);
});

type FragmentGate = {
  text: string;
  signal: AbortSignal;
  progress: ((index: number, text: string) => void) | undefined;
  resolve: (reply: unknown) => void;
};

async function flushFragments(): Promise<void> {
  for (let turn = 0; turn < 80; turn++) await Promise.resolve();
}

function fragmentHost(plans: Map<string, string[]>) {
  const gates: FragmentGate[] = [];
  let active = 0;
  let peak = 0;
  AT.local.callHost = async (message: ATNamespace, progress: FragmentGate['progress'], signal: AbortSignal) => {
    if (message.type === AT.C.MSG.LOCAL_COUNT) {
      return { ok: true, sourceChunks: message.texts.map((text: string) => plans.get(text) ?? [text]) };
    }
    assert.equal(message.type, AT.C.MSG.LOCAL_TRANSLATE);
    active++;
    peak = Math.max(peak, active);
    const gate = Promise.withResolvers<unknown>();
    gates.push({ text: message.texts[0], signal, progress, resolve: gate.resolve });
    try { return await gate.promise; } finally { active--; }
  };
  return { gates, peak: () => peak };
}

test('shared fragment slots lend a completed short unit slot to the unfinished long unit', async t => {
  const originalHost = AT.local.callHost;
  t.after(() => { AT.local.callHost = originalHost; });
  const parts = ['図書館を開きます。', '本を借りられます。', '予約もできます。'];
  const source = parts.join('');
  const { gates, peak } = fragmentHost(new Map([[source, parts]]));
  const fragmentScheduler = engines.createFragmentScheduler(2);
  const common = { source: 'ja', fragmentConcurrency: 2, fragmentScheduler };
  const short = localModel({ ...common, texts: ['今日は晴れです。'] });
  await flushFragments();
  const seen: string[] = [];
  const long = localModel({ ...common, texts: [source], onProgress: (_index: number, text: string) => seen.push(text) });
  await flushFragments();
  assert.deepEqual(gates.map(gate => gate.text), ['今日は晴れです。', parts[0]]);
  gates[0]!.resolve({ ok: true, translations: ['오늘은 맑습니다.'] });
  assert.deepEqual((await short).translations, ['오늘은 맑습니다.']);
  await flushFragments();
  assert.equal(gates[2]!.text, parts[1], 'borrows the released slot while the first long fragment is still running');
  gates[2]!.resolve({ ok: true, translations: ['책을 빌릴 수 있습니다.'] });
  await flushFragments();
  assert.equal(gates[3]!.text, parts[2]);
  assert.ok(seen.every(text => text === ''), 'completed suffix fragments are not exposed ahead of the source prefix');
  gates[1]!.resolve({ ok: true, translations: ['도서관을 엽니다.'] });
  gates[3]!.resolve({ ok: true, translations: ['예약도 가능합니다.'] });
  assert.deepEqual((await long).translations, ['도서관을 엽니다. 책을 빌릴 수 있습니다. 예약도 가능합니다.']);
  assert.equal(peak(), 2);
});

test('shared serial admission caps overlapping parallel fragment requests at one generation', async t => {
  const originalHost = AT.local.callHost;
  t.after(() => { AT.local.callHost = originalHost; });
  const parts = ['図書館を開きます。', '本を借りられます。'];
  const source = parts.join('');
  const { gates, peak } = fragmentHost(new Map([[source, parts]]));
  const common = { source: 'ja', fragmentConcurrency: 2, fragmentScheduler: engines.createFragmentScheduler(1) };
  const first = localModel({ ...common, texts: [source] });
  const second = localModel({ ...common, texts: ['今日は晴れです。'] });
  await flushFragments();
  assert.equal(gates.length, 1);
  for (let index = 0; index < 3; index++) {
    assert.equal(gates.length, index + 1);
    gates[index]!.resolve({ ok: true, translations: ['번역했습니다.'] });
    await flushFragments();
  }
  assert.deepEqual((await first).translations, ['번역했습니다. 번역했습니다.']);
  assert.deepEqual((await second).translations, ['번역했습니다.']);
  assert.equal(peak(), 1);
});

test('queued fragment cancellation never generates or publishes and leaves other owners intact', async t => {
  const originalHost = AT.local.callHost;
  t.after(() => { AT.local.callHost = originalHost; });
  const { gates } = fragmentHost(new Map());
  const common = { source: 'ja', fragmentConcurrency: 2, fragmentScheduler: engines.createFragmentScheduler(1) };
  const survivor = localModel({ ...common, texts: ['今日は晴れです。'] });
  await flushFragments();
  const controller = new AbortController();
  const seen: string[] = [];
  const cancelled = localModel({ ...common, texts: ['図書館を開きます。'], signal: controller.signal,
    onProgress: (_index: number, text: string) => seen.push(text) });
  const rejected = assert.rejects(cancelled, { code: 'cancelled' });
  await flushFragments();
  controller.abort();
  await rejected;
  assert.equal(gates[0]!.signal.aborted, false);
  gates[0]!.resolve({ ok: true, translations: ['오늘은 맑습니다.'] });
  await survivor;
  await flushFragments();
  assert.equal(gates.length, 1);
  assert.deepEqual(seen, []);
  const next = localModel({ ...common, texts: ['明日も晴れです。'] });
  await flushFragments();
  assert.equal(gates.length, 2, 'cancelled queue entries do not leak admission');
  gates[1]!.resolve({ ok: true, translations: ['내일도 맑습니다.'] });
  await next;
});

test('fragment failure removes only its queued siblings before lending the slot to another owner', async t => {
  const originalHost = AT.local.callHost;
  t.after(() => { AT.local.callHost = originalHost; });
  const parts = ['図書館を開きます。', '本を借りられます。', '予約もできます。'];
  const source = parts.join('');
  const { gates, peak } = fragmentHost(new Map([[source, parts]]));
  const common = { source: 'ja', fragmentConcurrency: 2, fragmentScheduler: engines.createFragmentScheduler(2) };
  const survivor = localModel({ ...common, texts: ['今日は晴れです。'] });
  await flushFragments();
  const seen: string[] = [];
  const failed = localModel({ ...common, texts: [source], onProgress: (_index: number, text: string) => seen.push(text) });
  const rejected = assert.rejects(failed, /unusable fragment/);
  await flushFragments();
  const next = localModel({ ...common, texts: ['明日も晴れです。'] });
  await flushFragments();
  gates[1]!.progress?.(0, '도서관');
  gates[1]!.resolve({ ok: true, translations: [''] });
  await rejected;
  await flushFragments();
  assert.deepEqual(gates.map(gate => gate.text), ['今日は晴れです。', parts[0], '明日も晴れです。']);
  assert.equal(gates[0]!.signal.aborted, false);
  assert.equal(gates[2]!.signal.aborted, false);
  gates[1]!.progress?.(0, '늦은 응답');
  assert.deepEqual(seen, ['도서관', '']);
  gates[0]!.resolve({ ok: true, translations: ['오늘은 맑습니다.'] });
  gates[2]!.resolve({ ok: true, translations: ['내일도 맑습니다.'] });
  await Promise.all([survivor, next]);
  assert.equal(peak(), 2);
});

for (const width of [1, 2, 4, 8]) {
  test(`fragment workers respect requested width ${width} without dropping source fragments`, async t => {
    const originalHost = AT.local.callHost;
    t.after(() => { AT.local.callHost = originalHost; });
    const parts = Array.from({ length: 10 }, () => '図書館を開きます。');
    const source = parts.join('');
    const { gates, peak } = fragmentHost(new Map([[source, parts]]));
    const result = localModel({ texts: [source], source: 'ja', fragmentConcurrency: width });
    await flushFragments();
    assert.equal(gates.length, width);
    for (let index = 0; index < parts.length; index++) {
      gates[index]!.resolve({ ok: true, translations: ['번역했습니다.'] });
      await flushFragments();
      assert.equal(gates.length, Math.min(parts.length, width + index + 1));
    }
    assert.deepEqual((await result).translations, [Array.from({ length: 10 }, () => '번역했습니다.').join(' ')]);
    assert.equal(peak(), width);
  });
}

test('shared admission rotates pending owners while preserving each owner FIFO', async () => {
  const scheduler = engines.createFragmentScheduler(1);
  const signal = new AbortController().signal;
  const started: string[] = [];
  const releases: (() => void)[] = [];
  const jobs = [[7, 'a1'], [7, 'a2'], [7, 'a3'], [8, 'b1'], [8, 'b2'], [9, 'c1'], [9, 'c2']] as const;
  const pending = jobs.map(([owner, text]) => scheduler.run(async () => {
    started.push(text);
    const gate = Promise.withResolvers<void>();
    releases.push(gate.resolve);
    await gate.promise;
  }, signal, owner));
  await flushFragments();
  for (let index = 0; index < jobs.length; index++) {
    assert.equal(releases.length, index + 1);
    releases[index]!();
    await flushFragments();
  }
  await Promise.all(pending);
  assert.deepEqual(started, ['a1', 'a2', 'b1', 'c1', 'a3', 'b2', 'c2']);
});

test('lowering shared admission retains active slot accounting until those generations settle', async () => {
  const scheduler = engines.createFragmentScheduler(8);
  const signal = new AbortController().signal;
  const releases: (() => void)[] = [];
  const pending = Array.from({ length: 9 }, () => scheduler.run(async () => {
    const gate = Promise.withResolvers<void>();
    releases.push(gate.resolve);
    await gate.promise;
  }, signal));
  await flushFragments();
  assert.equal(releases.length, 8);
  scheduler.setConcurrency(2);
  for (let index = 0; index < 6; index++) {
    releases[index]!();
    await flushFragments();
    assert.equal(releases.length, 8);
  }
  releases[6]!();
  await flushFragments();
  assert.equal(releases.length, 9);
  releases[7]!();
  releases[8]!();
  await Promise.all(pending);
});

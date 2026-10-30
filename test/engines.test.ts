import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { load, fetchStub, json, response, type ATNamespace } from './helpers.ts';

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
  'lib/gemma.js',
  'lib/pagecontext.js',
  'lib/targets.js',
  'lib/rules.js',
  'lib/local.js',
  'lib/settings.js',
  'lib/engines.js'
);
const { engines } = AT;

const LIBRE = 'http://127.0.0.1:5000/translate';

/**
 * Rejections from engines.js arrive untyped across the eval boundary; these are
 * the members the tests below assert on (each code carries its own subset).
 */
type EngineError = Error & { code: string; status: number; detail: string; reason: string; expected: number; got: number };

const engineError = (thrown: unknown): EngineError => thrown as EngineError;

function googleReply(lines: string[], detected = 'en') {
  const segments = lines.map((line, index) => [
    `${index === 0 ? '' : '\n'}${line}`,
    `orig-${index}`,
    null,
    null,
    10
  ]);
  return [segments, null, detected, null, null];
}

const google = (overrides: ATNamespace = {}) =>
  engines.translate({ engine: 'google', target: 'ko', texts: ['hello'], ...overrides });

test('google: joins a chunk with newlines and splits the reply back', async () => {
  const { calls, fetchImpl } = fetchStub(() => json(googleReply(['안녕', '잘 지내요'])));
  const result = await google({ texts: ['hello', 'how are you'], fetchImpl });
  assert.deepEqual(result.translations, ['안녕', '잘 지내요']);
  assert.equal(result.detected, 'en');
  assert.equal(calls.length, 1);
  const url = new URL(calls[0]!.url);
  assert.equal(url.origin + url.pathname, 'https://translate.googleapis.com/translate_a/single');
  assert.equal(url.searchParams.get('client'), 'gtx');
  assert.equal(url.searchParams.get('sl'), 'auto');
  assert.equal(url.searchParams.get('tl'), 'ko');
  assert.equal(url.searchParams.get('dt'), 't');
  assert.equal(url.searchParams.get('q'), 'hello\nhow are you');
  assert.equal(calls[0]!.init.body, undefined);
});

test('google: maps language codes per provider', async () => {
  const { calls, fetchImpl } = fetchStub(() => json(googleReply(['你好'])));
  await google({ target: 'zh-CN', source: 'pt', texts: ['hello'], fetchImpl });
  const url = new URL(calls[0]!.url);
  assert.equal(url.searchParams.get('tl'), 'zh-CN');
  assert.equal(url.searchParams.get('sl'), 'pt-BR');
});

test('google: a reply that cannot be split falls back to one request per text', async () => {
  let first = true;
  const { calls, fetchImpl } = fetchStub(() => {
    if (first) {
      first = false;
      // One line back for two inputs: the boundaries are unknowable.
      return json(googleReply(['glued together']));
    }
    const url = new URL(calls.at(-1)!.url);
    return json(googleReply([`<${url.searchParams.get('q')}>`]));
  });
  const result = await google({ texts: ['one', 'two'], fetchImpl });
  assert.deepEqual(result.translations, ['<one>', '<two>']);
  assert.equal(calls.length, 3);
});

test('google: a Korean page asks about its English text separately', async () => {
  // `sl=auto` decides once per request. Sending the English title with the
  // Korean chrome around it made Google answer "Korean" and echo the title
  // untranslated, so the page never finished. Each script is asked on its own.
  const { calls, fetchImpl } = fetchStub(() => {
    const url = new URL(calls.at(-1)!.url);
    const q = url.searchParams.get('q') ?? '';
    return json(googleReply([q.split('\n').map((line) => `<${line}>`).join('\n')]));
  });
  const result = await google({ texts: ['구독', 'Never Gonna Give You Up', '좋아요'], fetchImpl });
  assert.deepEqual(result.translations, ['<구독>', '<Never Gonna Give You Up>', '<좋아요>']);
  assert.equal(calls.length, 2, 'one request for the Hangul texts, one for the Latin');
  assert.deepEqual(
    calls.map((call) => new URL(call.url).searchParams.get('q')),
    ['구독\n좋아요', 'Never Gonna Give You Up']
  );
});

test('google: a single text keeps its whole answer, even with line breaks in it', async () => {
  // Sentence segmentation in the reply used to fail a one-text chunk outright
  // ("Google batch split mismatch"), which is what broke YouTube descriptions:
  // the chunk was fine, the answer simply had more lines than the request.
  const { fetchImpl } = fetchStub(() => json(googleReply(['첫 문장입니다.\n둘째 문장입니다.'])));
  const result = await google({ texts: ['First sentence. Second sentence.'], fetchImpl });
  assert.deepEqual(result.translations, ['첫 문장입니다.\n둘째 문장입니다.']);
});

test('google: a multi-text chunk whose answer has extra lines is retried per text', async () => {
  // Two inputs, three lines back: the boundaries are unknowable, and the retry
  // asks one text at a time instead of failing the page.
  let first = true;
  const { calls, fetchImpl } = fetchStub(() => {
    if (first) {
      first = false;
      return json(googleReply(['a', 'b', 'c']));
    }
    const url = new URL(calls.at(-1)!.url);
    return json(googleReply([`<${url.searchParams.get('q')}>`]));
  });
  const result = await google({ texts: ['one', 'two'], fetchImpl });
  assert.deepEqual(result.translations, ['<one>', '<two>']);
  assert.equal(calls.length, 3);
});

test('google: an HTML rate-limit page is reported as a format error', async () => {
  const { fetchImpl } = fetchStub(() => response(200, '<html><title>Sorry...</title></html>'));
  await assert.rejects(() => google({ fetchImpl }), (thrown) => {
    const error = engineError(thrown);
    assert.equal(error.name, 'EngineError');
    assert.equal(error.code, 'format');
    assert.match(error.detail, /Sorry/);
    return true;
  });
});

test('a 5xx answer is retried once, then surfaced with its status', async () => {
  const { calls, fetchImpl } = fetchStub(() => response(503, 'upstream busy'));
  await assert.rejects(
    () => engines.translate({ engine: 'libretranslate', target: 'ko', texts: ['hello'], fetchImpl }),
    (thrown) => {
      const error = engineError(thrown);
      assert.equal(error.code, 'http');
      assert.equal(error.status, 503);
      assert.equal(error.detail, 'upstream busy');
      return true;
    }
  );
  assert.equal(calls.length, AT.C.PROVIDER_RETRIES + 1);
});

test('a 429 answer is reported as a rate limit', async () => {
  const { calls, fetchImpl } = fetchStub(() => response(429, 'slow down'));
  await assert.rejects(() => google({ fetchImpl }), (thrown) => {
    const error = engineError(thrown);
    assert.equal(error.code, 'rate-limit');
    return true;
  });
  assert.equal(calls.length, AT.C.PROVIDER_RETRIES + 1);
});

test('a transport failure is reported as a network error', async () => {
  const { fetchImpl } = fetchStub(() => {
    throw new TypeError('Failed to fetch');
  });
  await assert.rejects(() => google({ fetchImpl }), (thrown) => {
    const error = engineError(thrown);
    assert.equal(error.code, 'network');
    assert.match(error.message, /Failed to fetch/);
    return true;
  });
});

test('a provider that never answers times out', async () => {
  const previous = AT.C.PROVIDER_TIMEOUT_MS;
  AT.C.PROVIDER_TIMEOUT_MS = 25;
  const { fetchImpl } = fetchStub(
    (_url, init) =>
      new Promise<never>((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      })
  );
  try {
    await assert.rejects(() => google({ fetchImpl }), (thrown) => {
      const error = engineError(thrown);
      assert.equal(error.code, 'timeout');
      return true;
    });
  } finally {
    AT.C.PROVIDER_TIMEOUT_MS = previous;
  }
});

test('libretranslate: batches texts and forwards the key when present', async () => {
  const { calls, fetchImpl } = fetchStub(() =>
    json([
      { translatedText: '안녕' },
      { translatedText: '잘 지내요' },
      { translatedText: '좋아요' }
    ])
  );
  const result = await engines.translate({
    engine: 'libretranslate',
    endpoints: { libretranslate: LIBRE },
    apiKey: 'secret',
    source: 'en',
    target: 'ko',
    texts: ['hello', 'how are you', 'nice'],
    fetchImpl
  });
  assert.deepEqual(result.translations, ['안녕', '잘 지내요', '좋아요']);
  assert.equal(result.requested, 3);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, LIBRE);
  assert.equal(calls[0]!.init.method, 'POST');
  const body = JSON.parse(calls[0]!.init.body!);
  assert.deepEqual(body.q, ['hello', 'how are you', 'nice']);
  assert.equal(body.format, 'text');
  assert.equal(body.api_key, 'secret');
});

test('libretranslate: omits api_key and aliases regional codes', async () => {
  const { calls, fetchImpl } = fetchStub(() => json([{ translatedText: '你好' }]));
  await engines.translate({
    engine: 'libretranslate',
    endpoints: { libretranslate: LIBRE },
    source: 'zh-TW',
    target: 'pt',
    texts: ['hello'],
    fetchImpl
  });
  const body = JSON.parse(calls[0]!.init.body!);
  assert.equal(body.api_key, undefined);
  assert.equal(body.source, 'zh');
  assert.equal(body.target, 'pt');
});

test('libretranslate: accepts the contents and single-object reply shapes', async () => {
  const contents = fetchStub(() => json({ contents: [{ translatedText: '안녕' }] }));
  const single = fetchStub(() => json({ translatedText: '안녕', detectedLanguage: 'en' }));
  assert.deepEqual(
    (await engines.translate({ engine: 'libretranslate', endpoints: { libretranslate: LIBRE }, target: 'ko', texts: ['hello'], fetchImpl: contents.fetchImpl })).translations,
    ['안녕']
  );
  const result = await engines.translate({
    engine: 'libretranslate',
    endpoints: { libretranslate: LIBRE },
    target: 'ko',
    texts: ['hello'],
    fetchImpl: single.fetchImpl
  });
  assert.deepEqual(result.translations, ['안녕']);
  assert.equal(result.detected, 'en');
});

test('libretranslate: provider errors and short replies are distinguishable', async () => {
  const quota = fetchStub(() => json({ error: 'Rate limit exceeded' }, 400));
  await assert.rejects(
    () =>
      engines.translate({
        engine: 'libretranslate',
        endpoints: { libretranslate: LIBRE },
        target: 'ko',
        texts: ['hello'],
        fetchImpl: quota.fetchImpl
      }),
    (thrown) => {
      const error = engineError(thrown);
      assert.equal(error.code, 'rate-limit');
      assert.match(error.message, /Rate limit/);
      return true;
    }
  );
  const short = fetchStub(() => json([{ translatedText: 'a' }, { translatedText: 'b' }]));
  await assert.rejects(
    () =>
      engines.translate({
        engine: 'libretranslate',
        endpoints: { libretranslate: LIBRE },
        target: 'ko',
        texts: ['one', 'two', 'three'],
        fetchImpl: short.fetchImpl
      }),
    (thrown) => {
      const error = engineError(thrown);
      assert.equal(error.code, 'format');
      assert.equal(error.reason, 'count');
      return true;
    }
  );
});

test('duplicate and blank texts never reach the provider', async () => {
  const { calls, fetchImpl } = fetchStub(() => json([{ translatedText: '안녕' }]));
  const result = await engines.translate({
    engine: 'libretranslate',
    endpoints: { libretranslate: LIBRE },
    target: 'ko',
    texts: ['hello', 'hello', '   ', '', 'hello'],
    fetchImpl
  });
  assert.equal(result.requested, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0]!.init.body!).q, ['hello']);
  assert.deepEqual(result.translations, ['안녕', '안녕', '   ', '', '안녕']);
});

test('oversized input is split into several requests in order', async () => {
  const { calls, fetchImpl } = fetchStub((_url, init) => {
    const q = JSON.parse(init.body!).q;
    return json(q.map((text: string) => ({ translatedText: text.toUpperCase() })));
  });
  const texts = ['a'.repeat(3000), 'b'.repeat(3000), 'c'.repeat(10)];
  const result = await engines.translate({
    engine: 'libretranslate',
    endpoints: { libretranslate: LIBRE },
    target: 'ko',
    texts,
    fetchImpl
  });
  assert.ok(calls.length > 1, 'expected more than one request');
  assert.deepEqual(
    result.translations,
    texts.map((text) => text.toUpperCase())
  );
});

test('bad configuration is rejected before any request', async () => {
  const { calls, fetchImpl } = fetchStub(() => json([]));
  await assert.rejects(
    () => engines.translate({ engine: 'nope', target: 'ko', texts: ['hello'], fetchImpl }),
    (thrown) => engineError(thrown).code === 'config'
  );
  await assert.rejects(
    () => engines.translate({ engine: 'google', target: 'klingon', texts: ['hello'], fetchImpl }),
    (thrown) => engineError(thrown).code === 'config'
  );
  await assert.rejects(
    () =>
      engines.translate({
        engine: 'libretranslate',
        endpoints: { libretranslate: 'javascript:alert(1)' },
        target: 'ko',
        texts: ['hello'],
        fetchImpl
      }),
    (thrown) => engineError(thrown).code === 'config'
  );
  assert.equal(calls.length, 0);
});

test('test() round-trips a probe sentence', async () => {
  const { fetchImpl } = fetchStub(() => json([{ translatedText: 'OK' }]));
  const result = await engines.test({
    engine: 'libretranslate',
    endpoints: { libretranslate: LIBRE },
    target: 'ko',
    fetchImpl
  });
  assert.equal(result.output, 'OK');
  assert.equal(result.engine, 'libretranslate');
  assert.ok(result.ms >= 0);
});

// --- the on-device engine ---------------------------------------------------
// The host is the offscreen document; the tests stand in for it so the
// contract (one message per chunk, answers mapped back to the inputs) is fixed
// without loading a 4B model.

const localModel = (overrides: ATNamespace = {}) =>
  engines.translate({ engine: 'local', target: 'ko', texts: ['hello'], localModelId: 'gemma-4b', ...overrides });

let sent: ATNamespace[] = [];

function stubSend(reply: (message: ATNamespace) => unknown, counts?: (message: ATNamespace) => unknown) {
  sent = [];
  AT.sendMessage = async (message: ATNamespace) => {
    sent.push(message);
    // The engine asks the host for real token counts before it packs; a stub
    // that answers everything as a translation would starve that path.
    if (message.type === AT.C.MSG.LOCAL_COUNT) {
      return counts ? counts(message) : { ok: false, error: 'no counts' };
    }
    return reply(message);
  };
}

/** Only the messages that ask for a translation; counting is a separate hop. */
const translates = () => sent.filter((message) => message.type === AT.C.MSG.LOCAL_TRANSLATE);

after(() => {
  delete AT.sendMessage;
});

test('local: the model is asked through the offscreen host, never a URL', async () => {
  stubSend(() => ({ ok: true, translations: ['안녕'] }));
  // A poisoned endpoint must be irrelevant: the local engine has no URL.
  const result = await localModel({ endpoints: { local: 'javascript:alert(1)' } });
  assert.deepEqual(result.translations, ['안녕']);
  assert.equal(result.engine, 'local');
  assert.equal(translates().length, 1);
  const first = translates()[0] as ATNamespace;
  assert.equal(first.type, AT.C.MSG.LOCAL_TRANSLATE);
  assert.equal(first.to, AT.local.TARGET_OFFSCREEN);
  assert.equal(first.modelId, 'gemma-4b');
  assert.deepEqual(first.texts, ['hello']);
  assert.equal(first.source, '', 'no detector answer: the host is not told a source');
  assert.equal(first.target, 'ko');
  assert.equal(first.maxTokens, AT.local.DEFAULT_MAX_TOKENS);
});

test('local: the source comes from the browser detector when the setting says auto', async () => {
  detector.answer = { isReliable: false, languages: [{ language: 'de-AT', percentage: 100 }] };
  stubSend(() => ({ ok: true, translations: ['안녕'] }));
  try {
    const result = await localModel({ source: 'auto', texts: ['Guten Morgen'] });
    assert.deepEqual(detector.calls, ['Guten Morgen'], 'the detector sees the text, not the settings');
    assert.equal((translates()[0] as ATNamespace).source, 'de-AT', 'a table code goes through unchanged');
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

test('local: the region of the page joins the page context in one line', async () => {
  stubSend(() => ({ ok: true, translations: ['안녕'] }));
  const context = {
    kind: 'news', site: 'Example News', title: 'Headline', section: 'Politics',
    sections: [], language: 'en', summary: null, tags: [], entities: [], glossary: []
  };
  await localModel({ context, role: 'comment' });
  assert.equal(
    (translates()[0] as ATNamespace).context,
    'This is a news article in the Politics section from Example News. These are reader comments.',
    'the region decides register: a comment is not prose'
  );

  await localModel({ context, role: 'article' });
  assert.equal(
    (translates()[1] as ATNamespace).context,
    'This is a news article in the Politics section from Example News.',
    'article text adds no line of its own'
  );

  await localModel({ context: null, role: 'navigation' });
  assert.equal((translates()[2] as ATNamespace).context, 'These are navigation labels.');
});

test('local: the target is the model code, and only a model code', async () => {
  stubSend(() => ({ ok: true, translations: ['你好'] }));
  await localModel({ target: 'zh-CN', texts: ['hello'] });
  assert.equal((translates()[0] as ATNamespace).target, 'zh-Hans', 'Simplified Chinese is zh-Hans to this model');

  const before = sent.length;
  await assert.rejects(
    () => localModel({ target: 'xx-YY' }),
    (thrown: unknown) => engineError(thrown).code === 'config',
    'a target the model has no code for is refused before the host is woken'
  );
  assert.equal(sent.length, before, 'nothing was sent');
});

test('local: the page context becomes one bounded line for the host', async () => {
  stubSend(() => ({ ok: true, translations: ['안녕'] }));
  const context = {
    kind: 'news',
    site: 'Example News',
    title: 'Headline',
    section: 'Politics',
    language: 'en',
    summary: null,
    tags: []
  };
  await localModel({ context });
  assert.equal(
    (translates()[0] as ATNamespace).context,
    'This is a news article in the Politics section from Example News.',
    'the analyzer renders the line, the host only pastes it'
  );

  await localModel({ context: null });
  assert.equal((translates()[1] as ATNamespace).context, '', 'no context, no line');

  await localModel({ context: { ...context, kind: 'unknown', site: 'example.com' } });
  assert.equal((translates()[2] as ATNamespace).context, '', 'a host alone is not context');
});

test('local: a token budget splits the work and the answers stay in order', async () => {
  // 900 Latin characters are ~150 tokens each, and a chunk pays for input and
  // its answer: two fit in 1024, three do not.
  const texts = Array.from({ length: 5 }, (_unused, index) => `s${index} ${'x'.repeat(897)}`);
  stubSend((message) => ({ ok: true, translations: message.texts.map((text: string) => `[${text.slice(0, 2)}]`) }));
  const result = await localModel({ texts, localMaxTokens: 1024 });
  assert.deepEqual(
    translates().map((call) => call.texts.length),
    [2, 2, 1],
    'each chunk stays inside the budget'
  );
  assert.deepEqual(result.translations, texts.map((text) => `[${text.slice(0, 2)}]`));
});

test('local: Korean packs by measured tokens, not by Latin characters', async () => {
  // The same character count is worth ~3.4x the tokens in Hangul (1.82
  // characters per token against 6.12 for Latin), so a batch that looks small
  // by length must still be split.
  const korean = Array.from({ length: 4 }, (_unused, index) => `${index}번째 ` + '인공지능 번역 모델은 문장의 의미와 뉘앙스를 정확하게 전달해야 하며, 원문의 문체와 문화적 맥락을 함께 고려해야 합니다. '.repeat(4));
  stubSend((message) => ({ ok: true, translations: message.texts.map(() => '번역') }));
  await localModel({ texts: korean, localMaxTokens: 1024, source: 'ko', target: 'ko' });
  assert.ok(translates().length >= 2, 'the Latin-sized batch would have overflowed the context');
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

test('local: no model selected fails without waking the host', async () => {
  stubSend(() => ({ ok: true, translations: [''] }));
  await assert.rejects(() => localModel({ localModelId: '' }), (thrown) => engineError(thrown).code === 'config');
  assert.equal(sent.length, 0);
});

test('local: the host failure decides who is at fault', async () => {
  const cases: [ATNamespace, string][] = [
    [{ ok: false, code: 'config', error: 'this browser has no WebGPU' }, 'config'],
    [{ ok: false, code: 'timeout', error: 'the generation ran too long' }, 'timeout'],
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
  stubSend(() => ({ ok: true, translations: ['only one'] }));
  await assert.rejects(
    () => localModel({ texts: ['hello there', 'goodbye now'] }),
    (thrown) => {
      const error = engineError(thrown);
      return error.code === 'format' && error.reason === 'count' && error.expected === 2 && error.got === 1;
    }
  );
});

test('local: an empty answer keeps the original text', async () => {
  stubSend(() => ({ ok: true, translations: ['', '안녕'] }));
  const result = await localModel({ texts: ['hello', 'goodbye'] });
  assert.deepEqual(result.translations, ['hello', '안녕']);
});

test('local: test() probes through the same host', async () => {
  stubSend(() => ({ ok: true, translations: ['확인'] }));
  const result = await engines.test({ engine: 'local', target: 'ko', localModelId: 'gemma-4b' });
  assert.equal(result.output, '확인');
  assert.equal(result.engine, 'local');
  assert.equal(translates().length, 1);
  assert.equal(translates()[0]!.texts.length, 1);
});

test('local: the host counts tokens, and the packing obeys those counts', async () => {
  // The host owns the tokenizer, so the engine asks before it packs. These
  // counts say each text is 500 tokens: two of them plus the instruction do
  // not fit in 1024, and no character arithmetic is involved.
  stubSend(
    (message) => ({ ok: true, translations: message.texts.map(() => '번역') }),
    (message) => ({ ok: true, counts: message.texts.map(() => 500), overhead: 90 })
  );
  const texts = ['alpha', 'beta', 'gamma'];
  await localModel({ texts, localMaxTokens: 1024 });

  const count = sent.find((message) => message.type === AT.C.MSG.LOCAL_COUNT) as ATNamespace;
  assert.deepEqual(count.texts, texts, 'every text is counted once, before packing');
  assert.deepEqual(
    translates().map((call) => call.texts),
    [['alpha'], ['beta'], ['gamma']],
    'one text per generation: 90 + 2 x 500 already exceeds the budget'
  );
});

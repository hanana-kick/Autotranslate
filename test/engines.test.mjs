import test from 'node:test';
import assert from 'node:assert/strict';
import { load, fetchStub, json, response } from './helpers.mjs';

const AT = load('lib/constants.js', 'lib/rules.js', 'lib/settings.js', 'lib/engines.js');
const { engines } = AT;

const LIBRE = 'http://127.0.0.1:5000/translate';

function googleReply(lines, detected = 'en') {
  const segments = lines.map((line, index) => [
    `${index === 0 ? '' : '\n'}${line}`,
    `orig-${index}`,
    null,
    null,
    10
  ]);
  return [segments, null, detected, null, null];
}

const google = (overrides = {}) =>
  engines.translate({ engine: 'google', target: 'ko', texts: ['hello'], ...overrides });

test('google: joins a chunk with newlines and splits the reply back', async () => {
  const { calls, fetchImpl } = fetchStub(() => json(googleReply(['안녕', '잘 지내요'])));
  const result = await google({ texts: ['hello', 'how are you'], fetchImpl });
  assert.deepEqual(result.translations, ['안녕', '잘 지내요']);
  assert.equal(result.detected, 'en');
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, 'https://translate.googleapis.com/translate_a/single');
  assert.equal(url.searchParams.get('client'), 'gtx');
  assert.equal(url.searchParams.get('sl'), 'auto');
  assert.equal(url.searchParams.get('tl'), 'ko');
  assert.equal(url.searchParams.get('dt'), 't');
  assert.equal(url.searchParams.get('q'), 'hello\nhow are you');
  assert.equal(calls[0].init.body, undefined);
});

test('google: maps language codes per provider', async () => {
  const { calls, fetchImpl } = fetchStub(() => json(googleReply(['你好'])));
  await google({ target: 'zh-CN', source: 'pt', texts: ['hello'], fetchImpl });
  const url = new URL(calls[0].url);
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
    const url = new URL(calls.at(-1).url);
    return json(googleReply([`<${url.searchParams.get('q')}>`]));
  });
  const result = await google({ texts: ['one', 'two'], fetchImpl });
  assert.deepEqual(result.translations, ['<one>', '<two>']);
  assert.equal(calls.length, 3);
});

test('google: an HTML rate-limit page is reported as a format error', async () => {
  const { fetchImpl } = fetchStub(() => response(200, '<html><title>Sorry...</title></html>'));
  await assert.rejects(() => google({ fetchImpl }), (error) => {
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
    (error) => {
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
  await assert.rejects(() => google({ fetchImpl }), (error) => {
    assert.equal(error.code, 'rate-limit');
    return true;
  });
  assert.equal(calls.length, AT.C.PROVIDER_RETRIES + 1);
});

test('a transport failure is reported as a network error', async () => {
  const { fetchImpl } = fetchStub(() => {
    throw new TypeError('Failed to fetch');
  });
  await assert.rejects(() => google({ fetchImpl }), (error) => {
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
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      })
  );
  try {
    await assert.rejects(() => google({ fetchImpl }), (error) => {
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
  assert.equal(calls[0].url, LIBRE);
  assert.equal(calls[0].init.method, 'POST');
  const body = JSON.parse(calls[0].init.body);
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
  const body = JSON.parse(calls[0].init.body);
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
    (error) => {
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
    (error) => {
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
  assert.deepEqual(JSON.parse(calls[0].init.body).q, ['hello']);
  assert.deepEqual(result.translations, ['안녕', '안녕', '   ', '', '안녕']);
});

test('oversized input is split into several requests in order', async () => {
  const { calls, fetchImpl } = fetchStub((url, init) => {
    const q = JSON.parse(init.body).q;
    return json(q.map((text) => ({ translatedText: text.toUpperCase() })));
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
    (error) => error.code === 'config'
  );
  await assert.rejects(
    () => engines.translate({ engine: 'google', target: 'klingon', texts: ['hello'], fetchImpl }),
    (error) => error.code === 'config'
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
    (error) => error.code === 'config'
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

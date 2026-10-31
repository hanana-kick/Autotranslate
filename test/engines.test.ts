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
  'lib/gemma.js',
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
  engines.translate({ target: 'ko', texts: ['hello'], localModelId: 'gemma-4b', ...overrides });

let sent: ATNamespace[] = [];

function stubSend(reply: (message: ATNamespace) => unknown, counts?: (message: ATNamespace) => unknown) {
  sent = [];
  AT.sendMessage = async (message: ATNamespace) => {
    sent.push(message);
    // The engine asks the host for real token counts before it packs; a stub
    // that answers everything as a translation would starve that path. The
    // default failure makes every test without explicit counts exercise the
    // character-estimate fallback.
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

test('local: the model is asked through the offscreen host, never fetched', async () => {
  stubSend(() => ({ ok: true, translations: ['안녕'] }));
  const result = await localModel();
  assert.deepEqual(result.translations, ['안녕']);
  assert.equal(result.requested, 1);
  assert.equal(translates().length, 1);
  const first = translates()[0] as ATNamespace;
  assert.equal(first.type, AT.C.MSG.LOCAL_TRANSLATE);
  assert.equal(first.to, AT.local.TARGET_OFFSCREEN);
  assert.equal(first.modelId, 'gemma-4b');
  assert.deepEqual(first.texts, ['hello']);
  assert.equal(first.source, '', 'no detector answer: the host is not told a source');
  assert.equal(first.target, 'ko');
  assert.equal(first.maxTokens, AT.local.DEFAULT_MAX_TOKENS);
  assert.equal(first.url, undefined, 'there is no endpoint to call');
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

test('local: the target is the model code, not the picker code', async () => {
  stubSend(() => ({ ok: true, translations: ['你好'] }));
  await localModel({ target: 'zh-CN', texts: ['hello'] });
  assert.equal((translates()[0] as ATNamespace).target, 'zh-Hans', 'Simplified Chinese is zh-Hans to this model');
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
  const korean = AT.gemma.LANGS.ko;
  delete AT.gemma.LANGS.ko;
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
    AT.gemma.LANGS.ko = korean;
  }
  assert.equal(translates().length, 0, 'no generation is attempted');
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

test('local: Korean packs by script-aware estimate, not by Latin characters', async () => {
  // The same character count is worth ~3.4x the tokens in Hangul (1.82
  // characters per token against 6.12 for Latin), so a batch that looks small
  // by length must still be split when the host cannot count.
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

test('local: texts with no letters or numbers are not sent', async () => {
  stubSend((message) => ({ ok: true, translations: message.texts.map((text: string) => `[${text}]`) }));
  const texts = ['', '   ', '!!!', '😀', 'a', '42'];
  const result = await localModel({ texts });
  assert.deepEqual(translates()[0]!.texts, ['42'], 'only a text the model can translate is asked about');
  assert.deepEqual(result.translations, ['', '   ', '!!!', '😀', 'a', '[42]']);
  assert.equal(result.requested, 1);
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
    [{ ok: false, code: 'network', error: 'the message channel died' }, 'network'],
    [{ ok: false, code: 'timeout', error: 'the generation ran too long' }, 'timeout'],
    [{ ok: false, code: 'rate-limit', error: 'too many generations' }, 'rate-limit'],
    [{ ok: false, code: 'provider', error: 'the model crashed' }, 'provider'],
    [{ ok: false, code: 'http', error: 'the download failed' }, 'http'],
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
  stubSend(() => ({ ok: true, translations: ['only one'] }));
  await assert.rejects(
    () => localModel({ texts: ['hello there', 'goodbye now'] }),
    (thrown) => {
      const error = engineError(thrown);
      return error.code === 'format' && error.reason === 'count' && error.expected === 2 && error.got === 1;
    }
  );
});

test('local: an empty answer remains incomplete for the DOM layer', async () => {
  stubSend(() => ({ ok: true, translations: ['', '안녕'] }));
  const result = await localModel({ texts: ['hello', 'goodbye'] });
  assert.deepEqual(result.translations, ['', '안녕']);
});

test('local: test() probes through the same host', async () => {
  stubSend(() => ({ ok: true, translations: ['확인'] }));
  const result = await engines.test({ target: 'ko', localModelId: 'gemma-4b' });
  assert.equal(result.output, '확인');
  assert.equal(result.detected, null);
  assert.ok(result.ms >= 0);
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

test('local: a host that cannot count falls back to character estimates', async () => {
  stubSend(
    (message) => ({ ok: true, translations: message.texts.map((text: string) => text.toUpperCase()) }),
    () => ({ ok: false, error: 'the tokenizer did not load' })
  );
  const warnings: unknown[][] = [];
  const originalWarn = AT.warn;
  AT.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    const result = await localModel({ texts: ['one', 'two'], localMaxTokens: 1024 });
    assert.deepEqual(result.translations, ['ONE', 'TWO']);
  } finally {
    AT.warn = originalWarn;
  }
  assert.equal(translates().length, 1, 'small texts still pack together');
  assert.deepEqual(translates()[0]!.texts, ['one', 'two']);
  assert.equal(warnings.length, 1, 'the fallback is announced, not silent');
  assert.match(String(warnings[0]![0]), /did not count tokens/);
});

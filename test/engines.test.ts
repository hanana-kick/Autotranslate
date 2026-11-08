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

// The model is a 1.1 GB artifact the suite cannot load, so the tests stand in
// for the host. `AT.local.callHost` is the only entry `AT.engines` has, and
// every assertion below is about the message it is handed and the use it makes
// of the reply. Nothing asks the host to count tokens first: the packer runs on
// `AT.local`'s own estimates, so one generation is the only round trip.
const realCallHost = AT.local.callHost;
const realSendMessage = AT.sendMessage;
// `background` means "this context is the host". Nothing here may fall back to
// a runtime message, so a stray `AT.sendMessage` is a bug, not a detour.
AT.local.setHostPlacement('background');

let calls: ATNamespace[] = [];
let channel: ATNamespace[] = [];

function stubHost(reply: (message: ATNamespace) => unknown) {
  calls = [];
  channel = [];
  AT.local.callHost = async (message: ATNamespace) => {
    calls.push(structuredClone(message));
    return reply(message);
  };
  AT.sendMessage = async (message: ATNamespace) => {
    channel.push(message);
    return { ok: false, code: null, error: 'the host is stubbed: nothing travels the channel' };
  };
}

// The only message kind the engine may hand the host. A payload with any other
// key (a token count, a source, a route) fails the key checks below.
const TRANSLATE_KEYS = ['context', 'maxTokens', 'modelId', 'target', 'texts', 'type'];

// Every test starts from a clean detector log and the published token priors:
// the packer reads the calibration a previous case may have measured.
test.beforeEach(() => {
  detector.calls.length = 0;
  detector.answer = null;
  AT.local.setCalibration(1);
});

after(() => {
  AT.local.callHost = realCallHost;
  AT.sendMessage = realSendMessage;
});

const localModel = (overrides: ATNamespace = {}) =>
  engines.translate({
    target: 'ko',
    texts: ['hello'],
    localModelId: AT.local.MODEL_SOURCES[0].id,
    ...overrides
  });

/** Add picker codes for one case: the picker is data, and a release that grows
 *  it must still land on a code the model was released with. A code the real
 *  catalogue already carries is left in place, so a case can never take away a
 *  target the next one expects. */
function withPickerCodes(codes: string[], body: () => Promise<void>): Promise<void> {
  const added = codes.filter((code) => !AT.C.LANG_CODES.has(code));
  for (const code of added) AT.C.LANG_CODES.add(code);
  return body().finally(() => {
    for (const code of added) AT.C.LANG_CODES.delete(code);
  });
}

/** The host's own failure envelope: `AT.localhost` maps its reason onto a code
 *  with `AT.local.codeForReason` and `callHost` wraps it. */
const refusal = (reason: string, explanation: string) => ({
  ok: false,
  code: AT.local.codeForReason(reason),
  error: explanation
});

test('local: the model is asked through the host, never fetched', async () => {
  stubHost(() => ({ ok: true, translations: ['안녕'] }));
  const result = await localModel();
  assert.equal(AT.local.hostPlacement(), 'background', 'this context stands in for the host');
  assert.deepEqual(result.translations, ['안녕']);
  assert.equal(result.requested, 1);
  assert.equal(calls.length, 1, 'one text is one generation');
  assert.deepEqual(calls[0], {
    type: AT.C.MSG.LOCAL_TRANSLATE,
    modelId: AT.local.MODEL_SOURCES[0].id,
    texts: ['hello'],
    target: 'ko',
    maxTokens: AT.local.DEFAULT_MAX_TOKENS,
    context: ''
  });
  assert.equal(AT.C.MSG.LOCAL_TRANSLATE, 'at/local-translate', 'the wire type the host dispatches on');
  assert.deepEqual(channel, [], 'there is no endpoint to call and no message to route');
});

test('local: the host is asked for generations only, never for a token count', async () => {
  stubHost((message) => ({ ok: true, translations: message.texts.map((text: string) => `[${text}]`) }));
  const texts = ['first sentence', 'second sentence', 'third sentence'];
  const result = await localModel({ texts, localMaxTokens: 512 });

  assert.equal(calls.length, 1, 'the packing is decided before the host is woken');
  for (const call of calls) {
    assert.deepEqual(
      Object.keys(call).sort(),
      TRANSLATE_KEYS,
      'the payload is exactly the generation contract: no count request hides in it'
    );
    assert.equal(call.type, AT.C.MSG.LOCAL_TRANSLATE);
  }
  assert.equal(AT.C.MSG.LOCAL_COUNT, undefined, 'the message table has no counting type left to send');
  assert.deepEqual(channel, [], 'the host has no tokenizer, so no hop asks it for one');
  assert.deepEqual(result.translations, ['[first sentence]', '[second sentence]', '[third sentence]']);
});

test('local: the source comes from the browser detector when the setting says auto', async () => {
  detector.answer = { isReliable: true, languages: [{ language: 'ja', percentage: 100 }] };
  stubHost(() => ({ ok: true, translations: ['おはよう', 'ありがとう'] }));
  const result = await localModel({ source: 'auto', texts: ['おはようございます', 'ありがとう'] });
  assert.deepEqual(detector.calls, ['おはようございます ありがとう'], 'the detector sees the batch once, not every text');
  assert.equal(result.detected, 'ja', 'a language the model can express is reported to the page');
  assert.equal(calls.length, 1, 'detection is not a second generation');
  assert.deepEqual(
    Object.keys(calls[0]!).sort(),
    TRANSLATE_KEYS,
    'the instruction names the target only: a wrong source claim would move the translation'
  );
});

test('local: a detector answer the picker does not offer is not reported as one', async () => {
  detector.answer = { isReliable: false, languages: [{ language: 'de-AT', percentage: 100 }] };
  stubHost(() => ({ ok: true, translations: ['Hallo'] }));
  const result = await localModel({ source: 'auto', texts: ['Guten Morgen'] });
  assert.equal(detector.calls.length, 1, 'the detector is still consulted once');
  assert.equal(result.detected, null, 'a code the target picker does not offer is not reported as one');
  assert.equal(calls.length, 1, 'and the text is translated regardless');
});

test('local: an undetectable source leaves the page with no answer instead of a guess', async () => {
  detector.answer = { isReliable: false, languages: [{ language: 'und', percentage: 100 }] };
  stubHost(() => ({ ok: true, translations: ['안녕'] }));
  const result = await localModel({ source: 'auto' });
  assert.equal(detector.calls.length, 1, 'the question was asked');
  assert.equal(result.detected, null, 'and nothing was invented for the answer');
  assert.deepEqual(calls[0]!.texts, ['hello']);
});

test('local: an explicit source skips the detector', async () => {
  stubHost(() => ({ ok: true, translations: ['안녕'] }));
  const result = await localModel({ source: 'ja' });
  assert.deepEqual(detector.calls, [], 'a chosen language is not second-guessed');
  assert.equal(result.detected, 'ja', 'an explicit source is reported as it stands');

  await localModel({ source: 'fi' });
  assert.deepEqual(detector.calls, [], 'still no detector call for a chosen language');
  assert.equal(calls.length, 2, 'a source outside the picker does not block the translation');
});

test('local: the region of the page joins the page context in one line', async () => {
  stubHost(() => ({ ok: true, translations: ['안녕'] }));
  const context = {
    kind: 'news', site: 'Example News', title: 'Headline', section: 'Politics',
    sections: [], language: 'en', summary: null, tags: [], entities: [], glossary: []
  };
  await localModel({ context, role: 'comment' });
  assert.equal(
    calls[0]!.context,
    'This is a news article in the Politics section from Example News. These are reader comments.',
    'the region decides register: a comment is not prose'
  );

  await localModel({ context, role: 'article' });
  assert.equal(
    calls[1]!.context,
    'This is a news article in the Politics section from Example News.',
    'article text adds no line of its own'
  );

  await localModel({ context: null, role: 'navigation' });
  assert.equal(calls[2]!.context, 'These are navigation labels.', 'a menu label is described even with no page');
});

test('local: the page context becomes one bounded line for the host', async () => {
  stubHost(() => ({ ok: true, translations: ['안녕'] }));
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
    calls[0]!.context,
    'This is a news article in the Politics section from Example News.',
    'the analyzer renders the line, the host only pastes it'
  );

  await localModel({ context: null, role: null });
  assert.equal(calls[1]!.context, '', 'nothing captured: the host is handed an empty line, not an invented one');
  assert.equal(AT.pagecontext.hint(null), null, 'the page really said nothing at all');

  await localModel({ context: { ...context, kind: 'unknown', site: 'example.com' } });
  assert.equal(calls[2]!.context, '', 'a host alone is not context');

  // Above the cap the policy is to drop the tail, not to grow the prompt.
  const wordy = { ...context, site: 'Example News '.repeat(30), kind: 'forum' };
  await localModel({ context: wordy, role: 'metadata' });
  const line = calls[3]!.context;
  const unbounded = `${AT.pagecontext.hint(wordy)} ${AT.targets.roleHint('metadata')}`;
  assert.ok(unbounded.length > AT.targets.CONTEXT_MAX_CHARS, 'the uncapped line really is too long');
  assert.ok(line.length <= AT.targets.CONTEXT_MAX_CHARS, 'the line the host sees stays inside the budget');
  assert.ok(unbounded.startsWith(line), 'the line is cut, never rewritten');
  assert.equal(unbounded[line.length], ' ', 'and the cut lands on a word boundary');
});

test('local: the host is handed the code the installed model was released with', async () => {
  stubHost(() => ({ ok: true, translations: ['こんにちは'] }));
  await localModel({ target: 'en' });
  assert.equal(calls[0]!.target, 'en', 'a code the model already spells is passed through');
  await localModel({ target: 'ja' });
  assert.equal(calls[1]!.target, 'ja', 'and so is every code the picker offers');

  // The Chinese codes were picker entries once. Nothing offers them now, so
  // they are refused as targets before any card is asked to spell them; the
  // fold itself is pinned where the model table lives, in `plamo3.test.ts`.
  for (const target of ['zh-CN', 'zh-TW']) {
    await assert.rejects(
      () => localModel({ target }),
      (thrown: unknown) => {
        const error = engineError(thrown);
        return error.code === 'config' && /unsupported target language/.test(error.message);
      },
      `${target} is no longer a target anyone can pick`
    );
  }
  assert.equal(calls.length, 2, 'no prompt is built for a code the picker does not offer');
});

test('local: a picker code the model spells differently is folded before the host sees it', async () => {
  // `zh_CN` is what a settings store may hold and `zh-TW` what a browser
  // reports; the fold inside `AT.plamo3.langFor` decides the spelling the model
  // reads, underscores included, because `check_lang` admits no capital.
  stubHost(() => ({ ok: true, translations: ['你好'] }));
  await withPickerCodes(['zh-CN', 'zh_CN', 'zh-TW'], async () => {
    await localModel({ target: 'zh-CN' });
    assert.equal(calls[0]!.target, 'zh-hans', 'simplified Chinese is spelled in lower case');
    await localModel({ target: 'zh_CN' });
    assert.equal(calls[1]!.target, 'zh-hans', 'an underscore does not hide the variant');
    await localModel({ target: 'zh-TW' });
    assert.equal(calls[2]!.target, 'zh-hant', 'and a Taiwan reader gets the traditional one');
  });
  assert.equal(calls.length, 3, 'every fold is answered through the same host entry');

  // A language the model was not released with is refused rather than quietly
  // answered in the spelling nearest to it.
  await withPickerCodes(['fil'], async () => {
    await assert.rejects(
      () => localModel({ target: 'fil' }),
      (thrown: unknown) => {
        const error = engineError(thrown);
        return error.code === 'config' && error.detail === 'no-target';
      }
    );
  });
  assert.equal(calls.length, 3, 'no prompt is built for a spelling the model never saw');
});

test('local: a picker code the model cannot express fails as no-target', async () => {
  stubHost(() => ({ ok: true, translations: [''] }));
  // Swahili is a picker entry a release could gain and this model was not
  // released with; the model table, not the picker, is what refuses it.
  await withPickerCodes(['sw'], async () => {
    await assert.rejects(
      () => localModel({ target: 'sw' }),
      (thrown: unknown) => {
        const error = engineError(thrown);
        return error.code === 'config' && error.detail === 'no-target' && /sw/.test(error.message);
      }
    );
  });
  assert.equal(calls.length, 0, 'no generation is attempted for a language no prompt can name');
});

test('local: a target outside the picker is refused before the host is woken', async () => {
  stubHost(() => ({ ok: true, translations: [''] }));
  await assert.rejects(
    () => localModel({ target: 'xx-YY' }),
    (thrown: unknown) => {
      const error = engineError(thrown);
      return error.code === 'config';
    },
    'a target the extension does not offer is refused'
  );
  assert.deepEqual(calls, [], 'the host is never woken for it');
  assert.deepEqual(channel, [], 'and nothing is routed around the host entry');
});

test('local: no model selected fails without waking the host', async () => {
  stubHost(() => ({ ok: true, translations: [''] }));
  await assert.rejects(
    () => localModel({ localModelId: '' }),
    (thrown) => {
      const error = engineError(thrown);
      return error.code === 'config' && error.detail === 'no-model';
    }
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(channel, [], 'the model list is checked before the host is asked');
});

test('local: a token budget splits the work and the answers stay in order', async () => {
  // 900 Latin characters are 169 tokens at this model's published Latin prior,
  // and each text pays for its answer as well plus a row of its own: two fit
  // in 1024 with the frame, three do not. No hop asks the host to count.
  const texts = Array.from({ length: 5 }, (_unused, index) => `s${index} ${'x'.repeat(897)}`);
  stubHost((message) => ({ ok: true, translations: message.texts.map((text: string) => `[${text.slice(0, 2)}]`) }));
  const result = await localModel({ texts, localMaxTokens: 1024 });

  assert.deepEqual(
    calls.map((call) => call.texts),
    [
      [texts[0], texts[1]],
      [texts[2], texts[3]],
      [texts[4]]
    ],
    'one generation per chunk, each inside the budget, in the caller order'
  );
  assert.deepEqual(result.translations, texts.map((text) => `[${text.slice(0, 2)}]`));
  assert.equal(result.requested, 5, 'every text was asked about exactly once');
});

test('local: a repeated text is asked once and answered for every position', async () => {
  // t0 returns at the end: the host must not see it twice, and the answer it
  // gets must land in both places.
  const texts = Array.from({ length: 5 }, (_unused, index) => `s${index} ${'x'.repeat(897)}`);
  const batch = [texts[0], texts[1], texts[2], texts[3], texts[4], texts[0]];
  stubHost((message) => ({ ok: true, translations: message.texts.map((text: string) => `[${text.slice(0, 2)}]`) }));
  const result = await localModel({ texts: batch, localMaxTokens: 1024 });

  const asked = calls.flatMap((call) => call.texts);
  assert.equal(asked.length, new Set(asked).size, 'a text is never sent to the model twice');
  assert.deepEqual(asked, texts, 'the unique texts reach the host in the caller order');
  assert.deepEqual(
    calls.map((call) => call.texts.length),
    [2, 2, 1],
    'the budget packs the unique texts, not the repeated ones'
  );
  assert.deepEqual(
    result.translations,
    ['[s0]', '[s1]', '[s2]', '[s3]', '[s4]', '[s0]'],
    'the shared answer is written back to both positions'
  );
  assert.equal(result.requested, 5, 'requested counts what was asked, not what came back');
});

test('local: Korean packs by script-aware estimate, not by Latin characters', async () => {
  // Hangul costs about five times what Latin costs on this tokenizer at the
  // same character count, so a batch that looks small by length must still be
  // split: the Latin lookalike fits in one generation, the Korean does not.
  const sentence = '인공지능 번역 모델은 문장의 의미와 뉘앙스를 정확하게 전달해야 하며, 원문의 문체와 문화적 맥락을 함께 고려해야 합니다. ';
  const korean = Array.from({ length: 4 }, (_unused, index) => `${index}번째 ` + sentence.repeat(4));
  const latin = korean.map((text, index) => 'x'.repeat(text.length - 1) + String(index));
  stubHost((message) => ({ ok: true, translations: message.texts.map(() => '번역') }));

  const result = await localModel({ texts: korean, localMaxTokens: 1024, source: 'ko' });
  assert.deepEqual(
    calls.map((call) => call.texts.length),
    [2, 2],
    'the Latin-sized batch would have overflowed the context'
  );
  assert.deepEqual(calls.map((call) => call.texts).flat(), korean, 'no text is dropped');
  assert.equal(result.requested, 4);

  stubHost((message) => ({ ok: true, translations: message.texts.map(() => 'translated') }));
  await localModel({ texts: latin, localMaxTokens: 1024 });
  assert.deepEqual(
    calls.map((call) => call.texts.length),
    [4],
    'the same character count in Latin is one generation: the estimate is script-aware'
  );
});

test('local: a language the model was not released with fails as no-target', async () => {
  // Portuguese is outside the five codes `AT.plamo3` lists, so this is the
  // model refusing rather than the catalogue: the picker no longer lists it, so
  // the case puts it back on the list for the length of the call and the
  // refusal still happens, at the fold, before a prompt is built.
  await withPickerCodes(['pt'], async () => {
    stubHost(() => ({ ok: true, translations: ['olá'] }));
    await assert.rejects(
      () => localModel({ target: 'pt' }),
      (thrown: unknown) => {
        const error = engineError(thrown);
        return error.code === 'config' && error.detail === 'no-target' && /pt/.test(error.message);
      }
    );
    assert.deepEqual(calls, [], 'no generation is spent on a language the model has no code for');
  });
});

test('local: calibration tightens the packing without asking the host to count', async () => {
  // Every generation reports its real prompt cost (`AT.local.setCalibration`),
  // so the estimates track the model that is loaded. The same batch at the same
  // budget is packed twice: once on the published priors, once on a measured
  // ratio that says the text is far dearer than they claimed.
  const sentence = '인공지능 번역 모델은 문장의 의미와 뉘앙스를 정확하게 전달해야 하며, 원문의 문체와 문화적 맥락을 함께 고려해야 합니다. ';
  const texts = Array.from({ length: 4 }, (_unused, index) => `${index}번째 ` + sentence.repeat(4));
  const answer = (message: ATNamespace) => ({ ok: true, translations: message.texts.map(() => '번역') });

  stubHost(answer);
  await localModel({ texts, localMaxTokens: 1024, source: 'ko' });
  assert.equal(calls.length, 2, 'the published priors split the batch in two');

  AT.local.setCalibration(2.5);
  assert.equal(AT.local.calibrationValue(), 2.5, 'the measured ratio is in effect');
  stubHost(answer);
  await localModel({ texts, localMaxTokens: 1024, source: 'ko' });
  assert.equal(calls.length, 4, 'a dearer model gets a smaller chunk per generation');
  assert.deepEqual(calls.map((call) => call.texts.length), [1, 1, 1, 1], 'down to one text per generation');

  AT.local.setCalibration(Number.NaN);
  assert.equal(AT.local.calibrationValue(), 1, 'a nonsense measurement cannot break the packing');
  stubHost(answer);
  await localModel({ texts, localMaxTokens: 1024, source: 'ko' });
  assert.equal(calls.length, 2, 'and the packing falls back to the published priors');
});

test('local: one detection serves every chunk of the request', async () => {
  // The detector is a browser call and its answer never enters the prompt, so
  // it cannot differ per chunk: three chunks still means one question.
  detector.answer = { isReliable: true, languages: [{ language: 'ja', percentage: 100 }] };
  const texts = ['a' + 'x'.repeat(299), 'b' + 'y'.repeat(299), 'c' + 'z'.repeat(299)];
  stubHost((message) => ({ ok: true, translations: message.texts.map((text: string) => `[${text.slice(0, 1)}]`) }));
  const result = await localModel({ texts, localMaxTokens: 64, source: 'auto' });
  assert.equal(calls.length, 3, 'each chunk is its own generation');
  assert.equal(detector.calls.length, 1, 'the language was asked once for the whole request');
  assert.equal(result.detected, 'ja', 'and that one answer is what the page is told');
  assert.deepEqual(result.translations, ['[a]', '[b]', '[c]'], 'the answers return in the caller order');
});

test('local: a budget below the floor packs at the floor and is forwarded as asked', async () => {
  // The packer never uses a budget smaller than one generation needs, and the
  // number the host is given is the one the host clamps for the context window.
  const texts = ['a' + 'x'.repeat(299), 'b' + 'x'.repeat(299)];
  stubHost((message) => ({ ok: true, translations: message.texts.map((text: string) => text.slice(0, 4)) }));
  const result = await localModel({ texts, localMaxTokens: 64 });

  assert.equal(AT.local.clampTokens(64), AT.local.MIN_MAX_TOKENS, 'the budget is floored for packing');
  assert.deepEqual(
    calls.map((call) => call.texts),
    [[texts[0]], [texts[1]]],
    'each text pays for its answer, so neither fits beside the other at the floor'
  );
  assert.equal(calls[0]!.maxTokens, 64, 'the engine forwards the caller budget untouched');
  assert.equal(AT.local.contextTokens(64), AT.local.MIN_CONTEXT_TOKENS, 'the host raises the window to what a run needs');
  assert.ok(
    AT.local.outputTokens(64, 'y'.repeat(20000)) >= AT.local.MIN_OUTPUT_TOKENS,
    'and never promises the model less than that for the answer'
  );
  assert.deepEqual(result.translations, ['axxx', 'bxxx']);

  // The floor is a floor, not "one text per generation": short texts still
  // share a prompt at the same budget.
  stubHost((message) => ({ ok: true, translations: message.texts.map((text: string) => text.toUpperCase()) }));
  const short = await localModel({ texts: ['alpha phrase', 'beta phrase'], localMaxTokens: 64 });
  assert.equal(calls.length, 1, 'both fit in the floored budget');
  assert.deepEqual(short.translations, ['ALPHA PHRASE', 'BETA PHRASE']);
});

test('local: texts with no letters or numbers are not sent', async () => {
  stubHost((message) => ({ ok: true, translations: message.texts.map((text: string) => `[${text}]`) }));
  const texts = ['', '   ', '!!!', '😀', 'a', '42'];
  const result = await localModel({ texts });
  assert.deepEqual(calls[0]!.texts, ['42'], 'only a text the model can translate is asked about');
  assert.deepEqual(result.translations, ['', '   ', '!!!', '😀', 'a', '[42]'], 'the rest is kept as it stands');
  assert.equal(result.requested, 1);
});

test('local: the host reason decides who is at fault', async () => {
  // What the host can complain about, and who has to fix it: a broken
  // installation is the user's (`config`), a run out of its budget is the text
  // (`timeout`), anything the model did is nobody's fault to configure (`provider`).
  const expected: Record<string, string> = {
    'no-webgpu': 'config',
    'no-target': 'config',
    'runtime-load-failed': 'config',
    'no-model': 'config',
    'model-missing': 'config',
    'model-load-failed': 'provider',
    'generation-failed': 'provider',
    'generation-timeout': 'timeout'
  };
  assert.deepEqual(
    Object.keys(AT.local.REASONS).sort(),
    Object.keys(expected).sort(),
    'the table the engine maps is the table the host can report'
  );
  for (const reason of Object.keys(AT.local.REASONS)) {
    stubHost(() => refusal(reason, `the host said no: ${reason}`));
    await assert.rejects(
      () => localModel(),
      (thrown: unknown) => {
        const error = engineError(thrown);
        return (
          error.code === expected[reason] &&
          error.message === `the host said no: ${reason}` &&
          error.detail === `the host said no: ${reason}`
        );
      },
      reason
    );
    assert.equal(calls.length, 1, `${reason}: a repeat would spend another minute on the same model`);
  }
});

test('local: a host code the table never produced is blamed on the model, not the installation', async () => {
  // The host only ever answers with one of `codeForReason`'s three codes; what
  // arrives otherwise is a runtime failure, never something the user configured.
  const cases: [() => unknown, string][] = [
    [() => ({ ok: false, code: 'made-up', error: 'the wasm died' }), 'provider'],
    [() => ({ ok: false, error: 'no code at all' }), 'provider'],
    [() => ({}), 'provider'],
    [() => undefined, 'provider'],
    [() => ({ ok: false, code: 'config' }), 'config'],
    [() => ({ ok: false, code: 'timeout' }), 'timeout'],
    [() => ({ ok: false, code: 'provider' }), 'provider']
  ];
  for (const [reply, code] of cases) {
    const value = reply();
    stubHost(() => value);
    await assert.rejects(
      () => localModel(),
      (thrown: unknown) => engineError(thrown).code === code,
      JSON.stringify(value)
    );
    assert.equal(calls.length, 1, `${JSON.stringify(value)}: one generation is the whole exchange`);
  }
});

test('local: a dead channel is reported as the host not answering', async () => {
  stubHost(() => undefined);
  await assert.rejects(
    () => localModel(),
    (thrown: unknown) => {
      const error = engineError(thrown);
      return error.code === 'provider' && error.message === 'the on-device host did not answer';
    }
  );
  assert.deepEqual(channel, [], 'the engine never routes around callHost');
});

test('local: a long explanation is folded into one line for the page', async () => {
  const explanation = '  model load failed:\n' + 'wasm\n'.repeat(60);
  stubHost(() => refusal('model-load-failed', explanation));
  await assert.rejects(
    () => localModel(),
    (thrown: unknown) => {
      const error = engineError(thrown);
      return (
        error.code === 'provider' &&
        error.detail.length <= 180 &&
        !/\s\s/.test(error.detail) &&
        error.detail.startsWith('model load failed: wasm')
      );
    }
  );
});

test('local: a reply that does not match the request is refused', async () => {
  stubHost(() => ({ ok: true, translations: ['only one'] }));
  await assert.rejects(
    () => localModel({ texts: ['hello there', 'goodbye now'] }),
    (thrown: unknown) => {
      const error = engineError(thrown);
      return error.code === 'format' && error.reason === 'count' && error.expected === 2 && error.got === 1;
    }
  );
  assert.equal(calls.length, 1, 'a wrong shape is not answered with a second generation');

  stubHost(() => ({ ok: true, translations: '안녕' }));
  await assert.rejects(
    () => localModel(),
    (thrown: unknown) => {
      const error = engineError(thrown);
      return error.code === 'format' && error.reason === 'count' && error.expected === 1 && error.got === 0;
    },
    'an answer that is not a list at all is the same refusal'
  );
});

test('local: an answer that is not text arrives as no answer', async () => {
  stubHost(() => ({ ok: true, translations: [null, '안녕'] }));
  const result = await localModel({ texts: ['hello', 'goodbye'] });
  assert.deepEqual(result.translations, ['', '안녕'], 'a blank is the signal to ask again');
});

test('local: an empty answer is not painted over with the page text', async () => {
  stubHost(() => ({ ok: true, translations: ['', '안녕'] }));
  const result = await localModel({ texts: ['hello', 'goodbye'] });
  assert.deepEqual(
    result.translations,
    ['', '안녕'],
    'a source substituted here would be recorded as a translation and never retried'
  );
});

test('local: one failing chunk stops the batch without a retry', async () => {
  const texts = Array.from({ length: 5 }, (_unused, index) => `s${index} ${'x'.repeat(897)}`);
  let asked = 0;
  stubHost(() => {
    asked += 1;
    return asked === 1 ? refusal('generation-failed', 'the model stopped answering') : { ok: true, translations: ['x'] };
  });
  await assert.rejects(
    () => localModel({ texts, localMaxTokens: 1024 }),
    (thrown: unknown) => engineError(thrown).code === 'provider'
  );
  assert.equal(calls.length, 1, 'neither the failed chunk nor the next one is asked again');
});

test('local: test() probes through the same host', async () => {
  stubHost(() => ({ ok: true, translations: ['확인'] }));
  const result = await engines.test({ target: 'ko', localModelId: AT.local.MODEL_SOURCES[0].id });
  assert.equal(result.output, '확인');
  assert.equal(result.detected, null);
  assert.ok(result.ms >= 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.texts.length, 1);
  assert.deepEqual(Object.keys(calls[0]!).sort(), TRANSLATE_KEYS);
});

test('local: the background placement reaches the host in this context, over no channel', async () => {
  // The real `callHost` with the host living in this very context, which is how
  // a Firefox background page runs: the envelope the engine reads (`ok`,
  // `code`, `error`) is built by local.js, not by a stub.
  const realHandle = AT.localhost;
  let handled: ATNamespace[] = [];
  let rejection: { code: string; message: string } | null = null;
  AT.localhost = {
    handle: async (message: ATNamespace) => {
      handled.push(structuredClone(message));
      if (rejection) throw rejection;
      return { translations: message.texts.map(() => '안녕') };
    }
  };
  AT.local.callHost = realCallHost;
  channel = [];
  try {
    const result = await localModel({ texts: ['hello', 'hello'] });
    assert.deepEqual(result.translations, ['안녕', '안녕'], 'one answer fills both positions');
    assert.deepEqual(
      handled.map((message) => message.type),
      [AT.C.MSG.LOCAL_TRANSLATE],
      'one generation, and no counting hop in front of it'
    );
    assert.deepEqual(Object.keys(handled[0]!).sort(), TRANSLATE_KEYS);
    assert.equal(handled[0]!.target, 'ko');

    handled = [];
    rejection = { code: AT.local.codeForReason('model-missing'), message: 'no stored file for that model' };
    await assert.rejects(
      () => localModel(),
      (thrown: unknown) => {
        const error = engineError(thrown);
        return error.code === 'config' && error.message === 'no stored file for that model';
      },
      'a host rejection arrives as the same envelope'
    );
    assert.equal(handled.length, 1, 'and it is not asked twice');
    assert.deepEqual(channel, [], 'nothing went over the message channel to find out');
  } finally {
    if (realHandle === undefined) delete AT.localhost;
    else AT.localhost = realHandle;
  }
});

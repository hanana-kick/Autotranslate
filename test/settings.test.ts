import test from 'node:test';
import assert from 'node:assert/strict';
import { load, type ATNamespace } from './helpers.ts';

const AT = load('lib/constants.js', 'lib/rules.js', 'lib/local.js', 'lib/settings.js');
const { settings } = AT;

test('defaults are a complete, normalised object', () => {
  const base = settings.normalize(undefined);
  assert.equal(base.version, 1);
  assert.equal(base.enabled, false, 'nothing translates until onboarding turns it on');
  assert.equal(base.targetLang, 'en');
  assert.equal(base.sourceLang, 'auto');
  assert.equal(base.localModelId, '', 'nothing is downloaded out of the box');
  assert.equal(base.localMaxTokens, AT.local.DEFAULT_MAX_TOKENS, 'the budget starts at the shared default');
  assert.equal(base.maxNodes, AT.C.DEFAULT_MAX_NODES);
  assert.deepEqual(base.siteRules, []);
  // The whole stored blob: an extra field here would be persisted forever.
  assert.deepEqual(Object.keys(base).sort(), [
    'debug',
    'enabled',
    'localMaxTokens',
    'localModelId',
    'maxNodes',
    'showBadge',
    'siteRules',
    'sourceLang',
    'targetLang',
    'version'
  ]);
});

test('junk values fall back instead of throwing', () => {
  const coerced = settings.normalize({
    enabled: false,
    autoDetect: false,
    targetLang: 'klingon',
    sourceLang: 'ko',
    maxNodes: -5,
    showBadge: false,
    debug: 'yes',
    unknownKey: 'dropped',
    // A blob from a version that still had providers: every one of these keys
    // must be dropped rather than resurrected.
    engine: 'google',
    endpoints: { google: 'https://translate.googleapis.com/translate_a/single' },
    apiKey: '  secret  ',
    batchChars: '99999',
    fallbackEngine: 'google',
    localModelId: 42,
    localMaxTokens: 'nonsense'
  });
  assert.equal(coerced.enabled, false);
  assert.equal(coerced.targetLang, 'en');
  assert.equal(coerced.sourceLang, 'ko');
  assert.equal(coerced.maxNodes, 10);
  assert.equal(coerced.showBadge, false);
  assert.equal(coerced.debug, false);
  assert.equal(coerced.localModelId, '', 'a model id must be a string to be stored');
  assert.equal(coerced.localMaxTokens, AT.local.DEFAULT_MAX_TOKENS, 'an unparseable budget falls back');
  for (const gone of ['engine', 'endpoints', 'apiKey', 'batchChars', 'fallbackEngine', 'autoDetect', 'unknownKey']) {
    assert.equal(gone in coerced, false, `${gone} is not a setting any more`);
  }
});

test('the on-device fields are clamped', () => {
  const picked = settings.normalize({
    localModelId: '  translategemma-4b-it-int8-web  ',
    localMaxTokens: '4096'
  });
  assert.equal(picked.localModelId, 'translategemma-4b-it-int8-web', 'the id is trimmed before it is stored');
  assert.equal(picked.localMaxTokens, 4096, 'a string budget from the form still counts');

  // The budget sizes one generation, so it stays inside the range the host can
  // serve; anything unparseable lands on the default rather than on 0.
  assert.equal(settings.normalize({ localMaxTokens: 1 }).localMaxTokens, AT.local.MIN_MAX_TOKENS);
  assert.equal(settings.normalize({ localMaxTokens: -5 }).localMaxTokens, AT.local.MIN_MAX_TOKENS);
  assert.equal(settings.normalize({ localMaxTokens: 99999 }).localMaxTokens, AT.local.MAX_MAX_TOKENS);
  assert.equal(settings.normalize({ localMaxTokens: null }).localMaxTokens, AT.local.DEFAULT_MAX_TOKENS);
  assert.equal(settings.normalize({ localModelId: 'x'.repeat(200) }).localModelId, 'x'.repeat(96));
});

test('site rules are canonicalised and deduplicated', () => {
  const saved = settings.normalize({
    siteRules: [
      { pattern: '*.Example.com', action: 'always' },
      { pattern: 'example.com', action: 'never' },
      { pattern: 'news.example.com/top', action: 'never' },
      { pattern: 'not a host', action: 'always' },
      { pattern: 'ok.example', action: 'sometimes' }
    ]
  });
  assert.deepEqual(saved.siteRules, [
    { pattern: 'example.com', action: 'always' },
    { pattern: 'news.example.com/top', action: 'never' }
  ]);
});

test('the content snapshot carries only what a page needs', () => {
  const snapshot = settings.contentSnapshot(settings.normalize({ maxNodes: 400 }));
  assert.deepEqual(Object.keys(snapshot).sort(), [
    'enabled',
    'maxNodes',
    'showBadge',
    'sourceLang',
    'targetLang',
    'translationKey'
  ]);
  assert.equal(snapshot.maxNodes, 400);
});

test('the UI language picks a supported target', () => {
  const cases = [
    ['ko-KR', 'ko'],
    ['pt-BR', 'pt'],
    ['zh-TW', 'zh-TW'],
    ['zh-HK', 'zh-TW'],
    ['zh-CN', 'zh-CN'],
    ['en-GB', 'en'],
  ];
  for (const [ui, expected] of cases) {
    AT.api = { i18n: { getUILanguage: () => ui } };
    assert.equal(settings.uiLang(), expected, `UI language ${ui}`);
  }
  delete AT.api;
  assert.equal(settings.uiLang(), 'en');
});

test('storage round-trips through normalisation', async () => {
  const store: ATNamespace = {};
  AT.storage = {
    local: {
      get: async (key: string) => ({ [key]: structuredClone(store[key]) }),
      set: async (value: ATNamespace) => Object.assign(store, structuredClone(value))
    }
  };

  assert.deepEqual(await settings.load(), settings.normalize(undefined));

  const saved = await settings.save({ targetLang: 'ko' });
  assert.equal(saved.targetLang, 'ko');
  assert.equal(store.settings.targetLang, 'ko');
  const reloaded = await settings.load();
  assert.equal(reloaded.targetLang, 'ko');

  // Hand-edited garbage in storage is normalised on read.
  store.settings = { targetLang: 42, siteRules: 'nope', maxNodes: '700' };
  const repaired = await settings.load();
  assert.equal(repaired.targetLang, 'en');
  assert.deepEqual(repaired.siteRules, []);
  assert.equal(repaired.maxNodes, 700);

  // The on-device choices are stored like any other setting.
  const local = await settings.save({ localModelId: 'model-a', localMaxTokens: 2048 });
  assert.equal(local.localModelId, 'model-a');
  assert.equal(store.settings.localModelId, 'model-a', 'the selected model is persisted');
  assert.equal(store.settings.localMaxTokens, 2048, 'the token budget is persisted');
  assert.equal((await settings.load()).localModelId, 'model-a');

  // A patch with one unusable value keeps what the user already had; the rest of
  // the patch still lands. (The stored target is 'en' here: the garbage above was
  // repaired on read.)
  const patched = await settings.save({ targetLang: 'klingon', maxNodes: 900 });
  assert.equal(patched.targetLang, 'en', 'an unusable patch value does not reset the choice');
  assert.equal(patched.maxNodes, 900);

  const reset = await settings.reset();
  assert.equal(store.settings.targetLang, 'en');
  assert.equal(reset.localModelId, '', 'a reset stops pointing at a model the user may have deleted');
});

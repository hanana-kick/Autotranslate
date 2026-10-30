import test from 'node:test';
import assert from 'node:assert/strict';
import { load, type ATNamespace } from './helpers.ts';

const AT = load('lib/constants.js', 'lib/rules.js', 'lib/local.js', 'lib/settings.js');
const { settings } = AT;

test('defaults are a complete, normalised object', () => {
  const base = settings.normalize(undefined);
  assert.equal(base.version, 1);
  assert.equal(base.enabled, true);
  assert.equal(base.autoDetect, true);
  assert.equal(base.targetLang, 'en');
  assert.equal(base.sourceLang, 'auto');
  assert.equal(base.engine, 'local', 'a fresh install translates on-device, not through a provider');
  assert.equal(base.apiKey, '');
  assert.equal(base.localModelId, '', 'nothing is downloaded out of the box');
  assert.equal(base.localMaxTokens, AT.local.DEFAULT_MAX_TOKENS, 'the budget starts at the shared default');
  assert.equal(base.fallbackEngine, '', 'offline stays offline: no provider without an explicit opt-in');
  assert.equal(base.batchChars, AT.C.DEFAULT_BATCH_CHARS);
  assert.equal(base.maxNodes, AT.C.DEFAULT_MAX_NODES);
  assert.deepEqual(base.siteRules, []);
  assert.deepEqual(Object.keys(base.endpoints).sort(), ['google', 'libretranslate', 'local']);
  assert.equal(base.endpoints.local, '', 'the on-device engine has no endpoint to store');
  assert.equal(base.endpoints.google, 'https://translate.googleapis.com/translate_a/single');
  // The whole stored blob: an extra field here would be persisted forever.
  assert.deepEqual(Object.keys(base).sort(), [
    'apiKey',
    'autoDetect',
    'batchChars',
    'debug',
    'enabled',
    'endpoints',
    'engine',
    'fallbackEngine',
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
    engine: 'nope',
    apiKey: '  secret  ',
    batchChars: '99999',
    maxNodes: -5,
    showBadge: false,
    debug: 'yes',
    unknownKey: 'dropped',
    endpoints: { google: 'not a url', libretranslate: 'https://lt.example/translate' },
    localModelId: 42,
    localMaxTokens: 'nonsense',
    fallbackEngine: 'local'
  });
  assert.equal(coerced.enabled, false);
  assert.equal(coerced.autoDetect, false);
  assert.equal(coerced.targetLang, 'en');
  assert.equal(coerced.sourceLang, 'ko');
  assert.equal(coerced.engine, 'local', 'an unknown id falls back to the default engine');
  assert.equal(coerced.apiKey, 'secret');
  assert.equal(coerced.batchChars, 8000);
  assert.equal(coerced.maxNodes, 10);
  assert.equal(coerced.showBadge, false);
  assert.equal(coerced.debug, false);
  assert.equal('unknownKey' in coerced, false);
  assert.equal(coerced.endpoints.google, 'https://translate.googleapis.com/translate_a/single');
  assert.equal(coerced.endpoints.libretranslate, 'https://lt.example/translate');
  assert.equal(coerced.localModelId, '', 'a model id must be a string to be stored');
  assert.equal(coerced.localMaxTokens, AT.local.DEFAULT_MAX_TOKENS, 'an unparseable budget falls back');
  assert.equal(coerced.fallbackEngine, '', 'the on-device engine is never a fallback');
});

test('endpoints must be https, except localhost', () => {
  assert.equal(settings.isValidEndpoint('https://lt.example/translate'), 'https://lt.example/translate');
  assert.equal(settings.isValidEndpoint('http://127.0.0.1:5000/translate'), 'http://127.0.0.1:5000/translate');
  assert.equal(settings.isValidEndpoint('http://localhost:5000/translate'), 'http://localhost:5000/translate');
  assert.equal(settings.isValidEndpoint('http://lt.example/translate'), null);
  assert.equal(settings.isValidEndpoint('javascript:alert(1)'), null);
  assert.equal(settings.isValidEndpoint('not a url'), null);
  assert.equal(settings.isValidEndpoint(undefined), null);

  const saved = settings.normalize({
    endpoints: { libretranslate: 'http://lt.example/translate', google: 'https://custom.example/translate' }
  });
  assert.equal(saved.endpoints.google, 'https://custom.example/translate');
  assert.equal(
    saved.endpoints.libretranslate,
    AT.C.getEngineMeta('libretranslate').endpoint,
    'an rejected endpoint falls back to the catalogue default'
  );
});

test('the on-device fields are clamped and a local fallback is refused', () => {
  const picked = settings.normalize({
    engine: 'local',
    localModelId: '  translategemma-4b-it-int8-web  ',
    localMaxTokens: '4096',
    fallbackEngine: 'libretranslate'
  });
  assert.equal(picked.engine, 'local', 'the on-device engine is a selectable engine');
  assert.equal(picked.localModelId, 'translategemma-4b-it-int8-web', 'the id is trimmed before it is stored');
  assert.equal(picked.localMaxTokens, 4096, 'a string budget from the form still counts');
  assert.equal(picked.fallbackEngine, 'libretranslate', 'an explicit remote fallback is kept');

  // The budget sizes one generation, so it stays inside the range the host can
  // serve; anything unparseable lands on the default rather than on 0.
  assert.equal(settings.normalize({ localMaxTokens: 1 }).localMaxTokens, AT.local.MIN_MAX_TOKENS);
  assert.equal(settings.normalize({ localMaxTokens: -5 }).localMaxTokens, AT.local.MIN_MAX_TOKENS);
  assert.equal(settings.normalize({ localMaxTokens: 99999 }).localMaxTokens, AT.local.MAX_MAX_TOKENS);
  assert.equal(settings.normalize({ localMaxTokens: null }).localMaxTokens, AT.local.DEFAULT_MAX_TOKENS);
  assert.equal(settings.normalize({ localModelId: 'x'.repeat(200) }).localModelId, 'x'.repeat(96));

  // 'local' as a fallback would re-enter the engine that just failed, and an
  // unknown id would bury the failure the user has to see.
  for (const junk of ['local', 'LOCAL', 'nope', ' google', 42, null, undefined, {}]) {
    assert.equal(settings.normalize({ fallbackEngine: junk }).fallbackEngine, '', `${String(junk)} is not a fallback`);
  }
  assert.equal(settings.normalize({ fallbackEngine: '' }).fallbackEngine, '', 'the opt-out is preserved');
  assert.equal(settings.normalize({ fallbackEngine: 'google' }).fallbackEngine, 'google');
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

test('the content snapshot hides provider credentials and clamps the batch', () => {
  const google = settings.normalize({ engine: 'google', batchChars: 8000, apiKey: 'secret' });
  const snapshot = settings.contentSnapshot(google);
  assert.equal('endpoints' in snapshot, false);
  assert.equal('apiKey' in snapshot, false);
  assert.equal(snapshot.batchChars, AT.C.getEngineMeta('google').maxChars);

  const libre = settings.normalize({ engine: 'libretranslate', batchChars: 8000 });
  assert.equal(settings.contentSnapshot(libre).batchChars, AT.C.getEngineMeta('libretranslate').maxChars);
  assert.deepEqual(Object.keys(settings.contentSnapshot(google)).sort(), [
    'autoDetect',
    'batchChars',
    'enabled',
    'engine',
    'maxNodes',
    'showBadge',
    'sourceLang',
    'targetLang'
  ]);
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

  const saved = await settings.save({ targetLang: 'ko', engine: 'libretranslate' });
  assert.equal(saved.targetLang, 'ko');
  assert.equal(saved.engine, 'libretranslate');
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
  const local = await settings.save({
    engine: 'local',
    localModelId: 'model-a',
    localMaxTokens: 2048,
    fallbackEngine: 'google'
  });
  assert.equal(local.engine, 'local', 'the on-device engine survives a save');
  assert.equal(store.settings.localModelId, 'model-a', 'the selected model is persisted');
  assert.equal(store.settings.localMaxTokens, 2048, 'the token budget is persisted');
  assert.equal(store.settings.fallbackEngine, 'google', 'the opted-in fallback is persisted');
  assert.equal((await settings.load()).localModelId, 'model-a');

  const reset = await settings.reset();
  assert.equal(reset.engine, 'local', 'a reset goes back to the on-device engine');
  assert.equal(store.settings.engine, 'local');
  assert.equal(reset.localModelId, '', 'a reset stops pointing at a model the user may have deleted');
  assert.equal(reset.fallbackEngine, '', 'a reset does not keep a provider as the offline fallback');
});

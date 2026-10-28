import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.mjs';

const AT = load('lib/constants.js', 'lib/rules.js', 'lib/settings.js');
const { settings } = AT;

test('defaults are a complete, normalised object', () => {
  const base = settings.normalize(undefined);
  assert.equal(base.version, 1);
  assert.equal(base.enabled, true);
  assert.equal(base.autoDetect, true);
  assert.equal(base.targetLang, 'en');
  assert.equal(base.sourceLang, 'auto');
  assert.equal(base.engine, 'google');
  assert.equal(base.apiKey, '');
  assert.equal(base.batchChars, AT.C.DEFAULT_BATCH_CHARS);
  assert.equal(base.maxNodes, AT.C.DEFAULT_MAX_NODES);
  assert.deepEqual(base.siteRules, []);
  assert.deepEqual(Object.keys(base.endpoints).sort(), ['google', 'libretranslate']);
  assert.equal(base.endpoints.google, 'https://translate.googleapis.com/translate_a/single');
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
    endpoints: { google: 'not a url', libretranslate: 'https://lt.example/translate' }
  });
  assert.equal(coerced.enabled, false);
  assert.equal(coerced.autoDetect, false);
  assert.equal(coerced.targetLang, 'en');
  assert.equal(coerced.sourceLang, 'ko');
  assert.equal(coerced.engine, 'google');
  assert.equal(coerced.apiKey, 'secret');
  assert.equal(coerced.batchChars, 8000);
  assert.equal(coerced.maxNodes, 10);
  assert.equal(coerced.showBadge, false);
  assert.equal(coerced.debug, false);
  assert.equal('unknownKey' in coerced, false);
  assert.equal(coerced.endpoints.google, 'https://translate.googleapis.com/translate_a/single');
  assert.equal(coerced.endpoints.libretranslate, 'https://lt.example/translate');
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
  const store = {};
  AT.storage = {
    local: {
      get: async (key) => ({ [key]: structuredClone(store[key]) }),
      set: async (value) => Object.assign(store, structuredClone(value))
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

  const reset = await settings.reset();
  assert.equal(reset.engine, 'google');
  assert.equal(store.settings.engine, 'google');
});

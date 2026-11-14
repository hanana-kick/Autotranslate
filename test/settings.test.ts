import test from 'node:test';
import assert from 'node:assert/strict';
import { load, type ATNamespace } from './helpers.ts';

const AT = load('lib/constants.js', 'lib/rules.js', 'lib/local.js', 'lib/settings.js');
const { settings } = AT;

test('defaults are a complete, normalised object', () => {
  const base = settings.normalize(undefined);
  assert.equal(base.version, 3);
  assert.equal(base.enabled, false, 'nothing translates until onboarding turns it on');
  assert.equal(base.targetLang, 'en');
  assert.equal(base.sourceLang, 'auto');
  assert.equal(base.localModelId, '', 'nothing is downloaded out of the box');
  assert.equal(base.localMaxTokens, AT.local.DEFAULT_MAX_TOKENS, 'the budget starts at the shared default');
  assert.equal(base.maxNodes, AT.C.DEFAULT_MAX_NODES);
  assert.equal(base.translationConcurrency, 8);
  assert.equal(base.translationRendering, 'aurora');
  assert.deepEqual(base.siteRules, []);
  assert.deepEqual(base.alwaysTranslateLanguages, []);
  // The whole stored blob: an extra field here would be persisted forever.
  assert.deepEqual(Object.keys(base).sort(), [
    'alwaysTranslateLanguages',
    'debug',
    'enabled',
    'localMaxTokens',
    'localModelId',
    'maxNodes',
    'showBadge',
    'siteRules',
    'sourceLang',
    'targetLang',
    'translationConcurrency',
    'translationRendering',
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
      { pattern: '*.example.com', action: 'never' },
      { pattern: 'news.example.com/top', action: 'never' },
      { pattern: 'not a host', action: 'always' },
      { pattern: 'ok.example', action: 'sometimes' }
    ]
  });
  assert.deepEqual(saved.siteRules, [
    { pattern: '*.example.com', action: 'always' },
    { pattern: 'news.example.com/top', action: 'never' }
  ]);
});

test('automatic source languages accept only supported, unique catalogue codes', () => {
  const saved = settings.normalize({ alwaysTranslateLanguages: ['en', 'ja', 'en', 'zh-TW', 'auto', 'xx', null, 3] });
  assert.deepEqual(saved.alwaysTranslateLanguages, ['en', 'ja', 'zh-TW']);
  assert.deepEqual(settings.normalize({ alwaysTranslateLanguages: 'ja' }).alwaysTranslateLanguages, []);
  assert.deepEqual(settings.normalize({ alwaysTranslateLanguages: null }, saved).alwaysTranslateLanguages, saved.alwaysTranslateLanguages);
  assert.deepEqual(settings.normalize({ alwaysTranslateLanguages: [] }, saved).alwaysTranslateLanguages, []);
});

test('the content snapshot carries only what a page needs', () => {
  const snapshot = settings.contentSnapshot(settings.normalize({ maxNodes: 400 }));
  // `debug` is here because the content script draws the region overlay itself;
  // credentials and site rules are not.
  assert.deepEqual(Object.keys(snapshot).sort(), [
    'debug',
    'enabled',
    'maxNodes',
    'showBadge',
    'sourceLang',
    'targetLang',
    'translationConcurrency',
    'translationKey',
    'translationRendering'
  ]);
  assert.equal(snapshot.maxNodes, 400);
  assert.equal(snapshot.debug, false);
});

test('parallel admission defaults to eight while preserving every explicit supported width', () => {
  const parallel = settings.normalize({});
  assert.equal(settings.defaults().translationConcurrency, 8);
  assert.equal(parallel.translationConcurrency, 8);
  assert.equal(settings.contentSnapshot().translationConcurrency, 8);
  for (const width of [1, 2, 4, 8]) {
    const chosen = settings.normalize({ translationConcurrency: width });
    assert.equal(chosen.translationConcurrency, width);
    assert.equal(settings.contentSnapshot(chosen).translationConcurrency, width);
    assert.equal(settings.contentSnapshot(chosen).translationKey, settings.contentSnapshot(parallel).translationKey);
    for (const value of [undefined, 0, 3, 16, '1', '2', '4', '8', null, false]) {
      assert.equal(settings.normalize({ translationConcurrency: value }).translationConcurrency, 8);
      assert.equal(settings.normalize({ translationConcurrency: value }, chosen).translationConcurrency, width);
    }
  }
});

test('rendering mode defaults safely and never changes generation identity', () => {
  const base = settings.defaults();
  for (const mode of ['aurora', 'immediate']) {
    const chosen = settings.normalize({ translationRendering: mode });
    assert.equal(chosen.translationRendering, mode);
    assert.equal(settings.contentSnapshot(chosen).translationRendering, mode);
    assert.equal(settings.contentSnapshot(chosen).translationKey, settings.contentSnapshot(base).translationKey);
    for (const value of [undefined, null, false, 1, '', 'none']) {
      assert.equal(settings.normalize({ translationRendering: value }).translationRendering, 'aurora');
      assert.equal(settings.normalize({ translationRendering: value }, chosen).translationRendering, mode);
    }
  }
});

test('source-fragment translation invalidates the previous content cache', () => {
  const selected = settings.normalize({ localModelId: 'model-a', targetLang: 'ko' });
  const previousKey = JSON.stringify([
    'prompt-v2', selected.localModelId, selected.localMaxTokens, selected.sourceLang, selected.targetLang
  ]);
  assert.notEqual(settings.contentSnapshot(selected).translationKey, previousKey);
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

  assert.equal((await settings.load()).translationConcurrency, 8);
  const saved = await settings.save({ targetLang: 'ko', alwaysTranslateLanguages: ['en', 'ja', 'en'] });
  assert.equal(saved.targetLang, 'ko');
  assert.equal(store.settings.targetLang, 'ko');
  const reloaded = await settings.load();
  assert.equal(reloaded.targetLang, 'ko');
  assert.deepEqual(reloaded.alwaysTranslateLanguages, ['en', 'ja']);
  for (const width of [1, 2, 4, 8]) {
    await settings.save({ translationConcurrency: width });
    assert.equal(store.settings.translationConcurrency, width);
    assert.equal((await settings.load()).translationConcurrency, width);
    await settings.save({ targetLang: 'ja' });
    assert.equal((await settings.load()).translationConcurrency, width, 'unrelated saves preserve the selected width');
  }

  // Hand-edited garbage in storage is normalised on read.
  store.settings = { targetLang: 42, siteRules: 'nope', maxNodes: '700' };
  const repaired = await settings.load();
  assert.equal(repaired.targetLang, 'en');
  assert.deepEqual(repaired.siteRules, []);
  assert.equal(repaired.maxNodes, 700);
  assert.equal(repaired.translationConcurrency, 8);

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
  await settings.save({ alwaysTranslateLanguages: ['ja', 'en'] });
  await settings.save({ targetLang: 'ko' });
  assert.deepEqual((await settings.load()).alwaysTranslateLanguages, ['ja', 'en'], 'unrelated saves preserve automatic languages');
  await settings.save({ alwaysTranslateLanguages: [] });
  assert.deepEqual((await settings.load()).alwaysTranslateLanguages, [], 'unchecking every language disables language enrollment');

  const reset = await settings.reset();
  assert.equal(store.settings.targetLang, 'en');
  assert.equal(reset.localModelId, '', 'a reset stops pointing at a model the user may have deleted');
  assert.equal(reset.translationConcurrency, 8);
});

test('loading legacy settings erases retired credentials from storage while preserving local choices', async () => {
  const legacy = {
    ...settings.defaults(),
    version: 1,
    engine: 'openai',
    serverBaseUrl: 'https://example.invalid/v1',
    serverApiKey: 'retired-secret',
    serverModel: 'retired-model',
    serverTimeoutMs: 60000,
    serverRevision: 9,
    localModelId: 'model-a',
    localMaxTokens: 2048,
    targetLang: 'ko',
    siteRules: [{ pattern: 'example.com', action: 'never' }]
  };
  const store: ATNamespace = { settings: structuredClone(legacy), unrelated: 'keep' };
  let writes = 0, trusted = 0;
  AT.storage = { local: {
    get: async (key: string) => ({ [key]: structuredClone(store[key]) }),
    set: async (value: ATNamespace) => { writes++; Object.assign(store, structuredClone(value)); },
    setAccessLevel: async ({ accessLevel }: { accessLevel: string }) => {
      assert.equal(accessLevel, 'TRUSTED_CONTEXTS'); trusted++;
    }
  } };
  const migrated = await settings.load();
  assert.deepEqual(store.settings, migrated);
  assert.equal(migrated.version, 3);
  assert.equal(migrated.localModelId, 'model-a');
  assert.equal(migrated.localMaxTokens, 2048);
  assert.equal(migrated.targetLang, 'ko');
  assert.deepEqual(migrated.siteRules, legacy.siteRules);
  assert.equal(store.unrelated, 'keep');
  for (const key of ['engine', 'serverBaseUrl', 'serverApiKey', 'serverModel', 'serverTimeoutMs', 'serverRevision']) {
    assert.equal(key in migrated, false, key);
    assert.equal(key in settings.contentSnapshot(migrated), false, key);
  }
  assert.equal(JSON.stringify(store).includes('retired-secret'), false);
  assert.equal(trusted, 1);
  await settings.load();
  assert.equal(writes, 1, 'a clean blob is not rewritten on each read');
  await settings.save({ targetLang: 'ja', serverApiKey: 'cannot-return', engine: 'openai' });
  assert.equal('serverApiKey' in store.settings, false, 'untrusted patches cannot restore credentials');
  assert.equal('engine' in store.settings, false);
  assert.equal(store.settings.targetLang, 'ja');
  store.settings.serverApiKey = 'stale-v3-secret';
  await settings.load();
  assert.equal('serverApiKey' in store.settings, false, 'unknown fields are removed even with a current version');
  await settings.reset();
  assert.deepEqual(store.settings, settings.defaults());
});

test('v2 URL prefixes migrate once without shrinking legacy exclusions', async () => {
  const store: ATNamespace = { settings: {
    ...settings.defaults(), version: 2,
    siteRules: [
      { pattern: 'example.com/news/*', action: 'never' },
      { pattern: 'example.org/news', action: 'always' }
    ]
  } };
  let writes = 0;
  AT.storage = { local: {
    get: async (key: string) => ({ [key]: structuredClone(store[key]) }),
    set: async (value: ATNamespace) => { writes++; Object.assign(store, structuredClone(value)); }
  } };
  const migrated = await settings.load();
  assert.equal(migrated.version, 3);
  assert.deepEqual(migrated.siteRules, [
    { pattern: 'example.com/news/**', action: 'never' },
    { pattern: 'example.org/news**', action: 'always' }
  ]);
  assert.equal(AT.rules.resolve(migrated.siteRules, 'https://example.com/news/deep/story').action, 'never');
  assert.deepEqual(await settings.load(), migrated);
  assert.equal(writes, 1, 'migration is persisted exactly once');
  const saved = await settings.save({ siteRules: [{ pattern: 'example.com/news/*', action: 'always' }] });
  assert.equal(saved.siteRules[0].pattern, 'example.com/news/*', 'newly entered globs retain one-segment semantics');
});

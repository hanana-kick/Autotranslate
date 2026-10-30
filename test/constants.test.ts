import assert from 'node:assert/strict';
import test from 'node:test';
import { load, resetGlobals, type ATNamespace } from './helpers.ts';

// The catalogue every context reads from AT.C: message names, the language
// list the pickers render, the engine table and the numeric ceilings.

function constants(): ATNamespace {
  resetGlobals();
  const AT = load('lib/constants.js');
  assert.ok(AT.C, 'constants.js must define AT.C');
  return AT;
}

const MSG_NAMES = [
  'BATCH',
  'STATE_CHANGED',
  'GET_STATE',
  'SET_SETTINGS',
  'RESET_SETTINGS',
  'SET_SITE_RULE',
  'REMOVE_SITE_RULE',
  'TEST_ENGINE',
  'TRANSLATE_TAB',
  'RESTORE_TAB',
  'CONTENT_TRANSLATE',
  'CONTENT_TRANSLATE_SELECTION',
  'CONTENT_RESTORE',
  'CONTENT_PING',
  // The on-device protocol: background <-> host, and the UI asking the
  // background to keep the host warm.
  'LOCAL_TRANSLATE',
  'LOCAL_LOAD',
  'LOCAL_UNLOAD',
  'LOCAL_COUNT',
  'LOCAL_STATUS',
  'LOCAL_PREPARE',
  'LOCAL_RELEASE',
  'LOCAL_GET_STATUS'
];

// What the engine picker and the batch clamps are built from, so a catalogue
// edit has to be deliberate: `kind` decides whether an endpoint is expected.
type EngineTableEntry = {
  id: string;
  label: string;
  endpoint: string;
  supportsKey: boolean;
  maxChars: number;
  kind?: string;
};

const ENGINE_TABLE: EngineTableEntry[] = [
  {
    id: 'google',
    label: 'Google Translate (unofficial endpoint)',
    endpoint: 'https://translate.googleapis.com/translate_a/single',
    supportsKey: false,
    maxChars: 1200
  },
  {
    id: 'libretranslate',
    label: 'LibreTranslate',
    endpoint: 'http://127.0.0.1:5000/translate',
    supportsKey: true,
    maxChars: 4000
  },
  {
    id: 'local',
    label: 'On-device TranslateGemma (offline)',
    endpoint: '',
    supportsKey: false,
    maxChars: 1500,
    kind: 'local'
  }
];

const REMOTE_ENGINE_KEYS = ['docs', 'endpoint', 'id', 'label', 'maxChars', 'supportsKey'];
const LOCAL_ENGINE_KEYS = ['docs', 'endpoint', 'id', 'kind', 'label', 'maxChars', 'supportsKey'];

const PREFIX = 'at/';

test('message names are unique and carry the extension prefix', () => {
  const C = constants().C;
  const names = Object.keys(C.MSG as Record<string, string>);
  assert.deepEqual(
    [...names].sort(),
    [...MSG_NAMES].sort(),
    'the catalogue must cover every name in MessageTypes'
  );

  const values = names.map((name) => (C.MSG as Record<string, string>)[name]!);
  for (const value of values) {
    assert.ok(value.startsWith(PREFIX), `${value} must be namespaced with ${PREFIX}`);
    assert.match(value, /^at\/[a-z][a-z-]*$/, `${value} must be a single lower-case slug after the prefix`);
    assert.ok(value.length > PREFIX.length, `${value} must not be the bare prefix`);
  }
  assert.equal(new Set(values).size, values.length, 'no two names may share a string');
  assert.equal(new Set(values.map((value) => value.slice(PREFIX.length))).size, values.length);
});

test('every engine in the catalogue carries complete metadata', () => {
  const C = constants().C;
  assert.ok(Array.isArray(C.ENGINES) && C.ENGINES.length > 0);

  assert.deepEqual(
    C.ENGINES.map((engine: ATNamespace) => engine.id),
    ENGINE_TABLE.map((engine) => engine.id),
    'the picker renders the catalogue in order, and the count is part of the contract'
  );

  const ids = C.ENGINES.map((engine: ATNamespace) => engine.id);
  assert.equal(new Set(ids).size, ids.length, 'engine ids are the lookup key, so they must be unique');

  for (const engine of C.ENGINES) {
    const expected = ENGINE_TABLE.find((entry) => entry.id === engine.id);
    assert.ok(expected, `${engine.id} is not in the table this test guards`);
    assert.equal(typeof engine.id, 'string');
    assert.ok(engine.id.length > 0, 'engine id must not be empty');
    assert.equal(engine.label, expected.label, `${engine.id} label is what the engine picker shows`);
    assert.ok(engine.docs.length > 0, `${engine.id} needs the docs note shown in options`);
    assert.equal(typeof engine.supportsKey, 'boolean', `${engine.id} must say whether it takes a key`);
    assert.equal(engine.supportsKey, expected.supportsKey, `${engine.id} must not start demanding a key`);
    assert.ok(Number.isInteger(engine.maxChars) && engine.maxChars > 0, `${engine.id} needs a char ceiling`);
    assert.equal(engine.maxChars, expected.maxChars, `${engine.id} char ceiling feeds the batch clamp`);
    assert.equal(engine.kind, expected.kind, `${engine.id} kind decides how the options page renders it`);

    if (expected.kind === 'local') {
      // An on-device engine has no provider. An endpoint here would mean page
      // text left the browser, and a key field would only be dead weight.
      assert.equal(engine.endpoint, '', `${engine.id} runs in this browser, so it has no endpoint`);
      assert.equal(
        C.ENGINE_LANG_ALIAS[engine.id],
        undefined,
        `${engine.id} reads our own codes, not provider spellings`
      );
      assert.deepEqual(Object.keys(engine).sort(), LOCAL_ENGINE_KEYS);
    } else {
      assert.ok(engine.endpoint.length > 0, `${engine.id} is remote, so it needs an endpoint`);
      assert.equal(engine.endpoint, expected.endpoint, `${engine.id} endpoint is the options page default`);
      const url = new URL(engine.endpoint);
      assert.ok(url.protocol === 'https:' || url.protocol === 'http:', `${engine.id} has a ${url.protocol} endpoint`);
      assert.ok(url.hostname.length > 0 && url.pathname.length > 1, `${engine.id} endpoint must address a path`);
      if (url.protocol === 'http:') {
        assert.ok(
          url.hostname === '127.0.0.1' || url.hostname === 'localhost',
          `${engine.id} would send page text unencrypted to ${url.hostname}`
        );
      }
      assert.deepEqual(Object.keys(engine).sort(), REMOTE_ENGINE_KEYS);
    }

    // Callers spread the meta object, so it must be the catalogue entry itself.
    assert.equal(C.getEngineMeta(engine.id), engine);
  }

  // settings.ts defaults to 'google', so that id has to resolve.
  assert.equal(C.getEngineMeta('google')?.label, 'Google Translate (unofficial endpoint)');
});

test('the on-device engine is offered as an offline choice', () => {
  const C = constants().C;
  const local = C.getEngineMeta('local');
  assert.ok(local, 'the engine picker must offer the on-device engine');
  assert.equal(local.kind, 'local', 'only kind "local" makes the options page hide the endpoint field');
  assert.equal(local.endpoint, '', 'nothing may be fetched while translating offline');
  assert.equal(local.supportsKey, false, 'a model the user downloaded needs no provider key');
  assert.equal(local.maxChars, 1500, 'one generation is bounded by the model, not the network');
  assert.match(local.label, /On-device[\s\S]*offline/, 'the picker has to say the translation stays local');
  assert.ok(local.docs.includes('WebGPU'), 'the docs note has to name the requirement the user must meet');
  assert.equal(
    C.ENGINES.filter((engine: ATNamespace) => engine.kind === 'local').length,
    1,
    'exactly one on-device engine is offered'
  );
});

test('getEngineMeta returns null, not a partial object, for an unknown id', () => {
  const C = constants().C;
  for (const id of ['nope', '', 'GOOGLE', ' google', 'libre']) {
    const meta = C.getEngineMeta(id);
    assert.equal(meta, null, `${JSON.stringify(id)} must resolve to exactly null`);
  }
});

test('isSupportedLang accepts catalogue codes only', () => {
  const C = constants().C;
  for (const lang of C.LANGS) assert.equal(C.isSupportedLang(lang.code), true, `${lang.code} is a target`);
  assert.equal(C.LANG_CODES.size, C.LANGS.length, 'the code set mirrors the list');
  assert.deepEqual([...C.LANG_CODES].sort(), C.LANGS.map((lang: ATNamespace) => lang.code).sort());

  // No base folding here: 'en-US' is rejected even though sameLanguage would
  // match it, and provider spellings ('pt-BR', 'zh') are outbound only.
  for (const junk of ['', 'xx', 'en-US', 'EN', 'pt-BR', 'zh', 'auto', ' en', 'en ', null, undefined]) {
    assert.equal(C.isSupportedLang(junk), false, `${JSON.stringify(junk)} is not a target`);
  }

  // Regional variants stay distinct rather than collapsing to a base.
  assert.equal(C.isSupportedLang('zh-CN'), true);
  assert.equal(C.isSupportedLang('zh-TW'), true);
  assert.equal(C.isSupportedLang('pt'), true);
});

test('sameLanguage folds a region onto the base code in one direction only', () => {
  const C = constants().C;
  assert.equal(C.sameLanguage('en-US', 'en'), true, 'a regional source matches a base target');
  assert.equal(C.sameLanguage('en', 'en-US'), false, 'the reverse is not true: the right side keeps its region');
  assert.equal(C.sameLanguage('zh-CN', 'zh-TW'), false, 'the two Chinese variants never match');
  assert.equal(C.sameLanguage('ZH-CN', ' zh-cn '), true, 'case and padding are ignored');
  assert.equal(C.sameLanguage('en', 'en'), true);
  assert.equal(C.sameLanguage('', 'en'), false);
  assert.equal(C.sameLanguage('   ', 'en'), false);
  assert.equal(C.sameLanguage(null, 'en'), false);
  assert.equal(C.sameLanguage('en', undefined), false);
});

test('RTL_LANGS is only safe when read with === true', () => {
  const C = constants().C;
  const table = C.RTL_LANGS as Record<string, unknown>;

  for (const code of ['ar', 'fa', 'he', 'ur']) {
    assert.equal(table[code], true, `${code} must read as RTL under the === true contract`);
    assert.equal(C.RTL_LANGS[code], true);
  }
  assert.equal(C.RTL_LANGS['en'], undefined, 'an LTR language has no entry at all');
  assert.equal(C.RTL_LANGS['en'] === true, false);
  assert.equal(C.RTL_LANGS['xx'] === true, false);

  // The table is a plain object, so inherited members are truthy: only the
  // strict comparison keeps content.ts from marking unknown codes rtl.
  assert.equal(typeof table['toString'], 'function');
  assert.notEqual(table['toString'], true);
  assert.equal(C.RTL_LANGS['constructor'] === true, false);

  assert.deepEqual(Object.keys(C.RTL_LANGS).sort(), ['ar', 'fa', 'he', 'ur']);
  for (const value of Object.values(C.RTL_LANGS)) assert.equal(value, true, 'the table only ever holds true');

  // Reality check: 'ur' has a direction entry but no picker entry, so it is
  // unreachable through C.LANGS.
  assert.equal(C.isSupportedLang('ur'), false);
});

test('numeric defaults sit inside the ceilings they feed', () => {
  const C = constants().C;
  const positiveIntegers: string[] = [
    'DEFAULT_BATCH_CHARS',
    'DEFAULT_MAX_NODES',
    'OBSERVER_BATCH_NODES',
    'OBSERVER_DEBOUNCE_MS',
    'PROVIDER_TIMEOUT_MS'
  ];
  for (const key of positiveIntegers) {
    const value = C[key] as number;
    assert.ok(Number.isInteger(value) && value > 0, `${key} must be a positive whole number, got ${value}`);
  }

  assert.ok(C.OBSERVER_BATCH_NODES <= C.DEFAULT_MAX_NODES, 'one observer tick cannot exceed a run budget');
  assert.ok(C.PROVIDER_RETRIES >= 0, 'retries are additional attempts');
  assert.ok(C.PROVIDER_CONCURRENCY >= 1, 'at least one request must be in flight');
  assert.ok(
    C.DEFAULT_BATCH_CHARS <= Math.min(...C.ENGINES.map((engine: ATNamespace) => engine.maxChars)),
    'the default batch size must fit the strictest engine'
  );
  assert.ok(C.PROVIDER_TIMEOUT_MS > C.OBSERVER_DEBOUNCE_MS, 'a debounce must not outlive the request it guards');
});

test('the picker language list is complete enough to render', () => {
  const C = constants().C;
  assert.ok(C.LANGS.length > 0);

  const codes = C.LANGS.map((lang: ATNamespace) => lang.code);
  assert.equal(new Set(codes).size, codes.length, 'duplicate codes would render two identical options');

  for (const lang of C.LANGS) {
    assert.equal(typeof lang.code, 'string');
    assert.match(lang.code, /^[a-z]{2,3}(-[A-Z]{2})?$/, `${lang.code} must be a BCP-47 style tag`);
    assert.equal(typeof lang.native, 'string');
    // popup.ts / options.ts build the label as `${native} (${code})`.
    assert.ok(lang.native.trim().length > 0, `${lang.code} needs a native label for the option text`);
    assert.equal(C.isSupportedLang(lang.code), true, `${lang.code} must survive settings validation`);
  }

  // popup.ts falls back to the first entry for an unsupported selection.
  assert.equal(C.isSupportedLang(C.LANGS[0]!.code), true, 'the fallback code must be a real target');
});

test('engine language aliases map catalogue codes to provider spellings', () => {
  const C = constants().C;
  const engineIds = C.ENGINES.map((engine: ATNamespace) => engine.id) as string[];

  for (const engineId of Object.keys(C.ENGINE_LANG_ALIAS)) {
    assert.ok(engineIds.includes(engineId), `${engineId} has aliases but is not an engine`);
    const aliases = C.ENGINE_LANG_ALIAS[engineId] as Record<string, string>;
    for (const [code, alias] of Object.entries(aliases)) {
      assert.equal(C.isSupportedLang(code), true, `${engineId} aliases a code we do not offer`);
      assert.ok(typeof alias === 'string' && alias.length > 0, `${engineId}:${code} must map to a spelling`);
    }
  }

  // Google keeps the two Chinese variants apart; LibreTranslate collapses them
  // to 'zh', and google's Portuguese spelling is a provider-only tag.
  assert.deepEqual(C.ENGINE_LANG_ALIAS['google'], { 'zh-CN': 'zh-CN', 'zh-TW': 'zh-TW', pt: 'pt-BR' });
  assert.deepEqual(C.ENGINE_LANG_ALIAS['libretranslate'], { 'zh-CN': 'zh', 'zh-TW': 'zh', pt: 'pt' });
  assert.equal(C.isSupportedLang(C.ENGINE_LANG_ALIAS['google']!['pt']), false, 'pt-BR is outbound only');
});

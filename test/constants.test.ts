import assert from 'node:assert/strict';
import test from 'node:test';
import { load, resetGlobals, type ATNamespace } from './helpers.ts';

// The catalogue every context reads from AT.C: message names, the language
// list the pickers render and the numeric ceilings.

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
  'SET_TAB_ENABLED',
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
  'CONTENT_STATE',
  // The on-device protocol: background <-> host, and the UI asking the
  // background to keep the host warm.
  'LOCAL_TRANSLATE',
  'LOCAL_LOAD',
  'LOCAL_UNLOAD',
  'LOCAL_COUNT',
  'LOCAL_QUERY',
  'LOCAL_STATUS',
  'LOCAL_PREPARE',
  'LOCAL_RELEASE',
  'LOCAL_GET_STATUS'
];

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

test('isSupportedLang accepts catalogue codes only', () => {
  const C = constants().C;
  for (const lang of C.LANGS) assert.equal(C.isSupportedLang(lang.code), true, `${lang.code} is a target`);
  assert.equal(C.LANG_CODES.size, C.LANGS.length, 'the code set mirrors the list');
  assert.deepEqual([...C.LANG_CODES].sort(), C.LANGS.map((lang: ATNamespace) => lang.code).sort());

  // No base folding here: 'en-US' is rejected even though sameLanguage would
  // match it, and regional variants stay distinct.
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
    'DEFAULT_MAX_NODES',
    'OBSERVER_BATCH_NODES',
    'SENTENCE_MAX_CHARS',
    'OBSERVER_DEBOUNCE_MS'
  ];
  for (const key of positiveIntegers) {
    const value = C[key] as number;
    assert.ok(Number.isInteger(value) && value > 0, `${key} must be a positive whole number, got ${value}`);
  }

  assert.ok(C.OBSERVER_BATCH_NODES <= C.DEFAULT_MAX_NODES, 'one observer tick cannot exceed a run budget');
  assert.ok(C.OBSERVER_BATCH_NODES > 0 && C.OBSERVER_BATCH_NODES <= C.DEFAULT_MAX_NODES);
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

test('the constants carry no provider catalogue', () => {
  // The on-device model is the only engine now; a leftover engine table would
  // suggest a provider path that no longer exists.
  const C = constants().C;
  for (const key of [
    'ENGINES',
    'ENGINE_LANG_ALIAS',
    'LOCAL_BATCH_CHARS',
    'PROVIDER_RETRIES',
    'PROVIDER_CONCURRENCY',
    'PROVIDER_TIMEOUT_MS'
  ]) {
    assert.equal(key in C, false, `${key} was part of the removed provider layer`);
  }
});

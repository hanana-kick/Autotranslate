import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.ts';

// The module that owns TranslateGemma's language vocabulary: the type comes
// from the table, so every code the rest of the code passes is one the model
// itself lists.
const AT = load('lib/constants.js', 'lib/gemma.js');
const { gemma } = AT;

test('every code the extension offers has a model code', () => {
  for (const language of AT.C.LANGS) {
    assert.ok(gemma.langFor(language.code), `${language.code} has no TranslateGemma code`);
  }
});

test('Simplified Chinese is spelled the way the model spells it', () => {
  // Our UI calls it `zh-CN`; the model's table has `zh-Hans` and no `zh-CN`.
  assert.equal(gemma.langFor('zh-CN'), 'zh-Hans');
  assert.equal(gemma.langFor('zh-TW'), 'zh-TW', 'Traditional Chinese is a table entry as it stands');
  assert.equal(gemma.LANGS['zh-Hans'], 'Chinese');
});

test('codes outside the table are refused instead of passed on', () => {
  assert.equal(gemma.langFor('xx'), null);
  assert.equal(gemma.langFor('en-US'), null, 'the table has en, not en-US');
  assert.equal(gemma.langFor(''), null);
  assert.equal(gemma.langFor(null), null);
  assert.equal(gemma.langFor(undefined), null);
  assert.equal(gemma.isLang('xx'), false);
  assert.equal(gemma.isLang('ko'), true);
  assert.equal(gemma.isLang(42), false);
});

test('a detected regional code keeps its region when the model lists it', () => {
  // What i18n.detectLanguage answers is not normalised: de-AT is an entry, and
  // a code the table lacks falls back to the bare language.
  assert.equal(gemma.langForDetected('de-AT'), 'de-AT');
  assert.equal(gemma.langForDetected('pt-BR'), 'pt-BR');
  assert.equal(gemma.langForDetected('en-US'), 'en', 'en-US is not a table entry, en is');
  assert.equal(gemma.langForDetected('zh-CN'), 'zh-Hans');
  assert.equal(gemma.langForDetected('de_AT'), 'de-AT', 'underscores are folded to the table spelling');
  assert.equal(gemma.langForDetected('xx-YY'), null);
  assert.equal(gemma.langForDetected(null), null);
});

test('the table is the model vocabulary, not a sample', () => {
  const count = Object.keys(gemma.LANGS).length;
  assert.ok(count > 500, `the published table has 581 entries, got ${count}`);
  assert.equal(gemma.nameOf('ko'), 'Korean');
  assert.equal(gemma.nameOf('sr-Latn'), 'Serbian');
  assert.equal(gemma.LANGS['zh-CN'], undefined, 'the model never lists zh-CN');
});

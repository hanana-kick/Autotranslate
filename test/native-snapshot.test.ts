import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Execute the exact two reads from the shipped QA driver. This is a driver
// ordering contract test, not a mock substituted into native extension QA.
const source = readFileSync(new URL('./native-extension/real-extension.mjs', import.meta.url), 'utf8');
const statements = source.match(/^\s+const (?:state|render) = await bound\([^\n]+\);$/gm)!;
assert.equal(statements.length, 2);
const sample = new Function('bound', 'options', 'page', `return (async () => {
  const tabId = 1, selectors = ['#guide'];
  ${statements.join('\n')}
  return { state, render };
})()`);
const assertion = source.match(/assert\.ok\(Object\.values\(render\)\.every\(\(s\) => \/\[가-힣\]\/u\.test\(s\)\)\);/);
assert.ok(assertion, 'native rendered-language assertion must remain mandatory');
const validate = new Function('assert', 'render', assertion[0]);

test('native QA samples DOM after the completion acknowledgement, not before', async () => {
  let text = 'the installation guide'; const calls: string[] = [];
  const result = await sample((p: Promise<unknown>) => p,
    { evaluate: async () => { calls.push('state'); text = '설치 지침'; return { state: { status: 'translated' } }; } },
    { evaluate: async () => { calls.push('dom'); return { '#guide': text }; } });
  assert.deepEqual(calls, ['state', 'dom']);
  assert.deepEqual(result.render, { '#guide': '설치 지침' });
  validate(assert, result.render);
});

test('native QA still fails a completed state whose fresh DOM remains untranslated', async () => {
  const result = await sample((p: Promise<unknown>) => p,
    { evaluate: async () => ({ state: { status: 'translated' } }) },
    { evaluate: async () => ({ '#guide': 'the installation guide' }) });
  assert.throws(() => validate(assert, result.render));
});

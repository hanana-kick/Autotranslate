import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.ts';
const AT = load('lib/constants.js');

test('output validity: structural garbage is rejected without linguistic scoring', () => {
  assert.equal(AT.outputIssue('Hello.', '<pad>'.repeat(946)), 'control-token');
  assert.equal(AT.outputIssue('Hello.', '<end_of_turn>'), 'control-token');
  assert.equal(AT.outputIssue('Hello.', '   '), 'empty-output');
  assert.equal(AT.outputIssue('Hello.', '반복'.repeat(50)), 'repeated-output');
  assert.equal(AT.outputIssue('Hello.', 'a'.repeat(10000)), 'excessive-output');
  assert.equal(AT.outputIssue('Hello.', '안녕하세요.'), null);
  assert.equal(AT.outputIssue('OpenAI', 'OpenAI'), null, 'a proper noun may remain unchanged');
  assert.equal(AT.outputIssue('The <pad> token.', '<pad> 토큰.'), null, 'literal source tokens remain legal');
  assert.equal(AT.outputIssue('ha'.repeat(50), 'ha'.repeat(50)), null);
  assert.equal(AT.outputIssue('Hello.', '', true), null, 'empty progress is not an empty final answer');
});

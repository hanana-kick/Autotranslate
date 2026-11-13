import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.ts';
const AT = load('lib/constants.js');

test('output validity: structural garbage is rejected without linguistic scoring', () => {
  assert.equal(AT.outputIssue('Hello.', '<pad>'.repeat(946)), 'control-token');
  assert.equal(AT.outputIssue('Hello.', '<end_of_turn>'), 'control-token');
  assert.equal(AT.outputIssue('Hello.', '<|plamo:tag|>output'), 'control-token');
  assert.equal(AT.outputIssue('Hello.', '   '), 'empty-output');
  assert.equal(AT.outputIssue('Hello.', '반복'.repeat(50)), 'repeated-output');
  assert.equal(AT.outputIssue('Hello.', 'a'.repeat(10000)), 'excessive-output');
  assert.equal(AT.outputIssue('Hello.', '안녕하세요.'), null);
  assert.equal(AT.outputIssue('OpenAI', 'OpenAI'), null, 'a proper noun may remain unchanged');
  assert.equal(AT.outputIssue('The <pad> token.', '<pad> 토큰.'), null, 'literal source tokens remain legal');
  assert.equal(AT.outputIssue('ha'.repeat(50), 'ha'.repeat(50)), null);
  assert.equal(AT.outputIssue('Hello.', '', true), null, 'empty progress is not an empty final answer');
});

test('target-language exclusion is a conservative per-fragment Hangul proof', () => {
  const shortReply = '이 노래 정말 좋아요!!';
  assert.equal(shortReply.length, 13);
  for (const text of [shortReply, '감사합니다', '네', 'ㅋㅋㅋ', '  좋아요! 123 🎵 ', '감사']) {
    assert.equal(AT.isTargetLanguage(text, 'ko'), true, text);
  }
  assert.equal(AT.isTargetLanguage(shortReply, 'ko-KR'), true);
  for (const text of ['', '123 🎵', 'Thank you', '좋아요 Thank you', '좋아요 ありがとう',
    '좋아요 謝謝', '좋아요 спасибо', '감사합니다 '.repeat(30) + 'Please translate this']) {
    assert.equal(AT.isTargetLanguage(text, 'ko'), false, text);
  }
  for (const target of ['ja', 'zh-CN', 'zh-TW', 'en', 'ru']) {
    assert.equal(AT.isTargetLanguage('日本語 中文', target), false, target);
    assert.equal(AT.isTargetLanguage(shortReply, target), false, target);
  }
  assert.equal(AT.outputIssue('Explain outputlangko.', 'outputlangko는 일반 문자열입니다.'), null);
});

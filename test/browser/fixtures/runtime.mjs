// Deterministic MediaPipe API contract double. Not a translation model.
export const FilesetResolver = { forGenAiTasks: async () => ({ wasmLoaderPath: 'fixture', wasmBinaryPath: 'fixture' }) };
function translate(text, japanese) {
  const ko = { 'Read': '읽으세요', 'privacy policy': '개인정보처리방침', 'before you continue.': '계속하기 전에.',
    'Original text': '원문 번역', 'First paragraph': '첫 문단', 'Inserted during inference': '추론 중 추가된 문단',
    'Repeated text': '반복 문장', 'New page value': '새 페이지 내용', 'Hello world': '안녕하세요' };
  const ja = { Read: '読んで', 'privacy policy': 'プライバシーポリシー', 'before you continue.': '続ける前に。',
    'Original text': '新しい翻訳', 'First paragraph': '最初の段落' };
  // Deliberately drop run markers to exercise the production safe fallback.
  if (/[\uE000\uE001]/u.test(text)) return japanese ? '続ける前にプライバシーポリシーを読んでください。' : '계속하기 전에 개인정보처리방침을 읽으세요.';
  return (japanese ? ja : ko)[text.trim()] ?? (japanese ? `訳:${text}` : `번역:${text}`);
}
export const LlmInference = { async createFromOptions(_files, options) {
  await globalThis.__qaReady;
  const state = globalThis.__qa; state.instances++; globalThis.__qaPublish?.();
  // Consume the real OPFS reader, making stream/byte-contract failures visible.
  const reader = options.baseOptions.modelAssetBuffer;
  let bytes = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; } }
  finally { reader.releaseLock(); }
  if (!bytes) throw new Error('empty test model');
  let closed = false;
  return {
    sizeInTokens: (text) => Math.ceil(text.length / 4),
    close() { if (!closed) state.closed++; closed = true; },
    cancelProcessing() {},
    async generateResponse(prompt) {
      if (closed) throw new Error('closed instance reused');
      if (prompt.includes('Translate to Korean: Good morning.')) {
        if (state.failWarmup) throw new Error('fixture warmup rejected');
        return '좋은 아침입니다.';
      }
      state.prompts.push(prompt); globalThis.__qaPublish?.();
      if (state.hold) await new Promise((resolve) => { state.pending.push(resolve); globalThis.__qaPublish?.(); });
      const japanese = /Japanese \(ja\)|into Japanese/.test(prompt);
      const body = prompt.split('\n<end_of_turn>')[0];
      if (body.includes('\nSegments:\n')) {
        return body.split('\nSegments:\n')[1].split('\n').filter(Boolean)
          .map((line, index) => `${index + 1}: ${translate(line.replace(/^\d+\.\s*/, ''), japanese)}`).join('\n');
      }
      return translate(body.split(/\n{2,}/).at(-1), japanese);
    }
  };
} };

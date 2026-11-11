// TEST ONLY: deterministic Transformers.js pipeline double, in the shape the
// offscreen host reads (`AT_TRANSFORMERS`). It replaces
// vendor/onnxruntime/transformers.web.js in the disposable extension, so the
// production host, offscreen document, message path and DOM layer all run
// unchanged; only the graph and the weights are not real.
//
// The pipeline is asked with `return_full_text` on, which is what the shipped
// host strips: every answer here is the prompt followed by the generation,
// exactly as the library returns it.
(() => {
  const KO = {
    'Read': '읽으세요',
    'privacy policy': '개인정보처리방침',
    'before you continue.': '계속하기 전에.',
    'Original text': '원문 번역',
    'First paragraph': '첫 문단',
    'Inserted during inference': '추론 중 추가된 문단',
    'Repeated text': '반복 문장',
    'New page value': '새 페이지 내용',
    'Hello world': '안녕하세요'
  };
  const JA = {
    'Read': '読んで',
    'privacy policy': 'プライバシーポリシー',
    'before you continue.': '続ける前に。',
    'Original text': '新しい翻訳',
    'First paragraph': '最初の段落'
  };

  /** One page segment, in the language the prompt asked for. */
  function translate(text, japanese) {
    const asked = text.trim();
    const table = japanese ? JA : KO;
    if (Object.hasOwn(table, asked)) return table[asked];
    return japanese ? `訳:${asked}` : `번역:${asked}`;
  }

  // Every code point is one token, so no text is out of vocabulary and the
  // byte-fallback expansion leaves page text exactly as it arrived.
  const tokenizer = (text) => ({ input_ids: { data: Array.from(String(text), (ch) => ch.codePointAt(0)) } });
  tokenizer.decode = (ids) => String.fromCodePoint(...Array.from(ids, Number));

  const INPUT = /<\|plamo:tag\|>input<\|plamo:msg\|>([\s\S]*?)<\|plamo:tag\|>output/;
  const LANG = /<\|plamo:key\|>lang<\|plamo:val\|>([^<]*)/;

  tokenizer.apply_chat_template = (messages, options) => {
    const content = messages[0]?.content ?? '';
    return (
      '<|plamo:tag|>dataset<|plamo:msg|>translation' +
      `<|plamo:tag|>input<|plamo:msg|>${content}` +
      `<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>${options?.target_lang ?? 'ko'}<|plamo:msg|>`
    );
  };

  /** The generation for one prompt: numbered lines in, numbered lines out. */
  function answer(prompt) {
    const body = INPUT.exec(prompt)?.[1] ?? '';
    const japanese = (LANG.exec(prompt)?.[1] ?? '') === 'ja';
    const lines = body.split('\n').map((line) => line.trim()).filter(Boolean);
    if (lines.length > 1 && lines.every((line) => /^\d+\.\s/.test(line))) {
      return lines
        .map((line, index) => `${index + 1}: ${translate(line.replace(/^\d+\.\s*/, ''), japanese)}`)
        .join('\n');
    }
    return translate(lines.at(-1) ?? body, japanese);
  }

  const qa = () => globalThis.__qa;

  /** What the library hands back: the prompt decoded with special tokens
   *  skipped, so every `<|plamo:...|>` marker is gone, then the generation. */
  const decoded = (prompt) => prompt.replace(/<\|[^|]*\|>/g, '');

  globalThis.AT_TRANSFORMERS = {
    env: { backends: { onnx: { wasm: {} } } },
    AutoTokenizer: { from_pretrained: async () => tokenizer },
    pipeline: async () => {
      // The host warms a fresh pipeline with two prompts before it answers
      // anything: one short and one realistic, neither of them page text.
      let warmup = 2;
      const state = qa();
      if (state) state.instances += 1;
      return async (prompt) => {
        if (warmup > 0) {
          warmup -= 1;
          if (state?.failWarmup) throw new Error('fixture warmup rejected');
          return [{ generated_text: prompt }];
        }
        const live = qa();
        if (live) {
          live.prompts.push(prompt);
          if (live.hold) {
            await new Promise((resolve) => {
              live.pending.push(resolve);
            });
          }
        }
        return [{ generated_text: decoded(prompt) + answer(prompt) }];
      };
    }
  };
})();

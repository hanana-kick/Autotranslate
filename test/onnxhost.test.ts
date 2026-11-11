import test from 'node:test';
import assert from 'node:assert/strict';
import { load, type ATNamespace } from './helpers.ts';

const AT = load('lib/constants.js', 'lib/plamo3.js', 'lib/local.js', 'lib/modelstore.js', 'lib/onnxhost.js');
const { local, onnxhost } = AT;

/** A tokenizer double shaped like the real one: the Plamo Unigram vocab has no
 *  byte fallback in JS, so an out-of-vocab char encodes to unk(0) while the
 *  `<0xXX>` byte tokens are in the vocab. */
const VOCAB: Record<string, number> = {
  '안': 101099, '하': 101026, '세': 101072, '요': 101084,
  '<0xEB>': 235, '<0x85>': 133, '<0x95>': 149
};
const fakeTokenizer = (text: string, _options?: { add_special_tokens?: boolean }) => {
  const ids: number[] = [];
  // Match <0xXX> byte tokens first, then single characters.
  const re = /<0x[0-9A-F]{2}>|./gsu;
  for (const piece of text.match(re) ?? []) {
    const id = VOCAB[piece];
    ids.push(id === undefined ? 0 : id);
  }
  return { input_ids: { data: ids } };
};
fakeTokenizer.decode = (ids: ArrayLike<number | bigint>) => {
  let out = '';
  const bytes: number[] = [];
  for (const id of Array.from(ids)) {
    const piece = Object.entries(VOCAB).find(([, v]) => v === Number(id))?.[0] ?? '?';
    const byte = piece.match(/^<0x([0-9A-F]{2})>$/)?.[1];
    if (byte) bytes.push(parseInt(byte, 16));
    else {
      if (bytes.length) {
        out += new TextDecoder().decode(new Uint8Array(bytes));
        bytes.length = 0;
      }
      out += piece;
    }
  }
  if (bytes.length) out += new TextDecoder().decode(new Uint8Array(bytes));
  return out;
};
fakeTokenizer.apply_chat_template = (messages: { content: string }[]) => `PROMPT:${messages[0]?.content ?? ''}`;

test.beforeEach(() => {
  onnxhost.configure({ tokenizer: fakeTokenizer });
});

test('expandByteFallback leaves in-vocab text alone', () => {
  assert.equal(onnxhost.expandByteFallback('안하세요'), '안하세요');
});

test('expandByteFallback turns an out-of-vocab char into its UTF-8 byte tokens', () => {
  // '녕' is not in the vocab (the real one has only 467 of 11172 syllables),
  // so it must become <0xEB><0x85><0x95>, which round-trips to the same ids the
  // Rust tokenizer produces.
  assert.equal(onnxhost.expandByteFallback('안녕하세요'), '안<0xEB><0x85><0x95>하세요');
  const ids = Array.from(fakeTokenizer(onnxhost.expandByteFallback('안녕하세요')).input_ids.data).map(Number);
  assert.deepEqual(ids, [101099, 235, 133, 149, 101026, 101072, 101084]);
  assert.equal(fakeTokenizer.decode(ids), '안녕하세요', 'the expansion round-trips to the original text');
});

test('modelKind classifies onnx files and files the runtime must judge', () => {
  assert.equal(
    local.modelKind({ name: 'model_q4f16.onnx', sourceUrl: 'https://huggingface.co/x/y/resolve/main/onnx/model_q4f16.onnx' }),
    'onnx'
  );
  assert.equal(local.modelKind({ sourceUrl: 'https://huggingface.co/x/y/resolve/main/onnx/model_fp16.onnx' }), 'onnx');
  assert.equal(local.modelKind({ name: 'other.bin' }), 'unknown');
  assert.equal(local.modelKind({}), 'unknown');
});

test('the ONNX card is the default offer and carries its parts', () => {
  const source = local.defaultSource();
  assert.equal(source.kind, 'onnx');
  assert.equal(source.id, 'plamo-3-translate-0.8b-onnx-q4f16');
  assert.ok(source.url.includes('model_q4f16.onnx'));
  assert.equal(source.size, 705701446);
  assert.equal(source.dtype, 'q4f16', 'the default is the graph the step and batch numbers were measured on');
  assert.ok((source.parts ?? []).includes('tokenizer.json'));
  assert.equal(local.sourceFor(source.url)?.id, source.id);
});

test('the answer is the generation alone, not the prompt the pipeline echoes back', async () => {
  // With `return_full_text` on, the pipeline hands back the decoded prompt
  // followed by the generation; a cut that trusts the library's token-count
  // slice left the page's own sentence at the head of the "translation".
  const source = 'The meeting moved to Monday.';
  const answer = '회의는 월요일로 변경되었습니다.';
  const prompts: string[] = [];
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const globals = globalThis as ATNamespace;
  const realRuntime = AT.runtime;
  const realGet = AT.modelstore.get;
  const realGetURL = AT.getURL;
  AT.getURL = (path: string) => `ext://${path}`;
  AT.modelstore.get = async (id: string) => ({
    id,
    name: 'model_q4f16.onnx',
    size: 705701446,
    sourceUrl: 'https://x/onnx/model_q4f16.onnx',
    createdAt: 1
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { gpu: { requestAdapter: async () => ({ features: { has: () => true } }) } }
  });
  onnxhost.configure({
    runtime: () => ({
      env: { backends: { onnx: { wasm: {} } } },
      AutoTokenizer: { from_pretrained: async () => fakeTokenizer },
      pipeline: async () => async (prompt: string) => {
        prompts.push(prompt);
        return [{ generated_text: prompt + answer }];
      }
    })
  });
  try {
    const reply = await onnxhost.translate({
      type: 'at/local-translate',
      modelId: 'onnx-model',
      texts: [source],
      target: 'ko',
      maxTokens: 512
    });
    assert.deepEqual(reply.translations, [answer]);
    assert.ok(prompts.some((prompt) => prompt.startsWith('PROMPT:')), 'the fake pipeline saw the prompt');
    assert.equal(reply.translations[0].includes('PROMPT:'), false, 'the prompt never comes back as the translation');
  } finally {
    await onnxhost.unload('requested');
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else delete globals.navigator;
    AT.runtime = realRuntime;
    AT.getURL = realGetURL;
    AT.modelstore.get = realGet;
  }
});

test('a status query for an ONNX model is answered by the one host', async () => {
  // Status, unload and query carry no model id: with a single host there is
  // nothing to route, so the answer is that host's own state.
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { gpu: { requestAdapter: async () => ({ features: { has: () => true } }) } }
  });
  try {
    const status = await AT.onnxhost.status();
    assert.equal(status.target, 'offscreen', 'the host installed by the offscreen document answers');
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else delete (globalThis as ATNamespace).navigator;
  }
});

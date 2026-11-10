import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.ts';

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

test('modelKind classifies gguf, onnx and unknown files', () => {
  assert.equal(local.modelKind({ name: 'plamo-3-translate-0.8b-Q4_K_M.gguf' }), 'gguf');
  assert.equal(
    local.modelKind({ name: 'model_q4f16.onnx', sourceUrl: 'https://huggingface.co/x/y/resolve/main/onnx/model_q4f16.onnx' }),
    'onnx'
  );
  assert.equal(local.modelKind({ sourceUrl: 'https://huggingface.co/x/y/resolve/main/onnx/model_fp16.onnx' }), 'onnx');
  assert.equal(local.modelKind({ name: 'other.gguf' }), 'unknown');
  assert.equal(local.isPlamo3File({ name: 'plamo-3-translate-0.8b-Q4_K_M.gguf' }), true);
  assert.equal(local.isPlamo3File({ name: 'model_q4f16.onnx' }), false);
});

test('the ONNX card is the default offer and carries its parts', () => {
  const source = local.defaultSource();
  assert.equal(source.kind, 'onnx');
  assert.equal(source.id, 'plamo-3-translate-0.8b-onnx-fp16');
  assert.ok(source.url.includes('model_fp16.onnx'));
  assert.equal(source.size, 1781996033);
  assert.equal(source.dtype, 'fp16', 'the default ONNX card is unquantized');
  assert.ok((source.parts ?? []).includes('tokenizer.json'));
  assert.equal(local.sourceFor(source.url)?.id, source.id);
});

test('callHost picks the ONNX host for an ONNX record in the background placement', async () => {
  const seen: string[] = [];
  local.bindRecordLookup((id: string) =>
    id === 'onnx-model' ? { id, name: 'model_q4f16.onnx', size: 705701446, sourceUrl: 'https://x/onnx/model_q4f16.onnx', createdAt: 1 } : null
  );
  local.setHostPlacement('background');
  const realSend = AT.sendMessage;
  AT.sendMessage = async (message: unknown) => {
    seen.push('msg:' + String((message as { type?: string }).type));
    return { ok: true };
  };
  const original = AT.onnxhost.handle;
  AT.onnxhost.handle = async (message: unknown) => {
    seen.push(String((message as { type?: string }).type));
    return {};
  };
  try {
    await local.callHost({ type: 'at/local-status', modelId: 'onnx-model' });
    assert.deepEqual(seen, ['at/local-status'], 'the ONNX host answered');
    await local.callHost({ type: 'at/local-status', modelId: 'gguf-model' });
    assert.deepEqual(seen, ['at/local-status', 'msg:at/local-status'], 'an unknown id falls back to the GGUF host');
  } finally {
    AT.sendMessage = realSend;
    AT.onnxhost.handle = original;
    local.setHostPlacement('offscreen');
    local.bindRecordLookup(() => null);
  }
});

test('a cold record view still routes an ONNX id to the ONNX host', async () => {
  // A document that has never listed the records answers 'gguf' to every id
  // synchronously; the first load must still reach the ONNX host, or the GGUF
  // host's file sniff fails the model outright.
  local.bindRecordLookup(() => null);
  const real = AT.modelstore.get;
  AT.modelstore.get = async (id: string) =>
    id === 'cold-onnx'
      ? { id, name: 'model_q4f16.onnx', size: 705701446, sourceUrl: 'https://x/onnx/model_q4f16.onnx', createdAt: 1 }
      : null;
  try {
    assert.equal(local.modelKindFor('cold-onnx'), 'gguf', 'the synchronous view is cold');
    assert.equal(await local.kindForHost('cold-onnx'), 'onnx');
    assert.equal(await local.kindForHost('missing-id'), 'gguf', 'an id the store does not hold stays GGUF');
  } finally {
    AT.modelstore.get = real;
    local.bindRecordLookup(() => null);
  }
});

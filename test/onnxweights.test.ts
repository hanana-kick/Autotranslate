import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.ts';

const AT = load('lib/constants.js', 'lib/onnxweights.js');
const { onnxweights } = AT;

// --- a minimal ONNX writer -------------------------------------------------
// The parser exists to avoid pulling a protobuf library into the worker, so the
// test builds its fixture the same way: by hand, field by field. It also pins
// the two encodings that broke the first reader - a length prefix that must be
// consumed before the payload offset is advanced, and a negative int64 written
// as a ten-byte two's-complement varint.

type Field = number | string | Field[];

function varint(value: number): number[] {
  let remaining = BigInt(value);
  if (remaining < 0n) remaining += 2n ** 64n;
  const out: number[] = [];
  for (;;) {
    const byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining === 0n) {
      out.push(byte);
      return out;
    }
    out.push(byte | 0x80);
  }
}

function tag(field: number, wire: number): number[] {
  return varint(field * 8 + wire);
}

function bytes(value: Uint8Array | number[]): number[] {
  return Array.from(value);
}

function len(field: number, payload: number[] | string): number[] {
  const body = typeof payload === 'string' ? Array.from(new TextEncoder().encode(payload)) : payload;
  return [...tag(field, 2), ...varint(body.length), ...body];
}

function vint(field: number, value: number): number[] {
  return [...tag(field, 0), ...varint(value)];
}

function join(fields: Field[]): number[] {
  // Field lists nest (a map of a field list is a list of lists).
  const out: number[] = [];
  const walk = (list: Field[]): void => {
    for (const field of list) {
      if (Array.isArray(field)) walk(field);
      else if (typeof field === 'number') out.push(field);
    }
  };
  walk(fields);
  return out;
}

function f16bits(value: number): number[] {
  const float = new Float32Array([value]);
  const view = new DataView(float.buffer);
  const f = view.getFloat32(0, true);
  const sign = f < 0 || Object.is(f, -0) ? 0x8000 : 0;
  const abs = Math.abs(f);
  if (abs === 0) return [sign, 0];
  const exponent = Math.floor(Math.log2(abs));
  const mantissa = Math.round((abs / 2 ** exponent - 1) * 1024);
  const bits = sign | ((exponent + 15) << 10) | (mantissa & 0x3ff);
  return [bits & 0xff, (bits >> 8) & 0xff];
}

function tensor(name: string, dims: number[], dataType: number, payload: number[]): number[] {
  return join([dims.map((dim) => vint(1, dim)), vint(2, dataType), len(8, name), len(9, payload)]);
}

function q4Tensor(name: string, N: number, blocks: number, blockBytes: number): number[] {
  const payload = Array.from({ length: N * blocks * blockBytes }, (_unused, index) => index % 251);
  return tensor(name, [N, blocks, blockBytes], 2, payload);
}

test('the parser reads the graph the kernels need, including a negative attribute', () => {
  const hidden = 8;
  const vocab = 4;
  const K = hidden;
  const N = hidden * 2;
  const block = 4;
  const blocks = K / block;

  const q4Name = 'onnx::Q4';
  const scaleName = 'onnx::scales';
  const qkvName = 'onnx::qkv';
  const qkvScales = 'onnx::qkv_scales';
  const headQ4 = 'onnx::head_q4';
  const headScales = 'onnx::head_scales';

  // 2 x 4-bit weights per byte, one f16 scale per 4-value block.
  const q4 = q4Tensor(q4Name, N, blocks, block / 2);
  const f16One = (count: number): number[] =>
    Array.from({ length: count * 2 }, (_unused, index) => (index % 2 === 0 ? 0x00 : 0x3c));
  const scales = tensor(scaleName, [N, blocks], 10, f16One(N * blocks));
  const qkv = q4Tensor(qkvName, N, blocks, block / 2);
  const qkvScale = tensor(qkvScales, [N, blocks], 10, f16One(N * blocks));
  const head = q4Tensor(headQ4, vocab, blocks, block / 2);
  const headScale = tensor(headScales, [vocab, blocks], 10, f16One(vocab * blocks));
  const embed = tensor('model.model.embed_tokens.weight', [vocab, hidden], 10,
    Array.from({ length: vocab * hidden }, (_unused, index) => f16bits(index).flat()).flat());
  const normWeight = tensor('onnx::norm_w', [hidden], 10,
    Array.from({ length: hidden }, (_unused, index) => f16bits(1 + index / 10)).flat());
  const qNorm = tensor('onnx::q_norm_w', [block], 10, Array.from({ length: block }, () => f16bits(0.5)).flat());
  const freqs = tensor('onnx::inv_freq', [2], 1, bytes(new Uint8Array(new Float32Array([1, 0.5]).buffer)));

  const matmul = (name: string, inputs: string[], n: number, attrs: number[][] = []): number[] =>
    join([
      inputs.map((input) => len(1, input)),
      len(2, `${name}_out`),
      len(3, name),
      len(4, 'MatMulNBits'),
      ...attrs,
      len(5, join([len(1, 'K'), vint(3, K)])),
      len(5, join([len(1, 'N'), vint(3, n)])),
      len(5, join([len(1, 'bits'), vint(3, 4)])),
      len(5, join([len(1, 'block_size'), vint(3, block)])),
      // A negative axis, which ONNX writes as a ten-byte varint.
      len(5, join([len(1, 'axis'), vint(3, -2)]))
    ]);
  // The graph multiplies the weight first: Mul(weight, normalized).
  const normNode = (name: string, input: string, weight: string): number[] =>
    join([len(1, weight), len(1, input), len(2, `${name}_out`), len(3, name), len(4, 'Mul')]);

  const nodes = [
    matmul('/model/model/layers/layers.0/mixer/qkv_proj/MatMul_Q4', ['x', qkvName, qkvScales], N),
    matmul('lm_head/MatMul_Q4', ['y', headQ4, headScales], vocab),
    normNode('/model/model/layers/layers.0/pre_mixer_norm/Mul_1', 'x', 'onnx::norm_w'),
    normNode('/model/model/layers/layers.0/post_mixer_norm/Mul_1', 'x', 'onnx::norm_w'),
    normNode('/model/model/layers/layers.0/pre_mlp_norm/Mul_1', 'x', 'onnx::norm_w'),
    normNode('/model/model/layers/layers.0/post_mlp_norm/Mul_1', 'x', 'onnx::norm_w'),
    normNode('/model/model/layers/layers.0/mixer/q_norm/Mul_1', 'q', 'onnx::q_norm_w'),
    normNode('/model/model/layers/layers.0/mixer/k_norm/Mul_1', 'k', 'onnx::q_norm_w'),
    normNode('/model/model/norm/Mul_1', 'x', 'onnx::norm_w'),
    // The layer's o/gate_up/down matrices still have to exist for the parser.
    matmul('/model/model/layers/layers.0/mixer/o_proj/MatMul_Q4', ['a', qkvName, qkvScales], N),
    matmul('/model/model/layers/layers.0/mlp/gate_up_proj/MatMul_Q4', ['a', qkvName, qkvScales], N),
    matmul('/model/model/layers/layers.0/mlp/down_proj/MatMul_Q4', ['a', qkvName, qkvScales], N),
    // Einsum whose second input is the per-layer frequency constant.
    join([len(1, 'pos'), len(1, 'onnx::inv_freq'), len(2, 'rope_out'), len(3, '/model/model/layers/layers.0/mixer/rotary_emb/Einsum'), len(4, 'Einsum')])
  ];

  const initializers = [q4, scales, qkv, qkvScale, head, headScale, embed, normWeight, qNorm, freqs];
  const graph = join([
    nodes.map((node) => len(1, node)),
    len(2, 'fixture'),
    initializers.map((init) => len(5, init))
  ]);
  const model = join([vint(1, 8), len(2, 'fixture'), len(7, graph), vint(8, 17)]);
  const buffer = new Uint8Array(model).buffer;

  const parsed = onnxweights.parse(buffer);
  assert.equal(parsed.vocab, vocab);
  assert.equal(parsed.hidden, hidden);
  assert.equal(parsed.layers.length, 1, 'one decoder layer found by its pre-mixer norm');
  const layer = parsed.layers[0];
  assert.equal(layer.qkv.N, N);
  assert.equal(layer.qkv.K, K);
  assert.equal(layer.qkv.block, block);
  assert.equal(layer.qkv.q4.length, N * blocks * (block / 2), 'the q4 payload is a view of the right size');
  assert.equal(layer.qkv.q4[0], 0, 'and starts at the tensor payload');
  assert.equal(layer.qkv.q4[5], 5, 'with the bytes in file order');
  assert.equal(layer.qkv.scales.length, N * blocks, 'one scale per block');
  assert.equal(layer.qkv.scales[0], 1, 'f16 1.0 widened to f32');
  assert.deepEqual(Array.from(layer.invFreq), [1, 0.5], 'the per-layer frequencies come from the Einsum input');
  const preMixer = layer.preMixer as Float32Array;
  assert.deepEqual(Array.from(preMixer).slice(0, 2).map((v) => Math.round(v * 1000) / 1000), [1, 1.1]);
  assert.equal(parsed.head.N, vocab);
  assert.equal(parsed.finalNorm.length, hidden);
  assert.equal(onnxweights.f16(0x3c00), 1, 'binary16 one');
  assert.equal(onnxweights.f16(0x0001) > 0, true, 'subnormals stay positive');
});

test('the parser refuses a graph it cannot serve, instead of half-answering', () => {
  const graph = join([len(2, 'empty')]);
  const model = join([vint(1, 8), len(7, graph)]);
  assert.throws(() => onnxweights.parse(new Uint8Array(model).buffer), /no decoder layers/);
  assert.throws(() => onnxweights.parse(new Uint8Array(join([vint(1, 8)])).buffer), /no graph/);
});

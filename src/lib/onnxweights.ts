// Reading the shipped ONNX graph's weights without ONNX Runtime: a focused
// protobuf reader for exactly what the kernels need - the initializers, the
// MatMulNBits attributes that name a matrix, the norm weight of each Mul node,
// and the per-layer RoPE constant.
//
// The graph is ~673 MB and the q4 payloads are 363 MB of it, so the big tensors
// stay views into the parsed buffer. Only the small f16 scale, norm and
// frequency tensors are widened to f32 once.
//
// Load after lib/constants.js.
namespace AT.onnxweights {
  /** One 4-bit matrix exactly as ORT packs it: uint8 nibbles, block 128, one
   *  f16 scale per block (widened here), symmetric `(q - 8) * scale`. */
  export type QMatrix = {
    q4: Uint8Array;
    scales: Float32Array;
    /** Output rows (the matmul's N). */
    N: number;
    /** Input columns (the matmul's K). */
    K: number;
    block: number;
  };

  export type LayerWeights = {
    qkv: QMatrix;
    o: QMatrix;
    gateUp: QMatrix;
    down: QMatrix;
    preMixer: Float32Array;
    postMixer: Float32Array;
    preMlp: Float32Array;
    postMlp: Float32Array;
    qNorm: Float32Array;
    kNorm: Float32Array;
    /** 64 frequencies, per layer: the graph is the only place they live. */
    invFreq: Float32Array;
  };

  export type ModelWeights = {
    embed: Uint16Array;
    vocab: number;
    hidden: number;
    layers: LayerWeights[];
    head: QMatrix;
    finalNorm: Float32Array;
  };

  const VARINT = 0;
  const LEN = 2;
  const FIXED32 = 5;
  const FIXED64 = 1;

  /** A cursor over one protobuf message inside the model buffer. */
  class Reader {
    readonly bytes: Uint8Array;
    readonly view: DataView;
    offset: number;

    constructor(buffer: ArrayBuffer, offset = 0, length?: number) {
      this.bytes = new Uint8Array(buffer, offset, length ?? buffer.byteLength - offset);
      this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
      this.offset = 0;
    }

    get done(): boolean {
      return this.offset >= this.bytes.byteLength;
    }

    varint(): number {
      // ONNX writes negative int64 (an `axis: -2`, say) as a ten-byte
      // two's-complement varint, so this has to read 64 bits before deciding
      // the sign; a 2^53 float accumulate would both overflow and mis-sign it.
      let result = 0n;
      let shift = 0n;
      for (;;) {
        const byte = this.view.getUint8(this.offset);
        this.offset += 1;
        result |= BigInt(byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) break;
        shift += 7n;
        if (shift > 63n) throw new Error('onnx: varint too long');
      }
      const signed = result >= 2n ** 63n ? result - 2n ** 64n : result;
      return Number(signed);
    }

    tag(): { field: number; wire: number } {
      const value = this.varint();
      return { field: Math.floor(value / 8), wire: value % 8 };
    }

    skip(wire: number): void {
      if (wire === VARINT) this.varint();
      else if (wire === FIXED64) this.offset += 8;
      else if (wire === LEN) {
        // Read the length first: `this.offset += this.varint()` would use the
        // offset from before the length prefix and drift by one byte per field.
        const length = this.varint();
        this.offset += length;
      } else if (wire === FIXED32) this.offset += 4;
      else throw new Error(`onnx: unsupported wire type ${wire} at byte ${this.bytes.byteOffset + this.offset}`);
    }

    /** Absolute offset (inside `buffer`) and length of a length-delimited field. */
    sub(wire: number): { offset: number; length: number } {
      if (wire !== LEN) throw new Error('onnx: expected a length-delimited field');
      const length = this.varint();
      const at = this.offset;
      this.offset += length;
      if (at + length > this.bytes.byteLength) throw new Error('onnx: field runs past its message');
      return { offset: this.bytes.byteOffset + at, length };
    }

    text(wire: number): string {
      const { offset, length } = this.sub(wire);
      return new TextDecoder().decode(new Uint8Array(this.bytes.buffer, offset, length));
    }
  }

  type Tensor = {
    dims: number[];
    dataType: number;
    /** Payload position for raw_data tensors; -1 when stored elsewhere. */
    offset: number;
    length: number;
    floats: Float32Array | null;
    ints: Int32Array | null;
  };

  type Attribute = { name: string; i: number | null; tensor: Tensor | null };

  type Node = {
    name: string;
    opType: string;
    inputs: string[];
    outputs: string[];
    attributes: Map<string, Attribute>;
  };

  /** Binary16 bit pattern to number (the embedding table is f16). */
  export function f16(bits: number): number {
    const sign = bits & 0x8000 ? -1 : 1;
    const exponent = (bits >> 10) & 0x1f;
    const mantissa = bits & 0x3ff;
    if (exponent === 0) return sign * mantissa * 2 ** -24;
    if (exponent === 31) return mantissa ? NaN : sign * Infinity;
    return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
  }

  function parseTensor(buffer: ArrayBuffer, offset: number, length: number): Tensor {
    const reader = new Reader(buffer, offset, length);
    const tensor: Tensor = { dims: [], dataType: 0, offset: -1, length: 0, floats: null, ints: null };
    while (!reader.done) {
      const { field, wire } = reader.tag();
      if (field === 1) {
        if (wire === LEN) {
          const packed = reader.sub(wire);
          const inner = new Reader(buffer, packed.offset, packed.length);
          while (!inner.done) tensor.dims.push(inner.varint());
        } else {
          tensor.dims.push(reader.varint());
        }
      } else if (field === 2) tensor.dataType = reader.varint();
      else if (field === 4) {
        const raw = reader.sub(wire);
        tensor.floats = new Float32Array(buffer.slice(raw.offset, raw.offset + raw.length));
      } else if (field === 5) {
        const raw = reader.sub(wire);
        tensor.ints = new Int32Array(buffer.slice(raw.offset, raw.offset + raw.length));
      } else if (field === 9) {
        const raw = reader.sub(wire);
        tensor.offset = raw.offset;
        tensor.length = raw.length;
      } else reader.skip(wire);
    }
    return tensor;
  }

  function parseAttribute(buffer: ArrayBuffer, offset: number, length: number): Attribute {
    const reader = new Reader(buffer, offset, length);
    const attribute: Attribute = { name: '', i: null, tensor: null };
    while (!reader.done) {
      const { field, wire } = reader.tag();
      if (field === 1) attribute.name = reader.text(wire);
      else if (field === 3) attribute.i = reader.varint();
      else if (field === 5) {
        const raw = reader.sub(wire);
        attribute.tensor = parseTensor(buffer, raw.offset, raw.length);
      } else reader.skip(wire);
    }
    return attribute;
  }

  function parseNode(buffer: ArrayBuffer, offset: number, length: number): Node {
    const reader = new Reader(buffer, offset, length);
    const node: Node = { name: '', opType: '', inputs: [], outputs: [], attributes: new Map() };
    const attributeRefs: { offset: number; length: number }[] = [];
    while (!reader.done) {
      const { field, wire } = reader.tag();
      if (field === 1) node.inputs.push(reader.text(wire));
      else if (field === 2) node.outputs.push(reader.text(wire));
      else if (field === 3) node.name = reader.text(wire);
      else if (field === 4) node.opType = reader.text(wire);
      else if (field === 5) attributeRefs.push(reader.sub(wire));
      else reader.skip(wire);
    }
    for (const ref of attributeRefs) {
      const attribute = parseAttribute(buffer, ref.offset, ref.length);
      node.attributes.set(attribute.name, attribute);
    }
    return node;
  }

  /** The `name` field of a TensorProto, read without touching its payload. */
  function tensorName(buffer: ArrayBuffer, offset: number, length: number): string {
    const reader = new Reader(buffer, offset, length);
    let name = '';
    while (!reader.done) {
      const { field, wire } = reader.tag();
      name = field === 8 ? reader.text(wire) : (reader.skip(wire), name);
    }
    return name;
  }

  /** A tensor's values as f32, whichever of the three encodings was used. */
  function asFloats(buffer: ArrayBuffer, tensor: Tensor): Float32Array {
    if (tensor.floats) return tensor.floats;
    const count = tensor.dims.reduce((total, dim) => total * dim, 1);
    if (tensor.dataType === 1) {
      // float32 raw_data
      return new Float32Array(buffer.slice(tensor.offset, tensor.offset + tensor.length));
    }
    // float16: raw_data bytes or the bit patterns in int32_data
    const source = tensor.length > 0
      ? buffer.slice(tensor.offset, tensor.offset + tensor.length)
      : tensor.ints
        ? tensor.ints.buffer.slice(tensor.ints.byteOffset, tensor.ints.byteOffset + tensor.ints.byteLength)
        : new ArrayBuffer(0);
    const bits = new Uint16Array(source);
    const out = new Float32Array(count);
    for (let i = 0; i < count; i += 1) out[i] = f16(bits[i] ?? 0);
    return out;
  }

  /** The embedding table as f16 bits, as a view when the payload is aligned. */
  function asUint16(buffer: ArrayBuffer, tensor: Tensor): Uint16Array {
    const count = tensor.dims.reduce((total, dim) => total * dim, 1);
    if (tensor.length > 0 && tensor.offset % 2 === 0) return new Uint16Array(buffer, tensor.offset, count);
    const source = tensor.length > 0
      ? buffer.slice(tensor.offset, tensor.offset + tensor.length)
      : new ArrayBuffer(count * 2);
    return new Uint16Array(source, 0, count);
  }

  function matrix(buffer: ArrayBuffer, node: Node, initializers: Map<string, Tensor>): QMatrix {
    const K = Number(node.attributes.get('K')?.i ?? 0);
    const N = Number(node.attributes.get('N')?.i ?? 0);
    const block = Number(node.attributes.get('block_size')?.i ?? 128);
    const q4 = initializers.get(node.inputs[1] ?? '');
    const scale = initializers.get(node.inputs[2] ?? '');
    if (!q4 || !scale) throw new Error(`onnx: matrix ${node.name} has no packed weights`);
    return { q4: new Uint8Array(buffer, q4.offset, q4.length), scales: asFloats(buffer, scale), N, K, block };
  }

  /** Parses the graph into the tensors the kernels consume. */
  export function parse(buffer: ArrayBuffer): ModelWeights {
    const root = new Reader(buffer);
    let graph: { offset: number; length: number } | null = null;
    while (!root.done) {
      const { field, wire } = root.tag();
      if (field === 7) graph = root.sub(wire);
      else root.skip(wire);
    }
    if (!graph) throw new Error('onnx: the model has no graph');

    const graphReader = new Reader(buffer, graph.offset, graph.length);
    const nodes: Node[] = [];
    const initializers = new Map<string, Tensor>();
    const refs: { offset: number; length: number }[] = [];
    while (!graphReader.done) {
      const { field, wire } = graphReader.tag();
      if (field === 1) refs.push(graphReader.sub(wire));
      else if (field === 5) {
        const raw = graphReader.sub(wire);
        const name = tensorName(buffer, raw.offset, raw.length);
        initializers.set(name, parseTensor(buffer, raw.offset, raw.length));
      } else graphReader.skip(wire);
    }
    for (const ref of refs) nodes.push(parseNode(buffer, ref.offset, ref.length));

    const constants = new Map<string, Tensor>();
    for (const node of nodes) {
      if (node.opType !== 'Constant') continue;
      const value = node.attributes.get('value')?.tensor;
      if (value && node.outputs[0]) constants.set(node.outputs[0], value);
    }
    const tensorOf = (name: string | undefined): Tensor | null => {
      if (!name) return null;
      return initializers.get(name) ?? constants.get(name) ?? null;
    };

    const bySuffix = (suffix: string): Node => {
      for (const node of nodes) if (node.name.endsWith(suffix)) return node;
      throw new Error(`onnx: no node ending with ${suffix}`);
    };
    const weightOf = (node: Node): Float32Array => {
      const tensor = tensorOf(node.inputs[0]);
      if (!tensor) throw new Error(`onnx: ${node.name} has no weight tensor`);
      return asFloats(buffer, tensor);
    };

    let layerCount = 0;
    for (const node of nodes) if (/\/layers\/layers\.\d+\/pre_mixer_norm\/Mul_1$/.test(node.name)) layerCount += 1;
    if (layerCount === 0) throw new Error('onnx: no decoder layers found');

    const layers: LayerWeights[] = [];
    for (let index = 0; index < layerCount; index += 1) {
      const prefix = `layers.${index}`;
      const einsum = bySuffix(`${prefix}/mixer/rotary_emb/Einsum`);
      const frequencies = tensorOf(einsum.inputs[1]);
      if (!frequencies) throw new Error(`onnx: layer ${index} has no RoPE frequencies`);
      layers.push({
        qkv: matrix(buffer, bySuffix(`${prefix}/mixer/qkv_proj/MatMul_Q4`), initializers),
        o: matrix(buffer, bySuffix(`${prefix}/mixer/o_proj/MatMul_Q4`), initializers),
        gateUp: matrix(buffer, bySuffix(`${prefix}/mlp/gate_up_proj/MatMul_Q4`), initializers),
        down: matrix(buffer, bySuffix(`${prefix}/mlp/down_proj/MatMul_Q4`), initializers),
        preMixer: weightOf(bySuffix(`${prefix}/pre_mixer_norm/Mul_1`)),
        postMixer: weightOf(bySuffix(`${prefix}/post_mixer_norm/Mul_1`)),
        preMlp: weightOf(bySuffix(`${prefix}/pre_mlp_norm/Mul_1`)),
        postMlp: weightOf(bySuffix(`${prefix}/post_mlp_norm/Mul_1`)),
        qNorm: weightOf(bySuffix(`${prefix}/mixer/q_norm/Mul_1`)),
        kNorm: weightOf(bySuffix(`${prefix}/mixer/k_norm/Mul_1`)),
        invFreq: asFloats(buffer, frequencies)
      });
    }

    const embed = tensorOf('model.model.embed_tokens.weight');
    if (!embed) throw new Error('onnx: no embedding table');
    return {
      embed: asUint16(buffer, embed),
      vocab: embed.dims[0] ?? 0,
      hidden: embed.dims[1] ?? 0,
      layers,
      head: matrix(buffer, bySuffix('lm_head/MatMul_Q4'), initializers),
      finalNorm: weightOf(bySuffix('/model/model/norm/Mul_1'))
    };
  }
}

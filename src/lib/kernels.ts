// PLaMo 3 Translate kernels: packed ONNX Q4 weights, f32 activations, one submission per
// step including token readback. Pipelines and weight bindings are built once.
//
// Small batches use width-specialized GEMV. Prefill uses a separate tiled GEMM;
// activation rows are independent of the request slots that own the KV cache.
// Mixed steps stay narrow so long prompts do not stall already-decoding jobs.
//
// Graph semantics: 16 layers, hidden 1536, 16 query heads / 1 KV head,
// head_dim 128, MLP 6144, vocabulary 107520, post-sublayer residual norms.
// Load after lib/onnxweights.js, lib/kernelmatmul.js and lib/kernelattention.js.
namespace AT.kernels {
  /** Only what this file calls: the DOM lib has no WebGPU types here. */
  export type GpuBuffer = { destroy?: () => void };
  type GpuQueue = {
    writeBuffer: (buffer: GpuBuffer, offset: number, data: ArrayBufferView | ArrayBuffer) => void;
    submit: (buffers: unknown[]) => void;
    onSubmittedWorkDone: () => Promise<void>;
  };
  export type GpuDevice = {
    queue: GpuQueue;
    features?: { has: (feature: string) => boolean };
    createBuffer: (descriptor: { size: number; usage: number }) => GpuBuffer;
    createShaderModule: (descriptor: { code: string }) => unknown;
    createComputePipeline: (descriptor: { layout: string | unknown; compute: { module: unknown; entryPoint: string } }) => GpuPipeline;
    createPipelineLayout: (descriptor: { bindGroupLayouts: unknown[] }) => unknown;
    createBindGroupLayout: (descriptor: { entries: { binding: number; visibility: number; buffer: { type: string } }[] }) => unknown;
    createBindGroup: (descriptor: { layout: unknown; entries: { binding: number; resource: { buffer: GpuBuffer } }[] }) => unknown;
    createCommandEncoder: () => GpuEncoder;
    limits: { maxStorageBufferBindingSize: number };
    pushErrorScope: (filter: 'validation' | 'out-of-memory' | 'internal') => void;
    popErrorScope: () => Promise<{ message: string } | null>;
  };
  type GpuPipeline = { getBindGroupLayout: (index: number) => unknown };
  type GpuPass = {
    setPipeline: (pipeline: GpuPipeline) => void;
    setBindGroup: (index: number, group: unknown) => void;
    dispatchWorkgroups: (x: number, y?: number) => void;
    end: () => void;
  };
  type GpuEncoder = {
    beginComputePass: () => GpuPass;
    copyBufferToBuffer: (from: GpuBuffer, fromOffset: number, to: GpuBuffer, toOffset: number, size: number) => void;
    finish: () => unknown;
  };
  type Mappable = GpuBuffer & {
    mapAsync: (mode: number) => Promise<void>;
    getMappedRange: () => ArrayBuffer;
    unmap: () => void;
  };

  export const USAGE = {
    STORAGE: 0x0080,
    UNIFORM: 0x0040,
    COPY_DST: 0x0008,
    COPY_SRC: 0x0004,
    MAP_READ: 0x0001
  };

  export type GpuAdapter = {
    features: { has: (feature: string) => boolean };
    limits?: { maxStorageBufferBindingSize: number };
    info?: {
      subgroupMinSize?: number;
      subgroupMaxSize?: number;
      subgroupMatrixConfigs?: readonly {
        M: number; N: number; K: number;
        componentType: string; resultComponentType: string;
      }[];
    };
    requestDevice: (options?: { requiredFeatures: string[]; requiredLimits?: { maxStorageBufferBindingSize: number } }) => Promise<GpuDevice>;
  };

  /** Request only advertised capabilities. No browser flags or platform guesses. */
  export async function openDevice(adapter: GpuAdapter): Promise<{ device: GpuDevice; matrixSubgroupSize: number }> {
    const features: string[] = [];
    if (adapter.features.has('shader-f16')) features.push('shader-f16');
    if (adapter.features.has('subgroups')) features.push('subgroups');
    const info = adapter.info;
    const size = info?.subgroupMaxSize ?? 0;
    const matrix = adapter.features.has('chromium-experimental-subgroup-matrix') &&
      adapter.features.has('subgroups') && (size === 32 || size === 64) &&
      info?.subgroupMinSize === size && info.subgroupMatrixConfigs?.some((config) =>
        config.M === 8 && config.N === 8 && config.K === 8 &&
        config.componentType === 'f32' && config.resultComponentType === 'f32');
    if (matrix) features.push('chromium-experimental-subgroup-matrix');
    // Negotiate the advertised storage binding limit, without browser flags.
    const bindingLimit = adapter.limits?.maxStorageBufferBindingSize;
    const requiredLimits = bindingLimit !== undefined
      ? { maxStorageBufferBindingSize: Math.min(bindingLimit, 256 * 1024 * 1024) } : undefined;
    return {
      device: await adapter.requestDevice({ requiredFeatures: features, ...(requiredLimits ? { requiredLimits } : {}) }),
      matrixSubgroupSize: matrix ? size : 0
    };
  }

  export type MatmulMode = 'auto' | 'portable' | 'f16' | 'matrix';
  export type Execution = {
    matmul: Exclude<MatmulMode, 'auto'>;
    attention: 'tiled' | 'decode';
    prefillPositions: number;
    mixedPositions: number;
  };

  export type Geometry = {
    hidden: number;
    layers: number;
    heads: number;
    headDim: number;
    intermediate: number;
    vocab: number;
    qkvWidth: number;
  };

  export function geometryOf(model: AT.onnxweights.ModelWeights): Geometry {
    const first = model.layers[0];
    if (!first) throw new Error('kernels: the model has no layers');
    const headDim = first.qNorm.length;
    const heads = (first.qkv.N - 2 * headDim) / headDim;
    if (!Number.isInteger(heads) || heads <= 0) throw new Error(`kernels: qkv width ${first.qkv.N} is not a head layout`);
    if (first.gateUp.N % 2 !== 0) throw new Error(`kernels: gate_up width ${first.gateUp.N} is odd`);
    return {
      hidden: model.hidden,
      layers: model.layers.length,
      heads,
      headDim,
      intermediate: first.gateUp.N / 2,
      vocab: model.vocab,
      qkvWidth: first.qkv.N
    };
  }

  /** Largest small-batch GEMV specialization; larger tiles use GEMM. */
  export const POSITIONS = 8;
  /** Independent request slots; prefill tile width is configured separately. */
  export const MAX_ROWS = POSITIONS;
  /** The sliding window the attention mask applies. */
  const WINDOW = 2048;

  /** First-layer RMSNorm over contiguous embedding rows. */
  const RMSNORM = `
    struct Info { n: u32, rows: u32 };
    @group(0) @binding(0) var<storage, read> x: array<f32>;
    @group(0) @binding(1) var<storage, read> w: array<f32>;
    @group(0) @binding(2) var<storage, read_write> y: array<f32>;
    @group(0) @binding(3) var<uniform> info: Info;
    var<workgroup> sums: array<f32, 128>;
    @compute @workgroup_size(128)
    fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
      let row = min(wg.x, info.rows - 1u);
      let lane = lid.x;
      let base = row * info.n;
      var acc: f32 = 0.0;
      for (var i: u32 = lane; i < info.n; i = i + 128u) {
        let v = x[base + i];
        acc = acc + v * v;
      }
      sums[lane] = acc;
      workgroupBarrier();
      var stride: u32 = 64u;
      loop {
        if (stride == 0u) { break; }
        if (lane < stride) { sums[lane] = sums[lane] + sums[lane + stride]; }
        workgroupBarrier();
        stride = stride / 2u;
      }
      let inv = 1.0 / sqrt(sums[0] / f32(info.n) + 1e-6);
      for (var i: u32 = lane; i < info.n; i = i + 128u) {
        y[row * info.n + i] = quantizeToF16(quantizeToF16(x[base + i] * inv) * w[i]);
      }
    }
  `;

  /** Post-normalization → residual sum → next pre-normalization. The same
   *  lane owns each residual element across both reductions, including its
   *  storage write/read. Both RMS reductions preserve the original tree. */
  const NORM_CHAIN = `
    struct Info { n: u32, rows: u32 };
    @group(0) @binding(0) var<storage, read> x: array<f32>;
    @group(0) @binding(1) var<storage, read> post: array<f32>;
    @group(0) @binding(2) var<storage, read> residual: array<f32>;
    @group(0) @binding(3) var<storage, read> pre: array<f32>;
    @group(0) @binding(4) var<storage, read_write> combined: array<f32>;
    @group(0) @binding(5) var<storage, read_write> y: array<f32>;
    @group(0) @binding(6) var<uniform> info: Info;
    var<workgroup> sums: array<f32, 128>;
    fn inverseRms(acc: f32, lane: u32) -> f32 {
      // Every invocation must consume the previous reduction before reuse.
      workgroupBarrier();
      sums[lane] = acc;
      workgroupBarrier();
      var stride: u32 = 64u;
      loop {
        if (stride == 0u) { break; }
        if (lane < stride) { sums[lane] = sums[lane] + sums[lane + stride]; }
        workgroupBarrier();
        stride = stride / 2u;
      }
      return 1.0 / sqrt(sums[0] / f32(info.n) + 1e-6);
    }
    @compute @workgroup_size(128)
    fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
      let base = wg.x * info.n;
      let lane = lid.x;
      var acc: f32 = 0.0;
      for (var i = lane; i < info.n; i += 128u) {
        let v = x[base + i];
        acc = acc + v * v;
      }
      let postInv = inverseRms(acc, lane);
      acc = 0.0;
      for (var i = lane; i < info.n; i += 128u) {
        let normalized = quantizeToF16(quantizeToF16(x[base + i] * postInv) * post[i]);
        let v = quantizeToF16(residual[base + i] + normalized);
        combined[base + i] = v;
        acc = acc + v * v;
      }
      let preInv = inverseRms(acc, lane);
      for (var i = lane; i < info.n; i += 128u) {
        y[base + i] = quantizeToF16(quantizeToF16(combined[base + i] * preInv) * pre[i]);
      }
    }
  `;

  /** GPU-only transpose: each vec4 holds the same word from four output rows.
   *  Padded output rows duplicate the last valid row; no weight precision changes. */
  const PACK_GEMV = `
    struct Info { n: u32, wordsPerRow: u32, vectors: u32, pad: u32 };
    @group(0) @binding(0) var<storage, read> src: array<u32>;
    @group(0) @binding(1) var<storage, read_write> dst: array<vec4<u32>>;
    @group(0) @binding(2) var<uniform> info: Info;
    @compute @workgroup_size(256)
    fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
      let at = (wg.y * 4096u + wg.x) * 256u + lid.x;
      if (at >= info.vectors) { return; }
      let row = (at / info.wordsPerRow) * 4u;
      let word = at % info.wordsPerRow;
      dst[at] = vec4<u32>(
        src[min(row, info.n - 1u) * info.wordsPerRow + word],
        src[min(row + 1u, info.n - 1u) * info.wordsPerRow + word],
        src[min(row + 2u, info.n - 1u) * info.wordsPerRow + word],
        src[min(row + 3u, info.n - 1u) * info.wordsPerRow + word]);
    }
  `;

  /** Eight outputs, 32 threads; each accumulator vector spans four outputs.
   *  Widths one/two factor the Q4 scale outside each eight-nibble block sum.
   *  Wider batches reuse scaled weights instead: additional block accumulators
   *  regressed them. F32 association changes, but final lane sums are unchanged. */
  function gemvWgsl(width: number): string {
    const factorScale = width <= 2;
    const outputs = ['A', 'B', 'C', 'D'];
    const decl = Array.from({ length: width }, (_unused, r) =>
      `var acc${r}: vec4<f32> = vec4<f32>(0.0);`).join('\n');
    const blockDecl = factorScale ? Array.from({ length: width }, (_unused, r) =>
      `var block${r}: vec4<f32> = vec4<f32>(0.0);`).join('\n') : '';
    const foldScale = factorScale ? Array.from({ length: width }, (_unused, r) =>
      `acc${r} = fma(block${r}, scale, acc${r});`).join('\n') : '';
    const rowDecl = outputs.map((s, i) =>
      `let row${s} = min(rawRow + ${i}u, info.n - 1u);`).join('\n');
    const scaleDecl = `let scale = vec4<f32>(${outputs.map(s =>
      `scales[row${s} * info.blocks + b]`).join(', ')});`;
    const loadActivations = Array.from({ length: width }, (_unused, r) =>
      `let activation${r} = x[(${r}u * info.k + at) / 4u];`).join('\n');
    const accumulate = Array.from({ length: width }, (_unused, r) =>
      `${factorScale ? 'block' : 'acc'}${r} = fma(weight, vec4<f32>(activation${r}[component]), ${factorScale ? 'block' : 'acc'}${r});`).join('\n');
    const store = Array.from({ length: width }, (_unused, r) =>
      outputs.map((_s, i) =>
        `partial[((tileRow + ${i}u) * ${width}u + ${r}u) * 16u + lane] = acc${r}[${i}];`).join('\n')).join('\n');
    return `
    struct Info { n: u32, k: u32, blocks: u32, rows: u32 };
    @group(0) @binding(0) var<storage, read> q4: array<vec4<u32>>;
    @group(0) @binding(1) var<storage, read> scales: array<f32>;
    @group(0) @binding(2) var<storage, read> x: array<vec4<f32>>;
    @group(0) @binding(3) var<storage, read_write> y: array<f32>;
    @group(0) @binding(4) var<uniform> info: Info;
    var<workgroup> partial: array<f32, 8 * ${width} * 16>;
    @compute @workgroup_size(32)
    fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>,
      @builtin(num_workgroups) grid: vec3<u32>) {
      let firstRow = (wg.y * grid.x + wg.x) * 8u;
      if (firstRow >= info.n) { return; }
      let t = lid.x;
      let tileRow = (t / 16u) * 4u;
      let lane = t % 16u;
      let rawRow = firstRow + tileRow;
      let packedRow = min(rawRow / 4u, (info.n - 1u) / 4u);
      ${rowDecl}
      ${decl}
      for (var b: u32 = 0u; b < info.blocks; b = b + 1u) {
        let words = q4[(packedRow * info.blocks + b) * 16u + lane];
        ${scaleDecl}
        ${blockDecl}
        for (var j: u32 = 0u; j < 8u; j = j + 4u) {
          let at = b * 128u + lane * 8u + j;
          ${loadActivations}
          for (var component: u32 = 0u; component < 4u; component = component + 1u) {
            let shift = vec4<u32>((j + component) * 4u);
            let weight = (vec4<f32>((words >> shift) & vec4<u32>(15u)) - vec4<f32>(8.0))${factorScale ? '' : ' * scale'};
            ${accumulate}
          }
        }
        ${foldScale}
      }
      ${store}
      workgroupBarrier();
      for (var output: u32 = t; output < 8u * ${width}u; output = output + 32u) {
        let tile = output / ${width}u;
        let p = output % ${width}u;
        let outRow = firstRow + tile;
        if (outRow < info.n) {
          var sum: f32 = 0.0;
          for (var i: u32 = 0u; i < 16u; i = i + 1u) {
            sum = sum + partial[(tile * ${width}u + p) * 16u + i];
          }
          y[p * info.n + outRow] = quantizeToF16(sum);
        }
      }
    }
    `;
  }


  /** Fuse 128-wide Q RMSNorm and RoPE, retaining the graph's FP16 boundaries.
   *  Shared FP32 storage holds values rounded at Cast/Mul boundaries.
   *  Five storage bindings and 1 KiB workgroup storage; no optional features. */
  const NORM_ROPE = `
    struct Info { heads: u32, rows: u32, half: u32, scale: f32, stride: u32, start: u32, pad: u32, pad2: u32 };
    @group(0) @binding(0) var<storage, read> x: array<f32>;
    @group(0) @binding(1) var<storage, read> inv: array<f32>;
    @group(0) @binding(2) var<storage, read_write> y: array<f32>;
    @group(0) @binding(3) var<uniform> info: Info;
    @group(0) @binding(4) var<storage, read> positions: array<u32>;
    @group(0) @binding(5) var<storage, read> w: array<f32>;
    var<workgroup> sums: array<f32, 128>;
    var<workgroup> normalised: array<f32, 128>;
    @compute @workgroup_size(128)
    fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
      let row = min(wg.y, info.rows - 1u);
      let head = min(wg.x, info.heads - 1u);
      let d = lid.x;
      let half = info.half;
      let at = (row * info.heads + head) * 2u * half;
      let src = row * info.stride + info.start + head * 2u * half;
      let v = x[src + d];
      var acc: f32 = 0.0;
      acc = acc + v * v;
      sums[d] = acc;
      workgroupBarrier();
      var stride: u32 = 64u;
      loop {
        if (stride == 0u) { break; }
        if (d < stride) { sums[d] = sums[d] + sums[d + stride]; }
        workgroupBarrier();
        stride = stride / 2u;
      }
      let normInv = 1.0 / sqrt(sums[0] / f32(2u * half) + 1e-6);
      normalised[d] = quantizeToF16(quantizeToF16(v * normInv) * w[d]);
      workgroupBarrier();
      let angle = f32(positions[row]) * inv[d % half];
      let c = quantizeToF16(cos(angle));
      let s = quantizeToF16(sin(angle));
      var out: f32;
      if (d < half) {
        out = quantizeToF16(normalised[d] * c) - quantizeToF16(normalised[d + half] * s);
      } else {
        out = quantizeToF16(normalised[d] * c) + quantizeToF16(normalised[d - half] * s);
      }
      y[at + d] = quantizeToF16(quantizeToF16(out) * quantizeToF16(info.scale));
    }
  `;


  /** y = gate * sigmoid(gate) * up, with the two halves read from one buffer
   *  (the first half is the gate, `half` elements later is up). */
  const SILU_MUL = `
    struct Info { half: u32, row: u32, pad1: u32, pad2: u32 };
    @group(0) @binding(0) var<storage, read> fused: array<f32>;
    @group(0) @binding(1) var<storage, read_write> y: array<f32>;
    @group(0) @binding(2) var<uniform> info: Info;
    @compute @workgroup_size(256)
    fn main(@builtin(global_invocation_id) id: vec3<u32>) {
      let i = id.x;
      if (i >= arrayLength(&y)) { return; }
      // Row-major over the fused projection: the gate is the first half of the
      // row, up is the second.
      let within = i % info.half;
      let row = i / info.half;
      let base = row * 2u * info.half;
      let a = fused[base + within];
      let sigmoid = quantizeToF16(1.0 / (1.0 + exp(-a)));
      y[i] = quantizeToF16(quantizeToF16(a * sigmoid) * fused[base + info.half + within]);
    }
  `;


  /** Split each original argmax lane's scan across 4096-token chunks. The
   *  second pass merges chunks in token order and keeps the original lane
   *  reduction, including its strict-greater tie behavior and NaN handling. */
  const ARGMAX_CHUNK = 4096;
  const ARGMAX_PARTIAL = `
    struct Info { vocab: u32, rows: u32, parts: u32, pad2: u32 };
    struct Pick { value: f32, index: u32 };
    @group(0) @binding(0) var<storage, read> logits: array<f32>;
    @group(0) @binding(1) var<storage, read_write> partials: array<Pick>;
    @group(0) @binding(2) var<uniform> info: Info;
    @compute @workgroup_size(128)
    fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
      let row = wg.y;
      let lane = lid.x;
      let start = wg.x * ${ARGMAX_CHUNK}u;
      let end = min(start + ${ARGMAX_CHUNK}u, info.vocab);
      var value: f32 = -3.0e38;
      var index: u32 = 0u;
      for (var i: u32 = start + lane; i < end; i = i + 128u) {
        let v = logits[row * info.vocab + i];
        if (v > value) { value = v; index = i; }
      }
      partials[(row * info.parts + wg.x) * 128u + lane] = Pick(value, index);
    }
  `;
  const ARGMAX = `
    struct Info { vocab: u32, rows: u32, parts: u32, pad2: u32 };
    struct Pick { value: f32, index: u32 };
    @group(0) @binding(0) var<storage, read> partials: array<Pick>;
    @group(0) @binding(1) var<storage, read_write> tokens: array<u32>;
    @group(0) @binding(2) var<uniform> info: Info;
    var<workgroup> best: array<f32, 128>;
    var<workgroup> bestAt: array<u32, 128>;
    @compute @workgroup_size(128)
    fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
      let row = min(wg.x, info.rows - 1u);
      let lane = lid.x;
      var value: f32 = -3.0e38;
      var index: u32 = 0u;
      for (var part: u32 = 0u; part < info.parts; part = part + 1u) {
        let pick = partials[(row * info.parts + part) * 128u + lane];
        if (pick.value > value) { value = pick.value; index = pick.index; }
      }
      best[lane] = value;
      bestAt[lane] = index;
      workgroupBarrier();
      var stride: u32 = 64u;
      loop {
        if (stride == 0u) { break; }
        if (lane < stride) {
          if (best[lane + stride] > best[lane]) {
            best[lane] = best[lane + stride];
            bestAt[lane] = bestAt[lane + stride];
          }
        }
        workgroupBarrier();
        stride = stride / 2u;
      }
      if (lane == 0u) { tokens[row] = bestAt[0]; }
    }
  `;

  export type Job = {
    id: number;
    /** The KV cache row this request owns while it is in flight. */
    cache: number;
    /** Dropped by the host after a timeout: delivered as cancelled, never ok. */
    cancelled: boolean;
    prompt: number[];
    maxNewTokens: number;
    generated: number[];
    /** Generated ids already read back for scheduling; never triggers GPU work. */
    onProgress?: ((tokens: number[]) => void) | undefined;
    fed: number;
    done: boolean;
    delivered: boolean;
  };

  export type Outcome =
    | { id: number; ok: true; tokens: number[] }
    | { id: number; ok: false; error: string };

  /** Pure phases are accounted separately; mixed work is never charged to one
   *  phase. Times include token readback, not just submitted compute work. */
  export type Stats = {
    prefillTokens: number;
    decodeTokens: number;
    prefillMs: number;
    decodeMs: number;
    mixedMs: number;
    mixedInputTokens: number;
    mixedOutputTokens: number;
  };

  export type StepSample = {
    phase: 'prefill' | 'decode' | 'mixed';
    inputTokens: number;
    outputTokens: number;
    activeRows: number;
    context: number;
    encodeMs: number;
    computeMs: number;
    readbackMs: number;
    wallMs: number;
  };

  export type Runner = {
    /** Queues a request; a cohort starts as soon as one can form. */
    add: (job: { id: number; prompt: number[]; maxNewTokens: number; onProgress?: ((tokens: number[]) => void) | undefined }) => void;
    /** Abandons a queued request; a running cohort keeps its rows. */
    drop: (id: number) => boolean;
    /** Resolves when every queued request has been answered. */
    drain: () => Promise<void>;
    /** Sequences one step carries. */
    rows: () => number;
    /** Cumulative prefill/decode work, for rates. */
    stats: () => Stats;
    execution: () => Execution;
    dispose: () => void;
  };

  /** Uploads every weight once and runs cohorts of up to `rows` sequences. */
  export async function create(options: {
    device: GpuDevice;
    model: AT.onnxweights.ModelWeights;
    maxTokens?: number;
    /** Independent request/KV slots; prefill can use more activation rows. */
    rows?: number;
    coalesceMs?: number;
    prefillPositions?: number;
    /** Total activation rows when decoding and prefilling together, not KV slots. */
    mixedPositions?: number;
    /** Diagnostic overrides; auto uses only capabilities negotiated by openDevice. */
    matmul?: MatmulMode;
    matrixSubgroupSize?: number;
    attention?: 'tiled' | 'decode';
    /** Model-declared sentinels; empty disables stopping for fixed-token diagnostics. */
    eosTokens: readonly number[];
    /** Optional diagnostics; computeMs is wall time, not a GPU timestamp. */
    onStep?: (sample: StepSample) => void;
    /** Profiling: '' (normal), 'nohead', 'noattn', 'onelay'. */
    ablate?: string;
    onDone: (outcome: Outcome) => void;
  }): Promise<Runner> {
    const { device, model, onDone } = options;
    const geometry = geometryOf(model);
    const maxTokens = Math.max(64, Math.min(options.maxTokens ?? 1024, 2048));
    const rows = Math.max(1, Math.min(Math.floor(options.rows ?? 1), MAX_ROWS));
    const capacity = Math.max(rows, Math.min(64, Math.floor(options.prefillPositions ?? 64)));
    const mixedCapacity = Math.max(rows, Math.min(capacity, Math.floor(options.mixedPositions ?? 32)));
    const ablate = options.ablate ?? '';
    const eos = options.eosTokens;
    // 0 normal, 1 skip the value pass, 2 skip the score pass.
    const attnMode = ablate === 'attn_novalue' ? 1 : ablate === 'attn_noscore' ? 2 : 0;
    const coalesceMs = Math.max(0, Math.floor(options.coalesceMs ?? 0));
    const { hidden, heads, headDim, intermediate, qkvWidth, vocab, layers } = geometry;
    const qWidth = heads * headDim;
    if (headDim !== 128 || model.layers.some(layer => layer.kNorm.length !== headDim)) {
      throw new Error('kernels: only 128-wide single-KV-head attention is supported');
    }
    const matrices = [model.head, ...model.layers.flatMap(layer =>
      [layer.qkv, layer.o, layer.gateUp, layer.down])];
    const alignedBytes = (bytes: number): number => Math.max(16, Math.ceil(bytes / 4) * 4);
    for (const matrix of matrices) {
      if (alignedBytes(matrix.q4.byteLength) > device.limits.maxStorageBufferBindingSize) {
        throw new Error(`kernels: packed matrix needs ${matrix.q4.byteLength} bytes; device binding limit is ${device.limits.maxStorageBufferBindingSize}`);
      }
    }
    const matrixSize = options.matrixSubgroupSize ?? 0;
    const hasMatrix = device.features?.has('chromium-experimental-subgroup-matrix') &&
      device.features.has('subgroups') && (matrixSize === 32 || matrixSize === 64);
    const matmul = options.matmul === undefined || options.matmul === 'auto'
      ? (hasMatrix ? 'matrix' : device.features?.has('shader-f16') ? 'f16' : 'portable') : options.matmul;
    if (matmul === 'matrix' && !hasMatrix) {
      throw new Error('kernels: subgroup matrix acceleration unavailable');
    }
    if (matmul === 'f16' && !device.features?.has('shader-f16')) {
      throw new Error('kernels: shader-f16 unavailable');
    }
    const usesMatrix = matmul === 'matrix';
    const tileOutputs = usesMatrix ? AT.kernelmatmul.MATRIX_TILE_OUTPUTS : AT.kernelmatmul.TILE_OUTPUTS;
    const tileRows = usesMatrix ? AT.kernelmatmul.MATRIX_TILE_ROWS : AT.kernelmatmul.TILE_ROWS;
    const execution: Execution = {
      matmul, attention: options.attention ?? 'tiled',
      prefillPositions: capacity, mixedPositions: mixedCapacity
    };

    const held = new Set<GpuBuffer>();
    const own = (buffer: GpuBuffer): GpuBuffer => {
      held.add(buffer);
      return buffer;
    };
    const release = (buffer: GpuBuffer): void => {
      if (!held.delete(buffer)) return;
      buffer.destroy?.();
    };
    const alloc = (bytes: number, extra = 0): GpuBuffer => {
      const buffer = device.createBuffer({
        size: alignedBytes(bytes),
        usage: USAGE.STORAGE | USAGE.COPY_DST | USAGE.COPY_SRC | extra
      });
      return own(buffer);
    };
    const uniform = (): GpuBuffer => {
      // 32 bytes: the norm and rope structures grew when they learned to gather.
      const buffer = device.createBuffer({ size: 32, usage: USAGE.UNIFORM | USAGE.COPY_DST });
      return own(buffer);
    };
    const put = (buffer: GpuBuffer, data: ArrayBufferView): void => device.queue.writeBuffer(buffer, 0, data);
    const pipeline = (code: string, layout: string | unknown = 'auto'): GpuPipeline =>
      device.createComputePipeline({ layout, compute: { module: device.createShaderModule({ code }), entryPoint: 'main' } });
    let scopes = 0;
    const closeScopes = async (): Promise<void> => {
      let failure: unknown;
      while (scopes) {
        scopes--;
        try {
          const error = await device.popErrorScope();
          if (error) failure ??= new Error(error.message);
        } catch (error) { failure ??= error; }
      }
      if (failure) throw failure;
    };
    try {
    for (const filter of ['validation', 'out-of-memory', 'internal'] as const) {
      device.pushErrorScope(filter);
      scopes++;
    }
    const compute = 4;
    const rms = pipeline(RMSNORM);
    const normChain = pipeline(NORM_CHAIN);
    const normRope = pipeline(NORM_ROPE);
    const attention = pipeline(AT.kernelattention.decode(maxTokens * headDim));
    const attentionParts = Math.ceil(maxTokens / AT.kernelattention.DECODE_PARTITION);
    // Explicit layout keeps one bind group usable by both head-group pipelines.
    const partitionLayout = maxTokens > AT.kernelattention.DECODE_SPLIT_MIN
      ? device.createBindGroupLayout({ entries: [
        { binding: 0, visibility: compute, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: compute, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: compute, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: compute, buffer: { type: 'storage' } },
        { binding: 4, visibility: compute, buffer: { type: 'uniform' } },
        { binding: 5, visibility: compute, buffer: { type: 'read-only-storage' } },
        { binding: 6, visibility: compute, buffer: { type: 'read-only-storage' } }
      ] }) : null;
    const partitionPipelineLayout = partitionLayout
      ? device.createPipelineLayout({ bindGroupLayouts: [partitionLayout] }) : null;
    const partitionAttention = partitionPipelineLayout
      ? pipeline(AT.kernelattention.decodePartial(maxTokens * headDim), partitionPipelineLayout) : null;
    const widePartitionAttention = partitionPipelineLayout && rows === MAX_ROWS
      ? pipeline(AT.kernelattention.decodePartial(maxTokens * headDim,
        AT.kernelattention.DECODE_WIDE_HEADS_PER_GROUP), partitionPipelineLayout) : null;
    const mergeAttention = partitionAttention
      ? pipeline(AT.kernelattention.decodeMerge(maxTokens * headDim)) : null;
    const prefillAttention = execution.attention === 'tiled'
      ? pipeline(AT.kernelattention.prefill(maxTokens * headDim, !!device.features?.has('subgroups'))) : null;
    const ropeKV = pipeline(AT.kernelattention.ropeKV(maxTokens * headDim, qkvWidth, heads));
    const silu = pipeline(SILU_MUL);
    const argmax = pipeline(ARGMAX);
    const argmaxPartial = pipeline(ARGMAX_PARTIAL);
    const argmaxParts = Math.ceil(vocab / ARGMAX_CHUNK);
    // One shared layout lets the small-row GEMV and prefill GEMM reuse bindings.
    const gemvLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: compute, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: compute, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: compute, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: compute, buffer: { type: 'storage' } },
        { binding: 4, visibility: compute, buffer: { type: 'uniform' } }
      ]
    });
    const gemvPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [gemvLayout] });
    const gemv = Array.from({ length: POSITIONS }, (_unused, width) =>
      pipeline(gemvWgsl(width + 1), gemvPipelineLayout));
    const gemm = pipeline(usesMatrix
      ? AT.kernelmatmul.matrixGemm(matrixSize)
      : AT.kernelmatmul.portableGemm(matmul === 'f16'), gemvPipelineLayout);
    const wideGemm = matmul === 'f16' && capacity > AT.kernelmatmul.TILE_ROWS
      ? pipeline(AT.kernelmatmul.portableGemm(true, true), gemvPipelineLayout) : null;
    const rowsPerGroup = 8;
    const bindGroup = (children: GpuPipeline | unknown, buffers: GpuBuffer[]): unknown =>
      device.createBindGroup({
        layout: children instanceof Object && 'getBindGroupLayout' in children ? (children as GpuPipeline).getBindGroupLayout(0) : children,
        entries: buffers.map((buffer, index) => ({ binding: index, resource: { buffer } }))
      });

    // One reusable f32 partial buffer for all layers. alloc registers it with
    // held, so runner disposal destroys it together with the activation buffers.
    const attentionScratch = partitionAttention
      ? alloc(capacity * heads * attentionParts * AT.kernelattention.DECODE_PARTIAL_FLOATS * 4) : null;
    const act = {
      x: alloc(capacity * hidden * 4),
      n1: alloc(capacity * hidden * 4),
      qkv: alloc(capacity * qkvWidth * 4),
      qR: alloc(capacity * qWidth * 4),
      attn: alloc(capacity * qWidth * 4),
      o: alloc(capacity * hidden * 4),
      res: alloc(capacity * hidden * 4),
      n2: alloc(capacity * hidden * 4),
      gu: alloc(capacity * intermediate * 2 * 4),
      s: alloc(capacity * intermediate * 4),
      d: alloc(capacity * hidden * 4),
      logits: alloc(rows * vocab * 4),
      argmaxPartial: alloc(rows * argmaxParts * 128 * 8),
      positions: alloc(capacity * 4),
      cacheRows: alloc(capacity * 4),
      tokens: alloc(rows * 4),
      /** The rows whose logits the head is asked for: prefill positions that
       *  end a prompt, and every generating row. */
      headIn: alloc(rows * hidden * 4)
    };
    const staging = device.createBuffer({ size: rows * 4, usage: USAGE.MAP_READ | USAGE.COPY_DST }) as Mappable;
    own(staging);
    const embedded = new Float32Array(capacity * hidden);
    // Exact binary16 conversion once, instead of an exponent operation per element/token.
    const embeddingFloats = Float32Array.from({ length: 65536 }, (_unused, bits) => AT.onnxweights.f16(bits));
    const positionData = new Uint32Array(capacity);
    const cacheRowData = new Uint32Array(capacity);
    const picksBuffer = new Uint32Array(rows);

    // Metadata is written before submit; queue.writeBuffer snapshots its input.
    const meta = {
      gemvQkv: uniform(),
      gemvO: uniform(),
      gemvGu: uniform(),
      gemvDown: uniform(),
      gemvHead: uniform(),
      normHidden: uniform(),
      ropeQ: uniform(),
      ropeK: uniform(),
      attn: uniform(),
      attnPrefill: uniform(),
      silu: uniform(),
      argmax: uniform()
    };
    const rawMeta = new ArrayBuffer(32);
    const metaU32 = new Uint32Array(rawMeta);
    const metaF32 = new Float32Array(rawMeta);
    const setMeta = (target: GpuBuffer, a = 0, b = 0, c = 0, d = 0, e = 0): void => {
      metaU32[0] = a;
      metaU32[1] = b;
      metaU32[2] = c;
      metaU32[3] = d;
      metaU32[4] = e;
      metaU32[5] = metaU32[6] = metaU32[7] = 0;
      put(target, metaU32);
    };
    const putGemv = (target: GpuBuffer, n: number, k: number, active: number): void =>
      setMeta(target, n, k, k / 128, active);
    const putRope = (target: GpuBuffer, headCount: number, active: number): void => {
      metaU32[0] = headCount;
      metaU32[1] = active;
      metaU32[2] = headDim / 2;
      metaU32[4] = qkvWidth;
      metaU32[5] = metaU32[6] = metaU32[7] = 0;
      metaF32[3] = Math.sqrt(1 / Math.sqrt(headDim));
      put(target, metaU32);
    };
    /** The width of the step that is about to run: a lone request costs one
     *  row, a full cohort costs what it uses. Every uniform is rewritten here,
     *  once per step, before the one submit that reads them. */
    const configure = (active: number, headRows: number, decodeRows: number, contextParts: number): void => {
      putGemv(meta.gemvQkv, qkvWidth, hidden, active);
      putGemv(meta.gemvO, hidden, qWidth, active);
      putGemv(meta.gemvGu, intermediate * 2, hidden, active);
      putGemv(meta.gemvDown, hidden, intermediate, active);
      putGemv(meta.gemvHead, vocab, hidden, headRows);
      setMeta(meta.normHidden, hidden, active);
      putRope(meta.ropeQ, heads, active);
      putRope(meta.ropeK, 1, active);
      const splitAttention = active > POSITIONS && prefillAttention !== null;
      setMeta(meta.attn, heads, splitAttention ? decodeRows : active, WINDOW, attnMode, contextParts);
      if (splitAttention) setMeta(meta.attnPrefill, heads, active, WINDOW, attnMode, decodeRows);
      setMeta(meta.silu, intermediate);
      setMeta(meta.argmax, vocab, headRows, argmaxParts);
    };

    const upload = (bytes: Uint8Array): GpuBuffer => {
      const buffer = alloc(bytes.byteLength);
      const aligned = bytes.byteLength - bytes.byteLength % 4;
      if (aligned === bytes.byteLength) device.queue.writeBuffer(buffer, 0, bytes);
      else {
        if (aligned) device.queue.writeBuffer(buffer, 0, bytes.subarray(0, aligned));
        const tail = new Uint8Array(4);
        tail.set(bytes.subarray(aligned));
        device.queue.writeBuffer(buffer, aligned, tail);
      }
      return buffer;
    };
    const uploadFloats = (values: Float32Array): GpuBuffer => {
      const buffer = alloc(values.byteLength);
      device.queue.writeBuffer(buffer, 0, values);
      return buffer;
    };

    const packPipeline = pipeline(PACK_GEMV);
    const packEncoder = device.createCommandEncoder();
    const packTransient: GpuBuffer[] = [];
    const uploadMatrix = (
      matrix: AT.onnxweights.QMatrix, n: number, k: number,
      retainOriginal: boolean
    ): { q4: GpuBuffer; packed: GpuBuffer; scales: GpuBuffer } => {
      const q4 = upload(matrix.q4);
      const scales = uploadFloats(matrix.scales);
      const wordsPerRow = k / 8;
      const vectors = Math.ceil(n / 4) * wordsPerRow;
      const target = alloc(vectors * 16);
      const info = uniform();
      setMeta(info, n, wordsPerRow, vectors);
      const pass = packEncoder.beginComputePass();
      pass.setPipeline(packPipeline);
      pass.setBindGroup(0, bindGroup(packPipeline, [q4, target, info]));
      const groups = Math.ceil(vectors / 256);
      pass.dispatchWorkgroups(Math.min(4096, groups), Math.ceil(groups / 4096));
      pass.end();
      packTransient.push(info);
      // The head always uses GEMV, even during prefill, so its original is temporary.
      if (!retainOriginal) packTransient.push(q4);
      return { q4, packed: target, scales };
    };
    const headWeights = uploadMatrix(model.head, vocab, hidden, false);
    const headBind = bindGroup(gemvLayout, [headWeights.packed, headWeights.scales, act.headIn, act.logits, meta.gemvHead]);
    const directHeadBind = bindGroup(gemvLayout, [headWeights.packed, headWeights.scales, act.n1, act.logits, meta.gemvHead]);
    const finalNorm = uploadFloats(model.finalNorm);
    const siluBind = bindGroup(silu, [act.gu, act.s, meta.silu]);
    const argmaxPartialBind = bindGroup(argmaxPartial, [act.logits, act.argmaxPartial, meta.argmax]);
    const argmaxBind = bindGroup(argmax, [act.argmaxPartial, act.tokens, meta.argmax]);
    const mergeAttentionBind = mergeAttention && attentionScratch
      ? bindGroup(mergeAttention, [attentionScratch, act.attn, meta.attn]) : null;

    const layerState: {
      bind: Record<string, unknown>;
    }[] = [];
    let precedingPostMlp: GpuBuffer | undefined;
    for (let index = 0; index < layers; index += 1) {
      const layer = model.layers[index]!;
      const w = {
        qkv: uploadMatrix(layer.qkv, qkvWidth, hidden, true),
        o: uploadMatrix(layer.o, hidden, qWidth, true),
        gateUp: uploadMatrix(layer.gateUp, intermediate * 2, hidden, true),
        down: uploadMatrix(layer.down, hidden, intermediate, true)
      };
      const norms = {
        preMixer: uploadFloats(layer.preMixer),
        postMixer: uploadFloats(layer.postMixer),
        preMlp: uploadFloats(layer.preMlp),
        postMlp: uploadFloats(layer.postMlp),
        qNorm: uploadFloats(layer.qNorm),
        kNorm: uploadFloats(layer.kNorm)
      };
      const frequencies = uploadFloats(layer.invFreq);
      const kc = alloc(rows * maxTokens * headDim * 4);
      const vc = alloc(rows * maxTokens * headDim * 4);
      layerState.push({
        bind: {
          qkv: bindGroup(gemvLayout, [w.qkv.q4, w.qkv.scales, act.n1, act.qkv, meta.gemvQkv]),
          o: bindGroup(gemvLayout, [w.o.q4, w.o.scales, act.attn, act.o, meta.gemvO]),
          gateUp: bindGroup(gemvLayout, [w.gateUp.q4, w.gateUp.scales, act.n2, act.gu, meta.gemvGu]),
          down: bindGroup(gemvLayout, [w.down.q4, w.down.scales, act.s, act.d, meta.gemvDown]),
          qkvPacked: bindGroup(gemvLayout, [w.qkv.packed, w.qkv.scales, act.n1, act.qkv, meta.gemvQkv]),
          oPacked: bindGroup(gemvLayout, [w.o.packed, w.o.scales, act.attn, act.o, meta.gemvO]),
          gateUpPacked: bindGroup(gemvLayout, [w.gateUp.packed, w.gateUp.scales, act.n2, act.gu, meta.gemvGu]),
          downPacked: bindGroup(gemvLayout, [w.down.packed, w.down.scales, act.s, act.d, meta.gemvDown]),
          preMixer: index === 0 ? bindGroup(rms, [act.x, norms.preMixer, act.n1, meta.normHidden]) : null,
          preMixerChain: precedingPostMlp ? bindGroup(normChain, [act.d, precedingPostMlp, act.res, norms.preMixer, act.x, act.n1, meta.normHidden]) : null,
          preMlpChain: bindGroup(normChain, [act.o, norms.postMixer, act.x, norms.preMlp, act.res, act.n2, meta.normHidden]),
          finalChain: index === 0 || index === layers - 1
            ? bindGroup(normChain, [act.d, norms.postMlp, act.res, finalNorm, act.x, act.n1, meta.normHidden]) : null,
          normRopeQ: bindGroup(normRope, [act.qkv, frequencies, act.qR, meta.ropeQ, act.positions, norms.qNorm]),
          ropeKV: bindGroup(ropeKV, [norms.kNorm, frequencies, kc, vc, act.qkv, act.positions, act.cacheRows, meta.ropeK]),
          attn: bindGroup(attention, [act.qR, kc, vc, act.attn, meta.attn, act.positions, act.cacheRows]),
          partialAttn: partitionAttention && attentionScratch
            ? bindGroup(partitionLayout, [act.qR, kc, vc, attentionScratch, meta.attn, act.positions, act.cacheRows]) : null,
          prefillAttn: prefillAttention
            ? bindGroup(prefillAttention, [act.qR, kc, vc, act.attn, meta.attnPrefill, act.positions, act.cacheRows]) : null
        }
      });
      precedingPostMlp = norms.postMlp;
    }
    device.queue.submit([packEncoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    for (const buffer of packTransient) release(buffer);
    await closeScopes();

    // One-row work shares a compute pass; dispatches remain synchronization scopes.
    // Batched steps retain separate passes because blanket coalescing regressed them.
    let sharedPass: GpuPass | null = null;
    const endSharedPass = (): void => { sharedPass?.end(); sharedPass = null; };
    const emit = (encoder: GpuEncoder, pipe: GpuPipeline, bind: unknown, groups: number | [number, number]): void => {
      const pass = sharedPass ?? encoder.beginComputePass();
      pass.setPipeline(pipe);
      pass.setBindGroup(0, bind);
      if (Array.isArray(groups)) pass.dispatchWorkgroups(groups[0], groups[1]);
      else pass.dispatchWorkgroups(groups);
      if (!sharedPass) pass.end();
    };
    /** Balance the dispatch rectangle instead of rounding its full x extent
     *  up for every y row. The shader skips any final wholly padded tile. */
    const gemvGroups = (n: number): [number, number] => {
      const tiles = Math.max(1, Math.ceil(n / rowsPerGroup));
      const y = Math.ceil(tiles / 4096);
      return [Math.ceil(tiles / y), y];
    };

    /** One step: every row feeds its token at its own position, all layers, the
     *  head, and - when a row is generating - the greedy pick on the device. */
    const step = (
      tokens: number[],
      positions: number[],
      cacheRows: number[],
      active: number,
      collectRows: number[],
      decodeRows: number
    ): void => {
      const headRows = Math.max(1, Math.min(collectRows.length, rows));
      const tiled = active > POSITIONS;
      const attentionRows = tiled && prefillAttention ? decodeRows : active;
      // Four-head KV reuse wins at eight rows, but regresses small batches.
      const useWideAttention = attentionRows === MAX_ROWS && widePartitionAttention !== null;
      const partitionPipe = useWideAttention ? widePartitionAttention : partitionAttention;
      const partitionHeads = useWideAttention ? AT.kernelattention.DECODE_WIDE_HEADS_PER_GROUP
        : AT.kernelattention.DECODE_HEADS_PER_GROUP;
      let longestContext = 0;
      if (partitionAttention && ablate !== 'noattn') {
        for (let row = 0; row < attentionRows; row += 1) {
          const position = (positions[row] ?? 0) >>> 0;
          if (position < maxTokens) {
            longestContext = Math.max(longestContext, Math.min(position + 1, WINDOW));
          }
        }
      }
      const contextParts = longestContext > AT.kernelattention.DECODE_SPLIT_MIN
        ? Math.ceil(longestContext / AT.kernelattention.DECODE_PARTITION) : 0;
      configure(active, headRows, decodeRows, contextParts);
      const wide = wideGemm !== null && active > AT.kernelmatmul.TILE_ROWS;
      const weights = tiled ? (wide ? wideGemm : gemm) : gemv[active - 1]!;
      const weightGroups = (n: number): [number, number] => tiled
        ? [Math.ceil(n / tileOutputs), Math.ceil(active / (wide ? AT.kernelmatmul.WIDE_TILE_ROWS : tileRows))]
        : gemvGroups(n);
      for (let row = 0; row < active; row += 1) {
        const token = tokens[row] ?? 0;
        const base = token * hidden;
        for (let i = 0; i < hidden; i += 1) embedded[row * hidden + i] = embeddingFloats[model.embed[base + i] ?? 0]!;
      }
      device.queue.writeBuffer(act.x, 0, embedded.subarray(0, active * hidden));
      positionData.set(positions);
      cacheRowData.set(cacheRows);
      put(act.positions, positionData);
      put(act.cacheRows, cacheRowData);
      const encoder = device.createCommandEncoder();
      sharedPass = active === 1 ? encoder.beginComputePass() : null;
      const layerCount = ablate === 'onelay' ? 1 : layers;
      for (let index = 0; index < layerCount; index += 1) {
        const state = layerState[index]!;
        const bind = state.bind;
        emit(encoder, index === 0 ? rms : normChain, index === 0 ? bind.preMixer : bind.preMixerChain, active);
        emit(encoder, weights, tiled ? bind.qkv : bind.qkvPacked, weightGroups(qkvWidth));
        // Each preparation dispatch normalises and rotates directly from QKV.
        // KV cache writes finish before either decode or causal prefill reads.
        emit(encoder, normRope, bind.normRopeQ, [heads, active]);
        emit(encoder, ropeKV, bind.ropeKV, [1, active]);
        if (ablate !== 'noattn') {
          if (attentionRows) {
            if (contextParts && partitionPipe && mergeAttention) {
              emit(encoder, partitionPipe, bind.partialAttn,
                [Math.ceil(heads / partitionHeads) * contextParts, attentionRows]);
              emit(encoder, mergeAttention, mergeAttentionBind, [heads, attentionRows]);
            } else {
              emit(encoder, attention, bind.attn, [heads, attentionRows]);
            }
          }
          if (tiled && prefillAttention && active > decodeRows) {
            // Prefill tiles remain independent of the decode partition scratch.
            emit(encoder, prefillAttention, bind.prefillAttn,
              [heads, Math.ceil((active - decodeRows) / AT.kernelattention.PREFILL_ROWS)]);
          }
        }
        emit(encoder, weights, tiled ? bind.o : bind.oPacked, weightGroups(hidden));
        emit(encoder, normChain, bind.preMlpChain, active);
        emit(encoder, weights, tiled ? bind.gateUp : bind.gateUpPacked, weightGroups(intermediate * 2));
        emit(encoder, silu, siluBind, Math.ceil((active * intermediate) / 256));
        emit(encoder, weights, tiled ? bind.down : bind.downPacked, weightGroups(hidden));
      }
      emit(encoder, normChain, layerState[layerCount - 1]!.bind.finalChain, active);
      // The head is the widest matrix in the model, so a prefill chunk that is
      // not asked for a token pays only for the rows whose logits are wanted.
      if (collectRows.length && ablate !== 'nohead') {
        // A contiguous prefix can read normalized activations without a gather copy.
        let directHead = true;
        for (let at = 0; at < headRows; at += 1) {
          if (collectRows[at] !== at) directHead = false;
        }
        if (!directHead) {
          endSharedPass();
          for (let at = 0; at < headRows; at += 1) {
            const row = Math.min(collectRows[at] ?? 0, active - 1);
            encoder.copyBufferToBuffer(act.n1, row * hidden * 4, act.headIn, at * hidden * 4, hidden * 4);
          }
          if (active === 1) sharedPass = encoder.beginComputePass();
        }
        emit(encoder, gemv[headRows - 1]!,
          directHead ? directHeadBind : headBind, gemvGroups(vocab));
        emit(encoder, argmaxPartial, argmaxPartialBind, [argmaxParts, headRows]);
        emit(encoder, argmax, argmaxBind, headRows);
      }
      endSharedPass();
      if (collectRows.length) encoder.copyBufferToBuffer(act.tokens, 0, staging, 0, collectRows.length * 4);
      device.queue.submit([encoder.finish()]);
    };

    const readTokens = async (count: number): Promise<Uint32Array> => {
      await staging.mapAsync(0x0001);
      picksBuffer.set(new Uint32Array(staging.getMappedRange(), 0, count));
      staging.unmap();
      return picksBuffer;
    };

    // A validation error leaves the submit empty; carry the driver's message
    // to the request so a failure is readable instead of an empty answer.
    let deviceError = '';
    (device as unknown as { onuncapturederror?: (event: { error?: { message?: string } }) => void })
      .onuncapturederror = (event) => {
        if (!deviceError) deviceError = String(event?.error?.message ?? 'uncaptured WebGPU error').slice(0, 300);
      };
    const queue: Job[] = [];
    const active = new Set<Job>();
    let readCursor = 0;
    const stats: Stats = { prefillTokens: 0, decodeTokens: 0, prefillMs: 0, decodeMs: 0,
      mixedMs: 0, mixedInputTokens: 0, mixedOutputTokens: 0 };
    let loop: Promise<void> | null = null;

    const deliver = (job: Job, outcome: Outcome): void => {
      if (job.delivered) return;
      job.delivered = true;
      onDone(outcome);
    };

    /** Continuous batching: every step decides which rows run. A finished row
     *  is delivered and its slot handed to the next queued request in the same
     *  iteration, so a cohort is never pinned to its slowest row and the tail
     *  of a page is not a one-row cohort. Each slot owns a KV cache row for the
     *  whole time it is alive, which is what the kernels index. */
    const runLoop = async (): Promise<void> => {
      const live: (Job | null)[] = new Array(rows).fill(null);
      let admitted = 0;
      const failAll = (message: string): void => {
        for (const job of live) if (job && !job.delivered) deliver(job, { id: job.id, ok: false, error: message.slice(0, 300) });
        live.fill(null);
        for (const job of queue.splice(0)) if (!job.delivered) deliver(job, { id: job.id, ok: false, error: message.slice(0, 300) });
      };
      try {
        for (;;) {
          // Retire what finished, then fill the free slots.
          for (let at = 0; at < live.length; at += 1) {
            const job = live[at];
            if (job && job.done) {
              // A cancelled request must not look like an answer.
              if (job.cancelled) deliver(job, { id: job.id, ok: false, error: 'cancelled' });
              else deliver(job, { id: job.id, ok: true, tokens: job.generated });
              active.delete(job);
              live[at] = null;
            }
          }
          const free = live.filter((slot) => slot === null).length;
          if (free > 0 && queue.length > 0) {
            // A beat of quiet, so requests that arrive together share a step.
            if (admitted === 0 && coalesceMs) await new Promise((resolve) => setTimeout(resolve, coalesceMs));
            for (let at = 0; at < live.length && queue.length > 0; at += 1) {
              if (live[at]) continue;
              const job = queue.shift()!;
              job.cache = at;
              job.fed = 0;
              job.done = false;
              job.delivered = false;
              job.generated = [];
              live[at] = job;
              active.add(job);
              admitted += 1;
            }
          }
          if (!live.some((slot) => slot !== null)) {
            if (!queue.length) break;
            continue;
          }
          const slots: { job: Job; token: number; position: number; collect: boolean }[] = [];
          for (const job of live) {
            if (!job || job.done) continue;
            if (job.fed >= job.prompt.length) {
              slots.push({ job, token: job.generated[job.generated.length - 1] ?? 0, position: job.fed, collect: true });
            }
          }
          // The rest of the step reads prompts, shared fairly between requests:
          // the rotation keeps a short prompt from waiting behind a long one.
          // Decode rows always run. A separate mixed token budget lets the
          // remaining prompt rows share a GEMM without allocating more KV slots.
          let budget = (slots.length ? mixedCapacity : capacity) - slots.length;
          const reading = live.filter((job): job is Job => job !== null && !job.done && job.fed < job.prompt.length);
          const firstReading = readCursor;
          for (let step = 0; step < reading.length && budget > 0; step += 1) {
            const at = (firstReading + step) % reading.length;
            const job = reading[at]!;
            const left = job.prompt.length - job.fed;
            const share = Math.max(1, Math.floor(budget / (reading.length - step)));
            const take = Math.min(left, share, budget);
            for (let index = 0; index < take; index += 1) {
              const position = job.fed + index;
              slots.push({
                job,
                token: job.prompt[position] ?? 0,
                position,
                collect: position === job.prompt.length - 1
              });
            }
            budget -= take;
            if (take > 0) readCursor = (at + 1) % reading.length;
          }
          if (!slots.length) break;
          const width = slots.length;
          const tokens: number[] = [];
          const positions: number[] = [];
          const cacheRows: number[] = [];
          const collectRows: number[] = [];
          for (let row = 0; row < width; row += 1) {
            const slot = slots[row]!;
            tokens.push(slot.token);
            positions.push(slot.position);
            cacheRows.push(slot.job.cache);
            if (slot.collect) collectRows.push(row);
          }
          const inputTokens = slots.filter((slot) => slot.job.fed < slot.job.prompt.length).length;
          const phase = inputTokens === width ? 'prefill' : inputTokens === 0 ? 'decode' : 'mixed';
          const began = performance.now();
          step(tokens, positions, cacheRows, width, collectRows, width - inputTokens);
          const encoded = performance.now();
          const completion = options.onStep
            ? device.queue.onSubmittedWorkDone().then(() => performance.now()) : null;
          const picks = collectRows.length ? await readTokens(collectRows.length) : picksBuffer;
          if (!collectRows.length) await (completion ?? device.queue.onSubmittedWorkDone());
          const finished = performance.now();
          const computed = completion ? await completion : finished;
          if (deviceError) throw new Error('webgpu: ' + deviceError);
          const spent = finished - began;
          if (phase === 'prefill') {
            stats.prefillMs += spent;
            stats.prefillTokens += inputTokens;
          } else if (phase === 'decode') {
            stats.decodeMs += spent;
            stats.decodeTokens += collectRows.length;
          } else {
            stats.mixedMs += spent;
            stats.mixedInputTokens += inputTokens;
            stats.mixedOutputTokens += collectRows.length;
          }
          options.onStep?.({
            phase, inputTokens, outputTokens: collectRows.length, activeRows: width,
            context: Math.max(...positions) + 1, encodeMs: encoded - began,
            computeMs: Math.min(computed, finished) - encoded,
            readbackMs: Math.max(0, finished - computed), wallMs: spent
          });
          for (const slot of slots) slot.job.fed = Math.max(slot.job.fed, slot.position + 1);
          for (let at = 0; at < collectRows.length; at += 1) {
            const row = collectRows[at]!;
            const slot = slots[row]!;
            if (slot.job.cancelled) continue;
            const pick = picks[at] ?? 0;
            slot.job.generated.push(pick);
            slot.job.onProgress?.(slot.job.generated);
            if (eos.includes(pick) || slot.job.generated.length >= slot.job.maxNewTokens) {
              slot.job.done = true;
            }
          }
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        failAll(message);
        return;
      } finally {
        for (const job of live) if (job && !job.delivered) deliver(job, { id: job.id, ok: true, tokens: job.generated });
      }
    };

    const start = (): void => {
      if (loop) return;
      loop = runLoop().finally(() => {
        loop = null;
        if (queue.length) start();
      });
    };

    return {
      add(job) {
        if (!job.prompt.length || job.prompt.some(id => !Number.isSafeInteger(id) || id < 0 || id >= vocab) ||
            !Number.isSafeInteger(job.maxNewTokens) || job.maxNewTokens < 1 ||
            job.prompt.length + job.maxNewTokens > maxTokens) {
          onDone({ id: job.id, ok: false, error: 'Invalid tokens or generation exceeds the backend context limit' });
          return;
        }
        queue.push({
          id: job.id,
          cache: 0,
          cancelled: false,
          prompt: job.prompt,
          maxNewTokens: job.maxNewTokens,
          generated: [],
          onProgress: job.onProgress,
          fed: 0,
          done: false,
          delivered: false
        });
        start();
      },
      drop(id) {
        const at = queue.findIndex((job) => job.id === id);
        if (at >= 0) {
          const [job] = queue.splice(at, 1);
          if (job) deliver(job, { id: job.id, ok: false, error: 'cancelled' });
          return true;
        }
        // In flight: let the row finish this step, then answer as cancelled.
        for (const job of active) {
          if (job.id !== id) continue;
          job.cancelled = true;
          job.done = true;
          return true;
        }
        return false;
      },
      async drain() {
        while (loop) await loop;
      },
      rows: () => rows,
      stats: () => ({ ...stats }),
      execution: () => ({ ...execution }),
      dispose() {
        for (const buffer of held) release(buffer);
      }
    };
    } catch (error) {
      for (const buffer of held) {
        try { release(buffer); } catch { /* Preserve the initialization failure. */ }
      }
      try { await closeScopes(); } catch { /* Preserve the initialization failure. */ }
      throw error;
    }
  }
}

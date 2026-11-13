// PLaMo 3 Translate kernels: Q4 weights, f32 activations, one submission per
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
    info?: {
      subgroupMinSize?: number;
      subgroupMaxSize?: number;
      subgroupMatrixConfigs?: readonly {
        M: number; N: number; K: number;
        componentType: string; resultComponentType: string;
      }[];
    };
    requestDevice: (options?: { requiredFeatures: string[] }) => Promise<GpuDevice>;
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
    return { device: await adapter.requestDevice({ requiredFeatures: features }), matrixSubgroupSize: matrix ? size : 0 };
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
    const headDim = 128;
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

  /** The q/k scale the exported graph applies to both halves (a double Sqrt). */
  const QK_SCALE = 0.297358;
  /** The card's end-of-turn ids. */
  export const EOS = [1, 16];
  /** Largest small-batch GEMV specialization; larger tiles use GEMM. */
  export const POSITIONS = 8;
  /** Independent request slots; prefill tile width is configured separately. */
  export const MAX_ROWS = POSITIONS;
  /** The sliding window the attention mask applies. */
  const WINDOW = 2048;

  /** RMSNorm over `rows` rows of `n`, read with a stride and an optional head
   *  gather so q and k are normalised straight out of the qkv projection:
   *  `info` is {n, rows, stride, start, heads, pad}. */
  const RMSNORM = `
    struct Info { n: u32, rows: u32, stride: u32, start: u32, heads: u32, pad: f32, pad2: u32, pad3: u32 };
    @group(0) @binding(0) var<storage, read> x: array<f32>;
    @group(0) @binding(1) var<storage, read> w: array<f32>;
    @group(0) @binding(2) var<storage, read_write> y: array<f32>;
    @group(0) @binding(3) var<uniform> info: Info;
    var<workgroup> sums: array<f32, 128>;
    @compute @workgroup_size(128)
    fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
      let row = min(wg.x, info.rows - 1u);
      let lane = lid.x;
      var base: u32 = row * info.stride + info.start;
      if (info.heads != 0u) {
        base = (row / info.heads) * info.stride + info.start + (row % info.heads) * info.n;
      }
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
        y[row * info.n + i] = x[base + i] * inv * w[i];
      }
    }
  `;

  /** q4 GEMM/GEMV: a workgroup owns eight output rows, sixteen lanes each, and
   *  every live row of x. One template per live-row count, because the
   *  accumulators are registers: an eight-accumulator template used for a lone
   *  request costs 3x (measured), and a sixteen-accumulator one costs more than
   *  the positions it gains.
   *  `info` is {n, k, blocks, rows}. */
  function gemvWgsl(width: number): string {
    const decl = Array.from({ length: width }, (_unused, r) =>
      `var acc${r}: f32 = 0.0;`).join('\n      ');
    const accumulate = Array.from({ length: width }, (_unused, r) =>
      `if (info.rows > ${r}u) {
          let base = ${r}u * info.k + at;
          acc${r} += dot(kv, vec4<f32>(x[base], x[base + 1u], x[base + 2u], x[base + 3u]));
        }`).join('\n          ');
    const store = Array.from({ length: width }, (_unused, r) =>
      `partial[(tileRow * ${width}u + ${r}u) * 16u + lane] = acc${r};`).join('\n      ');
    return `
    struct Info { n: u32, k: u32, blocks: u32, rows: u32 };
    @group(0) @binding(0) var<storage, read> q4: array<u32>;
    @group(0) @binding(1) var<storage, read> scales: array<f32>;
    @group(0) @binding(2) var<storage, read> x: array<f32>;
    @group(0) @binding(3) var<storage, read_write> y: array<f32>;
    @group(0) @binding(4) var<uniform> info: Info;
    var<workgroup> partial: array<f32, 8 * ${width} * 16>;
    @compute @workgroup_size(128)
    fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
      let t = lid.x;
      let tileRow = t / 16u;
      let lane = t % 16u;
      let rawRow = wg.y * 32768u + wg.x * 8u + tileRow;
      // No early return: every thread must reach the barrier.
      let row = min(rawRow, info.n - 1u);
      let wordsPerRow = info.blocks * 16u;
      ${decl}
      for (var b: u32 = 0u; b < info.blocks; b = b + 1u) {
        let word = q4[row * wordsPerRow + b * 16u + lane];
        let scale = scales[row * info.blocks + b];
        for (var j: u32 = 0u; j < 8u; j = j + 4u) {
          let shift = vec4<u32>(j * 4u) + vec4<u32>(0u, 4u, 8u, 12u);
          let kv = (vec4<f32>((vec4<u32>(word) >> shift) & vec4<u32>(15u)) - vec4<f32>(8.0)) * scale;
          let at = b * 128u + lane * 8u + j;
          ${accumulate}
        }
      }
      ${store}
      workgroupBarrier();
      // One thread per (output row, sequence): sixteen added values.
      if (t < 8u * ${width}u) {
        let tile = t / ${width}u;
        let p = t % ${width}u;
        let outRow = wg.y * 32768u + wg.x * 8u + tile;
        if (outRow < info.n && info.rows > p) {
          var sum: f32 = 0.0;
          for (var i: u32 = 0u; i < 16u; i = i + 1u) {
            sum = sum + partial[(tile * ${width}u + p) * 16u + i];
          }
          y[p * info.n + outRow] = sum;
        }
      }
    }
  `;
  }


  /** RoPE for `heads` heads of `headDim`, each row at its own position, then
   *  the q/k scale. `info` is {heads, rows, half, scale}. */
  const ROPE = `
    struct Info { heads: u32, rows: u32, half: u32, scale: f32, stride: u32, start: u32, pad: u32, pad2: u32 };
    @group(0) @binding(0) var<storage, read> x: array<f32>;
    @group(0) @binding(1) var<storage, read> inv: array<f32>;
    @group(0) @binding(2) var<storage, read_write> y: array<f32>;
    @group(0) @binding(3) var<uniform> info: Info;
    @group(0) @binding(4) var<storage, read> positions: array<u32>;
    @compute @workgroup_size(128)
    fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
      let row = min(wg.y, info.rows - 1u);
      let head = min(wg.x, info.heads - 1u);
      let d = lid.x;
      let half = info.half;
      let at = (row * info.heads + head) * 2u * half;
      // Stride 0 means the input is already gathered (the normalised q/k).
      var src = at;
      if (info.stride != 0u) { src = row * info.stride + info.start + head * 2u * half; }
      let angle = f32(positions[row]) * inv[d % half];
      let c = cos(angle);
      let s = sin(angle);
      var out: f32;
      if (d < half) {
        out = x[src + d] * c - x[src + d + half] * s;
      } else {
        out = x[src + d] * c + x[src + d - half] * s;
      }
      y[at + d] = out * info.scale;
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
      y[i] = (a / (1.0 + exp(-a))) * fused[base + info.half + within];
    }
  `;

  /** y = a + b, elementwise over all rows. */
  const ADD = `
    @group(0) @binding(0) var<storage, read> a: array<f32>;
    @group(0) @binding(1) var<storage, read> b: array<f32>;
    @group(0) @binding(2) var<storage, read_write> y: array<f32>;
    @compute @workgroup_size(256)
    fn main(@builtin(global_invocation_id) id: vec3<u32>) {
      let i = id.x;
      if (i >= arrayLength(&y)) { return; }
      y[i] = a[i] + b[i];
    }
  `;

  /** The greedy pick per row, on the device: only the token id crosses back. */
  const ARGMAX = `
    struct Info { vocab: u32, rows: u32, pad: u32, pad2: u32 };
    @group(0) @binding(0) var<storage, read> logits: array<f32>;
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
      for (var i: u32 = lane; i < info.vocab; i = i + 128u) {
        let v = logits[row * info.vocab + i];
        if (v > value) { value = v; index = i; }
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
    add: (job: { id: number; prompt: number[]; maxNewTokens: number }) => void;
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
    /** Empty disables early stopping, for fixed-token throughput measurements. */
    eosTokens?: readonly number[];
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
    const eos = options.eosTokens ?? EOS;
    // 0 normal, 1 skip the value pass, 2 skip the score pass.
    const attnMode = ablate === 'attn_novalue' ? 1 : ablate === 'attn_noscore' ? 2 : 0;
    const coalesceMs = Math.max(0, Math.floor(options.coalesceMs ?? 0));
    const { hidden, heads, headDim, intermediate, qkvWidth, vocab, layers } = geometry;
    const qWidth = heads * headDim;
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

    const held: GpuBuffer[] = [];
    const alloc = (bytes: number, extra = 0): GpuBuffer => {
      const buffer = device.createBuffer({
        size: Math.max(16, Math.ceil(bytes / 4) * 4),
        usage: USAGE.STORAGE | USAGE.COPY_DST | USAGE.COPY_SRC | extra
      });
      held.push(buffer);
      return buffer;
    };
    const uniform = (): GpuBuffer => {
      // 32 bytes: the norm and rope structures grew when they learned to gather.
      const buffer = device.createBuffer({ size: 32, usage: USAGE.UNIFORM | USAGE.COPY_DST });
      held.push(buffer);
      return buffer;
    };
    const put = (buffer: GpuBuffer, data: ArrayBufferView): void => device.queue.writeBuffer(buffer, 0, data);
    const pipeline = (code: string, layout: string | unknown = 'auto'): GpuPipeline =>
      device.createComputePipeline({ layout, compute: { module: device.createShaderModule({ code }), entryPoint: 'main' } });
    const rms = pipeline(RMSNORM);
    const rope = pipeline(ROPE);
    const attention = pipeline(AT.kernelattention.decode(maxTokens * headDim));
    const prefillAttention = execution.attention === 'tiled'
      ? pipeline(AT.kernelattention.prefill(maxTokens * headDim, !!device.features?.has('subgroups'))) : null;
    const ropeKV = pipeline(AT.kernelattention.ropeKV(maxTokens * headDim, qkvWidth, heads));
    const silu = pipeline(SILU_MUL);
    const argmax = pipeline(ARGMAX);
    const add = pipeline(ADD);
    // One shared layout lets the small-row GEMV and prefill GEMM reuse bindings.
    const compute = 4;
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

    const act = {
      x: alloc(capacity * hidden * 4),
      n1: alloc(capacity * hidden * 4),
      qkv: alloc(capacity * qkvWidth * 4),
      qN: alloc(capacity * qWidth * 4),
      kN: alloc(capacity * headDim * 4),
      qR: alloc(capacity * qWidth * 4),
      attn: alloc(capacity * qWidth * 4),
      o: alloc(capacity * hidden * 4),
      post: alloc(capacity * hidden * 4),
      res: alloc(capacity * hidden * 4),
      n2: alloc(capacity * hidden * 4),
      gu: alloc(capacity * intermediate * 2 * 4),
      s: alloc(capacity * intermediate * 4),
      d: alloc(capacity * hidden * 4),
      logits: alloc(rows * vocab * 4),
      positions: alloc(capacity * 4),
      cacheRows: alloc(capacity * 4),
      tokens: alloc(rows * 4),
      /** The rows whose logits the head is asked for: prefill positions that
       *  end a prompt, and every generating row. */
      headIn: alloc(rows * hidden * 4)
    };
    const staging = device.createBuffer({ size: rows * 4, usage: USAGE.MAP_READ | USAGE.COPY_DST }) as Mappable;
    held.push(staging);
    const embedded = new Float32Array(capacity * hidden);
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
      normQ: uniform(),
      normK: uniform(),
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
    const putNorm = (target: GpuBuffer, n: number, count: number, stride: number, start: number, heads: number): void =>
      setMeta(target, n, count, stride, start, heads);
    const putRope = (target: GpuBuffer, headCount: number, active: number): void => {
      metaU32[0] = headCount;
      metaU32[1] = active;
      metaU32[2] = headDim / 2;
      metaU32[4] = metaU32[5] = metaU32[6] = metaU32[7] = 0;
      metaF32[3] = QK_SCALE;
      put(target, metaU32);
    };
    /** The width of the step that is about to run: a lone request costs one
     *  row, a full cohort costs what it uses. Every uniform is rewritten here,
     *  once per step, before the one submit that reads them. */
    const configure = (active: number, headRows: number, decodeRows: number): void => {
      putGemv(meta.gemvQkv, qkvWidth, hidden, active);
      putGemv(meta.gemvO, hidden, qWidth, active);
      putGemv(meta.gemvGu, intermediate * 2, hidden, active);
      putGemv(meta.gemvDown, hidden, intermediate, active);
      putGemv(meta.gemvHead, vocab, hidden, headRows);
      putNorm(meta.normHidden, hidden, active, hidden, 0, 0);
      putNorm(meta.normQ, headDim, active * heads, qkvWidth, 0, heads);
      putNorm(meta.normK, headDim, active, qkvWidth, qWidth, 0);
      putRope(meta.ropeQ, heads, active);
      putRope(meta.ropeK, 1, active);
      const splitAttention = active > POSITIONS && prefillAttention !== null;
      setMeta(meta.attn, heads, splitAttention ? decodeRows : active, WINDOW, attnMode);
      if (splitAttention) setMeta(meta.attnPrefill, heads, active, WINDOW, attnMode, decodeRows);
      setMeta(meta.silu, intermediate);
      setMeta(meta.argmax, vocab, headRows);
    };

    const upload = (bytes: Uint8Array): GpuBuffer => {
      const buffer = alloc(bytes.byteLength);
      device.queue.writeBuffer(buffer, 0, bytes);
      return buffer;
    };
    const uploadFloats = (values: Float32Array): GpuBuffer => {
      const buffer = alloc(values.byteLength);
      device.queue.writeBuffer(buffer, 0, values);
      return buffer;
    };

    const headBind = bindGroup(gemvLayout, [upload(model.head.q4), uploadFloats(model.head.scales), act.headIn, act.logits, meta.gemvHead]);
    const finalBind = bindGroup(rms, [act.x, uploadFloats(model.finalNorm), act.n1, meta.normHidden]);
    const siluBind = bindGroup(silu, [act.gu, act.s, meta.silu]);
    const addMixer = bindGroup(add, [act.x, act.post, act.res]);
    const addMlp = bindGroup(add, [act.res, act.post, act.x]);
    const argmaxBind = bindGroup(argmax, [act.logits, act.tokens, meta.argmax]);

    const layerState: { bind: Record<string, unknown> }[] = [];
    for (let index = 0; index < layers; index += 1) {
      const layer = model.layers[index]!;
      const q4 = (matrix: { q4: Uint8Array; scales: Float32Array }): { q4: GpuBuffer; scales: GpuBuffer } =>
        ({ q4: upload(matrix.q4), scales: uploadFloats(matrix.scales) });
      const w = { qkv: q4(layer.qkv), o: q4(layer.o), gateUp: q4(layer.gateUp), down: q4(layer.down) };
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
          preMixer: bindGroup(rms, [act.x, norms.preMixer, act.n1, meta.normHidden]),
          postMixer: bindGroup(rms, [act.o, norms.postMixer, act.post, meta.normHidden]),
          preMlp: bindGroup(rms, [act.res, norms.preMlp, act.n2, meta.normHidden]),
          postMlp: bindGroup(rms, [act.d, norms.postMlp, act.post, meta.normHidden]),
          q: bindGroup(rms, [act.qkv, norms.qNorm, act.qN, meta.normQ]),
          k: bindGroup(rms, [act.qkv, norms.kNorm, act.kN, meta.normK]),
          ropeQ: bindGroup(rope, [act.qN, frequencies, act.qR, meta.ropeQ, act.positions]),
          ropeKV: bindGroup(ropeKV, [act.kN, frequencies, kc, vc, act.qkv, act.positions, act.cacheRows, meta.ropeK]),
          attn: bindGroup(attention, [act.qR, kc, vc, act.attn, meta.attn, act.positions, act.cacheRows]),
          prefillAttn: prefillAttention
            ? bindGroup(prefillAttention, [act.qR, kc, vc, act.attn, meta.attnPrefill, act.positions, act.cacheRows]) : null
        }
      });
    }

    const emit = (encoder: GpuEncoder, pipe: GpuPipeline, bind: unknown, groups: number | [number, number]): void => {
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipe);
      pass.setBindGroup(0, bind);
      if (Array.isArray(groups)) pass.dispatchWorkgroups(groups[0], groups[1]);
      else pass.dispatchWorkgroups(groups);
      pass.end();
    };
    /** Eight output rows per workgroup: exactly as many workgroups as tiles,
     *  x capped at 4096 and the rest in y, so a 2304-row matrix does not spin
     *  up 4096 workgroups that all compute a row twice. */
    const gemvGroups = (n: number): [number, number] => {
      const tiles = Math.max(1, Math.ceil(n / rowsPerGroup));
      return [Math.min(4096, tiles), Math.ceil(tiles / 4096)];
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
      configure(active, headRows, decodeRows);
      const tiled = active > POSITIONS;
      const wide = wideGemm !== null && active > AT.kernelmatmul.TILE_ROWS;
      const weights = tiled ? (wide ? wideGemm : gemm) : gemv[active - 1]!;
      const weightGroups = (n: number): [number, number] => tiled
        ? [Math.ceil(n / tileOutputs), Math.ceil(active / (wide ? AT.kernelmatmul.WIDE_TILE_ROWS : tileRows))]
        : gemvGroups(n);
      for (let row = 0; row < active; row += 1) {
        const token = tokens[row] ?? 0;
        const base = token * hidden;
        for (let i = 0; i < hidden; i += 1) embedded[row * hidden + i] = AT.onnxweights.f16(model.embed[base + i] ?? 0);
      }
      device.queue.writeBuffer(act.x, 0, embedded.subarray(0, active * hidden));
      positionData.set(positions);
      cacheRowData.set(cacheRows);
      put(act.positions, positionData);
      put(act.cacheRows, cacheRowData);
      const encoder = device.createCommandEncoder();
      const layerCount = ablate === 'onelay' ? 1 : layers;
      for (let index = 0; index < layerCount; index += 1) {
        const state = layerState[index]!;
        const bind = state.bind;
        emit(encoder, rms, bind.preMixer, active);
        emit(encoder, weights, bind.qkv, weightGroups(qkvWidth));
        // q and k are normalised straight out of the projection, rotated into
        // the scratch the attention reads, and only k and v reach the cache.
        emit(encoder, rms, bind.q, active * heads);
        emit(encoder, rms, bind.k, active);
        emit(encoder, rope, bind.ropeQ, [heads, active]);
        emit(encoder, ropeKV, bind.ropeKV, [1, active]);
        if (ablate !== 'noattn') {
          if (tiled && prefillAttention) {
            // Independent decoding queries cannot reuse each other's KV tiles.
            // Keep them out of the prefill tile's serial cache-slot loop.
            if (decodeRows) emit(encoder, attention, bind.attn, [heads, decodeRows]);
            if (active > decodeRows) {
              emit(encoder, prefillAttention, bind.prefillAttn,
                [heads, Math.ceil((active - decodeRows) / AT.kernelattention.PREFILL_ROWS)]);
            }
          } else {
            emit(encoder, attention, bind.attn, [heads, active]);
          }
        }
        emit(encoder, weights, bind.o, weightGroups(hidden));
        emit(encoder, rms, bind.postMixer, active);
        emit(encoder, add, addMixer, Math.ceil((active * hidden) / 256));
        emit(encoder, rms, bind.preMlp, active);
        emit(encoder, weights, bind.gateUp, weightGroups(intermediate * 2));
        emit(encoder, silu, siluBind, Math.ceil((active * intermediate) / 256));
        emit(encoder, weights, bind.down, weightGroups(hidden));
        emit(encoder, rms, bind.postMlp, active);
        emit(encoder, add, addMlp, Math.ceil((active * hidden) / 256));
      }
      emit(encoder, rms, finalBind, active);
      // The head is the widest matrix in the model, so a prefill chunk that is
      // not asked for a token pays only for the rows whose logits are wanted.
      if (collectRows.length && ablate !== 'nohead') {
        for (let at = 0; at < headRows; at += 1) {
          const row = Math.min(collectRows[at] ?? 0, active - 1);
          encoder.copyBufferToBuffer(act.n1, row * hidden * 4, act.headIn, at * hidden * 4, hidden * 4);
        }
        emit(encoder, gemv[headRows - 1]!, headBind, gemvGroups(vocab));
        emit(encoder, argmax, argmaxBind, headRows);
      }
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
            const pick = picks[at] ?? 0;
            slot.job.generated.push(pick);
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
        const prompt = job.prompt.filter((id) => Number.isFinite(id) && id >= 0 && id < vocab).slice(0, maxTokens - 1);
        queue.push({
          id: job.id,
          cache: 0,
          cancelled: false,
          prompt,
          maxNewTokens: Math.max(1, Math.min(job.maxNewTokens, maxTokens - prompt.length)),
          generated: [],
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
        for (const buffer of held) buffer.destroy?.();
      }
    };
  }
}

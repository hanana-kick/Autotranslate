// The measurement itself: the shipped graph, the shipped tokenizer, and a
// decode loop written the way the engine would write it. Nothing here is
// production code; the numbers it reports are what decide whether the engine
// gets built (see local://engine-plan.md).
(() => {
  const tf = globalThis.AT_TRANSFORMERS;
  const P = AT.plamo3;
  let tokenizer = null;
  let model = null;
  let session = null;
  let meta = null;

  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };

  function tensorOf(name, flat, dims) {
    const type = meta.get(name)?.type ?? 'int64';
    const data = type === 'int64' ? BigInt64Array.from(flat.map((value) => BigInt(value))) : Float32Array.from(flat);
    return new tf.Tensor(type, data, dims);
  }

  function flat(rows) {
    const out = [];
    for (const row of rows) for (const value of row) out.push(value);
    return out;
  }

  async function tokenIds(text) {
    return Array.from(tokenizer(text, { add_special_tokens: false }).input_ids.data).map(Number);
  }

  function renderPrompt(target, text) {
    return tokenizer.apply_chat_template(
      [{ role: 'user', content: P.sanitize(text) }],
      { target_lang: P.langFor(target) ?? 'ko', add_generation_prompt: true, tokenize: false }
    );
  }

  /** One forward of a batch of equally long rows. `cache` is the DynamicCache
   *  the library's own generate keeps, passed back in as past_key_values. */
  async function forward(rows, cache, masks = null) {
    const batch = rows.length;
    const length = rows[0].length;
    const mask = masks ?? rows.map(() => new Array(length).fill(1));
    const out = await model.forward({
      input_ids: tensorOf('input_ids', flat(rows), [batch, length]),
      // The mask spans the cache, the ids only the new positions.
      attention_mask: tensorOf('attention_mask', flat(mask), [batch, mask[0].length]),
      past_key_values: cache
    });
    return out;
  }

  /** This step's `present.*` tensors become next step's `past_key_values.*`.
   *  The library does the same rename internally but does not export it, and
   *  the engine will own this table anyway. */
  let disposeCache = true;
  /** Serves a different graph for the next model load (the injected-node test). */
  let overrideGraph = null;
  /** Our own q4 GEMV: y[n] = sum_k ((q[k] - 8) * scale[k//128]) * x[k], with the
   *  weights read exactly as ORT packs them (uint8 nibbles, low nibble first)
   *  and only re-laid out per row. One workgroup per output row. */
  /** Binary16 -> number, for the embedding table. */
  function decodeF16(bits) {
    const sign = bits & 0x8000 ? -1 : 1;
    const exponent = (bits >> 10) & 0x1f;
    const mantissa = bits & 0x3ff;
    if (exponent === 0) return sign * mantissa * 2 ** -24;
    if (exponent === 31) return mantissa ? NaN : sign * Infinity;
    return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
  }

  /** Batched q4 GEMV generator. `kind` 'dynamic' keeps the row accumulators in
   *  an array (indexed at runtime); 'unrolled' generates one register per row,
   *  which is the variant that tells us whether the array was spilling. */
  function gemvCoalescedWgsl(rows) {
    // One lane per packed word (8 nibbles), words in warp order: a warp reads
    // 32 consecutive words = 128 B, so the weight traffic has no duplicates.
    const acc = Array.from({ length: rows }, (_, r) => `var acc${r}: f32 = 0.0;`).join('\n      ');
    const fmAs = [];
    for (let nib = 0; nib < 8; nib += 1) {
      for (let r = 0; r < rows; r += 1) {
        fmAs.push(`acc${r} = acc${r} + w${nib} * x[${r}u * info.k + base + ${nib}u];`);
      }
    }
    const store = Array.from({ length: rows }, (_, r) => `partial[${r}u * 128u + lane] = acc${r};`).join('\n      ');
    const write = Array.from({ length: rows }, (_, r) => `y[${r}u * info.n + row] = partial[${r}u * 128u];`).join('\n        ');
    return `
    struct Meta { n: u32, k: u32, blocks: u32, rows: u32 };
    @group(0) @binding(0) var<storage, read> q4: array<u32>;
    @group(0) @binding(1) var<storage, read> scales: array<f32>;
    @group(0) @binding(2) var<storage, read> x: array<f32>;
    @group(0) @binding(3) var<storage, read_write> y: array<f32>;
    @group(0) @binding(4) var<uniform> info: Meta;
    var<workgroup> partial: array<f32, 8 * 128>;

    @compute @workgroup_size(128)
    fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
      let rawRow = wg.x + wg.y * 4096u;
      let row = min(rawRow, info.n - 1u);
      let lane = lid.x;
      let wordsPerRow = info.blocks * 16u;
      ${acc}
      var w = lane;
      loop {
        if (w >= wordsPerRow) { break; }
        let packed = q4[row * wordsPerRow + w];
        let scale = scales[row * info.blocks + w / 16u];
        let base = w * 8u;
        var w0: f32 = (f32(packed & 0xFu) - 8.0) * scale;
        var w1: f32 = (f32((packed >> 4u) & 0xFu) - 8.0) * scale;
        var w2: f32 = (f32((packed >> 8u) & 0xFu) - 8.0) * scale;
        var w3: f32 = (f32((packed >> 12u) & 0xFu) - 8.0) * scale;
        var w4: f32 = (f32((packed >> 16u) & 0xFu) - 8.0) * scale;
        var w5: f32 = (f32((packed >> 20u) & 0xFu) - 8.0) * scale;
        var w6: f32 = (f32((packed >> 24u) & 0xFu) - 8.0) * scale;
        var w7: f32 = (f32((packed >> 28u) & 0xFu) - 8.0) * scale;
        ${fmAs.join('\n        ')}
        w = w + 128u;
      }
      ${store}
      workgroupBarrier();
      for (var r: u32 = 0u; r < ${rows}u; r = r + 1u) {
        var stride: u32 = 64u;
        loop {
          if (stride == 0u) { break; }
          let at = r * 128u;
          if (lane < stride) { partial[at + lane] = partial[at + lane] + partial[at + lane + stride]; }
          workgroupBarrier();
          stride = stride / 2u;
        }
      }
      if (lane == 0u && rawRow < info.n) {
        ${write}
      }
    }
  `;
  }

  function gemvRowsWgsl(kind, rows) {
    const accDecl = kind === 'unrolled'
      ? Array.from({ length: rows }, (_, r) => `var acc${r}: f32 = 0.0;`).join('\n      ')
      : 'var acc: array<f32, 8>;\n      for (var r: u32 = 0u; r < 8u; r = r + 1u) { acc[r] = 0.0; }';
    const accumulate = kind === 'unrolled'
      ? Array.from({ length: rows }, (_, r) => `acc${r} = acc${r} + q * x[${r}u * info.k + at];`).join('\n          ')
      : 'for (var r: u32 = 0u; r < info.rows; r = r + 1u) { acc[r] = acc[r] + q * x[r * info.k + at]; }';
    const store = kind === 'unrolled'
      ? Array.from({ length: rows }, (_, r) => `partial[${r}u * 128u + lane] = acc${r};`).join('\n        ')
      : 'for (var r: u32 = 0u; r < info.rows; r = r + 1u) { partial[r * 128u + lane] = acc[r]; }';
    const write = kind === 'unrolled'
      ? Array.from({ length: rows }, (_, r) => `y[${r}u * info.n + row] = partial[${r}u * 128u];`).join('\n          ')
      : 'for (var r: u32 = 0u; r < info.rows; r = r + 1u) { y[r * info.n + row] = partial[r * 128u]; }';
    return `
    struct Meta { n: u32, k: u32, blocks: u32, rows: u32 };
    @group(0) @binding(0) var<storage, read> q4: array<u32>;
    @group(0) @binding(1) var<storage, read> scales: array<f32>;
    @group(0) @binding(2) var<storage, read> x: array<f32>;
    @group(0) @binding(3) var<storage, read_write> y: array<f32>;
    @group(0) @binding(4) var<uniform> info: Meta;
    var<workgroup> partial: array<f32, 8 * 128>;

    @compute @workgroup_size(128)
    fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
      let rawRow = wg.x + wg.y * 4096u;
      let row = min(rawRow, info.n - 1u);
      let lane = lid.x;
      let wordsPerBlock = 16u;
      let wordsPerRow = info.blocks * wordsPerBlock;
      ${accDecl}
      for (var b: u32 = 0u; b < info.blocks; b = b + 1u) {
        let word = q4[row * wordsPerRow + b * wordsPerBlock + lane / 8u];
        let byteInWord = (lane % 8u) / 2u;
        let nibble = lane % 2u;
        let byte = (word >> (byteInWord * 8u)) & 0xFFu;
        let q = (f32((byte >> (nibble * 4u)) & 0xFu) - 8.0) * scales[row * info.blocks + b];
        let at = b * 128u + lane;
          ${accumulate}
      }
      ${store}
      workgroupBarrier();
      for (var r: u32 = 0u; r < ${kind === 'unrolled' ? `${rows}u` : 'info.rows'}; r = r + 1u) {
        var stride: u32 = 64u;
        loop {
          if (stride == 0u) { break; }
          let base = r * 128u;
          if (lane < stride) { partial[base + lane] = partial[base + lane] + partial[base + lane + stride]; }
          workgroupBarrier();
          stride = stride / 2u;
        }
      }
      if (lane == 0u && rawRow < info.n) {
          ${write}
      }
    }
  `;
  }

  /** Load the repacked q4 matrix, run our GEMV on a fixed vector, and compare
   *  against ORT's own MatMulNBits on the same vector and weights. */
  /** RoPE for `heads` heads of 128 dims at one position, then the q/k scale the
   *  graph applies ((1/128)^(1/4), so the dot product carries 1/128). */
  const ROPE_WGSL = `
    struct Meta { heads: u32, pos: u32, half: u32, scale: f32 };
    @group(0) @binding(0) var<storage, read> x: array<f32>;
    @group(0) @binding(1) var<storage, read> inv: array<f32>;
    @group(0) @binding(2) var<storage, read_write> y: array<f32>;
    @group(0) @binding(3) var<uniform> info: Meta;
    @compute @workgroup_size(128)
    fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
      let head = min(wg.x, info.heads - 1u);
      let d = lid.x;
      let half = info.half;                 // 64
      let i = d % half;
      let at = head * 2u * half;
      let angle = f32(info.pos) * inv[i];
      let c = cos(angle);
      let s = sin(angle);
      var out: f32;
      if (d < half) {
        out = x[at + d] * c - x[at + d + half] * s;
      } else {
        out = x[at + d] * c + x[at + d - half] * s;
      }
      y[at + d] = out * info.scale;
    }
  `;

  /** One KV head, 16 query heads, causal + sliding-window attention.
   *  Deliberately simple: thread 0 computes every score and the softmax into
   *  workgroup memory, all 128 threads then accumulate the values. Correctness
   *  first; the split-across-threads version is measured separately. */
  const ATTENTION_WGSL = `
    struct Meta { pos: u32, length: u32, window: u32, heads: u32 };
    @group(0) @binding(0) var<storage, read> q: array<f32>;
    @group(0) @binding(1) var<storage, read> kcache: array<f32>;
    @group(0) @binding(2) var<storage, read> vcache: array<f32>;
    @group(0) @binding(3) var<storage, read_write> out: array<f32>;
    @group(0) @binding(4) var<uniform> info: Meta;
    var<workgroup> probs: array<f32, 2048>;
    @compute @workgroup_size(128)
    fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
      let head = min(wg.x, info.heads - 1u);
      let d = lid.x;
      let qbase = head * 128u;
      if (d == 0u) {
        var top: f32 = -3.0e38;
        for (var j: u32 = 0u; j <= info.pos; j = j + 1u) {
          var acc: f32 = 0.0;
          for (var i: u32 = 0u; i < 128u; i = i + 1u) {
            acc = acc + q[qbase + i] * kcache[j * 128u + i];
          }
          let inWindow = (info.window == 0u) || (info.pos - j < info.window);
          probs[j] = select(-3.0e38, acc, inWindow);
          top = max(top, probs[j]);
        }
        var denom: f32 = 0.0;
        for (var j: u32 = 0u; j <= info.pos; j = j + 1u) {
          probs[j] = exp(probs[j] - top);
          denom = denom + probs[j];
        }
        for (var j: u32 = 0u; j <= info.pos; j = j + 1u) { probs[j] = probs[j] / denom; }
      }
      workgroupBarrier();
      var acc2: f32 = 0.0;
      for (var j: u32 = 0u; j <= info.pos; j = j + 1u) {
        acc2 = acc2 + probs[j] * vcache[j * 128u + d];
      }
      out[qbase + d] = acc2;
    }
  `;

  /** RMSNorm over `rows` rows of `n` elements: y = x * rsqrt(mean(x^2)+eps) * w. */
  const RMSNORM_WGSL = `
    struct Meta { n: u32, rows: u32, eps: f32, pad: f32 };
    @group(0) @binding(0) var<storage, read> x: array<f32>;
    @group(0) @binding(1) var<storage, read> w: array<f32>;
    @group(0) @binding(2) var<storage, read_write> y: array<f32>;
    @group(0) @binding(3) var<uniform> info: Meta;
    var<workgroup> sums: array<f32, 128>;
    @compute @workgroup_size(128)
    fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
      let row = min(wg.x, info.rows - 1u);
      let lane = lid.x;
      var acc: f32 = 0.0;
      for (var i: u32 = lane; i < info.n; i = i + 128u) {
        let v = x[row * info.n + i];
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
      let inv = 1.0 / sqrt(sums[0] / f32(info.n) + info.eps);
      for (var i: u32 = lane; i < info.n; i = i + 128u) {
        y[row * info.n + i] = x[row * info.n + i] * inv * w[i];
      }
    }
  `;

  /** y = a * sigmoid(a) * b, elementwise. */
  const SILU_MUL_WGSL = `
    @group(0) @binding(0) var<storage, read> gate: array<f32>;
    @group(0) @binding(1) var<storage, read> up: array<f32>;
    @group(0) @binding(2) var<storage, read_write> y: array<f32>;
    @compute @workgroup_size(256)
    fn main(@builtin(global_invocation_id) id: vec3<u32>) {
      let i = id.x;
      if (i >= arrayLength(&y)) { return; }
      let a = gate[i];
      y[i] = (a / (1.0 + exp(-a))) * up[i];
    }
  `;

  /** y = a + b, elementwise. */
  const ADD_WGSL = `
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

  /** Layer 0 for four positions with our kernels: embeddings from the file,
   *  qkv, qk-norm, RoPE, KV cache, attention, o_proj and the residual chain.
   *  Every stage is compared against the dumped ORT tensors at each position. */
  function meanAbs(values) {
    let sum = 0;
    for (let i = 0; i < values.length; i += 1) sum += Math.abs(values[i]);
    return Math.round((sum / values.length) * 1000) / 1000;
  }

  /** A real prompt: the card's chat template around a Japanese sentence. */
  window.__tokenize = async (text) => {
    const base = new URL('/spike-model/', location.href);
    AT.pipelinehost.installSeams({
      modelFiles: async (name) => {
        const response = await fetch(new URL(name, base)).catch(() => null);
        return response?.ok ? await response.blob() : null;
      }
    });
    const opened = await AT.pipelinehost.openModel('spike-model', 'q4f16');
    const tf = opened.tf;
    const tokenizer = await tf.AutoTokenizer.from_pretrained('onnx-model');
    const prompt = tokenizer.apply_chat_template(
      [{ role: 'user', content: text }],
      { target_lang: 'ko', add_generation_prompt: true, tokenize: false }
    );
    const ids = Array.from(tokenizer(prompt).input_ids.data).map(Number);
    await opened.model.dispose?.();
    return { ids, prompt: prompt.slice(0, 80) };
  };

  /** Decode ids with the card's tokenizer, so a run can be read as text. */
  window.__decodeIds = async (ids) => {
    const base = new URL('/spike-model/', location.href);
    AT.pipelinehost.installSeams({
      modelFiles: async (name) => {
        const response = await fetch(new URL(name, base)).catch(() => null);
        return response?.ok ? await response.blob() : null;
      }
    });
    const opened = await AT.pipelinehost.openModel('spike-model', 'q4f16');
    const tokenizer = await opened.tf.AutoTokenizer.from_pretrained('onnx-model');
    const text = tokenizer.decode(ids, { skip_special_tokens: true });
    await opened.model.dispose?.();
    return text;
  };

  /** ORT's own greedy continuation of the same prompt, for token parity. */
  window.__ortGenerate = async (prompt, steps) => {
    // The loader installs the custom cache; the seam points it at the served
    // directory instead of the network.
    const base = new URL('/spike-model/', location.href);
    AT.pipelinehost.installSeams({
      modelFiles: async (name) => {
        const response = await fetch(new URL(name, base)).catch(() => null);
        return response?.ok ? await response.blob() : null;
      }
    });
    const opened = await AT.pipelinehost.openModel('spike-model', 'q4f16');
    const model = opened.model;
    const tf = opened.tf;
    const out = await model.generate({
      input_ids: new tf.Tensor('int64', BigInt64Array.from(prompt.map((id) => BigInt(id))), [1, prompt.length]),
      max_new_tokens: steps,
      do_sample: false
    });
    const ids = Array.from(out.tolist()[0]).map(Number);
    await model.dispose?.();
    return { ids: ids.slice(prompt.length), all: ids };
  };

  /** The whole decode loop on our kernels: 16 layers, final norm, lm_head,
   *  greedy argmax. Weights come from the repacked manifest. Returns the
   *  generated ids and the per-token wall time. */
  window.__translateProbe = async (config) => {
    const base = new URL('/micro/mm/', location.href);
    const get = async (name) => new Uint8Array(await (await fetch(new URL(name, base))).arrayBuffer());
    const getJson = async (name) => await (await fetch(new URL(name, base))).json();
    const manifest = await getJson('manifest.json');
    const embedBytes = await get('embed.f16.bin');
    const embedF16 = new Uint16Array(embedBytes.buffer, embedBytes.byteOffset, embedBytes.byteLength / 2);
    const finalNorm = new Float32Array((await get('finalNormW.f32.bin')).buffer);
    const headManifest = manifest.head;
    const headQ4 = await get(`${headManifest.name}.q4.bin`);
    const headScales = new Float32Array((await get(`${headManifest.name}.scales.bin`)).buffer);

    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter.requestDevice();
    const U = GPUBufferUsage;
    const alloc = (bytes, extra = 0) => device.createBuffer({
      size: Math.max(16, Math.ceil(bytes / 4) * 4),
      usage: U.STORAGE | U.COPY_DST | U.COPY_SRC | extra
    });
    const uni = () => device.createBuffer({ size: 16, usage: U.UNIFORM | U.COPY_DST });
    const write = (b, data) => device.queue.writeBuffer(b, 0, data);
    const pipeline = (code) => device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code }), entryPoint: 'main' } });
    const gemvPipe = pipeline(gemvCoalescedWgsl(1));
    const rmsPipe = pipeline(RMSNORM_WGSL);
    const ropePipe = pipeline(ROPE_WGSL);
    const attnPipe = pipeline(ATTENTION_WGSL);
    const siluPipe = pipeline(SILU_MUL_WGSL);
    const addPipe = pipeline(ADD_WGSL);

    const MAXK = 512;
    const act = {
      x: alloc(1536 * 4), n1: alloc(1536 * 4), qkv: alloc(2304 * 4),
      q: alloc(2048 * 4), k: alloc(128 * 4), v: alloc(128 * 4),
      qN: alloc(2048 * 4), kN: alloc(128 * 4), qR: alloc(2048 * 4), kR: alloc(128 * 4),
      attn: alloc(2048 * 4), o: alloc(1536 * 4), post: alloc(1536 * 4), res: alloc(1536 * 4),
      n2: alloc(1536 * 4), gu: alloc(12288 * 4), gate: alloc(6144 * 4), up: alloc(6144 * 4), s: alloc(6144 * 4),
      d: alloc(1536 * 4), logits: alloc(107520 * 4)
    };
    void act.d;
    const headBuf = { q4: alloc(headQ4.byteLength), scales: alloc(headScales.byteLength) };
    write(headBuf.q4, headQ4);
    write(headBuf.scales, headScales);
    const finalW = alloc(finalNorm.byteLength);
    write(finalW, finalNorm);

    const layers = [];
    for (const entry of manifest.layers) {
      const w = {};
      for (const [key, matrix] of Object.entries(entry.matrices)) {
        const q4 = await get(`${matrix.name}.q4.bin`);
        const scales = new Float32Array((await get(`${matrix.name}.scales.bin`)).buffer);
        w[key] = { q4: alloc(q4.byteLength), scales: alloc(scales.byteLength), manifest: matrix };
        write(w[key].q4, q4);
        write(w[key].scales, scales);
      }
      const norms = {};
      for (const [key, norm] of Object.entries(entry.norms)) {
        norms[key] = alloc(norm.length * 4);
        write(norms[key], new Float32Array((await get(`${norm.name}.f32.bin`)).buffer));
      }
      const inv = alloc(64 * 4);
      const invName = config?.sharedFreq ? manifest.layers[0].invFreq.name : entry.invFreq.name;
      write(inv, new Float32Array((await get(`${invName}.f32.bin`)).buffer));
      const kc = alloc(MAXK * 128 * 4);
      const vc = alloc(MAXK * 128 * 4);
      layers.push({ w, norms, inv, kc, vc });
    }

    // Uniforms, one per dispatch site.
    const meta = {
      qkv: uni(), o: uni(), gu: uni(), down: uni(), head: uni(),
      n1536: uni(), nQ: uni(), nK: uni(), rQ: [uni(), uni(), uni(), uni()], rK: [uni(), uni(), uni(), uni()],
      attn: [uni(), uni(), uni(), uni()], ropeMeta: []
    };
    void meta.ropeMeta;
    const writeNorm = (target, n, rows, eps) => {
      const raw = new ArrayBuffer(16);
      new Uint32Array(raw)[0] = n;
      new Uint32Array(raw)[1] = rows;
      new Float32Array(raw)[2] = eps;
      write(target, new Uint8Array(raw));
    };
    const writeRope = (target, heads, pos, scale) => {
      const raw = new ArrayBuffer(16);
      new Uint32Array(raw)[0] = heads;
      new Uint32Array(raw)[1] = pos;
      new Uint32Array(raw)[2] = 64;
      new Float32Array(raw)[3] = scale;
      write(target, new Uint8Array(raw));
    };
    const writeAttn = (target, pos, window) => write(target, new Uint32Array([pos, pos + 1, window, 16]));
    const writeGemv = (target, n, k, blocks) => write(target, new Uint32Array([n, k, blocks, 1]));

    const bindGemv = (w, input, output, metaBuf) => device.createBindGroup({
      layout: gemvPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: w.q4 } },
        { binding: 1, resource: { buffer: w.scales } },
        { binding: 2, resource: { buffer: input } },
        { binding: 3, resource: { buffer: output } },
        { binding: 4, resource: { buffer: metaBuf } }
      ]
    });
    const bindNorm = (input, weight, output, metaBuf) => device.createBindGroup({
      layout: rmsPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: input } },
        { binding: 1, resource: { buffer: weight } },
        { binding: 2, resource: { buffer: output } },
        { binding: 3, resource: { buffer: metaBuf } }
      ]
    });
    const bindRope = (input, output, inv, metaBuf) => device.createBindGroup({
      layout: ropePipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: input } },
        { binding: 1, resource: { buffer: inv } },
        { binding: 2, resource: { buffer: output } },
        { binding: 3, resource: { buffer: metaBuf } }
      ]
    });
    const bindAttn = (layer, metaBuf) => device.createBindGroup({
      layout: attnPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: act.q } },
        { binding: 1, resource: { buffer: layer.kc } },
        { binding: 2, resource: { buffer: layer.vc } },
        { binding: 3, resource: { buffer: act.attn } },
        { binding: 4, resource: { buffer: metaBuf } }
      ]
    });
    const bindSilu = (a, b, y) => device.createBindGroup({
      layout: siluPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: a } },
        { binding: 1, resource: { buffer: b } },
        { binding: 2, resource: { buffer: y } }
      ]
    });
    const bindAdd = (a, b, y) => device.createBindGroup({
      layout: addPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: a } },
        { binding: 1, resource: { buffer: b } },
        { binding: 2, resource: { buffer: y } }
      ]
    });

    const SCALE = 0.297358;
    const binds = layers.map((layer, index) => ({
      qkv: bindGemv(layer.w.qkv, act.n1, act.qkv, meta.qkv),
      o: bindGemv(layer.w.o, act.attn, act.o, meta.o),
      gateUp: bindGemv(layer.w.gateUp, act.n2, act.gu, meta.gu),
      down: bindGemv(layer.w.down, act.s, act.d, meta.down),
      preMixer: bindNorm(act.x, layer.norms.preMixer, act.n1, meta.n1536),
      postMixer: bindNorm(act.o, layer.norms.postMixer, act.post, meta.n1536),
      preMlp: bindNorm(act.res, layer.norms.preMlp, act.n2, meta.n1536),
      postMlp: bindNorm(act.d, layer.norms.postMlp, act.post, meta.n1536),
      q: bindNorm(act.q, layer.norms.qNorm, act.qN, meta.nQ),
      k: bindNorm(act.k, layer.norms.kNorm, act.kN, meta.nK),
      rQ: bindRope(act.qN, act.qR, layer.inv, meta.rQ[index % 4]),
      rK: bindRope(act.kN, act.kR, layer.inv, meta.rK[index % 4]),
      attn: bindAttn(layer, meta.attn[index % 4])
    }));
    const headBind = bindGemv({ q4: headBuf.q4, scales: headBuf.scales }, act.n1, act.logits, meta.head);
    const finalNormBind = bindNorm(act.x, finalW, act.n1, meta.n1536);
    const siluGate = bindSilu(act.gate, act.up, act.s);
    const addMixer = bindAdd(act.x, act.post, act.res);
    const addMlp = bindAdd(act.res, act.post, act.x);

    const emit = (encoder, pipe, bind, groups) => {
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipe);
      pass.setBindGroup(0, bind);
      if (Array.isArray(groups)) pass.dispatchWorkgroups(groups[0], groups[1]);
      else pass.dispatchWorkgroups(groups);
      pass.end();
    };
    const gemvGroups = (matrix) => [4096, Math.ceil(matrix.N / 4096)];

    const readFloats = async (buffer, floats) => {
      const staging = device.createBuffer({ size: floats * 4, usage: U.MAP_READ | U.COPY_DST });
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(buffer, 0, staging, 0, floats * 4);
      device.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const out = new Float32Array(staging.getMappedRange().slice(0));
      staging.unmap();
      return out;
    };

    writeNorm(meta.n1536, 1536, 1, 1e-6);
    writeNorm(meta.nQ, 128, 16, 1e-6);
    writeNorm(meta.nK, 128, 1, 1e-6);
    // One position through all 16 layers, then the head. Everything stays on
    // the GPU except the final logits: the q/k/v split is three buffer copies.
    const layerStates = [];
    const stepOnce = async (token, pos) => {
      const row = new Float32Array(1536);
      for (let i = 0; i < 1536; i += 1) row[i] = decodeF16(embedF16[token * 1536 + i]);
      write(act.x, row);
      let encoder = device.createCommandEncoder();
      for (let index = 0; index < 16; index += 1) {
        const bind = binds[index];
        const layer = layers[index];
        emit(encoder, rmsPipe, bind.preMixer, 1);
        writeGemv(meta.qkv, 2304, 1536, 12);
        emit(encoder, gemvPipe, bind.qkv, gemvGroups(layer.w.qkv.manifest));
        encoder.copyBufferToBuffer(act.qkv, 0, act.q, 0, 2048 * 4);
        encoder.copyBufferToBuffer(act.qkv, 2048 * 4, act.k, 0, 128 * 4);
        encoder.copyBufferToBuffer(act.qkv, 2176 * 4, act.v, 0, 128 * 4);
        writeRope(meta.rQ[index % 4], 16, pos, SCALE);
        writeRope(meta.rK[index % 4], 1, pos, SCALE);
        writeAttn(meta.attn[index % 4], pos, 2048);
        emit(encoder, rmsPipe, bind.q, 16);
        emit(encoder, rmsPipe, bind.k, 1);
        emit(encoder, ropePipe, bind.rQ, 16);
        emit(encoder, ropePipe, bind.rK, 1);
        encoder.copyBufferToBuffer(act.qR, 0, act.q, 0, 2048 * 4);
        encoder.copyBufferToBuffer(act.kR, 0, act.k, 0, 128 * 4);
        encoder.copyBufferToBuffer(act.k, 0, layer.kc, pos * 128 * 4, 128 * 4);
        encoder.copyBufferToBuffer(act.v, 0, layer.vc, pos * 128 * 4, 128 * 4);
        emit(encoder, attnPipe, bind.attn, 16);
        writeGemv(meta.o, 1536, 2048, 16);
        emit(encoder, gemvPipe, bind.o, gemvGroups(layer.w.o.manifest));
        emit(encoder, rmsPipe, bind.postMixer, 1);
        emit(encoder, addPipe, addMixer, Math.ceil(1536 / 256));
        emit(encoder, rmsPipe, bind.preMlp, 1);
        writeGemv(meta.gu, 12288, 1536, 12);
        emit(encoder, gemvPipe, bind.gateUp, gemvGroups(layer.w.gateUp.manifest));
        encoder.copyBufferToBuffer(act.gu, 0, act.gate, 0, 6144 * 4);
        encoder.copyBufferToBuffer(act.gu, 6144 * 4, act.up, 0, 6144 * 4);
        emit(encoder, siluPipe, siluGate, Math.ceil(6144 / 256));
        writeGemv(meta.down, 1536, 6144, 48);
        emit(encoder, gemvPipe, bind.down, gemvGroups(layer.w.down.manifest));
        emit(encoder, rmsPipe, bind.postMlp, 1);
        emit(encoder, addPipe, addMlp, Math.ceil(1536 / 256));
        if (config?.collectLayers) {
          device.queue.submit([encoder.finish()]);
          layerStates.push(Array.from(await readFloats(act.x, 1536)));
          encoder = device.createCommandEncoder();
        }
      }
      emit(encoder, rmsPipe, finalNormBind, 1);
      writeGemv(meta.head, 107520, 1536, 12);
      emit(encoder, gemvPipe, headBind, gemvGroups(headManifest));
      device.queue.submit([encoder.finish()]);
      // The step's wall time has to include the device's work, not just the
      // submission.
      await device.queue.onSubmittedWorkDone();
    };

    const ids = config?.prompt ?? [];
    const steps = config?.steps ?? 8;
    const reference = config?.reference ? Float32Array.from(config.reference) : null;
    const generated = [];
    const times = [];
    let pos = 0;
    const argmax = async () => {
      const logits = await readFloats(act.logits, 107520);
      let best = -Infinity;
      let pick = 0;
      for (let i = 0; i < logits.length; i += 1) if (logits[i] > best) { best = logits[i]; pick = i; }
      return pick;
    };
    for (const id of ids) {
      const started = performance.now();
      await stepOnce(id, pos);
      times.push(performance.now() - started);
      pos += 1;
    }
    let comparison = null;
    if (reference) {
      const logits = await readFloats(act.logits, 107520);
      let maxAbs = 0;
      let sumAbs = 0;
      let dot = 0;
      let a2 = 0;
      let b2 = 0;
      for (let i = 0; i < logits.length; i += 1) {
        const diff = Math.abs(logits[i] - reference[i]);
        maxAbs = Math.max(maxAbs, diff);
        sumAbs += diff;
        dot += logits[i] * reference[i];
        a2 += logits[i] * logits[i];
        b2 += reference[i] * reference[i];
      }
      comparison = {
        maxAbs: Math.round(maxAbs * 1000) / 1000,
        meanAbs: Math.round((sumAbs / logits.length) * 1000) / 1000,
        cosine: Math.round((dot / Math.sqrt(a2 * b2)) * 100000) / 100000,
        referenceMeanAbs: Math.round((Math.sqrt(b2 / logits.length)) * 1000) / 1000
      };
    }
    for (let step = 0; step < steps; step += 1) {
      generated.push(await argmax());
      if (step === steps - 1) break;
      const started = performance.now();
      await stepOnce(generated[generated.length - 1], pos);
      times.push(performance.now() - started);
      pos += 1;
    }
    times.sort((a, b) => a - b);
    return {
      layers: config?.collectLayers ? layerStates : undefined,
      comparison,
      generated,
      msPerToken: Math.round(times[Math.floor(times.length / 2)] * 10) / 10,
      tokensPerSecond: Math.round((1000 / times[Math.floor(times.length / 2)]) * 100) / 100,
      promptLength: ids.length
    };
  };

  /** One layer in isolation: feed the residual stream the previous layer produced
   *  and compare every stage with ORT running the same subgraph. */
  window.__singleLayerProbe = async (layerIndex, inputValues, reference, layerManifest) => {
    const base = new URL('/micro/mm/', location.href);
    const get = async (name) => new Uint8Array(await (await fetch(new URL(name, base))).arrayBuffer());
    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter.requestDevice();
    const U = GPUBufferUsage;
    const alloc = (bytes) => device.createBuffer({ size: Math.max(16, Math.ceil(bytes / 4) * 4), usage: U.STORAGE | U.COPY_DST | U.COPY_SRC });
    const uni = (bytes) => device.createBuffer({ size: Math.max(16, bytes), usage: U.UNIFORM | U.COPY_DST });
    const write = (b, d) => device.queue.writeBuffer(b, 0, d);
    const pipeline = (code) => device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code }), entryPoint: 'main' } });
    const gemv = pipeline(gemvCoalescedWgsl(1));
    const rms = pipeline(RMSNORM_WGSL);
    const rope = pipeline(ROPE_WGSL);
    const attnP = pipeline(ATTENTION_WGSL);
    const silu = pipeline(SILU_MUL_WGSL);
    const addP = pipeline(ADD_WGSL);

    const entry = layerManifest;
    const wbuf = {};
    for (const [key, matrix] of Object.entries(entry.matrices)) {
      const q4 = await get(`${matrix.name}.q4.bin`);
      const scales = new Float32Array((await get(`${matrix.name}.scales.bin`)).buffer);
      wbuf[key] = { q4: alloc(q4.byteLength), scales: alloc(scales.byteLength), manifest: matrix };
      write(wbuf[key].q4, q4);
      write(wbuf[key].scales, scales);
    }
    const wnorm = {};
    for (const [key, norm] of Object.entries(entry.norms)) {
      wnorm[key] = alloc(norm.length * 4);
      write(wnorm[key], new Float32Array((await get(`${norm.name}.f32.bin`)).buffer));
    }
    const inv = alloc(64 * 4);
    write(inv, new Float32Array((await get(`${entry.invFreq.name}.f32.bin`)).buffer));

    const b = {
      x: alloc(1536 * 4), n1: alloc(1536 * 4), qkv: alloc(2304 * 4), q: alloc(2048 * 4), k: alloc(128 * 4), v: alloc(128 * 4),
      qN: alloc(2048 * 4), kN: alloc(128 * 4), qR: alloc(2048 * 4), kR: alloc(128 * 4), attn: alloc(2048 * 4),
      o: alloc(1536 * 4), post: alloc(1536 * 4), res: alloc(1536 * 4), n2: alloc(1536 * 4),
      gu: alloc(12288 * 4), gate: alloc(6144 * 4), up: alloc(6144 * 4), s: alloc(6144 * 4), d: alloc(1536 * 4),
      kc: alloc(512 * 128 * 4), vc: alloc(512 * 128 * 4)
    };
    const meta = { qkv: uni(16), o: uni(16), gu: uni(16), down: uni(16), n1536: uni(16), nQ: uni(16), nK: uni(16), rQ: uni(16), rK: uni(16), attn: uni(16) };
    const normMeta = (target, n, rows) => {
      const raw = new ArrayBuffer(16);
      new Uint32Array(raw)[0] = n;
      new Uint32Array(raw)[1] = rows;
      new Float32Array(raw)[2] = 1e-6;
      write(target, new Uint8Array(raw));
    };
    const ropeMeta = (target, heads) => {
      const raw = new ArrayBuffer(16);
      new Uint32Array(raw)[0] = heads;
      new Uint32Array(raw)[1] = 0;
      new Uint32Array(raw)[2] = 64;
      new Float32Array(raw)[3] = 0.297358;
      write(target, new Uint8Array(raw));
    };
    const gemvMeta = (target, m) => write(target, new Uint32Array([m.N, m.K, m.K / m.block, 1]));
    normMeta(meta.n1536, 1536, 1);
    normMeta(meta.nQ, 128, 16);
    normMeta(meta.nK, 128, 1);
    ropeMeta(meta.rQ, 16);
    ropeMeta(meta.rK, 1);
    write(meta.attn, new Uint32Array([0, 1, 2048, 16]));
    gemvMeta(meta.qkv, wbuf.qkv.manifest);
    gemvMeta(meta.o, wbuf.o.manifest);
    gemvMeta(meta.gu, wbuf.gateUp.manifest);
    gemvMeta(meta.down, wbuf.down.manifest);

    const bg = (layout, buffers) => device.createBindGroup({
      layout,
      entries: buffers.map((buffer, index) => ({ binding: index, resource: { buffer } }))
    });
    const bind = {
      preMixer: bg(rms.getBindGroupLayout(0), [b.x, wnorm.preMixer, b.n1, meta.n1536]),
      qkv: bg(gemv.getBindGroupLayout(0), [wbuf.qkv.q4, wbuf.qkv.scales, b.n1, b.qkv, meta.qkv]),
      qN: bg(rms.getBindGroupLayout(0), [b.q, wnorm.qNorm, b.qN, meta.nQ]),
      kN: bg(rms.getBindGroupLayout(0), [b.k, wnorm.kNorm, b.kN, meta.nK]),
      rQ: bg(rope.getBindGroupLayout(0), [b.qN, inv, b.qR, meta.rQ]),
      rK: bg(rope.getBindGroupLayout(0), [b.kN, inv, b.kR, meta.rK]),
      attn: bg(attnP.getBindGroupLayout(0), [b.q, b.kc, b.vc, b.attn, meta.attn]),
      o: bg(gemv.getBindGroupLayout(0), [wbuf.o.q4, wbuf.o.scales, b.attn, b.o, meta.o]),
      postMixer: bg(rms.getBindGroupLayout(0), [b.o, wnorm.postMixer, b.post, meta.n1536]),
      addMixer: bg(addP.getBindGroupLayout(0), [b.x, b.post, b.res]),
      preMlp: bg(rms.getBindGroupLayout(0), [b.res, wnorm.preMlp, b.n2, meta.n1536]),
      gateUp: bg(gemv.getBindGroupLayout(0), [wbuf.gateUp.q4, wbuf.gateUp.scales, b.n2, b.gu, meta.gu]),
      silu: bg(silu.getBindGroupLayout(0), [b.gate, b.up, b.s]),
      down: bg(gemv.getBindGroupLayout(0), [wbuf.down.q4, wbuf.down.scales, b.s, b.d, meta.down]),
      postMlp: bg(rms.getBindGroupLayout(0), [b.d, wnorm.postMlp, b.post, meta.n1536]),
      addMlp: bg(addP.getBindGroupLayout(0), [b.res, b.post, b.x])
    };
    write(b.x, inputValues);
    const emit = (encoder, pipe, bindGroup, groups) => {
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipe);
      pass.setBindGroup(0, bindGroup);
      if (Array.isArray(groups)) pass.dispatchWorkgroups(groups[0], groups[1]);
      else pass.dispatchWorkgroups(groups);
      pass.end();
    };
    const groups = (m) => [4096, Math.ceil(m.N / 4096)];
    const readFloats = async (buffer, floats) => {
      const staging = device.createBuffer({ size: floats * 4, usage: U.MAP_READ | U.COPY_DST });
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(buffer, 0, staging, 0, floats * 4);
      device.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const out = new Float32Array(staging.getMappedRange().slice(0));
      staging.unmap();
      return out;
    };
    const e1 = device.createCommandEncoder();
    emit(e1, rms, bind.preMixer, 1);
    emit(e1, gemv, bind.qkv, groups(wbuf.qkv.manifest));
    device.queue.submit([e1.finish()]);
    const n1 = await readFloats(b.n1, 1536);
    const qkv = await readFloats(b.qkv, 2304);
    write(b.q, qkv.slice(0, 2048));
    write(b.k, qkv.slice(2048, 2176));
    write(b.v, qkv.slice(2176, 2304));
    const e2 = device.createCommandEncoder();
    emit(e2, rms, bind.qN, 16);
    emit(e2, rms, bind.kN, 1);
    emit(e2, rope, bind.rQ, 16);
    emit(e2, rope, bind.rK, 1);
    e2.copyBufferToBuffer(b.qR, 0, b.q, 0, 2048 * 4);
    e2.copyBufferToBuffer(b.kR, 0, b.k, 0, 128 * 4);
    e2.copyBufferToBuffer(b.k, 0, b.kc, 0, 128 * 4);
    e2.copyBufferToBuffer(b.v, 0, b.vc, 0, 128 * 4);
    emit(e2, attnP, bind.attn, 16);
    emit(e2, gemv, bind.o, groups(wbuf.o.manifest));
    emit(e2, rms, bind.postMixer, 1);
    emit(e2, addP, bind.addMixer, Math.ceil(1536 / 256));
    emit(e2, rms, bind.preMlp, 1);
    emit(e2, gemv, bind.gateUp, groups(wbuf.gateUp.manifest));
    e2.copyBufferToBuffer(b.gu, 0, b.gate, 0, 6144 * 4);
    e2.copyBufferToBuffer(b.gu, 6144 * 4, b.up, 0, 6144 * 4);
    emit(e2, silu, bind.silu, Math.ceil(6144 / 256));
    emit(e2, gemv, bind.down, groups(wbuf.down.manifest));
    emit(e2, rms, bind.postMlp, 1);
    emit(e2, addP, bind.addMlp, Math.ceil(1536 / 256));
    device.queue.submit([e2.finish()]);

    const cmp = (label, ours) => {
      const ref = reference[label];
      if (!ref) return { label, missing: true };
      const refValues = ref.values;
      let maxAbs = 0;
      let sumAbs = 0;
      const n = Math.min(ours.length, refValues.length);
      for (let i = 0; i < n; i += 1) {
        const diff = Math.abs(ours[i] - refValues[i]);
        maxAbs = Math.max(maxAbs, diff);
        sumAbs += diff;
      }
      return { label, maxAbs: Math.round(maxAbs * 1000) / 1000, meanAbs: Math.round((sumAbs / n) * 1000) / 1000 };
    };
    const attnOut = await readFloats(b.attn, 2048);
    const oOut = await readFloats(b.o, 1536);
    const out = await readFloats(b.x, 1536);
    return {
      layerIndex,
      stages: [cmp('norm1', n1), cmp('qkv', qkv), cmp('attn', attnOut), cmp('o', oOut), cmp('out', out)]
    };
  };

  /** The attention kernel on its own: hand-filled q/k/v, two positions, so the
   *  uniform path and dispatch ordering are tested without the rest of the chain. */
  window.__attnProbe = async () => {
    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter.requestDevice();
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const buf = (bytes) => device.createBuffer({ size: bytes, usage: storage });
    const uni = (bytes) => device.createBuffer({ size: bytes, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const q = buf(2048 * 4);
    const kc = buf(512 * 128 * 4);
    const vc = buf(512 * 128 * 4);
    const out = buf(2048 * 4);
    const meta = uni(16);
    const write = (b, d) => device.queue.writeBuffer(b, 0, d);
    // deterministic data
    const qd = new Float32Array(2048);
    const kd = new Float32Array(512 * 128);
    const vd = new Float32Array(512 * 128);
    let seed = 7;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return (seed >>> 8) / 0x1000000 - 0.5;
    };
    for (let i = 0; i < qd.length; i += 1) qd[i] = next();
    for (let i = 0; i < 2 * 128; i += 1) { kd[i] = next(); vd[i] = next(); }
    write(q, qd);
    write(kc, kd);
    write(vc, vd);
    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: ATTENTION_WGSL }), entryPoint: 'main' }
    });
    const bind = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: q } },
        { binding: 1, resource: { buffer: kc } },
        { binding: 2, resource: { buffer: vc } },
        { binding: 3, resource: { buffer: out } },
        { binding: 4, resource: { buffer: meta } }
      ]
    });
    const run = async (pos) => {
      write(meta, new Uint32Array([pos, pos + 1, 2048, 16]));
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(16);
      pass.end();
      device.queue.submit([encoder.finish()]);
      const staging = device.createBuffer({ size: 2048 * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const copy = device.createCommandEncoder();
      copy.copyBufferToBuffer(out, 0, staging, 0, 2048 * 4);
      device.queue.submit([copy.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const values = Array.from(new Float32Array(staging.getMappedRange().slice(0)));
      staging.unmap();
      return values.slice(0, 3).map((v) => Math.round(v * 1000) / 1000);
    };
    const at0 = await run(0);
    const at1 = await run(1);
    // JS reference for head 0
    const ref = (pos) => {
      const scores = [];
      for (let j = 0; j <= pos; j += 1) {
        let acc = 0;
        for (let i = 0; i < 128; i += 1) acc += qd[i] * kd[j * 128 + i];
        scores.push(acc);
      }
      const top = Math.max(...scores);
      const exps = scores.map((v) => Math.exp(v - top));
      const denom = exps.reduce((a, b) => a + b, 0);
      return [0, 1, 2].map((i) => {
        let acc = 0;
        for (let j = 0; j <= pos; j += 1) acc += (exps[j] / denom) * vd[j * 128 + i];
        return Math.round(acc * 1000) / 1000;
      });
    };
    return { at0, at1, js0: ref(0), js1: ref(1) };
  };

  window.__blockProbe = async (tokens, dump) => {
    const base = new URL('/micro/mm/', location.href);
    const get = async (name) => new Uint8Array(await (await fetch(new URL(name, base))).arrayBuffer());
    const getJson = async (name) => await (await fetch(new URL(name, base))).json();
    const manifest = await getJson('manifest.json');
    const embedBytes = await get('embed.f16.bin');
    const embedF16 = new Uint16Array(embedBytes.buffer, embedBytes.byteOffset, embedBytes.byteLength / 2);
    const L0 = manifest.layers[0];
    const loadMatrix = async (entry) => ({
      q4: await get(`${entry.name}.q4.bin`),
      scales: new Float32Array((await get(`${entry.name}.scales.bin`)).buffer),
      manifest: entry
    });
    const matrices = {};
    for (const [key, entry] of Object.entries(L0.matrices)) matrices[key] = await loadMatrix(entry);
    const norms = {};
    for (const [key, entry] of Object.entries(L0.norms)) norms[key] = new Float32Array((await get(`${entry.name}.f32.bin`)).buffer);
    const invFreq = new Float32Array((await get(`L0_invFreq.f32.bin`)).buffer);

    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter.requestDevice();
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    const buffers = [];
    const buffer = (bytes) => {
      const b = device.createBuffer({
        size: Math.max(16, Math.ceil(bytes / 4) * 4),
        usage: storage | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
      });
      buffers.push(b);
      return b;
    };
    const write = (b, data) => device.queue.writeBuffer(b, 0, data);
    const read = async (b, floats) => {
      const staging = device.createBuffer({ size: floats * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const enc = device.createCommandEncoder();
      enc.copyBufferToBuffer(b, 0, staging, 0, floats * 4);
      device.queue.submit([enc.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const out = new Float32Array(staging.getMappedRange().slice(0));
      staging.unmap();
      return out;
    };
    const pipeline = (code) => device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code }), entryPoint: 'main' } });

    const gemv = pipeline(gemvCoalescedWgsl(1));
    const rms = pipeline(RMSNORM_WGSL);
    const rope = pipeline(ROPE_WGSL);
    const attn = pipeline(ATTENTION_WGSL);
    const silu = pipeline(SILU_MUL_WGSL);
    const add = pipeline(ADD_WGSL);

    const L = tokens.length;
    const MAXK = 512;
    const buf = {
      x: buffer(1536 * 4),
      n1: buffer(1536 * 4),
      qkv: buffer(2304 * 4),
      q: buffer(2048 * 4),
      k: buffer(128 * 4),
      v: buffer(128 * 4),
      qN: buffer(2048 * 4),
      kN: buffer(128 * 4),
      qR: buffer(2048 * 4),
      kR: buffer(128 * 4),
      gate: buffer(6144 * 4),
      up: buffer(6144 * 4),
      attn: buffer(2048 * 4),
      o: buffer(1536 * 4),
      post: buffer(1536 * 4),
      res: buffer(1536 * 4),
      n2: buffer(1536 * 4),
      gu: buffer(12288 * 4),
      s: buffer(6144 * 4),
      d: buffer(1536 * 4),
      kc: buffer(MAXK * 128 * 4),
      vc: buffer(MAXK * 128 * 4),
      dummyW: buffer(1536 * 4)
    };
    const wbuf = {};
    for (const [key, m] of Object.entries(matrices)) {
      wbuf[key] = {
        q4: buffer(m.q4.byteLength),
        scales: buffer(m.scales.byteLength),
        manifest: m.manifest
      };
      write(wbuf[key].q4, m.q4);
      write(wbuf[key].scales, m.scales);
    }
    const wnorm = {};
    for (const [key, data] of Object.entries(norms)) {
      wnorm[key] = buffer(data.byteLength);
      write(wnorm[key], data);
    }
    const winv = buffer(invFreq.byteLength);
    write(winv, invFreq);

    const uniform = (bytes) => device.createBuffer({ size: Math.max(16, bytes), usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    // One uniform buffer per dispatch site: several dispatches share a
    // submission, so a single buffer would be rewritten before execution.
    const meta = {
      gemvQkv: uniform(16), gemvO: uniform(16), gemvGu: uniform(16), gemvD: uniform(16),
      norm1536: uniform(16), normQ: uniform(16), normK: uniform(16),
      ropeQ: uniform(16), ropeK: uniform(16), attn: uniform(16)
    };
    const mGemv = (target, n, k, blocks) => write(meta[target], new Uint32Array([n, k, blocks, 1]));
    const mNorm = (target, n, rows, eps) => {
      const raw = new ArrayBuffer(16);
      new Uint32Array(raw)[0] = n;
      new Uint32Array(raw)[1] = rows;
      new Float32Array(raw)[2] = eps;
      write(meta[target], new Uint8Array(raw));
    };
    const mRope = (target, heads, pos, half, scale) => {
      const raw = new ArrayBuffer(16);
      new Uint32Array(raw)[0] = heads;
      new Uint32Array(raw)[1] = pos;
      new Uint32Array(raw)[2] = half;
      new Float32Array(raw)[3] = scale;
      write(meta[target], new Uint8Array(raw));
    };
    const mAttn = (pos, window) => write(meta.attn, new Uint32Array([pos, pos + 1, window, 16]));

    const bindGemv = (name, xb, yb, target) => device.createBindGroup({
      layout: gemv.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: wbuf[name].q4 } },
        { binding: 1, resource: { buffer: wbuf[name].scales } },
        { binding: 2, resource: { buffer: xb } },
        { binding: 3, resource: { buffer: yb } },
        { binding: 4, resource: { buffer: meta[target] } }
      ]
    });
    const bindNorm = (xb, wb, yb, target) => device.createBindGroup({
      layout: rms.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: xb } },
        { binding: 1, resource: { buffer: wb } },
        { binding: 2, resource: { buffer: yb } },
        { binding: 3, resource: { buffer: meta[target] } }
      ]
    });
    const bindRope = (xb, yb, target) => device.createBindGroup({
      layout: rope.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: xb } },
        { binding: 1, resource: { buffer: winv } },
        { binding: 2, resource: { buffer: yb } },
        { binding: 3, resource: { buffer: meta[target] } }
      ]
    });
    const bindAttn = () => device.createBindGroup({
      layout: attn.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: buf.q } },
        { binding: 1, resource: { buffer: buf.kc } },
        { binding: 2, resource: { buffer: buf.vc } },
        { binding: 3, resource: { buffer: buf.attn } },
        { binding: 4, resource: { buffer: meta.attn } }
      ]
    });
    const bindSilu = (a, b, y) => device.createBindGroup({
      layout: silu.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: a } },
        { binding: 1, resource: { buffer: b } },
        { binding: 2, resource: { buffer: y } }
      ]
    });
    const bindAdd = (a, b, y) => device.createBindGroup({
      layout: add.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: a } },
        { binding: 1, resource: { buffer: b } },
        { binding: 2, resource: { buffer: y } }
      ]
    });
    const gemvBind = {
      qkv: bindGemv('qkv', buf.n1, buf.qkv, 'gemvQkv'),
      o: bindGemv('o', buf.attn, buf.o, 'gemvO'),
      gateUp: bindGemv('gateUp', buf.n2, buf.gu, 'gemvGu'),
      down: bindGemv('down', buf.s, buf.d, 'gemvD')
    };
    const normBind = {
      preMixer: bindNorm(buf.x, wnorm.preMixer, buf.n1, 'norm1536'),
      postMixer: bindNorm(buf.o, wnorm.postMixer, buf.post, 'norm1536'),
      preMlp: bindNorm(buf.res, wnorm.preMlp, buf.n2, 'norm1536'),
      postMlp: bindNorm(buf.d, wnorm.postMlp, buf.post, 'norm1536'),
      q: bindNorm(buf.q, wnorm.qNorm, buf.qN, 'normQ'),
      k: bindNorm(buf.k, wnorm.kNorm, buf.kN, 'normK')
    };
    const ropeQ = bindRope(buf.qN, buf.qR, 'ropeQ');
    const ropeK = bindRope(buf.kN, buf.kR, 'ropeK');
    const attnBind = bindAttn();
    const siluBind = bindSilu(buf.gate, buf.up, buf.s);
    const addMixer = bindAdd(buf.x, buf.post, buf.res);
    const addMlp = bindAdd(buf.res, buf.post, buf.x);

    const step = (pass, pipe, bind, groups) => {
      pass.setPipeline(pipe);
      pass.setBindGroup(0, bind);
      const list = Array.isArray(groups) ? groups : [groups];
      pass.dispatchWorkgroups(list[0], list[1] ?? 1);
    };
    const emit = (encoder, pipe, bind, groups) => {
      const pass = encoder.beginComputePass();
      step(pass, pipe, bind, groups);
      pass.end();
    };
    const gemvGroups = (name) => [4096, Math.ceil(wbuf[name].manifest.N / 4096)];
    const dispatchGemv = (encoder, name) => emit(encoder, gemv, gemvBind[name], gemvGroups(name));

    const results = { positions: [] };
    const kHistory = [];
    const vHistory = [];
    const SCALE = 0.297358;
    for (let pos = 0; pos < L; pos += 1) {
      // embedding row, f16 -> f32
      const token = tokens[pos];
      const row = new Float32Array(1536);
      for (let i = 0; i < 1536; i += 1) {
        const bits = embedF16[token * 1536 + i];
        row[i] = decodeF16(bits);
      }
      write(buf.x, row);
      const encoder = device.createCommandEncoder();
      // pre-mixer norm
      mNorm('norm1536', 1536, 1, 1e-6);
      emit(encoder, rms, normBind.preMixer, 1);
      // qkv
      mGemv('gemvQkv', 2304, 1536, 12);
      dispatchGemv(encoder, 'qkv');
      device.queue.submit([encoder.finish()]);
      const qkvFlat = await read(buf.qkv, 2304);
      const vRow = qkvFlat.slice(2176, 2304);
      write(buf.q, qkvFlat.slice(0, 2048));
      write(buf.k, qkvFlat.slice(2048, 2176));
      write(buf.v, qkvFlat.slice(2176, 2304));

      const e2 = device.createCommandEncoder();
      mNorm('normQ', 128, 16, 1e-6);
      emit(e2, rms, normBind.q, 16);
      mNorm('normK', 128, 1, 1e-6);
      emit(e2, rms, normBind.k, 1);
      mRope('ropeQ', 16, pos, 64, SCALE);
      emit(e2, rope, ropeQ, 16);
      mRope('ropeK', 1, pos, 64, SCALE);
      emit(e2, rope, ropeK, 1);
      // The roped, scaled q and k must be in place before the cache takes k.
      e2.copyBufferToBuffer(buf.qR, 0, buf.q, 0, 2048 * 4);
      e2.copyBufferToBuffer(buf.kR, 0, buf.k, 0, 128 * 4);
      e2.copyBufferToBuffer(buf.k, 0, buf.kc, pos * 128 * 4, 128 * 4);
      e2.copyBufferToBuffer(buf.v, 0, buf.vc, pos * 128 * 4, 128 * 4);
      mAttn(pos, 2048);
      emit(e2, attn, attnBind, 16);
      emit(e2, attn, attnBind, 16);
      mGemv('gemvO', 1536, 2048, 16);
      dispatchGemv(e2, 'o');
      mNorm('norm1536', 1536, 1, 1e-6);
      emit(e2, rms, normBind.postMixer, 1);
      emit(e2, add, addMixer, Math.ceil(1536 / 256));
      mNorm('norm1536', 1536, 1, 1e-6);
      emit(e2, rms, normBind.preMlp, 1);
      mGemv('gemvGu', 12288, 1536, 12);
      dispatchGemv(e2, 'gateUp');
      e2.copyBufferToBuffer(buf.gu, 0, buf.gate, 0, 6144 * 4);
      e2.copyBufferToBuffer(buf.gu, 6144 * 4, buf.up, 0, 6144 * 4);
      emit(e2, silu, siluBind, Math.ceil(6144 / 256));
      mGemv('gemvD', 1536, 6144, 48);
      dispatchGemv(e2, 'down');
      mNorm('norm1536', 1536, 1, 1e-6);
      emit(e2, rms, normBind.postMlp, 1);
      emit(e2, add, addMlp, Math.ceil(1536 / 256));
      device.queue.submit([e2.finish()]);

      const n1Out = await read(buf.n1, 1536);
      const qkvOut = await read(buf.qkv, 2304);
      const qNOut = await read(buf.qN, 2048);
      const qROut = await read(buf.qR, 2048);
      const qOut = await read(buf.q, 2048);
      const kOut = await read(buf.k, 128);
      kHistory.push(Float32Array.from(kOut));
      vHistory.push(Float32Array.from(vRow));
      const attnOut = await read(buf.attn, 2048);
      const layerOut = await read(buf.x, 1536);
      const qRef = new Float32Array(dump.qscaled.values);
      const kRef = new Float32Array(dump.rope_k.values);
      const attnRef = new Float32Array(dump.attn_out.values);
      const outRef = new Float32Array(dump.layer_out.values);
      const score = (ours, at, reference) => {
        let maxAbs = 0;
        let sumAbs = 0;
        for (let i = 0; i < ours.length; i += 1) {
          const diff = Math.abs(ours[i] - reference(at + i));
          maxAbs = Math.max(maxAbs, diff);
          sumAbs += diff;
        }
        return { maxAbs: Math.round(maxAbs * 1000) / 1000, meanAbs: Math.round((sumAbs / ours.length) * 1000) / 1000 };
      };
      const n1Ref = new Float32Array(dump.norm1.values);
      const qkvRef = new Float32Array(dump.qkv.values);
      const embedRef = new Float32Array(dump.embed.values);
      const qNormRef = new Float32Array(dump.qnorm.values);
      const ropeQRef = new Float32Array(dump.rope_q.values);
      const stage = {
        pos,
        n1: score(n1Out, 0, (i) => n1Ref[pos * 1536 + i]),
        qkv: score(qkvOut, 0, (i) => qkvRef[pos * 2304 + i]),
        qN: score(qNOut, 0, (i) => qNormRef[(Math.floor(i / 128) * L + pos) * 128 + (i % 128)]),
        qR: score(qROut, 0, (i) => ropeQRef[(Math.floor(i / 128) * L + pos) * 128 + (i % 128)]),
        // q at [1,16,L,128]; our buffer is one head after another at this position
        q: score(qOut, 0, (i) => {
          const head = Math.floor(i / 128);
          const d = i % 128;
          return qRef[(head * L + pos) * 128 + d];
        }),
        k: score(kOut, 0, (i) => kRef[pos * 128 + i] * SCALE),
        attn: score(attnOut, 0, (i) => {
          const head = Math.floor(i / 128);
          const d = i % 128;
          return attnRef[(head * L + pos) * 128 + d];
        }),
        out: score(layerOut, 0, (i) => outRef[pos * 1536 + i])
      };
      stage.embed = score(row, 0, (i) => embedRef[pos * 1536 + i]);
      // JS reference for the scores, from data we know matches the dump.
      const scoreRef = new Float32Array(dump.attn_scores.values);
      let scoreMax = 0;
      let softMax = 0;
      const softRef = new Float32Array(dump.attn_softmax.values);
      for (let h = 0; h < 16; h += 1) {
        const scores = [];
        for (let j = 0; j <= pos; j += 1) {
          let acc = 0;
          for (let i = 0; i < 128; i += 1) acc += qOut[h * 128 + i] * kHistory[j][i];
          scores.push(acc);
          scoreMax = Math.max(scoreMax, Math.abs(acc - scoreRef[(h * L + pos) * L + j]));
        }
        const top = Math.max(...scores);
        const exps = scores.map((v) => Math.exp(v - top));
        const denom = exps.reduce((a, b) => a + b, 0);
        for (let j = 0; j <= pos; j += 1) {
          softMax = Math.max(softMax, Math.abs(exps[j] / denom - softRef[(h * L + pos) * L + j]));
        }
        // our kernel's output for this head, recomputed from probs
        let outMax = 0;
        for (let i = 0; i < 128; i += 1) {
          let acc = 0;
          for (let j = 0; j <= pos; j += 1) acc += (exps[j] / denom) * vHistory[j][i];
          outMax = Math.max(outMax, Math.abs(acc - attnOut[h * 128 + i]));
        }
        if (h === 0) {
          stage.head0 = {
            ours: Array.from(attnOut.slice(0, 4)).map((v) => Math.round(v * 1000) / 1000),
            js: Array.from({ length: 4 }, (_, i) => {
              let acc = 0;
              for (let j = 0; j <= pos; j += 1) acc += (exps[j] / denom) * vHistory[j][i];
              return Math.round(acc * 1000) / 1000;
            }),
            ref: Array.from({ length: 4 }, (_, i) => Math.round(attnRef[(0 * L + pos) * 128 + i] * 1000) / 1000),
            scores: scores.map((v) => Math.round(v * 1000) / 1000)
          };
        }
      }
      stage.jsScores = Math.round(scoreMax * 1000) / 1000;
      stage.jsSoftmax = Math.round(softMax * 1000) / 1000;

      results.positions.push(stage);
    }
    results.referenceMeans = {
      qscaled: meanAbs(new Float32Array(dump.qscaled.values)),
      attn_out: meanAbs(new Float32Array(dump.attn_out.values)),
      layer_out: meanAbs(new Float32Array(dump.layer_out.values))
    };
    return results;
  };

  /** Run the layer-0 debug model for one token and hand back every intermediate
   *  tensor: ground truth for each kernel, on real weights and real activations. */
  window.__layerDump = async (tokens) => {
    const ids = Array.isArray(tokens) ? tokens : [tokens];
    const ort = globalThis.AT_ORT_WEBGPU;
    const base = new URL('/micro/mm/', location.href);
    const probes = await (await fetch(new URL('layer0_debug.json', base))).json();
    const model = new Uint8Array(await (await fetch(new URL('layer0_debug.onnx', base))).arrayBuffer());
    const session = await ort.InferenceSession.create(model, { executionProviders: ['webgpu'], logSeverityLevel: 3 });
    const meta = new Map(session.inputMetadata.map((entry) => [entry.name, entry]));
    const feeds = {};
    for (const [name, entry] of meta) {
      if (name === 'input_ids') {
        feeds[name] = new ort.Tensor('int64', BigInt64Array.from(ids.map((id) => BigInt(id))), [1, ids.length]);
      } else if (name === 'attention_mask') {
        feeds[name] = new ort.Tensor('int64', BigInt64Array.from(ids.map(() => 1n)), [1, ids.length]);
      } else if (name.startsWith('past_key_values')) {
        const dims = (entry.shape ?? []).map((d) => (typeof d === 'number' ? d : d === 'batch_size' ? 1 : 0));
        const size = dims.reduce((a, b) => a * b, 1);
        const type = entry.type;
        const data = type === 'float16' ? new Uint16Array(size) : type === 'float32' ? new Float32Array(size) : new BigInt64Array(size);
        feeds[name] = new ort.Tensor(type, data, dims);
      }
    }
    const out = await session.run(feeds);
    const dump = {};
    for (const [label, tensorName] of Object.entries(probes)) {
      const value = out[tensorName];
      if (!value) continue;
      const data = await value.getData();
      dump[label] = { dims: [...value.dims], values: Array.from(data).map((v) => Math.round(Number(v) * 1e5) / 1e5) };
    }
    await session.release?.();
    return dump;
  };

  /** Reproduce layer 0 with our own kernels and compare every stage against the
   *  dumped ORT tensors. One token, so RoPE is the identity and softmax is 1. */
  window.__layerProbe = async (dump) => {
    const base = new URL('/micro/mm/', location.href);
    const load = async (name, kind) => {
      if (kind === 'json') return await (await fetch(new URL(name, base))).json();
      const bytes = new Uint8Array(await (await fetch(new URL(name, base))).arrayBuffer());
      return bytes;
    };
    const f32 = (bytes) => new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const matrices = {};
    for (const name of ['qkv0', 'o0', 'gateup0', 'down0']) {
      const manifest = await load(`${name}.json`, 'json');
      const q4 = await load(`${name}.q4.bin`, 'bytes');
      const scales = f32(await load(`${name}.scales.bin`, 'bytes'));
      matrices[name] = { manifest, q4, scales };
    }
    const norm1w = f32(await load('norm1_w.f32.bin', 'bytes'));
    const norm2w = f32(await load('norm2_w.f32.bin', 'bytes'));
    const qnormw = f32(await load('qnorm_w.f32.bin', 'bytes'));
    const knormw = f32(await load('knorm_w.f32.bin', 'bytes'));
    const postnorm1w = f32(await load('postnorm1_w.f32.bin', 'bytes'));
    const postnorm2w = f32(await load('postnorm2_w.f32.bin', 'bytes'));

    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter.requestDevice();
    const make = (bytes, usage) => {
      const buffer = device.createBuffer({ size: Math.ceil(bytes / 4) * 4, usage: usage | GPUBufferUsage.COPY_DST });
      return buffer;
    };
    const upload = (buffer, data) => device.queue.writeBuffer(buffer, 0, data);
    const readGpu = async (buffer, byteLength) => {
      const staging = device.createBuffer({ size: byteLength, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(buffer, 0, staging, 0, byteLength);
      device.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const out = new Float32Array(staging.getMappedRange().slice(0));
      staging.unmap();
      staging.destroy?.();
      return out;
    };

    // Pipelines and their buffers, sized for this token.
    const pipelineOf = (code) => device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code }), entryPoint: 'main' } });
    const rmsPipeline = pipelineOf(RMSNORM_WGSL);
    const siluPipeline = pipelineOf(SILU_MUL_WGSL);
    const addPipeline = pipelineOf(ADD_WGSL);
    const gemvPipeline = pipelineOf(gemvCoalescedWgsl(1));

    const wmat = {};
    for (const [name, entry] of Object.entries(matrices)) {
      wmat[name] = {
        q4: make(entry.q4.byteLength, GPUBufferUsage.STORAGE),
        scales: make(entry.scales.byteLength, GPUBufferUsage.STORAGE),
        manifest: entry.manifest
      };
      upload(wmat[name].q4, entry.q4);
      upload(wmat[name].scales, entry.scales);
    }
    const xBuffer = make(32768 * 4, GPUBufferUsage.STORAGE);
    const yBuffer = make(131072 * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const wBuffer = make(65536 * 4, GPUBufferUsage.STORAGE);
    const aBuffer = make(65536 * 4, GPUBufferUsage.STORAGE);
    const bBuffer = make(65536 * 4, GPUBufferUsage.STORAGE);
    const metaGemv = make(16, GPUBufferUsage.UNIFORM);
    const metaNorm = make(16, GPUBufferUsage.UNIFORM);

    const bindGemv = (name) => device.createBindGroup({
      layout: gemvPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: wmat[name].q4 } },
        { binding: 1, resource: { buffer: wmat[name].scales } },
        { binding: 2, resource: { buffer: xBuffer } },
        { binding: 3, resource: { buffer: yBuffer } },
        { binding: 4, resource: { buffer: metaGemv } }
      ]
    });
    const gemvBinds = Object.fromEntries(Object.keys(wmat).map((name) => [name, bindGemv(name)]));

    const runGemv = async (name, input) => {
      const { manifest } = wmat[name];
      upload(xBuffer, input);
      upload(metaGemv, new Uint32Array([manifest.N, manifest.K, manifest.K / manifest.block, 1]));
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(gemvPipeline);
      pass.setBindGroup(0, gemvBinds[name]);
      pass.dispatchWorkgroups(4096, Math.ceil(manifest.N / 4096));
      pass.end();
      device.queue.submit([encoder.finish()]);
      return await readGpu(yBuffer, manifest.N * 4);
    };

    const normBind = {};
    const runNorm = async (input, weight, rows, n, wname) => {
      upload(xBuffer, input);
      upload(wBuffer, weight);
      upload(metaNorm, new Float32Array([n, rows, 1e-6, 0]).reduce((acc, v, i) => {
        if (i < 2) acc[i] = v;
        return acc;
      }, new Uint32Array(4)) && new (function () {} )()) ; // replaced below
      return null;
    };

    // The uniform is mixed u32/f32: write the two counts and the epsilon by hand.
    const writeNormMeta = (n, rows, eps) => {
      const bytes = new ArrayBuffer(16);
      const u = new Uint32Array(bytes);
      const f = new Float32Array(bytes);
      u[0] = n;
      u[1] = rows;
      f[2] = eps;
      u[3] = 0;
      device.queue.writeBuffer(metaNorm, 0, bytes);
    };
    const runNormReal = async (input, weight, rows, n) => {
      upload(xBuffer, input);
      upload(wBuffer, weight);
      writeNormMeta(n, rows, 1e-6);
      const bind = device.createBindGroup({
        layout: rmsPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: xBuffer } },
          { binding: 1, resource: { buffer: wBuffer } },
          { binding: 2, resource: { buffer: yBuffer } },
          { binding: 3, resource: { buffer: metaNorm } }
        ]
      });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(rmsPipeline);
      pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(rows);
      pass.end();
      device.queue.submit([encoder.finish()]);
      return await readGpu(yBuffer, rows * n * 4);
    };
    void normBind;
    void runNorm;

    const runSilu = async (gate, up) => {
      upload(aBuffer, gate);
      upload(bBuffer, up);
      const bind = device.createBindGroup({
        layout: siluPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: aBuffer } },
          { binding: 1, resource: { buffer: bBuffer } },
          { binding: 2, resource: { buffer: yBuffer } }
        ]
      });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(siluPipeline);
      pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(Math.ceil(gate.length / 256));
      pass.end();
      device.queue.submit([encoder.finish()]);
      return await readGpu(yBuffer, gate.length * 4);
    };
    const runAdd = async (a, b) => {
      upload(aBuffer, a);
      upload(bBuffer, b);
      const bind = device.createBindGroup({
        layout: addPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: aBuffer } },
          { binding: 1, resource: { buffer: bBuffer } },
          { binding: 2, resource: { buffer: yBuffer } }
        ]
      });
      const encoder = device.createCommandEncoder();
      pass0: {
        const pass = encoder.beginComputePass();
        pass.setPipeline(addPipeline);
        pass.setBindGroup(0, bind);
        pass.dispatchWorkgroups(Math.ceil(a.length / 256));
        pass.end();
      }
      device.queue.submit([encoder.finish()]);
      return await readGpu(yBuffer, a.length * 4);
    };

    const value = (label) => new Float32Array(dump[label].values);
    const compare = (label, ours) => {
      const reference = value(label);
      let maxAbs = 0;
      let sumAbs = 0;
      const n = Math.min(ours.length, reference.length);
      for (let i = 0; i < n; i += 1) {
        const diff = Math.abs(ours[i] - reference[i]);
        maxAbs = Math.max(maxAbs, diff);
        sumAbs += diff;
      }
      const scale = reference.reduce((sum, v) => sum + Math.abs(v), 0) / n;
      return {
        label,
        dims: dump[label].dims,
        maxAbs: Math.round(maxAbs * 1000) / 1000,
        meanAbs: Math.round((sumAbs / n) * 1000) / 1000,
        referenceMeanAbs: Math.round(scale * 1000) / 1000,
        lengthMatch: ours.length === reference.length
      };
    };

    const stages = [];
    const embed = value('embed');
    const norm1 = await runNormReal(embed, norm1w, 1, 1536);
    stages.push(compare('norm1', norm1));

    const qkv = await runGemv('qkv0', norm1);
    stages.push(compare('qkv', qkv));

    const splitQ = qkv.slice(0, 2048);
    const splitK = qkv.slice(2048, 2176);
    const splitV = qkv.slice(2176, 2304);
    stages.push(compare('split_q', splitQ), compare('split_k', splitK), compare('split_v', splitV));

    const qnorm = await runNormReal(splitQ, qnormw, 16, 128);
    const knorm = await runNormReal(splitK, knormw, 1, 128);
    stages.push(compare('qnorm', qnorm), compare('knorm', knorm));

    // The scale the graph applies to q (and k): read it off the dump.
    const qref = value('qscaled');
    const qn = value('qnorm');
    const ratios = [];
    for (let i = 0; i < 128; i += 1) if (Math.abs(qn[i]) > 1e-3) ratios.push(qref[i] / qn[i]);
    ratios.sort((a, b) => a - b);
    const qScale = ratios[Math.floor(ratios.length / 2)];

    // One token: softmax over a single key is 1, so attention out is v repeated.
    const attnOut = new Float32Array(2048);
    for (let h = 0; h < 16; h += 1) attnOut.set(splitV, h * 128);
    stages.push(compare('attn_out', attnOut));

    const oProj = await runGemv('o0', attnOut);
    stages.push(compare('o_proj', oProj));

    // This model normalises each sublayer's output BEFORE adding it to the
    // residual stream (post-sublayer norm), which the dataflow shows as
    // post_mixer_norm feeding L0/Add.
    const postMixer = await runNormReal(oProj, postnorm1w, 1, 1536);
    const res1 = await runAdd(embed, postMixer);
    stages.push(compare('res1', res1));

    const norm2 = await runNormReal(res1, norm2w, 1, 1536);
    stages.push(compare('norm2', norm2));

    const gateUp = await runGemv('gateup0', norm2);
    stages.push(compare('gate_up', gateUp));

    const gateFirst = await runSilu(gateUp.slice(0, 6144), gateUp.slice(6144, 12288));
    const upFirst = await runSilu(gateUp.slice(6144, 12288), gateUp.slice(0, 6144));
    const siluFirst = compare('silu_mul', gateFirst);
    const siluSecond = compare('silu_mul', upFirst);
    stages.push({ label: 'silu_mul(order)', gateFirstMaxAbs: siluFirst.maxAbs, gateSecondMaxAbs: siluSecond.maxAbs });
    const silu = siluFirst.maxAbs <= siluSecond.maxAbs ? gateFirst : upFirst;

    const down = await runGemv('down0', silu);
    stages.push(compare('down', down));

    const postMlp = await runNormReal(down, postnorm2w, 1, 1536);
    const layerOut = await runAdd(res1, postMlp);
    stages.push(compare('layer_out', layerOut));

    return { qScaleFromDump: Math.round(qScale * 1e6) / 1e6, stages };
  };

  window.__gemvProbe = async (config) => {
    const ort = globalThis.AT_ORT_WEBGPU;
    const base = new URL('/micro/mm/', location.href);
    const manifest = await (await fetch(new URL('lmhead.json', base))).json();
    const weights = new Uint8Array(await (await fetch(new URL('lmhead.q4.bin', base))).arrayBuffer());
    const scaleBytes = new Uint8Array(await (await fetch(new URL('lmhead.scales.bin', base))).arrayBuffer());
    const ref = new Uint8Array(await (await fetch(new URL('lmhead_ref.onnx', base))).arrayBuffer());
    const repeats = config?.repeats ?? 7;
    const rowCounts = config?.rows ?? [1, 2, 4, 8];

    const x = new Float32Array(manifest.K);
    let seed = 12345;
    for (let i = 0; i < x.length; i += 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      x[i] = ((seed >>> 8) / 0x1000000 - 0.5) * 8;
    }

    // ORT reference for the first sequence.
    const session = await ort.InferenceSession.create(ref, { executionProviders: ['webgpu'], logSeverityLevel: 3 });
    const out = await session.run({ x: new ort.Tensor('float32', x, [1, 1, manifest.K]) });
    const reference = Float32Array.from(await out.y.getData());
    await session.release?.();

    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter.requestDevice();
    const q4Buffer = device.createBuffer({ size: weights.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(q4Buffer, 0, weights);
    const scales = new Float32Array(scaleBytes.buffer.slice(scaleBytes.byteOffset, scaleBytes.byteOffset + scaleBytes.byteLength));
    const scaleBuffer = device.createBuffer({ size: scales.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(scaleBuffer, 0, scales);
    const maxRows = Math.max(...rowCounts);
    const xBuffer = device.createBuffer({ size: maxRows * manifest.K * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const metaBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const yBuffer = device.createBuffer({ size: maxRows * manifest.N * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const readback = device.createBuffer({ size: maxRows * manifest.N * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });

    const pipelines = {};
    for (const kind of ['dynamic', 'unrolled', 'coalesced']) {
      for (const rows of rowCounts) {
        const key = kind + rows;
        if (pipelines[key]) continue;
        const module = device.createShaderModule({
          code: kind === 'coalesced' ? gemvCoalescedWgsl(rows) : gemvRowsWgsl(kind, rows)
        });
        const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
        pipelines[key] = {
          pipeline,
          bind: device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: q4Buffer } },
              { binding: 1, resource: { buffer: scaleBuffer } },
              { binding: 2, resource: { buffer: xBuffer } },
              { binding: 3, resource: { buffer: yBuffer } },
              { binding: 4, resource: { buffer: metaBuffer } }
            ]
          })
        };
      }
    }

    const measure = async (rows, kind) => {
      const xRows = new Float32Array(rows * manifest.K);
      for (let r = 0; r < rows; r += 1) xRows.set(x, r * manifest.K);
      device.queue.writeBuffer(xBuffer, 0, xRows);
      device.queue.writeBuffer(metaBuffer, 0, new Uint32Array([manifest.N, manifest.K, manifest.K / manifest.block, rows]));
      const encode = () => {
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipelines[kind + rows].pipeline);
        pass.setBindGroup(0, pipelines[kind + rows].bind);
        pass.dispatchWorkgroups(4096, Math.ceil(manifest.N / 4096));
        pass.end();
        device.queue.submit([encoder.finish()]);
      };
      encode();
      await device.queue.onSubmittedWorkDone();
      const runs = [];
      for (let rep = 0; rep < repeats; rep += 1) {
        const started = performance.now();
        encode();
        await device.queue.onSubmittedWorkDone();
        runs.push(performance.now() - started);
      }
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(yBuffer, 0, readback, 0, rows * manifest.N * 4);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const all = Float32Array.from(new Float32Array(readback.getMappedRange()));
      readback.unmap();
      let maxAbs = 0;
      let maxRowSpread = 0;
      let dot = 0;
      let refSum = 0;
      let ourSum = 0;
      for (let r = 0; r < rows; r += 1) {
        for (let i = 0; i < manifest.N; i += 1) {
          const value = all[r * manifest.N + i];
          const diff = Math.abs(value - reference[i]);
          maxAbs = Math.max(maxAbs, diff);
          maxRowSpread = Math.max(maxRowSpread, Math.abs(value - all[i]));
          dot += value * reference[i];
          refSum += reference[i] * reference[i];
          ourSum += value * value;
        }
      }
      const sorted = [...runs].sort((a, b) => a - b);
      const ms = sorted[Math.floor(sorted.length / 2)];
      return {
        kind,
        rows,
        ms: Math.round(ms * 100) / 100,
        msPerRow: Math.round((ms / rows) * 100) / 100,
        maxAbsDiff: Math.round(maxAbs * 1000) / 1000,
        rowsIdentical: maxRowSpread < 1e-4,
        cosine: Math.round((dot / Math.sqrt(ourSum * refSum)) * 10000) / 10000,
        weightMB: Math.round(weights.byteLength / 1e6 * 10) / 10
      };
    };

    const results = [];
    for (const kind of ['unrolled', 'coalesced']) {
      for (const rows of rowCounts) results.push(await measure(rows, kind));
    }
    return { results };
  };

  /** One prefill through a raw session, feeding everything the graph declares.
   *  `withProbe` files add a live chain of trivial nodes, so the difference is
   *  what a node costs inside this session - measured, not inferred. */
  async function rawPrefill(url, length) {
    const ort = globalThis.AT_ORT_WEBGPU;
    const buffer = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const session = await ort.InferenceSession.create(buffer, { executionProviders: ['webgpu'], logSeverityLevel: 3 });
    const feed = {};
    for (const entry of session.inputMetadata) {
      const name = entry.name;
      if (name === 'input_ids') {
        feed[name] = new ort.Tensor('int64', BigInt64Array.from(Array.from({ length }, () => 100n)), [1, length]);
      } else if (name === 'attention_mask') {
        feed[name] = new ort.Tensor('int64', BigInt64Array.from(Array.from({ length }, () => 1n)), [1, length]);
      } else if (name === 'probe_in') {
        feed[name] = new ort.Tensor('float32', new Float32Array(8), [1, 1, 8]);
      } else if (name.startsWith('past_key_values')) {
        const dims = (entry.shape ?? []).map((d) => (typeof d === 'number' ? d : d === 'batch_size' ? 1 : 0));
        const size = dims.reduce((a, b) => a * b, 1);
        const type = entry.type;
        const data = type === 'float16' ? new Uint16Array(size) : type === 'float32' ? new Float32Array(size) : new BigInt64Array(size);
        feed[name] = new ort.Tensor(type, data, dims);
      }
    }
    const runs = [];
    for (let rep = 0; rep < 5; rep += 1) {
      const started = performance.now();
      const out = await session.run(feed);
      runs.push(performance.now() - started);
      for (const key of Object.keys(out)) out[key]?.dispose?.();
    }
    await session.release?.();
    return Math.round(median(runs.slice(2)) * 100) / 100;
  }

  /** This GPU's achievable read bandwidth, from a plain buffer copy and from a
   *  stride-walking compute shader. The step's fixed cost is compared to it: if
   *  673 MB cannot explain the step, the cost is not the weights. */
  async function bandwidthProbe(megabytes) {
    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter.requestDevice();
    const bytes = Math.floor(megabytes * 1024 * 1024);
    const words = bytes / 4;

    const a = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    const b = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    // Fill without a 673 MB JS upload: one small write, then a GPU-side copy.
    device.queue.writeBuffer(a, 0, new Uint32Array(1 << 20));
    const time = async (work) => {
      await work();
      const runs = [];
      for (let rep = 0; rep < 3; rep += 1) {
        const started = performance.now();
        await work();
        runs.push(performance.now() - started);
      }
      return median(runs);
    };
    const copyMs = await time(async () => {
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(a, 0, b, 0, bytes);
      device.queue.submit([encoder.finish()]);
      await device.queue.onSubmittedWorkDone();
    });

    const groups = 8192;
    const out = device.createBuffer({ size: groups * 256 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const module = device.createShaderModule({
      code:
        '@group(0) @binding(0) var<storage, read> data: array<u32>;\n' +
        '@group(0) @binding(1) var<storage, read_write> out: array<u32>;\n' +
        '@compute @workgroup_size(256)\n' +
        'fn main(@builtin(global_invocation_id) id: vec3<u32>) {\n' +
        '  var sum = 0u;\n' +
        '  let total = arrayLength(&data);\n' +
        '  var i = id.x;\n' +
        '  let stride = ' + String(groups * 256) + 'u;\n' +
        '  loop {\n' +
        '    if (i >= total) { break; }\n' +
        '    sum = sum ^ data[i];\n' +
        '    i = i + stride;\n' +
        '  }\n' +
        '  out[id.x] = sum;\n' +
        '}'
    });
    const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    const bind = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: a } },
        { binding: 1, resource: { buffer: out } }
      ]
    });
    const readMs = await time(async () => {
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(groups);
      pass.end();
      device.queue.submit([encoder.finish()]);
      await device.queue.onSubmittedWorkDone();
    });
    return {
      megabytes,
      copyMs: Math.round(copyMs * 100) / 100,
      copyGbs: Math.round(((megabytes / 1024) * 2 / (copyMs / 1000)) * 100) / 100,
      readMs: Math.round(readMs * 100) / 100,
      readGbs: Math.round(((megabytes / 1024) / (readMs / 1000)) * 100) / 100,
      words
    };
  }

  async function measure(config) {
    const info = await setup(config);
    const target = config.target ?? 'ko';
    const text = config.text ?? 'Batteries keep the grid stable at night.';
    const prompt = await tokenIds(renderPrompt(target, text));

    // (A) the doc's own basis: one forward of a 23-token prompt, batch 1..8.
    const prefill = [];
    for (const size of config.sizes) {
      const rows = new Array(size).fill(0).map(() => sameRow(prompt, 23));
      await forward(rows, null); // warm shapes
      const runs = [];
      for (let run = 0; run < 3; run += 1) {
        const started = performance.now();
        const out = await forward(rows, null);
        runs.push(performance.now() - started);
        out.logits?.dispose?.();
        for (const key of Object.keys(out)) out[key]?.dispose?.();
      }
      const ms = median(runs);
      prefill.push({ size, ms: Math.round(ms), msPerRow: Math.round(ms / size) });
    }

    // (B) the decode step: prefill a real prompt, then 16 batched steps.
    const decodeSteps = [];
    const kv = {};
    for (const size of config.sizes) {
      const rows = new Array(size).fill(0).map(() => [...prompt]);
      const result = await decode(rows, 16);
      const steps = result.stepMs.slice(4);
      const ms = median(steps);
      decodeSteps.push({
        size,
        msPerStep: Math.round(ms * 100) / 100,
        msPerRow: Math.round((ms / size) * 100) / 100
      });
      if (size === 1) kv.one = { bytes: null };
    }

    // (C) parity: the same prompt through the library's own generate.
    const parity = {};
    try {
      // The library's own generation over the same session: same prompt, same
      // greedy rule, so the token streams must agree exactly.
      const library = await model.generate({
        input_ids: tensorOf('input_ids', prompt, [1, prompt.length]),
        max_new_tokens: 24,
        do_sample: false
      });
      const libraryIds = Array.from(library.tolist()[0]).map(Number).slice(prompt.length);
      const oursIds = await decode([[...prompt]], 24);
      const sameIds = libraryIds.length === oursIds.generated[0].length && libraryIds.every((id, at) => id === oursIds.generated[0][at]);
      Object.assign(parity, {
        match: sameIds,
        libraryTokens: libraryIds.length,
        ourTokens: oursIds.generated[0].length,
        library: tokenizer.decode(libraryIds, { skip_special_tokens: true }).slice(0, 120),
        ours: tokenizer.decode(oursIds.generated[0], { skip_special_tokens: true }).slice(0, 120)
      });
    } catch (error) {
      Object.assign(parity, { failure: String(error?.message ?? error), stack: String(error?.stack ?? '').slice(0, 400) });
    }

    // (C0) does disposing the replaced KV tensors each step cost what it looks
    // like? Same loop, twice, with the only difference being the dispose call.
    const disposeTiming = {};
    try {
      const ids = await tokenIds(renderPrompt(target, text));
      for (const mode of [true, false, true, false]) {
        disposeCache = mode;
        const startedAt = performance.now();
        await decode([[...ids]], 24);
        const ms = Math.round(performance.now() - startedAt);
        (disposeTiming[mode ? 'dispose' : 'keep'] ??= []).push(ms);
      }
      disposeCache = true;
      disposeTiming.disposeMedian = Math.round(median(disposeTiming.dispose));
      disposeTiming.keepMedian = Math.round(median(disposeTiming.keep));
    } catch (error) {
      disposeTiming.failure = String(error?.message ?? error);
    }

    // (C1) the same 24 tokens, twice: the library's generate against our loop,
    // in one page on one session. This is the only fair comparison of the
    // decode loop itself.
    const loopTiming = {};
    try {
      const ids = await tokenIds(renderPrompt(target, text));
      const inputIds = model ? null : null;
      void inputIds;
      const libraryStarted = performance.now();
      await model.generate({
        input_ids: tensorOf('input_ids', ids, [1, ids.length]),
        max_new_tokens: 24,
        do_sample: false
      });
      loopTiming.libraryMs = Math.round(performance.now() - libraryStarted);
      const oursStarted = performance.now();
      await decode([[...ids]], 24);
      loopTiming.oursMs = Math.round(performance.now() - oursStarted);
      loopTiming.promptTokens = ids.length;
    } catch (error) {
      loopTiming.failure = String(error?.message ?? error);
    }

    // (C1b) where a decode step's time goes, stage by stage.
    const stages = {};
    try {
      const ids = await tokenIds(renderPrompt(target, text));
      let cache = null;
      let mask = [];
      let fed = 0;
      let out = null;
      while (fed < 128) {
        const take = Math.min(128, 128 - fed);
        const previous = out;
        out = await forward([new Array(take).fill(ids[0])], cache, [new Array(fed + take).fill(1)]);
        previous?.logits?.dispose?.();
        cache = adopt(out, cache);
        mask = [new Array(fed + take).fill(1)];
        fed += take;
      }
      const timings = { feeds: [], run: [], argmax: [], adopt: [] };
      for (let step = 0; step < 8; step += 1) {
        const feedStarted = performance.now();
        const rows = [[ids[0]]];
        const idsTensor = tensorOf('input_ids', flat(rows), [1, 1]);
        const nextMask = [mask[0].concat([1])];
        const maskTensor = tensorOf('attention_mask', flat(nextMask), [1, nextMask[0].length]);
        const feedsMs = performance.now() - feedStarted;
        const runStarted = performance.now();
        const previous = out;
        out = await model.forward({ input_ids: idsTensor, attention_mask: maskTensor, past_key_values: cache });
        const runMs = performance.now() - runStarted;
        const argmaxStarted = performance.now();
        const picks = argmaxRows(out.logits, 1);
        const argmaxMs = performance.now() - argmaxStarted;
        const adoptStarted = performance.now();
        previous.logits?.dispose?.();
        cache = adopt(out, cache);
        out.logits?.dispose?.();
        const adoptMs = performance.now() - adoptStarted;
        mask = nextMask;
        timings.feeds.push(feedsMs);
        timings.run.push(runMs);
        timings.argmax.push(argmaxMs);
        timings.adopt.push(adoptMs);
        void picks;
      }
      for (const key of Object.keys(cache)) cache[key]?.dispose?.();
      for (const key of Object.keys(timings)) {
        const values = timings[key].slice(2);
        stages[key] = Math.round(median(values) * 1000) / 1000;
      }
    } catch (error) {
      stages.failure = String(error?.message ?? error);
    }

    // (C1c) per-node cost on a synthetic graph, and this GPU's read bandwidth.
    let micro = null;
    let bandwidth = null;
    if (config.micro) {
      try {
        micro = [
          await microRunner(config.micro.base + 'chain100.onnx', 100, 12),
          await microRunner(config.micro.base + 'chain1000.onnx', 1000, 12)
        ];
        micro.push({
          usPerNode: Math.round(((micro[1].ms - micro[0].ms) / 900) * 1000 * 100) / 100
        });
      } catch (error) {
        micro = { failure: String(error?.message ?? error) };
      }
    }
    if (config.bandwidthMb) {
      try {
        bandwidth = await bandwidthProbe(config.bandwidthMb);
      } catch (error) {
        bandwidth = { failure: String(error?.message ?? error) };
      }
    }

    // (C1i) everything on the GPU: KV resident between steps, only the token
    // read back. Compare with the same loop through the library's path.
    let gpuResidentResult = null;
    if (config.gpuResident) {
      try {
        gpuResidentResult = { plain: await gpuResident(100, 64, 12, false) };
        try {
          gpuResidentResult.captured = await gpuResident(100, 64, 12, true);
        } catch (error) {
          gpuResidentResult.captureError = String(error?.message ?? error).slice(0, 240);
        }
      } catch (error) {
        gpuResidentResult = { failure: String(error?.message ?? error).slice(0, 300) };
      }
    }

    // (C1h) a sustained decode loop, so the harness can watch what the browser
    // processes burn while it runs: dispatch (CPU) or execution (GPU).
    let sustained = null;
    if (config.sustainedSteps) {
      try {
        const ids = await tokenIds(renderPrompt(target, text));
        let cache = null;
        let mask = [[...new Array(64).fill(1)]];
        let out = await forward([new Array(64).fill(ids[0])], null, mask);
        cache = adopt(out, null);
        let picked = argmaxRows(out.logits, 1)[0];
        const started = performance.now();
        for (let step = 0; step < config.sustainedSteps; step += 1) {
          mask = [mask[0].concat([1])];
          const previous = out;
          out = await forward([[picked]], cache, mask);
          picked = argmaxRows(out.logits, 1)[0];
          previous.logits?.dispose?.();
          cache = adopt(out, cache);
          out.logits?.dispose?.();
        }
        const ms = performance.now() - started;
        for (const key of Object.keys(cache)) cache[key]?.dispose?.();
        sustained = {
          steps: config.sustainedSteps,
          totalMs: Math.round(ms),
          msPerStep: Math.round((ms / config.sustainedSteps) * 100) / 100
        };
      } catch (error) {
        sustained = { failure: String(error?.message ?? error).slice(0, 200) };
      }
    }

    // (C1g) CPU (submit) against GPU (execute), on the real graph and on the
    // same graph carrying 2000 extra live nodes.
    let cpuGpuSplit = null;
    if (config.nodeSlope) {
      try {
        const base = new URL(config.modelBase, location.href).href + 'model_q4f16.onnx';
        const extra = new URL(config.nodeSlope, new URL(config.modelBase, location.href)).href;
        cpuGpuSplit = {
          base: await syncSplit(base, 64, 6),
          extra: await syncSplit(extra, 64, 6)
        };
      } catch (error) {
        cpuGpuSplit = { failure: String(error?.message ?? error).slice(0, 300) };
      }
    }

    // (C1f) the real graph against the same graph with 2000 live extra nodes.
    let nodeSlope = null;
    if (config.nodeSlope) {
      try {
        const base = await rawPrefill(new URL(config.modelBase, location.href).href + 'model_q4f16.onnx', 64);
        const extra = await rawPrefill(new URL(config.nodeSlope, new URL(config.modelBase, location.href)).href, 64);
        nodeSlope = {
          basePrefillMs: base,
          extraPrefillMs: extra,
          usPerNode: Math.round(((extra - base) / 2000) * 1000 * 100) / 100
        };
      } catch (error) {
        nodeSlope = { failure: String(error?.message ?? error).slice(0, 300) };
      }
    }

    // (C1e) what one matmul that reads 660 MB of weights costs here: the
    // weight-read floor for the whole graph.
    let weightRead = null;
    if (config.weightRead) {
      try {
        const ort = globalThis.AT_ORT_WEBGPU;
        const buffer = new Uint8Array(await (await fetch(new URL(config.weightRead, new URL(config.modelBase, location.href)))).arrayBuffer());
        const session = await ort.InferenceSession.create(buffer, { executionProviders: ['webgpu'], logSeverityLevel: 3 });
        const feed = { x: new ort.Tensor('float32', new Float32Array(1536), [1, 1, 1536]) };
        await session.run(feed);
        const runs = [];
        for (let rep = 0; rep < 4; rep += 1) {
          const started = performance.now();
          await session.run(feed);
          runs.push(performance.now() - started);
        }
        const ms = median(runs.slice(1));
        await session.release?.();
        weightRead = {
          megabytes: 660.6,
          ms: Math.round(ms * 100) / 100,
          gbs: Math.round((660.6 / 1024 / (ms / 1000)) * 100) / 100
        };
      } catch (error) {
        weightRead = { failure: String(error?.message ?? error).slice(0, 200) };
      }
    }

    // (C1d) session options: can the runtime fold the shape bookkeeping away?
    let variants = null;
    if (config.variants) {
      variants = {};
      for (const [label, options] of Object.entries(config.variants)) {
        try {
          variants[label] = { msPerStep: await variantStep(options, 6) };
        } catch (error) {
          variants[label] = { failure: String(error?.message ?? error).slice(0, 200) };
        }
      }
    }

    // (C2) heterogeneous lengths in one batch: the scheduler's real shape.
    const hetero = {};
    try {
      const short = await tokenIds(renderPrompt(target, 'コメントありがとうございます。'));
      const long = await tokenIds(renderPrompt(target, '昨日の会議では、来月の予算案について長い議論が続きました。'));
      const together = await paddedDecode([[...short], [...long]], 8);
      const aloneShort = await decode([[...short]], 8);
      const aloneLong = await decode([[...long]], 8);
      hetero.widths = [short.length, long.length];
      hetero.match = [0, 1].every((row) => together[row].length === 8 && together[row].every((id, at) => id === (row === 0 ? aloneShort : aloneLong).generated[0][at]));
      hetero.together = together.map((row) => row.join(','));
      hetero.alone = [aloneShort.generated[0].join(','), aloneLong.generated[0].join(',')];
    } catch (error) {
      hetero.failure = String(error?.message ?? error);
      hetero.stack = String(error?.stack ?? '').slice(0, 400);
    }

    // (C3) step cost against context length: the workload runs at hundreds of
    // tokens of KV, not at the 30 the first table used.
    const contexts = [];
    for (const length of config.contexts) {
      for (const rows of config.sizes) {
        const row = await contextSteps(100, length, rows, 8);
        contexts.push({ tokens: length, ...row });
      }
    }

    // (C3b) can a rejected draft be rolled back by masking it out?
    let rollbackResult = null;
    if (config.rollback) {
      try {
        rollbackResult = await rollback(100, 128);
      } catch (error) {
        rollbackResult = { failure: String(error?.message ?? error) };
      }
    }

    // (C4) tokens per step: does one forward carrying four tokens cost four
    // steps, or closer to one?
    const widths = [];
    for (const width of config.widths ?? []) {
      widths.push(await widthSteps(100, 128, width, width === 1 ? 8 : 5));
    }

    // (D) KV cost at 512 tokens: one prefill, then read the cache tensors.
    let cache = null;
    let out = await forward([sameRow(prompt, 23)], null);
    cache = adopt(out, null);
    const totalTokens = prompt.length;
    const measured = kvBytes(cache, totalTokens);
    kv.perToken = Math.round(measured.bytes / totalTokens);
    kv.dims = measured.dims;
    kv.tokens = totalTokens;
    kv.bytesPerSequence = measured.bytes;
    for (const key of Object.keys(cache)) cache[key]?.dispose?.();
    out.logits?.dispose?.();

    // (E) prefix alignment: is the rendered header a token prefix of every
    // prompt, or does a BPE merge cross the text boundary?
    const samples = config.prefixTexts ?? [];
    let common = null;
    let headerLengths = [];
    for (const sample of samples) {
      const safe = P.sanitize(sample);
      const full = renderPrompt(target, sample);
      const at = full.indexOf(safe);
      const header = at > 0 ? full.slice(0, at) : '';
      const ids = await tokenIds(full);
      const headerIds = await tokenIds(header);
      headerLengths.push(headerIds.length);
      if (!common) common = ids;
      else {
        let index = 0;
        while (index < common.length && index < ids.length && common[index] === ids[index]) index += 1;
        common = common.slice(0, index);
      }
    }
    const prefix = {
      samples: samples.length,
      commonPrefixTokens: common ? common.length : 0,
      headerTokens: headerLengths.length ? median(headerLengths) : 0,
      aligned: common !== null && headerLengths.every((length) => length === common.length)
    };

    return {
      info,
      promptTokens: prompt.length,
      prefill,
      decode: decodeSteps,
      kv,
      prefix,
      parity,
      loopTiming,
      disposeTiming,
      hetero,
      contexts,
      widths,
      rollback: rollbackResult,
      stages,
      micro,
      weightRead,
      nodeSlope,
      cpuGpuSplit,
      gpuResident: gpuResidentResult,
      sustained,
      variants
    };
  }

  /** A pure decode loop over the already-open session, so the caller can watch
   *  CPU time around exactly this window. */
  window.__sustain = async (steps) => {
    try {
      const target = 'ko';
      const ids = await tokenIds(renderPrompt(target, 'Batteries keep the grid stable at night.'));
      let cache = null;
      let mask = [[...new Array(64).fill(1)]];
      let out = await forward([new Array(64).fill(ids[0])], null, mask);
      cache = adopt(out, null);
      let picked = argmaxRows(out.logits, 1)[0];
      const started = performance.now();
      for (let step = 0; step < steps; step += 1) {
        mask = [mask[0].concat([1])];
        const previous = out;
        out = await forward([[picked]], cache, mask);
        picked = argmaxRows(out.logits, 1)[0];
        previous.logits?.dispose?.();
        cache = adopt(out, cache);
        out.logits?.dispose?.();
      }
      const ms = performance.now() - started;
      for (const key of Object.keys(cache)) cache[key]?.dispose?.();
      return { steps, totalMs: Math.round(ms), msPerStep: Math.round((ms / steps) * 100) / 100 };
    } catch (error) {
      return { failure: String(error?.message ?? error).slice(0, 200) };
    }
  };

  window.__libraryProbe = async (steps, proxyOff) => {
    const ort = globalThis.AT_ORT_WEBGPU;
    // The proxy flag is read when the wasm runtime initialises, so this must be
    // set before the first session and each variant needs a fresh page.
    if (proxyOff) ort.env.wasm.proxy = false;
    await setup({ modelBase: '/spike-model/' });
    return { proxyOff: Boolean(proxyOff), msPerStep: await variantStep(null, steps) };
  };

  window.__gpuResidentProbe = async (steps) => {
    const out = {};
    const count = steps ?? 12;
    await setup({ modelBase: '/spike-model/' });
    try {
      out.libraryPath = await variantStep(null, count);
    } catch (error) {
      out.libraryPathError = String(error?.message ?? error).slice(0, 300);
    }
    try {
      out.plain = await gpuResident(100, 64, count, false);
    } catch (error) {
      out.failure = String(error?.message ?? error).slice(0, 400);
      out.stack = String(error?.stack ?? '').slice(0, 400);
      return out;
    }
    try {
      out.captured = await gpuResident(100, 64, count, true);
    } catch (error) {
      out.captureError = String(error?.message ?? error).slice(0, 400);
    }
    return out;
  };

  window.__openModel = (config) =>
    setup(config).then(
      () => ({ ok: true }),
      (error) => ({ failure: String(error?.message ?? error) })
    );

  window.__spike = (config) =>
    measure(config).catch((error) => ({ failure: String(error?.message ?? error), stack: String(error?.stack ?? '').slice(0, 900) }));
})();

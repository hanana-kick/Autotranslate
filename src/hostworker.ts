// The decode engine actor: one WebGPU session, several sequences sharing one
// forward pass per step.
//
// A decode step costs 51 ms for one row and 67 ms for eight on the shipped
// graph (test-results/browser/engine-spike.json), while two independent sessions
// cost 1.68x and buy nothing. So the win is not more sessions - it is one
// session whose step carries several rows, which is what `AT.engine` schedules
// and what this file feeds: tensors in, tokens out.
//
// The host owns the tokenizer, the prompt and the answer, and sends token ids;
// nothing here reads or writes text. `AT.sendMessage` is never called.
//
// Loaded by `new Worker(AT.getURL('hostworker.js'))`; the shared scripts come
// in through importScripts below, because a worker's own file cannot name itself
// there and importScripts is synchronous, so the body after it runs once
// everything is in place.
interface HostWorkerScope {
  importScripts: (...files: string[]) => void;
  postMessage: (message: unknown) => void;
  onmessage: ((event: MessageEvent) => void) | null;
}

const hostWorkerScope = self as unknown as HostWorkerScope;

// Relative paths resolve against this worker's own URL, which is the extension
// root: nothing here needs the browser API to build an absolute one. The
// polyfill and lib/browser.js are deliberately absent - `chrome.runtime` is not
// exposed to a dedicated worker, and the polyfill throws rather than give a
// half-answer - so the session is opened with the runtime and the model store
// alone.
hostWorkerScope.importScripts(
  'lib/constants.js',
  'vendor/onnxruntime/ort-common.all.js',
  'vendor/onnxruntime/ort-webgpu.all.js',
  'vendor/onnxruntime/transformers.web.js',
  'lib/local.js',
  'lib/modelstore.js',
  'lib/pipelinehost.js',
  'lib/engine.js',
  'lib/onnxweights.js',
  'lib/kernelmatmul.js',
  'lib/kernelattention.js',
  'lib/kernels.js'
);

namespace AT.hostworker {
  const L = AT.local;

  /** The session this worker drives, and the KV cache of the cohort in flight. */
  type Session = {
    tf: AT.pipelinehost.TfModule;
    model: AT.pipelinehost.CausalModel;
    session: AT.pipelinehost.SessionInfo;
    types: Map<string, string>;
    eos: number[];
    pad: number;
    batch: number;
  };

  let open: Session | null = null;
  let runner: AT.engine.Runner | null = null;
  /** The kernel decode loop, when it is the backend in use. It batches: each
   *  step carries up to `C.ENGINE_BATCH` sequences, one row each. */
  let kernels: AT.kernels.Runner | null = null;
  /** `past_key_values.N.{key,value}` of the cohort being decoded. */
  let cache: Record<string, AT.pipelinehost.Tensor> | null = null;

  // Only requests with a subscriber pay for progress bookkeeping. Token arrays
  // are cloned by postMessage at most every 40 ms, using existing CPU picks.
  const streaming = new Map<number, { at: number; count: number }>();

  function progress(id: number, tokens: number[], flush = false): void {
    const pending = streaming.get(id);
    if (!pending || pending.count === tokens.length) return;
    const now = performance.now();
    if (!flush && now - pending.at < 40) return;
    pending.at = now;
    pending.count = tokens.length;
    post({ type: L.WORKER_MESSAGE.PROGRESS, id, tokens });
  }

  function finishProgress(outcome: AT.engine.Outcome): void {
    if (outcome.ok) progress(outcome.id, outcome.tokens, true);
    streaming.delete(outcome.id);
  }

  function messageOf(error: unknown): string {
    return String((error as { message?: unknown })?.message ?? error ?? 'the decode engine failed');
  }

  function post(message: AT.local.WorkerReply): void {
    hostWorkerScope.postMessage(message);
  }

  /** The sentinels the graph stops on: the card's `generation_config` names an
   *  end-of-turn id that `config.json` alone does not carry. */
  async function sentinels(): Promise<{ eos: number[]; pad: number }> {
    const generation = (await AT.pipelinehost.modelJson('generation_config.json')) ?? {};
    const config = (await AT.pipelinehost.modelJson('config.json')) ?? {};
    const ids = (value: unknown): number[] =>
      (Array.isArray(value) ? value : [value]).filter((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry));
    const eos = [...new Set([...ids(generation.eos_token_id), ...ids(config.eos_token_id)])];
    const pad = ids(generation.pad_token_id)[0] ?? ids(config.pad_token_id)[0] ?? eos[0] ?? 0;
    return { eos, pad };
  }

  /** One tensor in the dtype the graph declares for that input. */
  function tensor(session: Session, name: string, rows: number[][]): AT.pipelinehost.Tensor {
    const width = rows[0]?.length ?? 0;
    const flat: number[] = [];
    for (const row of rows) for (const value of row) flat.push(value);
    const type = session.types.get(name) ?? 'int64';
    const data =
      type === 'float32'
        ? Float32Array.from(flat)
        : type === 'int32'
          ? Int32Array.from(flat)
          : BigInt64Array.from(flat.map((value) => BigInt(value)));
    return new session.tf.Tensor(type, data, [rows.length, width]);
  }

  /** This step's `present.*` tensors become the next step's cache. The library
   *  does the same rename internally but does not export it. */
  function adopt(out: AT.pipelinehost.ModelOutput, previous: Record<string, AT.pipelinehost.Tensor> | null): Record<string, AT.pipelinehost.Tensor> {
    const next = previous ?? {};
    for (const key of Object.keys(out)) {
      if (!key.startsWith('present')) continue;
      const name = 'past_key_values' + key.slice('present'.length);
      const older = next[name];
      const tensorOut = out[key];
      if (!tensorOut) continue;
      if (older && older !== tensorOut) older.dispose?.();
      next[name] = tensorOut;
    }
    return next;
  }

  function clearCache(): void {
    if (!cache) return;
    for (const key of Object.keys(cache)) cache[key]?.dispose?.();
    cache = null;
  }

  /** The engine's forward: one batched call, logits out, cache handed forward. */
  async function forward(
    rows: { inputIds: number[][]; mask?: number[][] },
    first: boolean
  ): Promise<{ logits: AT.engine.Logits }> {
    if (!open) throw new Error('this decode engine has no session');
    if (first) clearCache();
    const feeds: Record<string, unknown> = { input_ids: tensor(open, 'input_ids', rows.inputIds) };
    if (open.session.inputNames.includes('attention_mask')) {
      const mask = rows.mask ?? rows.inputIds.map((row) => row.map(() => 1));
      feeds.attention_mask = tensor(open, 'attention_mask', mask);
    }
    if (cache && !first) feeds.past_key_values = cache;
    const out = await open.model.forward(feeds);
    cache = adopt(out, cache);
    const logits = out.logits;
    if (!logits) throw new Error('the session returned no logits');
    return { logits: { dims: [...logits.dims], data: logits.data } };
  }

  /** Builds the shapes a page asks for before the page asks. */
  async function warm(session: Session): Promise<void> {
    const row = [session.pad, session.pad, session.pad, 1];
    await forward({ inputIds: [row] }, true);
    await forward({ inputIds: [[2]] }, false);
    clearCache();
  }

  /** The kernel backend: parse the graph's weights out of the stored file and
   *  build the pipeline. Throwing here is not fatal - `boot` falls back to the
   *  ONNX Runtime path in the same worker. */
  async function bootKernels(modelId: string): Promise<void> {
    const blob = await AT.modelstore.read(modelId);
    if (!blob) throw new Error(`model ${modelId} is not stored`);
    const weights = AT.onnxweights.parse(await blob.arrayBuffer());
    const gpu = (navigator as unknown as { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
    const adapter = (await gpu?.requestAdapter()) as AT.kernels.GpuAdapter | null;
    if (!adapter) throw new Error('this worker has no WebGPU adapter');
    const { device, matrixSubgroupSize } = await AT.kernels.openDevice(adapter);
    kernels = await AT.kernels.create({
      device,
      matrixSubgroupSize,
      model: weights,
      maxTokens: 2048,
      rows: AT.kernels.POSITIONS,
      ablate: AT.C.PROFILE_ABLATION,
      // A page's packs arrive in the same tick and must share the first step.
      coalesceMs: AT.C.ENGINE_COALESCE_MS,
      onDone: (outcome) => {
        finishProgress(outcome);
        if (outcome.ok) {
          const measured = kernels?.stats();
          post({
            type: L.WORKER_MESSAGE.RESULT,
            id: outcome.id,
            ok: true,
            tokens: outcome.tokens,
            ...(measured ? { stats: measured } : {})
          });
        } else {
          post({
            type: L.WORKER_MESSAGE.RESULT,
            id: outcome.id,
            ok: false,
            error: outcome.error.slice(0, 300),
            code: 'worker-generate'
          });
        }
      }
    });
  }

  async function boot(modelId: string, dtype: string): Promise<void> {
    if (AT.C.ENGINE_KERNELS) {
      try {
        await bootKernels(modelId);
        post({ type: L.WORKER_MESSAGE.READY, ok: true, backend: 'kernels', rows: kernels?.rows() ?? 1 });
        return;
      } catch (error: unknown) {
        // The runtime path below is the reference implementation: keep the
        // engine usable when a device or a graph disagrees with the kernels.
        AT.warn('on-device decode kernels unavailable, falling back to ONNX Runtime:', messageOf(error));
        kernels = null;
      }
    }
    try {
      const opened = await AT.pipelinehost.openModel(modelId, dtype);
      const names = Object.keys(opened.model.sessions);
      const info = opened.model.sessions[names.includes('model') ? 'model' : names[0] ?? ''] ?? null;
      if (!info) throw new Error('the session exposes no graph to run');
      const ends = await sentinels();
      open = {
        tf: opened.tf,
        model: opened.model,
        session: info,
        types: new Map(info.inputMetadata.map((entry) => [entry.name, entry.type])),
        eos: ends.eos,
        pad: ends.pad,
        batch: Math.max(1, Math.floor(AT.C.ENGINE_BATCH))
      };
      runner = AT.engine.create({
        forward,
        eos: open.eos,
        batch: open.batch,
        pad: open.pad,
        promptBudget: AT.C.ENGINE_PROMPT_TOKENS,
        // A beat of quiet: a page's packs arrive in the same tick and must share
        // the first step, not take one prefill each.
        coalesceMs: AT.C.ENGINE_COALESCE_MS,
        onDone: (outcome) => {
          finishProgress(outcome);
          if (outcome.ok) post({ type: L.WORKER_MESSAGE.RESULT, id: outcome.id, ok: true, tokens: outcome.tokens });
          else {
            post({
              type: L.WORKER_MESSAGE.RESULT,
              id: outcome.id,
              ok: false,
              error: outcome.error.slice(0, 300),
              code: 'worker-generate'
            });
          }
        }
      });
      // Compile the shapes before a page needs them: WebGPU builds its shaders
      // on the first run of a shape, and that cost used to land on the first
      // real sentence. One short row, one step, then the cache goes away.
      await warm(open);
      post({ type: L.WORKER_MESSAGE.READY, ok: true, backend: 'runtime' });
    } catch (error: unknown) {
      open = null;
      runner = null;
      post({ type: L.WORKER_MESSAGE.READY, ok: false, error: messageOf(error).slice(0, 300), code: 'worker-init' });
    }
  }

  hostWorkerScope.onmessage = (event: MessageEvent) => {
    const message = event.data as { type?: unknown; id?: unknown } | null;
    if (message?.type === L.WORKER_MESSAGE.INIT) {
      const init = message as AT.local.WorkerInit;
      void boot(init.modelId, init.dtype);
      return;
    }
    if (message?.type === L.WORKER_MESSAGE.GENERATE) {
      const job = message as AT.local.WorkerGenerate;
      if (job.stream) streaming.set(job.id, { at: -Infinity, count: 0 });
      const onProgress = job.stream ? (tokens: number[]) => progress(job.id, tokens) : undefined;
      if (kernels) {
        kernels.add({ id: job.id, prompt: job.inputIds, maxNewTokens: job.maxNewTokens, onProgress });
        return;
      }
      if (!runner) {
        streaming.delete(job.id);
        post({ type: L.WORKER_MESSAGE.RESULT, id: job.id, ok: false, error: 'this decode engine has no session', code: 'worker-init' });
        return;
      }
      runner.add({ id: job.id, prompt: job.inputIds, maxNewTokens: job.maxNewTokens, onProgress });
      return;
    }
    if (message?.type === L.WORKER_MESSAGE.DROP && typeof message.id === 'number') {
      streaming.delete(message.id);
      if (kernels) kernels.drop(message.id);
      else runner?.drop(message.id);
    }
  };
}

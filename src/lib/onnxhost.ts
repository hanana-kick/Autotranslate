// The on-device host: load, unload, status, translate and handle, over
// Transformers.js on onnxruntime-web WebGPU, with the ONNX export of PLaMo 3
// Translate stored in OPFS. The host renders the model's tokenizer template,
// plans exact token budgets and validates completion and structural safety.
//
// The vendored runtime arrives as classic scripts that publish three globals
// (`AT_ORT_COMMON`, `AT_ORT_WEBGPU`, `AT_TRANSFORMERS`); the model's own files
// (config, tokenizer, the graph) are served to Transformers.js through a
// custom cache backed by OPFS, so nothing but the extension's own origin is
// ever fetched.
//
// Load after lib/constants.js, lib/browser.js, lib/plamo3.js, lib/glossary.js,
// lib/local.js, lib/modelstore.js and lib/pipelinehost.js, and after
// vendor/ort-common.all.js, vendor/ort-webgpu.all.js and
// vendor/transformers.web.js.
namespace AT.onnxhost {
  const C = AT.C;
  const L = AT.local;
  const P = AT.plamo3;

  /** The loader is shared with every decode worker, so a session is described
   *  in one place (`lib/pipelinehost.js`); these are its types. */
  type Tokenizer = AT.pipelinehost.Tokenizer;
  type Pipeline = AT.pipelinehost.Pipeline;

  /** The seam a test replaces: how the vendored runtime and the model's files
   *  are reached, plus the tokenizer when no session is opened at all.
   *  Production leaves all three undefined. */
  type Seams = AT.pipelinehost.Seams & { tokenizer?: Tokenizer };

  let seams: Seams = {};
  let tokenizer: Tokenizer | null = null;
  let pipe: Pipeline | null = null;
  let inlineWarmed = false;
  let loadedId: string | null = null;
  let loadedBytes = 0;
  let loadMs: number | null = null;
  let generations = 0;
  let queue: Promise<unknown> = Promise.resolve();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let loading: Promise<void> | null = null;
  let unloading: Promise<void> | null = null;
  let inlineStarting: Promise<Pipeline> | null = null;
  let inlineQueue: Promise<unknown> = Promise.resolve();
  let inlineInFlight = 0;
  let lifecycle = 0;
  let reporter: ((status: AT.local.LocalStatus) => void) | null = null;
  /** The language the resident session was loaded for; the pool boots from it. */
  let lastTarget = 'ko';
  /** The dtype the resident graph was opened with; every worker opens the same. */
  let loadedDtype = 'fp16';
  let modelContextTokens = 0;
  let eosTokens: number[] = [];

  const state: AT.local.LocalStatus = {
    target: L.TARGET_OFFSCREEN,
    supported: false,
    reason: null,
    state: 'unloaded',
    modelId: null,
    modelName: null,
    loadedBytes: 0,
    loadMs: null,
    generations: 0,
    lastError: null
  };

  // Exact, document-memory-only tokenizer work; never generated translations.
  // Each FIFO has at most 256 entries of at most 8192 text/ID units. Large
  // inputs still tokenize in full but are not retained.
  const expandedTexts = new Map<string, string>();
  const countedTexts = new Map<string, number>();
  const encodedPrompts = new Map<string, number[]>();

  function remember<T>(memo: Map<string, T>, key: string, value: T, size = 0): T {
    if (key.length + size > 8192) return value;
    if (memo.size >= 256) memo.delete(memo.keys().next().value!);
    memo.set(key, value);
    return value;
  }

  function setTokenizer(next: Tokenizer | null): void {
    expandedTexts.clear();
    countedTexts.clear();
    encodedPrompts.clear();
    tokenizer = next;
  }

  function promptIds(prompt: string): number[] {
    const cached = encodedPrompts.get(prompt);
    if (cached) return cached;
    // The chat template already emits BOS and PFML controls. Adding the
    // tokenizer's defaults here would duplicate them.
    const ids = Array.from(tokenizer!(prompt, { add_special_tokens: false }).input_ids.data, Number);
    return remember(encodedPrompts, prompt, ids, ids.length);
  }

  export function configure(patch: Seams): void {
    seams = { ...seams, ...patch };
    AT.pipelinehost.installSeams(seams);
    if (patch.tokenizer) setTokenizer(patch.tokenizer);
  }

  export function install(place: 'offscreen' | 'background', report: (status: AT.local.LocalStatus) => void): AT.local.LocalStatus {
    state.target = place;
    reporter = report;
    // A browser without WebGPU records its reason inside; nobody is waiting on
    // the answer here, so the rejection must not escape as an unhandled one.
    void checkSupport().catch(() => undefined);
    publish();
    return state;
  }

  function publish(): void {
    state.generations = generations;
    state.loadedBytes = loadedBytes;
    state.loadMs = loadMs;
    state.modelId = loadedId;
    reporter?.(state);
  }

  function fail(reason: string, detail: unknown): never {
    state.state = 'error';
    state.reason = reason;
    state.lastError = String((detail as { message?: unknown })?.message ?? detail ?? reason).slice(0, 300);
    publish();
    const error = new Error(state.lastError) as Error & { reason: string; code: string };
    error.reason = reason;
    error.code = L.codeForReason(reason);
    throw error;
  }

  async function checkSupport(): Promise<void> {
    if (state.supported) return;
    if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
      state.supported = false;
      fail('no-webgpu', 'this browser has no WebGPU');
    }
    // Every ONNX card here runs f16 activations, and a device without the
    // shader-f16 feature fails inside ORT's first kernel ("Gather requires f16
    // but the device does not support it") after the whole model loaded. Ask
    // the adapter first, so the answer arrives in a second, not in a crash.
    const surface = (globalThis.navigator as { gpu?: { requestAdapter?: () => Promise<unknown> } } | undefined)?.gpu;
    let probe: ReturnType<typeof setTimeout> | undefined;
    let adapter: unknown;
    try {
      adapter = await Promise.race([
        surface?.requestAdapter?.() ?? Promise.resolve(null),
        new Promise<never>((_resolve, reject) => {
          probe = setTimeout(() => reject(new Error('WebGPU adapter probe timed out')), L.GPU_PROBE_TIMEOUT_MS);
        })
      ]);
    } catch {
      adapter = null;
    } finally {
      if (probe) clearTimeout(probe);
    }
    const features = (adapter as { features?: { has?: (name: string) => boolean } } | null)?.features;
    if (!features?.has?.('shader-f16')) {
      state.supported = false;
      fail('no-webgpu', 'this GPU has no f16 shader support, which every ONNX card here needs');
    }
    state.supported = true;
    state.reason = null;
    publish();
  }

  /** The JS Unigram tokenizer has no byte-fallback, so an out-of-vocab
   *  character encodes to `unk` and is lost. The card's reference expands such
   *  characters to their UTF-8 bytes as `<0xXX>` tokens, which are in the
   *  vocab, reproducing the ids the Rust tokenizer produces. */
  export function expandByteFallback(text: string): string {
    const cached = expandedTexts.get(text);
    if (cached !== undefined) return cached;
    const tok = tokenizer ?? seams.tokenizer!;
    const encoded = tok(text, { add_special_tokens: false });
    const ids = Array.from(encoded.input_ids.data, Number);
    if (!ids.includes(0)) {
      // The fallback probe already measured these exact no-special-token IDs.
      remember(countedTexts, text, ids.length);
      return remember(expandedTexts, text, text, text.length);
    }
    let out = '';
    const utf8 = new TextEncoder();
    for (const ch of text) {
      const one = Array.from(tok(ch, { add_special_tokens: false }).input_ids.data, Number);
      if (one.length === 1 && one[0] !== 0) {
        out += ch;
        continue;
      }
      for (const byte of utf8.encode(ch)) {
        out += '<0x' + byte.toString(16).toUpperCase().padStart(2, '0') + '>';
      }
    }
    return remember(expandedTexts, text, out, out.length);
  }

  /** Select against each raw fragment; only the template-ready term sides are
   *  sanitized and byte-expanded, just like the source content. */
  /** Dense pages otherwise overflowed: eighty pairs cost 692 prompt tokens on a
   *  1,024-token budget, leaving no room for the source. Terminology may spend
   *  this share of the budget; the planner splits with the same rule, so every
   *  fragment it emits fits. */
  const GLOSSARY_TOKEN_SHARE = 0.35;

  function renderPrompt(target: string, text: string, source: string | null, entries?: readonly AT.glossary.Entry[], limit = Number.POSITIVE_INFINITY): string {
    const sourceLang = P.langFor(source);
    const selected = entries?.length ? AT.glossary.select(entries, text, source, target) : [];
    // A non-finite limit (before the model declares one) must not read as
    // "unlimited": that is exactly how the glossary overran the prompt.
    const budget = Number.isFinite(limit) && limit > 0 ? Math.floor(limit * GLOSSARY_TOKEN_SHARE) : 0;
    let spent = 0;
    const glossary: { source: string; target: string }[] = [];
    for (const pair of selected) {
      const sides = {
        source: expandByteFallback(P.sanitize(pair.source)),
        target: expandByteFallback(P.sanitize(pair.target))
      };
      const cost = promptTokens('<|plamo:index|>' + sides.source + '<|plamo:item|>' + sides.target);
      if (spent + cost > budget) break;
      spent += cost;
      glossary.push(sides);
    }
    const prompt = tokenizer!.apply_chat_template(
      [{ role: 'user', content: expandByteFallback(P.sanitize(text)) }],
      {
        target_lang: P.langFor(target)!,
        add_generation_prompt: true,
        tokenize: false,
        ...(sourceLang ? { source_lang: sourceLang } : {}),
        ...(glossary.length ? { glossary } : {})
      }
    );
    // Older imported templates can accept and silently ignore unknown kwargs.
    // Require the actual native PFML payload, never an invented prompt hint.
    if (glossary.length && !prompt.includes('<|plamo:tag|>glossary' +
        glossary.map(pair => '<|plamo:index|>' + pair.source + '<|plamo:item|>' + pair.target).join(''))) {
      fail('unsupported-glossary', 'The model chat template did not render the native glossary.');
    }
    return prompt;
  }

  function requireLifecycle(version: number): void {
    if (version !== lifecycle) {
      const error = new Error('the model was unloaded') as Error & { reason: string };
      error.reason = 'not-loaded';
      throw error;
    }
  }

  async function ensureLoaded(modelId: string, maxTokens: number, target: string): Promise<number> {
    requireTarget(target);
    const version = lifecycle;
    while (loading || unloading) {
      await (unloading ?? loading);
      requireLifecycle(version);
    }
    if (loadedId === modelId && tokenizer) {
      touchIdleTimer();
      return version;
    }
    if (loadedId) {
      await teardown('replaced');
      return await ensureLoaded(modelId, maxTokens, target);
    }
    const started = Date.now();
    const opening = (async () => {
      await checkSupport();
      requireLifecycle(version);
      const record = await AT.modelstore.get(modelId);
      requireLifecycle(version);
      if (!record) fail('model-missing', `model ${modelId} is not stored`);
      if (L.modelKind(record) !== 'onnx') fail('model-backend', 'Only ONNX models are supported; the stored file has not been deleted');
      state.state = 'loading';
      state.modelName = record.name;
      state.lastError = null;
      publish();
      const card = L.MODEL_SOURCES.find((source) => source.url === record.sourceUrl && source.kind === 'onnx');
      lastTarget = target;
      loadedDtype = card?.dtype ?? AT.pipelinehost.dtypeOf(record.name);
      const lazy = C.ENGINE_KERNELS && Math.floor(C.ENGINE_BATCH) >= 1;
      if (lazy) {
        // The worker opens its own model store and never needs host text or
        // token IDs until generation. Start it alongside tokenizer I/O, but
        // keep the shared load pending until both are ready.
        const openingTokenizer = AT.pipelinehost.openTokenizer(modelId);
        const openingEngine = ensureEngine(modelId);
        try {
          const [opened] = await Promise.all([openingTokenizer, openingEngine]);
          requireLifecycle(version);
          setTokenizer(opened.tokenizer);
        } catch (error: unknown) {
          if (version === lifecycle) stopEngine('the tokenizer could not start');
          await openingEngine;
          // A failed tokenizer load must not strand the next attempt on an
          // engine that was deliberately retired alongside it.
          if (version === lifecycle) engineUnavailable = false;
          throw error;
        }
      } else {
        const opened = await AT.pipelinehost.open(modelId, loadedDtype);
        if (version !== lifecycle) {
          await opened.pipe.dispose?.();
          requireLifecycle(version);
        }
        setTokenizer(opened.tokenizer);
        pipe = opened.pipe;
      }
      const [config, generation] = await Promise.all([
        AT.pipelinehost.modelJson('config.json'), AT.pipelinehost.modelJson('generation_config.json')
      ]);
      requireLifecycle(version);
      modelContextTokens = Number(config?.max_position_embeddings);
      if (!Number.isSafeInteger(modelContextTokens) || modelContextTokens < 2) {
        fail('model-load-failed', 'The model does not declare a valid context token limit.');
      }
      const eos = generation?.eos_token_id ?? config?.eos_token_id ?? tokenizer?.eos_token_id;
      eosTokens = (Array.isArray(eos) ? eos : [eos]).map(Number).filter(id => Number.isSafeInteger(id) && id >= 0);
      if (!eosTokens.length) fail('model-load-failed', 'The model does not declare an end token.');
      loadedId = modelId;
      loadedBytes = Number(record.size) || 0;
      generations = 0;
      await ensureEngine();
      requireLifecycle(version);
      if (!lazy) await warmup(target);
      requireLifecycle(version);
      loadMs = Date.now() - started;
      state.state = 'ready';
      publish();
      touchIdleTimer();
    })();
    loading = opening;
    try {
      await opening;
    } finally {
      if (loading === opening) loading = null;
    }
    return version;
  }

  /** All requests that lose the worker share one fallback initialization. */
  async function ensureInline(): Promise<Pipeline> {
    if (!loadedId || !tokenizer) throw new Error('no model is loaded');
    if (pipe) return pipe;
    if (inlineStarting) return await inlineStarting;
    const version = lifecycle;
    const modelId = loadedId;
    const opening = (async () => {
      const session = await AT.pipelinehost.openPipeline(modelId, loadedDtype);
      if (version !== lifecycle) {
        await session.dispose?.();
        requireLifecycle(version);
      }
      pipe = session;
      return session;
    })();
    inlineStarting = opening;
    try {
      return await opening;
    } finally {
      if (inlineStarting === opening) inlineStarting = null;
    }
  }

  /** Build the shapes a page asks for before the user asks: one short prompt and
   *  one of a realistic length. WebGPU compiles its shaders on the first run of
   *  a shape, and that cost was landing on the first page. */
  async function warmup(target: string): Promise<void> {
    if (!pipe || !tokenizer) return;
    const session = pipe;
    const version = lifecycle;
    const sample =
      'The meeting was moved to Monday because the vendor could not finish the integration tests on time.';
    await session(renderPrompt(target, 'Good morning.', 'en'), { max_new_tokens: 4, do_sample: false, add_special_tokens: false });
    requireLifecycle(version);
    await session(renderPrompt(target, sample, 'en'), { max_new_tokens: 4, do_sample: false, add_special_tokens: false });
    requireLifecycle(version);
    inlineWarmed = true;
  }

  function teardown(cause: string): Promise<void> {
    if (unloading) return unloading;
    lifecycle += 1;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    stopEngine('the model was unloaded');
    // A fresh load tries the engine again: the failure may have been this
    // hardware, this page's memory, or nothing at all.
    engineStarting = null;
    engineUnavailable = false;
    const session = pipe;
    pipe = null;
    inlineWarmed = false;
    setTokenizer(null);
    loadedId = null;
    loadedBytes = 0;
    loadMs = null;
    generations = 0;
    state.state = 'unloaded';
    state.reason = cause === 'idle' ? 'idle-unloaded' : null;
    state.modelId = null;
    state.modelName = null;
    publish();
    const closing = (async () => {
      await Promise.allSettled([loading, inlineStarting, inlineQueue]);
      await session?.dispose?.();
    })();
    unloading = closing;
    return closing.finally(() => {
      if (unloading === closing) unloading = null;
    });
  }

  function touchIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      void teardown('idle');
    }, L.IDLE_UNLOAD_MS);
  }

  function enqueue<T>(job: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const guarded = async (): Promise<T> => {
      L.throwIfAborted(signal);
      const result = await job();
      L.throwIfAborted(signal);
      return result;
    };
    const run = queue.then(guarded, guarded);
    queue = run.then(
      () => undefined,
      () => undefined
    );
    return L.withSignal(run, signal);
  }

  function requireTarget(target: string): void {
    if (P.langFor(target) === null) {
      fail('no-target', `the installed model has no language for ${target || 'that target'}`);
    }
  }

  /** The decode engine: one worker, one WebGPU session, and one forward pass
   *  per step carrying every sequence in flight. A decode step costs 51 ms for
   *  one row and 55 ms for four on this GPU, while a second session cost 1.68x
   *  and bought nothing (docs/native-extension-testing.md), so concurrency comes
   *  from rows in a step, not from sessions. Requests are sent as token ids: the
   *  tokenizer, the prompt and the answer stay here. */
  type EngineSlot = {
    worker: Worker;
    ready: boolean;
    dead: boolean;
    /** Requests this session has been handed and not yet answered. A session
     *  batches what it is given, so handing it several at once is the point. */
    inFlight: number;
    backend?: 'kernels' | 'runtime';
    rows: number;
    contextTokens?: number;
  };

  type Generated = { tokens: number[]; finishReason: 'eos' | 'length' };
  type EngineJob = {
    resolve: (result: Generated) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    slot: EngineSlot;
    onProgress?: ((text: string) => void) | undefined;
    progressTokens: number;
    signal?: AbortSignal | undefined;
    abort: () => void;
  };

  const pending = new Map<number, EngineJob>();
  /** Decode sessions. The host hands each request to the least-loaded one; the
   *  session batches whatever reaches it, so one session still shares a step. */
  let engines: EngineSlot[] = [];
  let engineStarting: Promise<void> | null = null;
  let engineUnavailable = false;
  let jobId = 0;

  function liveEngines(): EngineSlot[] {
    return engines.filter((slot) => slot.ready && !slot.dead);
  }

  /** A failure of the engine itself, never of a generation: the request that
   *  hit it finishes on the in-document session instead of failing. */
  function engineFailure(message: string): Error & { code: string } {
    const error = new Error(message) as Error & { code: string };
    error.code = 'worker-init';
    return error;
  }

  /** A request the engine stopped answering: the request recovers elsewhere,
   *  the engine itself is not at fault. */
  function engineTimeout(message: string): Error & { code: string } {
    const error = new Error(message) as Error & { code: string };
    error.code = 'engine-timeout';
    return error;
  }

  function codeOf(error: unknown): string {
    return String((error as { code?: unknown })?.code ?? '');
  }

  function settle(id: number, what: { tokens?: number[]; finishReason?: 'eos' | 'length'; error?: string; failure?: Error }): void {
    const job = pending.get(id);
    if (!job) return;
    pending.delete(id);
    clearTimeout(job.timer);
    job.signal?.removeEventListener('abort', job.abort);
    release(job.slot);
    if (what.failure) { job.reject(what.failure); return; }
    if (what.error === undefined && what.tokens && what.finishReason) job.resolve({ tokens: what.tokens, finishReason: what.finishReason });
    else {
      const error = new Error(what.error || 'the decode engine failed') as Error & { code: string };
      error.code = 'worker-generate';
      job.reject(error);
    }
  }

  function onEngineMessage(slot: EngineSlot, message: AT.local.WorkerReply): void {
    if (message?.type === L.WORKER_MESSAGE.READY) {
      if (message.ok) {
        slot.ready = true;
        slot.backend = message.backend ?? 'runtime';
        slot.rows = typeof message.rows === 'number' && message.rows >= 1 ? Math.min(8, Math.round(message.rows)) : 1;
        slot.contextTokens = message.contextTokens;
        if (liveEngines()[0] === slot) {
          state.backend = slot.backend;
          state.rows = slot.rows;
          publish();
        }
      } else {
        slot.dead = true;
        if (!liveEngines().length) disableEngine(message.error || 'the decode engine could not start');
      }
      return;
    }
    if (message?.type === L.WORKER_MESSAGE.PROGRESS) {
      const job = pending.get(message.id);
      if (!job?.onProgress || job.slot !== slot || slot.dead || !tokenizer) return;
      if (!Array.isArray(message.tokens) || message.tokens.length <= job.progressTokens ||
          !message.tokens.every((id) => Number.isSafeInteger(id) && id >= 0)) return;
      job.progressTokens = message.tokens.length;
      // Decode the cumulative GENERATED ids: a byte-fallback character can
      // span several tokens. Never decode isolated token deltas.
      job.onProgress(tokenizer.decode(message.tokens, { skip_special_tokens: true }));
      return;
    }
    if (message?.type !== L.WORKER_MESSAGE.RESULT) return;
    if (pending.get(message.id)?.slot !== slot || slot.dead) return;
    if (message.ok) {
      // The worker counts tokens and the milliseconds it spent on each phase;
      // the status carries the rates so a reader sees tok/s, not step times.
      const stats = message.stats;
      if (stats) {
        state.prefillTokens = Math.round(stats.prefillTokens);
        state.decodeTokens = Math.round(stats.decodeTokens);
        if (stats.prefillMs > 0) state.prefillTokPerSec = (stats.prefillTokens / stats.prefillMs) * 1000;
        if (stats.decodeMs > 0) state.decodeTokPerSec = (stats.decodeTokens / stats.decodeMs) * 1000;
        publish();
      }
      settle(message.id, { tokens: message.tokens, finishReason: message.finishReason });
    } else settle(message.id, { error: message.error });
  }


  function stopEngine(reason: string): void {
    for (const slot of engines) {
      slot.dead = true;
      slot.worker.onmessage = null;
      slot.worker.onerror = null;
      slot.worker.onmessageerror = null;
      slot.worker.terminate();
    }
    engines = [];
    for (const id of pending.keys()) settle(id, { failure: engineFailure(reason) });
  }

  function disableEngine(reason: string): void {
    engineUnavailable = true;
    stopEngine('the decode engine was shut down');
    // Recorded, never thrown: the host still answers, one generation at a time.
    state.reason = 'worker-init';
    publish();
    AT.warn('on-device decode engine unavailable; generating in the offscreen document:', reason);
  }

  /** Opens the engine and waits for its session. A worker that never answers is
   *  a dead engine, caught by the same deadline the pool used. */
  async function startEngine(modelId: string): Promise<void> {
    const version = lifecycle;
    // 0 is the documented way to run without the engine: the in-document
    // session answers everything, exactly as it did before the engine existed.
    if (Math.floor(C.ENGINE_BATCH) < 1) {
      disableEngine('C.ENGINE_BATCH is 0');
      return;
    }
    if (typeof Worker !== 'function') {
      disableEngine('this context cannot create a worker');
      return;
    }
    const count = Math.max(1, Math.min(Math.floor(C.HOST_POOL_SIZE) || 1, 8));
    const slots: EngineSlot[] = [];
    for (let index = 0; index < count; index += 1) {
      let worker: Worker;
      try {
        worker = new Worker(AT.getURL('hostworker.js'));
      } catch (error: unknown) {
        // One worker is still an engine; none is a reason to fall back.
        if (!slots.length) disableEngine(String((error as { message?: unknown })?.message ?? error));
        break;
      }
      const slot: EngineSlot = { worker, ready: false, dead: false, inFlight: 0, rows: 1 };
      slots.push(slot);
      worker.onmessage = (event: MessageEvent) => onEngineMessage(slot, event.data as AT.local.WorkerReply);
      worker.onerror = () => {
        slot.dead = true;
        if (!liveEngines().length) disableEngine(slot.ready ? 'the decode engine crashed' : 'the decode engine crashed while starting');
      };
      worker.onmessageerror = () => {
        slot.dead = true;
        if (!liveEngines().length) disableEngine('the decode engine sent an unreadable message');
      };
    }
    engines = slots;
    const started = Date.now();
    const ready = new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        const settled = slots.every((slot) => slot.ready || slot.dead);
        if (settled || Date.now() - started > L.WORKER_START_TIMEOUT_MS) {
          clearInterval(poll);
          resolve();
        }
      }, 25);
    });
    for (const slot of slots) {
      if (slot.dead) continue;
      slot.worker.postMessage({
        type: L.WORKER_MESSAGE.INIT,
        modelId,
        dtype: loadedDtype,
        target: lastTarget
      } satisfies AT.local.WorkerInit);
    }
    await ready;
    if (version !== lifecycle || engines !== slots) return;
    if (!liveEngines().length) disableEngine('the decode engine did not start in time');
  }

  async function ensureEngine(modelId = loadedId ?? ''): Promise<void> {
    if (engineUnavailable || liveEngines().length) return;
    if (engineStarting) return await engineStarting;
    const starting = startEngine(modelId);
    engineStarting = starting;
    try {
      await starting;
    } finally {
      if (engineStarting === starting) engineStarting = null;
    }
  }

  /** One request as tokens: the prompt is encoded here, where the tokenizer
   *  lives, and the answer is decoded here too. */
  /** The session with the fewest requests in flight: with one session that is
   *  the session itself, and its scheduler batches the requests it is given. */
  function acquire(): EngineSlot {
    const candidates = liveEngines();
    if (!candidates.length) throw engineFailure('the decode engine is not running');
    let chosen = candidates[0]!;
    for (const slot of candidates) if (slot.inFlight < chosen.inFlight) chosen = slot;
    chosen.inFlight += 1;
    return chosen;
  }

  function release(slot: EngineSlot): void {
    slot.inFlight = Math.max(0, slot.inFlight - 1);
  }

  async function generateInEngine(prompt: string, maxNewTokens: number, onProgress?: (text: string) => void, signal?: AbortSignal): Promise<string> {
    L.throwIfAborted(signal);
    await L.withSignal(ensureEngine(), signal);
    L.throwIfAborted(signal);
    if (!liveEngines().length || !tokenizer) throw engineFailure('the decode engine is not running');
    const inputIds = promptIds(prompt);
    const slot = acquire();
    const id = (jobId += 1);
    const { promise, resolve, reject } = Promise.withResolvers<Generated>();
    const drop = (failure: Error): void => {
      if (!pending.has(id)) return;
      settle(id, { failure });
      // DROP removes only this row; it never tears down a shared model.
      try { slot.worker.postMessage({ type: L.WORKER_MESSAGE.DROP, id } satisfies AT.local.WorkerDrop); }
      catch { /* A closed worker has already stopped its rows. */ }
    };
    const abort = (): void => drop(L.cancelled());
    const timer = setTimeout(() => drop(engineTimeout('the decode engine did not answer')),
      L.GENERATION_TIMEOUT_MS + L.WORKER_REPLY_GRACE_MS);
    pending.set(id, { resolve, reject, timer, slot, onProgress, progressTokens: 0, signal, abort });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    else try {
      slot.worker.postMessage({
        type: L.WORKER_MESSAGE.GENERATE,
        id,
        inputIds,
        maxNewTokens,
        ...(onProgress ? { stream: true } : {})
      } satisfies AT.local.WorkerGenerate);
    } catch (error) { settle(id, { failure: engineFailure(String(error)) }); }
    const result = await promise;
    L.throwIfAborted(signal);
    // Only EOS proves completeness. A length-limited answer is thrown here and
    // handled by the caller, which can still translate it in smaller pieces.
    if (result.finishReason !== 'eos') {
      const error = new Error('The translation reached its output token limit before an end token.') as Error & { reason: string; code: string };
      error.reason = 'output-limit';
      error.code = 'provider';
      throw error;
    }
    return tokenizer.decode(result.tokens, { skip_special_tokens: true });
  }

  /** The engine first. An engine that is gone finishes this request on the
   *  in-document session and is never used again; one that merely missed this
   *  request's deadline answers it here and keeps serving the rest. */
  async function generateText(prompt: string, maxNewTokens: number, onProgress?: (text: string) => void, signal?: AbortSignal): Promise<string> {
    L.throwIfAborted(signal);
    const version = lifecycle;
    if (!engineUnavailable) {
      try {
        return await generateInEngine(prompt, maxNewTokens, onProgress, signal);
      } catch (error: unknown) {
        L.throwIfAborted(signal);
        if (codeOf(error) === 'cancelled') throw error;
        requireLifecycle(version);
        const code = codeOf(error);
        const message = String((error as { message?: unknown })?.message ?? error);
        // An unload tears the engine down on purpose: that is not a reason to
        // stamp `worker-init` on a model that is already gone.
        if (code === 'worker-init' && loadedId && tokenizer) disableEngine(message);
        else if (code === 'engine-timeout') AT.warn('the decode engine missed a deadline; answering this request in the offscreen document');
        else throw error;
        onProgress?.('');
      }
    }
    return await generateInline(prompt, maxNewTokens, onProgress, signal);
  }

  /** The fallback session is opened on demand and runs one generation at a time. */
  async function generateInline(prompt: string, maxNewTokens: number, onProgress?: (text: string) => void, signal?: AbortSignal): Promise<string> {
    L.throwIfAborted(signal);
    const version = lifecycle;
    const opening = ensureInline();
    // Observe initialization immediately even while an earlier generation runs.
    void opening.catch(() => undefined);
    const run = inlineQueue.then(async () => {
      L.throwIfAborted(signal);
      const session = await opening;
      L.throwIfAborted(signal);
      requireLifecycle(version);
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      let active = true;
      let preview = '';
      let sent = '';
      let lastSent = -Infinity;
      let flush: (() => void) | undefined;
      let textStreamer: { put: (tokens: (number | bigint)[][]) => void; end: () => void } | undefined;
      if (onProgress) {
        const tf = seams.runtime?.() ?? (globalThis as Record<string, unknown>).AT_TRANSFORMERS as AT.pipelinehost.TfModule | undefined;
        if (tf?.TextStreamer) {
          flush = () => {
            if (!active || controller.signal.aborted || version !== lifecycle || preview === sent) return;
            sent = preview;
            lastSent = performance.now();
            onProgress(preview);
          };
          // Transformers.js emits decoded chunks, not cumulative strings.
          // skip_prompt prevents the tokenizer's PFML header reaching previews.
          textStreamer = new tf.TextStreamer(tokenizer!, {
            skip_prompt: true,
            skip_special_tokens: true,
            callback_function: (text: string) => {
              if (!active || controller.signal.aborted || version !== lifecycle) return;
              preview += text;
              if (performance.now() - lastSent >= 40) flush?.();
            }
          });
        }
      }
      let promptPending = true;
      let lastToken: number | undefined;
      const streamer = {
        put(tokens: (number | bigint)[][]): void {
          if (promptPending) promptPending = false;
          else for (const token of tokens[0] ?? []) lastToken = Number(token);
          textStreamer?.put(tokens);
        },
        end(): void { textStreamer?.end(); }
      };
      const timer = setTimeout(() => controller.abort(), L.GENERATION_TIMEOUT_MS);
      inlineInFlight += 1;
      try {
        const out = await session(prompt, {
          max_new_tokens: maxNewTokens,
          do_sample: false,
          add_special_tokens: false,
          abort_signal: controller.signal,
          streamer
        });
        L.throwIfAborted(signal);
        requireLifecycle(version);
        if (lastToken === undefined || !eosTokens.includes(lastToken)) {
          fail('invalid-output', 'The translation ended without an end token.');
        }
        flush?.();
        return answerOf(out?.[0]?.generated_text, prompt);
      } finally {
        active = false;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        inlineInFlight -= 1;
        if (signal?.aborted && version === lifecycle && loadedId && !pending.size && !inlineInFlight) {
          state.state = 'ready';
          publish();
        }
      }
    });
    inlineQueue = run.catch(() => undefined);
    // The queue retains the real kernel lifetime even when its caller leaves.
    return await L.withSignal(run, signal);
  }

  /** One generation with identical structural safety for previews and final text. */
  async function generate(prompt: string, maxNewTokens: number, source: string, onProgress?: (text: string) => void, signal?: AbortSignal): Promise<string> {
    L.throwIfAborted(signal);
    if (!loadedId || !tokenizer) fail('not-loaded', 'no model is loaded');
    const version = lifecycle;
    let previous = '';
    const preview = onProgress ? (raw: string): void => {
      if (version !== lifecycle || signal?.aborted) return;
      // Hold incomplete UTF-8 byte fallback and unfinished control syntax until
      // later ids complete them. Final validation still sees the original text.
      const text = raw.replace(/\uFFFD+$/u, '').replace(/<[^>]*$/u, '').trim();
      const valid = !text.includes('\uFFFD') && !AT.outputIssue(source, text, true) && !L.isRunaway(text, source);
      const next = valid ? text : '';
      if (next === previous) return;
      previous = next;
      try { onProgress(next); } catch { /* A detached subscriber cannot fail generation. */ }
    } : undefined;
    try {
      const generated = await generateText(prompt, maxNewTokens, preview, signal);
      L.throwIfAborted(signal);
      requireLifecycle(version);
      generations += 1;
      touchIdleTimer();
      const answer = generated.trim();
      const issue = AT.outputIssue(source, answer);
      if (issue || L.isRunaway(answer, source)) fail('invalid-output', 'Invalid translation output: ' + (issue ?? 'repetition or runaway output'));
      return answer;
    } catch (error: unknown) {
      L.throwIfAborted(signal);
      if (codeOf(error) === 'cancelled') throw error;
      if (previous) {
        try { onProgress?.(''); } catch { /* Preserve the generation failure. */ }
      }
      requireLifecycle(version);
      // A length-limited answer is not a dead end: the caller can split the
      // source and translate it in smaller pieces.
      if (error instanceof Error && 'reason' in error &&
          (error.reason === 'invalid-output' || error.reason === 'output-limit')) throw error;
      const message = String((error as { message?: unknown })?.message ?? error);
      fail(message.toLowerCase().includes('abort') ? 'generation-timeout' : 'generation-failed', error);
    }
  }

  /** The fallback pipeline returns the full decoded sequence. Decode the input
   * with the same tokenizer: stripping marker strings cannot reproduce byte
   * fallback, normalization or spacing. Never cut at a source occurrence: the
   * output header follows it, and the answer may legitimately repeat it. */
  function answerOf(generated: unknown, prompt: string): string {
    const text = typeof generated === 'string' ? generated : '';
    if (prompt && text.startsWith(prompt)) return text.slice(prompt.length);
    const input = promptIds(prompt);
    const decoded = tokenizer!.decode(input, { skip_special_tokens: true });
    if (decoded && text.startsWith(decoded)) return text.slice(decoded.length);
    fail('invalid-output', 'The generated response did not contain the complete decoded prompt.');
  }

  function contextLimit(maxTokens: number): number {
    return Math.min(L.clampTokens(maxTokens), modelContextTokens,
      ...liveEngines().map(slot => slot.contextTokens ?? 0));
  }

  function generationPlan(target: string, text: string, source: string | null, maxTokens: number, glossary?: readonly AT.glossary.Entry[]) {
    const limit = contextLimit(maxTokens);
    const prompt = renderPrompt(target, text, source, glossary, limit);
    const inputTokens = promptIds(prompt).length;
    const outputTokens = L.answerTokens(tokenCount(text));
    return { prompt, outputTokens, totalTokens: inputTokens + outputTokens, limit };
  }

  /** Where to cut a source whose answer ran out of room: a sentence end near the
   *  middle, then whitespace, then plain graphemes. Always inside the text. */
  function splitPoint(text: string): { at: number; space: boolean } {
    const length = text.length;
    if (length < 2) return { at: 0, space: false };
    const middle = Math.floor(length / 2);
    const window = Math.max(1, Math.floor(length / 4));
    const start = Math.max(1, middle - window);
    const end = Math.min(length - 1, middle + window);
    const sentence = /[。．.!?！？\n]/g;
    let best = 0;
    for (let match = sentence.exec(text); match !== null; match = sentence.exec(text)) {
      const at = match.index + 1;
      if (at <= start || at >= end) continue;
      if (!best || Math.abs(at - middle) < Math.abs(best - middle)) best = at;
    }
    if (best) return { at: best, space: false };
    const space = text.lastIndexOf(' ', middle);
    if (space >= start) return { at: space + 1, space: true };
    const characters = Array.from(text);
    return { at: characters.slice(0, Math.max(1, Math.floor(characters.length / 2))).join('').length, space: false };
  }

  /** A cut at whitespace consumed the separator, so one space puts it back; a
   *  sentence or grapheme cut did not. */
  function joinParts(parts: readonly string[], space: boolean): string {
    return parts.map(part => part.trim()).filter(Boolean).join(space ? ' ' : '');
  }

  async function translateOne(target: string, text: string, source: string | null, maxTokens: number, glossary: readonly AT.glossary.Entry[] | undefined, onProgress?: (text: string) => void, signal?: AbortSignal, depth = 0): Promise<string> {
    L.throwIfAborted(signal);
    const plan = generationPlan(target, text, source, maxTokens, glossary);
    if (plan.totalTokens > plan.limit) fail('context-overflow', 'The source and output reserve exceed the model context; plan source fragments first.');
    try {
      return await generate(plan.prompt, plan.outputTokens, text, onProgress, signal);
    } catch (error: unknown) {
      if ((error as { reason?: unknown }).reason !== 'output-limit') throw error;
      // The reserve is a guess about answer length. When it was too small, the
      // source is translated in two pieces rather than failing the element.
      const cut = depth >= 3 ? { at: 0, space: false } : splitPoint(text);
      if (!cut.at) fail('invalid-output', 'The translation reached its output token limit before an end token.');
      const pieces: string[] = [];
      for (const piece of [text.slice(0, cut.at), text.slice(cut.at)]) {
        pieces.push(await translateOne(target, piece, source, maxTokens, glossary, onProgress, signal, depth + 1));
      }
      return joinParts(pieces, cut.space);
    }
  }

  async function translateChunk(target: string, texts: string[], source: string | null, maxTokens: number, glossary: readonly AT.glossary.Entry[] | undefined, onProgress?: AT.TranslationProgress, signal?: AbortSignal): Promise<string[]> {
    L.throwIfAborted(signal);
    if (texts.length === 1) return [await translateOne(target, texts[0] ?? '', source, maxTokens, glossary, onProgress ? (text) => onProgress(0, text) : undefined, signal)];
    // WebGPU rows share weights while keeping each source's prompt, output
    // budget and identity independent. Refill only the advertised row count;
    // the worker owns global admission across concurrent application requests.
    const width = Math.min(texts.length,
      Math.max(1, ...liveEngines().filter((slot) => slot.backend === 'kernels').map((slot) => slot.rows)));
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const out = new Array<string>(texts.length);
    let next = 0;
    const consume = async (): Promise<void> => {
      for (;;) {
        L.throwIfAborted(controller.signal);
        const index = next++;
        if (index >= texts.length) return;
        out[index] = await translateOne(target, texts[index]!, source, maxTokens, glossary,
          onProgress ? (text) => onProgress(index, text) : undefined, controller.signal);
      }
    };
    const running = Array.from({ length: width }, consume);
    try {
      await Promise.all(running);
      return out;
    } catch (error: unknown) {
      // Failed batches must not leave sibling rows generating or publishing.
      controller.abort();
      await Promise.allSettled(running);
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  /** The tokens a prompt string costs in the model's own tokenizer. */
  function promptTokens(prompt: string): number {
    if (!tokenizer) fail('not-loaded', 'The source tokenizer is unavailable.');
    const cached = countedTexts.get(prompt);
    if (cached !== undefined) return cached;
    return remember(countedTexts, prompt, tokenizer(prompt, { add_special_tokens: false }).input_ids.data.length);
  }

  /** The tokens one segment costs inside a prompt: sanitized and byte-expanded
   *  exactly as `renderPrompt` writes it, and counted without specials so the
   *  number is the text's own cost rather than the template's. */
  function tokenCount(text: string): number {
    return promptTokens(expandByteFallback(P.sanitize(text)));
  }

  type CountRequest = AT.local.TranslateRequest;

  /** Exact costs and sentence-first plans, including prompt and output reserve. */
  async function countNow(request: CountRequest, signal?: AbortSignal): Promise<AT.local.TokenCounts> {
    L.throwIfAborted(signal);
    const modelId = typeof request.modelId === 'string' ? request.modelId : '';
    if (!modelId) fail('no-model', 'no model is selected');
    const inputs = Array.isArray(request.texts)
      ? request.texts.filter((text): text is string => typeof text === 'string')
      : [];
    const texts = inputs;
    const target = typeof request.target === 'string' ? request.target : '';
    requireTarget(target);
    const source = typeof request.source === 'string' ? request.source : null;
    const maxTokens = Number(request.maxTokens) || L.DEFAULT_MAX_TOKENS;
    const version = await ensureLoaded(modelId, maxTokens, target);
    L.throwIfAborted(signal);
    const limit = contextLimit(maxTokens);
    const result: AT.local.TokenCounts = { counts: [], sourceChunks: [] };
    for (const text of texts) {
      L.throwIfAborted(signal);
      requireLifecycle(version);
      result.counts.push(tokenCount(text));
      const matches = request.glossary?.length
        ? AT.glossary.selectSpans(request.glossary, text, source, target) : [];
      result.sourceChunks.push(await L.sourceChunks(text, limit, fragment => {
        requireLifecycle(version);
        L.throwIfAborted(signal);
        return generationPlan(target, fragment, source, maxTokens, request.glossary).totalTokens;
      }, signal, matches));
    }
    L.throwIfAborted(signal);
    requireLifecycle(version);
    return result;
  }

  async function translateNow(request: AT.local.TranslateRequest, onProgress?: AT.TranslationProgress, signal?: AbortSignal): Promise<AT.local.HostReply> {
    L.throwIfAborted(signal);
    const texts = Array.isArray(request.texts)
      ? request.texts.filter((text): text is string => typeof text === 'string')
      : [];
    const askedTarget = typeof request.target === 'string' ? request.target : '';
    const maxTokens = Number(request.maxTokens) || L.DEFAULT_MAX_TOKENS;
    const source = typeof request.source === 'string' ? request.source : null;
    if (texts.length === 0) return { translations: [] };
    if (P.langFor(askedTarget) === null) {
      fail('no-target', `no model translates into ${askedTarget || 'that language'}`);
    }
    const modelId = typeof request.modelId === 'string' && request.modelId ? request.modelId : '';
    if (!modelId) fail('no-model', 'no model is selected');
    state.state = 'busy';
    publish();
    let version = lifecycle;
    try {
      version = await ensureLoaded(modelId, maxTokens, askedTarget);
      L.throwIfAborted(signal);
      requireLifecycle(version);
      const translations = await translateChunk(askedTarget, texts, source, maxTokens, request.glossary, onProgress, signal);
      L.throwIfAborted(signal);
      requireLifecycle(version);
      state.state = 'ready';
      publish();
      return { translations };
    } catch (error: unknown) {
      if (signal?.aborted || codeOf(error) === 'cancelled') {
        if (version === lifecycle && loadedId && !pending.size && !inlineInFlight) { state.state = 'ready'; publish(); }
        throw L.cancelled();
      }
      requireLifecycle(version);
      const reason = (error as { reason?: string })?.reason ?? 'generation-failed';
      fail(reason, error);
    }
  }

  export async function status(): Promise<AT.local.LocalStatus> {
    try {
      await checkSupport();
    } catch {
      // checkSupport recorded the reason before it threw.
    }
    publish();
    return state;
  }

  export async function load(modelId: string, maxTokens: number, target: string): Promise<AT.local.LocalStatus> {
    const version = await ensureLoaded(modelId, maxTokens, target);
    // Preparation commits a replacement model. A tokenizer alone is not proof
    // it works: if no worker opened the graph, validate the document fallback
    // before the caller can select it and retire the previous model. Ordinary
    // translations still open their fallback lazily, without an eager warmup.
    if (!liveEngines().length && !inlineWarmed) {
      state.state = 'loading';
      publish();
      try {
        await ensureInline();
        requireLifecycle(version);
        await warmup(target);
        requireLifecycle(version);
      } catch (error: unknown) {
        requireLifecycle(version);
        const reason = error && typeof error === 'object' && 'reason' in error && typeof error.reason === 'string'
          ? error.reason : 'model-load-failed';
        fail(reason, error);
      }
      state.state = 'ready';
      state.reason = engineUnavailable ? 'worker-init' : null;
      state.lastError = null;
      publish();
    }
    return state;
  }

  export async function unload(cause = 'requested'): Promise<AT.local.LocalStatus> {
    await teardown(cause);
    return state;
  }

  export async function translate(request: AT.local.TranslateRequest, onProgress?: AT.TranslationProgress, signal?: AbortSignal): Promise<AT.local.HostReply> {
    L.throwIfAborted(signal);
    // Not queued: each request is one pool job, and the pool is what keeps a
    // page's N requests finishing in ceil(N / poolSize) request-times rather
    // than N. Loading, unloading and counting still queue (see `handle`).
    return await L.withSignal(translateNow(request, onProgress, signal), signal);
  }

  export async function handle(message: AT.Message, onProgress?: AT.TranslationProgress, signal?: AbortSignal): Promise<AT.local.HostReply> {
    L.throwIfAborted(signal);
    switch (message?.type) {
      case C.MSG.LOCAL_TRANSLATE:
        return await translate(message as AT.local.TranslateRequest, onProgress, signal);
      case C.MSG.LOCAL_LOAD: {
        const request = message as { modelId?: unknown; target?: unknown; maxTokens?: unknown };
        const modelId = typeof request.modelId === 'string' ? request.modelId : '';
        if (!modelId) fail('no-model', 'no model is selected');
        const askedTarget =
          typeof request.target === 'string' && P.langFor(request.target) !== null ? request.target : 'ko';
        return {
          status: await enqueue(() => load(modelId, Number(request.maxTokens) || L.DEFAULT_MAX_TOKENS, askedTarget))
        };
      }
      case C.MSG.LOCAL_UNLOAD:
        await enqueue(() => Promise.resolve());
        return { status: await unload('requested') };
      case C.MSG.LOCAL_COUNT:
        // Counting reads the tokenizer, which arrives with the model, so it
        // queues behind a load like a generation does.
        return await enqueue(() => countNow(message as CountRequest, signal), signal);
      case C.MSG.LOCAL_QUERY:
      case C.MSG.LOCAL_STATUS:
        return { status: await status() };
      default:
        return {};
    }
  }
}

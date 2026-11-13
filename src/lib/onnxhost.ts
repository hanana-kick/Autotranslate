// The on-device host: load, unload, status, translate and handle, over
// Transformers.js on onnxruntime-web WebGPU, with the ONNX export of PLaMo 3
// Translate stored in OPFS. Everything that is not the runtime - the prompt,
// packing, the script guard, the token budget - is shared through `AT.local`
// and `AT.plamo3`.
//
// The vendored runtime arrives as classic scripts that publish three globals
// (`AT_ORT_COMMON`, `AT_ORT_WEBGPU`, `AT_TRANSFORMERS`); the model's own files
// (config, tokenizer, the graph) are served to Transformers.js through a
// custom cache backed by OPFS, so nothing but the extension's own origin is
// ever fetched.
//
// Load after lib/constants.js, lib/browser.js, lib/plamo3.js, lib/local.js,
// lib/modelstore.js and lib/pipelinehost.js, and after
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
  let lifecycle = 0;
  let reporter: ((status: AT.local.LocalStatus) => void) | null = null;
  let lastMaxTokens = L.DEFAULT_MAX_TOKENS;
  /** The language the resident session was loaded for; the pool boots from it. */
  let lastTarget = 'ko';
  /** The dtype the resident graph was opened with; every worker opens the same. */
  let loadedDtype = 'fp16';

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

  export function configure(patch: Seams): void {
    seams = { ...seams, ...patch };
    AT.pipelinehost.installSeams(seams);
    if (patch.tokenizer) tokenizer = patch.tokenizer;
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
    const tok = tokenizer ?? seams.tokenizer!;
    const encoded = tok(text, { add_special_tokens: false });
    const ids = Array.from(encoded.input_ids.data as ArrayLike<number | bigint>).map(Number);
    if (!ids.includes(0)) return text;
    let out = '';
    for (const ch of text) {
      const one = Array.from(tok(ch, { add_special_tokens: false }).input_ids.data as ArrayLike<number | bigint>).map(Number);
      if (one.length === 1 && one[0] !== 0) {
        out += ch;
        continue;
      }
      for (const byte of new TextEncoder().encode(ch)) {
        out += '<0x' + byte.toString(16).toUpperCase().padStart(2, '0') + '>';
      }
    }
    return out;
  }

  /** The PFML3 prompt exactly as `AT.plamo3.buildPrompt` builds it, rendered
   *  through the tokenizer's own chat template so the special tokens line up
   *  with the ONNX graph's expectations. */
  function renderPrompt(target: string, text: string, hint: string | null): string {
    // Pass the page text as a plain string, not a chat: the template is already
    // applied here, and a chat input would make the pipeline render it again.
    // The prompt comes back verbatim in `generated_text`; `answerOf` cuts it off.
    const safe = P.sanitize(text);
    const context = hint === null ? null : P.sanitize(hint);
    return tokenizer!.apply_chat_template(
      [{ role: 'user', content: expandByteFallback(safe) }],
      {
        target_lang: P.langFor(target) ?? 'ko',
        add_generation_prompt: true,
        tokenize: false,
        ...(context === null ? {} : { context })
      }
    );
  }

  function requireLifecycle(version: number): void {
    if (version !== lifecycle) {
      const error = new Error('the model was unloaded') as Error & { reason: string };
      error.reason = 'not-loaded';
      throw error;
    }
  }

  async function ensureLoaded(modelId: string, maxTokens: number, target: string): Promise<number> {
    lastMaxTokens = maxTokens;
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
      state.state = 'loading';
      state.modelName = record.name;
      state.lastError = null;
      publish();
      const card = L.MODEL_SOURCES.find((source) => source.url === record.sourceUrl && source.kind === 'onnx');
      lastTarget = target;
      loadedDtype = card?.dtype ?? AT.pipelinehost.dtypeOf(record.name);
      const lazy = C.ENGINE_KERNELS && Math.floor(C.ENGINE_BATCH) >= 1;
      if (lazy) {
        const opened = await AT.pipelinehost.openTokenizer(modelId);
        requireLifecycle(version);
        tokenizer = opened.tokenizer;
      } else {
        const opened = await AT.pipelinehost.open(modelId, loadedDtype);
        if (version !== lifecycle) {
          await opened.pipe.dispose?.();
          requireLifecycle(version);
        }
        tokenizer = opened.tokenizer;
        pipe = opened.pipe;
      }
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
    const lang = P.langFor(target) ?? 'ko';
    const build = (text: string): string =>
      tokenizer!.apply_chat_template(
        [{ role: 'user', content: expandByteFallback(P.sanitize(text)) }],
        { target_lang: lang, add_generation_prompt: true, tokenize: false }
      );
    const sample =
      'The meeting was moved to Monday because the vendor could not finish the integration tests on time.';
    await session(build('Good morning.'), { max_new_tokens: 4, do_sample: false });
    requireLifecycle(version);
    await session(build(sample), { max_new_tokens: 4, do_sample: false });
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
    tokenizer = null;
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

  function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = queue.then(job, job);
    queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
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
  };

  type EngineJob = {
    resolve: (tokens: number[]) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    slot: EngineSlot;
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

  function settle(id: number, what: { tokens?: number[]; error?: string }): void {
    const job = pending.get(id);
    if (!job) return;
    pending.delete(id);
    clearTimeout(job.timer);
    if (what.error === undefined && what.tokens) job.resolve(what.tokens);
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
    if (message?.type !== L.WORKER_MESSAGE.RESULT) return;
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
      settle(message.id, { tokens: message.tokens });
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
    if (pending.size) {
      for (const [, job] of pending) {
        clearTimeout(job.timer);
        job.reject(engineFailure(reason));
      }
      pending.clear();
    }
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
  async function startEngine(): Promise<void> {
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
        modelId: loadedId ?? '',
        dtype: loadedDtype,
        target: lastTarget
      } satisfies AT.local.WorkerInit);
    }
    await ready;
    if (version !== lifecycle) return;
    if (!liveEngines().length) disableEngine('the decode engine did not start in time');
  }

  async function ensureEngine(): Promise<void> {
    if (engineUnavailable || liveEngines().length) return;
    if (engineStarting) return await engineStarting;
    const starting = startEngine();
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

  async function generateInEngine(prompt: string, maxNewTokens: number): Promise<string> {
    await ensureEngine();
    if (!liveEngines().length || !tokenizer) throw engineFailure('the decode engine is not running');
    const inputIds = Array.from(tokenizer(prompt).input_ids.data as ArrayLike<number | bigint>).map(Number);
    const slot = acquire();
    const id = (jobId += 1);
    try {
      const tokens = await new Promise<number[]>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          // The engine keeps its session: the row is abandoned, not the engine.
          slot.worker.postMessage({ type: L.WORKER_MESSAGE.DROP, id } satisfies AT.local.WorkerDrop);
          reject(engineTimeout('the decode engine did not answer'));
        }, L.GENERATION_TIMEOUT_MS + L.WORKER_REPLY_GRACE_MS);
        pending.set(id, { resolve, reject, timer, slot });
        slot.worker.postMessage({
          type: L.WORKER_MESSAGE.GENERATE,
          id,
          inputIds,
          maxNewTokens
        } satisfies AT.local.WorkerGenerate);
      });
      return tokenizer.decode([...inputIds, ...tokens], { skip_special_tokens: true });
    } finally {
      release(slot);
    }
  }

  /** The engine first. An engine that is gone finishes this request on the
   *  in-document session and is never used again; one that merely missed this
   *  request's deadline answers it here and keeps serving the rest. */
  async function generateText(prompt: string, maxNewTokens: number): Promise<string> {
    const version = lifecycle;
    if (!engineUnavailable) {
      try {
        return await generateInEngine(prompt, maxNewTokens);
      } catch (error: unknown) {
        requireLifecycle(version);
        const code = codeOf(error);
        const message = String((error as { message?: unknown })?.message ?? error);
        // An unload tears the engine down on purpose: that is not a reason to
        // stamp `worker-init` on a model that is already gone.
        if (code === 'worker-init' && loadedId && tokenizer) disableEngine(message);
        else if (code === 'engine-timeout') AT.warn('the decode engine missed a deadline; answering this request in the offscreen document');
        else throw error;
      }
    }
    return await generateInline(prompt, maxNewTokens);
  }

  /** The fallback session is opened on demand and runs one generation at a time. */
  async function generateInline(prompt: string, maxNewTokens: number): Promise<string> {
    const version = lifecycle;
    const opening = ensureInline();
    // Observe initialization immediately even while an earlier generation runs.
    void opening.catch(() => undefined);
    const run = inlineQueue.then(async () => {
      const session = await opening;
      requireLifecycle(version);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), L.GENERATION_TIMEOUT_MS);
      try {
        const out = await session(prompt, {
          max_new_tokens: maxNewTokens,
          do_sample: false,
          abort_signal: controller.signal
        });
        requireLifecycle(version);
        return out?.[0]?.generated_text ?? '';
      } finally {
        clearTimeout(timer);
      }
    });
    inlineQueue = run.catch(() => undefined);
    return await run;
  }

  /** One generation, on a worker or in this document. `source` is the text the
   *  prompt asked about, used only to find where the answer starts when the
   *  decoded prompt does not match the string we sent. */
  async function generate(prompt: string, maxNewTokens: number, source: string): Promise<string> {
    if (!loadedId || !tokenizer) fail('not-loaded', 'no model is loaded');
    const version = lifecycle;
    try {
      const generated = await generateText(prompt, maxNewTokens);
      requireLifecycle(version);
      generations += 1;
      touchIdleTimer();
      return answerOf(generated, prompt, source).trim();
    } catch (error: unknown) {
      requireLifecycle(version);
      const message = String((error as { message?: unknown })?.message ?? error);
      fail(message.toLowerCase().includes('abort') ? 'generation-timeout' : 'generation-failed', error);
    }
  }

  /** Every marker the chat template writes is a special token, so the decoded
   *  text carries the prompt without them; this strips the same markers from
   *  the prompt we sent. */
  const PROMPT_MARKERS = /<\|[^|]*\|>/g;

  /** The generation alone. The library's own cut needs a prompt length the
   *  tokenizer and the padded batch do not agree on, which leaves the source
   *  sentence in the answer. */
  function answerOf(generated: unknown, prompt: string, source: string): string {
    const text = typeof generated === 'string' ? generated : '';
    if (!text) return '';
    const bare = prompt.replace(PROMPT_MARKERS, '');
    if (bare && text.startsWith(bare)) return text.slice(bare.length);
    // A prompt the decoder renders differently still ends with the text we
    // asked about; anchoring there cannot return text from earlier in the prompt.
    const anchor = source.trim();
    const at = anchor ? text.lastIndexOf(anchor) : -1;
    return at >= 0 ? text.slice(at + anchor.length) : '';
  }

  const SELF_SUFFICIENT_CHARS = 40;

  function usable(answer: string, text: string, target: string): boolean {
    if (!answer || L.isRunaway(answer, text)) return false;
    const lang = P.langFor(target);
    return lang === null || P.checkScript(answer, lang);
  }

  async function translateOne(target: string, text: string, hint: string | null): Promise<string> {
    const plain = renderPrompt(target, text, null);
    const framed = hint === null ? plain : renderPrompt(target, text, hint);
    const leadIsPlain = hint === null || text.length >= SELF_SUFFICIENT_CHARS;
    const lead = leadIsPlain ? plain : framed;
    const cap = L.answerTokens(text, lastMaxTokens, lead);
    const answer = await generate(lead, cap, text);
    if (usable(answer, text, target)) return answer;
    const follow = leadIsPlain ? framed : plain;
    const retry = await generate(follow, L.answerTokens(text, lastMaxTokens, follow), text);
    return usable(retry, text, target) ? retry : '';
  }

  async function translateChunk(target: string, texts: string[], hint: string | null): Promise<string[]> {
    if (texts.length === 1) return [await translateOne(target, texts[0] ?? '', hint)];
    // One numbered prompt for the whole chunk: the segments travel as text inside
    // one sequence, one prefill and one decode, and the model stops at its own
    // end. Batched rows were implemented and measured slower (see the speed
    // section of docs/native-extension-testing.md), so they are not used.
    const batch = texts.map((text, index) => `${index + 1}. ${P.sanitize(text).replace(/\s+/g, ' ').trim()}`).join('\n');
    const prompt = renderPrompt(target, batch, hint);
    const cap = L.answerTokens(texts, lastMaxTokens, prompt);
    const reply = await generate(prompt, cap, batch);
    const parsed = L.parseNumbered(reply, texts.length);
    if (parsed) return parsed.map((answer) => answer.trim());
    AT.warn('on-device split mismatch, retrying per text', texts.length);
    const out: string[] = [];
    for (const text of texts) out.push(await translateOne(target, text, hint));
    return out;
  }

  /** The tokens a prompt string costs in the model's own tokenizer. */
  function promptTokens(prompt: string): number {
    if (!tokenizer) return L.estimateTokens(prompt);
    return Array.from(tokenizer(prompt, { add_special_tokens: false }).input_ids.data as ArrayLike<number | bigint>).length;
  }

  /** The tokens one segment costs inside a prompt: sanitized and byte-expanded
   *  exactly as `renderPrompt` writes it, and counted without specials so the
   *  number is the text's own cost rather than the template's. */
  function tokenCount(text: string): number {
    if (!tokenizer) return L.estimateTokens(text);
    return promptTokens(expandByteFallback(P.sanitize(text)));
  }

  type CountRequest = { modelId?: unknown; maxTokens?: unknown; texts?: unknown; target?: unknown };

  /** Per-text costs and the empty instruction's own cost, so `engines` can pack
   *  a batch against the model's real tokenizer instead of an estimate. */
  async function countNow(request: CountRequest): Promise<AT.local.TokenCounts> {
    const modelId = typeof request.modelId === 'string' ? request.modelId : '';
    if (!modelId) fail('no-model', 'no model is selected');
    const texts = Array.isArray(request.texts)
      ? request.texts.filter((text): text is string => typeof text === 'string').slice(0, 200)
      : [];
    const askedTarget = typeof request.target === 'string' ? request.target : '';
    const target = P.langFor(askedTarget) !== null ? askedTarget : 'ko';
    await ensureLoaded(modelId, Number(request.maxTokens) || L.DEFAULT_MAX_TOKENS, target);
    // The chat template refuses empty content, so the instruction's own cost is
    // read from a one-character text with that character's count removed.
    const MARKER = 'x';
    const overhead = Math.max(0, promptTokens(renderPrompt(target, MARKER, null)) - promptTokens(MARKER));
    return { counts: texts.map((text) => tokenCount(text)), overhead };
  }

  async function translateNow(request: AT.local.TranslateRequest): Promise<AT.local.HostReply> {
    const texts = Array.isArray(request.texts)
      ? request.texts.filter((text): text is string => typeof text === 'string')
      : [];
    const askedTarget = typeof request.target === 'string' ? request.target : '';
    const maxTokens = Number(request.maxTokens) || L.DEFAULT_MAX_TOKENS;
    const hint = typeof request.context === 'string' ? request.context.slice(0, 200) : null;
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
      lastMaxTokens = maxTokens;
      version = await ensureLoaded(modelId, maxTokens, askedTarget);
      requireLifecycle(version);
      const translations = await translateChunk(askedTarget, texts, hint);
      requireLifecycle(version);
      state.state = 'ready';
      publish();
      return { translations };
    } catch (error: unknown) {
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
    await ensureLoaded(modelId, maxTokens, target);
    return state;
  }

  export async function unload(cause = 'requested'): Promise<AT.local.LocalStatus> {
    await teardown(cause);
    return state;
  }

  export async function translate(request: AT.local.TranslateRequest): Promise<AT.local.HostReply> {
    // Not queued: each request is one pool job, and the pool is what keeps a
    // page's N requests finishing in ceil(N / poolSize) request-times rather
    // than N. Loading, unloading and counting still queue (see `handle`).
    return await translateNow(request);
  }

  export async function handle(message: AT.Message): Promise<AT.local.HostReply> {
    switch (message?.type) {
      case C.MSG.LOCAL_TRANSLATE:
        return await translate(message as AT.local.TranslateRequest);
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
        return await enqueue(() => countNow(message as CountRequest));
      case C.MSG.LOCAL_QUERY:
      case C.MSG.LOCAL_STATUS:
        return { status: await status() };
      default:
        return {};
    }
  }
}

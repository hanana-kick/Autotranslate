// The on-device host: every part that touches MediaPipe, written without any
// assumption about where it runs. One instance, one queue, because MediaPipe
// allows a single generation at a time and the model holds gigabytes.
//
// Chrome's service worker cannot hold WebAssembly plus WebGPU, so the
// background puts this module in an offscreen document and talks to it over
// runtime messages. A Firefox background page is a document already, so the
// same module runs in place and the background calls it directly. Both
// placements install a reporter for the status, so the rest of the extension
// sees one shape.
//
// In a document, handle() supervises a dedicated worker. The worker loads the
// SAME host, bundled runtime and OPFS model. Synchronous WASM never runs in the
// extension UI renderer; deadlines and unload remain responsive outside it.
// Load after lib/constants.js, lib/browser.js, lib/local.js and
// lib/modelstore.js; the MediaPipe module itself arrives at runtime.
namespace AT.localhost {
  const C = AT.C;
  const L = AT.local;

  /** The members of @mediapipe/tasks-genai this file touches. */
  type WasmFileset = { wasmLoaderPath: string; wasmBinaryPath: string };

  type GenaiModule = {
    FilesetResolver: { forGenAiTasks: (path: string) => Promise<WasmFileset> };
    LlmInference: {
      createFromOptions: (fileset: WasmFileset, options: Record<string, unknown>) => Promise<LlmInstance>;
    };
  };

  type LlmInstance = {
    generateResponse: (prompt: string, listener?: (partial: string, done: boolean) => void) => Promise<string>;
    /** The model's own tokenizer; the ground truth the chunker only estimates. */
    sizeInTokens?: (query: string) => number | undefined;
    cancelProcessing?: () => void;
    /** The runtime's only disposer (`TaskRunner.close`); nothing else exists. */
    close?: () => void;
    isIdle?: boolean;
  };

  /** at/local-translate as the background sends it. */
  export type TranslateRequest = {
    modelId?: unknown;
    texts?: unknown;
    source?: unknown;
    target?: unknown;
    maxTokens?: unknown;
    /** One line of page context, already rendered and bounded by the engine. */
    context?: unknown;
  };

  /** at/local-load and at/local-unload. */
  type LoadRequest = { modelId?: unknown; maxTokens?: unknown };

  /** at/local-count: how many tokens the model's own tokenizer sees. */
  type CountRequest = {
    modelId?: unknown;
    maxTokens?: unknown;
    texts?: unknown;
    source?: unknown;
    target?: unknown;
    context?: unknown;
  };

  /** The answer at/local-count gives: per-text counts and the instruction. */
  export type TokenCounts = { counts: number[]; overhead: number };

  /** What one host call answers with; `callHost` adds `ok` around it. */
  export type HostReply = {
    status?: AT.local.LocalStatus;
    translations?: string[];
    engine?: string;
    counts?: number[];
    overhead?: number;
  };

  /** Where the host is running, for the status the UI reads. */
  export type Placement = 'offscreen' | 'background';

  let module: GenaiModule | null = null;
  let fileset: WasmFileset | null = null;
  let llm: LlmInstance | null = null;
  type GpuDevice = { destroy: () => void };
  type GpuAdapter = {
    isFallbackAdapter?: boolean;
    info?: { architecture?: string; description?: string };
    features: { has: (feature: string) => boolean };
    limits: { maxBufferSize: number; maxStorageBufferBindingSize: number; maxStorageBuffersPerShaderStage: number };
    requestDevice: (options: Record<string, unknown>) => Promise<GpuDevice>;
  };
  let ownedDevice: GpuDevice | null = null;
  let loadedId: string | null = null;
  let loadedMaxTokens = 0;
  let loadedBytes = 0;
  let loadMs: number | null = null;
  let generations = 0;
  let queue: Promise<unknown> = Promise.resolve();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let loading: Promise<void> | null = null;
  let reporter: ((status: AT.local.LocalStatus) => void) | null = null;

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

  // The worker is a production isolation boundary, not a second inference engine.
  // Unit tests of the native host execute without a document, just as the worker.
  const documentHost = typeof document !== 'undefined';
  let compute: Worker | null = null;
  let workerEpoch = 0;
  let nextRequestId = 0;
  type Pending = {
    id: number;
    resolve: (reply: HostReply) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout> | null;
    deadlinePhase?: string;
    firstOutputTimer?: ReturnType<typeof setTimeout> | null;
  };
  let pending: Pending | null = null;

  function workerError(reason: string, message: string): Error & { reason: string; code: string } {
    return Object.assign(new Error(message), { reason, code: L.codeForReason(reason) });
  }

  function stopCompute(error = workerError('generation-failed', 'model operation cancelled'), invalidate = true): void {
    const previous = compute;
    compute = null;
    if (invalidate) workerEpoch++;
    const active = pending;
    pending = null;
    if (active?.timer) clearTimeout(active.timer);
    if (active?.firstOutputTimer) clearTimeout(active.firstOutputTimer);
    // terminate() does not wait for a blocked native generateResponse()/close().
    previous?.terminate();
    active?.reject(error);
  }

  function computeFailed(reason: string, detail: string): void {
    const phase = state.phase;
    // A cold warmup failure may be retried once by the request supervisor.
    // Explicit unload and all ordinary inference failures still invalidate work.
    stopCompute(workerError(reason, detail), !['warmup-timeout', 'generation-stalled'].includes(reason));
    teardown('worker-failed');
    state.state = 'error';
    state.reason = reason;
    state.lastError = detail.slice(0, 300);
    state.phase = phase ?? null;
    publish();
  }

  function armDeadline(): void {
    if (!pending) return;
    const phase = state.phase;
    const key = `${phase ?? 'worker-start'}:${state.softwareRendering === true}`;
    // A ready hardware graph must produce a first token within a bounded
    // interval. Observe outside the worker: a blocked native call cannot run
    // its own timer. Duplicate status messages must not extend this interval.
    if (phase !== 'generate' || state.softwareRendering || (state.outputChars ?? 0) > 0) {
      if (pending.firstOutputTimer) clearTimeout(pending.firstOutputTimer);
      pending.firstOutputTimer = null;
    } else if (!pending.firstOutputTimer) {
      pending.firstOutputTimer = setTimeout(() => computeFailed('generation-stalled',
        'native generation produced no output within ' + L.FIRST_OUTPUT_TIMEOUT_MS + ' ms; inference worker terminated'), L.FIRST_OUTPUT_TIMEOUT_MS);
    }
    // Progress/status updates must not renew the absolute deadline of a phase.
    if (pending.deadlinePhase === key) return;
    pending.deadlinePhase = key;
    if (pending.timer) clearTimeout(pending.timer);
    const generation = phase === 'generate' || phase === 'warmup';
    const ms = generation ? generationTimeout() : L.MODEL_LOAD_TIMEOUT_MS;
    pending.timer = setTimeout(() => computeFailed(
      phase === 'warmup' ? 'warmup-timeout' : generation ? 'generation-timeout' : 'model-load-failed',
      "native " + (phase ?? "worker-start") + " timed out after " + ms + " ms; inference worker terminated"
    ), ms);
  }

  function workerCall(message: AT.Message): Promise<HostReply> {
    if (!compute) {
      if (typeof Worker === 'undefined') fail('runtime-load-failed', 'dedicated workers are unavailable');
      const generationBase = generations;
      const worker = new Worker(AT.getURL('inference-worker.js'), { name: 'autotranslate-inference' });
      compute = worker;
      worker.onmessage = (event: MessageEvent) => {
        if (compute !== worker) return; // a terminated session cannot publish late replies
        const data = event.data as { kind?: string; status?: AT.local.LocalStatus; id?: number;
          reply?: HostReply; error?: { message?: string; reason?: string } };
        if (data.kind === 'status' && data.status) {
          const reported = L.normalizeStatus(data.status);
          Object.assign(state, reported, { generations: generationBase + reported.generations });
          loadedBytes = state.loadedBytes;
          loadMs = state.loadMs;
          generations = state.generations;
          publish();
          // Invalid streamed output can be reported while the native graph is
          // still running. Its owner can terminate it without entering close().
          if (state.reason === 'invalid-output' || state.reason === 'warmup-timeout') {
            stopCompute(workerError(state.reason, state.lastError ?? 'invalid native session'), false);
            return;
          }
          // Only the worker's real stage transitions renew the deadline. UI
          // status polling never sends work to the compute queue.
          armDeadline();
          return;
        }
        if (data.kind !== 'reply' || !pending || data.id !== pending.id) return;
        const active = pending;
        pending = null;
        if (active.timer) clearTimeout(active.timer);
        if (active.firstOutputTimer) clearTimeout(active.firstOutputTimer);
        if (data.error) active.reject(workerError(data.error.reason ?? 'generation-failed', data.error.message ?? 'worker failed'));
        else active.resolve(data.reply ?? {});
      };
      worker.onerror = (event: ErrorEvent) => {
        event.preventDefault();
        if (compute === worker) computeFailed('runtime-load-failed', event.message || 'inference worker crashed');
      };
      worker.onmessageerror = () => {
        if (compute === worker) computeFailed('runtime-load-failed', 'invalid inference worker response');
      };
    }
    return new Promise<HostReply>((resolve, reject) => {
      const id = ++nextRequestId;
      pending = { id, resolve, reject, timer: null };
      armDeadline();
      try { compute!.postMessage({ id, placement: state.target, message }); }
      catch (error) { computeFailed('runtime-load-failed', String((error as Error)?.message ?? error)); }
    });
  }

  function generationTimeout(): number {
    if (state.softwareRendering) return L.SOFTWARE_GENERATION_TIMEOUT_MS;
    // The first generation also compiles/tunes kernels; it is startup work,
    // not the steady-state inference deadline. Both remain strictly bounded.
    return state.phase === 'warmup'
      ? Math.max(L.MODEL_LOAD_TIMEOUT_MS, L.GENERATION_TIMEOUT_MS)
      : L.GENERATION_TIMEOUT_MS;
  }

  function setPhase(phase: AT.local.ModelPhase | null): void {
    if (phase === 'generate' || phase === 'warmup') {
      state.outputChars = 0;
      state.lastProgressAt = 0;
    }
    state.phase = phase;
    publish();
  }

  /** The one thing a placement supplies: where a status change goes. */
  export function install(place: Placement, report: (status: AT.local.LocalStatus) => void): AT.local.LocalStatus {
    state.target = place;
    reporter = report;
    return state;
  }

  function publish(): void {
    state.loadedBytes = loadedBytes;
    state.loadMs = loadMs;
    state.generations = generations;
    AT.log('on-device host', state.target, state.state, state.modelId, state.reason);
    reporter?.(state);
  }

  function fail(reason: string, detail: unknown): never {
    state.state = 'error';
    state.reason = reason;
    state.lastError = String((detail as { message?: unknown })?.message ?? detail ?? reason).slice(0, 300);
    publish();
    // `code` is what the caller turns into an engine error, and the engine
    // layer decides on retry and messaging from it.
    const error = new Error(state.lastError) as Error & { reason: string; code: string };
    error.reason = reason;
    error.code = L.codeForReason(reason);
    throw error;
  }

  /** Runs one job after everything queued before it. */
  function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = queue.then(job, job);
    queue = run.catch(() => undefined);
    return run;
  }

  function touchIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer);
    if (!llm) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      teardown('idle');
    }, L.IDLE_UNLOAD_MS);
  }

  function teardown(cause: string): void {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (llm) {
      try {
        llm.cancelProcessing?.();
      } catch {
        // A dead runtime cannot cancel; nothing to recover.
      }
      try {
        // `close()` frees the wasm graph; without it the weights stay allocated
        // and the next load stacks a second model on top of the first.
        llm.close?.();
      } catch {
        // A dead runtime has nothing left to free.
      }
    }
    llm = null;
    ownedDevice?.destroy();
    ownedDevice = null;
    loadedId = null;
    loadedMaxTokens = 0;
    loadedBytes = 0;
    loadMs = null;
    loading = null;
    state.state = 'unloaded';
    state.phase = null;
    state.modelId = null;
    state.modelName = null;
    // A reason belongs to a state, not to the host: the next load starts with
    // a clean sheet even when the previous one ended in a failure.
    state.reason = null;
    AT.log('on-device host unloaded model', cause);
    publish();
  }

  /** WebGPU is required: a 4B int8 model on CPU is not a usable experience. */
  async function checkSupport(): Promise<void> {
    if (state.supported) return;
    const gpu = (globalThis.navigator as { gpu?: { requestAdapter?: () => Promise<unknown> } } | undefined)?.gpu;
    if (!gpu?.requestAdapter) fail('no-webgpu', 'WebGPU is not available');
    const adapter = await gpu.requestAdapter();
    if (!adapter) fail('no-webgpu', 'no WebGPU adapter was found');
    const actual = adapter as { isFallbackAdapter?: boolean; info?: { architecture?: string; description?: string } };
    state.softwareRendering = actual.isFallbackAdapter === true ||
      /swiftshader|llvmpipe|lavapipe/i.test(`${actual.info?.architecture ?? ''} ${actual.info?.description ?? ''}`);
    state.supported = true;
    state.reason = null;
    // A probe that failed once must not keep the host reporting an error for the
    // rest of the session: the next successful probe clears it.
    if (state.state === 'error') {
      state.state = 'unloaded';
      state.lastError = null;
      publish();
    }
  }

  async function loadRuntime(): Promise<GenaiModule> {
    if (module && fileset) return module;
    await checkSupport();
    let imported: unknown;
    try {
      const url = AT.getURL(L.VENDOR.bundle);
      // A static import cannot work here: the project compiles to classic
      // scripts (`module: none`), while the vendored MediaPipe build is an ES
      // module whose specifier is only known through runtime.getURL().
      imported = await import(url);
    } catch (error: unknown) {
      fail('runtime-load-failed', error);
    }
    const candidate = imported as Partial<GenaiModule> | undefined;
    if (!candidate?.FilesetResolver?.forGenAiTasks || !candidate.LlmInference) {
      fail('runtime-load-failed', 'the bundled MediaPipe module is incomplete');
    }
    module = candidate as GenaiModule;
    try {
      fileset = await module.FilesetResolver.forGenAiTasks(AT.getURL(L.VENDOR.wasmDir));
    } catch (error: unknown) {
      module = null;
      fail('runtime-load-failed', error);
    }
    return module;
  }

  /** First generation on a freshly loaded model is ~8x slower; pay it here. */
  async function warmup(instance: LlmInstance): Promise<void> {
    const answer = await boundedResponse(instance, L.wrapChatPrompt('Translate to Korean: Good morning.'), 'Good morning.');
    if (!answer.trim()) throw new Error('model warmup returned an empty answer');
  }

  /** Software WebGPU uses portable kernels rather than GPU subgroup kernels.
   * The SDK and model are unchanged; this is its public gpuOptions.device API. */
  async function softwareGpuOptions(): Promise<Record<string, unknown>> {
    if (!state.softwareRendering) return {};
    const gpu = (globalThis.navigator as unknown as {
      gpu: { requestAdapter: (options: Record<string, unknown>) => Promise<GpuAdapter | null> }
    }).gpu;
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) fail('no-webgpu', 'the inference adapter is no longer available');
    const software = adapter.isFallbackAdapter === true ||
      /swiftshader|llvmpipe|lavapipe/i.test(
        String(adapter.info?.architecture ?? '') + ' ' + String(adapter.info?.description ?? ''));
    state.softwareRendering = software;
    if (!software) return {}; // Keep the original SDK's hardware selection.
    const requiredFeatures = adapter.features.has('shader-f16') ? ['shader-f16'] : [];
    ownedDevice = await adapter.requestDevice({
      requiredFeatures,
      requiredLimits: {
        maxBufferSize: adapter.limits.maxBufferSize,
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        maxStorageBuffersPerShaderStage: adapter.limits.maxStorageBuffersPerShaderStage
      }
    });
    AT.log('software WebGPU device enabled features', requiredFeatures);
    return { gpuOptions: { device: ownedDevice, adapterInfo: adapter.info } };
  }

  async function instantiate(record: AT.modelstore.ModelRecord, maxTokens: number): Promise<LlmInstance> {
    const active = module as GenaiModule;
    const assets = fileset as WasmFileset;
    setPhase('model-read');
    const blob = await AT.modelstore.read(record.id);
    if (!blob) fail('model-missing', `no stored file for model ${record.id}`);
    const options = (baseOptions: Record<string, unknown>): Record<string, unknown> => ({
      baseOptions,
      // maxTokens covers input plus output, so the chunker budgets both.
      maxTokens: Math.max(L.MIN_MAX_TOKENS, Math.min(maxTokens, L.MAX_MAX_TOKENS)),
      topK: 1,
      // topK=1 already selects the single highest-ranked token. Keep the
      // logit scaling finite instead of relying on a native zero-temperature
      // special case; the locked SDK and greedy selection remain unchanged.
      temperature: 1,
      randomSeed: 42,
      numResponses: 1
    });
    // The stored file is streamed into the runtime: a 3.6 GiB model must not
    // be copied into the JS heap, and reading it by URL would fetch it again.
    setPhase('model-create');
    return await active.LlmInference.createFromOptions(
      assets,
      options({ modelAssetBuffer: blob.stream().getReader(), ...await softwareGpuOptions() })
    );
  }

  async function ensureLoaded(modelId: string, maxTokens: number): Promise<void> {
    const budget = Number.isFinite(maxTokens)
      ? Math.max(L.MIN_MAX_TOKENS, Math.min(Math.round(maxTokens), L.MAX_MAX_TOKENS))
      : L.DEFAULT_MAX_TOKENS;
    if (llm && loadedId === modelId && loadedMaxTokens === budget) {
      touchIdleTimer();
      return;
    }
    if (loading) {
      await loading;
      if (llm && loadedId === modelId && loadedMaxTokens === budget) return;
    }
    // Whether this browser can run a model at all is the more fundamental
    // answer, and reading the store first would mask it behind a store error.
    await checkSupport();
    const record = await AT.modelstore.get(modelId);
    if (!record) fail('model-missing', `model ${modelId} is not stored`);
    state.state = 'loading';
    state.modelId = record.id;
    state.modelName = record.name;
    state.lastError = null;
    publish();
    const started = Date.now();
    loading = (async () => {
      setPhase('runtime');
      await loadRuntime();
      if (llm) teardown('switch');
      const instance = await instantiate(record as AT.modelstore.ModelRecord, budget);
      // Own the instance before warming it, so a failed verification also frees
      // its allocated weights. Readiness means inference succeeded, not just load.
      llm = instance;
      setPhase('warmup');
      await warmup(instance);
      setPhase(null);
      loadedId = record.id;
      loadedMaxTokens = budget;
      loadedBytes = record.size;
      loadMs = Date.now() - started;
      state.state = 'ready';
      state.modelId = record.id;
      state.modelName = record.name;
      state.lastError = null;
      state.reason = null;
    })();
    try {
      await loading;
    } catch (error: unknown) {
      // Keep the specific reason the loader failed with: `model-load-failed`
      // would hide whether WebGPU, the runtime or the file was at fault.
      const reason = (error as { reason?: string })?.reason ?? 'model-load-failed';
      if (reason === 'invalid-output') fail(reason, error);
      teardown('load-failed');
      fail(reason, error);
    } finally {
      loading = null;
    }
    touchIdleTimer();
    publish();
  }

  /** Tokens as the model's tokenizer counts them; the estimate only stands in
   *  when the runtime exposes no tokenizer. */
  function tokenCount(text: string): number {
    const counted = llm?.sizeInTokens?.(text);
    return typeof counted === 'number' && Number.isFinite(counted) && counted >= 0
      ? Math.round(counted)
      : L.estimateTokens(text);
  }

  /** Includes warmup: no generation may hold the queue without a deadline. */
  function boundedResponse(instance: LlmInstance, prompt: string, source: string): Promise<string> {
    // Idle eviction measures quiet time, never the duration of active native work.
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    return new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => reject(workerError(
        state.phase === 'warmup' ? 'warmup-timeout' : 'generation-timeout',
        state.phase === 'warmup' ? 'model warmup timeout' : 'generation timeout'
      )), generationTimeout());
      let lastPublished = 0, streamed = '';
      instance.generateResponse(prompt, (partial, done) => {
        // Only counts/timestamps cross the worker boundary, never page content.
        if (partial) {
          streamed += partial;
          const issue = AT.outputIssue(source, streamed, true);
          if (issue) {
            const controls = [...new Set(streamed.match(/<(?:pad|bos|eos|start_of_turn|end_of_turn)>|<\|(?:endoftext|im_start|im_end)\|>/g) ?? [])];
            const error = workerError('invalid-output', 'invalid model output: ' + issue +
              (controls.length ? ' [' + controls.join(',') + ']' : ''));
            state.state = 'error'; state.reason = 'invalid-output'; state.lastError = error.message;
            publish(); reject(error); return;
          }
          state.outputChars = Math.min((state.outputChars ?? 0) + partial.length, 1_000_000);
          state.lastProgressAt = Date.now();
        }
        if (done || Date.now() - lastPublished >= 1000) {
          lastPublished = Date.now();
          publish();
        }
      }).then((answer) => {
        const issue = AT.outputIssue(source, answer);
        if (issue) reject(workerError('invalid-output', 'invalid model output: ' + issue));
        else resolve(answer);
      }, reject);
    }).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  /** A timed-out promise does not mean the native runtime has stopped. */
  async function generate(prompt: string, source: string): Promise<string> {
    const instance = llm;
    if (!instance) fail('no-model', 'no model is loaded');
    try {
      setPhase('generate');
      const reply = await boundedResponse(instance, prompt, source);
      setPhase(null);
      generations += 1;
      touchIdleTimer();
      return reply;
    } catch (error: unknown) {
      try {
        instance.cancelProcessing?.();
      } catch {
        // cancellation is best-effort
      }
      const message = String((error as { message?: unknown })?.message ?? error);
      if ((error as { reason?: string }).reason === 'invalid-output') fail('invalid-output', error);
      // Never reuse the possibly still-busy graph after rejection or timeout.
      // The next queued request has to create a fresh, verified instance.
      teardown('generation-failed');
      fail(message.includes('timeout') ? 'generation-timeout' : 'generation-failed', error);
    }
  }

  /** One generation for a group of texts, retreating to one text per
   *  generation when the numbered reply cannot be split back reliably. */
  /**
   * Does this prompt fit the context the model was created with? The chunker
   * only estimates — one number cannot cover every script — so the finished
   * prompt is measured with the model's own tokenizer, leaving room for the
   * answer. When no tokenizer is exposed, the estimate is all there is.
   */
  function fits(prompt: string, texts: string[]): boolean {
    const count = tokenCount(prompt);
    const answer = texts.reduce((sum, text) => sum + L.estimateTokens(text), 0);
    return count + answer <= loadedMaxTokens;
  }

  async function translateChunk(
    source: AT.gemma.GemmaLang | null,
    target: AT.gemma.GemmaLang,
    texts: string[],
    hint: string | null
  ): Promise<string[]> {
    // Context only travels in the numbered batch prompt: measured, the
    // single-text shape answers with the context line translated instead of the
    // text, and the auto shape has no room for metadata at all.
    const batch = state.softwareRendering && texts.length === 1
  ? L.wrapChatPrompt('Translate ' + (source ? AT.gemma.nameOf(source) + ' (' + source + ')' : 'the text') + ' to ' + AT.gemma.nameOf(target) + ' (' + target + '). Output only the translation.\n\n' + texts[0])
  : L.buildBatchPrompt(source, target, texts, texts.length > 1 ? hint : null);
    if (!fits(batch, texts)) {
      if (texts.length === 1) {
        fail('context-overflow', 'a single translation segment exceeds the model context budget; split it or raise the token limit');
      }
      // Halve the batch and pay for a second generation rather than let the
      // model silently drop the end of the prompt.
      const middle = Math.ceil(texts.length / 2);
      AT.log('on-device prompt over the context, splitting', texts.length, middle);
      const head = await translateChunk(source, target, texts.slice(0, middle), hint);
      const tail = await translateChunk(source, target, texts.slice(middle), hint);
      return [...head, ...tail];
    }
    const reply = await generate(batch, texts.join('\n'));
    if (texts.length === 1) return [reply.trim()];
    const parsed = L.parseNumbered(reply, texts.length);
    if (parsed) return parsed;
    AT.warn('on-device split mismatch, retrying per text', texts.length);
    const out: string[] = [];
    for (const text of texts) {
      const single = await translateChunk(source, target, [text], null);
      out.push(single[0] ?? '');
    }
    return out;
  }

  /** Keeps the model warm and answers what the UI asks about it. Never throws:
   *  "this browser cannot run the model" is a status, not an exception. */
  export async function status(): Promise<AT.local.LocalStatus> {
    try {
      await checkSupport();
    } catch {
      // checkSupport recorded the reason before it threw.
    }
    publish();
    return state;
  }

  export async function load(modelId: string, maxTokens: number): Promise<AT.local.LocalStatus> {
    await ensureLoaded(modelId, maxTokens);
    return state;
  }

  export function unload(cause = 'requested'): AT.local.LocalStatus {
    if (documentHost) stopCompute();
    teardown(cause);
    return state;
  }

  export async function translate(request: TranslateRequest): Promise<HostReply> {
    return await enqueue(() => translateNow(request));
  }

  async function translateNow(request: TranslateRequest): Promise<HostReply> {
    const texts = Array.isArray(request.texts)
      ? request.texts.filter((text): text is string => typeof text === 'string')
      : [];
    const askedSource = typeof request.source === 'string' ? request.source : '';
    const askedTarget = typeof request.target === 'string' ? request.target : '';
    const maxTokens = Number(request.maxTokens) || L.DEFAULT_MAX_TOKENS;
    const hint = typeof request.context === 'string' ? request.context.slice(0, 200) : null;
    if (texts.length === 0) return { translations: [], engine: 'local' };
    // The message boundary is untrusted: only a code from the model's own table
    // may reach a prompt, and only a known one may claim to be the source.
    if (!AT.gemma.isLang(askedTarget)) fail('no-target', `the model has no code for ${askedTarget || 'that target'}`);
    const target = askedTarget;
    const source = AT.gemma.isLang(askedSource) ? askedSource : null;
    const modelId = typeof request.modelId === 'string' && request.modelId ? request.modelId : '';
    if (!modelId) fail('no-model', 'no model is selected');

    state.state = 'busy';
    publish();
    try {
      await ensureLoaded(modelId, maxTokens);
      state.state = 'busy';
      publish();
      const translations = await translateChunk(source, target, texts, hint);
      state.state = 'ready';
      state.reason = null;
      state.lastError = null;
      publish();
      return { translations, engine: 'local' };
    } catch (error: unknown) {
      const reason = (error as { reason?: string })?.reason ?? 'generation-failed';
      fail(reason, error);
    }
  }

  /** One entry point for both placements: the offscreen document's message
   *  handlers and the background's direct calls dispatch through here. */
  export async function handle(message: AT.Message): Promise<HostReply> {
    if (documentHost) {
      if (message.type === C.MSG.LOCAL_QUERY || message.type === C.MSG.LOCAL_STATUS) return { status: await status() };
      // Control-plane cancellation must never queue behind native computation.
      if (message.type === C.MSG.LOCAL_UNLOAD) return { status: unload('requested') };
      if (![C.MSG.LOCAL_TRANSLATE, C.MSG.LOCAL_LOAD, C.MSG.LOCAL_COUNT].includes(message.type)) return {};
      const epoch = workerEpoch;
      return enqueue(async () => {
        if (epoch !== workerEpoch) throw workerError('generation-failed', 'obsolete worker session');
        await checkSupport();
        try {
          return await workerCall(message);
        } catch (error) {
          const reason = (error as { reason?: string }).reason;
          if (!['invalid-output', 'warmup-timeout', 'generation-stalled'].includes(reason ?? '') || epoch !== workerEpoch) throw error;
          // Exactly one recovery per request, shared by corrupt output and cold
          // warmup failure or missing first output. Ordinary total-generation
          // timeouts are final; no request can recover more than once.
          // The model, SDK, prompt and GPU policy remain unchanged.
          stopCompute(workerError(reason!, 'discard failed native session'), false);
          teardown('native-session-retry');
          state.recoveries = (state.recoveries ?? 0) + 1;
          publish();
          AT.warn('native session failed; retrying once with a fresh inference worker', reason);
          return await workerCall(message);
        }
      });
    }
    switch (message?.type) {
      case C.MSG.LOCAL_TRANSLATE:
        return await translate(message as TranslateRequest);
      case C.MSG.LOCAL_LOAD: {
        const request = message as LoadRequest;
        const modelId = typeof request.modelId === 'string' ? request.modelId : '';
        if (!modelId) fail('no-model', 'no model is selected');
        return { status: await enqueue(() => load(modelId, Number(request.maxTokens) || L.DEFAULT_MAX_TOKENS)) };
      }
      case C.MSG.LOCAL_UNLOAD:
        return await enqueue(async () => ({ status: unload('requested') }));
      case C.MSG.LOCAL_COUNT: {
        // Counting uses the same tokenizer as generation, so it queues like one.
        const request = message as CountRequest;
        return await enqueue(() => countNow(request));
      }
      case C.MSG.LOCAL_QUERY:
      case C.MSG.LOCAL_STATUS:
        return { status: await status() };
      default:
        return {};
    }
  }

  async function countNow(request: CountRequest): Promise<HostReply> {
    const modelId = typeof request.modelId === 'string' ? request.modelId : '';
    if (!modelId) fail('no-model', 'no model is selected');
    const texts = Array.isArray(request.texts)
      ? request.texts.filter((text): text is string => typeof text === 'string').slice(0, 200)
      : [];
    // Counting needs the tokenizer, and the tokenizer arrives with the model.
    await ensureLoaded(modelId, Number(request.maxTokens) || L.DEFAULT_MAX_TOKENS);
    const target = AT.gemma.isLang(request.target) ? request.target : 'en';
    const source = AT.gemma.isLang(request.source) ? request.source : null;
    // The measured cost of the instruction without any text, for packing.
    const empty = source ? L.buildTranslatePrompt(source, target, '') : L.buildAutoPrompt(target, '');
    setPhase('count');
    const result = { counts: texts.map((text) => tokenCount(text)), overhead: tokenCount(empty) };
    setPhase(null);
    return result;
  }
}

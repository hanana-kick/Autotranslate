// The on-device host: every part that touches the inference runtime, written
// without any assumption about where it runs. One instance, one queue, because
// llama.cpp allows a single generation at a time and the model holds
// gigabytes.
//
// Chrome's service worker cannot hold WebAssembly plus WebGPU, so the
// background puts this module in an offscreen document and talks to it over
// runtime messages. A Firefox background page is a document already, so the
// same module runs in place and the background calls it directly. Both
// placements install a reporter for the status, so the rest of the extension
// sees one shape.
//
// The runtime is @wllama/wllama: llama.cpp compiled to WASM, with the WebGPU
// backend for the tensors. The model is a GGUF file read straight out of OPFS.
// Load after lib/constants.js, lib/browser.js, lib/local.js and
// lib/modelstore.js; the runtime module itself arrives at runtime.
namespace AT.localhost {
  const C = AT.C;
  const L = AT.local;

  /** The members of @wllama/wllama this file touches. */
  type WllamaInstance = {
    loadModel(blobs: Blob[], params?: Record<string, unknown>): Promise<void>;
    createChatCompletion(options: Record<string, unknown>): Promise<ChatResult>;
    createCompletion(options: Record<string, unknown>): Promise<ChatResult>;
    isModelLoaded(): boolean;
    isSupportWebGPU(): boolean;
    getChatTemplate(): string | null;
    getLoadedContextInfo(): LoadedContext | undefined;
    exit(): Promise<void>;
  };

  type WllamaModule = {
    Wllama: new (paths: Record<string, string>, config?: Record<string, unknown>) => WllamaInstance;
    LoggerWithoutDebug?: Record<string, unknown>;
  };

  type LoadedContext = { n_ctx?: number; n_ctx_train?: number };

  /** What the completion API answers with. */
  type ChatResult = {
    choices?: {
      text?: string | null;
      finish_reason?: string | null;
    }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  /** at/local-translate as the background sends it. */
  export type TranslateRequest = {
    modelId?: unknown;
    texts?: unknown;
    target?: unknown;
    maxTokens?: unknown;
    /** One line of page context, already rendered and bounded by the engine. */
    context?: unknown;
  };

  /** at/local-load and at/local-unload. */
  type LoadRequest = { modelId?: unknown; target?: unknown; maxTokens?: unknown };

  /** What one host call answers with; `callHost` adds `ok` around it. */
  export type HostReply = {
    status?: AT.local.LocalStatus;
    translations?: string[];
  };

  /** Where the host is running, for the status the UI reads. */
  export type Placement = 'offscreen' | 'background';

  /** The seam a test replaces: where the runtime's ES module comes from.
   *  Production leaves it undefined and gets the vendored build; a suite hands
   *  in an object shaped like it, whose `Wllama` never touches WASM. */
  type Seams = {
    loadModule?: (url: string) => Promise<unknown>;
  };

  let seams: Seams = {};
  let module: WllamaModule | null = null;
  let llm: WllamaInstance | null = null;
  let loadedId: string | null = null;
  let loadedContext = 0;
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
    calibration: null,
    lastError: null
  };

  export function configure(patch: Seams): void {
    seams = { ...seams, ...patch };
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
      void teardown('idle');
    }, L.IDLE_UNLOAD_MS);
  }

  async function teardown(cause: string): Promise<void> {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    const instance = llm;
    llm = null;
    loadedId = null;
    loadedContext = 0;
    loadedBytes = 0;
    loadMs = null;
    loading = null;
    if (instance) {
      try {
        // `exit()` frees the WASM graph and the GPU buffers; without it the
        // weights stay allocated and the next load stacks a second model on
        // top of the first.
        await instance.exit();
      } catch {
        // A dead runtime has nothing left to free.
      }
    }
    state.state = 'unloaded';
    state.modelId = null;
    state.modelName = null;
    // A reason belongs to a state, not to the host: the next load starts with
    // a clean sheet even when the previous one ended in a failure.
    state.reason = null;
    AT.log('on-device host unloaded model', cause);
    publish();
  }

  /** WebGPU is required: a gigabyte-class model decoding on CPU is not a usable
   *  experience, and the user should learn that before downloading a model. */
  async function checkSupport(): Promise<void> {
    if (state.supported) return;
    const gpu = (globalThis.navigator as { gpu?: { requestAdapter?: () => Promise<unknown> } } | undefined)?.gpu;
    if (!gpu?.requestAdapter) fail('no-webgpu', 'WebGPU is not available');
    const adapter = await gpu.requestAdapter();
    if (!adapter) fail('no-webgpu', 'no WebGPU adapter was found');
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

  async function loadRuntime(): Promise<WllamaModule> {
    if (module) return module;
    await checkSupport();
    let imported: unknown;
    const url = AT.getURL(L.VENDOR.module);
    try {
      // A static import cannot work here: the project compiles to classic
      // scripts (`module: none`), while the vendored runtime is an ES module
      // whose specifier is only known through runtime.getURL().
      imported = seams.loadModule ? await seams.loadModule(url) : await import(url);
    } catch (error: unknown) {
      fail('runtime-load-failed', error);
    }
    const shape = imported as Partial<WllamaModule> | undefined;
    if (typeof shape?.Wllama !== 'function') {
      fail('runtime-load-failed', 'the bundled on-device runtime is incomplete');
    }
    // The check above proves the one member this file constructs. The rest of
    // the surface is declared structurally here because a classic script
    // cannot import the package's own types.
    module = shape as WllamaModule;
    return module;
  }

  function createInstance(): WllamaInstance {
    const active = module as WllamaModule;
    const paths = { default: AT.getURL(L.VENDOR.wasm) };
    const config: Record<string, unknown> = { suppressNativeLog: true };
    if (active.LoggerWithoutDebug) config.logger = active.LoggerWithoutDebug;
    return new active.Wllama(paths, config);
  }

  /** First generation on a freshly loaded model is several times slower; pay
   *  it here, in the language the page is about to be translated into. */
  async function warmup(instance: WllamaInstance, target: string): Promise<void> {
    const prompt = L.buildEnginePrompt(target, 'Good morning.');
    try {
      await generate(instance, prompt, L.SAMPLING, L.MIN_OUTPUT_TOKENS);
    } catch (error: unknown) {
      AT.warn('on-device warmup failed', error);
    }
  }

  async function instantiate(record: AT.modelstore.ModelRecord, maxTokens: number): Promise<WllamaInstance> {
    const instance = createInstance();
    try {
      const blob = await AT.modelstore.read(record.id);
      if (!blob) fail('model-missing', `no stored file for model ${record.id}`);
      const nCtx = L.contextTokens(maxTokens);
      // The stored file is handed over as a Blob: a gigabyte of weights must not
      // be copied into the JS heap, and reading it by URL would fetch it again.
      // The chat template is pinned rather than taken from the converted file:
      // the PFML3 prompt `AT.plamo3` builds is the prompt, byte for byte,
      // because the jinja the file carries cannot be compiled by the runtime's
      // template engine at all (`Unable to generate parser for this template`),
      // and a template that cannot render must not stand between the model and
      // the text it was asked about.
      await instance.loadModel([blob as Blob], {
        n_ctx: nCtx,
        n_batch: Math.min(512, nCtx),
        n_ubatch: Math.min(512, nCtx),
        n_gpu_layers: -1,
        // A browser extension page is not cross-origin isolated, so the
        // multi-threaded build has no SharedArrayBuffer to work with.
        n_threads: 1,
        flash_attn: true,
        chat_template: AT.plamo3.PASS_THROUGH_TEMPLATE
      });
      if (!instance.isModelLoaded()) fail('model-load-failed', `the runtime did not load ${record.name}`);
      if (instance.isSupportWebGPU && !instance.isSupportWebGPU()) {
        fail('no-webgpu', 'the runtime could not open a WebGPU device');
      }
      const context = instance.getLoadedContextInfo?.();
      loadedContext = Number(context?.n_ctx) > 0 ? Number(context?.n_ctx) : nCtx;
      return instance;
    } catch (error: unknown) {
      // A runtime that failed halfway still holds its WASM heap and whatever the
      // GPU backend mapped, and this is the only place holding the handle.
      try {
        await instance.exit();
      } catch {
        // A runtime that died during load has nothing left to free.
      }
      throw error;
    }
  }

  async function ensureLoaded(
    modelId: string,
    maxTokens: number,
    target: string
  ): Promise<WllamaInstance> {
    if (llm && loadedId === modelId) {
      // The same file is still in memory, and the language still has to be one
      // it was released with, warm or not: a prompt would name a language it
      // never learned.
      requireTarget(target);
      touchIdleTimer();
      return llm;
    }
    if (loading) {
      await loading;
      if (llm && loadedId === modelId) {
        requireTarget(target);
        return llm;
      }
    }
    // Whether this browser can run a model at all is the more fundamental
    // answer, and reading the store first would mask it behind a store error.
    await checkSupport();
    const record = await AT.modelstore.get(modelId);
    if (!record) fail('model-missing', `model ${modelId} is not stored`);
    // A target the installed model was not released with is a configuration
    // problem, not a generation that might answer on a retry: the prompt would
    // name a language the weights never learned.
    requireTarget(target);
    state.state = 'loading';
    state.modelId = record.id;
    state.modelName = record.name;
    state.lastError = null;
    publish();
    const started = Date.now();
    loading = (async () => {
      await loadRuntime();
      if (llm) await teardown('switch');
      const instance = await instantiate(record, maxTokens);
      await warmup(instance, target);
      llm = instance;
      loadedId = record.id;
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
      await teardown('load-failed');
      fail(reason, error);
    } finally {
      loading = null;
    }
    const ready = llm;
    if (!ready) fail('model-load-failed', 'the runtime did not keep the model loaded');
    touchIdleTimer();
    publish();
    return ready;
  }

  /**
   * One generation, bounded and cancellable: the abort signal reaches the
   * runtime's own decode loop, so a timed-out generation is really over rather
   * than left running while the next one queues behind it.
   *
   * PLaMo is asked as a raw completion: its PFML3 prompt is made of
   * special-token elements that are the prompt itself, so anything that renders
   * it - a chat template, a role - would corrupt it, and its two end tokens are
   * special ids the sampler never emits on its own, which is why they go to the
   * runtime as stop sequences.
   */
  async function generate(
    instance: WllamaInstance,
    prompt: string,
    sampling: Record<string, unknown>,
    maxTokens: number
  ): Promise<string> {
    const controller = new AbortController();
    const { promise, resolve, reject } = Promise.withResolvers<ChatResult>();
    const options: Record<string, unknown> = {
      stream: false,
      max_tokens: maxTokens,
      cache_prompt: true,
      abortSignal: controller.signal,
      temp: sampling.temp,
      top_p: sampling.topP,
      top_k: sampling.topK,
      penalty_repeat: sampling.repeatPenalty,
      seed: sampling.seed
    };
    options.prompt = prompt;
    options.stop = [...AT.plamo3.STOP_TOKENS];
    const timer = setTimeout(() => {
      // Aborting is what actually stops the decode loop; the timer only
      // decides when a generation that stopped answering counts as lost.
      controller.abort();
      reject(new Error('generation timeout'));
    }, L.GENERATION_TIMEOUT_MS);
    const ask = instance.createCompletion(options);
    ask.then(resolve, reject);
    try {
      const result = await promise;
      const choice = result?.choices?.[0];
      const raw = choice?.text;
      const reply = typeof raw === 'string' ? raw : '';
      // The runtime counted the prompt with the model's own tokenizer; fold the
      // measured/estimated ratio into the packer so the next chunk is planned
      // against what this model really costs, not against the published prior.
      const measured = Number(result?.usage?.prompt_tokens);
      const estimated = L.rawEstimateTokens(prompt);
      if (Number.isFinite(measured) && measured > 0 && estimated > 0) {
        const ratio = measured / estimated;
        L.setCalibration(state.calibration ? (state.calibration + ratio) / 2 : ratio);
        state.calibration = L.calibrationValue();
      }
      generations += 1;
      touchIdleTimer();
      return reply;
    } catch (error: unknown) {
      const message = String((error as { message?: unknown })?.message ?? error);
      fail(message.toLowerCase().includes('timeout') ? 'generation-timeout' : 'generation-failed', error);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Refuse a language the installed model has no code for. The settings page
   *  offers en, ko and ja, every one of which PLaMo was released with, so this
   *  is the last gate before a prompt names a language the weights never
   *  learned; it answers as a configuration failure, not a generation to retry. */
  function requireTarget(target: string): void {
    if (AT.plamo3.langFor(target) === null) {
      fail('no-target', `the installed model has no language for ${target || 'that target'}`);
    }
  }

  /**
   * Does this prompt fit the context the model was loaded with? The packer
   * only estimates — one ratio cannot cover every script — so the finished
   * prompt is measured against the same budget, leaving room for the answer.
   */
  function fits(prompt: string, texts: string[]): boolean {
    const budget = loadedContext > 0 ? loadedContext : L.contextTokens(L.DEFAULT_MAX_TOKENS);
    const used =
      L.estimateTokens(prompt) + texts.reduce((sum, text) => sum + L.estimateTokens(text), 0);
    return used <= budget;
  }

  /** The budget the loaded model was asked to hold, kept for the answer's own
   *  share of that context. */
  let lastMaxTokens = L.DEFAULT_MAX_TOKENS;

  /**
   * Text this long carries its own situation, so the card's background block
   * buys nothing for it - and costs a whole second generation every time the
   * model answers the framed ask by echoing that block back. A measured pass
   * over a sixteen-node feed asked thirty generations for seventeen keys, which
   * is the retry rather than the translation. So prose is asked plainly first
   * and keeps the page line as the fallback; a short label, where `Save changes`
   * and `Save` are the same two words without a page to sit on, keeps the frame
   * first.
   */
  const SELF_SUFFICIENT_CHARS = 40;

  /** Is this a usable answer to this text? Length and glyph runs catch the
   *  collapse measured on the artifact - one generation in 800 came back as 972
   *  characters of one syllable. `checkScript` catches the failure a length test
   *  cannot see: handing the source back in its own script, a Japanese target
   *  answered in Hangul, which is exactly as long as a real answer would be. It
   *  tolerates Latin always, so a URL, a version number or a product name never
   *  fails; what it can catch is a proper noun kept in the source's script, and
   *  the price of that false positive is one more ask and, if it repeats, the
   *  page's own text left where the reader can see it. */
  function usable(answer: string, text: string, target: string): boolean {
    if (!answer || L.isRunaway(answer, text)) return false;
    const lang = AT.plamo3.langFor(target);
    return lang === null || AT.plamo3.checkScript(answer, lang);
  }

  /**
   * One text in one generation. Two ways this goes wrong on the real model: the
   *  page line can swallow the answer, so the reply is the context and nothing
   *  else, and once in the 800 measured generations the answer collapsed into
   *  972 characters of one syllable. Either earns exactly one more ask - the
   *  other prompt shape, and with `RETRY_SAMPLING`, because the seeded decoding
   *  answers a repeat of the same request identically. An answer still unusable
   *  after that comes back empty, which is how the caller is told to leave the
   *  page's own text alone. Neither ask may spend more of the window than
   *  `L.answerTokens` allows, so a model that misses its end token costs seconds
   *  instead of the whole context.
   */
  async function translateOne(
    instance: WllamaInstance,
    target: string,
    text: string,
    hint: string | null
  ): Promise<string> {
    const plain = L.buildEnginePrompt(target, text);
    const framed = hint === null ? plain : L.buildEnginePrompt(target, text, hint);
    const leadIsPlain = hint === null || text.length >= SELF_SUFFICIENT_CHARS;
    const lead = leadIsPlain ? plain : framed;
    const answer = (
      await generate(instance, lead, L.SAMPLING, L.answerTokens(text, lastMaxTokens, lead))
    ).trim();
    if (usable(answer, text, target)) return answer;
    AT.log(
      answer
        ? 'on-device answer was unusable, asking once more'
        : leadIsPlain
          ? 'on-device answer was empty, asking again with the page line'
          : 'on-device answer was only the page line, retrying without it',
      text.slice(0, 40)
    );
    const follow = leadIsPlain ? framed : plain;
    const retry = (
      await generate(instance, follow, L.RETRY_SAMPLING, L.answerTokens(text, lastMaxTokens, follow))
    ).trim();
    return usable(retry, text, target) ? retry : '';
  }

  /** One generation for a group of texts, retreating to one text per
   *  generation when the numbered reply cannot be split back reliably. */
  async function translateChunk(
    instance: WllamaInstance,
    target: string,
    texts: string[],
    hint: string | null
  ): Promise<string[]> {
    // A batch keeps the page line whatever the lengths: a navigation row is
    // exactly where `Save changes` and `Save` are untranslatable without
    // knowing what page they sit on, the card's background block is the shape
    // the model reads as context rather than as text to translate, and the one
    // generation is shared, so the echo risk is priced once per group rather
    // than once per text. Text asked alone is priced by `translateOne`.
    if (texts.length === 1) return [await translateOne(instance, target, texts[0] ?? '', hint)];
    const batch = L.buildEngineBatch(target, texts, hint);
    if (!fits(batch, texts)) {
      // Halve the batch and pay for a second generation rather than let the
      // model silently drop the end of the prompt.
      const middle = Math.ceil(texts.length / 2);
      AT.log('on-device prompt over the context, splitting', texts.length, middle);
      const head = await translateChunk(instance, target, texts.slice(0, middle), hint);
      const tail = await translateChunk(instance, target, texts.slice(middle), hint);
      return [...head, ...tail];
    }
    const reply = (
      await generate(instance, batch, L.BATCH_SAMPLING, L.answerTokens(texts, lastMaxTokens, batch))
    ).trim();
    const parsed = L.parseNumbered(reply, texts.length);
    if (parsed) return parsed.map((answer) => answer.trim());
    AT.warn('on-device split mismatch, retrying per text', texts.length);
    const out: string[] = [];
    for (const text of texts) out.push(await translateOne(instance, target, text, hint));
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

  export async function load(modelId: string, maxTokens: number, target: string): Promise<AT.local.LocalStatus> {
    await ensureLoaded(modelId, maxTokens, target);
    return state;
  }

  export async function unload(cause = 'requested'): Promise<AT.local.LocalStatus> {
    await teardown(cause);
    return state;
  }

  export async function translate(request: TranslateRequest): Promise<HostReply> {
    return await enqueue(() => translateNow(request));
  }

  async function translateNow(request: TranslateRequest): Promise<HostReply> {
    const texts = Array.isArray(request.texts)
      ? request.texts.filter((text): text is string => typeof text === 'string')
      : [];
    const askedTarget = typeof request.target === 'string' ? request.target : '';
    const maxTokens = Number(request.maxTokens) || L.DEFAULT_MAX_TOKENS;
    const hint = typeof request.context === 'string' ? request.context.slice(0, 200) : null;
    if (texts.length === 0) return { translations: [] };
    // The message boundary is untrusted: only a language the model was released
    // with may reach a prompt, and a target outside that list is a configuration
    // problem no retry answers.
    if (AT.plamo3.langFor(askedTarget) === null) {
      fail('no-target', `no model translates into ${askedTarget || 'that language'}`);
    }
    const target = askedTarget;
    const modelId = typeof request.modelId === 'string' && request.modelId ? request.modelId : '';
    if (!modelId) fail('no-model', 'no model is selected');

    state.state = 'busy';
    publish();
    try {
      lastMaxTokens = maxTokens;
      const instance = await ensureLoaded(modelId, maxTokens, target);
      const translations = await translateChunk(instance, target, texts, hint);
      state.state = 'ready';
      publish();
      return { translations };
    } catch (error: unknown) {
      const reason = (error as { reason?: string })?.reason ?? 'generation-failed';
      fail(reason, error);
    }
  }

  /** One entry point for both placements: the offscreen document's message
   *  handlers and the background's direct calls dispatch through here. */
  export async function handle(message: AT.Message): Promise<HostReply> {
    switch (message?.type) {
      case C.MSG.LOCAL_TRANSLATE:
        return await translate(message as TranslateRequest);
      case C.MSG.LOCAL_LOAD: {
        const request = message as LoadRequest;
        const modelId = typeof request.modelId === 'string' ? request.modelId : '';
        if (!modelId) fail('no-model', 'no model is selected');
        // Korean is the warmup language when the caller names none it can use.
        const askedTarget =
          typeof request.target === 'string' && AT.plamo3.langFor(request.target) !== null
            ? request.target
            : 'ko';
        return {
          status: await enqueue(() =>
            load(modelId, Number(request.maxTokens) || L.DEFAULT_MAX_TOKENS, askedTarget)
          )
        };
      }
      case C.MSG.LOCAL_UNLOAD:
        await enqueue(() => Promise.resolve());
        return { status: await unload('requested') };
      case C.MSG.LOCAL_QUERY:
      case C.MSG.LOCAL_STATUS:
        return { status: await status() };
      default:
        return {};
    }
  }
}

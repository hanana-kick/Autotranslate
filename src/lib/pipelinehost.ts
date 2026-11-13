// The one place a WebGPU session is opened: the vendored runtime, the custom
// cache Transformers.js fetches the model's files through, and the tokenizer
// and pipeline that come out of it.
//
// The offscreen document loads only the tokenizer on the kernel path; it opens
// a session lazily if the worker cannot answer. Decode workers open their own
// runtime session only when kernels are unavailable. Both contexts carry the
// `AT_TRANSFORMERS` and `AT_ORT_*` globals, so the loader is a plain namespace
// they share rather than a module only one of them can import.
//
// Load after lib/constants.js, lib/browser.js, lib/modelstore.js, and after
// vendor/ort-common.all.js, vendor/ort-webgpu.all.js and
// vendor/transformers.web.js.
namespace AT.pipelinehost {
  /** The members of the vendored Transformers.js global this file touches. */
  export type TfModule = {
    env: Record<string, any>;
    AutoTokenizer: { from_pretrained: (id: string) => Promise<Tokenizer> };
    AutoModelForCausalLM: {
      from_pretrained: (id: string, options: Record<string, unknown>) => Promise<CausalModel>;
    };
    Tensor: new (type: string, data: ArrayLike<number | bigint>, dims: number[]) => Tensor;
    pipeline: (task: string, id: string, options: Record<string, unknown>) => Promise<Pipeline>;
    TextStreamer?: new (tokenizer: Tokenizer, options: {
      skip_prompt?: boolean;
      skip_special_tokens?: boolean;
      callback_function?: (text: string) => void;
    }) => { end: () => void };
  };
  export type Tokenizer = {
    (text: string, options?: { add_special_tokens?: boolean }): { input_ids: { data: ArrayLike<number | bigint> } };
    decode(ids: number[] | ArrayLike<number | bigint>, options?: { skip_special_tokens?: boolean }): string;
    apply_chat_template(
      messages: { role: string; content: string }[],
      options: { target_lang: string; add_generation_prompt: boolean; tokenize: false }
    ): string;
    pad_token_id?: number | null;
    eos_token_id?: number | null;
  };
  /** A tensor the runtime hands back: the fields the engine reads. */
  export type Tensor = {
    data: ArrayLike<number>;
    dims: number[];
    type: string;
    /** Frees the GPU buffer; not every tensor is backed by one. */
    dispose?: () => void;
  };
  /** One forward of a decoder graph: logits plus the cache of this step. */
  export type ModelOutput = Record<string, Tensor>;
  /**
   * The causal-LM object Transformers.js builds around one ONNX session. The
   * engine calls `forward` itself instead of `generate`, which is what makes
   * several sequences share one batched step.
   */
  export type CausalModel = {
    forward: (feeds: Record<string, unknown>) => Promise<ModelOutput>;
    sessions: Record<string, { inputNames: string[]; inputMetadata: { name: string; shape: unknown[]; type: string }[] }>;
    config?: Record<string, any>;
  };
  /** The session the engine drives: input names and dtypes as exported. */
  export type SessionInfo = { inputNames: string[]; inputMetadata: { name: string; shape: unknown[]; type: string }[] };
  /** A generation call: one prompt, one decoded sequence, one padded output. */
  export type Pipeline = {
    (prompt: string | string[], options: Record<string, unknown>): Promise<{ generated_text: string }[]>;
    dispose?: () => Promise<unknown> | void;
  };

  /** The seam a test replaces: how the vendored runtime and the model's files
   *  are reached. Production leaves both undefined. */
  export type Seams = {
    runtime?: () => TfModule;
    modelFiles?: (name: string) => Promise<Blob | null>;
  };

  let seams: Seams = {};
  /** The model whose files the cache serves; set before the pipeline loads. */
  let modelIdForCache = '';

  /** A test replaces the runtime and the store before anything is opened. */
  export function installSeams(patch: Seams): void {
    seams = { ...seams, ...patch };
  }

  function runtime(): TfModule {
    if (seams.runtime) return seams.runtime();
    const global = globalThis as Record<string, unknown>;
    const mod = global.AT_TRANSFORMERS as TfModule | undefined;
    if (!mod) throw new Error('the ONNX runtime bundle is not loaded');
    return mod;
  }

  /** A packaged file's URL. The extension API knows the bundle's root; a decode
   *  worker has no extension API at all (`chrome.runtime` is not exposed to
   *  dedicated workers), so its own location is the root there. */
  function assetUrl(path: string): string {
    if (typeof AT.getURL === 'function') return AT.getURL(path);
    const base = (globalThis as { location?: { href?: string } }).location?.href;
    if (!base) throw new Error('no extension origin to resolve a packaged file against');
    return new URL(path, base).href;
  }

  function setModelId(id: string): void {
    modelIdForCache = id;
  }

  /** The model's own small files live next to the graph in OPFS; the graph
   *  itself is served as one response so Transformers.js streams it into the
   *  WebGPU session without a second copy in the JS heap. */
  async function modelFile(name: string): Promise<Blob | null> {
    if (seams.modelFiles) return seams.modelFiles(name);
    const record = await AT.modelstore.get(modelIdForCache).catch(() => null);
    if (!record) return null;
    // Bundled bytes live in the package beside the code: read them from there,
    // never the network, and never copy them into OPFS.
    if (record.bundled) {
      const response = await fetch(assetUrl(`weights/${name}`)).catch(() => null);
      return response?.ok ? await response.blob() : null;
    }
    // The graph is the model's main file; everything else is a named part.
    if (name.endsWith('.onnx')) return AT.modelstore.read(record.id).catch(() => null);
    return AT.modelstore.readPart(record.id, name).catch(() => null);
  }

  /** One of the model's small JSON files, read through the same cache as
   *  everything else: the card's sentinel ids live in `generation_config`. */
  export async function modelJson(name: string): Promise<Record<string, unknown> | null> {
    const blob = await modelFile(name);
    if (!blob) return null;
    try {
      return JSON.parse(await blob.text()) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /** Serves the ONNX model's files to Transformers.js from OPFS. A relative
   *  model id makes the library take its local-file branch, and the custom
   *  cache answers every fetch from the store, so nothing crosses the network. */
  function installCache(tf: TfModule): void {
    const env = tf.env;
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.useFS = false;
    env.useFSCache = false;
    env.useBrowserCache = false;
    env.useCustomCache = true;
    env.experimental_useCrossOriginStorage = false;
    env.localModelPath = './';
    env.customCache = {
      match: async (request: unknown) => {
        // The library asks for both the joined path and the raw cache key, and
        // neither names the file the way the store keeps it, so match on the
        // trailing path segment of either.
        const raw = typeof request === 'string' ? request : String((request as { url?: string })?.url ?? '');
        const name = raw.split('/').filter(Boolean).pop() ?? '';
        const blob = await modelFile(name);
        if (!blob) return undefined;
        const total = Number((blob as Blob).size);
        return new Response(blob, {
          headers: { 'content-length': String(total), 'content-type': 'application/octet-stream' }
        });
      },
      put: async () => undefined
    };
    env.backends.onnx.wasm.wasmPaths = assetUrl('vendor/onnxruntime/');
    env.backends.onnx.wasm.numThreads = 1;
  }

  /** Loads only the tokenizer and its small files, without opening an ONNX session. */
  export async function openTokenizer(modelId: string): Promise<{ tf: TfModule; tokenizer: Tokenizer }> {
    const tf = runtime();
    setModelId(modelId);
    installCache(tf);
    // A bare model id (not a URL, but shaped like a repo id) makes
    // Transformers.js take its local-file branch, which fetches through the
    // custom cache (OPFS) instead of the network; the cache matches on the
    // file name, so the id's own directory prefix is irrelevant.
    const tokenizer = await tf.AutoTokenizer.from_pretrained('onnx-model');
    return { tf, tokenizer };
  }

  /** Opens the document's generation session only when its caller needs it. */
  export async function openPipeline(modelId: string, dtype: string): Promise<Pipeline> {
    const tf = runtime();
    setModelId(modelId);
    installCache(tf);
    return await tf.pipeline('text-generation', 'onnx-model', { dtype, device: 'webgpu' });
  }

  /** Opens the tokenizer and graph together for the nonkernel path. */
  export async function open(modelId: string, dtype: string): Promise<{
    tf: TfModule;
    tokenizer: Tokenizer;
    pipe: Pipeline;
  }> {
    const opened = await openTokenizer(modelId);
    const pipe = await openPipeline(modelId, dtype);
    return { ...opened, pipe };
  }

  /** The same session without the generation wrapper: the raw causal LM, whose
   *  `forward` the engine drives one step at a time so several sequences share
   *  a step. The tokenizer is left to the caller, which owns the prompt. */
  export async function openModel(modelId: string, dtype: string): Promise<{
    tf: TfModule;
    model: CausalModel;
  }> {
    const tf = runtime();
    setModelId(modelId);
    installCache(tf);
    const model = await tf.AutoModelForCausalLM.from_pretrained('onnx-model', { dtype, device: 'webgpu' });
    return { tf, model };
  }

  /** The card names its graph after the dtype; a file the user picked from disk
   *  carries the same name the export gave it, so read it off there instead of
   *  asking the library for a file that does not exist. */
  export function dtypeOf(name: unknown): string {
    const match = /model[_-](q4f16|q4|fp16|fp32|int8|q8)/i.exec(typeof name === 'string' ? name : '');
    return match ? match[1]!.toLowerCase() : 'fp16';
  }
}

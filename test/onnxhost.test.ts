/// <reference lib="es2024.promise" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { load, type ATNamespace } from './helpers.ts';

const AT = load('lib/constants.js', 'lib/plamo3.js', 'lib/glossary.js', 'lib/local.js', 'lib/modelstore.js', 'lib/pipelinehost.js', 'lib/onnxhost.js');
const { local, onnxhost } = AT;

/** A tokenizer double shaped like the real one: the Plamo Unigram vocab has no
 *  byte fallback in JS, so an out-of-vocab char encodes to unk(0) while the
 *  `<0xXX>` byte tokens are in the vocab. */
const VOCAB: Record<string, number> = {
  '안': 101099, '하': 101026, '세': 101072, '요': 101084,
  '<0xEB>': 235, '<0x85>': 133, '<0x95>': 149
};
const fakeTokenizer = (text: string, _options?: { add_special_tokens?: boolean }) => {
  const ids: number[] = [];
  // Match <0xXX> byte tokens first, then single characters.
  const re = /<0x[0-9A-F]{2}>|./gsu;
  for (const piece of text.match(re) ?? []) {
    const id = VOCAB[piece];
    ids.push(id === undefined ? 0 : id);
  }
  return { input_ids: { data: ids } };
};
fakeTokenizer.decode = (ids: ArrayLike<number | bigint>) => {
  let out = '';
  const bytes: number[] = [];
  for (const id of Array.from(ids)) {
    const piece = Object.entries(VOCAB).find(([, v]) => v === Number(id))?.[0] ?? '?';
    const byte = piece.match(/^<0x([0-9A-F]{2})>$/)?.[1];
    if (byte) bytes.push(parseInt(byte, 16));
    else {
      if (bytes.length) {
        out += new TextDecoder().decode(new Uint8Array(bytes));
        bytes.length = 0;
      }
      out += piece;
    }
  }
  if (bytes.length) out += new TextDecoder().decode(new Uint8Array(bytes));
  return out;
};
fakeTokenizer.apply_chat_template = (messages: { content: string }[]) => `PROMPT:${messages[0]?.content ?? ''}`;

test.beforeEach(() => {
  onnxhost.configure({ modelFiles: async (name: string) => new Blob([JSON.stringify(
    name === 'config.json' ? { max_position_embeddings: 8192, eos_token_id: 1 } : { eos_token_id: 1 }
  )]) });
  onnxhost.configure({ tokenizer: fakeTokenizer });
});

test('expandByteFallback leaves in-vocab text alone', () => {
  assert.equal(onnxhost.expandByteFallback('안하세요'), '안하세요');
});

test('expandByteFallback turns an out-of-vocab char into its UTF-8 byte tokens', () => {
  // '녕' is not in the vocab (the real one has only 467 of 11172 syllables),
  // so it must become <0xEB><0x85><0x95>, which round-trips to the same ids the
  // Rust tokenizer produces.
  assert.equal(onnxhost.expandByteFallback('안녕하세요'), '안<0xEB><0x85><0x95>하세요');
  const ids = Array.from(fakeTokenizer(onnxhost.expandByteFallback('안녕하세요')).input_ids.data).map(Number);
  assert.deepEqual(ids, [101099, 235, 133, 149, 101026, 101072, 101084]);
  assert.equal(fakeTokenizer.decode(ids), '안녕하세요', 'the expansion round-trips to the original text');
});

test('byte expansion memo is exact, bounded and cleared by tokenizer replacement', () => {
  let calls = 0;
  const tracked = Object.assign((text: string, options?: { add_special_tokens?: boolean }) => {
    calls += 1;
    return fakeTokenizer(text, options);
  }, { decode: fakeTokenizer.decode, apply_chat_template: fakeTokenizer.apply_chat_template });
  onnxhost.configure({ tokenizer: tracked });
  const source = '안녕하세요';
  const expanded = onnxhost.expandByteFallback(source);
  const firstCalls = calls;
  assert.equal(onnxhost.expandByteFallback(source), expanded);
  assert.equal(calls, firstCalls, 'identical source expansion needs no tokenization');
  for (let index = 0; index < 257; index += 1) onnxhost.expandByteFallback('안'.repeat(index + 1));
  onnxhost.expandByteFallback(source);
  assert.ok(calls > firstCalls + 257, 'old source text is evicted from the bounded memo');
  const large = '안'.repeat(8193);
  onnxhost.expandByteFallback(large);
  const largeCalls = calls;
  assert.equal(onnxhost.expandByteFallback(large), large);
  assert.equal(calls, largeCalls + 1, 'large input is processed intact, not retained');
  onnxhost.configure({ tokenizer: Object.assign(
    (text: string) => ({ input_ids: { data: Array.from(text, (character) => character.codePointAt(0) ?? 0) } }),
    { decode: fakeTokenizer.decode, apply_chat_template: fakeTokenizer.apply_chat_template }
  ) });
  assert.equal(onnxhost.expandByteFallback(source), source, 'replacement vocab cannot inherit byte expansion');
});

test('modelKind classifies supported ONNX files and unsupported files', () => {
  assert.equal(
    local.modelKind({ name: 'model_q4f16.onnx', sourceUrl: 'https://huggingface.co/x/y/resolve/main/onnx/model_q4f16.onnx' }),
    'onnx'
  );
  assert.equal(local.modelKind({ sourceUrl: 'https://huggingface.co/x/y/resolve/main/onnx/model_fp16.onnx' }), 'onnx');
  assert.equal(local.modelKind({ name: 'other.bin' }), 'unknown');
  assert.equal(local.modelKind({}), 'unknown');
});

test('the ONNX card is the default offer and carries its parts', () => {
  const source = local.defaultSource();
  assert.equal(source.kind, 'onnx');
  assert.equal(source.id, 'plamo-3-translate-0.8b-onnx-q4f16');
  assert.ok(source.url.includes('model_q4f16.onnx'));
  assert.equal(source.size, 705701446);
  assert.equal(source.dtype, 'q4f16', 'the default is the graph the step and batch numbers were measured on');
  assert.ok((source.parts ?? []).includes('tokenizer.json'));
  assert.equal(local.sourceFor(source.url)?.id, source.id);
});

test('the answer is the generation alone, not the prompt the pipeline echoes back', async () => {
  // With `return_full_text` on, the pipeline hands back the decoded prompt
  // followed by the generation; a cut that trusts the library's token-count
  // slice left the page's own sentence at the head of the "translation".
  const source = 'The meeting moved to Monday.';
  const answer = '회의는 월요일로 변경되었습니다.';
  const prompts: string[] = [];
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const globals = globalThis as ATNamespace;
  const realRuntime = AT.runtime;
  const realGet = AT.modelstore.get;
  const realGetURL = AT.getURL;
  AT.getURL = (path: string) => `ext://${path}`;
  AT.modelstore.get = async (id: string) => ({
    id,
    name: 'model_q4f16.onnx',
    size: 705701446,
    sourceUrl: 'https://x/onnx/model_q4f16.onnx',
    createdAt: 1
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { gpu: { requestAdapter: async () => ({ features: { has: () => true } }) } }
  });
  onnxhost.configure({
    runtime: () => ({
      env: { backends: { onnx: { wasm: {} } } },
      AutoTokenizer: { from_pretrained: async () => fakeTokenizer },
      pipeline: async () => async (prompt: string, options: ATNamespace) => {
        options.streamer?.put([[2]]);
        options.streamer?.put([[1]]);
        prompts.push(prompt);
        return [{ generated_text: prompt + answer }];
      }
    })
  });
  try {
    const reply = await onnxhost.translate({
      type: 'at/local-translate',
      modelId: 'onnx-model',
      texts: [source],
      target: 'ko',
      maxTokens: 512
    });
    assert.deepEqual(reply.translations, [answer]);
    assert.ok(prompts.some((prompt) => prompt.startsWith('PROMPT:')), 'the fake pipeline saw the prompt');
    assert.equal(reply.translations[0].includes('PROMPT:'), false, 'the prompt never comes back as the translation');
  } finally {
    await onnxhost.unload('requested');
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else delete globals.navigator;
    AT.runtime = realRuntime;
    AT.getURL = realGetURL;
    AT.modelstore.get = realGet;
  }
});

test('a status query for an ONNX model is answered by the one host', async () => {
  // Status, unload and query carry no model id: with a single host there is
  // nothing to route, so the answer is that host's own state.
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { gpu: { requestAdapter: async () => ({ features: { has: () => true } }) } }
  });
  try {
    const status = await AT.onnxhost.status();
    assert.equal(status.target, 'offscreen', 'the host installed by the offscreen document answers');
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else delete (globalThis as ATNamespace).navigator;
  }
});

// --- the decode engine -----------------------------------------------------
// The host sends token ids and receives tokens; `AT.engine` decides which rows
// share a step (test/engine.test.ts covers that). These pin the host's half:
// the wire protocol, concurrency without a queue, and the fallback.

type EngineJob = { worker: FakeEngine; id: number; inputIds: number[]; maxNewTokens: number };

/** A worker double for the engine actor: answers `init`, holds every `generate`
 *  until the test replies with tokens, and records `drop`. */
class FakeEngine {
  static made: FakeEngine[] = [];
  static inFlight: EngineJob[] = [];
  static dropped: number[] = [];
  static failInit: string | null = null;
  static holdInit = false;
  static backend: 'kernels' | 'runtime' = 'runtime';
  static rows = 1;
  static contextTokens = 2048;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeEngine.made.push(this);
  }
  postMessage(message: { type?: string; id?: number; inputIds?: number[]; maxNewTokens?: number }): void {
    const failure = FakeEngine.failInit;
    if (message?.type === 'init') {
      if (FakeEngine.holdInit) return;
      queueMicrotask(() => {
        this.onmessage?.({
          data: failure
            ? { type: 'ready', ok: false, error: failure, code: 'worker-init' }
            : { type: 'ready', ok: true, backend: FakeEngine.backend, rows: FakeEngine.rows, contextTokens: FakeEngine.contextTokens }
        });
      });
      return;
    }
    if (message?.type === 'drop' && typeof message.id === 'number') {
      FakeEngine.dropped.push(message.id);
      FakeEngine.inFlight = FakeEngine.inFlight.filter((job) => job.id !== message.id);
      return;
    }
    if (message?.type !== 'generate' || typeof message.id !== 'number') return;
    FakeEngine.inFlight.push({
      worker: this,
      id: message.id,
      inputIds: message.inputIds ?? [],
      maxNewTokens: message.maxNewTokens ?? 0
    });
  }
  answer(job: EngineJob, text: string, finishReason: 'eos' | 'length' = 'eos'): void {
    FakeEngine.inFlight = FakeEngine.inFlight.filter((entry) => entry !== job);
    const tokens = Array.from(text).map((character) => character.codePointAt(0) ?? 0);
    this.onmessage?.({ data: { type: 'result', id: job.id, ok: true, tokens, finishReason } });
  }
  crash(): void {
    FakeEngine.inFlight = FakeEngine.inFlight.filter((job) => job.worker !== this);
    this.onerror?.();
  }
  terminate(): void {
    this.terminated = true;
  }
  static reset(): void {
    FakeEngine.made = [];
    FakeEngine.inFlight = [];
    FakeEngine.dropped = [];
    FakeEngine.failInit = null;
    FakeEngine.holdInit = false;
    FakeEngine.backend = 'runtime';
    FakeEngine.rows = 1;
    FakeEngine.contextTokens = 2048;
  }
}

/** Waits for a state the host reaches on its own microtask schedule. */
async function until(label: string, predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise((done) => setTimeout(done, 5));
  }
  assert.fail(`${label} did not happen`);
}

/** A tokenizer whose ids are code points, so prompt-in and answer-out survive
 *  the round trip through the engine unchanged. */
const codepoints = (text: string, _options?: { add_special_tokens?: boolean }) => ({
  input_ids: { data: Array.from(text).map((character) => character.codePointAt(0) ?? 0) }
});
codepoints.decode = (ids: ArrayLike<number | bigint>) =>
  Array.from(ids)
    .map((id) => String.fromCodePoint(Number(id)))
    .join('');
codepoints.apply_chat_template = (messages: { content: string }[], _options: NativeTemplateOptions) => `PROMPT:${messages[0]?.content ?? ''}`;

type NativeTemplateOptions = {
  target_lang: string;
  source_lang?: string;
  glossary?: { source: string; target: string }[];
};

/** The native model template's glossary protocol, without tokenizer-specific IDs. */
function nativeTemplate(messages: { content: string }[], options: NativeTemplateOptions): string {
  return '<|plamo:tag|>dataset<|plamo:msg|>translation' +
    (options.glossary?.length ? '<|plamo:tag|>glossary' + options.glossary.map(pair =>
      '<|plamo:index|>' + pair.source + '<|plamo:item|>' + pair.target).join('') : '') +
    '<|plamo:tag|>input' +
    (options.source_lang ? '<|plamo:key|>lang<|plamo:val|>' + options.source_lang : '') +
    '<|plamo:msg|>' + messages[0]!.content +
    '<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>' + options.target_lang + '<|plamo:msg|>';
}

function glossaryEntries(source: string, target: string, conceptId = source) {
  return [
    { id: conceptId + '-en', conceptId, language: 'en', term: source, group: 'default', traits: [], description: '' },
    { id: conceptId + '-ko', conceptId, language: 'ko', term: target, group: 'default', traits: [], description: '' }
  ];
}

const nativeTokenizer = Object.assign((text: string) => codepoints(text), {
  decode: codepoints.decode, apply_chat_template: nativeTemplate
});

/** The document's runtime seam records session creation separately from generation. */
function installSession(options: {
  beforeTokenizer?: () => Promise<void>;
  beforePipeline?: () => Promise<void>;
  beforeGenerate?: () => Promise<void>;
  tokenizer?: typeof codepoints;
  generatedText?: (prompt: string) => string;
  finishReason?: 'eos' | 'length';
  previewChunks?: string[];
  onStreamer?: (options: { skip_prompt?: boolean; skip_special_tokens?: boolean }) => void;
} = {}) {
  const inline: string[] = [];
  const calls = { tokenizers: 0, pipelines: 0, disposed: 0 };
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const globals = globalThis as ATNamespace;
  const realGetURL = AT.getURL;
  const realGet = AT.modelstore.get;
  const realKernels = AT.C.ENGINE_KERNELS;
  const realBatch = AT.C.ENGINE_BATCH;
  AT.C.ENGINE_KERNELS = true;
  AT.C.ENGINE_BATCH = 8;
  AT.getURL = (path: string) => `ext://${path}`;
  AT.modelstore.get = async (id: string) => ({
    id,
    name: 'model_q4f16.onnx',
    size: 705701446,
    sourceUrl: 'https://x/onnx/model_q4f16.onnx',
    createdAt: 1
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { gpu: { requestAdapter: async () => ({ features: { has: () => true } }) } }
  });
  onnxhost.configure({
    runtime: () => ({
      env: { backends: { onnx: { wasm: {} } } },
      TextStreamer: class {
        readonly config: { callback_function: (text: string) => void };
        constructor(_tokenizer: unknown, config: {
          skip_prompt?: boolean; skip_special_tokens?: boolean; callback_function: (text: string) => void;
        }) {
          this.config = config;
          options.onStreamer?.(config);
        }
        private promptPending = true;
        put(tokens: number[][]) {
          if (this.promptPending) { this.promptPending = false; return; }
          const text = codepoints.decode((tokens[0] ?? []).filter(id => id !== 1));
          if (text) this.config.callback_function(text);
        }
        end() {}
      },
      AutoTokenizer: {
        from_pretrained: async () => {
          calls.tokenizers += 1;
          await options.beforeTokenizer?.();
          return options.tokenizer ?? codepoints;
        }
      },
      pipeline: async () => {
        calls.pipelines += 1;
        await options.beforePipeline?.();
        const pipe = async (prompt: string, generation: {
          streamer?: { put: (tokens: number[][]) => void; end: () => void };
        }) => {
          inline.push(prompt);
          await options.beforeGenerate?.();
          generation.streamer?.put([codepoints(prompt).input_ids.data]);
          for (const chunk of options.previewChunks ?? []) generation.streamer?.put([codepoints(chunk).input_ids.data]);
          generation.streamer?.put([[options.finishReason === 'length' ? 42 : 1]]);
          generation.streamer?.end();
          return [{ generated_text: options.generatedText?.(prompt) ?? `${prompt}문서` }];
        };
        pipe.dispose = async () => { calls.disposed += 1; };
        return pipe;
      }
    })
  });
  return {
    inline,
    calls,
    restore: () => {
      if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
      else delete globals.navigator;
      AT.getURL = realGetURL;
      AT.modelstore.get = realGet;
      AT.C.ENGINE_KERNELS = realKernels;
      AT.C.ENGINE_BATCH = realBatch;
      delete globals.Worker;
    }
  };
}

/** Unloads the model and puts the environment back, after every request a test
 *  started has settled. */
async function finish(started: Promise<unknown>[], session: { restore: () => void }): Promise<void> {
  for (const job of [...FakeEngine.inFlight]) job.worker.answer(job, '정리');
  await Promise.allSettled(started);
  await onnxhost.unload('requested');
  session.restore();
}

const ASK_ONE = '안하세요';
const ASK_TWO = '요세하안';

function translateRequest(text: string): Record<string, unknown> {
  return { type: 'at/local-translate', modelId: 'onnx-model', texts: [text], target: 'ko', maxTokens: 512 };
}

function jobFor(text: string): EngineJob {
  const job = FakeEngine.inFlight.find((entry) => {
    const prompt = entry.inputIds.map((id) => String.fromCodePoint(id)).join('');
    return prompt.includes(text);
  });
  assert.ok(job, `no engine job in flight for "${text}"`);
  return job;
}

test('requests reach the engine as token ids and come back as tokens', async () => {
  const session = installSession();
  FakeEngine.reset();
  (globalThis as ATNamespace).Worker = FakeEngine;
  const started: Promise<unknown>[] = [];
  try {
    const first = onnxhost.translate(translateRequest(ASK_ONE));
    const second = onnxhost.translate(translateRequest(ASK_TWO));
    started.push(first, second);
    await until('both requests in one engine', () => FakeEngine.inFlight.length === 2);
    assert.equal(FakeEngine.made.length, 1, 'one engine serves every request');
    assert.equal(session.calls.tokenizers, 1, 'concurrent requests share the initial tokenizer load');
    assert.equal(session.calls.pipelines, 0, 'the document never opens an ORT pipeline');
    assert.equal(session.inline.length, 0, 'the kernel path does not warm an inline pipeline');
    const baseline = session.inline.length;
    const one = jobFor(ASK_ONE);
    const two = jobFor(ASK_TWO);
    assert.ok(one.inputIds.every((id) => typeof id === 'number'), 'the prompt crossed as ids, not text');
    assert.equal(
      one.inputIds.map((id) => String.fromCodePoint(id)).join(''),
      `PROMPT:${ASK_ONE}`,
      'the host rendered and tokenized the prompt before handing it over'
    );
    two.worker.answer(two, '둘째');
    one.worker.answer(one, '첫째');
    const replies = await Promise.all([first, second]);
    assert.deepEqual(replies[0]?.translations, ['첫째'], 'the answer is the decoded generation, not the prompt');
    assert.deepEqual(replies[1]?.translations, ['둘째']);
    assert.equal(session.inline.length, baseline, 'nothing was generated in this document');
    assert.equal((await onnxhost.status()).generations, 2, 'each answer is one generation');
  } finally {
    await finish(started, session);
  }
});

/** PFML labels remain plain text after special tokens disappear. The decoder
 * also normalizes source spacing, so marker removal is not the decoded prompt. */
const protocolTokenizer = Object.assign(
  (text: string, options?: { add_special_tokens?: boolean }) => codepoints(text, options),
  {
    decode: (ids: ArrayLike<number | bigint>) => codepoints.decode(ids)
      .replace(/<\|plamo:[^|]*\|>/g, '').replace(/\u3000/g, ' '),
    apply_chat_template: (messages: { content: string }[]) =>
      '<|plamo:tag|>dataset<|plamo:msg|>translation' +
      '<|plamo:tag|>input<|plamo:msg|>' + (messages[0]?.content ?? '') +
      '<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>ko<|plamo:msg|>'
  }
);

for (const mode of ['native', 'fallback'] as const) {
  test(`${mode}: exact protocol extraction removes the header, not ordinary outputlangko prose`, async () => {
    const source = '안녕　친구';
    const answer = 'outputlangko는 문자열입니다. 안녕 친구라고 했습니다. 안녕 친구';
    const session = installSession({
      tokenizer: protocolTokenizer,
      generatedText: prompt => protocolTokenizer.decode(codepoints(prompt).input_ids.data) + answer
    });
    FakeEngine.reset();
    if (mode === 'fallback') FakeEngine.failInit = 'no adapter in this worker';
    (globalThis as ATNamespace).Worker = FakeEngine;
    const started: Promise<unknown>[] = [];
    try {
      const request = onnxhost.translate(translateRequest(source));
      started.push(request);
      if (mode === 'native') {
        await until('protocol generation', () => FakeEngine.inFlight.length === 1);
        const job = jobFor(source);
        job.worker.answer(job, answer);
      }
      const reply = await request;
      assert.deepEqual(reply.translations, [answer]);
      assert.equal((await onnxhost.status()).generations, 1, 'valid extraction never needs a retry');
      assert.equal(session.calls.pipelines, mode === 'native' ? 0 : 1);
    } finally {
      await finish(started, session);
    }
  });

  test(`${mode}: structural invalid output fails rather than retrying or becoming identity text`, async () => {
    const session = installSession({ generatedText: prompt => prompt + '<pad>' });
    FakeEngine.reset();
    if (mode === 'fallback') FakeEngine.failInit = 'no adapter in this worker';
    (globalThis as ATNamespace).Worker = FakeEngine;
    const started: Promise<unknown>[] = [];
    try {
      const request = onnxhost.translate(translateRequest(ASK_ONE));
      started.push(request);
      const rejected = assert.rejects(request, { reason: 'invalid-output', message: /control-token/ });
      if (mode === 'native') {
        await until('invalid generation', () => FakeEngine.inFlight.length === 1);
        const job = jobFor(ASK_ONE);
        job.worker.answer(job, '<pad>');
      }
      await rejected;
      assert.equal((await onnxhost.status()).generations, 1);
      assert.equal(FakeEngine.inFlight.length, 0, 'invalid output does not start a retry');
    } finally {
      await finish(started, session);
    }
  });
}

test('fallback: incomplete decoded prompt is an explicit protocol error, never a source-anchor guess', async () => {
  const source = '안녕 친구';
  const session = installSession({
    tokenizer: protocolTokenizer,
    generatedText: () => 'damaged prefix ' + source + 'outputlangko번역'
  });
  FakeEngine.reset();
  FakeEngine.failInit = 'no adapter in this worker';
  (globalThis as ATNamespace).Worker = FakeEngine;
  const started: Promise<unknown>[] = [];
  try {
    const request = onnxhost.translate(translateRequest(source));
    started.push(request);
    await assert.rejects(request, { reason: 'invalid-output', message: /complete decoded prompt/ });
    assert.equal(session.inline.length, 1, 'protocol errors are not swallowed by a retry');
  } finally {
    await finish(started, session);
  }
});

test('an engine that cannot start answers every request in this document, and says why', async () => {
  const session = installSession();
  FakeEngine.reset();
  FakeEngine.failInit = 'no adapter in this worker';
  (globalThis as ATNamespace).Worker = FakeEngine;
  const started: Promise<unknown>[] = [];
  try {
    const reply = await onnxhost.translate(translateRequest(ASK_ONE));
    assert.deepEqual(reply.translations, ['문서'], 'the request is answered, not failed');
    assert.equal(session.calls.pipelines, 1, 'fallback opens one document session');
    assert.equal(session.inline.length, 1, 'fallback answers without an eager warmup');
    assert.equal(FakeEngine.made.length, 1, 'the engine is not rebuilt for every request');
    const status = await onnxhost.status();
    assert.equal(status.state, 'ready', 'a page still gets its translations');
    assert.equal(status.reason, 'worker-init', 'and the status names the engine as the reason they are serial');
  } finally {
    await finish(started, session);
  }
});

test('an engine that dies mid-request is answered in this document, and stays down', async () => {
  const session = installSession();
  FakeEngine.reset();
  (globalThis as ATNamespace).Worker = FakeEngine;
  const started: Promise<unknown>[] = [];
  try {
    const first = onnxhost.translate(translateRequest(ASK_ONE));
    started.push(first);
    await until('one engine job in flight', () => FakeEngine.inFlight.length === 1);
    const baseline = session.inline.length;
    const job = FakeEngine.inFlight[0]!;
    job.worker.crash();
    const reply = await first;
    assert.deepEqual(reply.translations, ['문서'], 'the in-document session answered');
    assert.equal(session.inline.length, baseline + 1, 'exactly one generation ran in this document');
    assert.equal(job.worker.terminated, true, 'the dead engine was released');
    const next = onnxhost.translate(translateRequest(ASK_TWO));
    started.push(next);
    assert.deepEqual((await next).translations, ['문서'], 'the next request does not wait for a rebuild');
    assert.equal(FakeEngine.made.length, 1, 'the engine is not restarted behind a failing worker');
  } finally {
    await finish(started, session);
  }
});

test('a request that times out abandons its row and keeps the engine', async () => {
  const session = installSession();
  FakeEngine.reset();
  (globalThis as ATNamespace).Worker = FakeEngine;
  const started: Promise<unknown>[] = [];
  const timeout = AT.local.GENERATION_TIMEOUT_MS;
  const grace = AT.local.WORKER_REPLY_GRACE_MS;
  AT.local.GENERATION_TIMEOUT_MS = 30;
  AT.local.WORKER_REPLY_GRACE_MS = 10;
  try {
    const first = onnxhost.translate(translateRequest(ASK_ONE));
    started.push(first);
    await until('one engine job in flight', () => FakeEngine.inFlight.length === 1);
    const reply = await first;
    assert.deepEqual(reply.translations, ['문서'], 'the timeout is answered in this document');
    assert.equal(session.calls.pipelines, 1, 'the timeout lazily opens its fallback session');
    assert.equal(FakeEngine.dropped.length, 1, 'the engine was told to stop spending steps on it');
    const next = onnxhost.translate(translateRequest(ASK_TWO));
    started.push(next);
    await until('the next request uses the engine', () => FakeEngine.inFlight.length === 1);
    const job = FakeEngine.inFlight[0]!;
    job.worker.answer(job, '둘째');
    assert.deepEqual((await next).translations, ['둘째'], 'the engine still serves the next request');
  } finally {
    AT.local.GENERATION_TIMEOUT_MS = timeout;
    AT.local.WORKER_REPLY_GRACE_MS = grace;
    await finish(started, session);
  }
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  return Promise.withResolvers<void>();
}

test('kernel load and token counting need no document generation session', async () => {
  const session = installSession();
  FakeEngine.reset();
  (globalThis as ATNamespace).Worker = FakeEngine;
  try {
    const loaded = await onnxhost.load('onnx-model', 512, 'ko');
    assert.equal(loaded.state, 'ready');
    assert.equal(FakeEngine.made.length, 1);
    const counts = await onnxhost.handle({
      type: 'at/local-count', modelId: 'onnx-model', texts: [ASK_ONE], target: 'ko'
    });
    assert.deepEqual(counts.counts, [ASK_ONE.length]);
    assert.deepEqual(counts.sourceChunks, [[ASK_ONE]], 'all count calls include safe source plans');
    assert.equal(session.calls.tokenizers, 1);
    assert.equal(session.calls.pipelines, 0);
    assert.equal(session.inline.length, 0);
  } finally {
    await finish([], session);
  }
});

test('count and complete-prompt memos preserve exact IDs, special tokens and languages', async () => {
  const calls: { text: string; specials: boolean }[] = [];
  const tokenizer = Object.assign((text: string, options?: { add_special_tokens?: boolean }) => {
    const specials = options?.add_special_tokens !== false;
    calls.push({ text, specials });
    const ids = codepoints(text).input_ids.data;
    return { input_ids: { data: specials ? [17, ...ids] : ids } };
  }, {
    decode: codepoints.decode,
    apply_chat_template: (messages: { content: string }[], options?: { target_lang?: string; source_lang?: string }) =>
      `PROMPT:${options?.target_lang}:${options?.source_lang ?? ''}:${messages[0]?.content ?? ''}`
  });
  const session = installSession({ tokenizer });
  FakeEngine.reset();
  (globalThis as ATNamespace).Worker = FakeEngine;
  const started: Promise<unknown>[] = [];
  const source = '안녕 e\u0301 👩‍👩‍👧‍👦';
  const plain = `PROMPT:ko::${source}`;
  const countRequest = { type: 'at/local-count', modelId: 'onnx-model', texts: [source, plain], target: 'ko' };
  try {
    const counted = await onnxhost.handle(countRequest);
    assert.deepEqual(counted.counts, [Array.from(source).length, Array.from(plain).length]);
    const before = calls.length;
    assert.deepEqual(await onnxhost.handle(countRequest), counted);
    assert.equal(calls.length, before, 'repeat source counts reuse expansion and no-special counts');
    for (const sourceLang of [undefined, undefined, 'ja', 'ja']) {
      const request = onnxhost.translate({ ...translateRequest(source), source: sourceLang });
      started.push(request);
      await until('memoized prompt admitted', () => FakeEngine.inFlight.length === 1);
      const job = jobFor(source);
      const prompt = `PROMPT:ko:${sourceLang ?? ''}:${source}`;
      assert.deepEqual(job.inputIds, codepoints(prompt).input_ids.data,
        'a rendered template must not acquire a second set of special tokens');
      job.worker.answer(job, '번역');
      await request;
    }
    assert.equal((await onnxhost.status()).generations, 4, 'only tokenizer work is reused, never translations');
  } finally {
    await finish(started, session);
  }
});

test('model replacement invalidates source counts and complete-prompt IDs even with the same tokenizer object', async () => {
  let width = 1;
  const tokenizer = Object.assign((text: string) => ({
    input_ids: { data: codepoints(text).input_ids.data.flatMap((id) => Array.from({ length: width }, () => id)) }
  }), { decode: codepoints.decode, apply_chat_template: codepoints.apply_chat_template });
  const session = installSession({ tokenizer });
  FakeEngine.reset();
  (globalThis as ATNamespace).Worker = FakeEngine;
  const started: Promise<unknown>[] = [];
  try {
    for (const modelId of ['onnx-model', 'replacement-model']) {
      const counted = await onnxhost.handle({ type: 'at/local-count', modelId, texts: [ASK_ONE], target: 'ko' });
      assert.deepEqual(counted.counts, [ASK_ONE.length * width]);
      const request = onnxhost.translate({ ...translateRequest(ASK_ONE), modelId });
      started.push(request);
      await until('model-specific prompt', () => FakeEngine.inFlight.length === 1);
      const job = FakeEngine.inFlight[0]!;
      assert.deepEqual(job.inputIds, tokenizer(`PROMPT:${ASK_ONE}`).input_ids.data);
      job.worker.answer(job, '번역');
      await request;
      width += 1;
    }
    assert.equal(session.calls.tokenizers, 2);
    assert.equal(FakeEngine.made[0]!.terminated, true);
  } finally {
    await finish(started, session);
  }
});

test('LOCAL_COUNT plans actual-token bounded raw source fragments with the loaded tokenizer', async () => {
  const weightedTokenizer = Object.assign((text: string, _options?: { add_special_tokens?: boolean }) => ({
    input_ids: {
      data: Array.from(text).flatMap((character) =>
        Array.from({ length: character === '重' ? 5 : 1 }, () => character.codePointAt(0) ?? 0))
    }
  }), { decode: codepoints.decode, apply_chat_template: codepoints.apply_chat_template });
  const session = installSession({ tokenizer: weightedTokenizer });
  FakeEngine.reset();
  FakeEngine.contextTokens = 78; // 7 prompt tokens + 7 source tokens + 64 output reserve.
  (globalThis as ATNamespace).Worker = FakeEngine;
  const texts = [
    ' \t最初です。次です！終わり？ \n',
    ' \talpha beta  gamma\r\n',
    ` e\u0301e\u0301e\u0301e\u0301e\u0301 `,
    '👩‍👩‍👧‍👦👩‍👩‍👧‍👦',
    '重軽重軽重軽',
    ' \t\r\n',
    ''
  ];
  try {
    const reply = await onnxhost.handle({
      type: 'at/local-count', modelId: 'onnx-model', texts, target: 'ko'
    });
    const plans: string[][] = reply.sourceChunks;
    assert.equal(plans.length, texts.length);
    assert.deepEqual(plans[0], [' \t最初です。', '次です！', '終わり？ \n']);
    assert.deepEqual(plans[3], ['👩‍👩‍👧‍👦', '👩‍👩‍👧‍👦']);
    assert.deepEqual(plans[5], [texts[5]]);
    assert.deepEqual(plans[6], []);
    plans.forEach((chunks, index) => {
      assert.equal(chunks.join(''), texts[index]);
      if (texts[index]!.trim()) assert.ok(chunks.every((chunk) => chunk.trim()));
    });
    for (const chunk of plans[2]!) assert.match(chunk.trim(), /^(?:e\u0301)+$/u);
    const fragments = plans.flat().map((chunk) => chunk.trim()).filter(Boolean);
    const recounted = await onnxhost.handle({
      type: 'at/local-count', modelId: 'onnx-model', texts: fragments, target: 'ko'
    });
    assert.ok(recounted.counts.every((count: number) => count <= 7), 'every translated fragment fits the real host count');
    assert.equal(reply.counts[4], 18, 'the tokenizer, not character length, determines token cost');
    assert.equal(session.calls.tokenizers, 1, 'planning reuses the resident tokenizer');
    assert.equal(session.calls.pipelines, 0, 'planning does not generate translations');
    await assert.rejects(onnxhost.handle({
      type: 'at/local-count', modelId: 'onnx-model', texts: ['e' + '\u0301'.repeat(80)], target: 'ko'
    }), { reason: 'context-overflow', code: 'config', message: /grapheme/ });
    await assert.rejects(onnxhost.translate({
      ...translateRequest('a source that cannot fit this execution context')
    }), { reason: 'context-overflow', code: 'config' });
  } finally {
    await finish([], session);
  }
});

test('native glossary costs drive complete fragment plans and the exact worker generation prompts', async () => {
  const countedPrompts = new Set<string>();
  const tokenizer = Object.assign((text: string) => {
    countedPrompts.add(text);
    return codepoints(text);
  }, { decode: codepoints.decode, apply_chat_template: nativeTemplate });
  const glossary = [...glossaryEntries('GPU', '그래픽 프로세서'), ...glossaryEntries('CPU', '중앙 처리 장치')];
  const source = 'GPU alpha. CPU beta.';
  const expected = (text: string) => nativeTemplate([{ content: text }], {
    source_lang: 'en', target_lang: 'ko', glossary: AT.glossary.select(glossary, text, 'en', 'ko')
  });
  const cost = (text: string) => codepoints(expected(text)).input_ids.data.length + local.answerTokens(text.length);
  const session = installSession({ tokenizer });
  FakeEngine.reset();
  FakeEngine.contextTokens = Math.max(cost('GPU alpha.'), cost('CPU beta.'));
  (globalThis as ATNamespace).Worker = FakeEngine;
  const started: Promise<unknown>[] = [];
  try {
    assert.ok(cost(source) > FakeEngine.contextTokens);
    const request = { type: 'at/local-count', modelId: 'onnx-model', texts: [source], source: 'en', target: 'ko', maxTokens: 512 };
    const plain = await onnxhost.handle(request);
    assert.deepEqual(plain.sourceChunks, [[source]], 'without glossary the complete source fits');
    const counted = await onnxhost.handle({ ...request, glossary });
    const parts: string[] = counted.sourceChunks[0];
    assert.equal(parts.join(''), source, 'planning never drops source to make room for terminology');
    assert.equal(parts.length, 2, 'native glossary overhead, not a reduced context cap, causes splitting');
    const plannedPrompts = new Set(countedPrompts);
    for (const part of parts) {
      const text = part.trim();
      const previews: string[] = [];
      const translated = onnxhost.translate({ ...translateRequest(text), source: 'en', glossary },
        (_index: number, preview: string) => previews.push(preview));
      started.push(translated);
      await until('glossary-conditioned worker job', () => FakeEngine.inFlight.length === 1);
      const job = FakeEngine.inFlight[0]!;
      const prompt = codepoints.decode(job.inputIds);
      assert.equal(prompt, expected(text), 'only terms matched in this fragment enter PFML');
      assert.ok(plannedPrompts.has(prompt), 'count and generation tokenize the identical rendered prompt');
      assert.equal(job.maxNewTokens, local.answerTokens(text.length));
      assert.ok(job.inputIds.length + job.maxNewTokens <= FakeEngine.contextTokens);
      const output = text.startsWith('GPU') ? 'GPU 응답' : 'CPU 응답';
      job.worker.onmessage?.({ data: { type: 'progress', id: job.id, tokens: codepoints(output).input_ids.data } });
      job.worker.answer(job, output);
      assert.deepEqual((await translated).translations, [output], 'native output is not glossary post-replaced');
      assert.deepEqual(previews, [output], 'streaming output is not glossary post-replaced either');
    }
    assert.equal(session.calls.pipelines, 0);
  } finally { await finish(started, session); }
});

test('fragment planning never splits matched multiword or cross-sentence glossary terms to hide their cost', async () => {
  for (const term of ['GPU processor', 'GPU. processor']) {
    const glossary = glossaryEntries(term, '그래픽 처리 장치');
    const prompt = nativeTemplate([{ content: term }], {
      source_lang: 'en', target_lang: 'ko', glossary: [{ source: term, target: '그래픽 처리 장치' }]
    });
    const session = installSession({ tokenizer: nativeTokenizer });
    FakeEngine.reset();
    FakeEngine.contextTokens = codepoints(prompt).input_ids.data.length + local.answerTokens(term.length);
    (globalThis as ATNamespace).Worker = FakeEngine;
    const started: Promise<unknown>[] = [];
    const source = `aaa ${term} zzz`;
    const request = { type: 'at/local-count', modelId: 'onnx-model', texts: [source], source: 'en', target: 'ko', maxTokens: 512 };
    try {
      const counted = await onnxhost.handle({ ...request, glossary });
      const parts: string[] = counted.sourceChunks[0];
      assert.equal(parts.join(''), source);
      assert.ok(parts.some(part => part.trim() === term), 'a native glossary match stays intact at word and sentence boundaries');
      const translated = onnxhost.translate({ ...translateRequest(term), source: 'en', glossary });
      started.push(translated);
      await until('indivisible glossary generation', () => FakeEngine.inFlight.length === 1);
      const job = FakeEngine.inFlight[0]!;
      assert.equal(codepoints.decode(job.inputIds), prompt);
      assert.equal(job.inputIds.length + job.maxNewTokens, FakeEngine.contextTokens, 'the model budget is usable right up to its exact boundary');
      job.worker.answer(job, '응답');
      await translated;
      await assert.rejects(onnxhost.handle({ ...request, glossary: glossaryEntries(term, '장치'.repeat(100)) }),
        { reason: 'context-overflow', code: 'config', message: /glossary term/ });
    } finally { await finish(started, session); }
  }
});

test('empty, unmatched and unknown-source glossaries preserve the ordinary native prompt', async () => {
  const rendered: NativeTemplateOptions[] = [];
  const tokenizer = Object.assign((text: string) => codepoints(text), {
    decode: codepoints.decode,
    apply_chat_template: (messages: { content: string }[], options: NativeTemplateOptions) => {
      rendered.push(options);
      return nativeTemplate(messages, options);
    }
  });
  const session = installSession({ tokenizer });
  FakeEngine.reset();
  (globalThis as ATNamespace).Worker = FakeEngine;
  const started: Promise<unknown>[] = [];
  const glossary = glossaryEntries('GPU', '그래픽 장치');
  try {
    for (const item of [
      { text: 'CPU works.', source: 'en', glossary: undefined },
      { text: 'CPU works.', source: 'en', glossary: [] },
      { text: 'CPU works.', source: 'en', glossary },
      { text: 'GPU works.', source: undefined, glossary }
    ]) {
      const request = onnxhost.translate({ ...translateRequest(item.text), source: item.source, glossary: item.glossary });
      started.push(request);
      await until('ordinary native prompt', () => FakeEngine.inFlight.length === 1);
      const job = FakeEngine.inFlight[0]!;
      assert.equal(codepoints.decode(job.inputIds), nativeTemplate([{ content: item.text }],
        { ...(item.source ? { source_lang: item.source } : {}), target_lang: 'ko' }));
      job.worker.answer(job, '응답');
      await request;
    }
    assert.ok(rendered.every(options => !('glossary' in options)), 'do not alter template kwargs when nothing matches');
  } finally { await finish(started, session); }
});

test('a failed worker passes the same native glossary prompt to the inline session', async () => {
  const output = 'GPU 응답';
  const session = installSession({ tokenizer: nativeTokenizer, generatedText: prompt => prompt + output, previewChunks: [output] });
  FakeEngine.reset();
  (globalThis as ATNamespace).Worker = FakeEngine;
  const started: Promise<unknown>[] = [];
  const seen: string[] = [];
  try {
    const request = onnxhost.translate({
      ...translateRequest('GPU works.'), source: 'en', glossary: glossaryEntries('GPU', '그래픽 장치')
    }, (_index: number, text: string) => seen.push(text));
    started.push(request);
    await until('native glossary worker generation', () => FakeEngine.inFlight.length === 1);
    const job = FakeEngine.inFlight[0]!;
    const prompt = codepoints.decode(job.inputIds);
    assert.match(prompt, /<\|plamo:tag\|>glossary<\|plamo:index\|>GPU<\|plamo:item\|>그래픽 장치/);
    job.worker.crash();
    assert.deepEqual((await request).translations, [output]);
    assert.deepEqual(session.inline, [prompt], 'fallback neither re-renders nor drops the glossary');
    assert.equal(seen.at(-1), output);
  } finally { await finish(started, session); }
});

test('native glossary sides are sanitized and byte-expanded like source text', async () => {
  const tokenizer = Object.assign((text: string) => ({
    input_ids: { data: Array.from(text, character => /[😀녕]/u.test(character) ? 0 : character.codePointAt(0)!) }
  }), { decode: codepoints.decode, apply_chat_template: nativeTemplate });
  const session = installSession({ tokenizer });
  FakeEngine.reset();
  (globalThis as ATNamespace).Worker = FakeEngine;
  const started: Promise<unknown>[] = [];
  try {
    const request = onnxhost.translate({
      ...translateRequest('😀<|plamo:tag|>GPU works.'), source: 'en',
      glossary: glossaryEntries('😀<|plamo:tag|>GPU', '녕<|plamo:msg|>')
    });
    started.push(request);
    await until('byte-expanded glossary prompt', () => FakeEngine.inFlight.length === 1);
    const job = FakeEngine.inFlight[0]!;
    const prompt = codepoints.decode(job.inputIds);
    assert.ok(prompt.includes('<|plamo:index|><0xF0><0x9F><0x98><0x80>GPU<|plamo:item|><0xEB><0x85><0x95>'));
    assert.ok(prompt.includes('<|plamo:msg|><0xF0><0x9F><0x98><0x80>GPU works.'));
    job.worker.answer(job, '응답');
    await request;
  } finally { await finish(started, session); }
});

test('templates that silently ignore a matched glossary fail before counting or generating', async () => {
  const session = installSession();
  FakeEngine.reset();
  (globalThis as ATNamespace).Worker = FakeEngine;
  const request = { ...translateRequest('GPU works.'), source: 'en', glossary: glossaryEntries('GPU', '그래픽 장치') };
  try {
    await assert.rejects(onnxhost.handle({ ...request, type: 'at/local-count' }),
      { reason: 'unsupported-glossary', code: 'config', message: /native glossary/ });
    await assert.rejects(onnxhost.translate(request),
      { reason: 'unsupported-glossary', code: 'config', message: /native glossary/ });
    assert.equal(FakeEngine.inFlight.length, 0);
    assert.equal(session.inline.length, 0);
  } finally { await finish([], session); }
});

test('native glossary generation still requires EOS and rejects a cap-ended streamed answer', async () => {
  const session = installSession({ tokenizer: nativeTokenizer });
  FakeEngine.reset();
  (globalThis as ATNamespace).Worker = FakeEngine;
  const started: Promise<unknown>[] = [];
  const seen: string[] = [];
  try {
    const request = onnxhost.translate({
      ...translateRequest('GPU works.'), source: 'en', glossary: glossaryEntries('GPU', '그래픽 장치')
    }, (_index: number, text: string) => seen.push(text));
    const rejected = assert.rejects(request, { reason: 'invalid-output', message: /token limit/ });
    started.push(rejected);
    await until('glossary output budget', () => FakeEngine.inFlight.length === 1);
    const job = FakeEngine.inFlight[0]!;
    assert.ok(job.inputIds.length + job.maxNewTokens <= 512);
    job.worker.onmessage?.({ data: { type: 'progress', id: job.id, tokens: codepoints('GPU 응답').input_ids.data } });
    job.worker.answer(job, 'GPU 응답', 'length');
    await rejected;
    assert.deepEqual(seen, ['GPU 응답', '']);
    assert.equal(session.calls.pipelines, 0, 'a glossary never turns an incomplete native answer into a fallback retry');
  } finally { await finish(started, session); }
});

test('source planning covers lists larger than the former count limit', async () => {
  const session = installSession();
  FakeEngine.reset();
  (globalThis as ATNamespace).Worker = FakeEngine;
  const texts = Array.from({ length: 201 }, (_unused, index) => `${index}。`);
  try {
    const planned = await onnxhost.handle({
      type: 'at/local-count', modelId: 'onnx-model', texts, target: 'ko'
    });
    assert.equal(planned.counts.length, texts.length);
    assert.deepEqual(planned.sourceChunks, texts.map((text) => [text]));
  } finally {
    await finish([], session);
  }
});

test('LOCAL_COUNT cancellation stops source planning during actual tokenization', async () => {
  const controller = new AbortController();
  let afterCancellation = 0;
  const cancellingTokenizer = Object.assign((text: string, options?: { add_special_tokens?: boolean }) => {
    if (controller.signal.aborted) afterCancellation += 1;
    // Cancel while measuring the first sentence's complete rendered prompt.
    if (text === 'PROMPT:最初です。') controller.abort();
    return codepoints(text, options);
  }, { decode: codepoints.decode, apply_chat_template: codepoints.apply_chat_template });
  const session = installSession({ tokenizer: cancellingTokenizer });
  FakeEngine.reset();
  (globalThis as ATNamespace).Worker = FakeEngine;
  FakeEngine.contextTokens = 78;
  try {
    await assert.rejects(onnxhost.handle({
      type: 'at/local-count', modelId: 'onnx-model', texts: ['最初です。次です！終わり？'], target: 'ko'
    }, undefined, controller.signal), { code: 'cancelled' });
    assert.equal(controller.signal.aborted, true);
    assert.equal(afterCancellation, 0, 'planning does no tokenizer work after cancellation');
    assert.equal(session.calls.pipelines, 0);
  } finally {
    await finish([], session);
  }
});

test('concurrent worker failures share one lazy pipeline and unload releases it', async () => {
  const gate = deferred();
  const session = installSession({ beforePipeline: () => gate.promise });
  FakeEngine.reset();
  (globalThis as ATNamespace).Worker = FakeEngine;
  const started: Promise<unknown>[] = [];
  try {
    const first = onnxhost.translate(translateRequest(ASK_ONE));
    const second = onnxhost.translate(translateRequest(ASK_TWO));
    started.push(first, second);
    await until('both worker requests', () => FakeEngine.inFlight.length === 2);
    FakeEngine.made[0]!.crash();
    await until('fallback creation', () => session.calls.pipelines === 1);
    gate.resolve();
    const replies = await Promise.all([first, second]);
    assert.deepEqual(replies.map((reply) => reply.translations), [['문서'], ['문서']]);
    assert.equal(session.calls.pipelines, 1);
    assert.equal(session.inline.length, 2);
    await onnxhost.unload();
    assert.equal(session.calls.disposed, 1);
    assert.equal((await onnxhost.status()).state, 'unloaded');
  } finally {
    gate.resolve();
    await finish(started, session);
  }
});

test('unload during fallback creation discards the session before a new load', async () => {
  const gate = deferred();
  const session = installSession({ beforePipeline: () => gate.promise });
  FakeEngine.reset();
  FakeEngine.failInit = 'worker unavailable';
  (globalThis as ATNamespace).Worker = FakeEngine;
  const started: Promise<unknown>[] = [];
  try {
    const request = onnxhost.translate(translateRequest(ASK_ONE));
    const rejected = assert.rejects(request, /unloaded/);
    started.push(rejected);
    await until('fallback creation', () => session.calls.pipelines === 1);
    const unloading = onnxhost.unload();
    FakeEngine.failInit = null;
    const reloading = onnxhost.load('onnx-model', 512, 'ko');
    started.push(unloading, reloading);
    assert.equal(session.calls.tokenizers, 1, 'reload waits for the old initialization');
    gate.resolve();
    await Promise.all([rejected, unloading, reloading]);
    assert.equal(session.calls.disposed, 1, 'the stale pipeline is released');
    assert.equal(session.inline.length, 0, 'the stale request never generates');
    assert.equal(session.calls.tokenizers, 2);
    assert.equal(session.calls.pipelines, 1, 'reload remains tokenizer-only');
    assert.equal((await onnxhost.status()).state, 'ready');
  } finally {
    gate.resolve();
    await finish(started, session);
  }
});

test('unload during overlapping tokenizer and worker startup retires both before reload', async () => {
  const gate = deferred();
  const session = installSession({ beforeTokenizer: () => gate.promise });
  FakeEngine.reset();
  (globalThis as ATNamespace).Worker = FakeEngine;
  const started: Promise<unknown>[] = [];
  try {
    const loading = onnxhost.load('onnx-model', 512, 'ko');
    const rejected = assert.rejects(loading, /unloaded/);
    started.push(rejected);
    await until('tokenizer load', () => session.calls.tokenizers === 1);
    assert.equal(FakeEngine.made.length, 1, 'worker opening overlaps the blocked tokenizer');
    assert.equal((await onnxhost.status()).state, 'loading', 'worker readiness alone is not host readiness');
    const unloading = onnxhost.unload();
    started.push(unloading);
    gate.resolve();
    await Promise.all([rejected, unloading]);
    assert.equal(FakeEngine.made.length, 1);
    assert.equal(FakeEngine.made[0]!.terminated, true, 'the overlapping worker cannot survive unload');
    assert.equal(session.calls.pipelines, 0);
    assert.equal((await onnxhost.status()).state, 'unloaded');
    await onnxhost.load('onnx-model', 512, 'ko');
    assert.equal(FakeEngine.made.length, 2, 'a later load starts a fresh worker');
  } finally {
    gate.resolve();
    await finish(started, session);
  }
});

test('tokenizer completion cannot publish readiness before the overlapping GPU worker is ready', async () => {
  const session = installSession();
  FakeEngine.reset();
  FakeEngine.holdInit = true;
  (globalThis as ATNamespace).Worker = FakeEngine;
  const started: Promise<unknown>[] = [];
  try {
    let ready = false;
    const loading = onnxhost.load('onnx-model', 512, 'ko').then(() => { ready = true; });
    started.push(loading);
    await until('tokenizer and worker opened', () => session.calls.tokenizers === 1 && FakeEngine.made.length === 1);
    assert.equal(ready, false);
    assert.equal((await onnxhost.status()).state, 'loading');
    FakeEngine.made[0]!.onmessage?.({ data: { type: 'ready', ok: true, backend: 'kernels', rows: 8, contextTokens: 2048 } });
    await loading;
    assert.equal((await onnxhost.status()).state, 'ready');
    assert.equal(session.calls.pipelines, 0);
  } finally {
    for (const worker of FakeEngine.made) worker.onmessage?.({ data: { type: 'ready', ok: true, backend: 'kernels', rows: 8, contextTokens: 2048 } });
    await finish(started, session);
  }
});

test('failed tokenizer opening retires the overlapping worker and permits a fresh load', async () => {
  let failing = true;
  const session = installSession({ beforeTokenizer: async () => {
    if (failing) throw new Error('tokenizer failed');
  } });
  FakeEngine.reset();
  (globalThis as ATNamespace).Worker = FakeEngine;
  try {
    await assert.rejects(onnxhost.load('onnx-model', 512, 'ko'), /tokenizer failed/);
    assert.equal(FakeEngine.made.length, 1);
    assert.equal(FakeEngine.made[0]!.terminated, true);
    failing = false;
    await onnxhost.load('onnx-model', 512, 'ko');
    assert.equal(FakeEngine.made.length, 2);
    assert.equal((await onnxhost.status()).state, 'ready');
    assert.equal(session.calls.pipelines, 0);
  } finally {
    await finish([], session);
  }
});

test('a failed lazy pipeline can be retried by the next request', async () => {
  let fail = true;
  const session = installSession({
    beforePipeline: async () => {
      if (fail) throw new Error('session could not open');
    }
  });
  FakeEngine.reset();
  FakeEngine.failInit = 'worker unavailable';
  (globalThis as ATNamespace).Worker = FakeEngine;
  try {
    await assert.rejects(onnxhost.translate(translateRequest(ASK_ONE)), /session could not open/);
    fail = false;
    const reply = await onnxhost.translate(translateRequest(ASK_TWO));
    assert.deepEqual(reply.translations, ['문서']);
    assert.equal(session.calls.pipelines, 2);
    assert.equal(session.calls.tokenizers, 1);
  } finally {
    await finish([], session);
  }
});

for (const failure of ['open', 'warmup'] as const) {
  test(`explicit preparation rejects a failed fallback ${failure} and validates retries`, async () => {
    let reject = true;
    const fail = async () => {
      if (reject) throw new Error(`fallback ${failure} rejected`);
    };
    const session = installSession(failure === 'open' ? { beforePipeline: fail } : { beforeGenerate: fail });
    FakeEngine.reset();
    FakeEngine.failInit = 'worker unavailable';
    (globalThis as ATNamespace).Worker = FakeEngine;
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await assert.rejects(onnxhost.load('onnx-model', 512, 'ko'), new RegExp(`fallback ${failure} rejected`));
        assert.equal((await onnxhost.status()).state, 'error', 'a tokenizer is not a prepared model');
      }
      reject = false;
      const before = session.inline.length;
      assert.equal((await onnxhost.load('onnx-model', 512, 'ko')).state, 'ready');
      assert.equal(session.inline.length, before + 2, 'preparation validates both warmup shapes');
      await onnxhost.load('onnx-model', 512, 'ko');
      assert.equal(session.inline.length, before + 2, 'an already validated fallback is reused');
      assert.deepEqual((await onnxhost.translate(translateRequest(ASK_ONE))).translations, ['문서']);
      await onnxhost.unload();
      const after = session.inline.length;
      await onnxhost.load('onnx-model', 512, 'ko');
      assert.equal(session.inline.length, after + 2, 'a new session must be validated again');
    } finally {
      await finish([], session);
    }
  });
}

for (const mode of ['runtime', 'disabled'] as const) {
  test(`${mode} engine preserves eager pipeline loading and warmup`, async () => {
    const session = installSession();
    FakeEngine.reset();
    (globalThis as ATNamespace).Worker = FakeEngine;
    if (mode === 'runtime') AT.C.ENGINE_KERNELS = false;
    else AT.C.ENGINE_BATCH = 0;
    try {
      await onnxhost.load('onnx-model', 512, 'ko');
      assert.equal(session.calls.pipelines, 1);
      assert.equal(session.inline.length, 2);
      assert.equal(FakeEngine.made.length, mode === 'runtime' ? 1 : 0);
      await onnxhost.unload();
      assert.equal(session.calls.disposed, 1);
    } finally {
      await finish([], session);
    }
  });
}

test('unload releases a nonkernel pipeline that finishes opening after cancellation', async () => {
  const gate = deferred();
  const session = installSession({ beforePipeline: () => gate.promise });
  AT.C.ENGINE_KERNELS = false;
  FakeEngine.reset();
  (globalThis as ATNamespace).Worker = FakeEngine;
  const started: Promise<unknown>[] = [];
  try {
    const loading = onnxhost.load('onnx-model', 512, 'ko');
    const rejected = assert.rejects(loading, /unloaded/);
    started.push(rejected);
    await until('pipeline load', () => session.calls.pipelines === 1);
    const unloading = onnxhost.unload();
    started.push(unloading);
    gate.resolve();
    await Promise.all([rejected, unloading]);
    assert.equal(session.calls.disposed, 1);
    assert.equal(session.inline.length, 0);
    assert.equal(FakeEngine.made.length, 0);
    assert.equal((await onnxhost.status()).state, 'unloaded');
    await onnxhost.unload();
    assert.equal(session.calls.disposed, 1, 'unloading again does not dispose twice');
  } finally {
    gate.resolve();
    await finish(started, session);
  }
});

test('worker previews decode cumulative generated ids and hold incomplete Unicode tails', async () => {
  const tokenizer = Object.assign(
    (text: string) => codepoints(text),
    {
      ...codepoints,
      decode: (ids: ArrayLike<number | bigint>) => {
        const tokens = Array.from(ids).map(Number);
        if (tokens[0] === 2000001) return tokens.length === 1 ? '\uFFFD' : '녕';
        return codepoints.decode(tokens);
      }
    }
  );
  const session = installSession({ tokenizer });
  FakeEngine.reset();
  (globalThis as ATNamespace).Worker = FakeEngine;
  const seen: [number, string][] = [];
  const started: Promise<unknown>[] = [];
  try {
    const request = onnxhost.translate(translateRequest(ASK_ONE), (index: number, text: string) => seen.push([index, text]));
    started.push(request);
    await until('streaming job', () => FakeEngine.inFlight.length === 1);
    const job = jobFor(ASK_ONE);
    job.worker.onmessage?.({ data: { type: 'progress', id: job.id, tokens: [2000001] } });
    assert.deepEqual(seen, [], 'an incomplete UTF-8 sequence stays buffered');
    job.worker.onmessage?.({ data: { type: 'progress', id: job.id, tokens: [2000001, 2000002] } });
    assert.deepEqual(seen, [[0, '녕']]);
    job.worker.answer(job, '녕');
    assert.deepEqual((await request).translations, ['녕']);
    job.worker.onmessage?.({ data: { type: 'progress', id: job.id, tokens: [1, 2, 3] } });
    assert.deepEqual(seen, [[0, '녕']], 'settled ids cannot change the preview');
  } finally { await finish(started, session); }
});

test('Japanese quotes, paths and proper names survive both preview and final validation', async () => {
  const session = installSession();
  FakeEngine.reset();
  (globalThis as ATNamespace).Worker = FakeEngine;
  const started: Promise<unknown>[] = [];
  try {
    for (const answer of ['「こんにちは」는 일본어 인사입니다.', '/images/画像 경로를 사용합니다.', '夏目漱石의 작품입니다.']) {
      const seen: string[] = [];
      const request = onnxhost.translate(translateRequest(ASK_ONE), (_index: number, text: string) => seen.push(text));
      started.push(request);
      await until('single translation', () => FakeEngine.inFlight.length === 1);
      const job = jobFor(ASK_ONE);
      job.worker.onmessage?.({ data: { type: 'progress', id: job.id, tokens: codepoints(answer).input_ids.data } });
      job.worker.answer(job, answer);
      assert.deepEqual((await request).translations, [answer]);
      assert.deepEqual(seen, [answer], 'valid preview never rolls back because of its script');
      assert.equal(FakeEngine.inFlight.length, 0);
    }
  } finally { await finish(started, session); }
});

for (const mode of ['native', 'fallback'] as const) {
  test(`${mode}: an unchanged Japanese quote is not retried or rejected by script`, async () => {
    const session = installSession({ generatedText: (prompt) => prompt + 'こんにちは' });
    FakeEngine.reset();
    if (mode === 'fallback') FakeEngine.failInit = 'use document fallback';
    (globalThis as ATNamespace).Worker = FakeEngine;
    const started: Promise<unknown>[] = [];
    try {
      const request = onnxhost.translate(translateRequest(ASK_ONE));
      started.push(request);
      if (mode === 'native') {
        await until('first greedy attempt', () => FakeEngine.inFlight.length === 1);
        const job = jobFor(ASK_ONE);
        job.worker.answer(job, 'こんにちは');
      }
      assert.deepEqual((await request).translations, ['こんにちは']);
      assert.equal((await onnxhost.status()).generations, 1);
      assert.equal(FakeEngine.inFlight.length, 0);
      assert.equal(session.inline.length, mode === 'fallback' ? 1 : 0);
    } finally {
      await finish(started, session);
    }
  });
}

test('a worker crash resets its preview before streamed inline fallback, including its final flush', async () => {
  const session = installSession({
    previewChunks: ['문', '서'],
    onStreamer: (options) => {
      assert.equal(options.skip_prompt, true);
      assert.equal(options.skip_special_tokens, true);
    }
  });
  FakeEngine.reset();
  (globalThis as ATNamespace).Worker = FakeEngine;
  const seen: string[] = [];
  const started: Promise<unknown>[] = [];
  try {
    const request = onnxhost.translate(translateRequest(ASK_ONE), (_index: number, text: string) => seen.push(text));
    started.push(request);
    await until('worker job', () => FakeEngine.inFlight.length === 1);
    const job = jobFor(ASK_ONE);
    job.worker.onmessage?.({ data: { type: 'progress', id: job.id, tokens: ['반'.codePointAt(0)] } });
    job.worker.crash();
    assert.deepEqual((await request).translations, ['문서']);
    assert.deepEqual(seen, ['반', '', '문', '문서']);
  } finally { await finish(started, session); }
});

test('streaming does not turn invalid final output into success and clears the visible prefix', async () => {
  const session = installSession({ previewChunks: ['문서'], generatedText: (prompt) => prompt + '문서<pad>' });
  FakeEngine.reset();
  FakeEngine.failInit = 'use document fallback';
  (globalThis as ATNamespace).Worker = FakeEngine;
  const seen: string[] = [];
  const started: Promise<unknown>[] = [];
  try {
    const request = onnxhost.translate(translateRequest(ASK_ONE), (_index: number, text: string) => seen.push(text));
    started.push(request);
    await assert.rejects(request, { reason: 'invalid-output' });
    assert.deepEqual(seen, ['문서', '']);
    assert.equal(session.inline.length, 1, 'invalid final output is not retried into apparent success');
  } finally { await finish(started, session); }
});

test('native batches keep source ownership through out-of-order completion and slot refill', async () => {
  const session = installSession();
  FakeEngine.reset();
  FakeEngine.backend = 'kernels';
  FakeEngine.rows = 3;
  (globalThis as ATNamespace).Worker = FakeEngine;
  const texts = ['Source alpha.', 'Source bravo.', 'Source charlie.', 'Source delta.', 'Source echo.'];
  const answers = ['첫째 번역', '둘째 번역', '셋째 번역', '넷째 번역', '다섯째 번역'];
  const seen: [number, string][] = [];
  const started: Promise<unknown>[] = [];
  const controller = new AbortController();
  try {
    const request = onnxhost.translate({ ...translateRequest(texts[0]!), texts },
      (index: number, text: string) => seen.push([index, text]), controller.signal);
    started.push(request);
    await until('three source jobs', () => FakeEngine.inFlight.length === 3);
    const second = jobFor(texts[1]!);
    second.worker.onmessage?.({
      data: { type: 'progress', id: second.id, tokens: Array.from('둘째').map((ch) => ch.codePointAt(0)) }
    });
    second.worker.answer(second, answers[1]!);
    await until('free slot refilled before first source completes', () =>
      FakeEngine.inFlight.some((job) => codepoints.decode(job.inputIds).includes(texts[3]!)));
    assert.equal(FakeEngine.inFlight.length, 3);
    const fourth = jobFor(texts[3]!);
    fourth.worker.answer(fourth, answers[3]!);
    await until('last source admitted', () =>
      FakeEngine.inFlight.some((job) => codepoints.decode(job.inputIds).includes(texts[4]!)));
    for (const index of [4, 2, 0]) {
      const job = jobFor(texts[index]!);
      job.worker.answer(job, answers[index]!);
    }
    assert.deepEqual((await request).translations, answers);
    assert.deepEqual(seen, [[1, '둘째']], 'progress uses original source indexes, not completion order');
    assert.equal(session.inline.length, 0);
  } finally { controller.abort(); await finish(started, session); }
});

for (const cause of ['cancel', 'invalid-output'] as const) {
  test(`native batch ${cause} releases its sibling rows without touching another request`, async () => {
    const session = installSession();
    FakeEngine.reset();
    FakeEngine.backend = 'kernels';
    FakeEngine.rows = 4;
    (globalThis as ATNamespace).Worker = FakeEngine;
    const controller = new AbortController();
    const texts = ['Batch alpha.', 'Batch bravo.', 'Batch charlie.', 'Batch delta.', 'Batch echo.'];
    const seen: string[] = [];
    const started: Promise<unknown>[] = [];
    try {
      const request = onnxhost.translate({ ...translateRequest(texts[0]!), texts },
        (_index: number, text: string) => seen.push(text), controller.signal);
      const rejected = assert.rejects(request, cause === 'cancel' ? { code: 'cancelled' } : { reason: 'invalid-output' });
      const survivor = onnxhost.translate(translateRequest('Independent survivor.'));
      started.push(rejected, survivor);
      await until('batch and independent request admitted', () => FakeEngine.inFlight.length === 5);
      const siblings = texts.slice(0, 4).map(jobFor);
      if (cause === 'cancel') controller.abort();
      else siblings[0]!.worker.answer(siblings[0]!, '잘못된 출력<pad>');
      await rejected;
      await until('batch rows released', () => FakeEngine.inFlight.length === 1);
      assert.deepEqual([...FakeEngine.dropped].sort((a, b) => a - b),
        siblings.slice(cause === 'cancel' ? 0 : 1).map((job) => job.id).sort((a, b) => a - b));
      for (const job of siblings) job.worker.onmessage?.({
        data: { type: 'progress', id: job.id, tokens: [0xD55C] }
      });
      const remaining = jobFor('Independent survivor.');
      remaining.worker.answer(remaining, '독립된 번역');
      assert.deepEqual((await survivor).translations, ['독립된 번역']);
      assert.deepEqual(seen, [], 'settled batch cannot emit late previews');
      assert.equal(session.calls.pipelines, 0);
    } finally { controller.abort(); await finish(started, session); }
  });
}

test('serial runtime uses the same independent prompt and preview protocol as native rows', async () => {
  const session = installSession();
  FakeEngine.reset();
  (globalThis as ATNamespace).Worker = FakeEngine;
  const seen: [number, string][] = [];
  const started: Promise<unknown>[] = [];
  try {
    const request = onnxhost.translate({ ...translateRequest(ASK_ONE), texts: [ASK_ONE, ASK_TWO] },
      (index: number, text: string) => seen.push([index, text]));
    started.push(request);
    for (const [index, source] of [ASK_ONE, ASK_TWO].entries()) {
      await until('independent runtime prompt', () => FakeEngine.inFlight.length === 1);
      const job = jobFor(source);
      assert.equal(codepoints.decode(job.inputIds), `PROMPT:${source}`);
      job.worker.onmessage?.({ data: { type: 'progress', id: job.id, tokens: codepoints(`번역${index}`).input_ids.data } });
      job.worker.answer(job, `번역${index}`);
    }
    assert.deepEqual((await request).translations, ['번역0', '번역1']);
    assert.deepEqual(seen, [[0, '번역0'], [1, '번역1']]);
    assert.equal((await onnxhost.status()).generations, 2);
  } finally { await finish(started, session); }
});

test('cancelling a native request drops only its row, ignores late frames and never falls back', async () => {
  const session = installSession();
  FakeEngine.reset();
  (globalThis as ATNamespace).Worker = FakeEngine;
  const controller = new AbortController();
  const previews: string[] = [];
  const started: Promise<unknown>[] = [];
  try {
    const cancelled = onnxhost.translate(translateRequest(ASK_ONE), (_index: number, text: string) => previews.push(text), controller.signal);
    const rejected = assert.rejects(cancelled, { code: 'cancelled' });
    const survivor = onnxhost.translate(translateRequest(ASK_TWO));
    started.push(rejected, survivor);
    await until('two independent native jobs', () => FakeEngine.inFlight.length === 2);
    const first = jobFor(ASK_ONE);
    const second = jobFor(ASK_TWO);
    controller.abort();
    await rejected;
    assert.deepEqual(FakeEngine.dropped, [first.id]);
    assert.equal(FakeEngine.inFlight.length, 1);
    first.worker.onmessage?.({ data: { type: 'progress', id: first.id, tokens: [0xD55C] } });
    first.worker.answer(first, '늦은 응답');
    second.worker.answer(second, '둘째');
    assert.deepEqual((await survivor).translations, ['둘째']);
    assert.deepEqual(previews, []);
    assert.equal(session.calls.pipelines, 0, 'cancellation never opens fallback');
    assert.equal(first.worker.terminated, false, 'the shared model stays resident');
    controller.abort();
    assert.equal(FakeEngine.dropped.length, 1, 'cleanup happens only once');
  } finally {
    await finish(started, session);
  }
});

test('preaborted host requests do not load and abort during loading never admits generation', async () => {
  const gate = deferred();
  const session = installSession({ beforeTokenizer: () => gate.promise });
  FakeEngine.reset();
  (globalThis as ATNamespace).Worker = FakeEngine;
  const controller = new AbortController();
  const started: Promise<unknown>[] = [];
  try {
    const preaborted = new AbortController();
    preaborted.abort();
    await assert.rejects(onnxhost.translate(translateRequest(ASK_ONE), undefined, preaborted.signal), { code: 'cancelled' });
    assert.equal(session.calls.tokenizers, 0);
    const cancelled = assert.rejects(onnxhost.translate(translateRequest(ASK_ONE), undefined, controller.signal), { code: 'cancelled' });
    started.push(cancelled);
    await until('shared tokenizer loading', () => session.calls.tokenizers === 1);
    controller.abort();
    await cancelled;
    assert.equal(FakeEngine.made.length, 1);
    assert.equal(FakeEngine.made[0]!.terminated, false, 'one caller cannot cancel shared worker startup');
    gate.resolve();
    const survivor = onnxhost.translate(translateRequest(ASK_TWO));
    started.push(survivor);
    await until('only surviving job admitted', () => FakeEngine.inFlight.length === 1);
    const job = jobFor(ASK_TWO);
    job.worker.answer(job, '둘째');
    await survivor;
    assert.equal(FakeEngine.dropped.length, 0, 'no cancelled row was ever admitted');
    assert.equal(session.calls.tokenizers, 1, 'shared initialization survives cancellation');
  } finally {
    gate.resolve();
    await finish(started, session);
  }
});

test('a cancelled count queued behind loading never loads its requested model', async () => {
  const gate = deferred();
  const session = installSession({ beforeTokenizer: () => gate.promise });
  FakeEngine.reset();
  (globalThis as ATNamespace).Worker = FakeEngine;
  const controller = new AbortController();
  const started: Promise<unknown>[] = [];
  try {
    const loading = onnxhost.handle({ type: 'at/local-load', modelId: 'onnx-model', target: 'ko' });
    started.push(loading);
    await until('load owns the tokenizer queue', () => session.calls.tokenizers === 1);
    const counting = assert.rejects(onnxhost.handle({
      type: 'at/local-count', modelId: 'cancelled-other-model', texts: [ASK_TWO], target: 'ko'
    }, undefined, controller.signal), { code: 'cancelled' });
    started.push(counting);
    controller.abort();
    await counting;
    gate.resolve();
    await loading;
    await onnxhost.handle({ type: 'at/local-count', modelId: 'onnx-model', texts: [ASK_ONE], target: 'ko' });
    assert.equal(session.calls.tokenizers, 1);
    assert.equal(session.inline.length, 0);
    assert.equal(FakeEngine.inFlight.length, 0);
  } finally {
    gate.resolve();
    await finish(started, session);
  }
});

test('inline cancellation is prompt but retains serialization until the real kernel settles', async () => {
  const gate = deferred();
  const session = installSession({ beforeGenerate: () => gate.promise });
  FakeEngine.reset();
  FakeEngine.failInit = 'worker unavailable';
  (globalThis as ATNamespace).Worker = FakeEngine;
  const firstController = new AbortController();
  const queuedController = new AbortController();
  const started: Promise<unknown>[] = [];
  try {
    const first = assert.rejects(onnxhost.translate(translateRequest(ASK_ONE), undefined, firstController.signal), { code: 'cancelled' });
    started.push(first);
    await until('inline kernel running', () => session.inline.length === 1);
    const queued = assert.rejects(onnxhost.translate(translateRequest(ASK_TWO), undefined, queuedController.signal), { code: 'cancelled' });
    started.push(queued);
    firstController.abort();
    queuedController.abort();
    await Promise.all([first, queued]);
    assert.equal((await onnxhost.status()).state, 'busy', 'pending kernel is not reported as stopped');
    const survivor = onnxhost.translate(translateRequest('하나요'));
    started.push(survivor);
    assert.equal(session.inline.length, 1);
    gate.resolve();
    assert.deepEqual((await survivor).translations, ['문서']);
    assert.equal(session.inline.length, 2, 'cancelled queued work never calls the pipeline');
    assert.equal(FakeEngine.dropped.length, 0, 'inline cancellation does not pretend to DROP a GPU job');
  } finally {
    gate.resolve();
    await finish(started, session);
  }
});

test('one template policy names only the requested languages on both sides of 40 characters', async () => {
  const rendered: { content: string; options: Record<string, unknown> }[] = [];
  const tokenizer = Object.assign((text: string) => codepoints(text), {
    decode: codepoints.decode,
    apply_chat_template(messages: { content: string }[], options: Record<string, unknown> = {}) {
      const content = messages[0]!.content;
      rendered.push({ content, options });
      return `PROMPT:${options.source_lang ?? ''}:${options.target_lang}:${content}`;
    }
  });
  const session = installSession({ tokenizer });
  FakeEngine.reset();
  (globalThis as ATNamespace).Worker = FakeEngine;
  const started: Promise<unknown>[] = [];
  try {
    for (const length of [39, 40, 75]) {
      const source = 'あ'.repeat(length - 1) + '。';
      const request = onnxhost.translate({ ...translateRequest(source), source: 'ja', target: 'zh-TW' });
      started.push(request);
      await until('language-conditioned request', () => FakeEngine.inFlight.length === 1);
      const job = jobFor(source);
      job.worker.answer(job, '翻譯完成。');
      assert.deepEqual((await request).translations, ['翻譯完成。']);
    }
    assert.equal(rendered.length, 3, 'no alternate prompt or greedy retry');
    for (const { options } of rendered) assert.deepEqual(options,
      { source_lang: 'ja', target_lang: 'zh-hant', add_generation_prompt: true, tokenize: false });
  } finally { await finish(started, session); }
});

test('emoji byte-token cost raises the reserve and clean cap-ended output is rejected', async () => {
  const tokenizer = Object.assign((text: string) => ({
    input_ids: { data: Array.from(text).flatMap(character =>
      Array(character === '😀' ? 4 : 1).fill(character.codePointAt(0))) }
  }), { decode: codepoints.decode, apply_chat_template: codepoints.apply_chat_template });
  const session = installSession({ tokenizer });
  FakeEngine.reset();
  (globalThis as ATNamespace).Worker = FakeEngine;
  const started: Promise<unknown>[] = [];
  const source = '😀'.repeat(14) + '【よくある質問】';
  const seen: string[] = [];
  try {
    const request = onnxhost.translate(translateRequest(source), (_index: number, text: string) => seen.push(text));
    const rejected = assert.rejects(request, { reason: 'invalid-output', message: /token limit/ });
    started.push(rejected);
    await until('emoji generation', () => FakeEngine.inFlight.length === 1);
    const job = FakeEngine.inFlight[0]!;
    assert.equal(job.maxNewTokens, local.answerTokens(tokenizer(source).input_ids.data.length));
    assert.ok(job.maxNewTokens > 64);
    assert.ok(job.inputIds.length + job.maxNewTokens <= 512);
    const partial = '😀'.repeat(14) + '【자주 묻';
    job.worker.onmessage?.({ data: { type: 'progress', id: job.id, tokens: codepoints(partial).input_ids.data } });
    job.worker.answer(job, partial, 'length');
    await rejected;
    assert.deepEqual(seen, [partial, '']);
    assert.equal(session.calls.pipelines, 0, 'a cap is not a reason to change backend or retry');
  } finally { await finish(started, session); }
});

test('inline fallback also rejects unfinished output and clears its preview', async () => {
  const session = installSession({ finishReason: 'length', previewChunks: ['자주 묻'], generatedText: prompt => prompt + '자주 묻' });
  FakeEngine.reset();
  FakeEngine.failInit = 'worker unavailable';
  (globalThis as ATNamespace).Worker = FakeEngine;
  const seen: string[] = [];
  try {
    await assert.rejects(onnxhost.translate(translateRequest(ASK_ONE), (_index: number, text: string) => seen.push(text)),
      { reason: 'invalid-output', message: /end token/ });
    assert.equal(seen.at(-1), '');
    assert.equal(session.inline.length, 1);
  } finally { await finish([], session); }
});

test('large input plans preserve sentences against the actual execution context, not source64', async () => {
  const session = installSession();
  FakeEngine.reset();
  FakeEngine.contextTokens = 512;
  (globalThis as ATNamespace).Worker = FakeEngine;
  try {
    const sentence = 'あ'.repeat(74) + '。';
    const source = sentence.repeat(200);
    const result = await onnxhost.handle({
      type: 'at/local-count', modelId: 'onnx-model', maxTokens: 8192, target: 'ko', source: 'ja', texts: [sentence, source]
    });
    assert.deepEqual(result.sourceChunks[0], [sentence], 'a fitting sentence over 64 tokens stays intact');
    const fragments: string[] = result.sourceChunks[1];
    assert.equal(fragments.join(''), source);
    assert.equal(fragments.length, 200);
    for (const fragment of fragments) {
      assert.equal(fragment, sentence);
      assert.ok(codepoints(`PROMPT:${fragment}`).input_ids.data.length + local.answerTokens(fragment.length) <= 512);
    }
    assert.equal(FakeEngine.inFlight.length, 0);
    assert.equal(session.calls.pipelines, 0);
  } finally { await finish([], session); }
});

test('the model context and configured total budget both constrain exact source planning', async () => {
  const session = installSession();
  FakeEngine.reset();
  (globalThis as ATNamespace).Worker = FakeEngine;
  onnxhost.configure({ modelFiles: async (name: string) => new Blob([JSON.stringify(
    name === 'config.json' ? { max_position_embeddings: 256, eos_token_id: 1 } : { eos_token_id: 1 }
  )]) });
  const source = 'あいうえお。'.repeat(40);
  try {
    for (const maxTokens of [128, 8192]) {
      const result = await onnxhost.handle({
        type: 'at/local-count', modelId: 'onnx-model', maxTokens, target: 'ko', texts: [source]
      });
      assert.equal(result.sourceChunks[0].join(''), source);
      for (const fragment of result.sourceChunks[0]) {
        assert.ok(fragment.endsWith('。'), 'fitting sentence boundaries are retained');
        assert.ok(codepoints(`PROMPT:${fragment}`).input_ids.data.length + local.answerTokens(fragment.length)
          <= Math.min(maxTokens, 256));
      }
    }
    assert.equal(session.calls.pipelines, 0);
  } finally { await finish([], session); }
});

test('structural repetition still fails without retry after script restrictions are removed', async () => {
  const session = installSession();
  FakeEngine.reset();
  (globalThis as ATNamespace).Worker = FakeEngine;
  const started: Promise<unknown>[] = [];
  try {
    const request = onnxhost.translate(translateRequest(ASK_ONE));
    const rejected = assert.rejects(request, { reason: 'invalid-output' });
    started.push(rejected);
    await until('single translation', () => FakeEngine.inFlight.length === 1);
    const job = FakeEngine.inFlight[0]!;
    job.worker.answer(job, '반복되는 문장입니다. '.repeat(20));
    await rejected;
    assert.equal(FakeEngine.inFlight.length, 0);
    assert.equal(session.calls.pipelines, 0);
  } finally { await finish(started, session); }
});

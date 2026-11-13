/// <reference lib="es2024.promise" />
import test from 'node:test';
import assert from 'node:assert/strict';
import { load, type ATNamespace } from './helpers.ts';

const AT = load('lib/constants.js', 'lib/plamo3.js', 'lib/local.js', 'lib/modelstore.js', 'lib/pipelinehost.js', 'lib/onnxhost.js');
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

test('modelKind classifies onnx files and files the runtime must judge', () => {
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
      pipeline: async () => async (prompt: string) => {
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
      queueMicrotask(() => {
        this.onmessage?.({
          data: failure
            ? { type: 'ready', ok: false, error: failure, code: 'worker-init' }
            : { type: 'ready', ok: true }
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
  answer(job: EngineJob, text: string): void {
    FakeEngine.inFlight = FakeEngine.inFlight.filter((entry) => entry !== job);
    const tokens = Array.from(text).map((character) => character.codePointAt(0) ?? 0);
    this.onmessage?.({ data: { type: 'result', id: job.id, ok: true, tokens } });
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
codepoints.apply_chat_template = (messages: { content: string }[]) => `PROMPT:${messages[0]?.content ?? ''}`;

/** The document's runtime seam records session creation separately from generation. */
function installSession(options: {
  beforeTokenizer?: () => Promise<void>;
  beforePipeline?: () => Promise<void>;
  beforeGenerate?: () => Promise<void>;
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
      AutoTokenizer: {
        from_pretrained: async () => {
          calls.tokenizers += 1;
          await options.beforeTokenizer?.();
          return codepoints;
        }
      },
      pipeline: async () => {
        calls.pipelines += 1;
        await options.beforePipeline?.();
        const pipe = async (prompt: string) => {
          inline.push(prompt);
          await options.beforeGenerate?.();
          return [{ generated_text: `${prompt}문서` }];
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
    assert.equal(session.calls.tokenizers, 1);
    assert.equal(session.calls.pipelines, 0);
    assert.equal(session.inline.length, 0);
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

test('unload cancels an initial tokenizer load without starting a worker', async () => {
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
    const unloading = onnxhost.unload();
    started.push(unloading);
    gate.resolve();
    await Promise.all([rejected, unloading]);
    assert.equal(FakeEngine.made.length, 0);
    assert.equal(session.calls.pipelines, 0);
    assert.equal((await onnxhost.status()).state, 'unloaded');
    await onnxhost.load('onnx-model', 512, 'ko');
    assert.equal(FakeEngine.made.length, 1, 'a later load can start normally');
  } finally {
    gate.resolve();
    await finish(started, session);
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

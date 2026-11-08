import test from 'node:test';
import assert from 'node:assert/strict';
import { load, deferred } from './helpers.ts';

// The host is the only module that touches the inference runtime, and until now
// it had no suite at all: everything above it is tested against a fake reply.
// These cases drive the real host against a fake runtime, so what is asserted is
// the host's own decisions — what it asks the runtime for, when it gives up, and
// what it tells the background afterwards.
const AT = load('lib/constants.js', 'lib/plamo3.js', 'lib/local.js', 'lib/localhost.js');
const { local, localhost } = AT;

AT.log = () => {};
AT.warn = () => {};
AT.getURL = (path: string) => `chrome-extension://test/${path}`;

/** What one runtime instance did, in order. */
type Call =
  | { kind: 'load'; blobs: unknown[]; params: Record<string, unknown> }
  | { kind: 'generate'; options: Record<string, unknown> }
  | { kind: 'exit' };

type Behaviour = {
  /** Reply for the next generation; a function may read the prompt. */
  reply: ((prompt: string, index: number) => string) | string;
  promptTokens: number | 'double' | null;
  loaded: boolean;
  webgpu: boolean;
  /** Never settle: only the host's own timer may end the run. */
  hang: boolean;
  /** Reject the runtime's own load, the way a bad file does. */
  failLoad: boolean;
  onAbort?: () => void;
};

let behaviour: Behaviour;
let calls: Call[];
let instances: number;

function resetBehaviour(over: Partial<Behaviour> = {}): void {
  behaviour = {
    reply: '번역',
    promptTokens: null,
    loaded: true,
    webgpu: true,
    hang: false,
    failLoad: false,
    ...over
  };
}

class FakeWllama {
  readonly paths: Record<string, string>;
  readonly config: Record<string, unknown>;
  loaded = false;

  constructor(paths: Record<string, string>, config: Record<string, unknown>) {
    instances += 1;
    this.paths = paths;
    this.config = config;
  }

  async loadModel(blobs: unknown[], params: Record<string, unknown>): Promise<void> {
    calls.push({ kind: 'load', blobs, params: { ...params } });
    if (behaviour.failLoad) throw new Error('gguf: bad tensor');
    this.loaded = behaviour.loaded;
  }

  /** The host asks for a raw completion: it hands over the finished PFML3
   *  prompt and reads `choices[].text` back, so every generation the host made
   *  lands in `calls` as one `generate` record the cases below assert on. */
  private async respond(options: Record<string, unknown>, prompt: string): Promise<unknown> {
    calls.push({ kind: 'generate', options: { ...options, prompt } });
    const signal = options.abortSignal as AbortSignal | undefined;
    if (behaviour.hang) {
      // A runtime that stopped answering. It settles only when the host aborts
      // it, which is what makes the abort observable and leaves nothing pending
      // in the process when the case is over.
      // The test compile targets an older lib than the extension's own, so this
      // one place is written in the executor form.
      return await new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          behaviour.onAbort?.();
          reject(new Error('aborted by signal'));
        });
      });
    }
    const index = calls.filter((call) => call.kind === 'generate').length - 1;
    const content = typeof behaviour.reply === 'function' ? behaviour.reply(prompt, index) : behaviour.reply;
    return {
      choices: [{ text: content, finish_reason: 'stop' }],
      usage:
        behaviour.promptTokens === null
          ? undefined
          : {
              // 'double' reports what the model's own tokenizer would have said
              // for this prompt, twice: the host is meant to notice and learn.
              prompt_tokens:
                behaviour.promptTokens === 'double'
                  ? 2 * local.rawEstimateTokens(prompt)
                  : behaviour.promptTokens
            }
    };
  }

  async createCompletion(options: Record<string, unknown>): Promise<unknown> {
    return await this.respond(options, String(options.prompt ?? ''));
  }

  isModelLoaded(): boolean {
    return this.loaded;
  }

  isSupportWebGPU(): boolean {
    return behaviour.webgpu;
  }

  getChatTemplate(): string | null {
    return null;
  }

  getLoadedContextInfo(): { n_ctx: number } {
    return { n_ctx: Number(this.params?.n_ctx) || 0 };
  }

  get params(): Record<string, unknown> | undefined {
    const last = [...calls].reverse().find((call) => call.kind === 'load') as Call | undefined;
    return last && last.kind === 'load' ? last.params : undefined;
  }

  async exit(): Promise<void> {
    calls.push({ kind: 'exit' });
    this.loaded = false;
  }
}

const MODEL_ID = 'plamo-3-translate-0.8b-q4_k_m-1';
const STORED = { id: MODEL_ID, name: 'plamo-3-translate-0.8b-Q4_K_M.gguf', size: 573_125_952 };

/** A second installed file - the same card's other quantization - so one case
 *  can watch the host free one graph before the next arrives. */
const OTHER_ID = 'plamo-3-translate-0.8b-bf16-2';
const OTHER_STORED = { id: OTHER_ID, name: 'plamo-3-translate-0.8b-BF16.gguf', size: 1_783_495_808 };

let stored: Record<string, unknown> | null = STORED;
let readBlobs: unknown[] = [];
AT.modelstore = {
  async get(id: string) {
    return stored && stored.id === id ? stored : null;
  },
  async read(id: string) {
    if (!stored || stored.id !== id) return null;
    const blob = { name: String(stored.name), size: Number(stored.size) };
    readBlobs.push(blob);
    return blob;
  }
};

const statuses: Record<string, unknown>[] = [];
let moduleLoads = 0;
localhost.configure({
  async loadModule(url: string) {
    moduleLoads += 1;
    assert.equal(url, 'chrome-extension://test/vendor/wllama/index.js', 'the vendored runtime, never a CDN');
    return { Wllama: FakeWllama, LoggerWithoutDebug: { debug: () => {} } };
  }
});
localhost.install('offscreen', (status: Record<string, unknown>) => statuses.push({ ...status }));

const navigatorStub = () => {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: { gpu: { requestAdapter: async () => ({}) } }
  });
};
const noNavigatorGpu = () => {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: { gpu: undefined }
  });
};

// The same entry every caller uses: `callHost` adds the `ok`/`code` envelope the
// host itself never speaks in, so these cases assert what the background sees.
local.setHostPlacement('background');
const send = (message: Record<string, unknown>) => local.callHost(message);

/** Wait for a condition on the event loop instead of guessing how long it takes;
 *  a failure then names the condition that never became true. */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 1000 && !condition(); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(condition(), what);
}

/** The text the host put inside the prompt's own `input` element. */
function inputOf(prompt: string): string {
  return /<\|plamo:tag\|>input<\|plamo:msg\|>([\s\S]*?)<\|plamo:tag\|>output/.exec(prompt)?.[1] ?? '';
}

const loaded = async (modelId = MODEL_ID) => {
  navigatorStub();
  resetBehaviour();
  const reply = await send({ type: 'at/local-load', modelId, maxTokens: 1024, target: 'ko' });
  assert.equal(reply.ok, true, JSON.stringify(reply.error));
  return reply.status as Record<string, unknown>;
};

test.beforeEach(async () => {
  // Every case starts with nothing resident: the host keeps one instance for
  // the whole module, and a model left loaded by the previous case would answer
  // from memory instead of going through the store and the runtime.
  await localhost.unload('test');
  calls = [];
  instances = 0;
  readBlobs = [];
  stored = STORED;
  resetBehaviour();
  navigatorStub();
});

test('a browser without WebGPU is reported, not thrown', async () => {
  noNavigatorGpu();
  const status = (await send({ type: 'at/local-query' })).status as Record<string, unknown>;
  assert.equal(status.supported, false);
  assert.equal(status.reason, 'no-webgpu', 'the reason the options page shows before a download');
  assert.equal(status.state, 'error');
});

test('the probe is answered once and the host then stays ready to load', async () => {
  const status = (await send({ type: 'at/local-query' })).status as Record<string, unknown>;
  assert.equal(status.supported, true);
  assert.equal(status.state, 'unloaded');
  assert.equal(status.target, 'offscreen', 'the placement the reporter was installed with');
});

test('loading asks the runtime for the model the card publishes', async () => {
  const status = await loaded();
  assert.equal(status.state, 'ready');
  assert.equal(status.modelId, MODEL_ID);
  assert.equal(status.modelName, STORED.name);
  assert.equal(status.loadedBytes, STORED.size);
  assert.equal(typeof status.loadMs, 'number');
  assert.equal(moduleLoads, 1, 'the runtime module is imported once for the whole session');

  const load = calls.find((call) => call.kind === 'load') as Extract<Call, { kind: 'load' }>;
  assert.deepEqual(load.blobs, [readBlobs[0]], 'the bytes come out of OPFS as one blob, not a refetch');
  assert.equal(
    load.params.chat_template,
    AT.plamo3.PASS_THROUGH_TEMPLATE,
    'the prompt is handed over as it was built, with no template of the file rendering it'
  );
  assert.equal(load.params.n_ctx, local.contextTokens(1024));
  assert.equal(load.params.n_threads, 1, 'an extension page has no SharedArrayBuffer for more');
  assert.equal(load.params.n_gpu_layers, -1, 'the whole model goes to WebGPU or the run is not usable');
  assert.equal(load.params.flash_attn, true);
  assert.ok(Number(load.params.n_batch) <= Number(load.params.n_ctx), 'llama.cpp refuses n_batch over n_ctx');
});

test('a model that is not in the store is a configuration failure', async () => {
  stored = null;
  const reply = await send({ type: 'at/local-load', modelId: MODEL_ID, maxTokens: 1024, target: 'ko' });
  assert.equal(reply.ok, false);
  assert.equal(reply.code, 'config');
  assert.match(String(reply.error), /not stored/);
});

test('a file the runtime cannot read keeps its own reason', async () => {
  behaviour.failLoad = true;
  const reply = await send({ type: 'at/local-load', modelId: MODEL_ID, maxTokens: 1024, target: 'ko' });
  assert.equal(reply.ok, false);
  assert.equal(reply.code, 'provider');
  assert.match(String(reply.error), /bad tensor/, 'the loader said what failed');
  const status = (await send({ type: 'at/local-query' })).status as Record<string, unknown>;
  assert.equal(status.state, 'error', 'the failure stays visible until a load succeeds');
  assert.equal(
    calls.filter((call) => call.kind === 'exit').length,
    1,
    'the half-loaded runtime was released, not dropped with its bytes still mapped'
  );
});

test('a runtime without a WebGPU device says so at load', async () => {
  behaviour.webgpu = false;
  const reply = await send({ type: 'at/local-load', modelId: MODEL_ID, maxTokens: 1024, target: 'ko' });
  assert.equal(reply.ok, false);
  assert.equal(reply.code, 'config');
  assert.equal(calls.some((call) => call.kind === 'exit'), true, 'the dead instance is released');
});

test('a warm-up that fails still leaves a usable model', async () => {
  navigatorStub();
  resetBehaviour();
  let first = true;
  behaviour.reply = () => {
    if (first) {
      first = false;
      throw new Error('warm-up exploded');
    }
    return '번역';
  };
  const status = (await send({ type: 'at/local-load', modelId: MODEL_ID, maxTokens: 1024, target: 'ko' })).status;
  assert.equal((status as Record<string, unknown>).state, 'ready', 'the first answer is slow, not required');
});

test('several texts are one numbered generation', async () => {
  await loaded();
  const texts = ['Hello', 'Good morning', 'Thank you'];
  resetBehaviour({
    reply: (prompt) =>
      inputOf(prompt).includes('2. Good morning')
        ? '1: 안녕하세요\n2: 좋은 아침입니다\n3: 감사합니다'
        : '번역'
  });
  calls = [];
  const reply = await send({ type: 'at/local-translate', modelId: MODEL_ID, texts, target: 'ko', maxTokens: 1024 });
  assert.deepEqual(reply.translations, ['안녕하세요', '좋은 아침입니다', '감사합니다']);
  const generations = calls.filter((call) => call.kind === 'generate');
  assert.equal(generations.length, 1, 'the batch is the point of the numbered shape');
  const options = generations[0] as Extract<Call, { kind: 'generate' }>;
  assert.equal(options.options.prompt, local.buildEngineBatch('ko', texts, null));
  assert.equal(options.options.stream, false);
  assert.deepEqual(
    Object.keys(options.options).sort().join(','),
    'abortSignal,cache_prompt,max_tokens,penalty_repeat,prompt,seed,stop,stream,temp,top_k,top_p',
    'exactly the knobs the host controls, nothing inherited by accident'
  );
  assert.equal(options.options.temp, local.BATCH_SAMPLING.temp, 'a numbered reply stays greedy');
});

test('page context reaches the prompt in its own element', async () => {
  await loaded();
  calls = [];
  const reply = await send({
    type: 'at/local-translate',
    modelId: MODEL_ID,
    texts: ['Hello'],
    target: 'ko',
    maxTokens: 1024,
    context: 'This is a product page from Example Shop.'
  });
  assert.deepEqual(reply.translations, ['번역']);
  const options = calls.find((call) => call.kind === 'generate') as Extract<Call, { kind: 'generate' }>;
  assert.equal(options.options.prompt, local.buildEngineBatch('ko', ['Hello'], 'This is a product page from Example Shop.'));
  assert.ok(
    String(options.options.prompt).includes(
      '<|plamo:tag|>context<|plamo:msg|>This is a product page from Example Shop.'
    ),
    'the page line rides in the element the model reads as context'
  );
});

test('a text the model never answers is given up on after two tries', async () => {
  await loaded();
  resetBehaviour({ reply: '   ' });
  calls = [];
  const reply = await send({
    type: 'at/local-translate',
    modelId: MODEL_ID,
    texts: ['응답이 없는 문장'],
    target: 'en',
    maxTokens: 1024,
    context: 'These are sidebar notes.'
  });
  assert.deepEqual(reply.translations, [''], 'no answer, so the page keeps the node for a later pass');
  assert.equal(calls.filter((call) => call.kind === 'generate').length, 2, 'with the page line, without it, then stop');
});

test('an answer that collapsed into one syllable is asked about once more', async () => {
  await loaded();
  const source =
    'The digastric muscle is involved in any complex jaw action such as speaking, swallowing, chewing and breathing';
  const healthy = 'The digastric muscle takes part in jaw actions such as speaking and swallowing.';
  resetBehaviour({
    reply: (prompt) => (String(prompt).includes('This is an anatomy page.') ? healthy : '근'.repeat(971))
  });
  calls = [];
  const reply = await send({
    type: 'at/local-translate',
    modelId: MODEL_ID,
    texts: [source],
    target: 'ko',
    maxTokens: 1024,
    context: 'This is an anatomy page.'
  });
  assert.deepEqual(reply.translations, [healthy]);
  const asks = calls.filter((call) => call.kind === 'generate') as Extract<Call, { kind: 'generate' }>[];
  assert.equal(asks.length, 2, 'the collapse is worth exactly one more generation');
  assert.ok(!String(asks[0]!.options.prompt).includes('This is an anatomy page.'), 'the long text is asked plainly first');
  assert.ok(String(asks[1]!.options.prompt).includes('This is an anatomy page.'), 'the retry brings the page line back');
  assert.equal(asks[0]!.options.penalty_repeat, local.SAMPLING.repeatPenalty, 'the first ask is the card decoding');
  assert.equal(asks[1]!.options.penalty_repeat, local.RETRY_SAMPLING.repeatPenalty, 'the retry pushes on repetition');
  assert.notEqual(
    asks[1]!.options.penalty_repeat,
    asks[0]!.options.penalty_repeat,
    'the same seeded decoding would answer the same way'
  );
});

test('a long text is asked plainly, without paying for the page line', async () => {
  await loaded();
  const source =
    'The linker had been asked to resolve the same four thousand symbols on every build, and nobody had looked at why.';
  const healthy = '링커는 빌드마다 같은 사천 개의 기호를 해석하도록 요청받아 왔고, 그 이유를 살펴본 사람은 없었다.';
  resetBehaviour({ reply: healthy });
  calls = [];
  const reply = await send({
    type: 'at/local-translate',
    modelId: MODEL_ID,
    texts: [source],
    target: 'ko',
    maxTokens: 1024,
    context: 'This is a build blog.'
  });
  assert.deepEqual(reply.translations, [healthy]);
  const asks = calls.filter((call) => call.kind === 'generate') as Extract<Call, { kind: 'generate' }>[];
  assert.equal(asks.length, 1, 'a text that speaks for itself is answered in one generation');
  assert.ok(!String(asks[0]!.options.prompt).includes('This is a build blog.'), 'the lead ask is the plain card');
});

test('a short label is asked with the page it sits on', async () => {
  await loaded();
  resetBehaviour({ reply: '설정 저장' });
  calls = [];
  const reply = await send({
    type: 'at/local-translate',
    modelId: MODEL_ID,
    texts: ['Save settings'],
    target: 'ko',
    maxTokens: 1024,
    context: 'These are dialog buttons.'
  });
  assert.deepEqual(reply.translations, ['설정 저장']);
  const asks = calls.filter((call) => call.kind === 'generate') as Extract<Call, { kind: 'generate' }>[];
  assert.equal(asks.length, 1, 'the label was answered the first time');
  assert.ok(String(asks[0]!.options.prompt).includes('These are dialog buttons.'), 'a label keeps the page line');
});

test('a long text the plain ask cannot answer is asked again with the page line', async () => {
  await loaded();
  const source =
    'Module maps removed the last symlink hack, and with it the class of bug where a test passed locally and failed in the container.';
  const healthy = '모듈 맵은 마지막 심링크 꼼수와, 로컬에서는 통과하는데 컨테이너에서는 실패하는 버그 종류를 함께 없앴다.';
  resetBehaviour({
    reply: (prompt) => (String(prompt).includes('This is a build blog.') ? healthy : '   ')
  });
  calls = [];
  const reply = await send({
    type: 'at/local-translate',
    modelId: MODEL_ID,
    texts: [source],
    target: 'ko',
    maxTokens: 1024,
    context: 'This is a build blog.'
  });
  assert.deepEqual(reply.translations, [healthy], 'the page line is the fallback, not the dead end');
  const asks = calls.filter((call) => call.kind === 'generate') as Extract<Call, { kind: 'generate' }>[];
  assert.equal(asks.length, 2, 'the plain ask is worth exactly one more generation');
  assert.ok(!String(asks[0]!.options.prompt).includes('This is a build blog.'), 'the lead ask is plain');
  assert.ok(String(asks[1]!.options.prompt).includes('This is a build blog.'), 'the retry brings the page line back');
  assert.equal(asks[1]!.options.penalty_repeat, local.RETRY_SAMPLING.repeatPenalty, 'the retry pushes on repetition');
});

test('an answer still collapsed on the retry leaves the page its own text', async () => {
  await loaded();
  resetBehaviour({ reply: () => '근'.repeat(971) });
  calls = [];
  const reply = await send({
    type: 'at/local-translate',
    modelId: MODEL_ID,
    texts: ['The digastric muscle is involved in any complex jaw action.'],
    target: 'ko',
    maxTokens: 1024
  });
  assert.deepEqual(reply.translations, [''], 'two unusable answers are no answer');
  assert.equal(
    calls.filter((call) => call.kind === 'generate').length,
    2,
    'the text is given up on, not asked a third time'
  );
});

test('a single text pays the card sampling settings, not the batch ones', async () => {
  await loaded();
  calls = [];
  await send({ type: 'at/local-translate', modelId: MODEL_ID, texts: ['Hello'], target: 'ko', maxTokens: 1024 });
  const options = (calls.find((call) => call.kind === 'generate') as Extract<Call, { kind: 'generate' }>).options;
  assert.equal(options.temp, local.SAMPLING.temp);
  assert.equal(options.top_p, local.SAMPLING.topP);
  assert.equal(options.top_k, local.SAMPLING.topK);
  assert.equal(options.penalty_repeat, local.SAMPLING.repeatPenalty);
  assert.equal(options.seed, local.SAMPLING.seed);
  assert.equal(options.max_tokens, local.answerTokens('Hello', 1024, local.buildEnginePrompt('ko', 'Hello')));
  assert.equal(options.max_tokens, local.MIN_OUTPUT_TOKENS, 'a label is answered in the floor, not the window');
});

test('a long text is answered inside its own budget, not the whole window', async () => {
  await loaded();
  const text = 'The digastric muscle is involved in any complex jaw action such as speaking, swallowing, chewing and breathing.';
  calls = [];
  await send({ type: 'at/local-translate', modelId: MODEL_ID, texts: [text], target: 'ko', maxTokens: 1024 });
  const options = (calls.find((call) => call.kind === 'generate') as Extract<Call, { kind: 'generate' }>).options;
  assert.ok(Number(options.max_tokens) < 150, `one sentence was allowed ${String(options.max_tokens)} tokens`);
  assert.ok(
    local.outputTokens(1024, local.buildEnginePrompt('ko', text)) > 900,
    'the window on its own would have paid for a minute of decoding'
  );
});

test('the measured prompt cost teaches the packer what the priors got wrong', async () => {
  local.setCalibration(1);
  await loaded();
  const text = 'a'.repeat(385);
  resetBehaviour({ promptTokens: 'double', reply: '번역' });
  calls = [];
  await send({ type: 'at/local-translate', modelId: MODEL_ID, texts: [text], target: 'ko', maxTokens: 1024 });
  assert.equal(local.calibrationValue(), 2, 'the runtime counted twice what the priors predicted');
  const status = (await send({ type: 'at/local-query' })).status as Record<string, unknown>;
  assert.equal(status.calibration, 2, 'and the UI can see the multiplier in effect');
  local.setCalibration(1);
});

test('a reply that cannot be split is redone one text at a time', async () => {
  await loaded();
  const texts = ['one', 'two', 'three'];
  resetBehaviour({
    reply: (prompt) => {
      const asked = inputOf(prompt);
      return asked.includes('2. two') ? 'I cannot help with that.' : `번역: ${asked.trim()}`;
    }
  });
  calls = [];
  const reply = await send({ type: 'at/local-translate', modelId: MODEL_ID, texts, target: 'ko', maxTokens: 1024 });
  assert.equal(reply.translations.length, 3);
  assert.deepEqual(reply.translations, ['번역: one', '번역: two', '번역: three']);
  assert.equal(calls.filter((call) => call.kind === 'generate').length, 4, 'one wasted batch, then one per text');
});

test('an empty answer is reported as no answer', async () => {
  await loaded();
  resetBehaviour({ reply: '   ' });
  calls = [];
  const reply = await send({ type: 'at/local-translate', modelId: MODEL_ID, texts: ['Hello'], target: 'ko', maxTokens: 1024 });
  assert.deepEqual(
    reply.translations,
    [''],
    'the page keeps its own text and asks again; the source returned here would stop that'
  );
});

test('a target the model cannot name is refused before the runtime is asked', async () => {
  await loaded();
  calls = [];
  const reply = await send({ type: 'at/local-translate', modelId: MODEL_ID, texts: ['Hello'], target: 'xx', maxTokens: 1024 });
  assert.equal(reply.ok, false);
  assert.equal(reply.code, 'config');
  assert.match(String(reply.error), /no model translates into xx/);
  assert.equal(calls.length, 0, 'no prompt is built for a language the model cannot name');
});

test('a warm-up named for a language the model lacks is asked in Korean instead', async () => {
  // `pt` is a real language this model was not released with. A load may not
  // build a prompt naming a language the weights never learned, so it warms up
  // in the one the card always answers with.
  calls = [];
  const reply = await send({ type: 'at/local-load', modelId: MODEL_ID, maxTokens: 1024, target: 'pt' });
  assert.equal(reply.ok, true, JSON.stringify(reply.error));
  const asks = calls.filter((call) => call.kind === 'generate') as Extract<Call, { kind: 'generate' }>[];
  assert.equal(asks.length, 1, 'the warm-up is the only generation the load spends');
  assert.ok(
    String(asks[0]!.options.prompt).includes('<|plamo:key|>lang<|plamo:val|>ko'),
    'the prompt names a language the model was released with'
  );
});

test('the model is asked as a raw completion, never as a chat message', async () => {
  await loaded();
  calls = [];
  resetBehaviour({ reply: '번역: 안녕하세요' });
  const reply = await send({
    type: 'at/local-translate',
    modelId: MODEL_ID,
    texts: ['Hello'],
    target: 'ko',
    maxTokens: 1024
  });
  const asks = calls.filter((call) => call.kind === 'generate') as Extract<Call, { kind: 'generate' }>[];
  assert.ok(asks.length > 0, 'the ask reached the runtime');
  assert.ok(
    asks.every((ask) => !('messages' in ask.options)),
    'PFML3 is not a chat message: the runtime may not wrap it in one'
  );
  assert.deepEqual(asks[0]!.options.stop, AT.plamo3.STOP_TOKENS, 'the element token is what ends an answer');
  // The answer carries a `번역:` byline of the model's own. Stripping it
  // would eat words the reader came for, so the host hands it over untouched.
  assert.deepEqual(reply.translations, ['번역: 안녕하세요']);
});

test('an answer in a script the target never writes is not painted on the page', async () => {
  // Hangul for a Japanese target: the runtime counts it as an answer, and only
  // the target's own script tells it apart from a translation.
  await loaded();
  calls = [];
  resetBehaviour({ reply: '안녕하세요' });
  const reply = await send({ type: 'at/local-translate', modelId: MODEL_ID, texts: ['Hello'], target: 'ja', maxTokens: 1024 });
  assert.deepEqual(reply.translations, [''], 'the page keeps its own text and asks again');
});

test('a message with no model selected is a configuration failure', async () => {
  const reply = await send({ type: 'at/local-translate', texts: ['Hello'], target: 'ko', maxTokens: 1024 });
  assert.equal(reply.ok, false);
  assert.equal(reply.code, 'config');
  assert.match(String(reply.error), /no model is selected/);
});

test('an empty batch costs no generation', async () => {
  await loaded();
  calls = [];
  const reply = await send({ type: 'at/local-translate', modelId: MODEL_ID, texts: [], target: 'ko', maxTokens: 1024 });
  assert.deepEqual(reply.translations, []);
  assert.equal(calls.length, 0);
});

test('a generation that stops answering is cancelled, not waited for', async (t) => {
  const previousTimeout = local.GENERATION_TIMEOUT_MS;
  const previousIdle = local.IDLE_UNLOAD_MS;
  local.GENERATION_TIMEOUT_MS = 50;
  local.IDLE_UNLOAD_MS = 10 * 60 * 1000;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await loaded();
    let aborted = false;
    resetBehaviour({ hang: true, onAbort: () => { aborted = true; } });
    calls = [];
    const inFlight = send({
      type: 'at/local-translate',
      modelId: MODEL_ID,
      texts: ['Hello'],
      target: 'ko',
      maxTokens: 1024
    });
    await until(() => calls.some((call) => call.kind === 'generate'), 'the generation reached the runtime');
    // The clock belongs to the test: the host's own budget expires here, at no
    // wall-clock cost, instead of the suite waiting three minutes for it.
    t.mock.timers.tick(local.GENERATION_TIMEOUT_MS);
    const reply = await inFlight;
    assert.equal(reply.ok, false);
    assert.equal(reply.code, 'timeout', 'the user is told to shorten the text, not to reload the model');
    assert.equal(aborted, true, 'the decode loop was told to stop, so the next run is not queued behind it');
  } finally {
    t.mock.timers.reset();
    local.GENERATION_TIMEOUT_MS = previousTimeout;
    local.IDLE_UNLOAD_MS = previousIdle;
  }
});

test('generations never overlap', async () => {
  await loaded();
  let active = 0;
  let peak = 0;
  const hold = deferred();
  const inner = FakeWllama.prototype.createCompletion;
  FakeWllama.prototype.createCompletion = async function (this: FakeWllama, options: Record<string, unknown>) {
    active += 1;
    peak = Math.max(peak, active);
    await hold.promise;
    active -= 1;
    return await inner.call(this, options);
  };
  try {
    const first = send({ type: 'at/local-translate', modelId: MODEL_ID, texts: ['a'], target: 'ko', maxTokens: 1024 });
    const second = send({ type: 'at/local-translate', modelId: MODEL_ID, texts: ['b'], target: 'ko', maxTokens: 1024 });
    // The second message is already in the host when the first is still
    // decoding: an unserialised host would have two decodes in flight here.
    await until(() => active === 1, 'the first generation reached the runtime');
    hold.resolve();
    const [one, two] = await Promise.all([first, second]);
    assert.equal(one.ok, true);
    assert.equal(two.ok, true);
    assert.equal(peak, 1, 'llama.cpp holds one graph; two decodes at once would corrupt it');
  } finally {
    hold.resolve();
    FakeWllama.prototype.createCompletion = inner;
  }
});

test('switching models releases the first before the second arrives', async () => {
  await loaded();
  stored = OTHER_STORED;
  const status = await loaded(OTHER_ID);
  assert.equal(status.modelId, OTHER_ID);
  assert.equal(instances, 2, 'a second instance, not a second model inside the first');
  const kinds = calls.map((call) => call.kind);
  assert.ok(
    kinds.indexOf('exit') >= 0 && kinds.indexOf('exit') < kinds.lastIndexOf('load'),
    `the old graph is freed before the new weights: ${kinds.join(',')}`
  );
});

test('unloading frees the runtime and the next load starts clean', async () => {
  await loaded();
  calls = [];
  const status = (await send({ type: 'at/local-unload' })).status as Record<string, unknown>;
  assert.equal(status.state, 'unloaded');
  assert.equal(status.modelId, null);
  assert.equal(status.reason, null, 'a reason belongs to a failure, not to the idle host');
  assert.equal(calls.filter((call) => call.kind === 'exit').length, 1);
  calls = [];
  await loaded();
  assert.equal(calls.filter((call) => call.kind === 'load').length, 1, 'the model really comes back');
});

test('a quiet host unloads itself, because it holds a gigabyte', async (t) => {
  const previousIdle = local.IDLE_UNLOAD_MS;
  local.IDLE_UNLOAD_MS = 600000;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await loaded();
    calls = [];
    t.mock.timers.tick(local.IDLE_UNLOAD_MS);
    // The release is fire-and-forget by design (a timer callback cannot await),
    // so the assertion waits for the state the teardown writes.
    await until(() => calls.some((call) => call.kind === 'exit'), 'the idle timer released the model');
    const status = (await send({ type: 'at/local-query' })).status as Record<string, unknown>;
    assert.equal(status.state, 'unloaded');
    assert.equal(calls.filter((call) => call.kind === 'exit').length, 1);
  } finally {
    t.mock.timers.reset();
    local.IDLE_UNLOAD_MS = previousIdle;
  }
});

test('an unknown message type answers with nothing instead of throwing', async () => {
  assert.deepEqual(await send({ type: 'at/not-a-host-message' }), { ok: true }, 'a stray message is not ours to answer');
});

test('loading with a language the model lacks fails before the runtime is asked', async () => {
  // `handle` folds an unusable warm-up target, so the exported entry point is
  // where a prompt could still be built naming a language the weights never
  // learned. The guard answers as a configuration failure: no graph is
  // instantiated and no generation is spent on a target to refuse.
  calls = [];
  await assert.rejects(
    () => localhost.load(MODEL_ID, 1024, 'pt'),
    (thrown: unknown) => {
      const error = thrown as { reason?: string; code?: string; message?: string };
      return error.reason === 'no-target' && /no language for pt/.test(String(error.message));
    }
  );
  assert.deepEqual(calls, [], 'the refusal costs neither a load nor a generation');
});

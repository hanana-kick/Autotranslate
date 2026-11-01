import assert from 'node:assert/strict';
import test from 'node:test';
import { load, resetGlobals, type ATNamespace } from './helpers.ts';
const scope = globalThis as ATNamespace;
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string; preventDefault(): void }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  messages: ATNamespace[] = [];
  terminated = false;
  url: string;
  constructor(url: string) { this.url = url; FakeWorker.instances.push(this); }
  postMessage(message: ATNamespace) { this.messages.push(message); }
  terminate() { this.terminated = true; }
  send(data: unknown) { this.onmessage?.({ data }); }
  reply(reply: unknown = {}) { this.send({ kind: 'reply', id: this.messages.at(-1)!.id, reply }); }
}
function fixture() {
  resetGlobals(); FakeWorker.instances = [];
  scope.document = {};
  scope.Worker = FakeWorker;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { gpu: { requestAdapter: async () => ({}) } } });
  const AT = load('lib/constants.js', 'lib/gemma.js', 'lib/local.js', 'lib/modelstore.js', 'lib/localhost.js');
  AT.getURL = (path: string) => `chrome-extension://fixture/${path}`;
  AT.localhost.install('offscreen', () => {});
  return AT;
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const message = { type: 'at/local-load', modelId: 'fixture-model', maxTokens: 1024 };
test.afterEach(() => { delete scope.document; delete scope.Worker; });

test('worker host: original host is dispatched to the packaged worker, not a native bridge', async () => {
  const AT = fixture(); const loading = AT.localhost.handle(message); await tick();
  const worker = FakeWorker.instances[0]!;
  assert.equal(worker.url, 'chrome-extension://fixture/inference-worker.js');
  assert.deepEqual(worker.messages[0]!.message, message);
  assert.deepEqual(Object.keys(worker.messages[0]!).sort(), ['id', 'message', 'placement']);
  worker.reply({ status: { state: 'ready' } }); await loading;
  await AT.localhost.handle({ type: 'at/local-unload' });
});
test('worker host: status is answered outside a busy worker', async () => {
  const AT = fixture(); const loading = AT.localhost.handle(message); await tick();
  const worker = FakeWorker.instances[0]!;
  worker.send({ kind: 'status', status: { state: 'loading', supported: true, phase: 'model-create' } });
  const reply = await AT.localhost.handle({ type: 'at/local-query' });
  assert.equal(reply.status.state, 'loading'); assert.equal(reply.status.phase, 'model-create');
  assert.equal(worker.messages.length, 1, 'status polling must not enqueue native work');
  worker.reply(); await loading; await AT.localhost.handle({ type: 'at/local-unload' });
});
test('worker host: unload terminates active native work and invalidates queued jobs', async () => {
  const AT = fixture(); const first = AT.localhost.handle(message);
  const second = AT.localhost.handle(message);
  const rejected = [assert.rejects(first, /cancelled/), assert.rejects(second, /obsolete/)];
  await tick(); const worker = FakeWorker.instances[0]!;
  const result = await AT.localhost.handle({ type: 'at/local-unload' });
  assert.equal(result.status.state, 'unloaded'); assert.equal(worker.terminated, true);
  await Promise.all(rejected);
  assert.equal(worker.messages.length, 1);
});
test('worker host: a native initialization stall is timed out outside that worker', async () => {
  const AT = fixture(); AT.local.MODEL_LOAD_TIMEOUT_MS = 20;
  const loading = AT.localhost.handle(message);
  await assert.rejects(loading, /timed out.*worker terminated/);
  assert.equal(FakeWorker.instances[0]!.terminated, true);
  const status = await AT.localhost.status();
  assert.equal(status.state, 'error'); assert.equal(status.reason, 'model-load-failed');
});
test('worker host: a crashed worker is disposed and a later request starts cleanly', async () => {
  const AT = fixture(); const loading = AT.localhost.handle(message);
  const failed = assert.rejects(loading, /crashed/); await tick();
  FakeWorker.instances[0]!.onerror!({ message: 'worker crashed', preventDefault() {} }); await failed;
  const next = AT.localhost.handle(message); await tick();
  assert.equal(FakeWorker.instances.length, 2); FakeWorker.instances[1]!.reply(); await next;
  await AT.localhost.handle({ type: 'at/local-unload' });
});
test('worker host: stale messages cannot overwrite a new worker session', async () => {
  const AT = fixture(); const first = AT.localhost.handle(message);
  const stopped = assert.rejects(first, /cancelled/); await tick(); const old = FakeWorker.instances[0]!;
  await AT.localhost.handle({ type: 'at/local-unload' }); await stopped;
  const next = AT.localhost.handle(message); await tick(); const current = FakeWorker.instances[1]!;
  current.send({ kind: 'status', status: { state: 'ready', supported: true, generations: 7 } });
  old.send({ kind: 'status', status: { state: 'error', generations: 99 } });
  assert.equal((await AT.localhost.status()).generations, 7);
  current.reply(); await next; await AT.localhost.handle({ type: 'at/local-unload' });
});


test('worker host: generation progress cannot indefinitely extend the phase deadline', async () => {
  const AT = fixture(); AT.local.GENERATION_TIMEOUT_MS = 35;
  const loading = AT.localhost.handle(message); const failed = assert.rejects(loading, /timed out/);
  await tick(); const worker = FakeWorker.instances[0]!;
  worker.send({ kind: 'status', status: { state: 'busy', supported: true, phase: 'generate', outputChars: 0 } });
  const progress = setInterval(() => worker.send({ kind: 'status', status: { state: 'busy', supported: true, phase: 'generate', outputChars: 4 } }), 5);
  try { await failed; assert.equal(worker.terminated, true); } finally { clearInterval(progress); }
});


test('worker host: invalid output retries once with a fresh original worker', async () => {
  const AT = fixture();
  const request = AT.localhost.handle({ type: 'at/local-translate', modelId: 'fixture-model', texts: ['Hello.'], source: 'en', target: 'ko' });
  await tick(); const first = FakeWorker.instances[0]!;
  first.send({ kind: 'status', status: { state: 'error', reason: 'invalid-output', lastError: 'padding tokens' } });
  await tick(); const second = FakeWorker.instances[1]!;
  assert.equal(first.terminated, true);
  assert.equal(second.url, first.url, 'the engine is never substituted');
  second.reply({ translations: ['안녕하세요.'] });
  assert.deepEqual((await request).translations, ['안녕하세요.']);
  await AT.localhost.handle({ type: 'at/local-unload' });
});

test('worker host: corrupt retry fails, it never loops until green', async () => {
  const AT = fixture();
  const request = AT.localhost.handle({ type: 'at/local-translate', modelId: 'fixture-model', texts: ['Hello.'], source: 'en', target: 'ko' });
  const failure = assert.rejects(request, /invalid|padding/);
  await tick(); FakeWorker.instances[0]!.send({ kind: 'status', status: { state: 'error', reason: 'invalid-output', lastError: 'padding' } });
  await tick(); FakeWorker.instances[1]!.send({ kind: 'status', status: { state: 'error', reason: 'invalid-output', lastError: 'padding' } });
  await failure; assert.equal(FakeWorker.instances.length, 2);
});


test('worker host: cold warmup has a startup budget and one bounded fresh-worker recovery', async () => {
  const AT = fixture(); AT.local.MODEL_LOAD_TIMEOUT_MS = 40; AT.local.GENERATION_TIMEOUT_MS = 20;
  const request = AT.localhost.handle(message); await tick(); const first = FakeWorker.instances[0]!;
  first.send({ kind: 'status', status: { state: 'loading', supported: true, phase: 'warmup' } });
  await new Promise(r => setTimeout(r, 25));
  assert.equal(first.terminated, false, 'cold warmup does not use the shorter generation deadline');
  await new Promise(r => setTimeout(r, 25)); await tick();
  const second = FakeWorker.instances[1]!; assert.ok(second); assert.equal(first.terminated, true);
  second.reply({ status: { state: 'ready' } }); await request;
  assert.equal((await AT.localhost.status()).recoveries, 1);
  await AT.localhost.handle({ type: 'at/local-unload' });
});

test('worker host: a repeated cold warmup failure is final, never retried until green', async () => {
  const AT = fixture(); AT.local.MODEL_LOAD_TIMEOUT_MS = 25; AT.local.GENERATION_TIMEOUT_MS = 20;
  const request = AT.localhost.handle(message); const rejected = assert.rejects(request, /warmup.*timed out/);
  await tick(); FakeWorker.instances[0]!.send({ kind: 'status', status: { state: 'loading', supported: true, phase: 'warmup' } });
  await new Promise(r => setTimeout(r, 30)); await tick();
  FakeWorker.instances[1]!.send({ kind: 'status', status: { state: 'loading', supported: true, phase: 'warmup' } });
  await rejected; assert.equal(FakeWorker.instances.length, 2);
  assert.ok(FakeWorker.instances.every(w => w.terminated));
  assert.equal((await AT.localhost.status()).state, 'error');
});

test('worker host: unload during a recovered warmup cannot restart a cancelled session', async () => {
  const AT = fixture(); const request = AT.localhost.handle(message);
  const rejected = assert.rejects(request, /cancelled/); await tick();
  FakeWorker.instances[0]!.send({ kind: 'status', status: { state: 'error', reason: 'warmup-timeout', lastError: 'warmup timeout' } });
  await tick(); const second = FakeWorker.instances[1]!; assert.ok(second);
  await AT.localhost.handle({ type: 'at/local-unload' }); await rejected;
  assert.equal(second.terminated, true); assert.equal(FakeWorker.instances.length, 2);
});


test('worker host: a missing first token causes exactly one original-worker recovery', async () => {
  const AT=fixture(); AT.local.FIRST_OUTPUT_TIMEOUT_MS=25;
  const req=AT.localhost.handle({type:'at/local-translate',modelId:'fixture-model',texts:['Hello.'],source:'en',target:'ko'});
  await tick(); const first=FakeWorker.instances[0]!;
  first.send({kind:'status',status:{state:'busy',phase:'generate',supported:true,outputChars:0}});
  const poll=setInterval(()=>first.send({kind:'status',status:{state:'busy',phase:'generate',supported:true,outputChars:0}}),5);
  await new Promise(r=>setTimeout(r,35));clearInterval(poll);await tick();
  const second=FakeWorker.instances[1]!;assert.ok(second);assert.equal(first.terminated,true);
  assert.deepEqual(second.messages[0]!.message,first.messages[0]!.message);
  second.reply({translations:['안녕하세요.']});assert.deepEqual((await req).translations,['안녕하세요.']);
  assert.equal((await AT.localhost.status()).recoveries,1);await AT.localhost.handle({type:'at/local-unload'});
});

test('worker host: actual first output clears only the first-output timer',async()=>{
  const AT=fixture();AT.local.FIRST_OUTPUT_TIMEOUT_MS=20;AT.local.GENERATION_TIMEOUT_MS=80;
  const req=AT.localhost.handle(message);await tick();const worker=FakeWorker.instances[0]!;
  worker.send({kind:'status',status:{state:'busy',phase:'generate',supported:true,outputChars:0}});
  await new Promise(r=>setTimeout(r,10));worker.send({kind:'status',status:{state:'busy',phase:'generate',supported:true,outputChars:3}});
  await new Promise(r=>setTimeout(r,25));assert.equal(worker.terminated,false);worker.reply();await req;
  await AT.localhost.handle({type:'at/local-unload'});
});

test('worker host: a second missing-first-token failure is final',async()=>{
  const AT=fixture();AT.local.FIRST_OUTPUT_TIMEOUT_MS=15;
  const req=AT.localhost.handle(message);const failed=assert.rejects(req,/produced no output/);
  await tick();FakeWorker.instances[0]!.send({kind:'status',status:{state:'busy',phase:'generate',supported:true,outputChars:0}});
  await new Promise(r=>setTimeout(r,25));await tick();FakeWorker.instances[1]!.send({kind:'status',status:{state:'busy',phase:'generate',supported:true,outputChars:0}});
  await failed;assert.equal(FakeWorker.instances.length,2);assert.ok(FakeWorker.instances.every(w=>w.terminated));
});

test('worker host: software generation retains its explicit long deadline',async()=>{
  const AT=fixture();AT.local.FIRST_OUTPUT_TIMEOUT_MS=10;AT.local.SOFTWARE_GENERATION_TIMEOUT_MS=100;
  const req=AT.localhost.handle(message);await tick();const worker=FakeWorker.instances[0]!;
  worker.send({kind:'status',status:{state:'busy',phase:'generate',supported:true,softwareRendering:true,outputChars:0}});
  await new Promise(r=>setTimeout(r,25));assert.equal(worker.terminated,false);worker.reply();await req;
  await AT.localhost.handle({type:'at/local-unload'});
});


test('worker host: a lost GPU capability probe cannot hang status or unload', async () => {
  const AT = fixture();
  AT.local.GPU_PROBE_TIMEOUT_MS = 15;
  Object.defineProperty(globalThis, 'navigator', { configurable: true,
    value: { gpu: { requestAdapter: () => new Promise(() => {}) } } });
  const state = await AT.localhost.status();
  assert.equal(state.state, 'error');
  assert.equal(state.reason, 'no-webgpu');
  assert.match(state.lastError, /probe timed out/);
  const reply = await AT.localhost.handle({ type: 'at/local-unload' });
  assert.equal(reply.status.state, 'unloaded');
});

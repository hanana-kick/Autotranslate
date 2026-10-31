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

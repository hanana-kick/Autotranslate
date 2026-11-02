import test from 'node:test';
import assert from 'node:assert/strict';
import { load, type ATNamespace } from './helpers.ts';

const host = globalThis as ATNamespace;
host.chrome = { runtime: { sendMessage: async () => undefined, onMessage: { addListener() {} }, getURL: (s: string) => s } };
const AT = load('lib/constants.js', 'lib/browser.js', 'lib/remote.js');
const R = AT.remote;
const originalFetch = globalThis.fetch;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const config = (n: number) => ({ baseUrl: 'https://configured.example/v1', model: 'TranslateGemma',
  style: 'delimiters', concurrency: n, maxOutputTokens: 512 });
let active = 0, peak = 0, calls = 0, aborts = 0, latency = 20, status = 200;
const starts: string[] = [];

test.beforeEach(async () => {
  R.cancelAll();
  await wait(5);
  assert.equal(R.schedulerStatus().active, 0);
  assert.equal(R.schedulerStatus().queued, 0);
  active = 0; peak = 0; calls = 0; aborts = 0; latency = 20; status = 200; starts.length = 0;
  globalThis.fetch = (async (_input: unknown, init: RequestInit) => {
    calls++; active++; peak = Math.max(peak, active);
    const body = JSON.parse(String(init.body));
    const text = body.messages[0].content.split('<<<text>>>').at(-1);
    starts.push(text);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { init.signal?.removeEventListener('abort', abort); resolve(); }, latency + text.length % 3 * 5);
        const abort = () => { clearTimeout(timer); aborts++; reject(new Error('abort')); };
        if (init.signal?.aborted) abort();
        else init.signal?.addEventListener('abort', abort, { once: true });
      });
      return new Response(JSON.stringify(status === 200 ? { choices: [{ finish_reason: 'stop', message: { content: '번역: ' + text } }] } : { error: 'secret-server-body' }),
        { status, headers: { 'Content-Type': 'application/json' } });
    } finally { active--; }
  }) as typeof fetch;
});
test.afterEach(async () => { R.cancelAll(); await wait(5); globalThis.fetch = originalFetch; });

for (const count of [1, 2, 4, 8, 32]) {
  test('one tab really runs up to manual concurrency ' + count, async () => {
    const input = Array.from({ length: 40 }, (_, i) => 'unique sentence ' + i);
    const result = await R.translate(config(count), '', input, 'en', 'ko');
    assert.deepEqual(result, input.map(s => '번역: ' + s));
    assert.equal(peak, count);
    assert.equal(calls, input.length);
    assert.equal(R.schedulerStatus().queued, 0);
  });
}

test('simultaneous batches and tabs share one total limit, never a limit per call', async () => {
  const sets = Array.from({ length: 5 }, (_, tab) => Array.from({ length: 7 }, (_, item) => `tab ${tab} text ${item}`));
  const results = await Promise.all(sets.map(texts => R.translate(config(3), 'same-key', texts, 'en', 'ko')));
  assert.deepEqual(results, sets.map(texts => texts.map(s => '번역: ' + s)));
  assert.equal(peak, 3, 'five callers must not multiply 3 into 15');
  assert.equal(calls, 35);
});

test('lowering the setting drains in-flight work before admitting replacements', async () => {
  latency = 45;
  const pending = R.translate(config(4), '', Array.from({ length: 12 }, (_, i) => 'change ' + i), 'en', 'ko');
  await wait(5);
  assert.equal(R.schedulerStatus().active, 4);
  R.configureConcurrency(1);
  const before = calls;
  await wait(10);
  assert.equal(calls, before, 'no request starts while previous work exceeds the new setting');
  await pending;
  assert.equal(peak, 4, 'already active requests cannot retroactively disappear');
  assert.equal(R.schedulerStatus().limit, 1);
  peak = 0;
  await R.translate(config(1), '', ['new A', 'new B', 'new C'], 'en', 'ko');
  assert.equal(peak, 1);
});

test('raising the setting immediately releases the queued work without a second batch', async () => {
  latency = 60;
  const jobs = Array.from({ length: 6 }, (_, i) => R.translate(config(1), '', ['increase ' + i], 'en', 'ko'));
  await wait(5);
  assert.equal(calls, 1);
  R.configureConcurrency(3);
  await wait(5);
  assert.equal(calls, 3);
  await Promise.all(jobs);
  assert.equal(peak, 3);
});

test('turning off one tab aborts its active and queued requests without cancelling another tab', async () => {
  latency = 60;
  const off = new AbortController();
  const first = R.translate(config(2), '', ['cancel A', 'cancel B', 'cancel C', 'cancel D'], 'en', 'ko', off.signal);
  const check = assert.rejects(first, /cancelled/);
  const second = R.translate(config(2), '', ['keep A', 'keep B', 'keep C'], 'en', 'ko');
  await wait(10);
  off.abort();
  await check;
  assert.deepEqual(await second, ['번역: keep A', '번역: keep B', '번역: keep C']);
  assert.ok(aborts >= 1);
  assert.ok(!starts.includes('cancel C') && !starts.includes('cancel D'));
  assert.equal(peak, 2);
  assert.equal(R.schedulerStatus().queued, 0);
});

test('a failed request releases slots and no queued sibling keeps dispatching', async () => {
  status = 429;
  await assert.rejects(R.translate(config(2), '', ['error A', 'error B', 'error C', 'error D'], 'en', 'ko'),
    (error: ATNamespace) => error.code === 'rate-limit' && !error.message.includes('secret-server-body'));
  await wait(5);
  assert.ok(calls <= 2);
  assert.equal(R.schedulerStatus().active, 0);
  assert.equal(R.schedulerStatus().queued, 0);
  status = 200;
  assert.deepEqual(await R.translate(config(2), '', ['recovered'], 'en', 'ko'), ['번역: recovered']);
});

test('switching away from server mode cancels the complete remote queue', async () => {
  latency = 80;
  const jobs = Array.from({ length: 4 }, (_, i) => R.translate(config(2), '', ['switch ' + i], 'en', 'ko'));
  const settled = Promise.allSettled(jobs);
  await wait(5);
  R.cancelAll();
  const result = await settled;
  assert.ok(result.every(r => r.status === 'rejected'));
  assert.equal(calls, 2);
  assert.equal(R.schedulerStatus().queued, 0);
});

test('invalid settings are bounded and a pre-aborted request never opens a connection', async () => {
  assert.equal(R.concurrencyOf(0), 1);
  assert.equal(R.concurrencyOf(99), 32);
  assert.equal(R.concurrencyOf(3.8), 3);
  assert.equal(R.concurrencyOf(NaN), 2);
  assert.equal(R.normalizeBaseUrl('https://example.org/custom/compat'), 'https://example.org/custom/compat');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(R.translate(config(3), '', ['no request'], 'en', 'ko', controller.signal), /cancelled/);
  assert.equal(calls, 0);
});

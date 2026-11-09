import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { withNativeHostMonitor } from './host-monitor.mjs';

function fixture() {
  const options = { navigating: false };
  const probe = { url: null, hydrated: false, closed: false,
    async goto(url) { this.url = url; },
    async waitForFunction() { this.hydrated = true; },
    async close() { this.closed = true; } };
  const pages = [options];
  const context = { pages: () => pages, async newPage() { pages.push(probe); return probe; } };
  return { options, probe, context, optionsURL: 'chrome-extension://fixture/options.html', intervalMs: 1, label: 'fixture' };
}

test('host monitor polls a hydrated stable page while Options repeatedly navigates', async () => {
  const f = fixture(); let samples = 0;
  const result = await withNativeHostMonitor({ ...f,
    async readHost(p) { assert.equal(p, f.probe); assert.notEqual(p, f.options); assert.ok(p.hydrated); samples++; return { ok: true, status: { state: 'ready' } }; },
    async run() { for (let i=0;i<5;i++) { f.options.navigating=true; await delay(4); f.options.navigating=false; } return 42; }
  });
  assert.equal(result, 42); assert.ok(samples > 1); assert.equal(f.probe.closed, true);
});

test('host monitor tolerates a recovery transition, not two definitive errors', async () => {
  const f = fixture(); let calls = 0;
  const result = await withNativeHostMonitor({ ...f,
    async readHost() { return { ok: true, status: { state: ++calls === 1 ? 'error' : 'ready', lastError: 'recovery' } }; },
    async run() { await delay(12); return 'completed'; }
  });
  assert.equal(result, 'completed'); assert.ok(calls > 1);
});

test('host monitor fails on repeated actual errors and closes only its own fixture pages', async () => {
  const f = fixture(); let fixtureClosed = false, finish;
  const page = { async close() { fixtureClosed=true; finish(); } };
  await assert.rejects(withNativeHostMonitor({ ...f,
    async readHost() { return { ok: true, status: { state: 'error', reason: 'generation-timeout', lastError: 'native timeout', recoveries: 1 } }; },
    async run() { const original = f.context.pages; f.context.pages=()=>[...original(),page]; return new Promise(r=>{ finish=r; }); }
  }), /native host failed: native timeout/);
  assert.ok(fixtureClosed); assert.ok(f.probe.closed);
});

test('host monitor retains fixture failure and closes its probe', async () => {
  const f=fixture();
  await assert.rejects(withNativeHostMonitor({ ...f, readHost: async()=>({ok:true,status:{state:'ready'}}), run:async()=>{throw new Error('HTML not restored');} }), /HTML not restored/);
  assert.ok(f.probe.closed);
});

test('host unavailability is not skipped or turned into a pass', async () => {
  const f=fixture();
  await assert.rejects(withNativeHostMonitor({ ...f, readHost:async()=>({ok:false,error:'no receiver'}), run:()=>delay(5) }), /host unavailable: no receiver/);
  assert.ok(f.probe.closed);
});

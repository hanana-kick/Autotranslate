import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.ts';

const AT = load('lib/constants.js', 'lib/local.js', 'lib/modelstore.js');
const { modelstore, local } = AT;
const STORE = local.STORE;

// --- fakes ------------------------------------------------------------------
// IndexedDB and OPFS are replaced wholesale: the file tests the decisions
// around a transfer (accept, reject, clean up, report), not the storage API.

const bytes = (size: number, fill = 1): Uint8Array => new Uint8Array(size).fill(fill);

const streamOf = (...chunks: Uint8Array[]): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    }
  });

type Fakes = ReturnType<typeof fakes>;

function fakes() {
  const meta = new Map<string, unknown>();
  const settings = new Map<string, unknown>();
  const stored = new Map<string, Uint8Array>();
  const deleted: string[] = [];
  const clock = { now: 1_700_000_000_000 };
  const estimate = { usage: 0, quota: 0, persisted: false };

  const driver = {
    get: async (store: string, key: string) => (store === STORE.metaStore ? meta.get(key) : settings.get(key)),
    put: async (store: string, key: string, value: unknown) => {
      (store === STORE.metaStore ? meta : settings).set(key, value);
    },
    remove: async (store: string, key: string) => {
      (store === STORE.metaStore ? meta : settings).delete(key);
    },
    all: async (store: string) => [...(store === STORE.metaStore ? meta.values() : settings.values())]
  };

  const files = {
    write: async (id: string, stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      const parts: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        parts.push(chunk.value);
        size += chunk.value.byteLength;
      }
      const all = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) {
        all.set(part, offset);
        offset += part.byteLength;
      }
      stored.set(id, all);
      return size;
    },
    read: async (id: string) => (stored.has(id) ? { size: stored.get(id)!.byteLength } : null),
    remove: async (id: string) => {
      deleted.push(id);
      stored.delete(id);
    },
    estimate: async () => ({ ...estimate }),
    persist: async () => true
  };

  const use = (over: { fetchImpl?: unknown; quota?: number; usage?: number; now?: number } = {}) => {
    if (over.quota !== undefined) estimate.quota = over.quota;
    if (over.usage !== undefined) estimate.usage = over.usage;
    if (over.now !== undefined) clock.now = over.now;
    modelstore.configure({ driver, files, now: () => clock.now, ...(over.fetchImpl ? { fetchImpl: over.fetchImpl } : {}) });
  };

  return { meta, settings, stored, deleted, clock, estimate, driver, files, use };
}

/** A response with the members a download reads. */
const response = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  body
});

const bodyOf = (...chunks: Uint8Array[]) => {
  let index = 0;
  return {
    read: async () =>
      index < chunks.length ? { done: false, value: chunks[index++] } : { done: true, value: undefined }
  };
};

const big = () => [bytes(local.MIN_MODEL_BYTES), bytes(1024)];
const length = { 'content-length': String(local.MIN_MODEL_BYTES + 1024) };

test.beforeEach(() => {
  const f = fakes();
  active = f;
  f.use();
});

let active: Fakes;

// --- records ----------------------------------------------------------------

test('an empty store lists nothing', async () => {
  assert.deepEqual(await modelstore.list(), []);
  assert.equal(await modelstore.get('nope'), null);
  assert.equal(await modelstore.read('nope'), null);
  assert.equal(await modelstore.remove('nope'), false);
});

test('a list is normalised even when the store holds junk', async () => {
  active.meta.set('good', { id: 'good', name: 'g.task', size: 5_000_000, sourceUrl: '', createdAt: 5 });
  active.meta.set('broken', { id: 'broken', size: 1 });
  assert.deepEqual((await modelstore.list()).map((model: { id: string }) => model.id), ['good']);
});

test('removing a model deletes its bytes as well as its record', async () => {
  const result = await modelstore.ingest({ name: 'kept.task', sourceUrl: 'https://a.test/kept.task', stream: streamOf(...big()) });
  assert.equal(result.ok, true);
  const id = result.record.id;
  assert.equal(active.stored.has(id), true);

  assert.equal(await modelstore.remove(id), true);
  assert.equal(active.stored.has(id), false, 'the file must not outlive the record');
  assert.deepEqual(active.deleted, [id]);
  assert.deepEqual(await modelstore.list(), []);
});

test('read hands back the stored file only for a known model', async () => {
  const result = await modelstore.ingest({ name: 'file.task', sourceUrl: 'https://a.test/file.task', stream: streamOf(...big()) });
  const blob = await modelstore.read(result.record.id);
  assert.equal(blob.size, local.MIN_MODEL_BYTES + 1024);
});

// --- ingest -----------------------------------------------------------------

test('a model is registered only after the whole stream is written', async () => {
  const result = await modelstore.ingest({
    name: 'my model.task',
    sourceUrl: 'https://a.test/my%20model.task',
    stream: streamOf(bytes(2_000_000), bytes(1_000_000))
  });
  assert.equal(result.ok, true);
  assert.equal(result.bytes, 3_000_000);
  assert.equal(result.record.size, 3_000_000, 'the real byte count wins over any claimed size');
  assert.equal(result.record.name, 'my model.task');
  assert.deepEqual(await modelstore.list(), [result.record]);
});

test('a file too small to be a model is deleted, not registered', async () => {
  const result = await modelstore.ingest({ name: 'tiny.task', sourceUrl: 'https://a.test/tiny.task', stream: streamOf(bytes(10)) });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'too-small');
  assert.equal(active.stored.size, 0);
  assert.equal(active.deleted.length, 1);
  assert.deepEqual(await modelstore.list(), []);
});

test('a failed write leaves nothing behind', async () => {
  modelstore.configure({
    files: {
      ...active.files,
      write: async () => {
        throw new Error('disk full');
      }
    }
  });
  const result = await modelstore.ingest({ name: 'half.task', sourceUrl: 'https://a.test/half.task', stream: streamOf(...big()) });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'disk full');
  assert.equal(active.deleted.length, 1, 'the partial file must be removed');
});

test('an aborted transfer reports a cancellation', async () => {
  const abort = new Error('stopped');
  abort.name = 'AbortError';
  modelstore.configure({
    files: {
      ...active.files,
      write: async () => {
        throw abort;
      }
    }
  });
  const result = await modelstore.ingest({ name: 'gone.task', sourceUrl: 'https://a.test/gone.task', stream: streamOf(...big()) });
  assert.equal(result.error, 'cancelled');
});

test('a transfer with no source is refused before any file is made', async () => {
  assert.equal((await modelstore.ingest({ name: 'x.task', sourceUrl: 'https://a.test/x.task', stream: null })).error, 'no-stream');
  assert.equal((await modelstore.ingest({ name: '  ', sourceUrl: 'https://a.test/x.task', stream: streamOf(...big()) })).error, 'no-name');
  assert.equal(active.stored.size, 0);
});

test('a non-https source is stored as no source at all', async () => {
  const result = await modelstore.ingest({ name: 'local.task', sourceUrl: 'file:///tmp/x', stream: streamOf(...big()) });
  assert.equal(result.record.sourceUrl, '');
});

test('re-downloading the same file name replaces the older copy', async () => {
  const first = await modelstore.ingest({ name: 'same.task', sourceUrl: 'https://a.test/same.task', stream: streamOf(...big()) });
  active.clock.now += 1000;
  const second = await modelstore.ingest({ name: 'same.task', sourceUrl: 'https://b.test/same.task', stream: streamOf(...big()) });
  assert.notEqual(first.record.id, second.record.id);
  const list = await modelstore.list();
  assert.deepEqual(list.map((model: { id: string }) => model.id), [second.record.id]);
  assert.equal(active.stored.has(first.record.id), false);
});

test('a failed re-download leaves the working model alone', async () => {
  const kept = await modelstore.ingest({ name: 'keep.task', sourceUrl: 'https://a.test/keep.task', stream: streamOf(...big()) });
  active.clock.now += 60_000;
  active.use({
    fetchImpl: async () =>
      response(200, bodyOf(bytes(Math.floor(local.MIN_MODEL_BYTES / 2))), { 'content-length': String(local.MIN_MODEL_BYTES) })
  });
  const again = await modelstore.download({ url: 'https://a.test/keep.task' });
  assert.equal(again.error, 'truncated');
  assert.deepEqual((await modelstore.list()).map((model: { id: string }) => model.id), [kept.record.id]);
  assert.equal(active.stored.has(kept.record.id), true, 'a half file must not replace working bytes');
});

// --- download ---------------------------------------------------------------

test('a download is rejected before the network for a bad url', async () => {
  const calls: string[] = [];
  active.use({ fetchImpl: async (url: string) => (calls.push(url), response(200, bodyOf(), length)) });
  const result = await modelstore.download({ url: 'http://a.test/model.task' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'bad-url');
  assert.deepEqual(calls, []);
});

test('a download sends the token as a bearer credential', async () => {
  const seen: { url: string; init: { headers: Record<string, string> } }[] = [];
  active.use({
    fetchImpl: async (url: string, init: { headers: Record<string, string> }) => {
      seen.push({ url, init });
      return response(200, bodyOf(...big()), length);
    }
  });
  const result = await modelstore.download({ url: 'https://a.test/model.task', token: 'hf_secret' });
  assert.equal(result.ok, true);
  assert.equal(seen[0]!.url, 'https://a.test/model.task');
  assert.equal(seen[0]!.init.headers.Authorization, 'Bearer hf_secret');
  assert.equal(seen[0]!.init.headers.Accept, 'application/octet-stream');
});

test('an existing Bearer prefix is not doubled', async () => {
  const seen: Record<string, string>[] = [];
  active.use({
    fetchImpl: async (_url: string, init: { headers: Record<string, string> }) => {
      seen.push(init.headers);
      return response(200, bodyOf(...big()), length);
    }
  });
  await modelstore.download({ url: 'https://a.test/model.task', token: 'Bearer hf_secret' });
  assert.equal(seen[0]!.Authorization, 'Bearer hf_secret');
});

test('a gated repository is reported as needing a token', async () => {
  for (const status of [401, 403]) {
    active.use({ fetchImpl: async () => response(status, null) });
    const result = await modelstore.download({ url: 'https://a.test/model.task' });
    assert.equal(result.error, 'needs-token', `status ${status}`);
  }
});

test('an http failure keeps the status code in the error', async () => {
  active.use({ fetchImpl: async () => response(503, null) });
  assert.equal((await modelstore.download({ url: 'https://a.test/model.task' })).error, 'http-503');
});

test('a network failure reports why', async () => {
  active.use({
    fetchImpl: async () => {
      throw new Error('offline');
    }
  });
  assert.equal((await modelstore.download({ url: 'https://a.test/model.task' })).error, 'offline');
});

test('an aborted download reports a cancellation', async () => {
  const abort = new Error('stopped');
  abort.name = 'AbortError';
  active.use({
    fetchImpl: async () => {
      throw abort;
    }
  });
  assert.equal((await modelstore.download({ url: 'https://a.test/model.task' })).error, 'cancelled');
});

test('a response without a body cannot be stored', async () => {
  active.use({ fetchImpl: async () => response(200, null, length) });
  assert.equal((await modelstore.download({ url: 'https://a.test/model.task' })).error, 'no-body');
});

test('a declared size outside the plausible range is refused up front', async () => {
  active.use({ fetchImpl: async () => response(200, bodyOf(bytes(10)), { 'content-length': '10' }) });
  assert.equal((await modelstore.download({ url: 'https://a.test/model.task' })).error, 'bad-size');
});

test('a file that is not the advertised model is refused', async () => {
  active.use({ fetchImpl: async () => response(200, bodyOf(...big()), length) });
  const result = await modelstore.download({ url: 'https://a.test/model.task', expectedSize: local.MIN_MODEL_BYTES * 4 });
  assert.equal(result.error, 'size-mismatch');
});

test('a truncated transfer is deleted and reported', async () => {
  active.use({
    fetchImpl: async () => response(200, bodyOf(bytes(local.MIN_MODEL_BYTES)), { 'content-length': String(local.MIN_MODEL_BYTES * 2) })
  });
  const result = await modelstore.download({ url: 'https://a.test/model.task' });
  assert.equal(result.error, 'truncated');
  assert.equal(active.stored.size, 0, 'a half model must not stay on disk');
  assert.deepEqual(await modelstore.list(), []);
});

test('a download reports progress and stores the finished file', async () => {
  const seen: [number, number | null][] = [];
  active.use({
    fetchImpl: async () => response(200, bodyOf(...big()), length),
    now: 0
  });
  const result = await modelstore.download({
    url: 'https://a.test/final.task',
    onProgress: (received: number, total: number | null) => seen.push([received, total])
  });
  assert.equal(result.ok, true);
  assert.equal(result.record.name, 'final.task', 'the file name comes from the url');
  assert.ok(seen.length > 0, 'the UI must see progress');
  assert.deepEqual(seen[seen.length - 1], [local.MIN_MODEL_BYTES + 1024, local.MIN_MODEL_BYTES + 1024]);
  const list = await modelstore.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].sourceUrl, 'https://a.test/final.task');
});

test('progress is throttled so a fast pipe is not rendered per chunk', async () => {
  const chunks = Array.from({ length: 200 }, () => bytes(Math.floor(local.MIN_MODEL_BYTES / 100)));
  active.use({ fetchImpl: async () => response(200, bodyOf(...chunks), { 'content-length': String(200 * Math.floor(local.MIN_MODEL_BYTES / 100)) }), now: 0 });
  let reports = 0;
  await modelstore.download({ url: 'https://a.test/many.task', onProgress: () => (reports += 1) });
  assert.ok(reports > 0 && reports < chunks.length, `got ${reports} reports for ${chunks.length} chunks`);
});

// --- local files ------------------------------------------------------------

test('a picked file is stored like a download', async () => {
  const result = await modelstore.importFile({ name: 'mine.task', size: 3_000_000, stream: () => streamOf(bytes(2_000_000), bytes(1_000_000)) });
  assert.equal(result.ok, true);
  assert.equal(result.bytes, 3_000_000);
  assert.equal((await modelstore.list())[0].sourceUrl, '', 'a local file has no source url');
});

test('a picked file without a name is refused', async () => {
  assert.equal((await modelstore.importFile({ name: '', size: 1, stream: () => streamOf(bytes(1)) })).error, 'no-name');
});

// --- capacity ---------------------------------------------------------------

test('usage adds up the models and the quota', async () => {
  await modelstore.ingest({ name: 'one.task', sourceUrl: 'https://a.test/one.task', stream: streamOf(bytes(2_000_000)) });
  active.clock.now += 1;
  await modelstore.ingest({ name: 'two.task', sourceUrl: 'https://a.test/two.task', stream: streamOf(bytes(3_000_000)) });
  active.estimate.usage = 6_000_000;
  active.estimate.quota = 10_000_000;
  const usage = await modelstore.usage();
  assert.equal(usage.models, 2);
  assert.equal(usage.modelBytes, 5_000_000);
  assert.equal(usage.usage, 6_000_000);
});

test('a download that cannot fit is refused before it starts', async () => {
  active.use({ quota: 10_000_000, usage: 9_000_000 });
  assert.equal(await modelstore.fits(5_000_000), false);
  assert.equal(await modelstore.fits(500_000), true);
});

test('an unknown quota never blocks a download', async () => {
  active.use({ quota: 0, usage: 0 });
  assert.equal(await modelstore.fits(5_000_000), true);
  assert.equal(await modelstore.fits(0), false);
});

// --- token ------------------------------------------------------------------

test('the gated-repository token round-trips and is trimmed', async () => {
  assert.equal(await modelstore.getToken(), '');
  await modelstore.setToken('  hf_abc  ');
  assert.equal(await modelstore.getToken(), 'hf_abc');
  assert.equal((await modelstore.list()).length, 0, 'the token must not be listed as a model');
  await modelstore.setToken('');
  assert.equal(await modelstore.getToken(), '');
});

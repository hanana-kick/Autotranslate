import test from 'node:test';
import assert from 'node:assert/strict';
import { load, ggufHead, GGUF_PROBE_BYTES } from './helpers.ts';

const AT = load('lib/constants.js', 'lib/local.js', 'lib/plamo3.js', 'lib/modelstore.js');
const { modelstore, local } = AT;
const STORE = local.STORE;

// --- fakes ------------------------------------------------------------------
// IndexedDB and OPFS are replaced wholesale: the file tests the decisions
// around a transfer (accept, reject, clean up, report), not the storage API.

const bytes = (size: number, fill = 1): Uint8Array => new Uint8Array(size).fill(fill);

/** Bytes as a network gives them: only while somebody is reading. */
const streamOf = (...chunks: Uint8Array[]): ReadableStream<Uint8Array> => {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      if (!chunk) {
        controller.close();
        return;
      }
      index += 1;
      controller.enqueue(chunk);
    },
    cancel(reason: unknown) {
      cancels.push(String(reason ?? ''));
    }
  });
};

type Fakes = ReturnType<typeof fakes>;

function fakes() {
  const meta = new Map<string, unknown>();
  const stored = new Map<string, Uint8Array>();
  const ages = new Map<string, number>();
  const deleted: string[] = [];
  const clock = { now: 1_700_000_000_000 };
  const estimate = { usage: 0, quota: 0, persisted: false };

  // IndexedDB holds exactly one object store, the model records. Anything
  // else asked for - a settings or blob store - is a store the extension no
  // longer has, and must fail here rather than quietly keep secrets.
  const storeOf = (store: string) => {
    if (store !== STORE.metaStore) throw new Error(`unexpected object store ${store}`);
    return meta;
  };
  const driver = {
    get: async (store: string, key: string) => storeOf(store).get(key),
    put: async (store: string, key: string, value: unknown) => {
      storeOf(store).set(key, value);
    },
    remove: async (store: string, key: string) => {
      storeOf(store).delete(key);
    },
    all: async (store: string) => [...storeOf(store).values()]
  };

  const parts = new Map<string, number>();
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
      ages.set(id, clock.now);
      return size;
    },
    read: async (id: string) => (stored.has(id) ? { size: stored.get(id)!.byteLength } : null),
    writePart: async (id: string, name: string, stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      let size = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
      }
      parts.set(`${id}/${name}`, size);
      return size;
    },
    readPart: async (id: string, name: string) =>
      parts.has(`${id}/${name}`) ? { size: parts.get(`${id}/${name}`)! } : null,
    remove: async (id: string) => {
      deleted.push(id);
      stored.delete(id);
      ages.delete(id);
      for (const key of [...parts.keys()]) if (key.startsWith(id + '/')) parts.delete(key);
    },
    list: async () =>
      [...stored.keys()].map((name) => ({ name, lastModified: ages.get(name) ?? clock.now })),
    estimate: async () => ({ ...estimate }),
    persist: async () => true
  };

  const use = (over: { fetchImpl?: unknown; quota?: number; usage?: number; now?: number } = {}) => {
    if (over.quota !== undefined) estimate.quota = over.quota;
    if (over.usage !== undefined) estimate.usage = over.usage;
    if (over.now !== undefined) clock.now = over.now;
    modelstore.configure({ driver, files, now: () => clock.now, ...(over.fetchImpl ? { fetchImpl: over.fetchImpl } : {}) });
  };

  return { meta, stored, ages, deleted, clock, estimate, driver, files, use };
}

/** A response with the members a download reads. */
const response = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  body
});

/** Cancel reasons the fake streams saw, so a test can prove a stopped transfer
 *  released its connection instead of streaming the rest of the file. */
const cancels: string[] = [];

/** A response body as `fetch` really gives one: bytes come through a reader. */
const bodyOf = (...chunks: Uint8Array[]) => {
  let index = 0;
  return {
    getReader: () => ({
      read: async () =>
        index < chunks.length ? { done: false, value: chunks[index++] } : { done: true, value: undefined },
      cancel: async (reason: unknown) => {
        cancels.push(String(reason ?? ''));
      }
    })
  };
};

const big = () => [bytes(local.MIN_MODEL_BYTES), bytes(1024)];
const length = { 'content-length': String(local.MIN_MODEL_BYTES + 1024) };

test.beforeEach(() => {
  const f = fakes();
  active = f;
  f.use();
  cancels.length = 0;
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
  assert.deepEqual(cancels, ['the file was not stored'], 'the rest of the transfer was stopped, not left arriving');
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

// --- the tokenizer tag ------------------------------------------------------
// PLaMo's tokenizer tag is rewritten on the way *into* storage: the file has to
// arrive in OPFS already carrying the tag the vendored runtime has a tokenizer
// for, because the alternative is reading a 1.78 GB file out of storage on
// every start. The gate is `AT.local.isPlamo3File`, so these three cases are
// the whole contract: one byte changed in a file that reads as this model,
// nothing changed in one that does not, and a file that is not a GGUF is
// refused instead of stored under a name it does not deserve.

/** Above the ingest floor and above the head the store holds back, so the patch
 *  is proven against a stream and not an array. */
const MODEL_FILE_BYTES = local.MIN_MODEL_BYTES * 2;

/** A model file in pieces, its first megabyte a real GGUF header. */
function modelFile(model: string, architecture: string): Uint8Array[] {
  const head = ggufHead(model, architecture);
  const rest = MODEL_FILE_BYTES - head.length;
  const quarter = Math.floor(rest / 4);
  return [head, bytes(quarter), bytes(quarter), bytes(quarter), bytes(rest - quarter * 3)];
}

function joined(chunks: Uint8Array[]): Uint8Array {
  const all = new Uint8Array(chunks.reduce((sum, one) => sum + one.byteLength, 0));
  let at = 0;
  for (const one of chunks) {
    all.set(one, at);
    at += one.byteLength;
  }
  return all;
}

/** The value of `tokenizer.ggml.model`: past the key, its u32 type tag and its
 *  8-byte length, which is where the walker said the string would begin. */
function tokenizerTag(file: Uint8Array): string {
  const key = Buffer.from('tokenizer.ggml.model', 'utf8');
  const at = Buffer.from(file).indexOf(key);
  assert.notEqual(at, -1, 'the header names its tokenizer');
  const value = at + key.length + 4 + 8;
  return Buffer.from(file.subarray(value, value + 6)).toString('utf8');
}

/** How often a tag appears in the part of the file that holds metadata. */
const times = (file: Uint8Array, needle: string): number =>
  Buffer.from(file.subarray(0, GGUF_PROBE_BYTES)).toString('latin1').split(needle).length - 1;

const PLAMO_NAME = 'plamo-3-translate-0.8b-BF16.gguf';
const PLAMO_URL = `https://a.test/${PLAMO_NAME}`;

/** A file `isPlamo3File` cannot read as this model: neither its name nor its
 *  url carries the model's name, so its bytes go to storage untouched. */
const OTHER_NAME = 'other-model-1.8b-q8_0.gguf';
const OTHER_URL = `https://a.test/${OTHER_NAME}`;

test('a PLaMo file is stored carrying the tokenizer tag the runtime can load', async () => {
  const file = modelFile('plamo3', 'plamo3');
  const result = await modelstore.ingest({ name: PLAMO_NAME, sourceUrl: PLAMO_URL, stream: streamOf(...file) });
  assert.equal(result.ok, true, String(result.error));
  const stored = active.stored.get(String(result.record!.id))!;
  assert.equal(stored.byteLength, MODEL_FILE_BYTES, 'the two tags are the same length, so the file is too');
  assert.equal(tokenizerTag(stored), 'plamo2', 'the tag with no tokenizer behind it is rewritten on the way in');
  assert.equal(times(stored, 'plamo3'), 1, 'the architecture keeps its own name');
  assert.equal(times(stored, 'plamo2'), 1, 'and nothing else takes the new tag');
  const original = joined(file);
  let differing = 0;
  for (let at = 0; at < original.byteLength; at += 1) {
    if (original[at] !== stored[at]) differing += 1;
  }
  assert.equal(differing, 1, 'one byte differs, and it is the tag');
});

test('a file that is not this model is stored byte for byte as it arrived', async () => {
  const file = modelFile('gpt2', 'llama');
  const result = await modelstore.ingest({
    name: OTHER_NAME,
    sourceUrl: OTHER_URL,
    stream: streamOf(...file)
  });
  assert.equal(result.ok, true, String(result.error));
  assert.deepEqual(
    active.stored.get(String(result.record!.id)),
    joined(file),
    'no byte is touched for a file that never needed the rewrite'
  );
});

test('a file that is not a GGUF is refused rather than stored under a PLaMo name', async () => {
  const result = await modelstore.ingest({
    name: PLAMO_NAME,
    sourceUrl: PLAMO_URL,
    stream: streamOf(bytes(MODEL_FILE_BYTES))
  });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /not a GGUF file/);
  assert.deepEqual(await modelstore.list(), [], 'nothing is registered');
  assert.equal(active.stored.size, 0, 'and no bytes are left in the way');
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

test('a download asks for bytes and carries no credential', async () => {
  // The model is published without a login: what leaves is the url the user
  // chose and an Accept header, so nothing can identify anybody.
  const seen: { url: string; init: { headers: Record<string, string> } }[] = [];
  active.use({
    fetchImpl: async (url: string, init: { headers: Record<string, string> }) => {
      seen.push({ url, init });
      // The card's own artifact: a PLaMo header, so the rewrite runs on the
      // way into storage and the transfer has to be a real GGUF.
      const served = { 'content-length': String(MODEL_FILE_BYTES) };
      return response(200, bodyOf(...modelFile('plamo3', 'plamo3')), served);
    }
  });
  const result = await modelstore.download({
    url: 'https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF/resolve/main/plamo-3-translate-0.8b-Q4_K_M.gguf'
  });
  assert.equal(result.ok, true, String(result.error));
  assert.equal(
    seen[0]!.url,
    'https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF/resolve/main/plamo-3-translate-0.8b-Q4_K_M.gguf'
  );
  assert.deepEqual(seen[0]!.init.headers, { Accept: 'application/octet-stream' });
});

test('an http failure keeps the status code in the error', async () => {
  // A refusal from the host stays what it is, even the 401/403 that once read
  // as "this repository is gated": the download failed, with the code to show.
  for (const status of [401, 403, 503]) {
    active.use({ fetchImpl: async () => response(status, null) });
    const result = await modelstore.download({ url: 'https://a.test/model.task' });
    assert.equal(result.error, `http-${status}`, `status ${status}`);
    assert.equal(active.stored.size, 0, 'a refused download stores nothing');
  }
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

// --- sweep ------------------------------------------------------------------

/** A file as the file system would report it after an earlier session died. */
function aged(name: string, at: number): void {
  active.stored.set(name, bytes(local.MIN_MODEL_BYTES));
  active.ages.set(name, at);
}

test('bytes no record claims are dropped and a claimed file is kept', async () => {
  const result = await modelstore.ingest({
    name: 'kept.gguf',
    sourceUrl: 'https://a.test/kept.gguf',
    stream: streamOf(...big())
  });
  const id = result.record.id;
  active.ages.set(id, 0);
  aged('ghost.gguf', 0);

  assert.deepEqual((await modelstore.sweep()).removed, ['ghost.gguf']);
  assert.equal(active.stored.has(id), true, 'a model the list still shows keeps its bytes');
  assert.equal(active.stored.has('ghost.gguf'), false);
  assert.deepEqual(active.deleted, ['ghost.gguf']);
});

test('a file with no record yet is a download in progress, not debris', async () => {
  // The record appears only when a transfer ends, so a young file must survive
  // a sweep even one started by another page of the extension.
  aged('arriving.gguf', active.clock.now);
  assert.deepEqual((await modelstore.sweep()).removed, []);
  assert.equal(active.stored.has('arriving.gguf'), true);
});

test('a stale swap file is swept and a live one is left alone', async () => {
  aged('half.gguf.tmp', 0);
  aged('writing.gguf.tmp', active.clock.now);
  assert.deepEqual((await modelstore.sweep()).removed, ['half.gguf.tmp']);
  assert.equal(active.stored.has('writing.gguf.tmp'), true);
});

// --- multi-file (ONNX) ingest -------------------------------------------------

test('an ONNX install stores the graph and each part, and registers only the complete set', async () => {
  const graph = big();
  const graphLength = { 'content-length': String(graph[0]!.length + graph[1]!.length) };
  const partBytes = bytes(2048, 7);
  const seen: string[] = [];
  const fetchImpl = async (url: string) => {
    seen.push(url);
    if (url.endsWith('.onnx')) return response(200, bodyOf(...graph as [Uint8Array, ...Uint8Array[]]), graphLength);
    return response(200, bodyOf(partBytes), { 'content-length': String(partBytes.length) });
  };
  active.use({ fetchImpl });

  const result = await modelstore.ingestOnnx({
    graphUrl: 'https://example.test/repo/resolve/main/onnx/model_q4f16.onnx',
    expectedSize: graph[0]!.length + graph[1]!.length,
    parts: ['config.json', 'tokenizer.json']
  });

  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.ok(result.record);
  assert.equal(result.record!.size, graph[0]!.length + graph[1]!.length);
  assert.deepEqual(seen, [
    'https://example.test/repo/resolve/main/onnx/model_q4f16.onnx',
    'https://example.test/repo/resolve/main/config.json',
    'https://example.test/repo/resolve/main/tokenizer.json'
  ]);
  const id = result.record!.id;
  assert.equal(active.stored.get(id)?.length, graph[0]!.length + graph[1]!.length, 'the graph is stored whole');
  const storedPart = await modelstore.readPart(id, 'config.json');
  assert.ok(storedPart && Number((storedPart as { size: number }).size) === 2048, 'a part reads back under the model id');
  assert.equal(await modelstore.readPart(id, 'missing.json'), null, 'a part that was never stored is null');
  assert.ok(await modelstore.read(id), 'the graph reads back as the model file');
});

test('an ONNX install that misses a part leaves nothing behind', async () => {
  const graph = big();
  const fetchImpl = async (url: string) => {
    if (url.endsWith('.onnx')) return response(200, bodyOf(...graph as [Uint8Array, ...Uint8Array[]]), { 'content-length': String(graph[0]!.length + graph[1]!.length) });
    return response(404, null);
  };
  active.use({ fetchImpl });
  const result = await modelstore.ingestOnnx({
    graphUrl: 'https://example.test/repo/resolve/main/onnx/model_q4f16.onnx',
    parts: ['config.json']
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'missing part config.json');
  assert.equal((await modelstore.list()).length, 0, 'no record is registered');
  assert.deepEqual(active.deleted.length, 1, 'the partial directory is removed');
});

test('an ONNX graph that comes up short is truncated and removed', async () => {
  const full = big();
  const fetchImpl = async (url: string) => {
    if (url.endsWith('.onnx')) return response(200, bodyOf(full[0]!), { 'content-length': String(full[0]!.length + full[1]!.length) });
    return response(200, bodyOf(bytes(10)));
  };
  active.use({ fetchImpl });
  const result = await modelstore.ingestOnnx({
    graphUrl: 'https://example.test/repo/resolve/main/onnx/model_q4f16.onnx',
    expectedSize: full[0]!.length + full[1]!.length,
    parts: ['config.json']
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'truncated');
  assert.equal((await modelstore.list()).length, 0);
});

// Where the model files live: gigabyte-sized files in OPFS, their metadata in
// IndexedDB. Runs in any extension context that can reach storage (options,
// popup, the host wherever it is placed); the two seams below are what the
// tests replace, so all the logic around download, validation and cleanup is
// covered without a browser.
// Load after lib/constants.js, lib/local.js.
namespace AT.modelstore {
  const L = AT.local;
  const S = L.STORE;

  /** The swap file `createWritable()` writes through before the name appears.
   *  Implementation-defined, so its absence is normal and its persistence is not. */
  const TMP_SUFFIX = '.tmp';

  /** Longer than any transfer this extension makes: below it a file is a download
   *  in progress, above it a file is debris. */
  const RECENT_WRITE_MS = 60 * 60 * 1000;

  export type ModelRecord = AT.local.ModelRecord;

  /** Metadata persistence, replaced by the tests. */
  export type Driver = {
    get(store: string, key: string): Promise<unknown>;
    put(store: string, key: string, value: unknown): Promise<void>;
    remove(store: string, key: string): Promise<void>;
    all(store: string): Promise<unknown[]>;
  };

  /** One byte file as the file system reports it: a sweep needs the name and the
   *  age, nothing else. */
  export type StoredFile = { name: string; lastModified: number };

  /** Byte storage, replaced by the tests. A model may be more than one file
   *  (an ONNX export ships a graph plus its tokenizer and config), so writes
   *  and reads are keyed by `id/name` and a model's files share the id. */
  export type Files = {
    /** Writes the whole stream; returns the number of bytes stored. */
    write(id: string, stream: ReadableStream<Uint8Array>): Promise<number>;
    read(id: string): Promise<Blob | null>;
    /** Writes one named part of a multi-file model, under the same id. */
    writePart(id: string, name: string, stream: ReadableStream<Uint8Array>): Promise<number>;
    /** Reads one named part of a multi-file model. */
    readPart(id: string, name: string): Promise<Blob | null>;
    remove(id: string): Promise<void>;
    /** Every file under the model directory, including a half-written one. */
    list(): Promise<StoredFile[]>;
    estimate(): Promise<{ usage: number; quota: number; persisted: boolean }>;
    persist(): Promise<boolean>;
  };

  /** The response members a download reads; `fetch` is compatible with it. */
  export type StreamResponse = {
    ok: boolean;
    status: number;
    headers: { get(name: string): string | null };
    /** Bytes arrive through a reader; this is the member `fetch` really gives. */
    body: {
      getReader(): {
        read(): Promise<{ done: boolean; value?: Uint8Array }>;
        cancel(reason?: unknown): Promise<void>;
      };
    } | null;
  };

  export type StreamFetch = (
    url: string,
    init: { headers: Record<string, string>; signal?: AbortSignal | undefined }
  ) => Promise<StreamResponse>;

  type Deps = {
    driver: Driver | null;
    files: Files | null;
    fetchImpl: StreamFetch | null;
    now: () => number;
  };

  const deps: Deps = { driver: null, files: null, fetchImpl: null, now: () => Date.now() };

  export function configure(next: Partial<Deps>): void {
    if (next.driver !== undefined) deps.driver = next.driver;
    if (next.files !== undefined) deps.files = next.files;
    if (next.fetchImpl !== undefined) deps.fetchImpl = next.fetchImpl;
    if (next.now !== undefined) deps.now = next.now;
  }

  export function ready(): boolean {
    return Boolean(deps.driver && deps.files);
  }

  // ---------------------------------------------------------------- IndexedDB

  let database: IDBDatabase | null = null;

  function openDatabase(): Promise<IDBDatabase> {
    if (database) return Promise.resolve(database);
    const factory = globalThis.indexedDB;
    if (!factory) return Promise.reject(new Error('indexedDB is unavailable'));
    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(S.dbName, S.dbVersion);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(S.metaStore)) db.createObjectStore(S.metaStore);
      };
      request.onsuccess = () => {
        database = request.result;
        resolve(database);
      };
      request.onerror = () => reject(request.error ?? new Error('cannot open the model database'));
    });
  }

  function ask<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('model store failure'));
    });
  }

  /** The real driver: one object store per purpose, keys are ids. */
  export function indexedDbDriver(): Driver {
    const withStore = (
      store: string,
      mode: IDBTransactionMode,
      body: (objectStore: IDBObjectStore) => IDBRequest<unknown>
    ): Promise<unknown> =>
      openDatabase().then((db) => ask(body(db.transaction(store, mode).objectStore(store))));
    return {
      get: (store, key) => withStore(store, 'readonly', (os) => os.get(key) as IDBRequest<unknown>),
      put: (store, key, value) =>
        withStore(store, 'readwrite', (os) => os.put(value, key) as IDBRequest<unknown>).then(() => undefined),
      remove: (store, key) =>
        withStore(store, 'readwrite', (os) => os.delete(key) as IDBRequest<unknown>).then(() => undefined),
      all: (store) =>
        withStore(store, 'readonly', (os) => os.getAll() as unknown as IDBRequest<unknown>) as Promise<unknown[]>
    };
  }

  // --------------------------------------------------------------------- OPFS

  /** The listing a directory handle gives; `lib.dom` types the handle's own
   *  iterator as [name, handle] pairs, so a sweep asks for the values. */
  type Listing = { values(): AsyncIterable<FileSystemHandle> };

  /** The real byte store: one directory per model under `models/`, so a
   *  multi-file model (an ONNX export) keeps its graph, tokenizer and config
   *  together and is removed as one unit. */
  export function opfsFiles(): Files {
    const directory = async (): Promise<FileSystemDirectoryHandle> => {
      const storage = globalThis.navigator?.storage;
      if (!storage?.getDirectory) throw new Error('the origin private file system is unavailable');
      return storage.getDirectory();
    };
    const modelDir = async (id: string, create: boolean): Promise<FileSystemDirectoryHandle> => {
      const root = await directory();
      if (!create) {
        // A pre-existing single-file model from an older build is a plain file.
        const dir = await root.getDirectoryHandle(S.filesDir, { create: false });
        try {
          await dir.getDirectoryHandle(id, { create: false });
          return dir.getDirectoryHandle(id, { create: false });
        } catch {
          return dir;
        }
      }
      const dir = await root.getDirectoryHandle(S.filesDir, { create: true });
      return dir.getDirectoryHandle(id, { create: true });
    };
    const partHandle = async (id: string, name: string | null, create: boolean): Promise<FileSystemFileHandle | null> => {
      const dir = await modelDir(id, create);
      if (!create) {
        try {
          return name === null ? await dir.getFileHandle(id) : await dir.getFileHandle(name);
        } catch {
          return null;
        }
      }
      return name === null ? dir.getFileHandle(id, { create: true }) : dir.getFileHandle(name, { create: true });
    };
    const writeOne = async (handle: FileSystemFileHandle, stream: ReadableStream<Uint8Array>): Promise<number> => {
      const writable = (await handle.createWritable()) as FileSystemWritableFileStream;
      const reader = stream.getReader();
      let written = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (!chunk.value) continue;
          written += chunk.value.byteLength;
          // A response without a length is still bounded: this is the only
          // artefact the extension executes, and the quota is the user's disk.
          if (written > L.MAX_MODEL_BYTES) throw new Error('model-too-large');
          await writable.write(chunk.value as unknown as BufferSource);
        }
      } catch (error: unknown) {
        try {
          await writable.abort?.(error as Error);
        } catch {
          // An already-dead stream cannot be aborted; the throw below stands.
        }
        throw error;
      }
      // `close()` is where OPFS commits the swap file: a failure here means
      // nothing was stored, so it must reach `ingest` and clean up.
      await writable.close();
      return written;
    };
    return {
      async write(id, stream) {
        const handle = await partHandle(id, null, true);
        if (!handle) throw new Error(`cannot create the file for model ${id}`);
        return writeOne(handle, stream);
      },
      async writePart(id, name, stream) {
        const handle = await partHandle(id, name, true);
        if (!handle) throw new Error(`cannot create ${name} for model ${id}`);
        return writeOne(handle, stream);
      },
      async read(id) {
        const handle = await partHandle(id, null, false);
        if (!handle) return null;
        return handle.getFile();
      },
      async readPart(id, name) {
        const handle = await partHandle(id, name, false);
        if (!handle) return null;
        return handle.getFile();
      },
      async remove(id) {
        const root = await directory();
        try {
          const dir = await root.getDirectoryHandle(S.filesDir, { create: false });
          await dir.removeEntry(id, { recursive: true });
        } catch {
          // Missing file or directory: nothing left to delete.
        }
      },
      async list() {
        const root = await directory();
        let dir: FileSystemDirectoryHandle;
        try {
          dir = await root.getDirectoryHandle(S.filesDir, { create: false });
        } catch {
          // No directory yet: nothing has ever been stored.
          return [];
        }
        // The handle's own iterator yields [name, handle] pairs, values() handles.
        const entries = dir as unknown as Listing;
        const out: StoredFile[] = [];
        for await (const handle of entries.values()) {
          if (handle.kind === 'file') {
            const file = await (handle as FileSystemFileHandle).getFile();
            out.push({ name: handle.name, lastModified: Number(file.lastModified) || 0 });
          } else {
            // A model directory counts as its graph file for sweep purposes.
            const sub = handle as unknown as Listing;
            for await (const inner of sub.values()) {
              if (inner.kind !== 'file') continue;
              const file = await (inner as FileSystemFileHandle).getFile();
              out.push({ name: `${handle.name}/${inner.name}`, lastModified: Number(file.lastModified) || 0 });
            }
          }
        }
        return out;
      },
      async estimate() {
        const storage = globalThis.navigator?.storage;
        if (!storage?.estimate) return { usage: 0, quota: 0, persisted: false };
        const estimate = await storage.estimate();
        return {
          usage: Number(estimate.usage) || 0,
          quota: Number(estimate.quota) || 0,
          persisted: (await storage.persisted?.()) === true
        };
      },
      async persist() {
        const storage = globalThis.navigator?.storage;
        if (!storage?.persist) return false;
        return storage.persist();
      }
    };
  }

  function driver(): Driver {
    if (!deps.driver) deps.driver = indexedDbDriver();
    return deps.driver;
  }

  function files(): Files {
    if (!deps.files) deps.files = opfsFiles();
    return deps.files;
  }

  // ------------------------------------------------------------------ records

  // The engine's `callHost` picks the host module by the installed model's
  // kind without awaiting, so the store hands it a synchronous view of the
  // records it holds; `list()` and `get()` refresh that view.
  let known: ModelRecord[] = [];
  L.bindRecordLookup((modelId: string) => known.find((record) => record.id === modelId) ?? null);

  export async function list(): Promise<ModelRecord[]> {
    const raw = await driver().all(S.metaStore);
    known = L.normalizeModels(raw);
    return known;
  }

  export async function get(id: string): Promise<ModelRecord | null> {
    const record = L.normalizeModel(await driver().get(S.metaStore, id));
    if (record) {
      const existing = known.findIndex((entry) => entry.id === record.id);
      if (existing >= 0) known[existing] = record;
      else known.push(record);
    }
    return record;
  }

  export async function find(nameOrId: string): Promise<ModelRecord | null> {
    const records = await list();
    return records.find((record) => record.id === nameOrId || record.name === nameOrId) ?? null;
  }

  /** Reads a stored model as a Blob, or null when the file is gone. */
  export async function read(id: string): Promise<Blob | null> {
    const record = await get(id);
    if (!record) return null;
    return files().read(record.id);
  }

  async function putRecord(record: ModelRecord): Promise<void> {
    await driver().put(S.metaStore, record.id, record);
  }

  /** Deletes metadata and bytes together; reports whether anything was there. */
  export async function remove(id: string): Promise<boolean> {
    const existing = await get(id);
    await files().remove(id);
    await driver().remove(S.metaStore, id);
    return existing !== null;
  }

  /**
   * Drop bytes no record claims. A crash between the file write and the record
   * write, or a file an older build left behind, is otherwise a gigabyte the
   * user can neither see in the list nor delete from it. A file being written is
   * not an orphan: its record appears only at the end of a transfer, so anything
   * younger than the hour a download could take is left alone, here or in any
   * other page of the extension.
   */
  export async function sweep(): Promise<{ removed: string[] }> {
    const known = new Set((await list()).map((record) => record.id));
    const now = deps.now();
    const removed: string[] = [];
    for (const entry of await files().list()) {
      if (now - entry.lastModified < RECENT_WRITE_MS) continue;
      if (!entry.name.endsWith(TMP_SUFFIX) && known.has(entry.name)) continue;
      await files().remove(entry.name);
      removed.push(entry.name);
    }
    return { removed };
  }

  export type IngestRequest = {
    name: string;
    sourceUrl: string;
    stream: ReadableStream<Uint8Array> | null;
    /** The size the transfer promised; a shorter write is thrown away. */
    expectedBytes?: number | undefined;
  };

  export type IngestResult = {
    ok: boolean;
    record: ModelRecord | null;
    error: string | null;
    bytes: number;
    /** Ids of earlier copies this one replaced; the selection may point at one. */
    retired?: string[];
  };

  /** Wraps a stream so every consumer sees the same bytes and can be counted. */
  function countingStream(
    source: ReadableStream<Uint8Array>,
    onChunk: (received: number) => void
  ): ReadableStream<Uint8Array> {
    let received = 0;
    const reader = source.getReader();
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          return;
        }
        if (chunk.value) {
          received += chunk.value.byteLength;
          onChunk(received);
        }
        controller.enqueue(chunk.value as Uint8Array);
      },
      cancel(reason) {
        return reader.cancel(reason);
      }
    });
  }

  /** How much of a GGUF is read before the tokenizer tag is rewritten. A
   *  converted PLaMo 3 file finishes its metadata 2.5 MB in - the 107,520
   *  vocabulary entries, their scores and their types are all ahead of the
   *  tensor data - so one megabyte is probed first and the hold grows by
   *  doubling. The cap is not a guess about this model: above it a file's header
   *  is so far from the shape ours is that refusing it is worth more than
   *  buffering it, and the runtime could not have read it either. */
  const HEAD_PROBE = 1 << 20;
  const HEAD_CAP = 64 << 20;

  /** The walker's own way of saying "read me further"; anything else it raises
   *  is a file that is not what its name claimed. */
  const isShortHeader = (error: unknown): boolean =>
    error instanceof Error && /truncated/.test(error.message);

  /**
   * Rewrites PLaMo's tokenizer tag while the bytes go past, so the file that
   * ends up in OPFS is the one the runtime can load: the vendored wasm carries
   * the plamo3 architecture but no plamo3 tokenizer, and an unpatched file
   * stops at `unknown tokenizer: 'plamo3'` (see `AT.plamo3.patchTokenizerTag`).
   *
   * Only the header is held back. Everything after it is streamed through
   * untouched, which is the point of patching here rather than at load: the
   * alternative is reading a 1.78 GB file out of storage on every start.
   */
  function tokenizerPatch(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    const reader = source.getReader();
    const head: Uint8Array[] = [];
    const queued: Uint8Array[] = [];
    let held = 0;
    let probe = HEAD_PROBE;
    let settled = false;
    let ended = false;

    const patchHead = (): void => {
      const all = new Uint8Array(held);
      let at = 0;
      for (const part of head) {
        all.set(part, at);
        at += part.byteLength;
      }
      const result = AT.plamo3.patchTokenizerTag(all);
      AT.log('plamo3 tokenizer retagged for the runtime', result.patched);
      head.length = 0;
      settled = true;
      queued.push(result.bytes);
    };

    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        for (;;) {
          if (queued.length) {
            controller.enqueue(queued.shift() as Uint8Array);
            return;
          }
          if (ended) {
            controller.close();
            return;
          }
          const chunk = await reader.read();
          if (chunk.done) {
            ended = true;
            // A file shorter than the first probe is the whole header; there is
            // nothing left to read that could complete it.
            if (!settled) patchHead();
            continue;
          }
          if (!chunk.value) continue;
          if (settled) {
            queued.push(chunk.value);
            continue;
          }
          head.push(chunk.value);
          held += chunk.value.byteLength;
          if (held < probe) continue;
          try {
            patchHead();
          } catch (error: unknown) {
            if (!isShortHeader(error) || held >= HEAD_CAP) throw error;
            probe = Math.min(HEAD_CAP, held * 2);
          }
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      }
    });
  }

  /**
   * Streams a model into storage. Only a complete file is registered, so an
   * aborted or failed transfer never leaves a half model behind.
   */
  export async function ingest(request: IngestRequest): Promise<IngestResult> {
    const url = L.normalizeDownloadUrl(request.sourceUrl) ?? '';
    const name = typeof request.name === 'string' ? request.name.trim().slice(0, 120) : '';
    if (!request.stream) return { ok: false, record: null, error: 'no-stream', bytes: 0 };
    if (!name) return { ok: false, record: null, error: 'no-name', bytes: 0 };

    const id = L.makeModelId(name, url, deps.now());
    // The tokenizer rewrite is the one thing that may change the bytes on their
    // way to storage, and it happens only to the file that needs it.
    const stream = L.isPlamo3File({ name, sourceUrl: url })
      ? tokenizerPatch(request.stream)
      : request.stream;
    let bytes = 0;
    try {
      bytes = await files().write(id, stream);
    } catch (error: unknown) {
      await files().remove(id);
      const rejection = error as { name?: string; message?: string };
      // Nothing will read this stream now. Cancelling is what stops the rest of
      // the file arriving over the network into a stream nobody wants.
      try {
        await request.stream?.cancel('the file was not stored');
      } catch {
        // A stream that died with the write has nothing left to cancel.
      }
      return {
        ok: false,
        record: null,
        error: rejection?.name === 'AbortError' ? 'cancelled' : (rejection?.message ?? 'write-failed'),
        bytes: 0
      };
    }
    // A stream that stopped short of what the source promised is a truncated
    // download even when the shortfall also puts it under the model minimum:
    // "the transfer was cut off" is the reason the user can act on.
    if (typeof request.expectedBytes === 'number' && request.expectedBytes > 0 && bytes !== request.expectedBytes) {
      await files().remove(id);
      return { ok: false, record: null, error: 'truncated', bytes };
    }
    const record = L.normalizeModel({
      id,
      name,
      size: bytes,
      sourceUrl: url,
      createdAt: deps.now()
    });
    if (!record) {
      await files().remove(id);
      return { ok: false, record: null, error: bytes < L.MIN_MODEL_BYTES ? 'too-small' : 'invalid-record', bytes };
    }
    // Registration is the last step, and it retires the copy this one replaces,
    // so a failed transfer above can never touch a working model.
    try {
      await putRecord(record);
    } catch (error: unknown) {
      // Two gigabytes are already on disk: do not leave them behind without a
      // record, where nothing can list or delete them.
      await files().remove(id);
      return { ok: false, record: null, error: 'store-failed', bytes };
    }
    const retired = await replaceExisting(record).catch((error: unknown) => {
      AT.warn('retiring the replaced model failed', error);
      return [] as string[];
    });
    return { ok: true, record, error: null, bytes, retired };
  }

  export type OnnxInstallRequest = {
    /** The graph's URL; also the base for the small parts beside it. */
    graphUrl: string;
    name?: string | undefined;
    /** The graph's declared size, used as the truncation check. */
    expectedSize?: number | undefined;
    signal?: AbortSignal | undefined;
    onProgress?: ((received: number, total: number | null) => void) | undefined;
    /** The small files beside the graph, relative to the repo root. */
    parts: string[];
  };

  /**
   * Installs a multi-file ONNX export: the graph streams into OPFS as the
   * model's main file, each small part (config, tokenizer) lands beside it,
   * and only a complete set is registered. An aborted transfer leaves nothing
   * behind, exactly like `ingest`.
   */
  export async function ingestOnnx(request: OnnxInstallRequest): Promise<IngestResult> {
    const graphUrl = L.normalizeDownloadUrl(request.graphUrl);
    if (!graphUrl) return { ok: false, record: null, error: 'bad-url', bytes: 0 };
    const doFetch = deps.fetchImpl ?? (globalThis.fetch as unknown as StreamFetch | undefined);
    if (typeof doFetch !== 'function') return { ok: false, record: null, error: 'no-fetch', bytes: 0 };
    const name =
      (typeof request.name === 'string' && request.name.trim()) || fileNameFromUrl(graphUrl) || 'model.onnx';
    const id = L.makeModelId(name, graphUrl, deps.now());
    // The parts live at the repo root, two levels above `onnx/model.onnx`.
    const base = graphUrl.slice(0, graphUrl.lastIndexOf('/onnx/') + 1);

    const fetchStream = async (url: string, expected: number | null): Promise<ReadableStream<Uint8Array> | null> => {
      let response: StreamResponse;
      try {
        response = await doFetch(url, { headers: { Accept: 'application/octet-stream' }, signal: request.signal });
      } catch (error: unknown) {
        const rejection = error as { name?: string };
        throw new Error(rejection?.name === 'AbortError' ? 'cancelled' : 'network');
      }
      if (!response.ok || !response.body) return null;
      const declared = Number(response.headers.get('content-length'));
      const total = Number.isFinite(declared) && declared > 0 ? Math.round(declared) : null;
      if (expected !== null && total !== null && Math.abs(total - expected) / expected > 0.05) {
        throw new Error('size-mismatch');
      }
      const reader = (response.body as NonNullable<StreamResponse['body']>).getReader();
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          const chunk = await reader.read();
          if (chunk.done) {
            controller.close();
            return;
          }
          controller.enqueue(chunk.value as Uint8Array);
        },
        cancel(reason: unknown) {
          return reader.cancel(reason);
        }
      });
    };

    let bytes = 0;
    try {
      let lastReport = 0;
      const graphStream = await fetchStream(graphUrl, request.expectedSize ?? null);
      if (!graphStream) throw new Error('no-body');
      const counted = countingStream(graphStream, (received) => {
        const now = deps.now();
        const total = request.expectedSize ?? null;
        if (now - lastReport < L.DOWNLOAD_PROGRESS_INTERVAL_MS && !(total !== null && received >= total)) return;
        lastReport = now;
        request.onProgress?.(received, total);
      });
      bytes = await files().write(id, counted);
      for (const part of request.parts) {
        const partUrl = base + part;
        const stream = await fetchStream(partUrl, null);
        if (!stream) throw new Error(`missing part ${part}`);
        await files().writePart(id, part, stream);
      }
    } catch (error: unknown) {
      await files().remove(id);
      const rejection = error as { name?: string; message?: string };
      return {
        ok: false,
        record: null,
        error: rejection?.name === 'AbortError' || rejection?.message === 'cancelled' ? 'cancelled' : (rejection?.message ?? 'write-failed'),
        bytes: 0
      };
    }
    if (typeof request.expectedSize === 'number' && request.expectedSize > 0 && bytes !== request.expectedSize) {
      await files().remove(id);
      return { ok: false, record: null, error: 'truncated', bytes };
    }
    const record = L.normalizeModel({
      id,
      name,
      size: bytes,
      sourceUrl: graphUrl,
      createdAt: deps.now()
    });
    if (!record) {
      await files().remove(id);
      return { ok: false, record: null, error: bytes < L.MIN_MODEL_BYTES ? 'too-small' : 'invalid-record', bytes };
    }
    try {
      await putRecord(record);
    } catch (error: unknown) {
      await files().remove(id);
      return { ok: false, record: null, error: 'store-failed', bytes };
    }
    const retired = await replaceExisting(record).catch(() => [] as string[]);
    return { ok: true, record, error: null, bytes, retired };
  }

  /** Reads one named part of a stored multi-file model. */
  export async function readPart(id: string, name: string): Promise<Blob | null> {
    if (!(await get(id))) return null;
    return files().readPart(id, name);
  }

  /** Deletes previous copies of the same file; answers the ids it retired. */
  async function replaceExisting(record: ModelRecord): Promise<string[]> {
    const records = await list();
    const retired: string[] = [];
    for (const existing of records) {
      if (existing.name === record.name && existing.id !== record.id && (await remove(existing.id))) {
        retired.push(existing.id);
      }
    }
    return retired;
  }

  export type DownloadRequest = {
    url: string;
    name?: string | undefined;
    expectedSize?: number | undefined;
    signal?: AbortSignal | undefined;
    onProgress?: ((received: number, total: number | null) => void) | undefined;
  };

  /** Downloads a model over HTTPS. `expectedSize` is only a sanity check. */
  export async function download(request: DownloadRequest): Promise<IngestResult> {
    const url = L.normalizeDownloadUrl(request.url);
    if (!url) return { ok: false, record: null, error: 'bad-url', bytes: 0 };
    const doFetch = deps.fetchImpl ?? (globalThis.fetch as unknown as StreamFetch | undefined);
    if (typeof doFetch !== 'function') return { ok: false, record: null, error: 'no-fetch', bytes: 0 };

    // The model is published without a login, so no request carries a
    // credential: what goes out is the URL the user typed and nothing else.
    const headers: Record<string, string> = { Accept: 'application/octet-stream' };

    let response: StreamResponse;
    try {
      response = await doFetch(url, { headers, signal: request.signal });
    } catch (error: unknown) {
      const rejection = error as { name?: string; message?: string };
      return {
        ok: false,
        record: null,
        error: rejection?.name === 'AbortError' ? 'cancelled' : (rejection?.message ?? 'network'),
        bytes: 0
      };
    }
    if (!response.ok) {
      return { ok: false, record: null, error: `http-${response.status}`, bytes: 0 };
    }
    if (!response.body) return { ok: false, record: null, error: 'no-body', bytes: 0 };

    const declared = Number(response.headers.get('content-length'));
    const total = Number.isFinite(declared) && declared > 0 ? Math.round(declared) : null;
    if (total !== null && (total < L.MIN_MODEL_BYTES || total > L.MAX_MODEL_BYTES)) {
      return { ok: false, record: null, error: 'bad-size', bytes: total };
    }
    if (typeof request.expectedSize === 'number' && total !== null && request.expectedSize > 0) {
      const drift = Math.abs(total - request.expectedSize) / request.expectedSize;
      if (drift > 0.05) return { ok: false, record: null, error: 'size-mismatch', bytes: total };
    }

    let lastReport = 0;
    const reader = (response.body as NonNullable<StreamResponse['body']>).getReader();
    const stream = countingStream(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          const chunk = await reader.read();
          if (chunk.done) {
            controller.close();
            return;
          }
          controller.enqueue(chunk.value as Uint8Array);
        },
        // A cancelled transfer must release the connection rather than let the
        // rest of the gigabyte stream into a stream nobody reads.
        cancel(reason: unknown) {
          return reader.cancel(reason);
        }
      }),
      (received) => {
        const now = deps.now();
        if (now - lastReport < L.DOWNLOAD_PROGRESS_INTERVAL_MS && !(total !== null && received >= total)) return;
        lastReport = now;
        request.onProgress?.(received, total);
      }
    );

    const fileName =
      (typeof request.name === 'string' && request.name.trim()) || fileNameFromUrl(url) || 'model.gguf';
    return ingest({ name: fileName, sourceUrl: url, stream, expectedBytes: total ?? undefined });
  }

  /** Stores a file the user picked locally: the way to use a model on disk. */
  export async function importFile(
    file: { name: string; size: number; stream?: (() => ReadableStream<Uint8Array>) | undefined },
    options: { onProgress?: ((received: number, total: number | null) => void) | undefined } = {}
  ): Promise<IngestResult> {
    const name = typeof file?.name === 'string' ? file.name.trim().slice(0, 120) : '';
    if (!name) return { ok: false, record: null, error: 'no-name', bytes: 0 };
    const makeStream = () =>
      typeof file.stream === 'function'
        ? file.stream()
        : new ReadableStream<Uint8Array>({
            async start(controller) {
              const blob = (file as unknown as Blob) as Blob;
              controller.enqueue(new Uint8Array(await blob.arrayBuffer()));
              controller.close();
            }
          });
    let lastReport = 0;
    const total = Number(file.size) > 0 ? Number(file.size) : null;
    const stream = countingStream(makeStream(), (received) => {
      const now = deps.now();
      if (now - lastReport < L.DOWNLOAD_PROGRESS_INTERVAL_MS && !(total !== null && received >= total)) return;
      lastReport = now;
      options.onProgress?.(received, total);
    });
    const result = await ingest({ name, sourceUrl: 'file://local', stream });
    return result;
  }

  function fileNameFromUrl(url: string): string {
    try {
      const path = new URL(url).pathname;
      const last = path.split('/').filter(Boolean).pop() ?? '';
      return decodeURIComponent(last).slice(0, 120);
    } catch {
      return '';
    }
  }

  // -------------------------------------------------------------------- quota

  export type Usage = {
    usage: number;
    quota: number;
    persisted: boolean;
    models: number;
    modelBytes: number;
  };

  export async function usage(): Promise<Usage> {
    const records = await list();
    const estimate = await files().estimate();
    const modelBytes = records.reduce((total, record) => total + record.size, 0);
    return {
      usage: estimate.usage,
      quota: estimate.quota,
      persisted: estimate.persisted,
      models: records.length,
      modelBytes,
    };
  }

  /** Refuses a download that cannot fit instead of failing after 3 GB. */
  export async function fits(bytes: number): Promise<boolean> {
    if (!(bytes > 0)) return false;
    const estimate = await files().estimate();
    if (!estimate.quota) return true;
    return estimate.quota - estimate.usage >= bytes;
  }

  export async function requestPersistence(): Promise<boolean> {
    return files().persist();
  }
}

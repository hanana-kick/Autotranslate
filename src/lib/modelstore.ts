// Where the model files live: gigabyte-sized files in OPFS, their metadata in
// IndexedDB. Runs in any extension context that can reach storage (options,
// popup, the host wherever it is placed); the two seams below are what the
// tests replace, so all the logic around download, validation and cleanup is
// covered without a browser.
// Load after lib/constants.js, lib/local.js.
namespace AT.modelstore {
  /** Swap-file suffix `createWritable()` writes through before the name appears. */
  const TMP_SUFFIX = '.tmp';
  /** Longer than any transfer this extension makes: below it a file is a download
   *  in progress, not debris. */
  const RECENT_WRITE_MS = 60 * 60 * 1000;

  const L = AT.local;
  const S = L.STORE;

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

  type Listing = { values(): AsyncIterable<FileSystemHandle> };

  /** Byte storage, replaced by the tests. */
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

  /** Use the platform contract: Response.body is a stream, not a reader. */
  export type StreamResponse = Pick<InstanceType<typeof globalThis.Response>, 'ok' | 'status' | 'headers' | 'body'>;

  export type StreamFetch = (
    url: string,
    init: RequestInit
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
        for (const store of [S.metaStore, S.blobStore]) {
          if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
        }
      };
      request.onsuccess = () => {
        database = request.result;
        resolve(database);
      };
      request.onerror = () => reject(request.error ?? new Error('cannot open the model database'));
    });
  }

  /** The real driver: one object store per purpose, keys are ids. */
  export function indexedDbDriver(): Driver {
    const withStore = (
      store: string,
      mode: IDBTransactionMode,
      body: (objectStore: IDBObjectStore) => IDBRequest<unknown>
    ): Promise<unknown> =>
      openDatabase().then((db) => new Promise((resolve, reject) => {
        const transaction = db.transaction(store, mode);
        const request = body(transaction.objectStore(store));
        let result: unknown;
        request.onsuccess = () => { result = request.result; };
        // Request success is not transaction commit. A later quota/abort error
        // must not activate a model whose metadata was never persisted.
        transaction.oncomplete = () => resolve(result);
        transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error('model store transaction failed'));
        request.onerror = () => reject(request.error ?? new Error('model store request failed'));
      }));
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

  /** The real byte store: one file per model under `models/`. */
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

  export async function list(): Promise<ModelRecord[]> {
    return L.normalizeModels(await driver().all(S.metaStore));
  }

  export async function get(id: string): Promise<ModelRecord | null> {
    return L.normalizeModel(await driver().get(S.metaStore, id));
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

  /** Records bytes that ship inside the extension. Nothing is written: the
   *  graph is already on disk beside the code, and `AT.onnxhost` reads it from
   *  the package instead of OPFS. Re-running replaces the earlier record under
   *  the same name, so an updated bundle does not accumulate stale ids. */
  export async function putBundled(request: {
    name: string;
    size: number;
    sourceUrl?: string;
  }): Promise<IngestResult> {
    const name = typeof request.name === 'string' ? request.name.trim().slice(0, 120) : '';
    const size = Number(request.size);
    if (!name) return { ok: false, record: null, error: 'no-name', bytes: 0 };
    if (!Number.isFinite(size) || size < L.MIN_MODEL_BYTES) {
      return { ok: false, record: null, error: 'too-small', bytes: 0 };
    }
    const sourceUrl = typeof request.sourceUrl === 'string' ? request.sourceUrl : '';
    const record = L.normalizeModel({
      id: L.makeModelId(name, `bundled|${sourceUrl}`, deps.now()),
      name,
      size,
      sourceUrl,
      createdAt: deps.now(),
      bundled: true
    });
    if (!record) return { ok: false, record: null, error: 'invalid-record', bytes: 0 };
    await putRecord(record);
    const retired = await replaceExisting(record).catch(() => [] as string[]);
    return { ok: true, record, error: null, bytes: record.size, retired };
  }

  /** Deletes metadata and bytes together; reports whether anything was there. */
  export async function remove(id: string): Promise<boolean> {
    const existing = await get(id);
    await files().remove(id);
    await driver().remove(S.metaStore, id);
    return existing !== null;
  }

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
    const stream = request.stream;
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
    // Staging never deletes a working copy. Activation and retirement happen
    // only after modelflow has verified inference and saved the new selection.
    try {
      await putRecord(record);
    } catch (error: unknown) {
      // Two gigabytes are already on disk: do not leave them behind without a
      // record, where nothing can list or delete them.
      await files().remove(id);
      return { ok: false, record: null, error: 'store-failed', bytes };
    }
    return { ok: true, record, error: null, bytes, retired: [] };
  }

  /** Called only after a verified model has become the persisted selection. */
  export async function retireReplaced(modelId: string, previousId: string): Promise<string[]> {
    const record = await get(modelId);
    if (!record) throw new Error('the verified model is no longer stored');
    const records = await list();
    const retired: string[] = [];
    for (const existing of records) {
      if (existing.id === previousId && existing.name === record.name && existing.id !== record.id && (await remove(existing.id))) {
        retired.push(existing.id);
      }
    }
    return retired;
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
        response = await doFetch(url, { headers: { Accept: 'application/octet-stream' }, signal: request.signal ?? null });
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
    const doFetch: StreamFetch | undefined = deps.fetchImpl ?? globalThis.fetch?.bind(globalThis);
    if (typeof doFetch !== 'function') return { ok: false, record: null, error: 'no-fetch', bytes: 0 };

    const headers: Record<string, string> = { Accept: 'application/octet-stream' };
    let response: StreamResponse;
    try {
      response = await doFetch(url, { headers, signal: request.signal ?? null });
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
      const reason = `http-${response.status}`;
      return { ok: false, record: null, error: reason, bytes: 0 };
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
    const stream = countingStream(
      response.body,
      (received) => {
        const now = deps.now();
        if (now - lastReport < L.DOWNLOAD_PROGRESS_INTERVAL_MS && !(total !== null && received >= total)) return;
        lastReport = now;
        request.onProgress?.(received, total);
      }
    );

    const fileName =
      (typeof request.name === 'string' && request.name.trim()) || fileNameFromUrl(url) || 'model.task';
    return ingest({ name: fileName, sourceUrl: url, stream, expectedBytes: total ?? undefined });
  }

  /** A file the user picked, as the stream the store writes. */
  function pickedStream(file: { name: string; size: number; stream?: (() => ReadableStream<Uint8Array>) | undefined }): ReadableStream<Uint8Array> {
    return typeof file.stream === 'function'
      ? file.stream()
      : new ReadableStream<Uint8Array>({
          async start(controller) {
            const blob = (file as unknown as Blob) as Blob;
            controller.enqueue(new Uint8Array(await blob.arrayBuffer()));
            controller.close();
          }
        });
  }

  /** The name a picked file is stored under: the model asks for it by its own
   *  trailing segment, so a directory prefix from the picker is dropped. */
  function pickedName(name: unknown): string {
    if (typeof name !== 'string') return '';
    return (name.split('/').filter(Boolean).pop() ?? '').trim().slice(0, 120);
  }

  /** The tokenizer and the file that carries the chat template are what turn a
   *  graph into a model that can be asked a question; without them the graph
   *  loads and answers nothing, and a 706 MB copy that cannot work is worse than
   *  being told which file is missing. */
  const REQUIRED_PARTS = ['tokenizer.json', 'tokenizer_config.json'];

  export type PickedFile = {
    name: string;
    size: number;
    stream?: (() => ReadableStream<Uint8Array>) | undefined;
  };

  /** Stores a model the user picked from disk: the graph, plus the tokenizer and
   *  config files that sit beside it in the same directory they downloaded. The
   *  shape is the one the download route writes, so the host cannot tell them
   *  apart — `read()` for the graph, `readPart()` for everything else.
   *
   *  The tokenizer and the file that carries its chat template are required
   *  before anything is written: without them the graph loads and answers
   *  nothing, and a 706 MB copy that cannot work is worse than being told which
   *  file is missing. */
  export async function importOnnx(
    request: { graph: PickedFile; parts?: PickedFile[]; onProgress?: (received: number, total: number | null) => void }
  ): Promise<IngestResult> {
    const graphName = pickedName(request.graph?.name);
    if (!graphName) return { ok: false, record: null, error: 'no-name', bytes: 0 };
    if (!/\.onnx$/i.test(graphName)) return { ok: false, record: null, error: 'not-onnx', bytes: 0 };
    const parts = (request.parts ?? [])
      .map((part) => ({ file: part, name: pickedName(part?.name) }))
      .filter((entry): entry is { file: PickedFile; name: string } => Boolean(entry.name) && !/\.onnx$/i.test(entry.name));
    const missing = REQUIRED_PARTS.filter((name) => !parts.some((entry) => entry.name === name));
    if (missing.length) {
      return { ok: false, record: null, error: `missing-${missing[0]!.replace(/\.json$/, '')}`, bytes: 0 };
    }
    let lastReport = 0;
    const total = Number(request.graph.size) > 0 ? Number(request.graph.size) : null;
    const stream = countingStream(pickedStream(request.graph), (received) => {
      const now = deps.now();
      if (now - lastReport < L.DOWNLOAD_PROGRESS_INTERVAL_MS && !(total !== null && received >= total)) return;
      lastReport = now;
      request.onProgress?.(received, total);
    });
    const result = await ingest({ name: graphName, sourceUrl: 'file://local', stream, expectedBytes: total ?? undefined });
    if (!result.ok || !result.record) return result;
    try {
      for (const entry of parts) {
        await files().writePart(result.record.id, entry.name, pickedStream(entry.file));
      }
    } catch (error: unknown) {
      await remove(result.record.id);
      const rejection = error as { message?: unknown };
      return { ok: false, record: null, error: String(rejection?.message ?? 'part-write-failed'), bytes: 0 };
    }
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
    // A bundled model occupies the package, not this origin's storage.
    const modelBytes = records.reduce((total, record) => total + (record.bundled ? 0 : record.size), 0);
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

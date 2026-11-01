// Where the model files live: gigabyte-sized files in OPFS, their metadata in
// IndexedDB. Runs in any extension context that can reach storage (options,
// popup, the host wherever it is placed); the two seams below are what the
// tests replace, so all the logic around download, validation and cleanup is
// covered without a browser.
// Load after lib/constants.js, lib/local.js.
namespace AT.modelstore {
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

  /** Byte storage, replaced by the tests. */
  export type Files = {
    /** Writes the whole stream; returns the number of bytes stored. */
    write(id: string, stream: ReadableStream<Uint8Array>): Promise<number>;
    read(id: string): Promise<Blob | null>;
    remove(id: string): Promise<void>;
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
    const child = async (name: string, create: boolean): Promise<FileSystemFileHandle | null> => {
      const root = await directory();
      const dir = await root.getDirectoryHandle(S.filesDir, create ? { create: true } : { create: false });
      if (!create) {
        try {
          return await dir.getFileHandle(name);
        } catch {
          return null;
        }
      }
      return dir.getFileHandle(name, { create: true });
    };
    return {
      async write(id, stream) {
        const handle = await child(id, true);
        if (!handle) throw new Error(`cannot create the file for model ${id}`);
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
          await writable.close();
        } catch (error: unknown) {
          await reader.cancel(error).catch(() => {});
          try {
            await writable.abort?.(error as Error);
          } catch {
            // An already-dead stream cannot be aborted; the throw below stands.
          }
          throw error;
        } finally {
          reader.releaseLock();
        }
        return written;
      },
      async read(id) {
        const handle = await child(id, false);
        if (!handle) return null;
        return handle.getFile();
      },
      async remove(id) {
        const root = await directory();
        try {
          const dir = await root.getDirectoryHandle(S.filesDir, { create: false });
          await dir.removeEntry(id);
        } catch {
          // Missing file or directory: nothing left to delete.
        }
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
    const raw = await driver().all(S.metaStore);
    return L.normalizeModels(raw);
  }

  export async function get(id: string): Promise<ModelRecord | null> {
    const record = L.normalizeModel(await driver().get(S.metaStore, id));
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
    let bytes = 0;
    try {
      bytes = await files().write(id, request.stream);
    } catch (error: unknown) {
      await files().remove(id);
      const rejection = error as { name?: string; message?: string };
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

  export type DownloadRequest = {
    url: string;
    name?: string | undefined;
    token?: string | undefined;
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
    const token = typeof request.token === 'string' ? request.token.trim() : '';
    // The token is the user's Hugging Face credential: it rides on requests to
    // that host only, never on whatever URL happens to be in the field.
    const host = new URL(url).hostname.toLowerCase();
    const trusted = host === 'huggingface.co' || host.endsWith('.huggingface.co');
    if (token && trusted) headers.Authorization = token.startsWith('Bearer ') ? token : `Bearer ${token}`;

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
      const reason = response.status === 401 || response.status === 403 ? 'needs-token' : `http-${response.status}`;
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

  /** Stores a file the user picked locally: the way to use a gated model. */
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
    const result = await ingest({ name, sourceUrl: 'file://local', stream, expectedBytes: total ?? undefined });
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

  // -------------------------------------------------------------------- token

  /** The Hugging Face token is stored apart from the settings blob so it never
   *  travels with a settings snapshot. */
  export async function getToken(): Promise<string> {
    const blob = await driver().get(S.blobStore, S.settingsKey);
    const value = blob as { hfToken?: unknown } | undefined;
    return typeof value?.hfToken === 'string' ? value.hfToken : '';
  }

  export async function setToken(token: string): Promise<void> {
    const value = typeof token === 'string' ? token.trim().slice(0, 512) : '';
    await driver().put(S.blobStore, S.settingsKey, { hfToken: value });
  }
}

// Installing a model, the one way both entry points use: the onboarding page
// and the Options page ask for a transfer, this module does it and prepares the
// model afterwards so a caller only has to draw progress.
// Load after lib/constants.js, lib/browser.js, lib/local.js, lib/modelstore.js.
namespace AT.modelflow {
  const C = AT.C;

  export type Progress = (received: number, total: number | null) => void;

  export type Install = {
    url?: string;
    signal?: AbortSignal;
    onProgress?: Progress;
  };

  export type Outcome = {
    /** The model is stored *and* loaded: this is what `ok` means. */
    ok: boolean;
    /** The bytes reached storage; loading them is a separate step. */
    stored: boolean;
    modelId: string;
    name: string;
    bytes: number;
    seconds: number;
    /** `cancelled`, `bad-url`, the store's own code, or a load failure. */
    error: string | null;
    /** Ids of earlier copies this transfer replaced. */
    retired: string[];
  };

  /** The card the extension offers by default: the best file that can actually be
   *  fetched. The user may still name another url or pick a file. */
  export const SOURCE = AT.local.defaultSource();

  /** Eviction would cost the user a re-download of the card's whole file, so ask
   *  for an exemption from the start. */
  export async function keepStorage(): Promise<void> {
    try {
      await AT.modelstore.requestPersistence();
    } catch (error: unknown) {
      AT.warn('asking for persistent storage failed', String((error as { message?: unknown })?.message ?? error));
    }
  }

  /**
   * The tail both routes share: report the transfer, then load the model once
   * so a finished install really is a working one.
   */
  async function settle(
    result: AT.modelstore.IngestResult,
    started: number
  ): Promise<Outcome> {
    const name = result.record?.name ?? '';
    const bytes = result.bytes;
    const seconds = Math.max(1, Math.round((Date.now() - started) / 1000));
    if (!result.ok || !result.record) {
      return { ok: false, stored: false, modelId: '', name, bytes, seconds, error: result.error ?? 'unknown', retired: [] };
    }
    const prepared = await prepare(result.record.id);
    return {
      ok: prepared.ok,
      stored: true,
      modelId: result.record.id,
      name: result.record.name,
      bytes,
      seconds,
      error: prepared.ok ? null : (prepared.error ?? 'model-load-failed'),
      retired: result.retired ?? []
    };
  }

  /** Asks the host to load a model; only a successful load means it can translate. */
  export async function prepare(modelId: string): Promise<{ ok: boolean; error: string | null }> {
    const reply = await AT.sendMessage({ type: C.MSG.LOCAL_PREPARE, modelId });
    if (reply?.ok) return { ok: true, error: null };
    return { ok: false, error: String(reply?.error ?? 'the model did not load') };
  }

  export async function installFromUrl(install: Install = {}): Promise<Outcome> {
    const started = Date.now();
    const url = AT.local.normalizeDownloadUrl(install.url ?? SOURCE.url);
    if (!url) return { ok: false, stored: false, modelId: '', name: '', bytes: 0, seconds: 1, error: 'bad-url', retired: [] };
    const card = AT.local.sourceFor(url) ?? (url === SOURCE.url ? SOURCE : null);
    const expected = card?.size;
    if (expected && !(await AT.modelstore.fits(expected))) {
      return { ok: false, stored: false, modelId: '', name: '', bytes: 0, seconds: 1, error: 'no-space', retired: [] };
    }
    await keepStorage();
    // An ONNX card is a set of files, not one graph: fetch the parts beside it.
    const result =
      card?.kind === 'onnx'
        ? await AT.modelstore.ingestOnnx({
            graphUrl: url,
            name: card.dtype === 'fp16' ? 'model_fp16.onnx' : undefined,
            expectedSize: expected,
            signal: install.signal,
            onProgress: install.onProgress,
            parts: card.parts ?? []
          })
        : await AT.modelstore.download({
            url,
            expectedSize: expected,
            signal: install.signal,
            onProgress: install.onProgress
          });
    return settle(result, started);
  }

  export async function installFromFile(file: File): Promise<Outcome> {
    const started = Date.now();
    await keepStorage();
    const result = await AT.modelstore.importFile(file);
    return settle(result, started);
  }

  /** The model the user already has, if any; the newest one wins. */
  export async function installed(): Promise<AT.local.ModelRecord | null> {
    const models = await AT.modelstore.list();
    return models[0] ?? null;
  }
}

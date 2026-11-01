// Installing a model, the one way both entry points use: the onboarding page
// and the Options page ask for a transfer, this module does it and prepares the
// model afterwards so a caller only has to draw progress.
// Load after lib/constants.js, lib/browser.js, lib/local.js, lib/modelstore.js.
namespace AT.modelflow {
  const C = AT.C;

  export type Progress = (received: number, total: number | null) => void;

  export type Install = {
    url?: string;
    token?: string;
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
    /** `cancelled`, `needs-token`, `bad-url`, the store's own code, or a load failure. */
    error: string | null;
    /** Ids of earlier copies this transfer replaced. */
    retired: string[];
  };

  /** The source the extension offers by default; the user may still pick a file. */
  export const SOURCE = AT.local.MODEL_SOURCES[0]!;

  /** Eviction would cost the user a 3.6 GiB download, so ask for an exemption. */
  export async function keepStorage(): Promise<void> {
    // Firefox can leave this promise pending while a browser-owned permission
    // panel awaits input. Persistence is optional: download quota is checked
    // independently. Never make accepting an eviction exemption a prerequisite
    // for downloading/importing the user's model. No permission is auto-granted.
    void AT.modelstore.requestPersistence().catch((error: unknown) => {
      AT.warn('asking for persistent storage failed', String((error as { message?: unknown })?.message ?? error));
    });
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
    const record = result.record;
    const activate = async (): Promise<Outcome> => {
      const previous = await AT.settings.load();
      const prepared = await prepare(record.id);
      const outcome: Outcome = {
        ok: prepared.ok, stored: true, modelId: record.id, name: record.name,
        bytes, seconds, error: prepared.ok ? null : (prepared.error ?? 'model-load-failed'), retired: []
      };
      if (!prepared.ok) return outcome;
      try {
        // Persist the selection before deleting anything. On a storage failure
        // both files remain recoverable; a failed model never replaces the old one.
        await AT.settings.save({ localModelId: record.id });
      } catch (error: unknown) {
        return { ...outcome, ok: false, error: String((error as Error)?.message ?? error) };
      }
      try {
        outcome.retired = await AT.modelstore.retireReplaced(record.id, previous.localModelId);
      } catch (error: unknown) {
        // Cleanup may be retried later; the new, verified selection still works.
        AT.warn('retiring the replaced model failed', error);
      }
      return outcome;
    };
    // Options and onboarding can be open together. Serialize activation across
    // extension documents, not just within one UI's single-flight button.
    const locks = globalThis.navigator?.locks;
    return locks ? locks.request('autotranslate-model-activation', activate) : activate();
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
    const expected = AT.local.MODEL_SOURCES.find((source) => source.url === url)?.size;
    if (expected && !(await AT.modelstore.fits(expected))) {
      return { ok: false, stored: false, modelId: '', name: '', bytes: 0, seconds: 1, error: 'no-space', retired: [] };
    }
    await keepStorage();
    const result = await AT.modelstore.download({
      url,
      token: install.token ?? '',
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

  /** Prefer the active selection over a newer, potentially failed staged file. */
  export async function installed(): Promise<AT.local.ModelRecord | null> {
    const models = await AT.modelstore.list();
    const settings = await AT.settings.load();
    return models.find((model) => model.id === settings.localModelId) ?? models[0] ?? null;
  }
}

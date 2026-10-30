// First run: pick the target language, install the model once, then turn
// translation on. The extension is disabled until this page finishes, so a
// fresh install never sits there translating with no model.
// Compiled as a classic script next to welcome.html; loads after
// lib/constants.js, lib/browser.js, lib/local.js, lib/modelstore.js,
// lib/modelflow.js and lib/settings.js.
namespace AT.welcome {
  const C = AT.C;

  type Fields = {
    targetLang: HTMLSelectElement;
    support: HTMLParagraphElement;
    installed: HTMLParagraphElement;
    download: HTMLButtonElement;
    cancel: HTMLButtonElement;
    pick: HTMLButtonElement;
    modelFile: HTMLInputElement;
    modelToken: HTMLInputElement;
    progress: HTMLProgressElement;
    status: HTMLParagraphElement;
    start: HTMLButtonElement;
    options: HTMLButtonElement;
  };

  function el<K extends keyof Fields>(id: K): Fields[K] {
    return document.getElementById(id) as Fields[K];
  }

  function setStatus(text: string, kind: string): void {
    el('status').textContent = text;
    el('status').dataset.kind = kind;
  }

  const reason = (error: unknown): string => String((error as { message?: unknown })?.message ?? error);

  let settings: AT.settings.Settings | null = null;
  /** The model this page is about: stored and loaded, so `start` may finish. */
  let readyModel: AT.local.ModelRecord | null = null;
  let inflight: AbortController | null = null;

  function setBusy(busy: boolean): void {
    el('download').disabled = busy || el('download').dataset.blocked === 'true';
    el('pick').disabled = busy;
    el('cancel').hidden = !busy;
    el('start').disabled = busy || readyModel === null;
  }

  function showProgress(received: number, total: number | null): void {
    const bar = el('progress');
    bar.hidden = false;
    bar.max = total && total > 0 ? total : 100;
    bar.value = received;
    setStatus(
      AT.i18n.msg('options_downloading', [AT.local.formatBytes(received), total ? AT.local.formatBytes(total) : '?']),
      'info'
    );
  }

  /** Paint the model state: what is installed, and whether start may finish. */
  function renderInstalled(): void {
    const node = el('installed');
    if (!readyModel) {
      node.hidden = true;
      node.textContent = '';
    } else {
      node.hidden = false;
      node.textContent = AT.i18n.msg('welcome_modelReady', [
        readyModel.name,
        AT.local.formatBytes(readyModel.size)
      ]);
    }
    el('start').disabled = inflight !== null || readyModel === null;
    el('start').dataset.blocked = readyModel === null ? 'true' : 'false';
  }

  async function showSupport(): Promise<void> {
    const reply = await AT.sendMessage({ type: C.MSG.LOCAL_GET_STATUS });
    const supported = reply?.supported === true;
    const node = el('support');
    if (supported) {
      node.hidden = true;
      node.textContent = '';
      return;
    }
    node.hidden = false;
    node.textContent = AT.i18n.msg('options_localUnsupported');
    el('download').dataset.blocked = 'true';
    el('download').disabled = true;
  }

  /** Report the outcome of a transfer and, when it worked, arm the start button. */
  async function settle(outcome: AT.modelflow.Outcome, source: 'download' | 'file' = 'download'): Promise<void> {
    el('progress').hidden = true;
    inflight = null;
    setBusy(false);
    if (!outcome.ok) {
      const text =
        outcome.error === 'cancelled'
          ? AT.i18n.msg('options_cancelled')
          : outcome.error === 'needs-token'
            ? AT.i18n.msg('options_needsToken')
            : outcome.error === 'no-space'
              ? AT.i18n.msg('options_noSpace', AT.local.formatBytes(AT.modelflow.SOURCE.size))
              : source === 'file'
                ? AT.i18n.msg('welcome_importFailed', outcome.error ?? 'unknown')
                : `${AT.i18n.msg('options_downloadFailed')}: ${outcome.error ?? 'unknown'}`;
      readyModel = null;
      renderInstalled();
      setStatus(text, 'error');
      return;
    }
    readyModel = await AT.modelstore.get(outcome.modelId);
    renderInstalled();
    setStatus(
      AT.i18n.msg('options_downloadDone', [
        outcome.name,
        AT.local.formatBytes(outcome.bytes),
        String(outcome.seconds)
      ]),
      'ok'
    );
  }

  async function download(): Promise<void> {
    const controller = new AbortController();
    inflight = controller;
    setBusy(true);
    setStatus(AT.i18n.msg('welcome_starting'), 'info');
    const token = el('modelToken').value.trim();
    await AT.modelstore.setToken(token).catch((error: unknown) => AT.warn('storing the token failed', reason(error)));
    try {
      await settle(
        await AT.modelflow.installFromUrl({
          token,
          signal: controller.signal,
          onProgress: showProgress
        })
      );
    } catch (error: unknown) {
      inflight = null;
      setBusy(false);
      el('progress').hidden = true;
      setStatus(`${AT.i18n.msg('options_downloadFailed')}: ${reason(error)}`, 'error');
    }
  }

  async function pickFile(): Promise<void> {
    const file = el('modelFile').files?.[0];
    if (!file) return;
    inflight = new AbortController();
    setBusy(true);
    el('progress').max = file.size > 0 ? file.size : 100;
    showProgress(0, file.size > 0 ? file.size : null);
    try {
      await settle(await AT.modelflow.installFromFile(file), 'file');
    } catch (error: unknown) {
      inflight = null;
      setBusy(false);
      setStatus(`${AT.i18n.msg('options_downloadFailed')}: ${reason(error)}`, 'error');
    } finally {
      el('modelFile').value = '';
    }
  }

  /** Done: the extension is on, points at the model, and has a target language. */
  async function start(): Promise<void> {
    if (!readyModel) return;
    el('start').disabled = true;
    settings = await AT.settings.save({
      enabled: true,
      localModelId: readyModel.id,
      targetLang: el('targetLang').value
    });
    document.body.dataset.done = 'true';
    setStatus(AT.i18n.msg('welcome_done'), 'ok');
    el('start').hidden = true;
    el('download').disabled = true;
    el('pick').disabled = true;
    // The tab cannot always be closed (it may be pinned); a link to the options
    // page stays reachable either way.
    try {
      window.close();
    } catch {
      /* nothing to do */
    }
  }

  function wire(): void {
    el('download').addEventListener('click', () => void download());
    el('cancel').addEventListener('click', () => inflight?.abort());
    el('pick').addEventListener('click', () => el('modelFile').click());
    el('modelFile').addEventListener('change', () => void pickFile());
    el('start').addEventListener('click', () => void start());
    el('options').addEventListener('click', () => {
      void AT.api?.runtime.openOptionsPage();
    });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    AT.i18n.apply(document);
    settings = await AT.settings.load();
    el('targetLang').replaceChildren(
      ...C.LANGS.map((lang) => {
        const node = document.createElement('option');
        node.value = lang.code;
        node.textContent = `${lang.native} (${lang.code})`;
        return node;
      })
    );
    el('targetLang').value = settings.targetLang;
    el('modelToken').value = await AT.modelstore.getToken().catch(() => '');
    wire();
    await showSupport();
    // A profile that already has the file (a reinstall, a second browser) skips
    // the transfer and only has to confirm.
    const existing = await AT.modelflow.installed();
    if (existing) {
      const prepared = await AT.modelflow.prepare(existing.id);
      if (prepared.ok) {
        readyModel = existing;
        renderInstalled();
        setStatus(AT.i18n.msg('welcome_readyExisting'), 'ok');
      } else {
        setStatus(`${AT.i18n.msg('options_prepareFailed')}: ${prepared.error ?? ''}`, 'error');
      }
    } else {
      setStatus(AT.i18n.msg('welcome_needModel'), 'info');
    }
  });
}

// First run: choose an on-device model or configure a compatible server.
// Setup never opts a tab in: translation still requires explicit per-tab ON.
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
    progress: HTMLProgressElement;
    status: HTMLParagraphElement;
    start: HTMLButtonElement;
    options: HTMLButtonElement;
    serverOptions: HTMLButtonElement;
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
          : outcome.error === 'no-space'
            ? AT.i18n.msg('options_noSpace', AT.local.formatBytes(AT.modelflow.SOURCE.size))
            : outcome.stored
              // The file is in storage; only loading it failed. Saying the
              // import failed would send the user to repeat a 706 MB copy.
              ? AT.i18n.msg('welcome_modelStored', outcome.error ?? 'model-load-failed')
              : source === 'file'
                ? AT.i18n.msg('welcome_importFailed', outcome.error ?? 'unknown')
                : `${AT.i18n.msg('options_downloadFailed')}: ${outcome.error ?? 'unknown'}`;
      readyModel = null;
      renderInstalled();
      setStatus(text, 'error');
      return;
    }
    readyModel = await AT.modelstore.get(outcome.modelId);
    // Starting has to write a selection that exists: a replaced copy would leave
    // `localModelId` pointing at a file the store already deleted.
    if (readyModel && (!settings?.localModelId || outcome.retired.includes(settings.localModelId))) {
      settings = await AT.settings.save({ localModelId: readyModel.id });
    }
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
    try {
      await settle(
        await AT.modelflow.installFromUrl({
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

  /** Finish provider setup without selecting a tab for translation. */
  async function start(): Promise<void> {
    const remote = settings?.engine === 'openai' && AT.settings.serverConfigured(settings);
    if (!readyModel && !remote) return;
    el('start').disabled = true;
    settings = await AT.settings.save({
      enabled: false,
      localModelId: readyModel?.id ?? settings!.localModelId,
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
    el('serverOptions').addEventListener('click', () => {
      void AT.settings.save({ engine: 'openai' }).then(() => AT.ui.openPage('options.html', 'auto', AT.ui.targetTabId()));
    });
    el('download').addEventListener('click', () => void download());
    el('cancel').addEventListener('click', () => inflight?.abort());
    el('pick').addEventListener('click', () => el('modelFile').click());
    el('modelFile').addEventListener('change', () => void pickFile());
    el('start').addEventListener('click', () => void start());
    el('options').addEventListener('click', () => {
      void AT.ui.openPage('options.html', 'auto', AT.ui.targetTabId());
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
    wire();
    if (settings.engine === 'openai') {
      el('start').disabled = !AT.settings.serverConfigured(settings);
      setStatus(AT.i18n.msg('server_needConfig'), 'info');
      return;
    }
    await showSupport();
    // A profile that already has the file (a reinstall, a second browser) skips
    // the transfer and only has to confirm.
    let existing = await AT.modelflow.installed();
    if (!existing && (await AT.modelflow.bundled())) {
      // The package carries the weights: nothing to download, only to register.
      const bundled = await AT.modelflow.installBundled();
      if (bundled.ok) existing = await AT.modelflow.installed();
      else AT.warn('the bundled model did not load', bundled.error);
    }
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

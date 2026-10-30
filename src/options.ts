// Options page controller. Reads and writes storage directly; the background
// context picks the change up through storage.onChanged.
// Compiled as a classic script next to options.html; loads after
// lib/constants.js, lib/browser.js, lib/rules.js and lib/settings.js.
namespace AT.options {
  const C = AT.C;

  // The ids are the ones in options.html; the table types every lookup once so
  // the call sites stay as short as the untyped version was.
  type Fields = {
    enabled: HTMLInputElement;
    autoDetect: HTMLInputElement;
    showBadge: HTMLInputElement;
    debug: HTMLInputElement;
    testEngine: HTMLButtonElement;
    testStatus: HTMLParagraphElement;
    targetLang: HTMLSelectElement;
    sourceLang: HTMLSelectElement;
    localModel: HTMLSelectElement;
    localMaxTokens: HTMLInputElement;
    localSupport: HTMLParagraphElement;
    localUsage: HTMLParagraphElement;
    modelList: HTMLUListElement;
    modelUrl: HTMLInputElement;
    modelToken: HTMLInputElement;
    downloadModel: HTMLButtonElement;
    cancelDownload: HTMLButtonElement;
    modelFile: HTMLInputElement;
    pickModel: HTMLButtonElement;
    prepareModel: HTMLButtonElement;
    modelProgress: HTMLProgressElement;
    modelStatus: HTMLParagraphElement;
    maxNodes: HTMLInputElement;
    rulePattern: HTMLInputElement;
    ruleAction: HTMLSelectElement;
    addRule: HTMLButtonElement;
    ruleList: HTMLUListElement;
    save: HTMLButtonElement;
    reset: HTMLButtonElement;
    saveStatus: HTMLParagraphElement;
  };

  function el<K extends keyof Fields>(id: K): Fields[K] {
    return document.getElementById(id) as Fields[K];
  }

  // What the form holds: `version` comes from settings.save, and the limit
  // fields are still the input strings normalize() later coerces.
  type FormValues = Omit<AT.settings.Settings, 'version' | 'maxNodes' | 'localMaxTokens'> & {
    maxNodes: string;
    localMaxTokens: string;
  };

  /** The TEST_ENGINE reply: `result` is there exactly when `ok` is. */
  type TestReply = AT.Response & {
    error?: string;
    code?: string | null;
    result: AT.engines.TestResult;
  };

  // Set by the DOMContentLoaded handler before any listener is wired, so every
  // read below happens after the first load resolved.
  let settings: AT.settings.Settings | null = null;

  function option(value: string, label: string): HTMLOptionElement {
    const node = document.createElement('option');
    node.value = value;
    node.textContent = label;
    return node;
  }

  function setStatus(node: HTMLElement, text: string, kind?: string): void {
    node.textContent = text ?? '';
    node.dataset.kind = kind ?? 'info';
  }

  function buildSelects(): void {
    el('targetLang').replaceChildren(
      ...C.LANGS.map((lang) => option(lang.code, `${lang.native} (${lang.code})`))
    );
    el('sourceLang').replaceChildren(
      option('auto', AT.i18n.msg('options_sourceAuto')),
      ...C.LANGS.map((lang) => option(lang.code, `${lang.native} (${lang.code})`))
    );
  }

  function renderRules(): void {
    const list = el('ruleList');
    if (settings!.siteRules.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = AT.i18n.msg('options_noRules');
      list.replaceChildren(empty);
      return;
    }
    list.replaceChildren(
      ...settings!.siteRules.map((rule) => {
        const item = document.createElement('li');
        item.className = 'rule';
        const code = document.createElement('code');
        code.textContent = rule.pattern;
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.dataset.action = rule.action;
        tag.textContent = AT.i18n.msg(rule.action === 'never' ? 'options_ruleNever' : 'options_ruleAlways');
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'ghost danger';
        remove.textContent = AT.i18n.msg('options_remove');
        remove.addEventListener('click', () => writeRules(rule.pattern, null));
        item.append(code, tag, remove);
        return item;
      })
    );
  }

  function render(): void {
    el('enabled').checked = settings!.enabled;
    el('autoDetect').checked = settings!.autoDetect;
    el('showBadge').checked = settings!.showBadge;
    el('debug').checked = settings!.debug;
    el('targetLang').value = settings!.targetLang;
    el('sourceLang').value = settings!.sourceLang;
    el('maxNodes').value = String(settings!.maxNodes);
    el('localModel').value = models.some((model) => model.id === settings!.localModelId)
      ? settings!.localModelId
      : '';
    el('localMaxTokens').value = String(settings!.localMaxTokens);
    renderRules();
  }

  function collect(): FormValues {
    return {
      enabled: el('enabled').checked,
      autoDetect: el('autoDetect').checked,
      showBadge: el('showBadge').checked,
      debug: el('debug').checked,
      targetLang: el('targetLang').value,
      sourceLang: el('sourceLang').value,
      maxNodes: el('maxNodes').value,
      siteRules: settings!.siteRules,
      localModelId: el('localModel').value,
      localMaxTokens: el('localMaxTokens').value
    };
  }

  async function persist(nextSettings: FormValues): Promise<AT.settings.Settings> {
    // The two limit fields are the raw input strings. Number() is exactly the
    // coercion settings.normalize's clampInt() already applies to a string, so
    // the stored value is unchanged and save() sees the numbers it promises.
    const patch: Partial<AT.settings.Settings> = {
      ...nextSettings,
      maxNodes: Number(nextSettings.maxNodes),
      localMaxTokens: Number(nextSettings.localMaxTokens)
    };
    settings = await AT.settings.save(patch);
    render();
    setStatus(el('saveStatus'), AT.i18n.msg('options_saved'), 'ok');
    return settings;
  }

  async function writeRules(pattern: string, action: AT.SiteRuleAction | null): Promise<void> {
    const canonical = AT.rules.canonical(pattern);
    if (!canonical) {
      setStatus(el('saveStatus'), AT.i18n.msg('options_badRule'), 'error');
      return;
    }
    const kept = settings!.siteRules.filter((rule) => rule.pattern !== canonical);
    await persist({ ...collect(), siteRules: action ? [...kept, { pattern: canonical, action }] : kept });
  }

  // ------------------------------------------------------- on-device models

  /** The transfer in flight, so the cancel button has something to abort. */
  let inflight: AbortController | null = null;
  let models: AT.local.ModelRecord[] = [];

  const reason = (error: unknown): string => String((error as { message?: unknown })?.message ?? error);

  async function refreshLocalStatus(): Promise<void> {
    const reply = await AT.sendMessage({ type: C.MSG.LOCAL_GET_STATUS });
    const status = reply?.ok ? AT.local.normalizeStatus(reply.status) : null;
    el('localSupport').textContent = AT.local.describeStatus(status, reply?.supported === true, (key, subs) =>
      AT.i18n.msg(key, subs)
    );
  }

  function renderModels(): void {
    el('localModel').replaceChildren(
      option('', AT.i18n.msg('options_localNone')),
      ...models.map((model) => option(model.id, `${model.name} (${AT.local.formatBytes(model.size)})`))
    );
    // Replacing the options drops the selection, so it is restored here rather
    // than left to whichever caller happens to call render() afterwards.
    el('localModel').value = models.some((model) => model.id === settings!.localModelId)
      ? settings!.localModelId
      : '';
    const list = el('modelList');
    if (models.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = AT.i18n.msg('options_noModels');
      list.replaceChildren(empty);
      return;
    }
    list.replaceChildren(
      ...models.map((model) => {
        const selected = model.id === settings!.localModelId;
        const item = document.createElement('li');
        item.className = 'rule';
        const name = document.createElement('code');
        name.textContent = model.name;
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.dataset.action = selected ? 'always' : 'never';
        tag.textContent = `${selected ? '● ' : ''}${AT.local.formatBytes(model.size)}`;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'ghost danger';
        remove.textContent = AT.i18n.msg('options_remove');
        remove.addEventListener('click', () => {
          void forget(model);
        });
        item.append(name, tag, remove);
        return item;
      })
    );
  }

  async function refreshModels(): Promise<void> {
    try {
      models = await AT.modelstore.list();
      const usage = await AT.modelstore.usage();
      const said = AT.i18n.msg('options_usage', [
        AT.local.formatBytes(usage.usage),
        AT.local.formatBytes(usage.quota),
        String(usage.models),
        AT.local.formatBytes(usage.modelBytes)
      ]);
      // A model the browser may evict under disk pressure is not a model the
      // user can rely on offline, so say so rather than let it vanish silently.
      el('localUsage').textContent = usage.persisted
        ? said
        : `${said} · ${AT.i18n.msg('options_notPersisted')}`;
    } catch (error: unknown) {
      models = [];
      el('localUsage').textContent = reason(error);
    }
    renderModels();
  }

  /** Deletes a model, and the resident copy of it if it was the chosen one. */
  async function forget(model: AT.local.ModelRecord): Promise<void> {
    try {
      const wasSelected = settings!.localModelId === model.id;
      const removed = await AT.modelstore.remove(model.id);
      if (wasSelected) {
        settings = await AT.settings.save({ ...settings!, localModelId: '' });
        await AT.sendMessage({ type: C.MSG.LOCAL_RELEASE });
      }
      setStatus(
        el('modelStatus'),
        removed ? AT.i18n.msg('options_deleted', model.name) : AT.i18n.msg('options_alreadyGone', model.name),
        'ok'
      );
    } catch (error: unknown) {
      setStatus(el('modelStatus'), `${AT.i18n.msg('options_deleteFailed')}: ${reason(error)}`, 'error');
    }
    await refreshModels();
    render();
  }

  function showProgress(received: number, total: number | null): void {
    const bar = el('modelProgress');
    bar.hidden = false;
    bar.max = total && total > 0 ? total : 100;
    bar.value = received;
    setStatus(
      el('modelStatus'),
      AT.i18n.msg('options_downloading', [AT.local.formatBytes(received), total ? AT.local.formatBytes(total) : '?']),
      'info'
    );
  }

  function setBusy(busy: boolean): void {
    el('downloadModel').disabled = busy;
    el('pickModel').disabled = busy;
    el('prepareModel').disabled = busy;
    el('cancelDownload').hidden = !busy;
  }

  /** Eviction would cost the user a 3.6 GiB download, so ask for an exemption. */
  async function keepStorage(): Promise<void> {
    try {
      await AT.modelstore.requestPersistence();
    } catch (error: unknown) {
      AT.warn('asking for persistent storage failed', reason(error));
    }
  }

  /** Shared tail of the two ways a model arrives: report and re-list. */
  async function afterIngest(result: AT.modelstore.IngestResult, started: number): Promise<void> {
    el('modelProgress').hidden = true;
    setBusy(false);
    if (!result.ok || !result.record) {
      const detail = result.error === 'needs-token' ? '' : `: ${result.error ?? 'unknown'}`;
      setStatus(
        el('modelStatus'),
        result.error === 'cancelled'
          ? AT.i18n.msg('options_cancelled')
          : result.error === 'needs-token'
            ? AT.i18n.msg('options_needsToken')
            : AT.i18n.msg('options_downloadFailed') + detail,
        'error'
      );
      await refreshModels();
      return;
    }
    if (!settings!.localModelId) {
      settings = await AT.settings.save({ ...settings!, localModelId: result.record.id });
    }
    setStatus(
      el('modelStatus'),
      AT.i18n.msg('options_downloadDone', [
        result.record.name,
        AT.local.formatBytes(result.bytes),
        String(Math.max(1, Math.round((Date.now() - started) / 1000)))
      ]),
      'ok'
    );
    await refreshModels();
    render();
  }

  async function startDownload(): Promise<void> {
    const url = AT.local.normalizeDownloadUrl(el('modelUrl').value);
    if (!url) {
      setStatus(el('modelStatus'), AT.i18n.msg('options_badUrl'), 'error');
      return;
    }
    const token = el('modelToken').value.trim();
    const expected = AT.local.MODEL_SOURCES.find((source) => source.url === url)?.size;
    try {
      await AT.modelstore.setToken(token);
      if (expected && !(await AT.modelstore.fits(expected))) {
        setStatus(el('modelStatus'), AT.i18n.msg('options_noSpace', AT.local.formatBytes(expected)), 'error');
        return;
      }
    } catch (error: unknown) {
      setStatus(el('modelStatus'), reason(error), 'error');
      return;
    }
    const controller = new AbortController();
    inflight = controller;
    setBusy(true);
    await keepStorage();
    showProgress(0, expected ?? null);
    const started = Date.now();
    const result = await AT.modelstore.download({
      url,
      token,
      expectedSize: expected,
      signal: controller.signal,
      onProgress: (received, total) => showProgress(received, total)
    });
    if (inflight === controller) inflight = null;
    await afterIngest(result, started);
  }

  async function importPickedFile(): Promise<void> {
    const file = el('modelFile').files?.[0];
    if (!file) return;
    setBusy(true);
    await keepStorage();
    showProgress(0, file.size > 0 ? file.size : null);
    const started = Date.now();
    const result = await AT.modelstore.importFile(file, {
      onProgress: (received, total) => showProgress(received, total)
    });
    el('modelFile').value = '';
    await afterIngest(result, started);
  }

  async function prepareLocal(): Promise<void> {
    const modelId = el('localModel').value || settings!.localModelId;
    if (!modelId) {
      setStatus(el('modelStatus'), AT.i18n.msg('options_pickOne'), 'error');
      return;
    }
    setStatus(el('modelStatus'), AT.i18n.msg('options_preparing'), 'info');
    const reply = await AT.sendMessage({ type: C.MSG.LOCAL_PREPARE, modelId });
    if (!reply?.ok) {
      setStatus(el('modelStatus'), String(reply?.error ?? AT.i18n.msg('options_prepareFailed')), 'error');
      return;
    }
    await refreshLocalStatus();
    setStatus(el('modelStatus'), AT.i18n.msg('options_prepared'), 'ok');
  }

  function wire(): void {
    el('save').addEventListener('click', () => persist(collect()));

    el('reset').addEventListener('click', async () => {
      settings = await AT.settings.reset();
      render();
      setStatus(el('saveStatus'), AT.i18n.msg('options_resetDone'), 'ok');
    });

    el('addRule').addEventListener('click', async () => {
      // The select only ever offers the two actions markup declares.
      await writeRules(el('rulePattern').value, el('ruleAction').value as AT.SiteRuleAction);
      el('rulePattern').value = '';
    });

    el('rulePattern').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') el('addRule').click();
    });

    el('testEngine').addEventListener('click', async () => {
      setStatus(el('testStatus'), AT.i18n.msg('options_testing'), 'info');
      const response = (await AT.sendMessage({
        type: C.MSG.TEST_ENGINE,
        target: el('targetLang').value
      })) as TestReply;
      if (!response?.ok) {
        setStatus(el('testStatus'), `${response?.code ? `[${response.code}] ` : ''}${response?.error}`, 'error');
        return;
      }
      setStatus(
        el('testStatus'),
        // Both placeholders of "$1$ ($2$ ms)" need a value: msg() takes a single
        // substitutions argument, so a third positional argument is dropped.
        AT.i18n.msg('options_testOk', [response.result.output ?? '', String(response.result.ms)]),
        'ok'
      );
    });

    el('downloadModel').addEventListener('click', () => {
      void startDownload();
    });
    el('cancelDownload').addEventListener('click', () => inflight?.abort());
    el('pickModel').addEventListener('click', () => el('modelFile').click());
    el('modelFile').addEventListener('change', () => {
      void importPickedFile();
    });
    el('prepareModel').addEventListener('click', () => {
      void prepareLocal();
    });
    el('modelToken').addEventListener('change', () => {
      void AT.modelstore.setToken(el('modelToken').value.trim());
    });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    AT.i18n.apply(document);
    buildSelects();
    settings = await AT.settings.load();
    el('modelUrl').value = AT.local.MODEL_SOURCES[0]?.url ?? '';
    el('modelToken').value = await AT.modelstore.getToken().catch(() => '');
    wire();
    // Ask first, then report: the usage line is only meaningful once the
    // browser has answered whether it will keep the bytes.
    await keepStorage();
    // The model list decides what the model select can show, so the form is
    // painted once the store has answered rather than from settings alone.
    await Promise.all([refreshModels(), refreshLocalStatus()]);
    render();
  });
}

// Options page controller. Reads and writes storage directly; the background
// context picks the change up through storage.onChanged.
// Compiled as a classic script next to options.html; loads after
// lib/constants.js, lib/browser.js, lib/rules.js and lib/settings.js.
namespace AT.options {
  const C = AT.C;

  // The ids are the ones in options.html; the table types every lookup once so
  // the call sites stay as short as the untyped version was.
  type Fields = {
    targetLang: HTMLSelectElement;
    alwaysTranslateLanguages: HTMLDivElement;
    parallelTranslation: HTMLSelectElement;
    translationRendering: HTMLSelectElement;
    localModel: HTMLSelectElement;
    modelList: HTMLUListElement;
    downloadModel: HTMLButtonElement;
    cancelDownload: HTMLButtonElement;
    modelFile: HTMLInputElement;
    pickModel: HTMLButtonElement;
    prepareModel: HTMLButtonElement;
    modelProgress: HTMLProgressElement;
    modelStatus: HTMLParagraphElement;
    rulePattern: HTMLInputElement;
    addRule: HTMLButtonElement;
    ruleList: HTMLUListElement;
    save: HTMLButtonElement;
    saveStatus: HTMLParagraphElement;
  };

  function el<K extends keyof Fields>(id: K): Fields[K] {
    return document.getElementById(id) as Fields[K];
  }

  type FormValues = Pick<AT.settings.Settings,
    'enabled' | 'targetLang' | 'sourceLang' | 'alwaysTranslateLanguages' | 'siteRules' | 'localModelId' | 'translationConcurrency' | 'translationRendering'>;

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
    el('parallelTranslation').replaceChildren(
      ...[1, 2, 4, 8].map(width => option(String(width), AT.i18n.msg(`options_parallelTranslation${width}`)))
    );
    el('translationRendering').replaceChildren(
      option('aurora', AT.i18n.msg('options_translationRenderingAurora')),
      option('immediate', AT.i18n.msg('options_translationRenderingImmediate'))
    );
    el('alwaysTranslateLanguages').replaceChildren(
      ...C.LANGS.map((lang) => {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.value = lang.code;
        const text = document.createElement('span');
        text.textContent = `${lang.native} (${lang.code})`;
        label.append(input, text);
        return label;
      })
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
        tag.textContent = rule.action === 'never' ? AT.i18n.msg('options_ruleNever') : AT.i18n.msg('options_ruleAlways');
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
    el('targetLang').value = settings!.targetLang;
    el('parallelTranslation').value = String(settings!.translationConcurrency);
    el('translationRendering').value = settings!.translationRendering;
    for (const input of el('alwaysTranslateLanguages').querySelectorAll<HTMLInputElement>('input')) {
      input.checked = settings!.alwaysTranslateLanguages.includes(input.value);
    }
    el('localModel').value = models.some((model) => model.id === settings!.localModelId)
      ? settings!.localModelId
      : '';
    renderRules();
  }

  function collect(): FormValues {
    const concurrency = Number(el('parallelTranslation').value);
    return {
      enabled: true,
      targetLang: el('targetLang').value,
      sourceLang: 'auto',
      translationConcurrency: AT.settings.isTranslationConcurrency(concurrency) ? concurrency : settings!.translationConcurrency,
      translationRendering: el('translationRendering').value === 'immediate' ? 'immediate' : 'aurora',
      alwaysTranslateLanguages: [...el('alwaysTranslateLanguages').querySelectorAll<HTMLInputElement>('input')]
        .filter((input) => input.checked).map((input) => input.value),
      siteRules: settings!.siteRules,
      localModelId: el('localModel').value
    };
  }

  async function persist(nextSettings: FormValues): Promise<AT.settings.Settings> {
    settings = await AT.settings.save(nextSettings);
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
    if (action && settings!.siteRules.some((rule) => rule.pattern === canonical && rule.action === 'never')) {
      setStatus(el('saveStatus'), AT.i18n.msg('options_blockedRule'), 'error');
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
      if (!usage.persisted && !el('modelStatus').textContent) {
        setStatus(el('modelStatus'), AT.i18n.msg('options_notPersisted'), 'warn');
      }
    } catch (error: unknown) {
      models = [];
      setStatus(el('modelStatus'), reason(error), 'error');
    }
    renderModels();
  }

  /** Deletes a model, and the resident copy of it if it was the chosen one. */
  async function forget(model: AT.local.ModelRecord): Promise<void> {
    try {
      const wasSelected = settings!.localModelId === model.id;
      const removed = await AT.modelstore.remove(model.id);
      if (wasSelected) {
        // Patch one field: the page's copy of the rest may already be stale
        // (another context changed the switch while this page was open).
        settings = await AT.settings.save({ localModelId: '' });
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

  /** Report one finished transfer; the transfer itself is `AT.modelflow`. */
  async function settle(outcome: AT.modelflow.Outcome): Promise<void> {
    el('modelProgress').hidden = true;
    setBusy(false);
    // The shared workflow owns activation and preserves the previous model
    // when a newly stored file fails to load.
    settings = await AT.settings.load();
    if (!outcome.ok) {
      const detail = `: ${outcome.error ?? 'unknown'}`;
      // Two different things happened: the bytes are stored but the model does
      // not load, or nothing arrived at all. Saying "download failed" for the
      // first one sends the user to re-download 706 MB they already have.
      setStatus(
        el('modelStatus'),
        outcome.error === 'cancelled'
          ? AT.i18n.msg('options_cancelled')
          : outcome.stored
            ? AT.i18n.msg('options_modelStored', outcome.error ?? 'model-load-failed')
            : AT.i18n.msg('options_downloadFailed') + detail,
        'error'
      );
      await refreshModels();
      render();
      return;
    }
    setStatus(
      el('modelStatus'),
      AT.i18n.msg('options_downloadDone', [
        outcome.name,
        AT.local.formatBytes(outcome.bytes),
        String(outcome.seconds)
      ]),
      'ok'
    );
    await refreshModels();
    render();
  }

  async function startDownload(): Promise<void> {
    const { url, size: expected } = AT.local.defaultSource();
    // Claim the transfer before the first await: a second click would start a
    // second download of the same 706 MB.
    if (inflight) return;
    const controller = new AbortController();
    inflight = controller;
    setBusy(true);
    showProgress(0, expected ?? null);
    try {
      await settle(
        await AT.modelflow.installFromUrl({ url, signal: controller.signal, onProgress: showProgress })
      );
    } finally {
      if (inflight === controller) inflight = null;
    }
  }

  async function importPickedFile(): Promise<void> {
    const files = [...(el('modelFile').files ?? [])];
    if (!files.length) return;
    setBusy(true);
    showProgress(0, files.reduce((sum, file) => sum + (file.size > 0 ? file.size : 0), 0) || null);
    try {
      await settle(await AT.modelflow.installFromFiles(files));
    } finally {
      el('modelFile').value = '';
    }
  }

  async function prepareLocal(): Promise<void> {
    const modelId = el('localModel').value;
    if (!modelId) {
      setStatus(el('modelStatus'), AT.i18n.msg('options_pickOne'), 'error');
      return;
    }
    setStatus(el('modelStatus'), AT.i18n.msg('options_preparing'), 'info');
    const prepared = await AT.modelflow.prepare(modelId);
    if (!prepared.ok) {
      setStatus(el('modelStatus'), prepared.error ?? AT.i18n.msg('options_prepareFailed'), 'error');
      return;
    }
    settings = await AT.settings.save({ localModelId: modelId });
    render();
    setStatus(el('modelStatus'), AT.i18n.msg('options_prepared'), 'ok');
  }

  function wire(): void {
    el('save').addEventListener('click', async () => {
      try { await persist(collect()); }
      catch (error) { setStatus(el('saveStatus'), reason(error), 'error'); }
    });

    el('addRule').addEventListener('click', async () => {
      try {
        await writeRules(el('rulePattern').value, 'always');
        el('rulePattern').value = '';
      } catch (error) {
        setStatus(el('saveStatus'), reason(error), 'error');
      }
    });

    el('rulePattern').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') el('addRule').click();
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
  }

  /**
   * The form is not the only writer: the popup changes the language while this
   * page may be open. Repainting from storage keeps the next Save from writing
   * values the user has not seen for a while.
   */
  function watchStorage(): void {
    AT.storage?.onChanged?.addListener((changes, area) => {
      if (area !== 'local' || !changes[C.STORAGE_KEY]) return;
      void AT.settings.load().then((loaded) => {
        settings = loaded;
        render();
      });
    });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    AT.i18n.apply(document);
    buildSelects();
    settings = await AT.settings.load();
    await AT.modelflow.keepStorage();
    // The model list decides what the model select can show, so the form is
    // painted once the store has answered rather than from settings alone.
    // A bundle that ships its own weights has them already: register them
    // before the list is painted so the model reads as installed, and only
    // fall back to the transfer when the package carries none.
    if (!settings.localModelId && (await AT.modelflow.bundled())) {
      const bundled = await AT.modelflow.installBundled();
      if (bundled.ok) settings = await AT.settings.load();
      else AT.warn('the bundled model did not load', bundled.error);
    }
    await refreshModels();
    render();
    // Listeners go on last: a Save before `render()` would persist the markup's
    // empty defaults over the user's settings.
    wire();
    watchStorage();
    document.body.dataset.ready = 'true';
  });
}

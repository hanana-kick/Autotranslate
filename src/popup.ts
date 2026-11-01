// Popup controller. Reads settings straight from storage and asks the
// background context for per-tab state and actions.
// Compiled as a classic script next to popup.html; loads after
// lib/constants.js, lib/browser.js, lib/rules.js and lib/settings.js.
namespace AT.popup {
  const C = AT.C;

  // The ids are the ones in popup.html.
  type Fields = {
    enabled: HTMLInputElement;
    host: HTMLParagraphElement;
    status: HTMLParagraphElement;
    localStatus: HTMLParagraphElement;
    targetLang: HTMLSelectElement;
    options: HTMLButtonElement;
  };

  function el<K extends keyof Fields>(id: K): Fields[K] {
    return document.getElementById(id) as Fields[K];
  }

  // `change` fires on the element the listener is attached to; the DOM types
  // only promise `EventTarget` on the event.
  function sourceOf<T extends HTMLElement>(event: Event): T {
    return event.target as T;
  }

  /** The active tab as the GET_STATE reply echoes it back. */
  type TabSummary = {
    id?: number;
    url?: string | null;
    title?: string | null;
    host: string | null;
  };

  /** One background tab-state entry. */
  type TabState = {
    status: string;
    translated: number;
    error: string | null;
    targetLang: string | null;
  };

  /** Every answered message carries `ok`; the failure fields come with it. */
  type Reply = AT.Response & { error?: string; code?: string | null };

  /** GET_STATE plus the fields the popup renders; `ok` has been checked. */
  type StateReply = Reply & {
    tab: TabSummary | null;
    canTranslate: boolean;
    tabEnabled: boolean;
    rule: AT.SiteRuleAction | null;
    state: TabState | null;
    local?: { status?: unknown; supported?: boolean } | null;
  };

  /** SET_SETTINGS echoes the snapshot the background stored. */
  type SettingsReply = Reply & { settings: AT.settings.ContentSnapshot };

  const view = {
    tab: null as TabSummary | null,
    canTranslate: false,
    tabEnabled: false,
    rule: null as AT.SiteRuleAction | null,
    tabState: null as TabState | null,
    local: null as { status?: unknown; supported?: boolean } | null,
    // refresh() fills this in before the first render.
    settings: null as AT.settings.Settings | null
  };

  function option(value: string, label: string): HTMLOptionElement {
    const node = document.createElement('option');
    node.value = value;
    node.textContent = label;
    return node;
  }

  function fillLanguages(selected: string): void {
    const select = el('targetLang');
    select.replaceChildren(
      ...C.LANGS.map((lang) => option(lang.code, `${lang.native} (${lang.code})`))
    );
    select.value = C.isSupportedLang(selected) ? selected : C.LANGS[0]!.code;
  }

  function setStatus(text: string, kind?: string): void {
    const status = el('status');
    status.textContent = text;
    status.dataset.kind = kind ?? 'info';
  }

  function render(): void {
    el('enabled').checked = view.tabEnabled;
    el('enabled').disabled = !view.canTranslate;
    fillLanguages(view.settings!.targetLang);
    el('targetLang').disabled = !view.canTranslate;
    el('host').textContent = view.tab?.host ?? view.tab?.url ?? '';
    if (!view.tab || !String(view.tab.url ?? '').startsWith('http')) {
      setStatus(AT.i18n.msg('popup_unavailable'), 'warn');
      return;
    }
    if (!view.tabEnabled) {
      setStatus(AT.i18n.msg('popup_disabled'), 'warn');
      return;
    }
    if (!view.canTranslate) {
      setStatus(AT.i18n.msg('popup_unavailable'), 'warn');
      return;
    }
    if (view.tabState?.status === 'translated' && view.tabState.translated > 0) {
      setStatus(AT.i18n.msg('popup_translated', String(view.tabState.translated)), 'ok');
      return;
    }
    if (view.tabState?.error) {
      setStatus(view.tabState.error, 'error');
      return;
    }
    setStatus(AT.i18n.msg('popup_idle'), 'info');
  }

  /** One line about the model: whether it is there, loaded, and usable for the
   *  language pair the user picked. */
  function renderLocal(): void {
    const node = el('localStatus');
    const supported = view.local?.supported === true;
    const phrase = AT.local.describeStatus(
      view.local?.status ? AT.local.normalizeStatus(view.local.status) : null,
      supported,
      (key, subs) => AT.i18n.msg(key, subs)
    );
    const verified = AT.local.isVerifiedPair(view.settings!.sourceLang, view.settings!.targetLang);
    node.hidden = false;
    // The engine is the default, so the first thing a new user needs is the one
    // step that makes it work: the model is theirs to download, in Options.
    if (supported && !view.settings!.localModelId) {
      node.dataset.kind = 'warn';
      node.textContent = AT.i18n.msg('popup_localNoModel');
      return;
    }
    // A model is only known-good on the pairs it was checked against; admitting
    // that is cheaper than letting a poor answer look like an extension bug.
    node.dataset.kind = !supported || !verified ? 'warn' : 'info';
    node.textContent = supported && !verified ? `${phrase} · ${AT.i18n.msg('popup_localUnverified')}` : phrase;
  }

  async function refresh(): Promise<void> {
    el('options').disabled = true;
    const [response, settings] = await Promise.all([
      AT.sendMessage({ type: C.MSG.GET_STATE }) as Promise<StateReply>,
      AT.settings.load()
    ]);
    if (!response?.ok) {
      el('options').disabled = false;
      setStatus(response?.error ?? AT.i18n.msg('popup_unavailable'), 'error');
      return;
    }
    view.tab = response.tab;
    view.canTranslate = response.canTranslate;
    view.tabEnabled = response.tabEnabled === true;
    view.rule = response.rule;
    view.tabState = response.state;
    view.local = response.local ?? null;
    view.settings = settings;
    render();
    renderLocal();
    if (view.tab?.id != null) {
      await AT.ui.preparePage('options.html', view.tab.id).catch(() => undefined);
    }
    el('options').disabled = false;
  }

  async function patchSettings(
    patch: Partial<AT.settings.Settings>
  ): Promise<AT.settings.ContentSnapshot | null> {
    const response = (await AT.sendMessage({ type: C.MSG.SET_SETTINGS, patch })) as SettingsReply;
    if (!response?.ok) {
      setStatus(response?.error ?? 'error', 'error');
      return null;
    }
    view.settings = await AT.settings.load();
    return response.settings;
  }

  async function send(type: string, extra?: { [key: string]: unknown }): Promise<Reply> {
    const response = (await AT.sendMessage({ type, tabId: view.tab?.id, ...extra })) as Reply;
    if (!response?.ok) setStatus(response?.error ?? 'error', 'error');
    return response;
  }

  function wire(): void {
    el('enabled').addEventListener('change', async (event) => {
      const enabled = sourceOf<HTMLInputElement>(event).checked;
      if (!view.canTranslate || view.tab?.id == null) return;
      el('enabled').disabled = true;
      const reply = await send(C.MSG.SET_TAB_ENABLED, { enabled });
      await refresh();
      if (!reply.ok) setStatus(reply.error ?? 'error', 'error');
    });

    el('targetLang').addEventListener('change', async (event) => {
      await patchSettings({ targetLang: sourceOf<HTMLSelectElement>(event).value });
      // The background updates selected tabs; changing language never opts in
      // this tab and must not issue a duplicate translate command.
      await refresh();
    });

    el('options').addEventListener('click', () => {
      // A click here is a gesture, which is exactly what the side panel needs.
      // Without a model the onboarding page is the useful destination; a fully
      // set-up profile wants the settings page.
      void AT.ui.openPage('options.html', 'auto', view.tab?.id ?? null)
        .catch((error) => setStatus(String(error?.message ?? error), 'error'));
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    AT.i18n.apply(document);
    wire();
    refresh().catch((error: { message?: string }) => {
      AT.warn('popup refresh failed', error);
      setStatus(error?.message ?? String(error), 'error');
    });
  });
}

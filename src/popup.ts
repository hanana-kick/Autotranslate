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
    siteRule: HTMLSelectElement;
    translate: HTMLButtonElement;
    restore: HTMLButtonElement;
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
    rule: AT.SiteRuleAction | null;
    state: TabState | null;
    local?: { status?: unknown; supported?: boolean } | null;
  };

  /** SET_SETTINGS echoes the snapshot the background stored. */
  type SettingsReply = Reply & { settings: AT.settings.ContentSnapshot };

  const view = {
    tab: null as TabSummary | null,
    canTranslate: false,
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
    el('enabled').checked = view.settings!.enabled;
    fillLanguages(view.settings!.targetLang);
    el('siteRule').value = view.rule ?? '';
    const usable = view.canTranslate && view.settings!.enabled;
    for (const id of ['translate', 'restore', 'siteRule'] as const) {
      el(id).disabled = !usable;
    }
    el('host').textContent = view.tab?.host ?? view.tab?.url ?? '';
    if (!view.tab || !String(view.tab.url ?? '').startsWith('http')) {
      setStatus(AT.i18n.msg('popup_unavailable'), 'warn');
      return;
    }
    if (!view.settings!.enabled) {
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

  /** One line about the on-device engine, so the user knows whether the page
   *  they are looking at is being translated locally or not. */
  function renderLocal(): void {
    const node = el('localStatus');
    const engine = C.getEngineMeta(view.settings!.engine);
    if (engine?.kind !== 'local') {
      node.hidden = true;
      node.textContent = '';
      return;
    }
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
    const [response, settings] = await Promise.all([
      AT.sendMessage({ type: C.MSG.GET_STATE }) as Promise<StateReply>,
      AT.settings.load()
    ]);
    if (!response?.ok) {
      setStatus(response?.error ?? AT.i18n.msg('popup_unavailable'), 'error');
      return;
    }
    view.tab = response.tab;
    view.canTranslate = response.canTranslate;
    view.rule = response.rule;
    view.tabState = response.state;
    view.local = response.local ?? null;
    view.settings = settings;
    render();
    renderLocal();
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
      await patchSettings({ enabled: sourceOf<HTMLInputElement>(event).checked });
      await refresh();
    });

    el('targetLang').addEventListener('change', async (event) => {
      await patchSettings({ targetLang: sourceOf<HTMLSelectElement>(event).value });
      const wasTranslated = view.tabState?.status === 'translated';
      if (wasTranslated) await send(C.MSG.TRANSLATE_TAB);
      await refresh();
    });

    el('siteRule').addEventListener('change', async (event) => {
      const action = sourceOf<HTMLSelectElement>(event).value || null;
      const response = (await AT.sendMessage({
        type: action ? C.MSG.SET_SITE_RULE : C.MSG.REMOVE_SITE_RULE,
        tabId: view.tab?.id,
        pattern: view.tab?.host,
        action
      })) as Reply;
      if (!response?.ok) {
        setStatus(response?.error ?? 'error', 'error');
        return;
      }
      if (action === 'never') await send(C.MSG.RESTORE_TAB);
      if (action === 'always') await send(C.MSG.TRANSLATE_TAB);
      await refresh();
    });

    el('translate').addEventListener('click', async () => {
      setStatus(AT.i18n.msg('popup_working'), 'info');
      await send(C.MSG.TRANSLATE_TAB);
      await refresh();
    });

    el('restore').addEventListener('click', async () => {
      await send(C.MSG.RESTORE_TAB);
      await refresh();
    });

    el('options').addEventListener('click', () => void AT.api?.runtime.openOptionsPage());
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

// Popup controller. Reads settings straight from storage and asks the
// background context for per-tab state and actions.
(() => {
  const AT = globalThis.AT;
  const C = AT.C;

  const el = (id) => document.getElementById(id);
  const view = { tab: null, canTranslate: false, rule: null, tabState: null, settings: null };

  function option(value, label) {
    const node = document.createElement('option');
    node.value = value;
    node.textContent = label;
    return node;
  }

  function fillLanguages(selected) {
    const select = el('targetLang');
    select.replaceChildren(
      ...C.LANGS.map((lang) => option(lang.code, `${lang.native} (${lang.code})`))
    );
    select.value = C.isSupportedLang(selected) ? selected : C.LANGS[0].code;
  }

  function setStatus(text, kind) {
    const status = el('status');
    status.textContent = text;
    status.dataset.kind = kind ?? 'info';
  }

  function render() {
    el('enabled').checked = view.settings.enabled;
    fillLanguages(view.settings.targetLang);
    el('siteRule').value = view.rule ?? '';
    const usable = view.canTranslate && view.settings.enabled;
    for (const id of ['translate', 'restore', 'siteRule']) {
      el(id).disabled = !usable;
    }
    el('host').textContent = view.tab?.host ?? view.tab?.url ?? '';
    if (!view.tab || !String(view.tab.url ?? '').startsWith('http')) {
      setStatus(AT.i18n.msg('popup_unavailable'), 'warn');
      return;
    }
    if (!view.settings.enabled) {
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

  async function refresh() {
    const [response, settings] = await Promise.all([
      AT.sendMessage({ type: C.MSG.GET_STATE }),
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
    view.settings = settings;
    render();
  }

  async function patchSettings(patch) {
    const response = await AT.sendMessage({ type: C.MSG.SET_SETTINGS, patch });
    if (!response?.ok) {
      setStatus(response?.error ?? 'error', 'error');
      return null;
    }
    view.settings = await AT.settings.load();
    return response.settings;
  }

  async function send(type, extra) {
    const response = await AT.sendMessage({ type, tabId: view.tab?.id, ...extra });
    if (!response?.ok) setStatus(response?.error ?? 'error', 'error');
    return response;
  }

  function wire() {
    el('enabled').addEventListener('change', async (event) => {
      await patchSettings({ enabled: event.target.checked });
      await refresh();
    });

    el('targetLang').addEventListener('change', async (event) => {
      await patchSettings({ targetLang: event.target.value });
      const wasTranslated = view.tabState?.status === 'translated';
      if (wasTranslated) await send(C.MSG.TRANSLATE_TAB);
      await refresh();
    });

    el('siteRule').addEventListener('change', async (event) => {
      const action = event.target.value || null;
      const response = await AT.sendMessage({
        type: action ? C.MSG.SET_SITE_RULE : C.MSG.REMOVE_SITE_RULE,
        tabId: view.tab?.id,
        pattern: view.tab?.host,
        action
      });
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

    el('options').addEventListener('click', () => AT.api.runtime.openOptionsPage());
  }

  document.addEventListener('DOMContentLoaded', () => {
    AT.i18n.apply(document);
    wire();
    refresh().catch((error) => {
      AT.warn('popup refresh failed', error);
      setStatus(error?.message ?? String(error), 'error');
    });
  });
})();

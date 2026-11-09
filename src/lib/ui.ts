// Extension-owned surfaces. A detached settings window keeps the originating
// tab ID: opening/focusing the window must never select a different web page.
namespace AT.ui {
  export type Surface = 'panel' | 'window';
  const prepared = new Map<number, { path: string; ready: Promise<void>; complete: boolean }>();

  export function targetTabId(): number | null {
    const raw = new URLSearchParams(globalThis.location?.search ?? '').get('tabId');
    if (raw === null || !/^\d+$/.test(raw)) return null;
    const id = Number(raw);
    return Number.isSafeInteger(id) ? id : null;
  }

  function pathFor(page: string, tabId: number | null): string {
    if (!['options.html', 'welcome.html'].includes(page)) throw new Error('unsupported extension page');
    return tabId === null ? page : `${page}?tabId=${tabId}`;
  }

  /** Preconfigure while the popup loads; the click can then open synchronously. */
  export function preparePage(page: string, tabId: number): Promise<void> {
    if (!AT.supportsSidePanel() || !AT.sidePanelApi) return Promise.resolve();
    const path = pathFor(page, tabId);
    const found = prepared.get(tabId);
    if (found?.path === path) return found.ready;
    const ready = AT.sidePanelApi.setOptions({ tabId, path, enabled: true });
    const record = { path, ready, complete: false };
    prepared.set(tabId, record);
    void ready.then(() => { record.complete = true; }, () => { if (prepared.get(tabId) === record) prepared.delete(tabId); });
    return ready;
  }

  /** Use a tab-scoped side panel, or a real popup window (never a new tab). */
  export async function openPage(
    page: string,
    surface: 'auto' | 'window' = 'auto',
    target?: number | null
  ): Promise<Surface> {
    let tabId = target;
    if (tabId === undefined) {
      tabId = targetTabId();
      if (tabId === null) {
        const active = await AT.tabs?.query({ active: true, currentWindow: true });
        const tab = active?.find((candidate) => /^https?:/i.test(candidate?.url ?? ''));
        tabId = tab?.id ?? null;
      }
    }
    if (tabId !== null && (!Number.isSafeInteger(tabId) || tabId < 0)) throw new Error('invalid target tab');
    const path = pathFor(page, tabId);
    if (surface === 'auto' && tabId !== null && AT.supportsSidePanel() && AT.sidePanelApi) {
      try {
        // A prepared popup click reaches open() before its first await, retaining
        // the browser's user activation. Other callers configure then attempt it.
        if (prepared.get(tabId)?.path !== path || !prepared.get(tabId)?.complete) await preparePage(page, tabId);
        await AT.sidePanelApi.open({ tabId });
        return 'panel';
      } catch (error: unknown) {
        AT.log('side panel unavailable; opening settings window', String((error as Error)?.message ?? error));
      }
    }
    if (!AT.windows) throw new Error('extension windows API is unavailable');
    await AT.windows.create({ url: AT.getURL(path), type: 'popup', width: 520, height: 820, focused: true });
    return 'window';
  }

  export type TabView = AT.Response & {
    tab?: { id?: number; title?: string | null; url?: string | null; host?: string | null } | null;
    tabEnabled?: boolean;
    canTranslate?: boolean;
    state?: { status?: string; translated?: number; error?: string | null } | null;
  };

  /** Shared tab switch for persistent options surfaces. No tab ID means OFF,
   * not "guess the active tab", because this surface may itself be active. */
  export function bindTabSwitch(input: HTMLInputElement, host: HTMLElement, status: HTMLElement): () => Promise<void> {
    const id = targetTabId();
    let changing = false;
    const refresh = async (): Promise<void> => {
      if (changing) return;
      input.disabled = true;
      if (id === null) {
        host.textContent = AT.i18n.msg('tab_noTarget');
        input.checked = false;
        return;
      }
      const reply = await AT.sendMessage({ type: AT.C.MSG.GET_STATE, tabId: id }) as TabView;
      if (changing) return;
      if (!reply.ok || !reply.tab || !reply.canTranslate) {
        input.checked = false;
        host.textContent = AT.i18n.msg('tab_unavailable');
        return;
      }
      host.textContent = reply.tab.title || reply.tab.host || reply.tab.url || '';
      host.title = reply.tab.url ?? '';
      input.checked = reply.tabEnabled === true;
      input.disabled = false;
      status.textContent = reply.state?.error || AT.i18n.msg(input.checked ? 'tab_enabledHint' : 'tab_disabledHint');
      status.dataset.kind = reply.state?.error ? 'error' : 'info';
    };
    input.addEventListener('change', async () => {
      if (id === null) return;
      changing = true;
      input.disabled = true;
      let failure: string | null = null;
      try {
        const reply = await AT.sendMessage({ type: AT.C.MSG.SET_TAB_ENABLED, tabId: id, enabled: input.checked });
        if (!reply.ok) throw new Error(String(reply.error ?? 'tab control failed'));
      } catch (error) {
        failure = String((error as Error)?.message ?? error);
      } finally {
        changing = false;
        await refresh();
        if (failure) { status.textContent = failure; status.dataset.kind = 'error'; }
      }
    });
    AT.storage?.onChanged?.addListener((changes, area) => {
      if (area === 'session' && changes['translationTargets.v1']) void refresh();
    });
    AT.tabs?.onRemoved.addListener((removed) => { if (removed === id) void refresh(); });
    globalThis.addEventListener?.('focus', () => { void refresh(); });
    void refresh();
    return refresh;
  }
}

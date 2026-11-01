// Extension UI is docked when supported, otherwise opened in a real window.
// A known source tab lets the click handler call sidePanel.open before awaiting
// anything, retaining Chrome's user-gesture permission.
namespace AT.ui {
  export type Surface = 'panel' | 'window';
  export function targetTabId(): number | undefined {
    const value = new URLSearchParams(globalThis.location?.search ?? '').get('tabId');
    if (value === null || !/^\d+$/.test(value)) return undefined;
    const id = Number(value);
    return Number.isSafeInteger(id) ? id : undefined;
  }
  export async function openPage(page: string, surface: 'auto' | 'window' = 'auto', target?: number): Promise<Surface> {
    if (!['options.html', 'welcome.html'].includes(page)) throw new Error('unknown extension page');
    let tabId = target;
    if (tabId === undefined) {
      const tabs = await AT.tabs?.query({ active: true, currentWindow: true });
      const tab = tabs?.[0];
      if (tab?.id !== undefined && /^https?:/i.test(tab.url ?? '')) tabId = tab.id;
    }
    const path = tabId === undefined ? page : page + '?tabId=' + tabId;
    const panel = AT.sidePanelApi;
    if (surface === 'auto' && AT.supportsSidePanel() && panel && tabId !== undefined) {
      try {
        // Both browser calls are issued during the originating gesture. Awaiting
        // storage/tabs/setOptions before open can lose the gesture in Chromium.
        const configured = panel.setOptions({ path, tabId, enabled: true });
        const opened = panel.open({ tabId });
        await Promise.all([configured, opened]);
        return 'panel';
      } catch (error: unknown) {
        AT.log('side panel unavailable; opening a window', String((error as Error)?.message ?? error));
      }
    }
    if (!AT.api?.windows?.create) throw new Error('this browser cannot open an options window');
    await AT.api.windows.create({ url: AT.getURL(path), type: 'popup', focused: true, width: 560, height: 800 });
    return 'window';
  }
}

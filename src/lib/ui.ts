// Extension-owned global settings and setup surfaces, separate from web tabs.
namespace AT.ui {
  /** Called directly from a click handler so native sidebar APIs retain the gesture. */
  export async function openPage(page: string): Promise<'sidebar' | 'window'> {
    if (page !== 'options.html' && page !== 'welcome.html') throw new Error('unsupported extension page');
    if (page === 'options.html') {
      if (AT.api?.sidebarAction?.open) {
        await AT.api.sidebarAction.open();
        return 'sidebar';
      }
      if (AT.api?.sidePanel?.open) {
        const window = await AT.windows?.getCurrent?.();
        if (window?.id == null) throw new Error('the settings window is unavailable');
        await AT.api.sidePanel.open({ windowId: window.id });
        return 'sidebar';
      }
    }
    if (!AT.windows) throw new Error('extension windows API is unavailable');
    await AT.windows.create({ url: AT.getURL(page), type: 'popup', width: 520, height: 820, focused: true });
    return 'window';
  }
}

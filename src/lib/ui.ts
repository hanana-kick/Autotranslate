// Where an extension page is shown. The side panel is the better surface when
// the browser has one — it stays next to the page instead of taking a tab — but
// the browser only allows `sidePanel.open` in response to a user gesture, so a
// caller that has none (the background opening onboarding after an install) must
// land on a tab instead of doing nothing.
// Load after lib/constants.js, lib/browser.js.
namespace AT.ui {
  export type Surface = 'panel' | 'tab';

  /**
   * Shows `page` (`'welcome.html'`, `'options.html'`) and says where it went.
   * The side panel path does two things: it registers the page as the panel's
   * content, then asks the browser to open it. Either step can fail (no API, no
   * gesture, a browser that refuses a panel for that window), and a failure is
   * not an error for the caller: the tab still opens.
   */
  export async function openPage(page: string, surface: 'auto' | 'tab' = 'auto'): Promise<Surface> {
    const panel = AT.sidePanelApi;
    if (surface === 'auto' && AT.supportsSidePanel() && panel) {
      const url = AT.getURL(page);
      try {
        await panel.setOptions({ path: page, enabled: true });
        // `open` takes a window id or a tab id, and the tab API is the surface
        // this context has: the panel then follows that tab.
        const tabId = await activeTabId();
        if (tabId === null) throw new Error('no active tab to dock the panel to');
        await panel.open({ tabId });
        return 'panel';
      } catch (error: unknown) {
        // A gesture-less caller lands here every time; that is expected.
        AT.log('the side panel did not open, using a tab', String((error as { message?: unknown })?.message ?? error), url);
      }
    }
    await AT.tabs!.create({ url: AT.getURL(page), active: true });
    return 'tab';
  }

  /** The tab the user is looking at, for `sidePanel.open`. */
  async function activeTabId(): Promise<number | null> {
    const tabs = await AT.tabs?.query?.({ active: true, currentWindow: true });
    const id = tabs?.[0]?.id;
    return typeof id === 'number' ? id : null;
  }
}

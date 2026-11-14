// Extension-owned global settings and setup surfaces, separate from web tabs.
namespace AT.ui {
  /** Open a detached window without reading or changing any tab's state. */
  export async function openPage(page: string): Promise<'window'> {
    if (page !== 'options.html' && page !== 'welcome.html') throw new Error('unsupported extension page');
    if (!AT.windows) throw new Error('extension windows API is unavailable');
    await AT.windows.create({ url: AT.getURL(page), type: 'popup', width: 520, height: 820, focused: true });
    return 'window';
  }
}

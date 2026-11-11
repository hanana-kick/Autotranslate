// The Chrome placement of the on-device host. A service worker is too
// short-lived and cannot host WebAssembly plus WebGPU, so the background
// creates this document and talks to it over runtime messages. The host
// itself lives in lib/onnxhost.js, which runs unchanged in a Firefox
// background page: this file is only the message plumbing.
// Load after lib/constants.js, lib/browser.js, lib/local.js,
// lib/modelstore.js and lib/onnxhost.js.
namespace AT.offscreen {
  const C = AT.C;
  const L = AT.local;

  const report = (status: AT.local.LocalStatus): void => {
    // The background keeps the copy the popup reads; nobody answers here.
    void AT.sendMessage({ type: C.MSG.LOCAL_STATUS, status });
  };
  AT.onnxhost.install('offscreen', report);

  /** Only messages the background addressed to this document are ours. */
  const addressed = (message: AT.Message): boolean => (message as { to?: unknown }).to === L.TARGET_OFFSCREEN;

  /** The host answers with the same payload the background would have got
   *  back over the message boundary, so one dispatcher serves both. */
  const handle = async (message: AT.Message): Promise<AT.local.HostReply | Record<string, never>> => {
    if (!addressed(message)) return {};
    return AT.onnxhost.handle(message);
  };

  AT.onMessage({
    [C.MSG.LOCAL_TRANSLATE]: handle,
    [C.MSG.LOCAL_LOAD]: handle,
    [C.MSG.LOCAL_UNLOAD]: handle,
    [C.MSG.LOCAL_COUNT]: handle,
    [C.MSG.LOCAL_STATUS]: handle,
    [C.MSG.LOCAL_QUERY]: handle
  });
}

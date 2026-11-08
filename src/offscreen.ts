// The Chrome placement of the on-device host. A service worker is too
// short-lived and cannot host WebAssembly plus WebGPU, so the background
// creates this document and talks to it over runtime messages. The host
// Load after lib/constants.js, lib/browser.js, lib/local.js,
// lib/modelstore.js, lib/localhost.js, lib/onnxhost.js and the three vendored
// ONNX runtime scripts (vendor/ort-common.all.js, vendor/ort-webgpu.all.js,
// vendor/transformers.web.js).
namespace AT.offscreen {
  const C = AT.C;
  const L = AT.local;

  AT.localhost.install('offscreen', report);
  if (typeof AT.onnxhost !== 'undefined') AT.onnxhost.install('offscreen', report);

  function report(status: AT.local.LocalStatus): void {
    // The background keeps the copy the popup reads; nobody answers here.
    void AT.sendMessage({ type: C.MSG.LOCAL_STATUS, status });
  }

  /** Only messages the background addressed to this document are ours. */
  const addressed = (message: AT.Message): boolean => (message as { to?: unknown }).to === L.TARGET_OFFSCREEN;

  /** The host answers with the same payload the background would have got
   *  back over the message boundary, so one dispatcher serves both. */
  const handle = (message: AT.Message): Promise<AT.localhost.HostReply> | Record<string, never> => {
    if (!addressed(message)) return {};
    const modelId = typeof (message as { modelId?: unknown }).modelId === 'string' ? String((message as { modelId?: unknown }).modelId) : '';
    const host = modelId && L.modelKindFor(modelId) === 'onnx' && typeof AT.onnxhost !== 'undefined' ? AT.onnxhost : AT.localhost;
    return host.handle(message);
  };

  AT.onMessage({
    [C.MSG.LOCAL_TRANSLATE]: handle,
    [C.MSG.LOCAL_LOAD]: handle,
    [C.MSG.LOCAL_UNLOAD]: handle,
    [C.MSG.LOCAL_STATUS]: handle,
    [C.MSG.LOCAL_QUERY]: handle
  });
}

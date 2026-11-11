// TEST ONLY: deterministic inference controls, in the disposable extension.
// The production offscreen document and extension message path remain in use;
// only the pipeline behind them is a double (see onnx-runtime.mjs).
// Every ONNX card runs f16 activations, so the probe has to see that feature.
Object.defineProperty(navigator, 'gpu', {
  configurable: true,
  value: { requestAdapter: async () => ({ features: { has: () => true } }) }
});
const state = globalThis.__qa = { hold: false, failWarmup: false, pending: [], prompts: [], instances: 0, closed: 0 };
const snapshot = () => ({
  pending: state.pending.length,
  prompts: state.prompts,
  instances: state.instances,
  closed: state.closed
});
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message.type !== 'qa/control') return;
  if (typeof message.hold === 'boolean') state.hold = message.hold;
  if (typeof message.failWarmup === 'boolean') state.failWarmup = message.failWarmup;
  if (message.release) {
    state.hold = false;
    state.pending.splice(0).forEach((resolve) => resolve());
  }
  respond({ ok: true, ...snapshot() });
});

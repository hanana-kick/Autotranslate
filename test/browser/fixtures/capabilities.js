// TEST ONLY. Copied into a disposable extension, never src/ or release archives.
// This suite checks extension lifecycle and messaging, not GPU capabilities.
Object.defineProperty(navigator, 'gpu', { configurable: true, value: { requestAdapter: async () => ({}) } });
globalThis.__qa = { hold: false, failWarmup: false, pending: [], prompts: [], instances: 0, closed: 0 };
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message.type !== 'qa/control') return;
  const state = globalThis.__qa;
  if (typeof message.hold === 'boolean') state.hold = message.hold;
  if (typeof message.failWarmup === 'boolean') state.failWarmup = message.failWarmup;
  if (message.release) {
    state.hold = false;
    state.pending.splice(0).forEach((resolve) => resolve());
  }
  respond({ ok: true, pending: state.pending.length, prompts: state.prompts, instances: state.instances, closed: state.closed });
});

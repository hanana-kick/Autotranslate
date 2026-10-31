// TEST ONLY: deterministic inference controls, in the disposable extension.
// The production dedicated worker and extension message path remain in use.
Object.defineProperty(navigator, 'gpu', { configurable: true, value: { requestAdapter: async () => ({}) } });
const channel = new BroadcastChannel('autotranslate-test-runtime');
const isWorker = typeof document === 'undefined';
const state = globalThis.__qa = { hold: false, failWarmup: false, pending: [], prompts: [], instances: 0, closed: 0 };
const snapshot = () => ({ pending: state.pending.length, prompts: state.prompts, instances: state.instances, closed: state.closed });
function apply(message) {
  if (typeof message.hold === 'boolean') state.hold = message.hold;
  if (typeof message.failWarmup === 'boolean') state.failWarmup = message.failWarmup;
  if (message.release) { state.hold = false; state.pending.splice(0).forEach((resolve) => resolve()); }
}
if (isWorker) {
  let initialized;
  globalThis.__qaReady = new Promise((resolve) => { initialized = resolve; });
  globalThis.__qaPublish = () => channel.postMessage({ kind: 'snapshot', state: snapshot() });
  channel.onmessage = ({ data }) => {
    if (data.kind === 'initialize') { apply(data); initialized(); }
    if (data.kind === 'control') { apply(data.message); channel.postMessage({ kind: 'reply', id: data.id, state: snapshot() }); }
  };
  channel.postMessage({ kind: 'hello' });
} else {
  let mirror = snapshot(), sequence = 0;
  const waiting = new Map();
  channel.onmessage = ({ data }) => {
    if (data.kind === 'hello') channel.postMessage({ kind: 'initialize', hold: state.hold, failWarmup: state.failWarmup });
    if (data.state) mirror = data.state;
    if (data.kind === 'reply') waiting.get(data.id)?.();
  };
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type !== 'qa/control') return;
    apply(message);
    if (!('hold' in message) && !('failWarmup' in message) && !message.release) { respond({ ok: true, ...mirror }); return; }
    const id = ++sequence;
    // No compute worker exists before the first model is loaded, or after
    // explicit unload. Keep configuration for its initialization handshake.
    const timer = setTimeout(() => { waiting.delete(id); respond({ ok: true, ...mirror }); }, 200);
    waiting.set(id, () => { clearTimeout(timer); waiting.delete(id); respond({ ok: true, ...mirror }); });
    channel.postMessage({ kind: 'control', id, message });
    return true;
  });
}

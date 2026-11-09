import assert from 'node:assert/strict';
import test from 'node:test';
import { load, resetGlobals, deferred, type ATNamespace } from './helpers.ts';

// Message-contract tests against the compiled production background. HTTP and
// real-model behavior are separately covered by server.test and server-extension.
function serverBackground() {
  resetGlobals();
  const globals = globalThis as ATNamespace;
  const handlers: ((message: ATNamespace, sender: ATNamespace, reply: (value: any) => void) => unknown)[] = [];
  const changed: ((changes: ATNamespace, area: string) => void)[] = [];
  const tabs = [{ id: 7, url: 'https://example.com/a', active: true }, { id: 8, url: 'https://example.com/b', active: false }];
  const store: ATNamespace = { settings: { engine: 'openai', serverBaseUrl: 'http://localhost:8000/v1', serverModel: 'big', serverApiKey: 'test-key', targetLang: 'ko' } };
  const session: ATNamespace = { 'translationTargets.v1': [7, 8] };
  const native: any[] = [];
  const event = { addListener: () => undefined };
  const dispatch = async (message: ATNamespace, sender: ATNamespace = {}): Promise<ATNamespace> => {
    const result = deferred<ATNamespace>();
    for (const handle of handlers) {
      const answer = handle(message, sender, result.resolve);
      if (answer instanceof Promise) answer.then(result.resolve);
    }
    return result.promise;
  };
  globals.browser = {
    runtime: {
      getURL: (path: string) => 'chrome-extension://qa/' + path,
      getManifest: () => ({ version: '0.1.6' }),
      sendMessage: async (m: any) => { if (m.to === 'offscreen') { native.push(m); throw Error('local host forbidden'); } return dispatch(m); },
      onMessage: { addListener: (fn: any) => handlers.push(fn) }, onInstalled: event, onStartup: event
    },
    storage: {
      local: { get: async (key: string) => ({ [key]: store[key] }), set: async (items: any) => {
        const edits: ATNamespace = {};
        for (const key of Object.keys(items)) edits[key] = { oldValue: store[key], newValue: items[key] };
        Object.assign(store, items); for (const fn of changed) fn(edits, 'local');
      } },
      session: { get: async (key: string) => ({ [key]: session[key] }), set: async (items: any) => Object.assign(session, items) },
      onChanged: { addListener: (fn: any) => changed.push(fn) }
    },
    tabs: {
      get: async (id: number) => tabs.find(t => t.id === id), query: async () => tabs,
      sendMessage: async (_id: number, message: any) => message.type === 'at/content-state'
        ? { ok: true, status: 'idle', translated: 0 } : { ok: true, status: 'translated', translated: 1 },
      onUpdated: event, onRemoved: event, onActivated: event
    },
    scripting: { executeScript: async () => undefined },
    action: { setBadgeText: async () => undefined, setBadgeBackgroundColor: async () => undefined },
    offscreen: { hasDocument: async () => false, createDocument: async () => { native.push('created'); throw Error('offscreen forbidden'); } },
    i18n: { getUILanguage: () => 'en', getMessage: (key: string) => key }
  };
  globals.self = {};
  const AT = load('lib/constants.js', 'lib/browser.js', 'lib/gemma.js', 'lib/pagecontext.js', 'lib/targets.js', 'lib/rules.js', 'lib/local.js', 'lib/modelstore.js', 'lib/ui.js', 'lib/settings.js', 'lib/engines.js', 'lib/localhost.js', 'background.js');
  AT.warn = () => undefined;
  return { AT, dispatch, native, tabs };
}

test('server background dispatches without preparing a local model or probing WebGPU', async () => {
  const { AT, dispatch, native, tabs } = serverBackground();
  const requests: any[] = [];
  AT.engines.translate = async (request: any) => { requests.push(request); return { translations: ['안녕'], detected: null, requested: 1 }; };
  const state = await dispatch({ type: AT.C.MSG.GET_STATE, tabId: 7 });
  assert.equal(state.ok, true); assert.equal(state.local, null);
  const response = await dispatch({ type: AT.C.MSG.BATCH, texts: ['hello'], sourceLang: 'en', targetLang: 'ko' }, { tab: tabs[0] });
  assert.equal(response.ok, true); assert.deepEqual(response.translations, ['안녕']);
  assert.equal(requests[0].engine, 'openai'); assert.equal(requests[0].server.model, 'big');
  assert.equal(requests[0].localModelId, ''); assert.deepEqual(native, []);
});

test('content scripts cannot test, enumerate or replace the private server configuration', async () => {
  const { AT, dispatch, tabs } = serverBackground();
  for (const type of [AT.C.MSG.TEST_ENGINE, AT.C.MSG.SERVER_MODELS, AT.C.MSG.SET_SETTINGS, AT.C.MSG.RESET_SETTINGS]) {
    const reply = await dispatch({ type, patch: { serverBaseUrl: 'http://untrusted.invalid/v1' } }, { tab: tabs[0], url: tabs[0]!.url });
    assert.equal(reply.ok, false); assert.match(reply.error, /extension page/);
  }
});

test('tab OFF aborts its server request without revoking another tab', async () => {
  const { AT, dispatch, tabs } = serverBackground();
  const entered = deferred<void>(); let signal: AbortSignal | undefined;
  AT.engines.translate = async (request: any) => {
    signal = request.signal; entered.resolve();
    await new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(Error('cancelled'))));
  };
  const pending = dispatch({ type: AT.C.MSG.BATCH, texts: ['hello'] }, { tab: tabs[0] });
  await entered.promise;
  const off = await dispatch({ type: AT.C.MSG.SET_TAB_ENABLED, tabId: 7, enabled: false });
  assert.equal(off.ok, true); assert.equal(signal?.aborted, true); assert.equal((await pending).ok, false);
  assert.equal((await dispatch({ type: AT.C.MSG.GET_STATE, tabId: 8 })).tabEnabled, true);
});

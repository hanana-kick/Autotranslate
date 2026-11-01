import test from 'node:test';
import assert from 'node:assert/strict';
import { load, resetGlobals } from './helpers.ts';

function environment(mode: 'ok' | 'absent' | 'refuses' = 'ok') {
  resetGlobals();
  const host = globalThis as Record<string, any>;
  delete host.location;
  const calls = { configure: [] as any[], open: [] as any[], windows: [] as any[], tabs: [] as any[] };
  host.browser = {
    runtime: { getURL: (path: string) => 'chrome-extension://id/' + path },
    tabs: { query: async () => [{ id: 7, url: 'https://example.com/' }], create: async (o: unknown) => calls.tabs.push(o) },
    windows: { create: async (o: unknown) => calls.windows.push(o) },
    sidePanel: mode === 'absent' ? undefined : {
      setOptions: async (o: unknown) => { calls.configure.push(o); },
      open: (o: unknown) => { calls.open.push(o); return mode === 'refuses' ? Promise.reject(new Error('no user activation')) : Promise.resolve(); }
    }
  };
  return { AT: load('lib/constants.js','lib/browser.js','lib/ui.js'), calls, host };
}

test('options use a tab-scoped side panel with an explicit original tab ID', async () => {
  const { AT, calls } = environment();
  assert.equal(await AT.ui.openPage('options.html','auto',7),'panel');
  assert.deepEqual(calls.configure,[{tabId:7,path:'options.html?tabId=7',enabled:true}]);
  assert.deepEqual(calls.open,[{tabId:7}]); assert.equal(calls.tabs.length+calls.windows.length,0);
});
test('prepared popup click calls sidePanel.open synchronously, preserving user activation', async () => {
  const { AT, calls }=environment(); await AT.ui.preparePage('options.html',7);
  const pending=AT.ui.openPage('options.html','auto',7);
  assert.equal(calls.open.length,1,'there is no intervening tabs.query/storage await'); await pending;
});
test('browser without sidePanel opens a real detached window, never a tab', async () => {
  const { AT, calls }=environment('absent');
  assert.equal(await AT.ui.openPage('options.html','auto',7),'window');
  assert.deepEqual(calls.windows,[{url:'chrome-extension://id/options.html?tabId=7',type:'popup',width:520,height:820,focused:true}]);
  assert.equal(calls.tabs.length,0);
});
test('sidePanel refusal falls back exactly once to the same target in a new window', async () => {
  const {AT,calls}=environment('refuses');
  assert.equal(await AT.ui.openPage('options.html','auto',7),'window');
  assert.equal(calls.open.length,1); assert.equal(calls.windows.length,1); assert.equal(calls.tabs.length,0);
  assert.match(calls.windows[0].url,/tabId=7$/);
});
test('install with no originating tab opens onboarding in a window without guessing a tab', async () => {
  const {AT,calls}=environment(); await AT.ui.openPage('welcome.html','window',null);
  assert.equal(calls.open.length,0); assert.equal(calls.windows[0].url,'chrome-extension://id/welcome.html');
});
test('an options window preserves its source tab even after focus changes', async () => {
  const {AT,calls,host}=environment('absent'); host.location={search:'?tabId=23'};
  await AT.ui.openPage('options.html'); assert.match(calls.windows[0].url,/tabId=23$/);
});
test('invalid tab IDs and external extension paths are rejected', async () => {
  const {AT}=environment();
  await assert.rejects(()=>AT.ui.openPage('https://example.com/','window',7),/unsupported/);
  await assert.rejects(()=>AT.ui.openPage('options.html','auto',-1),/invalid target/);
});
test('missing or malformed origin binding never defaults to tab zero', () => {
  const {AT,host}=environment();
  for(const search of ['', '?tabId=', '?tabId=-1','?tabId=abc']) { host.location={search}; assert.equal(AT.ui.targetTabId(),null); }
  host.location={search:'?tabId=0'}; assert.equal(AT.ui.targetTabId(),0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { load, resetGlobals } from './helpers.ts';

function environment() {
  resetGlobals();
  const host = globalThis as Record<string, unknown>;
  const calls = { windows: [] as unknown[], tabs: [] as unknown[] };
  host.browser = {
    runtime: { getURL: (path: string) => 'chrome-extension://id/' + path },
    tabs: { create: async (options: unknown) => calls.tabs.push(options) },
    windows: { create: async (options: unknown) => calls.windows.push(options) }
  };
  return { AT: load('lib/constants.js', 'lib/browser.js', 'lib/ui.js'), calls };
}

test('browsers without sidebar support open global detached settings and setup', async () => {
  const { AT, calls } = environment();
  for (const page of ['options.html', 'welcome.html']) {
    assert.equal(await AT.ui.openPage(page), 'window');
  }
  assert.deepEqual(calls.windows, ['options.html', 'welcome.html'].map(page => ({
    url: `chrome-extension://id/${page}`, type: 'popup', width: 520, height: 820, focused: true
  })));
  assert.deepEqual(calls.tabs, []);
});

test('only the exact settings and setup pages may open', async () => {
  const { AT, calls } = environment();
  for (const page of ['https://example.com/', '../options.html', 'options.html?tabId=7', 'popup.html']) {
    await assert.rejects(() => AT.ui.openPage(page), /unsupported extension page/);
  }
  assert.deepEqual(calls.windows, []);
  assert.deepEqual(calls.tabs, []);
});

test('an unavailable windows API reports the failure without opening a tab', async () => {
  const { AT, calls } = environment();
  AT.windows = null;
  await assert.rejects(() => AT.ui.openPage('options.html'), /windows API is unavailable/);
  assert.deepEqual(calls.tabs, []);
});

test('window creation failure reaches the caller without opening another surface', async () => {
  const { AT, calls } = environment();
  AT.windows.create = async () => { throw new Error('window creation failed'); };
  await assert.rejects(() => AT.ui.openPage('options.html'), /window creation failed/);
  assert.deepEqual(calls.tabs, []);
});

test('Chrome settings use the current window sidebar, while setup stays detached', async () => {
  const { AT, calls } = environment();
  const panels: unknown[] = [];
  AT.windows.getCurrent = async () => ({ id: 42 });
  AT.api.sidePanel = { open: async (options: unknown) => { panels.push(options); } };
  assert.equal(await AT.ui.openPage('options.html'), 'sidebar');
  assert.deepEqual(panels, [{ windowId: 42 }]);
  assert.deepEqual(calls.windows, []);
  assert.equal(await AT.ui.openPage('welcome.html'), 'window');
  assert.equal(calls.windows.length, 1);
});

test('Firefox sidebar opens synchronously within the user gesture', async () => {
  const { AT, calls } = environment();
  let opened = false;
  AT.api.sidebarAction = { open: async () => { opened = true; } };
  const opening = AT.ui.openPage('options.html');
  assert.equal(opened, true);
  assert.equal(await opening, 'sidebar');
  assert.deepEqual(calls.windows, []);
});

test('sidebar failure is reported instead of silently opening a popup', async () => {
  const { AT, calls } = environment();
  AT.windows.getCurrent = async () => ({ id: 42 });
  AT.api.sidePanel = { open: async () => { throw new Error('gesture required'); } };
  await assert.rejects(() => AT.ui.openPage('options.html'), /gesture required/);
  assert.deepEqual(calls.windows, []);
});

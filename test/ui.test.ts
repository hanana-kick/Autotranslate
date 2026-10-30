import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helpers.ts';

// `AT.ui` decides where an extension page is shown. The browser only allows a
// side panel to open on a user gesture, so the interesting cases are the ones
// where the panel refuses and a tab has to happen instead.

type Surface = {
  AT: Record<string, any>;
  calls: { setOptions: Record<string, unknown>[]; open: Record<string, unknown>[]; tabs: Record<string, unknown>[] };
};

function environment(options: { panel?: 'ok' | 'no-api' | 'refuses'; tabs?: boolean } = {}): Surface {
  const host = globalThis as Record<string, any>;
  delete host.AT;
  delete host.browser;
  const calls = { setOptions: [] as Record<string, unknown>[], open: [] as Record<string, unknown>[], tabs: [] as Record<string, unknown>[] };
  const sidePanel =
    options.panel === 'no-api'
      ? undefined
      : {
          setOptions: async (details: Record<string, unknown>) => {
            calls.setOptions.push(details);
          },
          open: async (details: Record<string, unknown>) => {
            calls.open.push(details);
            if (options.panel === 'refuses') throw new Error('`sidePanel.open()` may only be called in response to a user gesture');
          }
        };
  host.browser = {
    runtime: { getURL: (path: string) => path, getManifest: () => ({ version: '0' }) },
    tabs: {
      create: async (details: Record<string, unknown>) => {
        calls.tabs.push(details);
        return { id: 5 };
      },
      query: async () => [{ id: 7, url: 'https://example.com/' }]
    },
    sidePanel
  };
  const AT = load('lib/constants.js', 'lib/browser.js', 'lib/ui.js');
  return { AT, calls };
}

test('a browser with a side panel gets the page docked, not a tab', async () => {
  const { AT, calls } = environment({ panel: 'ok' });
  assert.equal(AT.supportsSidePanel(), true);
  const where = await AT.ui.openPage('welcome.html');

  assert.equal(where, 'panel');
  assert.deepEqual(calls.setOptions, [{ path: 'welcome.html', enabled: true }], 'the panel is told what to show');
  assert.deepEqual(calls.open, [{ tabId: 7 }], 'it opens against the tab the user is looking at');
  assert.deepEqual(calls.tabs, [], 'no tab was opened as well');
});

test('a gesture-less caller is refused and lands in a tab', async () => {
  // This is the install path: `onInstalled` is not a user gesture.
  const { AT, calls } = environment({ panel: 'refuses' });
  const where = await AT.ui.openPage('welcome.html');

  assert.equal(where, 'tab');
  assert.equal(calls.open.length, 1, 'the panel was asked once');
  assert.deepEqual(calls.tabs, [{ url: 'welcome.html', active: true }]);
});

test('a browser without the side panel API goes straight to a tab', async () => {
  const { AT, calls } = environment({ panel: 'no-api' });
  assert.equal(AT.supportsSidePanel(), false);
  assert.equal(await AT.ui.openPage('welcome.html'), 'tab');
  assert.deepEqual(calls.setOptions, [], 'nothing is configured for a panel that does not exist');
  assert.deepEqual(calls.open, []);
  assert.deepEqual(calls.tabs, [{ url: 'welcome.html', active: true }]);
});

test('no active tab means no panel to dock to, so the page opens in a tab', async () => {
  const { AT, calls } = environment({ panel: 'ok' });
  AT.tabs.query = async () => [];
  assert.equal(await AT.ui.openPage('welcome.html'), 'tab');
  assert.deepEqual(calls.open, [], 'the panel was never asked to open without a tab');
});

test('an explicit tab request skips the panel even when it is available', async () => {
  const { AT, calls } = environment({ panel: 'ok' });
  assert.equal(await AT.ui.openPage('options.html', 'tab'), 'tab');
  assert.deepEqual(calls.open, [], 'the caller asked for a tab');
  assert.deepEqual(calls.tabs, [{ url: 'options.html', active: true }]);
});

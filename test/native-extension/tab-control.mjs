// Exercise shipped UI only. No runtime, network or translated-response replacement.
import assert from 'node:assert/strict';
export async function optionsReady(page) {
  await page.waitForFunction(async () => {
    if (!globalThis.AT?.settings) return false;
    const s = await AT.settings.load();
    return document.querySelector('#localModel')?.value === s.localModelId &&
      document.querySelector('#sourceLang')?.value === s.sourceLang &&
      document.querySelector('#targetLang')?.value === s.targetLang &&
      (AT.C.MSG.SET_TAB_ENABLED ? document.body.dataset.ready === 'true' : document.querySelector('#enabled')?.checked === s.enabled);
  });
}
export async function tabIdFor(options, page) {
  const id = await options.evaluate(async (url) => (await AT.api.tabs.query({})).find(t => t.url === url)?.id, page.url());
  assert.ok(Number.isSafeInteger(id) && id >= 0, 'actual browser tab ID');
  return id;
}
export async function setTabEnabledUI(options, tabId, enabled) {
  const modern = await options.evaluate(() => !!AT.C.MSG.SET_TAB_ENABLED);
  if (!modern) {
    // The paired performance baseline is the untouched published 0.1.3 ZIP.
    assert.equal(process.env.SPEED_LABEL, 'baseline', 'legacy global switch is allowed only in the labelled historical speed baseline');
    assert.equal(await options.evaluate(() => AT.runtime.getManifest().version), '0.1.3');
    await options.reload(); await optionsReady(options);
    await options.locator('#enabled').setChecked(enabled); await options.locator('#save').click();
    await options.waitForFunction(async value => document.querySelector('#saveStatus').dataset.kind === 'ok' && (await AT.settings.load()).enabled === value, enabled);
    return;
  }
  assert.ok(Number.isSafeInteger(tabId) && tabId >= 0, 'explicit target is mandatory');
  const url = new URL(options.url()); url.pathname = '/options.html'; url.search = '?tabId=' + tabId;
  if (options.url() !== url.href) await options.goto(url.href); else await options.reload();
  await optionsReady(options);
  await options.waitForFunction(() => !document.querySelector('#enabled').disabled);
  const before = await options.evaluate(() => AT.settings.load());
  await options.locator('#enabled').setChecked(enabled);
  await options.waitForFunction(async ({tabId, enabled}) => {
    const state = await AT.sendMessage({type: AT.C.MSG.GET_STATE, tabId});
    return state.ok && state.tabEnabled === enabled && document.querySelector('#enabled').checked === enabled && !document.querySelector('#enabled').disabled;
  }, {tabId, enabled});
  assert.equal((await options.evaluate(() => AT.settings.load())).enabled, before.enabled, 'per-tab control never mutates legacy global state');
}

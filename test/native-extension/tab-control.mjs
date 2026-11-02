// Real shipped UI actions only. No model inference or extension API replacement.
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
  const id = await options.evaluate(async url => (await AT.api.tabs.query({})).find(t => t.url === url)?.id, page.url());
  assert.ok(Number.isSafeInteger(id) && id >= 0, 'actual browser tab ID');
  return id;
}
// UI page creation/hydration is measured separately from the ON-click latency.
// The benchmark exercises a visible, already opened options UI, just as a user
// clicking its checkbox does. Reloading the entire options document after the
// timer starts would time OPFS model-list initialization, not translation.
export async function prepareTabEnabledUI(options, tabId) {
  const modern = await options.evaluate(() => !!AT.C.MSG.SET_TAB_ENABLED);
  if (!modern) {
    assert.equal(process.env.SPEED_LABEL, 'baseline', 'legacy global switch is allowed only in the pinned published baseline');
    assert.equal(await options.evaluate(() => AT.runtime.getManifest().version), '0.1.4');
    await options.reload();
    await optionsReady(options);
    return;
  }
  assert.ok(Number.isSafeInteger(tabId) && tabId >= 0, 'explicit target is mandatory');
  const url = new URL(options.url()); url.pathname = '/options.html'; url.search = '?tabId=' + tabId;
  if (options.url() !== url.href) await options.goto(url.href); else await options.reload();
  await optionsReady(options);
  await options.waitForFunction(() => !document.querySelector('#enabled').disabled);
}
export async function clickPreparedTabEnabledUI(options, tabId, enabled) {
  const modern = await options.evaluate(() => !!AT.C.MSG.SET_TAB_ENABLED);
  if (!modern) {
    assert.equal(process.env.SPEED_LABEL, 'baseline', 'only labelled baseline may use the historical global switch');
    await options.locator('#enabled').setChecked(enabled);
    await options.locator('#save').click();
    await options.waitForFunction(async value => document.querySelector('#saveStatus').dataset.kind === 'ok' && (await AT.settings.load()).enabled === value, enabled);
    return;
  }
  assert.ok(Number.isSafeInteger(tabId) && tabId >= 0, 'per-tab toggle requires the source browser tab');
  assert.equal(new URL(options.url()).searchParams.get('tabId'), String(tabId), 'prepared options must be source-tab-bound');
  const before = await options.evaluate(() => AT.settings.load());
  await options.locator('#enabled').setChecked(enabled);
  await options.waitForFunction(async ({tabId,enabled}) => {
    const state = await AT.sendMessage({type: AT.C.MSG.GET_STATE, tabId});
    return state.ok && state.tabEnabled === enabled && document.querySelector('#enabled').checked === enabled && !document.querySelector('#enabled').disabled;
  }, {tabId,enabled});
  assert.equal((await options.evaluate(() => AT.settings.load())).enabled, before.enabled, 'per-tab switch must not change global consent');
}
export async function setTabEnabledUI(options, tabId, enabled) {
  await prepareTabEnabledUI(options, tabId);
  await clickPreparedTabEnabledUI(options, tabId, enabled);
}

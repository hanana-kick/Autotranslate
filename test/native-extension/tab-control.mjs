// Real shipped UI actions only. No model inference or extension API replacement.
import assert from 'node:assert/strict';

export async function optionsReady(page) {
  await page.waitForFunction(async () => {
    if (!globalThis.AT?.settings) return false;
    const s = await AT.settings.load();
    return document.querySelector('#localModel')?.value === s.localModelId &&
      document.querySelector('#targetLang')?.value === s.targetLang &&
      (AT.C.MSG.SET_TAB_ENABLED ? document.body.dataset.ready === 'true' : document.querySelector('#enabled')?.checked === s.enabled);
  });
}
export async function tabIdFor(options, page) {
  const id = await options.evaluate(async url => (await AT.api.tabs.query({})).find(t => t.url === url)?.id, page.url());
  assert.ok(Number.isSafeInteger(id) && id >= 0, 'actual browser tab ID');
  return id;
}
// Hydrate the real toolbar popup before measuring its ON click. The source tab
// stays active; settings are only an extension context for opening the action.
export async function prepareTabEnabledUI(options, tabId) {
  const modern = await options.evaluate(() => !!AT.C.MSG.SET_TAB_ENABLED);
  if (!modern) {
    assert.equal(process.env.SPEED_LABEL, 'baseline', 'legacy global switch is allowed only in the pinned published baseline');
    assert.equal(await options.evaluate(() => AT.runtime.getManifest().version), '0.1.4');
    await options.reload();
    await optionsReady(options);
    return options;
  }
  assert.ok(Number.isSafeInteger(tabId) && tabId >= 0, 'explicit target is mandatory');
  const popupURL = new URL('/popup.html', options.url()).href;
  const context = options.context();
  for (const page of context.pages()) if (page.url() === popupURL) await page.close();
  const windowId = await options.evaluate(async tabId => {
    const tab = await AT.api.tabs.get(tabId);
    await AT.api.tabs.update(tabId, { active: true });
    await AT.api.windows.update(tab.windowId, { focused: true });
    return tab.windowId;
  }, tabId);
  // Native window activation can settle after windows.update resolves on macOS.
  // Wait for the requested state before opening; never retry a side-effecting action.
  await options.waitForFunction(async windowId =>
    (await AT.api.windows.get(windowId)).focused, windowId);
  // Chromium first exposes action popups as CDP "other" targets. Opt Playwright
  // into attaching only while opening this popup, not for model host documents.
  // Launchers must use viewport:null: emulating a native popup viewport crashes
  // Chrome 143. Source tabs retain their own explicit benchmark viewport.
  const attachOther = process.env.PW_CHROMIUM_ATTACH_TO_OTHER;
  process.env.PW_CHROMIUM_ATTACH_TO_OTHER = '1';
  let popup;
  try {
    [popup] = await Promise.all([
      context.waitForEvent('page', page => page.url() === popupURL),
      options.evaluate(windowId => AT.api.action.openPopup({ windowId }), windowId)
    ]);
  } finally {
    if (attachOther === undefined) delete process.env.PW_CHROMIUM_ATTACH_TO_OTHER;
    else process.env.PW_CHROMIUM_ATTACH_TO_OTHER = attachOther;
  }
  await popup.waitForURL(popupURL);
  await popup.waitForFunction(async tabId => {
    if (!globalThis.AT?.settings || document.querySelector('#options')?.disabled ||
        !document.querySelector('#targetLang')?.options.length) return false;
    const state = await AT.sendMessage({ type: AT.C.MSG.GET_STATE });
    const toggle = document.querySelector('#enabled');
    return state.ok && state.tab?.id === tabId && !toggle?.disabled &&
      toggle?.checked === state.tabEnabled;
  }, tabId);
  return popup;
}
export async function clickPreparedTabEnabledUI(popup, tabId, enabled) {
  const modern = await popup.evaluate(() => !!AT.C.MSG.SET_TAB_ENABLED);
  if (!modern) {
    assert.equal(process.env.SPEED_LABEL, 'baseline', 'only labelled baseline may use the historical global switch');
    await popup.locator('#enabled').setChecked(enabled);
    await popup.locator('#save').click();
    await popup.waitForFunction(async value => document.querySelector('#saveStatus').dataset.kind === 'ok' && (await AT.settings.load()).enabled === value, enabled);
    return;
  }
  assert.ok(Number.isSafeInteger(tabId) && tabId >= 0, 'per-tab toggle requires the source browser tab');
  assert.equal(new URL(popup.url()).pathname, '/popup.html', 'per-tab control is the shipped popup');
  const active = await popup.evaluate(() => AT.sendMessage({ type: AT.C.MSG.GET_STATE }));
  assert.equal(active.tab?.id, tabId, 'popup must target the active source tab');
  const before = await popup.evaluate(() => AT.settings.load());
  await popup.locator('#enabled').setChecked(enabled);
  await popup.waitForFunction(async ({tabId,enabled}) => {
    const state = await AT.sendMessage({type: AT.C.MSG.GET_STATE});
    return state.ok && state.tab?.id === tabId && state.tabEnabled === enabled &&
      document.querySelector('#enabled').checked === enabled && !document.querySelector('#enabled').disabled;
  }, {tabId,enabled});
  assert.equal((await popup.evaluate(() => AT.settings.load())).enabled, before.enabled, 'per-tab switch must not change global consent');
}
export async function setTabEnabledUI(options, tabId, enabled) {
  const popup = await prepareTabEnabledUI(options, tabId);
  try { await clickPreparedTabEnabledUI(popup, tabId, enabled); }
  finally { if (popup !== options && !popup.isClosed()) await popup.close(); }
}

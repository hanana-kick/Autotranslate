// Interact with the shipped per-tab checkbox. No settings/global or model API writes.
import assert from 'node:assert/strict';
export async function pageTabId(control, page) {
  const id = await control.evaluate(async url => (await AT.api.tabs.query({})).find(t => t.url === url)?.id, page.url());
  assert.ok(Number.isSafeInteger(id), 'source page has a real tab ID'); return id;
}
export async function setTabThroughUI(options, tabId, enabled) {
  assert.ok(Number.isSafeInteger(tabId));
  const origin = options.url().split('/options.html')[0];
  // Paired benchmark also exercises the released 0.1.3 ZIP. Read feature support
  // and use that version's genuine UI, never patch the installed extension.
  const explicit = await options.evaluate(() => !!AT.C.MSG.SET_TAB_ENABLED);
  if (!explicit) {
    await options.goto(origin + '/options.html');
    await options.waitForFunction(async () => { const s=await AT.settings.load(); return document.querySelector('#localModel').value===s.localModelId && document.querySelector('#enabled').checked===s.enabled; });
    await options.locator('#enabled').setChecked(enabled); await options.locator('#save').click();
    await options.waitForFunction(async v => document.querySelector('#saveStatus').dataset.kind==='ok' && (await AT.settings.load()).enabled===v, enabled);
    return;
  }
  await options.goto(origin + '/options.html?tabId=' + tabId);
  await options.waitForFunction(async () => {
    const s = await AT.settings.load();
    return document.querySelector('#sourceLang').value === s.sourceLang &&
      document.querySelector('#targetLang').value === s.targetLang &&
      document.querySelector('#localModel').value === s.localModelId && !document.querySelector('#enabled').disabled;
  });
  await options.locator('#enabled').setChecked(enabled);
  await options.waitForFunction(async ({tabId,enabled}) =>
    document.querySelector('#enabled').checked === enabled &&
    (await AT.sendMessage({type:AT.C.MSG.GET_STATE,tabId})).tabEnabled === enabled, {tabId,enabled});
}

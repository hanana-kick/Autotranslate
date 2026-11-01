// Actual installed UI surfaces. The model and every production API are unchanged.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { optionsReady, tabIdFor } from './tab-control.mjs';
export async function runSurfaces({context,options,capture,passed,summary,save}) {
  const server=createServer((_,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><html lang="en"><title translate="no">Explicit tab controls</title><main><p>Hello.</p></main></html>');});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const page=await context.newPage();let popup, panel, detached;
  summary.tabSurfaces={passed:false};
  const previousAttachOther=process.env.PW_CHROMIUM_ATTACH_TO_OTHER;
  // Pinned Playwright normally ignores Chrome toolbar/side-panel targets whose
  // CDP type is 'other'. Attach to those ORIGINAL surfaces for this UI test.
  // Enable only after model startup, not for the inference/offscreen context.
  process.env.PW_CHROMIUM_ATTACH_TO_OTHER='1';
  summary.stage='actual-tab-controls-and-options-surfaces';await save();
  try {
    await page.goto('http://127.0.0.1:'+server.address().port+'/tab-controls');
    const tabId=await tabIdFor(options,page);
    await page.bringToFront();
    const actualTab=await options.evaluate(async id=>AT.api.tabs.get(id),tabId);
    const findPage=async predicate=>{for(let i=0;i<100;i++){const p=context.pages().find(predicate);if(p)return p;await new Promise(r=>setTimeout(r,100));}const cdp=await context.browser().newBrowserCDPSession();try{summary.tabSurfaces.uninspectableTargets=(await cdp.send('Target.getTargets')).targetInfos.map(({targetId,type,url})=>({targetId,type,url}));}finally{await cdp.detach();}await save();throw Error('actual extension surface did not become inspectable');};
    await options.evaluate(windowId=>AT.api.action.openPopup({windowId}),actualTab.windowId);
    popup=await findPage(p=>p.url().endsWith('/popup.html'));
    await popup.waitForFunction(()=>!document.querySelector('#enabled').disabled && document.querySelector('#host').textContent.length>0);
    assert.equal(await popup.locator('#enabled').isChecked(),false);
    await popup.locator('#options').click();
    // SIDE_PANEL context must really exist, not an options tab made to look like it.
    await options.waitForFunction(async id=>(await chrome.runtime.getContexts({contextTypes:['SIDE_PANEL']})).some(c=>c.documentUrl.endsWith('/options.html?tabId='+id)),tabId);
    summary.tabSurfaces.nativePanelContexts=await options.evaluate(()=>chrome.runtime.getContexts({contextTypes:['SIDE_PANEL']}));
    panel=await findPage(p=>p.url().endsWith('/options.html?tabId='+tabId)&&p!==options);
    await optionsReady(panel);
    assert.equal(await panel.locator('#enabled').isChecked(),false);
    await panel.locator('#enabled').check();
    await page.waitForFunction(()=>/[가-힣]/u.test(document.querySelector('p').textContent),null,{timeout:600000});
    await capture(panel,'explicit-tab-sidepanel');
    await panel.locator('#enabled').uncheck();
    await page.waitForFunction(()=>document.querySelector('p').textContent==='Hello.');
    await passed('real-toolbar-popup-opens-tab-scoped-sidepanel',{tabId,translationAndRestore:true});
    // Exercise the same production window path used when sidePanel is absent or
    // refused. Capability absence itself is covered by the API-contract tests.
    const newPage=context.waitForEvent('page',p=>p!==options&&p!==page&&p!==panel);
    assert.equal(await options.evaluate(id=>AT.ui.openPage('options.html','window',id),tabId),'window');
    detached=await newPage;await optionsReady(detached);
    const windowType=await detached.evaluate(async()=>{const t=(await AT.api.tabs.query({active:true,currentWindow:true}))[0];return (await AT.api.windows.get(t.windowId)).type;});
    assert.equal(windowType,'popup');assert.equal(new URL(detached.url()).searchParams.get('tabId'),String(tabId));
    await detached.locator('#enabled').check();await page.waitForFunction(()=>/[가-힣]/u.test(document.querySelector('p').textContent),null,{timeout:600000});
    await capture(detached,'explicit-tab-separate-window');
    await detached.locator('#enabled').uncheck();await page.waitForFunction(()=>document.querySelector('p').textContent==='Hello.');
    await page.close();await detached.waitForFunction(()=>document.querySelector('#enabled').disabled);
    await passed('real-detached-window-retains-source-tab-and-closure',{windowType,closedTargetDisabled:true});
    Object.assign(summary.tabSurfaces,{passed:true,sidePanel:true,separateWindow:true,modelSubstituted:false});await save();
  }finally{
    if(previousAttachOther===undefined)delete process.env.PW_CHROMIUM_ATTACH_TO_OTHER;else process.env.PW_CHROMIUM_ATTACH_TO_OTHER=previousAttachOther;
    for(const p of [popup,panel,detached,page])if(p&&!p.isClosed())await p.close().catch(()=>{});
    server.closeAllConnections();await new Promise(r=>server.close(r));
  }
}

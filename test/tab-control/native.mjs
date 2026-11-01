// Real original-model regression, operated through the shipped popup/options UI.
// Fixture JS records source and performs page edits only; no extension injection.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTabThroughUI, pageTabId } from '../native-extension/tab-ui.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function runTabControls({context,options,host,capture,stage,passed,summary,save,out}) {
  const result=summary.tabControl={scope:'original installed Chrome extension and native model; actual popup click and side panel',checks:[],passed:false};
  const origin=options.url().split('/options.html')[0];
  const html='<!doctype html><html lang="en"><head><meta charset="utf-8"><title translate="no">Explicit tab consent</title><style>body{font:20px/1.5 system-ui;margin:40px}</style></head><body><main><p id="text">Your documents remain private.</p></main><button id="append" translate="no">Add text</button><input value="retained draft"><script>document.querySelector("#append").onclick=()=>{let p=document.createElement("p");p.id="late";p.textContent="Keep practicing every day.";document.querySelector("main").append(p);};</script></body></html>';
  const server=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html);});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const pages=[]; let popup, browserSession, panelSession;
  const check=async(name,detail={})=>{result.checks.push({name,...detail});await passed('tab-control-'+name,detail);};
  async function state(id){return options.evaluate(id=>AT.sendMessage({type:AT.C.MSG.GET_STATE,tabId:id}),id);}
  async function translated(p){await p.waitForFunction(()=>/[가-힣]/u.test(document.querySelector('#text').textContent),null,{timeout:120000});}
  async function popupFor(id){
    popup ??= await context.newPage();await popup.goto(origin+'/popup.html?tabId='+id);
    await popup.waitForFunction(()=>!document.querySelector('#enabled').disabled && document.querySelector('#host').textContent.length>0);
  }
  try {
    await stage('explicit-tab-selection-native');
    const a=await context.newPage(),b=await context.newPage();pages.push(a,b);
    await a.goto('http://127.0.0.1:'+server.address().port+'/a');
    await b.goto('http://127.0.0.1:'+server.address().port+'/b');
    const aid=await pageTabId(options,a),bid=await pageTabId(options,b);
    const initial=(await host(options)).status.generations;
    for(const p of pages){await p.bringToFront();await p.reload();}
    await sleep(700);
    assert.equal((await state(aid)).tabEnabled,false);assert.equal((await state(bid)).tabEnabled,false);
    assert.equal((await host(options)).status.generations,initial);
    await check('new-tabs-and-activation-are-off',{extraGenerations:0});
    await popupFor(aid);assert.equal(await popup.locator('#enabled').isChecked(),false);
    await popup.locator('#enabled').check();await translated(a);
    assert.equal((await state(aid)).tabEnabled,true);
    assert.equal(await b.locator('#text').textContent(),'Your documents remain private.');
    assert.equal((await state(bid)).tabEnabled,false);
    await check('popup-enables-only-source-tab');
    await capture(a,'tab-control-a-translated');await capture(popup,'tab-control-popup-on');
    // A chosen tab remains a target even when reload happens in the background.
    await b.bringToFront();await a.reload();await translated(a);
    await check('selected-background-reload-retains-consent');
    await setTabThroughUI(options,bid,true);await translated(b);
    await popupFor(aid);assert.equal(await popup.locator('#enabled').isChecked(),true);
    await popup.locator('#enabled').uncheck();
    await a.waitForFunction(()=>document.querySelector('#text').textContent==='Your documents remain private.');
    assert.equal((await state(aid)).tabEnabled,false);assert.equal((await state(bid)).tabEnabled,true);
    assert.match(await b.locator('#text').textContent(),/[가-힣]/u);
    const quiet=(await host(options)).status.generations;
    await a.locator('#append').click();await a.reload();await a.bringToFront();await sleep(700);
    assert.equal((await host(options)).status.generations,quiet);
    await check('off-restores-one-tab-and-stays-off',{extraGenerations:0});
    // Restart the real service worker. No session/local storage values are patched.
    const swSession=await context.newCDPSession(options);let version;
    swSession.on('ServiceWorker.workerVersionUpdated',({versions})=>{for(const v of versions)if(v.scriptURL===origin+'/background.js')version=v;});
    await swSession.send('ServiceWorker.enable');
    for(let i=0;i<100&&version?.runningStatus!=='running';i++)await sleep(50);
    assert.equal(version?.runningStatus,'running');
    await swSession.send('ServiceWorker.stopWorker',{versionId:version.versionId});
    for(let i=0;i<100&&version?.runningStatus!=='stopped';i++)await sleep(50);
    assert.equal(version?.runningStatus,'stopped');
    assert.equal((await state(aid)).tabEnabled,false);assert.equal((await state(bid)).tabEnabled,true);
    await swSession.detach();await check('on-and-off-survive-real-worker-restart');
    await setTabThroughUI(options,bid,false);
    await b.waitForFunction(()=>document.querySelector('#text').textContent==='Your documents remain private.');
    // Open Options from the actual shipped popup click, not from an injected API.
    await popupFor(bid);await popup.locator('#options').click();await b.bringToFront();
    let contexts=[];
    for(let i=0;i<100;i++){
      contexts=await options.evaluate(()=>chrome.runtime.getContexts({contextTypes:['SIDE_PANEL']}));
      if(contexts.some(c=>c.documentUrl.endsWith('/options.html?tabId='+bid)))break;await sleep(100);
    }
    assert.ok(contexts.some(c=>c.documentUrl===origin+'/options.html?tabId='+bid),'the real side panel context must load the source-bound options');
    result.panelContexts=contexts.map(c=>({type:c.contextType,url:c.documentUrl}));
    // Read/operate the actual panel target through CDP; no product globals replaced.
    browserSession=await context.browser().newBrowserCDPSession();
    const targets=(await browserSession.send('Target.getTargets')).targetInfos;
    // Match the SIDE_PANEL context's documentId by target ordering is not portable.
    // Read all matching targets and select the one whose window width is panel-sized.
    let panel;
    for(const t of targets.filter(t=>t.url===origin+'/options.html?tabId='+bid)) {
      const attached=await browserSession.send('Target.attachToTarget',{targetId:t.targetId,flatten:false});
      const sessionId=attached.sessionId;let next=0;const pending=new Map();
      const listener=event=>{if(event.sessionId!==sessionId)return;const msg=JSON.parse(event.message);const p=pending.get(msg.id);if(p){pending.delete(msg.id);msg.error?p.reject(Error(msg.error.message)):p.resolve(msg.result);}};
      browserSession.on('Target.receivedMessageFromTarget',listener);
      const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;const timer=setTimeout(()=>{pending.delete(id);reject(Error('panel CDP timeout '+method));},15000);pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});browserSession.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id,method,params})}).catch(reject);});
      const inspect=await call('Runtime.evaluate',{expression:'({width:innerWidth,height:innerHeight,title:document.title,ready:!document.querySelector("#enabled")?.disabled,scroll:document.documentElement.scrollWidth})',returnByValue:true});
      const info=inspect.result?.value;
      if(info?.width>0&&info.width<850){panel={call,info,sessionId,listener};break;}
      browserSession.off('Target.receivedMessageFromTarget',listener);await browserSession.send('Target.detachFromTarget',{sessionId});
    }
    assert.ok(panel,'real docked panel target found');panelSession=panel;
    for(let i=0;i<100;i++){const v=await panel.call('Runtime.evaluate',{expression:'!document.querySelector("#enabled").disabled',returnByValue:true});if(v.result.value)break;await sleep(100);}
    const layout=await panel.call('Runtime.evaluate',{expression:'({width:innerWidth,scroll:document.documentElement.scrollWidth,title:document.title})',returnByValue:true});
    assert.match(layout.result.value.title,/Autotranslate/);assert.ok(layout.result.value.scroll<=layout.result.value.width+1,'panel has no horizontal overflow');
    const img=await panel.call('Page.captureScreenshot',{format:'png'});
    await writeFile(join(out,'tab-control-sidepanel.png'),Buffer.from(img.data,'base64'));
    const box=await panel.call('Runtime.evaluate',{expression:'(()=>{const r=document.querySelector("#enabled").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()',returnByValue:true});
    const {x,y}=box.result.value;
    await panel.call('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});
    await panel.call('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});
    await translated(b);assert.equal((await state(bid)).tabEnabled,true);assert.equal((await state(aid)).tabEnabled,false);
    await check('real-sidepanel-options-and-checkbox',{width:layout.result.value.width});
    await setTabThroughUI(options,bid,false);
    await b.waitForFunction(()=>document.querySelector('#text').textContent==='Your documents remain private.');
    await capture(b,'tab-control-restored');
    await a.close();
    for(let i=0;i<100;i++){const stored=await options.evaluate(id=>chrome.storage.session.get('tab-selection:'+id),aid);if(Object.keys(stored).length===0)break;await sleep(50);}
    assert.deepEqual(await options.evaluate(id=>chrome.storage.session.get('tab-selection:'+id),aid),{});
    await check('closed-tab-selection-cleaned');
    result.passed=true;await save();
  } catch(error){result.failure={message:error.message,stage:summary.stage};await save();throw error;}
  finally{
    if(panelSession&&browserSession)await browserSession.send('Target.detachFromTarget',{sessionId:panelSession.sessionId}).catch(()=>{});
    if(browserSession)await browserSession.detach().catch(()=>{});
    for(const p of [...pages,popup])if(p&&!p.isClosed())await p.close().catch(()=>{});
    server.closeAllConnections();await new Promise(r=>server.close(r));
  }
}

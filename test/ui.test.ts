import test from 'node:test';
import assert from 'node:assert/strict';
import { load, resetGlobals } from './helpers.ts';
function environment(kind: 'ok' | 'missing' | 'refuses' = 'ok') {
  resetGlobals();
  const calls: { panels: unknown[]; open: unknown[]; windows: unknown[]; tabs: unknown[] } = {panels:[],open:[],windows:[],tabs:[]};
  const host = globalThis as Record<string, any>;
  host.browser = {
    runtime:{getURL:(p:string)=>'chrome-extension://test/'+p},
    windows:{create:async(p:unknown)=>{calls.windows.push(p);return {id:12};}},
    tabs:{query:async()=>[{id:7,url:'https://example.com/'}],create:async(p:unknown)=>calls.tabs.push(p)},
    sidePanel:kind==='missing'?undefined:{setOptions:async(p:unknown)=>{calls.panels.push(p);},open:async(p:unknown)=>{calls.open.push(p);if(kind==='refuses')throw Error('no gesture');}}
  };
  return {AT:load('lib/constants.js','lib/browser.js','lib/ui.js'),calls};
}
test('supported options open in a panel bound to the source tab',async()=>{
 const {AT,calls}=environment();assert.equal(await AT.ui.openPage('options.html','auto',7),'panel');
 assert.deepEqual(calls.panels,[{path:'options.html?tabId=7',tabId:7,enabled:true}]);assert.deepEqual(calls.open,[{tabId:7}]);assert.deepEqual(calls.windows,[]);assert.deepEqual(calls.tabs,[]);
});
test('open is called synchronously before setOptions settles to preserve the gesture',async()=>{
 const {AT,calls}=environment();let release!:()=>void;
 AT.sidePanelApi.setOptions=()=>new Promise<void>(r=>{release=r;});
 const pending=AT.ui.openPage('options.html','auto',7);
 assert.deepEqual(calls.open,[{tabId:7}]);release();assert.equal(await pending,'panel');
});
for(const kind of ['missing','refuses'] as const)test(kind+' panel opens an actual popup window, never a tab',async()=>{
 const {AT,calls}=environment(kind);assert.equal(await AT.ui.openPage('options.html','auto',7),'window');
 assert.deepEqual(calls.windows,[{url:'chrome-extension://test/options.html?tabId=7',type:'popup',focused:true,width:560,height:800}]);assert.deepEqual(calls.tabs,[]);
});
test('onboarding without a web tab opens a new setup window',async()=>{
 const {AT,calls}=environment();AT.tabs.query=async()=>[];
 assert.equal(await AT.ui.openPage('welcome.html'),'window');assert.deepEqual(calls.open,[]);assert.equal((calls.windows[0] as any).url,'chrome-extension://test/welcome.html');
});
test('explicit window request skips a supported panel',async()=>{
 const {AT,calls}=environment();assert.equal(await AT.ui.openPage('options.html','window',7),'window');assert.deepEqual(calls.open,[]);
});
test('a known source tab never falls through to the active options window',async()=>{
 const {AT,calls}=environment('missing');AT.tabs.query=async()=>{throw Error('must not resolve another tab');};
 await AT.ui.openPage('options.html','auto',19);assert.match((calls.windows[0] as any).url,/tabId=19$/);
});
test('invalid UI paths fail instead of opening arbitrary content',async()=>{
 const {AT,calls}=environment();await assert.rejects(AT.ui.openPage('https://example.com/'),/unknown/);assert.deepEqual(calls.windows,[]);
});

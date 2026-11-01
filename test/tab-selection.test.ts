import test from 'node:test';
import assert from 'node:assert/strict';
import {load, resetGlobals, deferred, type ATNamespace} from './helpers.ts';
function setup(session: ATNamespace = {}) {
 resetGlobals(); const globals = globalThis as ATNamespace;
 globals.browser = {runtime:{getURL:(p:string)=>p},storage:{
   local:{get:async()=>({settings:{enabled:true,siteRules:[{pattern:'*',action:'always'}]}}),set:async()=>{throw Error('must not store consent globally');}},
   session:{get:async(key:string)=>({[key]:session[key]}),set:async(items:ATNamespace)=>{Object.assign(session,items);},remove:async(key:string)=>{delete session[key];}}
 }};
 const AT=load('lib/constants.js','lib/browser.js','lib/local.js','lib/rules.js','lib/settings.js');
 return {AT,session};
}
test('new tabs remain OFF regardless of legacy global ON and always rules',async()=>{
 const {AT}=setup();assert.deepEqual(await AT.tabSelection.get(7),{enabled:false,epoch:0});assert.equal((await AT.tabSelection.get(8)).enabled,false);
});
test('only the chosen tab is enabled and session state survives worker reload',async()=>{
 const {AT,session}=setup();await AT.tabSelection.set(7,true);assert.equal((await AT.tabSelection.get(8)).enabled,false);
 const next=setup(session).AT;assert.deepEqual(await next.tabSelection.get(7),{enabled:true,epoch:1});assert.equal((await next.tabSelection.get(8)).enabled,false);
});
test('OFF persists across worker reload and does not change the other selected tab',async()=>{
 const {AT,session}=setup();await AT.tabSelection.set(7,true);await AT.tabSelection.set(8,true);await AT.tabSelection.set(7,false);
 const next=setup(session).AT;assert.deepEqual(await next.tabSelection.get(7),{enabled:false,epoch:2});assert.equal((await next.tabSelection.get(8)).enabled,true);
});
test('closing a tab deletes its consent; a recycled id starts OFF',async()=>{
 const {AT,session}=setup();await AT.tabSelection.set(7,true);await AT.tabSelection.forget(7);assert.equal('tab-selection:7' in session,false);assert.equal((await AT.tabSelection.get(7)).enabled,false);
});
test('a new browser session does not restore consent from global preferences',async()=>{
 const {AT}=setup();await AT.tabSelection.set(7,true);const restart=setup().AT;assert.equal((await restart.tabSelection.get(7)).enabled,false);
});
test('rapid ON/OFF has increasing epochs and ordered writes',async()=>{
 const {AT,session}=setup();await AT.tabSelection.get(7);const stalled=deferred<void>();let first=true;
 AT.storage.session.set=async(items:ATNamespace)=>{if(first){first=false;await stalled.promise;}Object.assign(session,items);};
 const on=AT.tabSelection.set(7,true),off=AT.tabSelection.set(7,false);
 await new Promise(r=>setImmediate(r));assert.deepEqual(await AT.tabSelection.get(7),{enabled:false,epoch:2});
 stalled.resolve();await Promise.all([on,off]);assert.deepEqual(session['tab-selection:7'],{enabled:false,epoch:2});
});
test('a failed storage write cannot authorize inference',async()=>{
 const {AT}=setup();AT.storage.session.set=async()=>{throw Error('write denied');};await assert.rejects(AT.tabSelection.set(7,true),/denied/);assert.equal((await AT.tabSelection.get(7)).enabled,false);
});
test('invalid IDs fail closed without reading arbitrary keys',async()=>{
 const {AT}=setup();for(const id of [-1,NaN,Infinity,1.5])await assert.rejects(AT.tabSelection.get(id),/invalid tab/);
});
test('without session storage consent is memory-only, never persisted locally',async()=>{
 const {AT}=setup();AT.storage.session=undefined;await AT.tabSelection.set(7,true);assert.equal((await AT.tabSelection.get(7)).enabled,true);
 const next=setup().AT;next.storage.session=undefined;assert.equal((await next.tabSelection.get(7)).enabled,false);
});

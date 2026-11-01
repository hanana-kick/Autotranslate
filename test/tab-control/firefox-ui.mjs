// Original packaged Firefox extension, operated with Mozilla WebDriver.
// No inference replacement, extension API patch, model conversion or browser profile export.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, join, relative } from 'node:path';
import { createHash } from 'node:crypto';

const out = resolve('test-results/firefox-tab-ui'); await mkdir(out, { recursive: true });
const token = process.env.HF_TOKEN || '';
const clean = s => token ? String(s).split(token).join('[REDACTED]') : String(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const summary = { commit: execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(), driver:'geckodriver 0.37.1', scope:'UI and native browser APIs only; model inference NOT exercised', inferenceDouble:false, passed:false, checks:[], stage:'start-driver' };
const save = () => writeFile(join(out,'summary.json'),clean(JSON.stringify(summary,null,2)));
async function step(name, detail={}) { summary.stage=name; summary.checks.push({name,...detail}); console.log(clean(JSON.stringify({stage:name,...detail}))); await save(); }
async function inventory(dir) { const files={}; async function walk(p) { for(const e of await readdir(p,{withFileTypes:true})) { const f=join(p,e.name);if(e.isDirectory())await walk(f);else files[relative(dir,f)]=createHash('sha256').update(await readFile(f)).digest('hex'); } } await walk(dir);return files; }
const before = await inventory('build/firefox');
assert.equal(before['vendor/mediapipe/genai_bundle.js'],createHash('sha256').update(await readFile('node_modules/@mediapipe/tasks-genai/genai_bundle.mjs')).digest('hex'));
// The tested popup windows are Firefox UI contexts. This documented WebDriver
// permission is confined to the ephemeral localhost-only CI browser, never a user profile.
const driver = spawn(process.env.GECKODRIVER || 'geckodriver',['--port','4444','--host','127.0.0.1','--allow-system-access','--log','error'],{stdio:['ignore','pipe','pipe']});
let driverLog='';for(const stream of [driver.stdout,driver.stderr])stream.on('data',b=>{driverLog+=clean(b).slice(0,4000);});
let session, server, rootWindow;
async function api(method,path,data,timeout=45000) { summary.operation = method + ' ' + path; await save(); const r=await fetch('http://127.0.0.1:4444'+path,{method,headers:{'Content-Type':'application/json'},...(data===undefined?{}:{body:JSON.stringify(data)}),signal:AbortSignal.timeout(timeout)}).catch(error=>{throw Error(clean(method+' '+path+': '+error.message));});const result=await r.json();if(!r.ok||result.value?.error)throw Error(clean(method+' '+path+': '+(result.value?.message || r.status)));return result.value; }
const command=(method,path,data,timeout)=>api(method,'/session/'+session+path,data,timeout);
const js=(script,...args)=>command('POST','/execute/sync',{script,args});
const use=handle=>command('POST','/window',{handle});
const navigate=url=>command('POST','/url',{url});
async function element(selector) { const e=await command('POST','/element',{using:'css selector',value:selector});return e['element-6066-11e4-a52e-4f735466cecf']; }
async function click(selector) { return command('POST','/element/'+await element(selector)+'/click',{}); }
async function fill(selector,text) { const id=await element(selector);await command('POST','/element/'+id+'/clear',{});await command('POST','/element/'+id+'/value',{text}); }
async function wait(fn,label,ms=30000) { const end=Date.now()+ms;let last;while(Date.now()<end){last=await fn();if(last)return last;await sleep(250);}throw Error(label+' timed out'); }
async function snapshot(name) { const png=await command('GET','/screenshot');await writeFile(join(out,name+'.png'),Buffer.from(png,'base64'));await writeFile(join(out,name+'.html'),clean(await js('return document.documentElement.outerHTML'))); }
// A popup options window is not a tab strip. Create fixture tabs in the original
// normal browser window, then continue operating the actual popup separately.
async function newTab(url) { await use(rootWindow); const {handle}=await command('POST','/window/new',{type:'tab'});await use(handle);await navigate(url);return handle; }
try {
  assert.ok(process.env.FIREFOX_BINARY,'official Firefox binary is required');
  await wait(async()=>{try{return await api('GET','/status');}catch{return false;}},'driver startup');
  const opened=await api('POST','/session',{capabilities:{alwaysMatch:{browserName:'firefox',pageLoadStrategy:'eager','moz:firefoxOptions':{binary:process.env.FIREFOX_BINARY}}}},90000);
  session=opened.sessionId;summary.browser=opened.capabilities.browserVersion;
  rootWindow = await command('GET','/window');
  await command('POST','/timeouts',{script:15000,pageLoad:30000,implicit:0});
  await command('POST','/window/rect',{width:1200,height:850});
  const version=JSON.parse(await readFile('package.json','utf8')).version;
  summary.addonId=await command('POST','/moz/addon/install',{path:resolve('dist/autotranslate-'+version+'-firefox.zip'),temporary:true},60000);
  let welcome,origin;
  await wait(async()=>{for(const h of await command('GET','/window/handles')){await use(h);const url=await command('GET','/url');if(/^moz-extension:\/\/[^/]+\/welcome.html/.test(url)){welcome=h;origin=url.split('/').slice(0,3).join('/');return true;}}return false;},'automatic onboarding window');
  await wait(()=>js('return !!window.AT?.ui'),'shipped UI');
  assert.equal(await js('return AT.supportsSidePanel()'),false,'test actual unsupported browser, not a patched API');
  await step('actual-firefox-no-sidepanel');
  const html='<!doctype html><html lang="en"><head><title translate="no">Tab control fixture</title></head><body><p>Original text.</p></body></html>';
  server=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url='http://127.0.0.1:'+server.address().port;
  const a=await newTab(url+'/a'),b=await newTab(url+'/b');
  await use(welcome);
  const aid=await js('return browser.tabs.query({}).then(ts=>ts.find(t=>t.url===arguments[0]).id)',url+'/a');
  const bid=await js('return browser.tabs.query({}).then(ts=>ts.find(t=>t.url===arguments[0]).id)',url+'/b');
  const popup=await newTab(origin+'/popup.html?tabId='+aid);
  await wait(()=>js('return !document.querySelector("#enabled").disabled && document.querySelector("#host").textContent.length>0'),'popup source state');
  assert.equal(await js('return document.querySelector("#enabled").checked'),false);
  const previous=await js('return browser.windows.getAll().then(ws=>ws.map(w=>w.id))');
  await click('#options');
  let options;
  await wait(async()=>{for(const h of await command('GET','/window/handles')){await use(h);if((await command('GET','/url'))===origin+'/options.html?tabId='+aid){options=h;return true;}}return false;},'real separate options window');
  await wait(()=>js('return !document.querySelector("#enabled")?.disabled && document.querySelector("#tabHost")?.textContent.length>0'),'bound options hydrated');
  const win=await js('return browser.windows.getCurrent()');assert.equal(win.type,'popup');assert.ok(!previous.includes(win.id));
  summary.window={id:win.id,type:win.type,width:win.width,height:win.height};
  assert.ok(await js('return document.documentElement.scrollWidth <= innerWidth+1'));
  await snapshot('01-firefox-options-window');await step('options-opens-real-window-not-tab',summary.window);
  await click('#enabled');
  await wait(()=>js('return AT.sendMessage({type:AT.C.MSG.GET_STATE,tabId:arguments[0]}).then(s=>s.tabEnabled)',aid),'source selection ON');
  assert.equal((await js('return AT.sendMessage({type:AT.C.MSG.GET_STATE,tabId:arguments[0]})',bid)).tabEnabled,false);
  await step('window-controls-bound-source-not-own-window');
  await click('#enabled');await wait(()=>js('return AT.sendMessage({type:AT.C.MSG.GET_STATE,tabId:arguments[0]}).then(s=>!s.tabEnabled)',aid),'source selection OFF');
  await navigate(origin+'/options.html?tabId='+aid);await wait(()=>js('return !document.querySelector("#enabled")?.disabled'),'options rehydrated');
  assert.equal(await js('return document.querySelector("#enabled").checked'),false);
  await snapshot('02-firefox-tab-off');await step('off-state-rendered-after-options-reload');
  // No model was installed. This validates browser window routing and consent,
  // not Firefox model support (tracked separately in issue #2).
  summary.passed=true;
} catch(error) {summary.failure={stage:summary.stage,message:clean(error.message)};console.error(JSON.stringify(summary.failure));process.exitCode=1;
  if(session)await snapshot('FAIL-current-page').catch(()=>{});
} finally {
  summary.installedFilesUnchanged=JSON.stringify(before)===JSON.stringify(await inventory('build/firefox'));
  if(!summary.installedFilesUnchanged){summary.passed=false;process.exitCode=1;}
  await save();await writeFile(join(out,'driver-error.log'),clean(driverLog));
  if(session)await api('DELETE','/session/'+session,undefined,10000).catch(()=>{});
  driver.kill('SIGTERM');if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
  console.log(JSON.stringify({passed:summary.passed,scope:summary.scope}));process.exit(process.exitCode||(summary.passed?0:1));
}

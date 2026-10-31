// Original packaged Firefox extension, operated with Mozilla WebDriver.
// No inference replacement, extension API patch, model conversion or browser profile export.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { firefox } from 'playwright';
const out = resolve('test-results/firefox-webdriver'); await mkdir(out, { recursive: true });
const token = process.env.HF_TOKEN || '';
const clean = s => token ? String(s).split(token).join('[REDACTED]') : String(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const summary = { commit: execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(), driver:'geckodriver 0.37.1', model:'translategemma-4b-it-int8-web.task', inferenceDouble:false, passed:false, checks:[], stage:'start-driver' };
const save = () => writeFile(join(out,'summary.json'),clean(JSON.stringify(summary,null,2)));
async function step(name, detail={}) { summary.stage=name; summary.checks.push({name,...detail}); console.log(clean(JSON.stringify({stage:name,...detail}))); await save(); }
async function inventory(dir) { const files={}; async function walk(p) { for(const e of await readdir(p,{withFileTypes:true})) { const f=join(p,e.name);if(e.isDirectory())await walk(f);else files[relative(dir,f)]=createHash('sha256').update(await readFile(f)).digest('hex'); } } await walk(dir);return files; }
const before = await inventory('build/firefox');
assert.equal(before['vendor/mediapipe/genai_bundle.js'],createHash('sha256').update(await readFile('node_modules/@mediapipe/tasks-genai/genai_bundle.mjs')).digest('hex'));
const driver = spawn(process.env.GECKODRIVER || 'geckodriver',['--port','4444','--log','error'],{stdio:['ignore','pipe','pipe']});
let driverLog='';for(const stream of [driver.stdout,driver.stderr])stream.on('data',b=>{driverLog+=clean(b).slice(0,4000);});
let session, server;
async function api(method,path,data,timeout=45000) { const r=await fetch('http://127.0.0.1:4444'+path,{method,headers:{'Content-Type':'application/json'},...(data===undefined?{}:{body:JSON.stringify(data)}),signal:AbortSignal.timeout(timeout)});const result=await r.json();if(!r.ok||result.value?.error)throw Error(clean(result.value?.message || path+' '+r.status));return result.value; }
const command=(method,path,data,timeout)=>api(method,'/session/'+session+path,data,timeout);
const js=(script,...args)=>command('POST','/execute/sync',{script,args});
const use=handle=>command('POST','/window',{handle});
const navigate=url=>command('POST','/url',{url});
async function element(selector) { const e=await command('POST','/element',{using:'css selector',value:selector});return e['element-6066-11e4-a52e-4f735466cecf']; }
async function click(selector) { return command('POST','/element/'+await element(selector)+'/click',{}); }
async function fill(selector,text) { const id=await element(selector);await command('POST','/element/'+id+'/clear',{});await command('POST','/element/'+id+'/value',{text}); }
async function wait(fn,label,ms=30000) { const end=Date.now()+ms;let last;while(Date.now()<end){last=await fn();if(last)return last;await sleep(250);}throw Error(label+' timed out'); }
async function snapshot(name) { const png=await command('GET','/screenshot');await writeFile(join(out,name+'.png'),Buffer.from(png,'base64'));await writeFile(join(out,name+'.html'),clean(await js('return document.documentElement.outerHTML'))); }
async function newTab(url) { const {handle}=await command('POST','/window/new',{type:'tab'});await use(handle);await navigate(url);return handle; }
try {
  await wait(async()=>{try{return await api('GET','/status');}catch{return false;}},'driver startup');
  const opened=await api('POST','/session',{capabilities:{alwaysMatch:{browserName:'firefox',pageLoadStrategy:'eager','moz:firefoxOptions':{binary:firefox.executablePath(),prefs:{'dom.webgpu.enabled':true}}}}},90000);
  session=opened.sessionId;summary.browser=opened.capabilities.browserVersion;
  await command('POST','/timeouts',{script:15000,pageLoad:30000,implicit:0});
  await command('POST','/window/rect',{width:1200,height:850});
  const version=JSON.parse(await readFile('package.json','utf8')).version;
  summary.addonId=await command('POST','/moz/addon/install',{path:resolve('dist/autotranslate-'+version+'-firefox.zip'),temporary:true},60000);
  await step('installed-original-addon',{addonId:summary.addonId,browser:summary.browser});
  let welcome,origin;
  await wait(async()=>{for(const h of await command('GET','/window/handles')){await use(h);const url=await command('GET','/url');if(/^moz-extension:\/\/[^/]+\/welcome.html/.test(url)){welcome=h;origin=url.split('/').slice(0,3).join('/');return true;}}return false;},'automatic onboarding');
  await wait(()=>js('return document.querySelector("#targetLang")?.options.length>1 && document.querySelector("#status")?.textContent.length>0'),'onboarding controls');
  summary.adapter=await js('return navigator.gpu.requestAdapter().then(a=>a?{vendor:a.info?.vendor,architecture:a.info?.architecture,features:[...a.features]}:null)');
  assert.ok(summary.adapter,'Firefox must expose a genuine WebGPU adapter');
  await click('#targetLang option[value="ko"]');await snapshot('01-onboarding');await step('onboarding-and-adapter',{adapter:summary.adapter});
  if(token)await fill('#modelToken',token);await click('#download');
  const begin=Date.now();
  await wait(async()=>{const ui=await js('return {ready:!document.querySelector("#start").disabled,kind:document.querySelector("#status").dataset.kind,status:document.querySelector("#status").textContent}');summary.lastUI=ui;await save();if(ui.kind==='error')throw Error(ui.status);return ui.ready;},'original model preparation',20*60000);
  await fill('#modelToken','');await snapshot('02-model-ready');await step('original-model-ready',{elapsedMs:Date.now()-begin});
  const options=await newTab(origin+'/options.html');
  await wait(()=>js('return document.querySelector("#localModel")?.value && document.querySelector("#targetLang")?.value==="ko"'),'options settings');
  await click('#sourceLang option[value="en"]');await click('#save');await wait(()=>js('return document.querySelector("#saveStatus").dataset.kind==="ok"'),'source saved');
  const html='<!doctype html><html lang="en"><head><meta charset="utf-8"><title translate="no">Firefox native DOM</title></head><body><main><h1 data-qa>Learn to draw a tree.</h1><p id="source" data-qa>Keep practicing every day.</p></main><div translate="no"><button id="change">Update</button><button id="event">Event</button><input value="private draft" id="draft"></div><script>window.sources=new Map([...document.querySelectorAll("[data-qa]")].map(e=>[e.firstChild,e.textContent]));window.clicks=0;document.querySelector("#event").onclick=()=>window.clicks++;document.querySelector("#change").onclick=()=>{let e=document.querySelector("#source");e.firstChild.nodeValue="New videos arrive every Friday.";sources.set(e.firstChild,e.textContent);let p=document.createElement("p");p.dataset.qa="";p.id="late";p.textContent="This lesson is very helpful.";document.querySelector("main").append(p);sources.set(p.firstChild,p.textContent);};</script></body></html>';
  server=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const page=await newTab('http://127.0.0.1:'+server.address().port+'/');await snapshot('03-before');
  await use(welcome);await click('#start');await use(page);
  const check=()=>js('return [...document.querySelectorAll("[data-qa]")].every(e=>/[가-힣]/u.test(e.textContent)&&!/<pad>/.test(e.textContent))');
  await wait(check,'initial native page translation',120000);await snapshot('04-translated');await step('initial-translation');
  await click('#change');await wait(check,'dynamic native page translation',120000);await snapshot('05-dynamic-translated');await step('dynamic-insertion-and-node-edit');
  await js('window.elements=[...document.body.querySelectorAll("*")];window.attrs=elements.map(e=>JSON.stringify([...e.attributes].map(a=>[a.name,a.value])));return true');
  await use(options);await navigate(origin+'/options.html');await wait(()=>js('return document.querySelector("#enabled")?.checked && document.querySelector("#localModel")?.value'),'enabled options');
  summary.host=await js('return AT.sendMessage({type:"at/local-get-status"})');assert.ok(summary.host.status.generations>=3);
  await click('#enabled');await click('#save');await wait(()=>js('return document.querySelector("#saveStatus").dataset.kind==="ok"'),'disabled saved');await use(page);
  await wait(()=>js('return [...sources].every(([node,text])=>!node.isConnected||node.nodeValue===text)'),'latest-source restoration');
  summary.restoration=await js('return {elements:elements.every((e,i)=>e===document.body.querySelectorAll("*")[i]),attributes:elements.every((e,i)=>JSON.stringify([...e.attributes].map(a=>[a.name,a.value]))===attrs[i]),text:[...sources].every(([n,t])=>n.nodeValue===t),input:document.querySelector("#draft").value==="private draft"}');
  assert.ok(Object.values(summary.restoration).every(Boolean));await click('#event');assert.equal(await js('return window.clicks'),1);await snapshot('06-restored');
  await step('latest-source-restored-and-events-preserved',summary.restoration);summary.passed=true;
} catch(error) {summary.failure={stage:summary.stage,message:clean(error.message)};console.error(JSON.stringify(summary.failure));process.exitCode=1;}
finally {
  summary.installedFilesUnchanged=JSON.stringify(before)===JSON.stringify(await inventory('build/firefox'));
  if(!summary.installedFilesUnchanged){summary.passed=false;process.exitCode=1;}
  await save();await writeFile(join(out,'driver-error.log'),clean(driverLog));
  if(session)await api('DELETE','/session/'+session,undefined,10000).catch(()=>{});
  driver.kill('SIGTERM');if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
  console.log(JSON.stringify({passed:summary.passed,stage:summary.stage}));process.exit(process.exitCode||(summary.passed?0:1));
}

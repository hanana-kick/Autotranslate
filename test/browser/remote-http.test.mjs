// Real installed Chrome extension / real HTTP / zero model- or GPU-substitution.
// A deterministic OpenAI-compatible HTTP server stands in for a configured
// user's vLLM host. This tests the browser-to-server protocol, NOT TranslateGemma
// linguistic quality or actual vLLM throughput.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, launchOptions, ROOT } from './support.mjs';

const serverRequests=[];
let activeRequests=0;
let peakRequests=0; let responseDelay=140;
const enToKo=new Map([
  ['Hello from the video.', '영상에서 안녕하세요.'],
  ['New comments appear.', '새 댓글이 표시됩니다.'],
  ['Changed after loading.', '로드 후 변경됨.'],
  ['Another video title.', '또 다른 동영상 제목.'],
  ['First different sentence.', '첫 번째 다른 문장.'],
  ['Second different sentence.', '두 번째 다른 문장.'],
  ['Third different sentence.', '세 번째 다른 문장.'],
  ['Fourth different sentence.', '네 번째 다른 문장.'],
  ['The extension is configured correctly.', '확장 프로그램이 올바르게 설정되었습니다.']
]);
let context, server, temp, origin, control;
const errors=[];
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function getId(page){
  const tab=await control.evaluate(async url=>(await AT.api.tabs.query({})).find(x=>x?.url===url),page.url());
  assert.ok(Number.isSafeInteger(tab?.id),`tab not found: ${page.url()}`);
  return tab.id;
}
async function opt(page,value){
  const reply=await control.evaluate(async ([id,enabled])=>AT.sendMessage({type:AT.C.MSG.SET_TAB_ENABLED,tabId:id,enabled}),[await getId(page),value]);
  assert.equal(reply.ok,true,JSON.stringify(reply));
}
async function waitText(page,selector,text){
  await page.waitForFunction(([s,expected])=>document.querySelector(s)?.textContent===expected,[selector,text],{timeout:20000});
}

test('OpenAI-compatible server integrates into original extension, and only opted-in tabs translate and restore',
  {timeout:120000}, async()=>{
    temp=await mkdtemp(join(tmpdir(),'autotranslate-remote-http-'));
    server=createServer(async(request,response)=>{
      const cors={'Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin':'*', 'Cache-Control':'no-store'};
      if(request.method==='OPTIONS'){response.writeHead(204,{...cors,'Access-Control-Allow-Headers':'authorization,content-type'});response.end();return;}
      let body={};
      if(request.method==='POST'){
        let data='';for await(const chunk of request)data+=chunk;
        try{body=JSON.parse(data);}catch{response.writeHead(400,cors);response.end('{}');return;}
      }
      const meta={path:request.url,method:request.method,authorization:request.headers.authorization??'',body};
      serverRequests.push(meta);
      if(request.url==='/v1/models'){
        response.writeHead(200,cors);
        response.end(JSON.stringify({object:'list',data:[{id:'test-translation-model',max_model_len:8192,max_num_seqs:999}]}));
      }else if(request.url==='/server_info?config_format=json'){
        response.writeHead(200,cors);
        response.end(JSON.stringify({vllm_config:{scheduler_config:{max_num_seqs:8,max_num_active_seqs:4}},system_env:{PASSWORD:'private, must not render'}}));
      }else if(request.url==='/v1/chat/completions'){
        if(meta.authorization!=='Bearer remote-fixture-secret'){
          response.writeHead(401,cors);response.end(JSON.stringify({error:'credential rejected'}));return;
        }
        const msg=body.messages?.[0]?.content;
        const text=typeof msg==='string'?msg.split('<<<text>>>').at(-1):msg?.[0]?.text;
        activeRequests++;peakRequests=Math.max(peakRequests,activeRequests);
        await delay(responseDelay);activeRequests--;
        const translated=enToKo.get(text);
        response.writeHead(translated?200:422,cors);
        response.end(translated?JSON.stringify({id:'chatcmpl-fixture',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:translated}}]}):'{}');
      }else{
        response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
        response.end(request.url.startsWith('/parallel')
          ? '<!doctype html><html lang="en"><head><title translate="no">Parallel remote test</title></head><body><main><p>First different sentence.</p><p>Second different sentence.</p><p>Third different sentence.</p><p>Fourth different sentence.</p></main></body></html>'
          : '<!doctype html><html lang="en"><head><title translate="no">Remote mode fixture</title></head><body><main><p id="title">Hello from the video.</p><section id="feed"></section></main></body></html>');
      }
    });
    try{
      await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
      origin='http://127.0.0.1:'+server.address().port;
      const args=[...launchOptions.args,`--disable-extensions-except=${join(ROOT,'build/chrome')}`,`--load-extension=${join(ROOT,'build/chrome')}`];
      context=await chromium.launchPersistentContext(join(temp,'profile'),{
        ...launchOptions, ignoreDefaultArgs:['--disable-extensions'], args,
        viewport:{width:1100,height:790}, locale:'en-US'
      });
      context.on('page',p=>p.on('pageerror',error=>errors.push({url:p.url(),message:error.message})));
      const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker',{timeout:15000});
      const extensionId=worker.url().split('/')[2];assert.ok(extensionId);
      control=await context.newPage();
      await control.goto(`chrome-extension://${extensionId}/options.html`);
      await control.waitForFunction(()=>document.body.dataset.ready==='true',null,{timeout:20000});
      assert.equal(await control.locator('#remoteSection').isVisible(), false);
      assert.equal(await control.locator('#remoteConcurrency').isDisabled(), true);
      await control.locator('#engineMode').selectOption('remote');
      assert.equal(await control.locator('#remoteConcurrency').isVisible(), true);
      assert.equal(await control.locator('#remoteConcurrency').isDisabled(), false);
      await control.locator('#remoteBaseUrl').fill(origin+'/v1');
      await control.locator('#remoteKey').fill('remote-fixture-secret');
      await control.locator('#remoteModel').fill('test-translation-model');
      await control.locator('#sourceLang').selectOption('en');
      await control.locator('#targetLang').selectOption('ko');
      await control.locator('#remotePromptStyle').selectOption('delimiters');
      await control.locator('#remoteConcurrency').fill('3');
      await control.locator('#save').click();
      await control.waitForFunction(()=>document.querySelector('#saveStatus').dataset.kind==='ok',{timeout:10000});
      const settings=await control.evaluate(()=>AT.settings.load());
      assert.equal(settings.engineMode,'remote');assert.equal(settings.localModelId,'');
      assert.equal(JSON.stringify(settings).includes('remote-fixture-secret'),false);
      const key=await control.evaluate(()=>AT.remote.getKey());assert.equal(key,'remote-fixture-secret');
      await control.locator('#remoteDiscover').click();
      await control.waitForFunction(()=>document.querySelector('#remoteStatus')?.textContent.includes('max_num_seqs: 8'),{timeout:10000});
      const info=await control.locator('#remoteStatus').textContent();
      assert.match(info,/max_num_active_seqs: 4/);
      assert.doesNotMatch(info,/private, must not render/);
      assert.equal(await control.locator('#remoteConcurrency').inputValue(), '3', 'server metadata never overwrites manual limit');
      const pageA=await context.newPage();await pageA.goto(origin+'/feed-a');
      const pageB=await context.newPage();await pageB.goto(origin+'/feed-b');
      await pageA.bringToFront();await pageB.bringToFront();
      await delay(400);
      assert.equal(await pageA.locator('#title').textContent(),'Hello from the video.');
      assert.equal(await pageB.locator('#title').textContent(),'Hello from the video.');
      assert.equal(serverRequests.filter(x=>x.path==='/v1/chat/completions').length,0,'no inference without tab opt-in');
      await opt(pageA,true);
      await waitText(pageA,'#title','영상에서 안녕하세요.');
      assert.equal(await pageB.locator('#title').textContent(),'Hello from the video.');
      const req=serverRequests.filter(x=>x.path==='/v1/chat/completions');
      assert.equal(req[0]?.body.model,'test-translation-model');
      assert.equal(req[0]?.authorization,'Bearer remote-fixture-secret');
      assert.equal(req[0]?.body.messages?.[0]?.content,'<<<source>>>en<<<target>>>ko<<<text>>>Hello from the video.');
      await pageA.evaluate(()=>{const p=document.createElement('p');p.id='comment';p.textContent='New comments appear.';document.querySelector('#feed').append(p);});
      await waitText(pageA,'#comment','새 댓글이 표시됩니다.');
      await pageA.evaluate(()=>document.querySelector('#title').firstChild.nodeValue='Changed after loading.');
      await waitText(pageA,'#title','로드 후 변경됨.');
      await pageA.reload();await pageA.bringToFront();
      await waitText(pageA,'#title','영상에서 안녕하세요.');
      await opt(pageB,true);await waitText(pageB,'#title','영상에서 안녕하세요.');
      await opt(pageA,false);await waitText(pageA,'#title','Hello from the video.');
      assert.equal(await pageB.locator('#title').textContent(),'영상에서 안녕하세요.');
      await pageA.reload();await delay(300);assert.equal(await pageA.locator('#title').textContent(),'Hello from the video.');
      await opt(pageB,false);await waitText(pageB,'#title','Hello from the video.');
      const parallel=await context.newPage();await parallel.goto(origin+'/parallel');
      const parallel2=await context.newPage();await parallel2.goto(origin+'/parallel?second=1');
      const beforeParallel=serverRequests.filter(r=>r.path==='/v1/chat/completions').length;
      peakRequests=0;
      await Promise.all([opt(parallel,true),opt(parallel2,true)]);
      await parallel.waitForFunction(()=>[...document.querySelectorAll('main p')].every(e=>/[가-힣]/u.test(e.textContent)),null,{timeout:20000});
      await parallel2.waitForFunction(()=>[...document.querySelectorAll('main p')].every(e=>/[가-힣]/u.test(e.textContent)),null,{timeout:20000});
      assert.equal(peakRequests,3,'the manual total limit must be reached but NEVER multiplied by two tabs or nested batches');
      assert.equal(serverRequests.filter(r=>r.path==='/v1/chat/completions').length-beforeParallel,8);
      const peakAcrossTabs=peakRequests;
      await Promise.all([opt(parallel,false), opt(parallel2,false)]);
      await control.reload();
      await control.waitForFunction(()=>document.body.dataset.ready==='true');
      assert.equal(await control.locator('#remoteConcurrency').inputValue(), '3');
      await control.locator('#remoteConcurrency').fill('1');
      await control.locator('#save').click();
      await control.waitForFunction(()=>document.querySelector('#saveStatus').dataset.kind==='ok');
      const serial=await context.newPage(); await serial.goto(origin+'/parallel?serial=1');
      peakRequests=0;
      await opt(serial,true);
      await serial.waitForFunction(()=>[...document.querySelectorAll('main p')].every(e=>/[가-힣]/u.test(e.textContent)),null,{timeout:20000});
      assert.equal(peakRequests,1,'manual 1 must really serialize independent text nodes');
      await opt(serial,false);
      const cancelPage=await context.newPage();await cancelPage.goto(origin+'/parallel?cancel=1');
      const beforeCancel=serverRequests.filter(r=>r.path==='/v1/chat/completions').length;
      responseDelay=1000;
      await opt(cancelPage,true);
      for(let i=0;i<100 && serverRequests.filter(r=>r.path==='/v1/chat/completions').length===beforeCancel;i++)await delay(10);
      assert.equal(serverRequests.filter(r=>r.path==='/v1/chat/completions').length,beforeCancel+1,'observe one real in-flight HTTP request');
      await opt(cancelPage,false);
      await delay(1200);
      assert.equal(serverRequests.filter(r=>r.path==='/v1/chat/completions').length,beforeCancel+1,'OFF must not dispatch pending nodes');
      assert.equal(await cancelPage.locator('main p').first().textContent(),'First different sentence.','late HTTP result must never overwrite restored DOM');
      responseDelay=140;
      await mkdir('test-results/remote-http',{recursive:true});
      await control.screenshot({path:'test-results/remote-http/options-remote.png',fullPage:true});
      await control.locator('#engineMode').selectOption('local');
      assert.equal(await control.locator('#remoteConcurrency').isVisible(),false);
      assert.equal(await control.locator('#remoteConcurrency').isDisabled(),true);
      await control.locator('#engineMode').selectOption('remote');
      assert.equal(await control.locator('#remoteConcurrency').inputValue(),'1');
      await parallel.waitForFunction(()=>document.querySelector('main').textContent.includes('First different sentence.'));
      const after=await control.evaluate(()=>AT.settings.load());
      assert.equal(after.engineMode,'remote');
      assert.deepEqual(errors,[]);
      await mkdir('test-results/remote-http',{recursive:true});
      await writeFile('test-results/remote-http/evidence.json',JSON.stringify({passed:true,actualExtension:true,server:'deterministic local HTTP OpenAI fixture, not real vLLM',tabConsent:true,dynamicDom:true,latestSourceRestore:true,independentTabs:true,concurrentDomRequests:peakRequests,peakAcrossTwoTabs:peakAcrossTabs,manualOneSerial:true,offCancelsPending:true,modelLoadingNotRequired:true,serverInfo:{maxNumSeqs:8,maxNumActiveSeqs:4},requestCount:serverRequests.length,errorCount:errors.length},null,2));
      console.log('REMOTE EXTENSION HTTP E2E PASSED');
    }finally{if(context)await context.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}if(temp)await rm(temp,{recursive:true,force:true});}
  });

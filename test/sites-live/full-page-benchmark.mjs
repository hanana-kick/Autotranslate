// Actual installed extension; complete fixed pages, not viewport-only previews.
// FULL_PAGE_BENCH=1 FULL_PAGE_ROUNDS=1 TRANSLATION_CONCURRENCY=2|4|8
// FULL_PAGE_LABEL=baseline|candidate
// MODEL_DIR=weight/plamo-3-translate-0.8b-onnx UNSAFE_WEBGPU=0
// Uses production ONNX q4f16 installation/toggle paths and real local GPU inference.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CORPUS } from './chunk-benchmark.mjs';
import { prepareTabEnabledUI, clickPreparedTabEnabledUI, setTabEnabledUI, tabIdFor } from '../native-extension/tab-control.mjs';

const jp = id => CORPUS.find(unit => unit.id === id).text;
const article = jp('japanese-article');
const tail = jp('extended-japanese').slice(article.length);
const split = tail.indexOf('。', Math.floor(tail.length / 2)) + 1;
const SCENARIOS = [
  { id: 'short-page', language: 'ja', texts: [
    '最初は説明が速すぎると思いましたが、自分のパソコンで試してみると意味が分かりました。再起動した後も同じ結果になるか確認することが大切ですね。',
    '図書館の電子書籍は十四日間借りることができます。期限を過ぎると自動的に返却されますが、紙の本を廃止する計画はありません。',
    'この映像は去年の夏に撮影されたものです。新しい機材を購入したわけではなく、照明の位置を変えることで見やすくなりました。',
    '申し込みは電話と窓口で受け付けています。電子メールを使えない人も参加できるので、家族や友人にも知らせてください。',
    '画面に表示される順番で翻訳してほしいです。下のコメントより先に、今読んでいる段落が最後まで翻訳されると助かります。',
    '操作方法が分からない場合は、毎週土曜日の無料説明会に参加できます。新しい端末を買う必要はなく、手持ちの機器を持参してください。',
    '最初の一回だけ時間がかかる理由を丁寧に説明してくれてありがとうございます。モデルの読み込み時間と翻訳時間は分けて比較するべきですね。',
    '個人の読書履歴を広告会社に提供することはありません。利用状況は半年間調べますが、人数だけで事業の成功を判断しない方針です。'
  ] },
  { id: 'article-page', language: 'ja', texts: [jp('japanese-comment'), article, tail.slice(0, split), tail.slice(split)] },
  { id: 'english-page', language: 'en', texts: CORPUS.filter(unit => ['short-comment', 'context-comment', 'long-comment', 'technical-paragraph'].includes(unit.id)).map(unit => unit.text) }
];
const CSS = 'html{overflow-anchor:none}body{margin:24px;font:19px/1.5 system-ui}main{max-width:920px;margin:auto}p{min-height:320px;margin:0 0 24px}';
const digest = data => createHash('sha256').update(data).digest('hex');
const median = values => { const s = [...values].sort((a,b) => a-b); return s.length ? (s[Math.floor((s.length-1)/2)]+s[Math.floor(s.length/2)])/2 : null; };
const errorText = error => String(error?.stack || error);
const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function observeFullPage() {
  const now = () => performance.timeOrigin + performance.now();
  const targets = [...document.querySelectorAll('main p')].map(p => ({ id:p.id, source:p.textContent,
    originalNode:p.firstChild, firstPreviewAt:null, completedAt:null, complete:false, finalText:null,
    initiallyOffscreen:p.getBoundingClientRect().top >= innerHeight }));
  const evidence = { targets, paintAt:null, allCommittedAt:null };
  let framePending = false;
  const scan = () => {
    for (const t of targets) {
      const p = document.getElementById(t.id), hosts = [...p.querySelectorAll('at-translation-text')];
      if (hosts.some(h => h.dataset.streaming === 'true' && h.shadowRoot?.querySelector('.preview')?.textContent)) t.firstPreviewAt ??= now();
      t.states = hosts.map(h => h.dataset.state);
      t.complete = hosts.length > 0 && t.states.every(s => s === 'translated') &&
        !p.querySelector('[aria-busy="true"]') && p.textContent !== t.source && /[가-힣]/u.test(p.textContent);
      t.currentText = p.textContent;
      if (t.complete) { t.completedAt ??= now(); t.finalText = p.textContent; }
    }
    if (targets.every(t => t.complete)) {
      evidence.allCommittedAt ??= now();
      if (!framePending && evidence.paintAt === null) {
        framePending = true;
        requestAnimationFrame(() => requestAnimationFrame(() => {
          framePending = false;
          if (targets.every(t => t.complete)) evidence.paintAt ??= now();
        }));
      }
    }
  };
  const observer = new MutationObserver(scan);
  observer.observe(document.querySelector('main'), {subtree:true,childList:true,characterData:true,attributes:true});
  const timer = setInterval(scan,16);
  globalThis.__fullPage = { scan,
    snapshot() { scan(); return { ...evidence, targets: targets.map(({originalNode,...t}) => t), capturedAt:now(), scrollY }; },
    restored() { return targets.every(t => { const p=document.getElementById(t.id); return p.textContent===t.source && p.firstChild===t.originalNode; }) && !document.querySelector('at-translation-text'); },
    stop() { clearInterval(timer); observer.disconnect(); }
  };
}

export async function runFullPageBenchmark({context, options, worker, output, extension}) {
  const label = process.env.FULL_PAGE_LABEL || 'candidate';
  const rounds = Number(process.env.FULL_PAGE_ROUNDS || 1);
  const timeoutMs = Number(process.env.FULL_PAGE_TIMEOUT_MS || 90000);
  const modelState = process.env.FULL_PAGE_STATE || 'warm';
  assert.ok(['warm', 'cold'].includes(modelState), 'FULL_PAGE_STATE must be warm or cold');
  const chosenCases = process.env.FULL_PAGE_CASES?.split(',');
  assert.ok(Number.isInteger(rounds) && rounds > 0 && rounds <= 10);
  assert.ok(timeoutMs > 0 && Number.isFinite(timeoutMs));
  if (chosenCases) assert.ok(chosenCases.length && chosenCases.every(x => SCENARIOS.some(s => s.id===x)));
  const scenarios = chosenCases ? SCENARIOS.filter(s => chosenCases.includes(s.id)) : SCENARIOS;
  const report = {label, modelState, startedAt:new Date().toISOString(), rounds, timeoutMs, goalMs:5000,
    metric:'actual enable click to ALL fixed-page eligible source units finally committed plus two animation-frame opportunities; no scrolling',
    limitations:['Finite frozen pages, not an arbitrary-size/infinite-page five-second guarantee.',
      modelState === 'warm' ? 'Warm resident model, fresh page result cache; preparation and warmup retained separately.'
        : 'Disk-cached cold GPU/model start: explicit unload before each enable click. Download and OS file-cache coldness are not measured.',
      'DOM observations and animation-frame opportunities are not GPU compositor presentation timestamps.',
      'All final translations retained for semantic inspection; Korean/nonempty checks alone are not a quality pass.',
      'No p95 estimate from these small round counts; incomplete and failed runs stay in denominators.'],
    fixtureHash:digest(JSON.stringify({SCENARIOS,CSS})),scenarios,models:[],runs:[],errors:[],installedFiles:{},warmup:[]};
  const reportPath = join(output,`full-page-${label}.json`);
  const persist = () => writeFile(reportPath,JSON.stringify(report,null,2));
  const pages = new Set();
  const server = createServer((req,res) => {
    const scenario = scenarios.find(s => new URL(req.url,'http://fixture').pathname === '/'+s.id);
    if (!scenario) { res.writeHead(404);res.end();return; }
    res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
    res.end(`<!doctype html><html lang="${scenario.language}"><meta charset="utf-8"><title translate="no">Full page completion</title><style>${CSS}</style><main>${scenario.texts.map((text,i)=>`<p id="unit-${i}">${escape(text)}</p>`).join('')}</main><div translate="no" id="protected">DO NOT TRANSLATE</div></html>`);
  });
  let wrapped=false;
  try {
    await new Promise((done,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',done);});
    const origin=`http://127.0.0.1:${server.address().port}`;
    report.browser={version:context.browser()?.version(),headless:process.env.HEADLESS==='1',unsafe:process.env.UNSAFE_WEBGPU!=='0',userAgent:await options.evaluate(()=>navigator.userAgent)};
    assert.equal(report.browser.headless,false);assert.equal(report.browser.unsafe,false);
    report.adapter=await options.evaluate(async()=>{const a=await navigator.gpu.requestAdapter();return {info:{vendor:a.info.vendor,architecture:a.info.architecture},features:[...a.features]};});
    for (const name of ['manifest.json','background.js','content.js','lib/settings.js','lib/pipeline.js','lib/dom.js','lib/engines.js','lib/onnxhost.js','lib/kernels.js','hostworker.js']) report.installedFiles[name]=digest(await readFile(join(extension,name)));
    await options.evaluate(()=>AT.settings.save({sourceLang:'auto',targetLang:'ko',debug:false}));
    const onnx=await options.evaluate(async()=>{const s=await AT.settings.load();return AT.modelstore.get(s.localModelId);});
    assert.ok(onnx);
    const model={id:'onnx',record:onnx};
    report.models.push(model);
    await worker.evaluate(()=>{
      const original=AT.local.callHost;
      globalThis.__fullHost={calls:[],active:0,maxActive:0};
      globalThis.__restoreFullHost=()=>{AT.local.callHost=original;};
      AT.local.callHost=async function(message,progress,signal){
        const state=globalThis.__fullHost, generation=message.type===AT.C.MSG.LOCAL_TRANSLATE;
        const entry={type:message.type,generation,texts:message.texts,startedAt:performance.timeOrigin+performance.now(),endedAt:null,error:null};
        state.calls.push(entry);if(generation)state.maxActive=Math.max(state.maxActive,++state.active);
        try{const result=await original.call(this,message,progress,signal);entry.result=result;if(result?.ok===false)entry.error=result.error??result.code;return result;}
        catch(error){entry.error=String(error?.message||error);throw error;}
        finally{entry.endedAt=performance.timeOrigin+performance.now();if(generation)state.active--;}
      };
    });wrapped=true;
    for(let round=1;round<=rounds;round++){
      const start=Date.now();
      const prepared=await options.evaluate(async id=>{const r=await AT.modelflow.prepare(id);if(r.ok)await AT.settings.save({localModelId:id});return r;},model.record.id);
      assert.ok(prepared.ok,prepared.error);
      const prepareMs=Date.now()-start;
      const warm=await worker.evaluate(async modelId=>{const start=performance.now();const result=await AT.engines.translate({localModelId:modelId,localMaxTokens:1024,source:'ja',target:'ko',texts:['明日は図書館で説明会を開きます。']});return {ms:performance.now()-start,result};},model.record.id);
      report.warmup.push({round,model:model.id,prepareMs,...warm});
      assert.ok(warm.result.translations.every(x=>/[가-힣]/u.test(x)));
      const settings=await options.evaluate(()=>AT.settings.load());
      for(const scenario of round%2?scenarios:[...scenarios].reverse()){
        const run={round,model:model.id,scenario:scenario.id,width:settings.translationConcurrency,goalMs:5000,completionMs:null,status:'incomplete',errors:[]};report.runs.push(run);
        let page,tabId;
        try{
          const counts=await options.evaluate(async({modelId,texts})=>AT.local.callHost({type:AT.C.MSG.LOCAL_COUNT,modelId,maxTokens:1024,target:'ko',texts}),{modelId:model.record.id,texts:scenario.texts});
          assert.ok(counts.ok,counts.error);run.sourceCounts=counts.counts;
          await worker.evaluate(()=>{if(globalThis.__fullHost.active)throw Error('previous generation still active');globalThis.__fullHost.calls=[];globalThis.__fullHost.maxActive=0;});
          page=await context.newPage();pages.add(page);await page.setViewportSize({width:1280,height:900});
          page.on('pageerror',e=>run.errors.push(errorText(e)));
          await page.goto(`${origin}/${scenario.id}?model=${model.id}&round=${round}`);
          await page.evaluate(observeFullPage);
          tabId=await tabIdFor(options,page);await prepareTabEnabledUI(options,tabId);
          run.initial=await page.evaluate(()=>__fullPage.snapshot());
          assert.ok(run.initial.targets.some(t=>t.initiallyOffscreen),'must measure below-fold source too');
          assert.equal(run.initial.scrollY,0,'whole-page test must start without scrolling');
          if (modelState === 'cold') {
            const unloaded = await options.evaluate(() => AT.sendMessage({type:AT.C.MSG.LOCAL_RELEASE}));
            assert.ok(unloaded.ok, unloaded.error);
            run.beforeEnableModel = await options.evaluate(() => AT.sendMessage({type:AT.C.MSG.LOCAL_GET_STATUS}));
            assert.equal(run.beforeEnableModel.status?.state, 'unloaded', 'cold timing requires a nonresident model');
            assert.equal(run.beforeEnableModel.status?.loadedBytes, 0);
          }
          await options.evaluate(()=>{globalThis.__fullClick=null;document.querySelector('#enabled').addEventListener('click',e=>{globalThis.__fullClick=performance.timeOrigin+e.timeStamp;},{once:true,capture:true});});
          await options.bringToFront();await clickPreparedTabEnabledUI(options,tabId,true);await page.bringToFront();
          run.startedAt=await options.evaluate(()=>globalThis.__fullClick);assert.ok(Number.isFinite(run.startedAt));
          await page.waitForFunction(()=>__fullPage.snapshot().paintAt!==null,null,{timeout:timeoutMs}).catch(e=>{run.timeout=String(e.message);});
          run.dom=await page.evaluate(()=>__fullPage.snapshot());
          run.host=await worker.evaluate(()=>globalThis.__fullHost);
          run.state=await options.evaluate(id=>AT.api.tabs.sendMessage(id,{type:AT.C.MSG.CONTENT_STATE}),tabId);
          run.modelStatus=await options.evaluate(()=>AT.sendMessage({type:AT.C.MSG.LOCAL_GET_STATUS}));
          assert.equal(run.modelStatus.status.backend,'kernels','no backend substitution');
          assert.equal(run.dom.scrollY,0,'whole-page test must not scroll to drive completion');
          assert.equal(await page.locator('#protected').textContent(),'DO NOT TRANSLATE');
          assert.ok(run.host.calls.some(c=>c.generation),'real fresh-page inference required');
          assert.ok(run.host.calls.every(c=>!c.error),'host failures cannot disappear from results');
          assert.ok(run.host.maxActive<=settings.translationConcurrency,'page admission cap');
          run.completedUnits=run.dom.targets.filter(t=>t.complete).length;
          if(run.completedUnits===scenario.texts.length&&run.dom.paintAt!==null){run.completionMs=run.dom.paintAt-run.startedAt;run.status='completed';}
          run.goalMet=run.status==='completed'&&run.completionMs<=5000;
          run.firstPreviewMs=Math.min(...run.dom.targets.filter(t=>t.firstPreviewAt!==null).map(t=>t.firstPreviewAt))-run.startedAt;
          if(!Number.isFinite(run.firstPreviewMs))run.firstPreviewMs=null;
          const stem=`full-page-${label}-${model.id}-${scenario.id}-${round}`;
          run.screenshot=`${stem}.png`;await page.screenshot({path:join(output,run.screenshot),fullPage:true});
          await setTabEnabledUI(options,tabId,false);
          await page.waitForFunction(()=>__fullPage.restored(),null,{timeout:15000});run.restored=true;
          await page.evaluate(()=>__fullPage.stop());
        }catch(error){run.errors.push(errorText(error));run.status='failed';}
        finally{
          if(page&&!page.isClosed()){if(tabId!==undefined)await setTabEnabledUI(options,tabId,false).catch(e=>run.errors.push(errorText(e)));await page.close();pages.delete(page);}
          console.log('[full-page]',label,model.id,scenario.id,'round',round,run.status,run.completionMs,'ms','goal',run.goalMet,'errors',run.errors.length);await persist();
        }
      }
    }
  }catch(error){report.errors.push(errorText(error));}
  finally{
    for(const page of pages)await page.close().catch(()=>{});
    if(wrapped)await worker.evaluate(()=>globalThis.__restoreFullHost()).catch(e=>report.errors.push(errorText(e)));
    report.summary=report.models.flatMap(model=>scenarios.map(s=>{const runs=report.runs.filter(r=>r.model===model.id&&r.scenario===s.id);const complete=runs.filter(r=>r.status==='completed'&&!r.errors.length&&r.restored);return {model:model.id,scenario:s.id,expected:rounds,observed:runs.length,completed:complete.length,goalMet:runs.filter(r=>r.goalMet&&!r.errors.length&&r.restored).length,medianMs:complete.length===rounds?median(complete.map(r=>r.completionMs)):null,maxMs:complete.length===rounds?Math.max(...complete.map(r=>r.completionMs)):null};}));
    report.finishedAt=new Date().toISOString();report.correct=report.errors.length===0&&report.summary.length===scenarios.length&&report.summary.every(s=>s.completed===rounds);report.goalMet=report.correct&&report.summary.every(s=>s.goalMet===rounds);
    server.closeAllConnections();await new Promise(done=>server.close(done));await persist();
  }
  console.log('[full-page report]',reportPath,'correct',report.correct,'five-second goal',report.goalMet);
  if(process.env.FULL_PAGE_ALLOW_INCOMPLETE!=='1')assert.equal(report.correct,true,`full-page correctness incomplete; see ${reportPath}`);
  return report;
}

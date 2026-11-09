// Planner-only audit. Identity responses isolate DOM/planning CPU costs; these
// are NOT translations. Genuine inference is measured by the installed-extension workflow.
// These adversarial acceptance cases are not a representative quality score.
// The visible-UI case is an explicit alternative to the existing content-first
// policy; other cases expose geometry, eligibility, semantics or budget limits.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';
const root = process.cwd(), out = resolve(process.env.PLANNER_QA_DIR || 'test-results/planner');
await mkdir(out, {recursive:true});
const browser = await chromium.launch({headless:true, ...(process.env.CHROMIUM_EXECUTABLE ? {executablePath:process.env.CHROMIUM_EXECUTABLE} : {channel:'chromium'}),args:['--disable-gpu', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])]});
const results=[];
async function run(name, html, options, accept, category='eligibility') {
 const page=await browser.newPage({viewport:{width:1100,height:780}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try {
  const document=`<!doctype html><html lang="en"><head><meta charset="utf-8"><title translate="no">Planner audit: ${name}</title><style>body{margin:0;font:16px/24px sans-serif}p{margin:0}main{display:block}</style></head><body>${html}</body></html>`;
  await page.setContent(document);
  for(const file of ['constants','pagecontext','targets','dom','pipeline'])await page.addScriptTag({content:await readFile(join(root,'build/ts/src/lib',file+'.js'),'utf8')});
  if(options.scrollTo)await page.locator(options.scrollTo).scrollIntoViewIfNeeded();
  const report=await page.evaluate(async options=>{
    const visibleTexts=[...document.querySelectorAll('p')].filter(e=>{const r=e.getBoundingClientRect();return r.bottom>=0&&r.top<=innerHeight&&r.right>=0&&r.left<=innerWidth;}).map(e=>e.textContent);
    const requests=[];let firstMs=null; const start=performance.now();
    const pipeline=AT.pipeline.create({doc:document,settings:()=>({maxNodes:options.maxNodes||600}),translate:async batch=>{
      firstMs??=performance.now()-start;
      requests.push({role:batch.role,texts:batch.texts});return batch.texts;
    }});
    const result=await pipeline.translate();const totalMs=performance.now()-start;
    const restoreStart=performance.now();pipeline.restore();const restoreMs=performance.now()-restoreStart;
    return {result,requests,firstMs,totalMs,restoreMs,visibleTexts,scrollY,viewport:{width:innerWidth,height:innerHeight}};
  },options);
  const verdict=accept(report);results.push({name,category,pass:verdict===true&&errors.length===0,expected:options.expected,actual:report,errors});
  if(options.screenshot)await page.screenshot({path:join(out,name+'.png'),fullPage:false,caret:'initial'});
  await writeFile(join(out,name+'.html'),document);
  console.log(`${verdict===true?'PASS':'FAIL'} ${name}: ${typeof verdict==='string'?verdict:''}`);
 }finally{await page.close();}
}
const texts=r=>r.requests.flatMap(b=>b.texts);
const first=r=>texts(r)[0];
const roleFor=(r,s)=>r.requests.find(b=>b.texts.some(t=>t.includes(s)))?.role;
await run('display-none', '<main><p>VISIBLE_ARTICLE</p><div style="display:none"><p>HIDDEN_DISPLAY</p></div></main>',{expected:'display:none text is not requested'},r=>!texts(r).some(s=>s.includes('HIDDEN')));
await run('invisible-and-collapsed', '<main><p>VISIBLE_ARTICLE</p><p style="visibility:hidden">HIDDEN_VISIBILITY</p><div style="opacity:0"><p>HIDDEN_OPACITY</p></div><details><summary>VISIBLE_SUMMARY</summary><p>HIDDEN_DETAILS</p></details></main>',{expected:'invisible and closed-details content is not requested'},r=>!texts(r).some(s=>s.includes('HIDDEN')));
await run('display-contents', '<main><span style="display:contents">VISIBLE_CONTENTS</span><p style="position:absolute;top:1600px">FAR_ARTICLE</p></main>',{expected:'visible display:contents text precedes distant prose'},r=>first(r)==='VISIBLE_CONTENTS','geometry');
await run('visible-ui-vs-distant-body','<div style="position:absolute;top:50px">VISIBLE_UI</div><main><p style="position:absolute;top:2000px">FAR_ARTICLE</p></main>',{expected:'visible text precedes offscreen article text',screenshot:true},r=>first(r)==='VISIBLE_UI','policy');
await run('viewport-top-overlap','<main><p style="position:absolute;top:-5px;height:40px">VISIBLE_OVERLAP</p><p style="position:absolute;top:2000px">FAR_ARTICLE</p></main>',{expected:'partially visible text precedes text two screens below'},r=>first(r)==='VISIBLE_OVERLAP','geometry');
await run('horizontal-offscreen','<main><p style="position:absolute;top:40px;left:-2000px">OFFSCREEN_HORIZONTAL</p><p style="position:absolute;top:80px;left:20px">VISIBLE_BODY</p></main>',{expected:'visible text precedes horizontally offscreen text'},r=>first(r)==='VISIBLE_BODY','geometry');
await run('native-button','<main><button>Save document</button></main>',{expected:'native button is classified as form'},r=>roleFor(r,'Save document')==='form','semantics');
await run('aria-navigation','<div role="navigation"><a role="link" href="#">Navigation entry</a></div>',{expected:'ancestor navigation role survives child link role'},r=>roleFor(r,'Navigation entry')==='navigation','semantics');
await run('deep-main','<main>'+'<div>'.repeat(16)+'<p>Deeply nested article</p>'+'</div>'.repeat(16)+'</main>',{expected:'main remains recognizable beyond twelve wrapper elements'},r=>roleFor(r,'Deeply nested article')==='article','semantics');
await run('thread-root','<div class="thread-page"><main><h1>Thread title</h1><p>Original post</p></main></div>',{expected:'generic thread container does not classify the entire article as comments'},r=>roleFor(r,'Thread title')==='heading'&&roleFor(r,'Original post')==='article','semantics');
await run('hidden-prefix-budget','<nav style="display:none">'+Array.from({length:100},(_,i)=>`<p>HIDDEN_MENU_${i}</p>`).join('')+'</nav><main><p>VISIBLE_ARTICLE</p></main>',{maxNodes:10,expected:'hidden navigation does not consume the collection window'},r=>first(r)==='VISIBLE_ARTICLE','budget');
// The bottom target can be the 33rd visible row; do not confuse first ten
// strings with the full visible cohort. Every visible row must precede offscreen rows.
await run('scrolled-beyond-window','<main>'+Array.from({length:4500},(_,i)=>`<p id="row-${i}">Article row ${i}</p>`).join('')+'</main>',{scrollTo:'#row-4499',maxNodes:600,expected:'current viewport remains discoverable beyond the 4001-node collection cap'},r=>texts(r).slice(0,r.visibleTexts.length).includes('Article row 4499') && texts(r).slice(0,r.visibleTexts.length).every(s=>r.visibleTexts.includes(s)),'budget');
await run('maxnodes-above-window','<main>'+Array.from({length:5002},(_,i)=>`<p>Repeated article ${i}</p>`).join('')+'</main>',{maxNodes:5000,expected:'a truncated scan must report remaining work'},r=>r.result.hasMore===true,'budget');
await run('protected-regions','<main><p>Visible prose</p><pre>KEEP_CODE</pre><p translate="no">KEEP_NO</p><div contenteditable="true">KEEP_EDIT</div></main>',{expected:'protected text is never requested'},r=>!texts(r).some(s=>s.includes('KEEP')),'safety');
await run('semantic-baseline','<nav>Menu label</nav><main><h1>Article title</h1><p>Article body</p><section role="comment">Reader comment</section></main>',{expected:'heading, article and explicit comment semantics remain distinct'},r=>roleFor(r,'Article title')==='heading'&&roleFor(r,'Article body')==='article'&&roleFor(r,'Reader comment')==='comment','semantics');
const performance=[];
for(const size of [100,1000,4000]){
 const samples=[];
 for(let repetition=0;repetition<5;repetition++){
  const page=await browser.newPage({viewport:{width:1100,height:780}});
  await page.setContent('<!doctype html><title translate="no">CPU planner cost</title><main>'+Array.from({length:size},(_,i)=>`<p>Unique document sentence ${i}.</p>`).join('')+'</main>');
  for(const file of ['constants','pagecontext','targets','dom','pipeline'])await page.addScriptTag({content:await readFile(join(root,'build/ts/src/lib',file+'.js'),'utf8')});
  samples.push(await page.evaluate(async()=>{let first=null,requests=0;const t=performance.now();const p=AT.pipeline.create({doc:document,settings:()=>({maxNodes:600}),translate:async b=>{first??=performance.now()-t;requests+=b.texts.length;return b.texts;}});let r=await p.translate(),passes=1;while(r.hasMore&&passes<20){r=await p.refresh(null,600);passes++;}const total=performance.now()-t;const ts=performance.now();p.restore();return {firstMs:first,totalMs:total,restoreMs:performance.now()-ts,requests,passes};}));
  await page.close();
 }
 const median=k=>samples.map(s=>s[k]).sort((a,b)=>a-b)[2];performance.push({size,samples,medianFirstMs:median('firstMs'),medianTotalMs:median('totalMs'),medianRestoreMs:median('restoreMs')});
}
const browserVersion=browser.version();await browser.close();
const summary={scope:'Real Chromium DOM + production planner; identity responses ONLY to isolate planning cost, not translation',sourceCommit:process.env.GITHUB_SHA||'local',browserVersion,cases:results.length,passed:results.filter(r=>r.pass).length,failed:results.filter(r=>!r.pass).length,results,performance};
await writeFile(join(out,'summary.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify({cases:summary.cases,passed:summary.passed,failed:summary.failed,performance:performance.map(({samples,...rest})=>rest)},null,2));
if(process.env.PLANNER_ENFORCE==='1'&&summary.failed)process.exitCode=1;

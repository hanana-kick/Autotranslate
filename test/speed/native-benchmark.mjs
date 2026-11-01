// Read-only timing observers + real UI controls. No inference or DOM-engine doubles.
import assert from 'node:assert/strict';
import { setTabEnabledUI, tabIdFor } from '../native-extension/tab-control.mjs';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const phrases = ['Your documents remain private.', 'Keep practicing every day.', 'The changes were saved successfully.', 'Thank you for your patience.'];
const rows = [
  ['Read ', 'the installation guide', ' before continuing.'],
  ['Visit ', 'the help center', ' for more information.'],
  ['Open ', 'the saved document', ' to review your changes.'],
  ['Check ', 'the privacy policy', ' before creating an account.']
];
const shell = (body) => '<!doctype html><html lang="en"><head><meta charset="utf-8"><title translate="no">Native speed fixture</title><style>body{font:17px/1.6 system-ui;margin:28px}p{margin:8px 0}</style></head><body><main>'+body+'</main><input value="retained draft"><pre>untouched code</pre></body></html>';
const paragraph = (s, i) => '<p data-bench id="p'+i+'">'+s+'</p>';
const pages = new Map([
  ['/cached', shell(Array.from({length:600},(_,i)=>paragraph(phrases[i%4],i)).join(''))],
  ['/inline', shell(rows.map((r,i)=>'<p><span data-bench>'+r[0]+'</span><a data-bench href="#guide-'+i+'">'+r[1]+'</a><span data-bench>'+r[2]+'</span></p>').join(''))],
  ['/foreground', shell(phrases.map(paragraph).join(''))],
  ['/unread', shell(['This article explains how to grow vegetables.', 'Water the plants every morning.', 'Prepare the garden before planting seeds.', 'Enjoy the fresh food from your garden.'].map(paragraph).join(''))]
]);
export async function runSpeedBenchmark({ context, options, host, capture, stage, passed, summary, save, out }) {
  const server=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(pages.get(new URL(req.url,'http://localhost').pathname)||shell(''));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin='http://127.0.0.1:'+server.address().port;
  const results=summary.speed={label:process.env.SPEED_LABEL||'candidate', scope:'Actual installed extension / original runtime and model / UI toggle, DOM timing and exact restoration',samples:[],passed:false};
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  let targetId = null;
  async function toggle(value) {
    if (targetId === null && process.env.SPEED_LABEL !== 'baseline') return;
    await setTabEnabledUI(options, targetId, value);
  }
  async function idle() {
    let last=-1,stable=0;
    const deadline=Date.now()+120000;
    while(Date.now()<deadline) {
      const s=(await host(options)).status;
      if(s.state==='error')throw Error(s.lastError||'native inference failed');
      stable=s.state==='ready'&&s.generations===last?stable+1:0;last=s.generations;
      if(stable>=4)return s;
      await sleep(250);
    }
    throw Error('native model did not become idle between cases');
  }
  try {
    for(const name of ['cached','inline','foreground']) for(let repetition=0;repetition<3;repetition++) {
      await stage('speed-'+name+'-'+repetition); await toggle(false); await idle();
      const unread=[];let page,original,timing;
      try {
        if(name==='foreground')for(let i=0;i<8;i++){const p=await context.newPage();unread.push(p);await p.goto(origin+'/unread?id='+i);}
        page=await context.newPage();await page.goto(origin+'/'+name);await page.bringToFront();
        targetId=await tabIdFor(options,page);
        assert.equal(await page.title(),'Native speed fixture');
        original=await page.evaluateHandle(()=>({html:document.body.innerHTML,elements:[...document.body.querySelectorAll('*')],attrs:[...document.body.querySelectorAll('*')].map(e=>JSON.stringify([...e.attributes].map(a=>[a.name,a.value])))}));
        timing=await page.evaluateHandle(()=>{
          const data={started:performance.now(),firstMs:null,allMs:null};
          const observer=new MutationObserver(()=>{
            const values=[...document.querySelectorAll('[data-bench]')].map(e=>/[가-힣]/u.test(e.textContent));
            if(data.firstMs===null&&values.some(Boolean))data.firstMs=performance.now()-data.started;
            if(data.allMs===null&&values.length&&values.every(Boolean))data.allMs=performance.now()-data.started;
          });observer.observe(document.body,{subtree:true,characterData:true,childList:true});return {data,observer};
        });
        const before=await idle();
        await timing.evaluate(o=>o.data.started=performance.now());
        await toggle(true);
        const deadline=Date.now()+600000;
        let complete=false;
        while(Date.now()<deadline){
          const current=await page.locator('[data-bench]').allTextContents();
          const status=(await host(options)).status;
          if(status.state==='error')throw Error(status.lastError||'native host failed');
          if(current.length&&current.every(s=>/[가-힣]/u.test(s)&&!/<(?:pad|start_of_turn|end_of_turn)>/.test(s))){complete=true;break;}
          await sleep(200);
        }
        assert.ok(complete,'all real model output must reach the page');
        const measured=await timing.evaluate(({data,observer})=>{observer.disconnect();return data;});
        const after=(await host(options)).status;
        const unreadChanged=(await Promise.all(unread.map(p=>p.locator('[data-bench]').allTextContents()))).flat().filter(s=>/[가-힣]/u.test(s)).length;
        if(results.label==='candidate')assert.equal(unreadChanged,0,'unread tabs must not spend inference');
        const item={name,repetition,firstMs:measured.firstMs,totalMs:measured.allMs,generations:after.generations-before.generations,recoveries:(after.recoveries||0)-(before.recoveries||0),unreadChanged,completed:await page.locator('[data-bench]').count(),restored:false};
        assert.ok(Number.isFinite(item.firstMs)&&Number.isFinite(item.totalMs));
        if(repetition===0)await capture(page,'speed-'+name+'-translated');
        const restoreAt=performance.now();await toggle(false);
        await page.waitForFunction(o=>document.body.innerHTML===o.html,original,{timeout:30000});
        assert.equal(await original.evaluate(o=>o.elements.every((e,i)=>e===document.body.querySelectorAll('*')[i]&&JSON.stringify([...e.attributes].map(a=>[a.name,a.value]))===o.attrs[i])),true,'DOM objects and attributes must survive translation and restore');
        assert.equal(await page.locator('input').inputValue(),'retained draft');
        item.restoreMs=performance.now()-restoreAt;item.restored=true;
        results.samples.push(item);await passed('speed-'+name+'-'+repetition,item);await save();
      } finally {
        await toggle(false).catch(()=>{});
        await timing?.dispose().catch(()=>{});await original?.dispose().catch(()=>{});
        await page?.close().catch(()=>{});targetId=null;for(const p of unread)await p.close().catch(()=>{});
      }
    }
    results.passed=true;
    await writeFile(join(out,'speed.json'),JSON.stringify(results,null,2));await save();
  } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
}

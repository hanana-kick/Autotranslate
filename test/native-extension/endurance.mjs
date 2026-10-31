// Two real tabs share the packaged model. Fixture actions only mutate their own
// DOM; all translation is performed by the installed extension and original SDK.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
export async function runEndurance({ context, options, host, capture, stage, passed, summary, save }) {
  const rounds = Number(process.env.ENDURANCE_ROUNDS || 5);
  assert.ok(Number.isInteger(rounds) && rounds >= 5 && rounds <= 100);
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title translate="no">Shared model endurance</title></head><body style="font:20px system-ui;margin:48px"><main><p id="text">This document contains chapter zero.</p></main><button id="next" translate="no">Next chapter</button><input value="retained draft"><script>let round=0;window.source='This document contains chapter zero.';document.querySelector('#next').onclick=()=>{window.source='This document contains chapter '+(++round)+'.';document.querySelector('#text').firstChild.nodeValue=window.source;};</script></body></html>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const tabs = []; const records = [];
  const result = summary.endurance = { rounds, tabs: 2, passed: false, samples: [] };
  async function toggle(value) {
    const before = await options.evaluate(() => AT.settings.load());
    await options.reload();
    await options.waitForFunction((s) => document.querySelector('#localModel').value === s.localModelId && document.querySelector('#enabled').checked === s.enabled, before);
    await options.locator('#enabled').setChecked(value); await options.locator('#save').click();
    await options.waitForFunction(async (v) => document.querySelector('#saveStatus').dataset.kind === 'ok' && (await AT.settings.load()).enabled === v, value);
  }
  try {
    await stage('multi-tab-endurance'); await toggle(false);
    for (let index = 0; index < 2; index++) {
      const page = await context.newPage(); tabs.push(page);
      await page.goto(`http://127.0.0.1:${server.address().port}/${index}`);
      records.push(await page.locator('#text').evaluateHandle((el) => ({ el, text: el.firstChild })));
    }
    await toggle(true);
    const initial = (await host(options)).status.generations;
    for (let round = 0; round <= rounds; round++) {
      const start = performance.now();
      if (round) await Promise.all(tabs.map((p) => p.locator('#next').click()));
      await Promise.all(tabs.map((p) => p.waitForFunction(() => {
        const text = document.querySelector('#text').textContent;
        return /[가-힣]/u.test(text) && !/<(?:pad|start_of_turn|end_of_turn)>/.test(text) && text.length < 500;
      }, null, { timeout: 90000 })));
      for (const [index, page] of tabs.entries()) {
        assert.equal(await records[index].evaluate((o) => o.el === document.querySelector('#text') && o.text === o.el.firstChild), true);
        assert.equal(await page.locator('input').inputValue(), 'retained draft');
      }
      result.samples.push({ round, ms: performance.now() - start, host: (await host(options)).status }); await save();
    }
    await toggle(false);
    await Promise.all(tabs.map((p) => p.waitForFunction(() => document.querySelector('#text').textContent === window.source)));
    result.finalGenerations = (await host(options)).status.generations;
    assert.ok(result.finalGenerations > initial, 'all work must reach actual inference');
    await capture(tabs[0], 'endurance-restored-tab-1'); await capture(tabs[1], 'endurance-restored-tab-2');
    result.passed = true; await passed('shared-model-multi-tab-endurance-and-restoration', { rounds, tabs: 2, generations: result.finalGenerations - initial });
    await save();
  } finally {
    for (const handle of records) await handle.dispose().catch(() => {});
    for (const page of tabs) await page.close().catch(() => {});
    server.closeAllConnections(); await new Promise((r) => server.close(r));
  }
}

// Installed content -> background -> real WebGPU host. Japanese evaluation only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CORPUS } from './chunk-benchmark.mjs';
import { prepareTabEnabledUI, clickPreparedTabEnabledUI, setTabEnabledUI, tabIdFor } from '../native-extension/tab-control.mjs';

export async function runPageChunkBenchmark({ context, options, worker, output }) {
  const corpus = CORPUS.filter(unit => ['extended-japanese', 'japanese-comment'].includes(unit.id));
  const server = createServer((request, response) => {
    const units = request.url.includes('pair') ? corpus : [corpus.find(unit => unit.id === 'extended-japanese')];
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html lang="ja"><meta charset="utf-8"><title>図書館の案内</title><style>body{font:18px/1.7 sans-serif;margin:24px;max-width:1150px}p{margin:0 0 24px}</style><main>${units.map(unit => `<p>${unit.text}</p>`).join('')}</main></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const report = { startedAt: new Date().toISOString(), language: 'ja', target: 'ko', runs: [],
    limits: ['Real model, no inference doubles; fixed Japanese fixtures, not a public-site SLO.',
      'Warm model; timings include tokenizer planning and shipped page scheduling.',
      'Preview samples every 16ms; UI automation and screenshots can add overhead.',
      'One run per shape/width; not a statistical performance comparison.'] };
  try {
    const settings = await options.evaluate(() => AT.settings.save({ sourceLang: 'ja', targetLang: 'ko', debug: false }));
    const prepared = await options.evaluate(maxTokens => AT.sendMessage({ type: AT.C.MSG.LOCAL_PREPARE, target: 'ko', maxTokens }), settings.localMaxTokens);
    assert.equal(prepared.ok, true, prepared.error);
    await worker.evaluate(async settings => {
      await AT.engines.translate({ texts: ['図書館は明日から開館します。'], source: 'ja', target: 'ko', localModelId: settings.localModelId });
      const call = AT.local.callHost;
      globalThis.__fragmentEvidence = { calls: [], active: 0, maximum: 0 };
      AT.local.callHost = async (message, progress, signal) => {
        const evidence = globalThis.__fragmentEvidence;
        if (message.type !== AT.C.MSG.LOCAL_TRANSLATE) return call(message, progress, signal);
        const entry = { texts: message.texts, started: performance.now(), firstPreview: null, completed: null };
        evidence.calls.push(entry); evidence.maximum = Math.max(evidence.maximum, ++evidence.active);
        try {
          return await call(message, (index, text) => {
            if (text) entry.firstPreview ??= performance.now();
            progress?.(index, text);
          }, signal);
        } finally { entry.completed = performance.now(); evidence.active--; }
      };
    }, settings);
    for (const shape of ['single', 'pair']) for (const width of [1, 2]) {
      await options.evaluate(width => AT.settings.save({ translationConcurrency: width }), width);
      await worker.evaluate(() => { globalThis.__fragmentEvidence = { calls: [], active: 0, maximum: 0 }; });
      const page = await context.newPage();
      await page.goto(`${origin}/${shape}-${width}`);
      const tabId = await tabIdFor(options, page);
      await prepareTabEnabledUI(options, tabId);
      await page.evaluate(() => {
        const sources = [...document.querySelectorAll('main p')].map(p => p.textContent);
        const evidence = { sources, firstPreviewMs: null, firstCompleteMs: null, completeMs: null, updates: 0, previous: '', started: performance.now() };
        const timer = setInterval(() => {
          const hosts = [...document.querySelectorAll('main at-translation-text')];
          const preview = hosts.map(host => host.shadowRoot?.querySelector('.preview')?.textContent ?? '').join('');
          if (hosts.some(host => host.dataset.streaming === 'true') && preview && preview !== evidence.previous) {
            evidence.firstPreviewMs ??= performance.now() - evidence.started; evidence.updates++; evidence.previous = preview;
          }
          if (hosts.some(host => host.dataset.state === 'translated')) evidence.firstCompleteMs ??= performance.now() - evidence.started;
          const paragraphs = [...document.querySelectorAll('main p')];
          if (paragraphs.every((p, i) => p.textContent !== sources[i] && p.querySelector('at-translation-text[data-state="translated"]') && !p.querySelector('[aria-busy="true"]'))) {
            evidence.completeMs ??= performance.now() - evidence.started;
          }
        }, 16);
        globalThis.__pageFragments = { evidence, stop: () => clearInterval(timer) };
      });
      await clickPreparedTabEnabledUI(options, tabId, true);
      await page.bringToFront();
      await page.waitForFunction(() => globalThis.__pageFragments.evidence.firstPreviewMs !== null, null, { timeout: 60000 });
      if (width === 2 && shape === 'single') await page.screenshot({ path: join(output, 'page-fragments-streaming.png') });
      await page.waitForFunction(() => globalThis.__pageFragments.evidence.completeMs !== null, null, { timeout: 180000 });
      const dom = await page.evaluate(() => {
        globalThis.__pageFragments.stop();
        return { ...globalThis.__pageFragments.evidence, translated: [...document.querySelectorAll('main p')].map(p => p.textContent) };
      });
      const host = await worker.evaluate(() => globalThis.__fragmentEvidence);
      const texts = host.calls.flatMap(call => call.texts);
      const counted = await options.evaluate(async ({ texts, modelId }) => AT.local.callHost({ type: AT.C.MSG.LOCAL_COUNT, modelId, texts, target: 'ko' }), { texts, modelId: settings.localModelId });
      assert.equal(counted.ok, true, counted.error);
      assert.ok(counted.counts.every(count => count <= 64), 'every actual generation respects the source-token cap');
      assert.ok(host.maximum <= width, 'page-wide slots are not multiplied by fragment parallelism');
      if (width === 2) assert.equal(host.maximum, 2, 'real host requests overlap');
      assert.ok(dom.translated.every(text => /[가-힣]/u.test(text)));
      assert.ok(dom.updates > 1, 'streamed presentation is observable');
      await page.screenshot({ path: join(output, `page-fragments-${shape}-${width}.png`) });
      await setTabEnabledUI(options, tabId, false);
      await page.waitForFunction(sources => [...document.querySelectorAll('main p')].every((p, i) => p.textContent === sources[i]) && !document.querySelector('at-translation-text'), dom.sources);
      report.runs.push({ shape, width, dom, host, sourceCounts: counted.counts, exactRestore: true });
      await writeFile(join(output, 'page-fragments.json'), JSON.stringify(report, null, 2));
      console.log('[page-fragments]', shape, width, JSON.stringify({ previewMs: dom.firstPreviewMs, completeMs: dom.completeMs, maximum: host.maximum, sourceCounts: counted.counts }));
      await page.close();
    }
    const page = await context.newPage();
    await page.goto(`${origin}/single-cancel`);
    const sources = await page.locator('main p').allTextContents();
    const tabId = await tabIdFor(options, page);
    await setTabEnabledUI(options, tabId, true);
    await page.bringToFront();
    await page.waitForSelector('at-translation-text[data-streaming="true"]', { timeout: 60000 });
    await setTabEnabledUI(options, tabId, false);
    await page.waitForFunction(sources => [...document.querySelectorAll('main p')].every((p, i) => p.textContent === sources[i]) &&
      !document.querySelector('at-translation-text'), sources);
    await options.waitForFunction(async () => {
      const status = await AT.sendMessage({ type: AT.C.MSG.LOCAL_GET_STATUS });
      return status.ok && status.status?.state === 'ready';
    });
    report.cancelled = { exactRestore: true, residualAuroras: await page.locator('at-translation-text').count() };
    await page.screenshot({ path: join(output, 'page-fragments-cancelled.png') });
    await page.close();
  } finally {
    await writeFile(join(output, 'page-fragments.json'), JSON.stringify(report, null, 2));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

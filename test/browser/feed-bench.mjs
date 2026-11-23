// Does dynamically added DOM get slower as more of it is translated?
// A feed appends paragraphs in waves; the page stamps each paragraph's
// completion time in its own clock, so a slope is visible per wave.
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, launchOptions, ROOT } from './support.mjs';
import { optionsReady, tabIdFor } from '../native-extension/tab-control.mjs';

const OUT = join(ROOT, 'test-results/browser/dynamic-feed');
const WAVES = Number(process.env.WAVES || 60);
const PER_WAVE = Number(process.env.PER_WAVE || 4);
const WAVE_MS = Number(process.env.WAVE_MS || 300);
const SENTENCE = '今日は配信を見ながら新しいゲームの話をしていました。とても楽しい時間でした。';
await mkdir(OUT, { recursive: true });

const page_script = `
const feed = document.getElementById('feed');
window.__waves = [];
let wave = 0;
const perWave = ${JSON.stringify(PER_WAVE)};
const total = ${JSON.stringify(WAVES)};
const sentence = ${JSON.stringify(SENTENCE)};
const timer = setInterval(() => {
  wave += 1;
  const started = performance.now();
  const nodes = [];
  for (let index = 0; index < perWave; index += 1) {
    const p = document.createElement('p');
    p.textContent = sentence + ' 第' + wave + '-' + index + '回';
    p.dataset.wave = String(wave);
    feed.append(p);
    nodes.push(p);
  }
  window.__waves.push({ wave, started, nodes });
  if (wave >= total) clearInterval(timer);
}, ${JSON.stringify(WAVE_MS)});
const seen = new IntersectionObserver((entries) => {
  for (const entry of entries) if (entry.isIntersecting && !entry.target.dataset.seenAt) entry.target.dataset.seenAt = String(performance.now());
});
window.__seen = seen;
new MutationObserver((records) => {
  for (const record of records) {
    if (record.type === 'childList') for (const node of record.addedNodes) if (node.nodeType === 1) seen.observe(node);
  }
  for (const record of records) {
    const node = record.target.nodeType === 3 ? record.target.parentElement : record.target;
    const paragraph = node && node.closest ? node.closest('#feed p') : null;
    if (!paragraph || paragraph.dataset.doneAt) continue;
    if (/[\\uac00-\\ud7a3]/.test(paragraph.textContent || '')) paragraph.dataset.doneAt = String(performance.now());
  }
}).observe(feed, { childList: true, subtree: true, characterData: true });
`;

const server = await new Promise((resolve) => {
  const created = createHttpServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html lang="ja"><meta charset="utf-8"><title>feed</title><body><main id="feed"></main><script>${page_script}</script></body></html>`);
  });
  created.listen(0, '127.0.0.1', () => resolve(created));
});
const origin = `http://127.0.0.1:${server.address().port}`;

const work = await mkdtemp(join(tmpdir(), 'at-feed-'));
const extension = join(work, 'extension');
await cp(join(ROOT, 'build/chrome'), extension, { recursive: true });
const report = { waves: WAVES, perWave: PER_WAVE, samples: [], errors: [] };
let context;
try {
  context = await chromium.launchPersistentContext(join(work, 'profile'), {
    ...launchOptions, headless: false, viewport: null, locale: 'ja-JP',
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [...launchOptions.args.filter(arg => arg !== '--disable-gpu'), '--use-webgpu-adapter=apple',
      '--enable-precise-memory-info',
      `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-first-run', '--no-default-browser-check']
  });
  context.setDefaultTimeout(240000);
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 30000 });
  const id = worker.url().split('/')[2];
  const options = await context.newPage();
  await options.goto(`chrome-extension://${id}/options.html`);
  await optionsReady(options);
  await options.waitForFunction(() => document.querySelector('#glossarySection').dataset.ready === 'true');
  await options.locator('#modelFile').setInputFiles(['model_q4f16.onnx', 'tokenizer.json', 'tokenizer_config.json', 'config.json', 'generation_config.json', 'chat_template.jinja']
    .map(name => join(ROOT, 'weight/plamo-3-translate-0.8b-onnx', name)));
  await options.waitForFunction(() => ['ok', 'error'].includes(document.querySelector('#modelStatus')?.dataset.kind ?? ''), null, { timeout: 420000 });
  await options.evaluate(async () => {
    await AT.settings.save({ enabled: true, sourceLang: 'auto', targetLang: 'ko', translationConcurrency: 4, translationRendering: 'immediate', siteRules: [], alwaysTranslateLanguages: [] });
  });

  const page = await context.newPage();
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(300);
  const tabId = await tabIdFor(options, page);
  const started = Date.now();
  await options.evaluate(async id => { await AT.sendMessage({ type: AT.C.MSG.SET_TAB_ENABLED, tabId: id, enabled: true }); }, tabId);

  const total = WAVES;
  const deadline = Date.now() + Number(process.env.RUN_MS || 45000);
  let scrolling = setInterval(() => { void page.evaluate(() => window.scrollBy(0, innerHeight * 0.8)).catch(() => {}); }, 500);
  while (Date.now() < deadline) {
    await page.waitForTimeout(500);
    const state = await page.evaluate(() => {
      const latencies = [];
      for (const entry of window.__waves) {
        const finished = entry.nodes.map(node => Number(node.dataset.doneAt || 0)).filter(at => at > 0).sort((a, b) => a - b);
        const seenAt = Math.max(...entry.nodes.map(node => Number(node.dataset.seenAt || 0)));
        if (finished.length === entry.nodes.length) latencies.push({ wave: entry.wave, ms: Math.round(finished[finished.length - 1] - Math.max(entry.started, seenAt)) });
      }
      return { latencies, doneWaves: latencies.length, heap: performance.memory ? performance.memory.usedJSHeapSize : null, nodes: document.querySelectorAll('#feed p').length };
    });
    report.samples.push({ at: Date.now() - started, ...state });
  }
  clearInterval(scrolling);
  report.ms = Date.now() - started;
  const last = report.samples.at(-1) ?? { latencies: [], heap: null };
  report.latencies = last.latencies;
  report.doneWaves = last.doneWaves;
  report.heapStart = report.samples[0]?.heap ?? null;
  report.heapEnd = last.heap ?? null;
  const seenWaves = report.samples.at(-1) ? await page.evaluate(() => window.__waves.filter(entry => entry.nodes.every(node => Number(node.dataset.seenAt || 0) > 0)).length) : 0;
  report.seenWaves = seenWaves;
  report.parked = await page.evaluate(() => [...document.querySelectorAll('#feed p')].filter(node => !/[\uac00-\ud7a3]/.test(node.textContent || '')).length);
  const heaps = report.samples.map(sample => sample.heap).filter(value => typeof value === 'number');
  report.heapMax = heaps.length ? Math.max(...heaps) : null;
  await page.screenshot({ path: join(OUT, 'feed.png') });
} catch (error) {
  report.errors.push(String(error?.stack ?? error).split('\n').slice(0, 4).join('\n'));
} finally {
  await writeFile(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  await context?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(work, { recursive: true, force: true });
}
const lat = report.latencies ?? [];
const median = list => { const sorted = [...list].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null; };
console.log(JSON.stringify({
  doneWaves: report.doneWaves, seenWaves: report.seenWaves, parked: report.parked, of: WAVES, ms: report.ms,
  first5: lat.slice(0, 5).map(entry => entry.ms),
  wave20to24: lat.slice(19, 24).map(entry => entry.ms),
  last5: lat.slice(-5).map(entry => entry.ms),
  median: median(lat.map(entry => entry.ms)),
  heapStartMB: report.heapStart ? Math.round(report.heapStart / 1e6) : null,
  heapEndMB: report.heapEnd ? Math.round(report.heapEnd / 1e6) : null,
  heapMaxMB: report.heapMax ? Math.round(report.heapMax / 1e6) : null,
  errors: report.errors
}, null, 2));

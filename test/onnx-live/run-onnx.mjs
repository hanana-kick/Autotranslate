// Live verification of the ONNX (q4f16) on-device path: the real published
// card, the real shipped options UI, the real background/offscreen split and
// real WebGPU. Not part of `npm test` and not part of CI: it downloads 706 MB
// and needs a GPU with shader-f16.
//
//   npm run build
//   node test/onnx-live/run-onnx.mjs
//   YOUTUBE=1 node test/onnx-live/run-onnx.mjs   # adds a paused watch page
//
// What it proves, in the order the product reaches it:
//   1. the options download route stores the q4f16 graph and its five parts;
//   2. the first load is routed to AT.onnxhost (the GGUF host's file sniff
//      fails an ONNX graph, so a misroute is visible as "No model format
//      matched" rather than as a wrong answer);
//   3. the host answers at/local-count, so batches are packed per real tokens
//      instead of the per-script estimate;
//   4. a four-sequence page comes back in the target language and restores to
//      the exact original text when the tab is turned off.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, cp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, launchOptions, ROOT, OUTPUT } from '../browser/support.mjs';
import { optionsReady, setTabEnabledUI, tabIdFor } from '../native-extension/tab-control.mjs';

const CARD = 'https://huggingface.co/TeamFlaxia/plamo-3-translate-0.8b-onnx/resolve/main/onnx/model_q4f16.onnx';
// The card the page prefills; the harness fails if the two ever disagree.
const MODEL_URL = process.env.MODEL_URL || CARD;
const PAGE_SECONDS = Number(process.env.PAGE_SECONDS || 240000);
const summary = { chrome: null, adapter: null, install: null, page: null, countWarnings: 0, misroutes: 0, youtube: null, errors: [] };

const body =
  '<h1>Grid storage in winter</h1>' +
  '<p>Batteries keep the grid stable at night by storing the surplus power generated at noon.</p>' +
  '<p>Wind turbines produce more power in winter because cold air is denser.</p>' +
  '<p>Operators forecast demand hour by hour and hold reserve capacity for sudden clouds.</p>' +
  '<p>Solar panels lose efficiency when snow covers their surface.</p>';
const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(body);
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;

const report = join(OUTPUT, 'onnx-q4f16-live.json');
process.on('uncaughtException', (error) => {
  summary.failure = String(error?.message ?? error);
  summary.consoleTail = console_.slice(-20);
  void writeFile(report, JSON.stringify(summary, null, 2));
});

const temporary = await mkdtemp(join(tmpdir(), 'onnx-live-'));
const extension = join(temporary, 'extension');
await cp(join(ROOT, 'build/chrome'), extension, { recursive: true });

const context = await chromium.launchPersistentContext(join(temporary, 'profile'), {
  ...launchOptions,
  // WebGPU needs the GPU process; the shared options disable it for the
  // deterministic suites, which never reach a real adapter.
  ignoreDefaultArgs: [...launchOptions.ignoreDefaultArgs ?? [], '--disable-extensions', '--disable-gpu'],
  args: [
    ...launchOptions.args.filter((arg) => arg !== '--disable-gpu'),
    '--enable-unsafe-webgpu',
    ...(process.platform === 'darwin' ? ['--use-webgpu-adapter=apple'] : []),
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`
  ],
  viewport: { width: 1100, height: 800 },
  locale: 'en-US'
});
context.setDefaultTimeout(30000);

const console_ = [];
context.on('page', (page) => page.on('pageerror', (error) => summary.errors.push({ url: page.url(), error: error.message })));
// The offscreen document logs the host's own progress; VERBOSE=1 shows it.
if (process.env.VERBOSE === '1') context.on('console', (message) => console.log('[ctx]', message.text().slice(0, 220)));

let worker = context.serviceWorkers()[0];
if (!worker) {
  const blank = await context.newPage();
  await blank.goto('about:blank').catch(() => {});
  try {
    worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
  } catch {
    worker = context.serviceWorkers()[0];
  }
  await blank.close().catch(() => {});
}
assert.ok(worker, 'the extension registered a service worker');
worker.on('console', (message) => {
  const text = message.text();
  if (process.env.VERBOSE === '1') console.log('[sw]', text.slice(0, 220));
  console_.push(text);
  if (text.includes('No model format matched')) summary.misroutes += 1;
  if (text.includes('the host did not count tokens')) summary.countWarnings += 1;
});

const extensionId = new URL(worker.url()).host;
const options = await context.newPage();
await options.goto(`chrome-extension://${extensionId}/options.html`);
await optionsReady(options);
summary.chrome = context.browser()?.version() ?? null;
summary.adapter = await options.evaluate(async () => {
  const adapter = await navigator.gpu?.requestAdapter?.();
  return adapter ? { arch: adapter.info?.architecture, vendor: adapter.info?.vendor, f16: adapter.features.has('shader-f16') } : null;
});
assert.ok(summary.adapter?.f16, 'the adapter must expose shader-f16 for a q4f16 graph');

// 1. The shipped download route, with the url the page prefilled: this is what
// a user sees on a fresh profile. MODEL_URL only overrides the address.
await options.waitForFunction((expected) => document.querySelector('#modelUrl')?.value === expected, MODEL_URL, { timeout: 15000 });
console.log('[install] downloading', MODEL_URL);
const startedInstall = Date.now();
await options.locator('#downloadModel').click();
await options.waitForFunction(
  () => document.querySelector('#modelStatus')?.dataset.kind === 'ok' || document.querySelector('#modelStatus')?.dataset.kind === 'error',
  null,
  { timeout: 600000 }
);
console.log('[install] done', Date.now() - startedInstall, 'ms');
const status = await options.evaluate(() => ({
  kind: document.querySelector('#modelStatus')?.dataset.kind,
  text: document.querySelector('#modelStatus')?.textContent ?? '',
  modelId: document.querySelector('#localModel')?.value ?? ''
}));
summary.install = { url: MODEL_URL, ...status };
console.log('[install]', status.kind, status.text);
assert.equal(status.kind, 'ok', `install reported: ${status.text}`);

// 2-4. A four-sequence page through the shipped per-tab switch.
const page = await context.newPage();
await page.goto(origin + '/', { waitUntil: 'load' });
const before = await page.evaluate(() => [...document.querySelectorAll('p')].map((p) => p.textContent));
const tabId = await tabIdFor(options, page);
await setTabEnabledUI(options, tabId, true);
const started = Date.now();
let translated = 0;
let host = null;
let tick = 0;
while (Date.now() - started < PAGE_SECONDS) {
  translated = await page.evaluate(() => [...document.querySelectorAll('p')].filter((p) => /[\uAC00-\uD7AF]/.test(p.textContent ?? '')).length);
  if (translated === before.length) break;
  host = await options.evaluate(() => AT.sendMessage({ type: AT.C.MSG.LOCAL_GET_STATUS })).catch(() => null);
  if (host?.status?.state === 'failed') break;
  if (++tick % 10 === 0) console.log('[page]', Math.round((Date.now() - started) / 1000) + 's', translated + '/' + before.length, host?.status?.state ?? '?');
  await new Promise((done) => setTimeout(done, 1000));
}
const after = await page.evaluate(() => [...document.querySelectorAll('p')].map((p) => p.textContent));
console.log('[page] finished', translated + '/' + before.length, 'after', Math.round((Date.now() - started) / 1000) + 's');
summary.page = {
  tabId, sequences: before.length, translated,
  seconds: Math.round((Date.now() - started) / 1000),
  host: host?.status ?? null, after
};
assert.equal(translated, before.length, 'every paragraph must be translated');

await setTabEnabledUI(options, tabId, false);
await page.waitForFunction((originals) => [...document.querySelectorAll('p')].every((p, index) => p.textContent === originals[index]), before, { timeout: 30000 });
summary.page.restored = true;

// 5. Optional live watch page: playback stopped for the whole run.
if (process.env.YOUTUBE === '1') {
  const watch = await context.newPage();
  await watch.goto('https://www.youtube.com/watch?v=jNQXAC9IVRw', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await watch.waitForTimeout(5000);
  await watch.evaluate(() => document.querySelector('video')?.pause()).catch(() => {});
  const watchId = await tabIdFor(options, watch);
  await setTabEnabledUI(options, watchId, true);
  const ytStarted = Date.now();
  let ko = false;
  console.log('[youtube] watching', watch.url().slice(0, 60));
  while (Date.now() - ytStarted < PAGE_SECONDS) {
    ko = await watch.evaluate(() => /[\uAC00-\uD7AF]/.test(document.querySelector('#description-inline-expander, ytd-text-inline-expander')?.textContent ?? ''));
    if (ko) break;
    const elapsed = Math.round((Date.now() - ytStarted) / 1000);
    if (elapsed % 20 < 3) console.log('[youtube]', elapsed + 's', ko ? 'ko' : 'en');
    await new Promise((done) => setTimeout(done, 2000));
  }
  summary.youtube = {
    seconds: Math.round((Date.now() - ytStarted) / 1000),
    descriptionTranslated: ko,
    paused: await watch.evaluate(() => document.querySelector('video')?.paused ?? null)
  };
  await setTabEnabledUI(options, watchId, false);
  assert.ok(ko, 'a public watch page description must translate');
  assert.equal(summary.youtube.paused, true, 'playback stays stopped');
}

summary.misroutes = console_.filter((line) => line.includes('No model format matched')).length;
summary.countWarnings = console_.filter((line) => line.includes('the host did not count tokens')).length;
summary.consoleTail = console_.slice(-20);
await mkdir(OUTPUT, { recursive: true });
await writeFile(report, JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ report, ...summary }, null, 2));
await context.close().catch(() => {});
server.close();
assert.equal(summary.misroutes, 0, 'the first load must not reach the GGUF host');
assert.equal(summary.countWarnings, 0, 'the ONNX host must answer at/local-count');
assert.deepEqual(summary.errors, [], 'no page errors');

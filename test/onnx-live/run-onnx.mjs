// Live verification of the ONNX (q4f16) on-device path: the shipped options
// download route, the real background/offscreen split, real WebGPU, and a page
// that must come back in the target language and restore exactly.
//
//   npm run build
//   npm run test:onnx                     # downloads the published card once
//   MODEL_DIR=weight/plamo-3-translate-0.8b-onnx npm run test:onnx
//   PROFILE_DIR=<dir> npm run test:onnx   # reuse an installed model
//   YOUTUBE=1 ...                         # adds a paused watch page
//
// MODEL_DIR serves that directory over a local https origin, so the shipped
// route still runs (fetch, byte-count check, OPFS write, parts by name) with the
// network out of the picture. A blocked or slow CDN must not decide whether a
// measurement is possible.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, cp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, launchOptions, ROOT, OUTPUT } from '../browser/support.mjs';
import { optionsReady, setTabEnabledUI, tabIdFor } from '../native-extension/tab-control.mjs';

const CARD = 'https://huggingface.co/TeamFlaxia/plamo-3-translate-0.8b-onnx/resolve/main/onnx/model_q4f16.onnx';
const GRAPH = 'model_q4f16.onnx';
const MODEL_DIR = process.env.MODEL_DIR ? resolve(process.env.MODEL_DIR) : '';
const PROFILE_DIR = process.env.PROFILE_DIR ? resolve(process.env.PROFILE_DIR) : '';
const MODEL_URL = process.env.MODEL_URL || CARD;
const PAGE_SECONDS = Number(process.env.PAGE_SECONDS || 240000);
const summary = {
  chrome: null, adapter: null, install: null, page: null,
  countWarnings: 0, misroutes: 0, youtube: null, errors: []
};

const body =
  '<h1>Grid storage in winter</h1>' +
  '<p>Batteries keep the grid stable at night by storing the surplus power generated at noon.</p>' +
  '<p>Wind turbines produce more power in winter because cold air is denser.</p>' +
  '<p>Operators forecast demand hour by hour and hold reserve capacity for sudden clouds.</p>' +
  '<p>Solar panels lose efficiency when snow covers their surface.</p>';
const site = createHttpServer((request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(body);
});
await new Promise((done) => site.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${site.address().port}`;

await mkdir(OUTPUT, { recursive: true });
const report = join(OUTPUT, 'onnx-q4f16-live.json');
const console_ = [];
/** Evidence first, then a non-zero exit: a run that fails must not hang here
 *  holding a browser and two listeners open. */
function abort(error) {
  summary.failure = String(error?.message ?? error);
  summary.consoleTail = console_.slice(-20);
  void writeFile(report, JSON.stringify(summary, null, 2)).finally(() => process.exit(1));
}
process.on('uncaughtException', abort);
process.on('unhandledRejection', abort);

/** Serves a model directory over https with a throwaway certificate. The caller
 *  closes it: an open listener keeps this process alive long after the run. */
async function serveModelDirectory(dir, work) {
  const key = join(work, 'key.pem');
  const cert = join(work, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=127.0.0.1'
  ], { stdio: 'ignore' });
  const server = createHttpsServer({ key: await readFile(key), cert: await readFile(cert) }, async (request, response) => {
    const name = (request.url ?? '/').split('/').filter(Boolean).pop() ?? '';
    const file = join(dir, name || GRAPH);
    try {
      const size = (await stat(file)).size;
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(size) });
      createReadStream(file).pipe(response);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    origin: `https://127.0.0.1:${port}`,
    close: () => new Promise((done) => {
      server.closeAllConnections?.();
      server.close(() => done(undefined));
    })
  };
}

const temporary = await mkdtemp(join(tmpdir(), 'onnx-live-'));
const profile = PROFILE_DIR || join(temporary, 'profile');
await mkdir(profile, { recursive: true });
const modelServer = MODEL_DIR ? await serveModelDirectory(MODEL_DIR, temporary) : null;
const localOrigin = modelServer?.origin ?? '';
if (localOrigin) console.log('[model] serving', MODEL_DIR, 'at', localOrigin);

// An unpacked extension's id comes from its own path, and so does the origin the
// model is stored under: a reused profile has to keep the extension where it
// was, or every run looks like a fresh install with an empty store.
const extension = PROFILE_DIR ? join(profile, 'extension') : join(temporary, 'extension');
await rm(extension, { recursive: true, force: true });
await cp(join(ROOT, 'build/chrome'), extension, { recursive: true });
console.log('[build] extension copied', PROFILE_DIR ? '(stable path for reuse)' : '');

const context = await chromium.launchPersistentContext(profile, {
  ...launchOptions,
  // HEADED=1 opens a real window: a visible browser is the whole point when the
  // question is "does this work in a browser", and headed is also what the sites
  // run uses because some pages refuse a headless one.
  headless: process.env.HEADED === '1' ? false : launchOptions.headless,
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
  locale: 'en-US',
  ...(localOrigin ? { ignoreHTTPSErrors: true } : {})
});
context.setDefaultTimeout(30000);
context.on('page', (page) => {
  page.on('pageerror', (error) => summary.errors.push({ url: page.url(), error: error.message }));
});
if (process.env.VERBOSE === '1') context.on('console', (message) => console.log('[ctx]', message.text().slice(0, 220)));
if (localOrigin) {
  const card = new URL(CARD);
  const base = CARD.slice(0, CARD.lastIndexOf('/') + 1);
  // The car's parts live beside it, so every request under that directory is
  // answered from the directory on disk, keeping the shipped shape intact.
  await context.route(`${base}**`, (route) => {
    const name = new URL(route.request().url()).pathname.split('/').filter(Boolean).pop() ?? GRAPH;
    return route.continue({ url: `${localOrigin}/onnx/${name}` });
  });
  void card;
}

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

// 1. Install through the shipped route: the prefilled card on a fresh profile,
// or the local directory, or a profile that already holds the model.
const startedInstall = Date.now();
const reuse = PROFILE_DIR
  ? await options.evaluate(async () => {
    const models = await AT.modelstore.list().catch(() => []);
    const installed = models.find((model) => /onnx/.test(model.name));
    if (!installed) return null;
    await AT.settings.save({ localModelId: installed.id });
    return installed.name;
  })
  : null;
if (reuse) {
  console.log('[install] reusing', reuse, 'from the profile');
} else {
  await options.waitForFunction((expected) => document.querySelector('#modelUrl')?.value === expected, MODEL_URL, { timeout: 15000 });
  console.log('[install] downloading', MODEL_URL, localOrigin ? '(from ' + localOrigin + ')' : '');
  await options.locator('#downloadModel').click();
  const installWatch = setInterval(() => {
    void options.evaluate(() => ({
      kind: document.querySelector('#modelStatus')?.dataset.kind ?? null,
      text: (document.querySelector('#modelStatus')?.textContent ?? '').slice(0, 60),
      progress: document.querySelector('#modelProgress')?.value ?? null
    })).then((value) => console.log('[install] watching', JSON.stringify(value))).catch(() => {});
  }, 5000);
  await options.waitForFunction(
    () => document.querySelector('#modelStatus')?.dataset.kind === 'ok' || document.querySelector('#modelStatus')?.dataset.kind === 'error',
    null,
    { timeout: 600000 }
  );
  clearInterval(installWatch);
}
const status = await options.evaluate(() => ({
  kind: document.querySelector('#modelStatus')?.dataset.kind ?? null,
  text: document.querySelector('#modelStatus')?.textContent ?? '',
  modelId: document.querySelector('#localModel')?.value ?? ''
}));
summary.install = { url: MODEL_URL, reused: Boolean(reuse), local: localOrigin || null, ...status };
console.log('[install]', reuse ? 'reused' : status.kind, status.text || reuse || '', Date.now() - startedInstall, 'ms');
assert.ok(reuse || status.kind === 'ok', `install reported: ${status.text}`);

// 2-4. A four-sequence page through the shipped per-tab switch.
// The shipped default target follows the browser's UI language, which a driver
// cannot depend on, so the page's target is chosen here: the page is English.
const target = 'ko';
await options.evaluate((code) => AT.settings.save({ targetLang: code, sourceLang: 'en' }), target);
summary.target = target;
const page = await context.newPage();
await page.goto(origin + '/', { waitUntil: 'load' });
const before = await page.evaluate(() => [...document.querySelectorAll('p')].map((p) => p.textContent));
const tabId = await tabIdFor(options, page);
await setTabEnabledUI(options, tabId, true);
console.log('[toggle]', Date.now());
const started = Date.now();
let translated = 0;
let host = null;
let tick = 0;
while (Date.now() - started < PAGE_SECONDS) {
  translated = await page.evaluate(() => [...document.querySelectorAll('p')].filter((p) => /[\uAC00-\uD7AF]/.test(p.textContent ?? '')).length);
  if (translated === before.length) break;
  host = await options.evaluate(() => AT.sendMessage({ type: AT.C.MSG.LOCAL_GET_STATUS })).catch(() => null);
  const content = await options.evaluate(async (id) => AT.api.tabs.sendMessage(id, { type: AT.C.MSG.CONTENT_STATE }), tabId).catch(() => null);
  summary.page ??= {};
  summary.page.content = content ?? null;
  if (++tick % 5 === 0) {
    console.log('[page]', Math.round((Date.now() - started) / 1000) + 's', translated + '/' + before.length,
      host?.status?.state ?? '?', 'content', JSON.stringify(summary.page?.content ?? null).slice(0, 160));
  }
  if (host?.status?.state === 'failed' || content?.error) break;
  await new Promise((done) => setTimeout(done, 1000));
}
const after = await page.evaluate(() => [...document.querySelectorAll('p')].map((p) => p.textContent));
summary.page = {
  tabId, sequences: before.length, translated, after,
  body: await page.evaluate(() => document.body.innerText.slice(0, 240)),
  seconds: Math.round((Date.now() - started) / 1000),
  host: host?.status ?? null
};
console.log('[page] finished', translated + '/' + before.length, 'after', summary.page.seconds + 's');
if (translated !== before.length) summary.page.failure = 'not every paragraph came back translated';

await setTabEnabledUI(options, tabId, false);
await page.waitForFunction((originals) => [...document.querySelectorAll('p')].every((p, index) => p.textContent === originals[index]), before, { timeout: 30000 });
summary.page.restored = true;

// 5. Optional live watch page: playback stopped for the whole run.
if (process.env.YOUTUBE === '1') {
  const watch = await context.newPage();
  await watch.goto('https://www.youtube.com/watch?v=ywN3cX4VEII&hl=ja', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await watch.waitForTimeout(5000);
  await watch.evaluate(() => document.querySelectorAll('video').forEach((video) => video.pause())).catch(() => {});
  const watchId = await tabIdFor(options, watch);
  await setTabEnabledUI(options, watchId, true);
  const ytStarted = Date.now();
  let ko = false;
  while (Date.now() - ytStarted < PAGE_SECONDS) {
    await watch.evaluate(() => document.querySelectorAll('video').forEach((video) => video.pause())).catch(() => {});
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

summary.countWarnings = console_.filter((line) => line.includes('the host did not count tokens')).length;
summary.emptySegments = console_.filter((line) => line.includes('empty translation segment')).length;
summary.consoleTail = console_.slice(-20);
await writeFile(report, JSON.stringify(summary, null, 2));
// Everything the run opened is released before anything is asserted: a failed
// run must not leave a window holding the profile, and an open listener must
// not keep this process alive after a passing one.
await context.close().catch(() => {});
site.close();
await modelServer?.close();
console.log(JSON.stringify({ report, target: summary.target, seconds: summary.page.seconds, translated: summary.page.translated, generations: summary.page.host.generations }, null, 2));
assert.equal(summary.page.translated, summary.page.sequences, 'every paragraph must come back translated');
assert.equal(summary.countWarnings, 0, 'the ONNX host must answer at/local-count');
assert.deepEqual(summary.errors, [], 'no page errors');

// Live verification of the ONNX (q4f16) on-device path: the shipped options
// download route, the real background/offscreen split, real WebGPU, and a page
// that must come back in the target language and restore exactly.
//
//   npm run build
//   npm run test:onnx                     # downloads the published card once
//   MODEL_DIR=weight/plamo-3-translate-0.8b-onnx npm run test:onnx
//   PROFILE_DIR=<dir> npm run test:onnx   # reuse an installed model
//   YOUTUBE=1 ...                         # adds a paused watch page
//   YOUTUBE_COMMENTS=1 YOUTUBE_URL=<url>   # scroll/reply selection and latency evidence
//   VISUAL_ORDER=1 ...                    # CSS-reordered reading-order evidence
//   AURORA=1 ...                          # real pending/revealed web-component evidence
//   STREAMING=1 ...                       # real token-preview/fade/frame evidence
//   EXTENSION_DIR=<dir> ...               # a preserved shipped build for comparison
//   VISUAL_ORDER_ASSERT=0 ...             # record a known-bad baseline without order assertions
//   PROBE_ENGINE_FAILURE=1 ...            # ships an engine that cannot start: the
//                                         # page must still translate, one at a time
//   TWO_TABS=1 ...                        # two pages at once: their requests must
//                                         # share steps, which one page never does
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
const VISUAL_ORDER = process.env.VISUAL_ORDER === '1';
const STREAMING = process.env.STREAMING === '1';
const AURORA = process.env.AURORA === '1' || STREAMING;
const VISUAL_ORDER_ASSERT = process.env.VISUAL_ORDER_ASSERT !== '0';
const EXTENSION_DIR = resolve(process.env.EXTENSION_DIR || join(ROOT, 'build/chrome'));
const summary = {
  chrome: null, adapter: null, install: null, page: null,
  countWarnings: 0, misroutes: 0, youtube: null, errors: []
};

const SENTENCES = [
  'Batteries keep the grid stable at night by storing the surplus power generated at noon.',
  'Wind turbines produce more power in winter because cold air is denser.',
  'Operators forecast demand hour by hour and hold reserve capacity for sudden clouds.',
  'Solar panels lose efficiency when snow covers their surface.'
];
// PARAGRAPHS widens the page for the batch benchmark: every paragraph is
// distinct, so none is answered from the page's own cache.
const paragraphs = Math.max(4, Number(process.env.PARAGRAPHS) || 4);
const body =
  '<h1>Grid storage in winter</h1>' +
  Array.from({ length: paragraphs }, (_unused, index) => `<p>Paragraph ${index + 1}. ${SENTENCES[index % SENTENCES.length]}</p>`).join('');
// Keep the benchmark above unchanged. This separate opt-in page deliberately
// disagrees with DOM order, including an early sidebar and a late title.
const visualUnits = [
  { id: 'title', tag: 'h1', text: 'How winter electricity reaches our homes' },
  { id: 'body-1', tag: 'p', text: 'At dawn, stored energy keeps the lights on while families prepare breakfast.' },
  { id: 'body-2', tag: 'p', text: 'By noon, solar farms refill the batteries with surplus electricity.' },
  { id: 'section', tag: 'h2', text: 'Preparing the network for colder weather' },
  { id: 'body-3', tag: 'p', text: 'Cold air helps wind turbines generate more power during the winter months.' },
  { id: 'body-4', tag: 'p', text: 'Operators review demand forecasts before scheduling additional reserve capacity.' },
  { id: 'body-5', tag: 'p', text: 'Local crews inspect cables and replace damaged equipment before the first snowfall.' },
  { id: 'body-6', tag: 'p', text: 'After sunset, the stored supply supports hospitals and railway stations.' },
  { id: 'body-7', tag: 'p', text: 'Households can reduce peak demand by delaying laundry until later in the evening.' },
  { id: 'body-8', tag: 'p', text: 'Reliable storage connects these daily changes into a stable electricity system.' }
];
const visualBody = `<!doctype html><html lang="en"><head><meta charset="utf-8">
  <title translate="no">Visual reading order regression</title><style>
  body{margin:24px;font:18px/1.45 system-ui;display:grid;grid-template-columns:minmax(0,740px) 240px;gap:28px}
  main{grid-column:1;grid-row:1;display:flex;flex-direction:column}aside{grid-column:2;grid-row:1}
  main>*{margin:0 0 12px}h1{font-size:27px}h2{font-size:23px}aside{font-size:16px}
  </style></head><body><aside><h2 data-visual="sidebar-title">Other stories to explore</h2>
  <p data-visual="sidebar-body">A coastal town builds a new visitor center beside the harbor.</p></aside><main>
  ${visualUnits.map((unit, index) => ({ ...unit, index })).reverse().map(({ id, tag, text, index }) =>
    `<${tag} data-visual="${id}" style="order:${index}">${text}</${tag}>`).join('')}
  </main></body></html>`;
const site = createHttpServer((request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  const fixture = AURORA ? `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <title translate="no">Aurora translation review</title><style>
    body{max-width:760px;margin:64px auto;padding:0 28px;color:#203044;background:#fbfcfe;font:20px/1.75 system-ui}
    h1{font-size:34px;line-height:1.3;letter-spacing:-.025em;margin-bottom:30px}p{margin:24px 0}
    </style></head><body>${body}</body></html>` : body;
  response.end(new URL(request.url, 'http://localhost').pathname === '/visual-order' ? visualBody : fixture);
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

// Runs in the page's normal world: records DOM writes made by the shipped
// extension, not provider requests or guessed completion order. Stable element
// identities avoid confusing repeated site strings with distinct reading units.
function observeTextApplications(groups) {
  const started = performance.now();
  const units = [];
  const known = new WeakSet();
  const events = [];
  const batches = [];
  const firstApplications = [];
  const box = (rect) => ({ top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height });
  const discover = () => {
    for (const { category, selector } of groups) {
      for (const element of document.querySelectorAll(selector)) {
        if (known.has(element) || !element.textContent.trim()) continue;
        const rect = element.getBoundingClientRect();
        const textBoxes = [];
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        for (let node; (node = walker.nextNode());) {
          if (!node.data.trim() || getComputedStyle(node.parentElement).visibility !== 'visible') continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          const boxes = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0).map(box);
          if (boxes.length) textBoxes.push({ text: node.data, boxes });
        }
        if (!textBoxes.length) continue;
        known.add(element);
        units.push({
          element, id: element.dataset.visual || `${category}-${units.filter((unit) => unit.category === category).length + 1}`,
          category, original: element.textContent, box: box(rect), textBoxes,
          discoveredMs: performance.now() - started, firstAppliedMs: null,
          initiallyVisible: rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight
        });
      }
    }
  };
  discover();
  const initialCount = units.length;
  const translated = (unit) => unit.element.textContent !== unit.original &&
    /[\uAC00-\uD7AF]/.test(unit.element.textContent) && !/[\uAC00-\uD7AF]/.test(unit.original);
  const observer = new MutationObserver((records) => {
    const atMs = performance.now() - started;
    discover();
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      const element = record.target.nodeType === Node.TEXT_NODE ? record.target.parentElement : record.target;
      const unit = units.find((candidate) => candidate.element === element || candidate.element.contains(element));
      if (!unit) continue;
      // A node can be written twice before delivery. The next oldValue is the
      // preceding write's new value; reading .data alone would lose that order.
      const next = record.type === 'characterData'
        ? records.slice(index + 1).find((candidate) => candidate.type === 'characterData' && candidate.target === record.target)
        : null;
      const newText = record.type === 'characterData' ? (next ? next.oldValue : record.target.data) : unit.element.textContent;
      events.push({ sequence: events.length, batch: batches.length, atMs, epochMs: performance.timeOrigin + started + atMs,
        id: unit.id, category: unit.category, type: record.type, oldText: record.oldValue, newText,
        translated: translated(unit) });
      if (unit.firstAppliedMs === null && translated(unit)) {
        unit.firstAppliedMs = atMs;
        firstApplications.push({ id: unit.id, category: unit.category, atMs, sequence: events.length - 1 });
      }
    }
    if (events.length && batches.at(-1)?.eventCount !== events.length) {
      batches.push({ atMs, eventCount: events.length, translatedIds: units.filter(translated).map((unit) => unit.id) });
    }
  });
  observer.observe(document.documentElement, { subtree: true, characterData: true, characterDataOldValue: true, childList: true });
  window.__readingEvidence = {
    snapshot: () => ({
      clock: 'milliseconds since observation immediately before requesting the shipped tab toggle',
      startedEpochMs: performance.timeOrigin + started, elapsedMs: performance.now() - started,
      initialCount, firstContentLatencyMs: firstApplications[0]?.atMs ?? null,
      units: units.map(({ element, ...unit }) => ({ ...unit, current: element.textContent, translated: translated({ ...unit, element }) })),
      events, batches, firstApplications
    }),
    stop: () => observer.disconnect()
  };
}

// Observe the installed content script from the page world. No provider seam,
// model delay, or extension-private state participates in this evidence.
function observeAurora() {
  const started = performance.now();
  const originalHTML = document.body.innerHTML;
  const originalNodes = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) originalNodes.push({ node: walker.currentNode, text: walker.currentNode.data });
  const events = [];
  let maxBusy = 0;
  const snapshot = () => {
    const hosts = [...document.querySelectorAll('at-translation-text')];
    const components = hosts.map((host) => {
      const elements = [host, ...(host.shadowRoot?.querySelectorAll('*') ?? [])];
      const animations = [...new Set(elements.flatMap((element) => element.getAnimations({ subtree: true })))];
      const range = document.createRange(); range.selectNodeContents(host);
      return {
        state: host.dataset.state, busy: host.getAttribute('aria-busy'), text: host.textContent,
        originalText: originalNodes.find(({ node }) => host.contains(node))?.text ?? null,
        slottedOriginal: originalNodes.some(({ node }) => host.shadowRoot?.querySelector('slot')?.assignedNodes().includes(node)),
        activeAnimations: animations.filter((animation) => animation.playState === 'running').length,
        textRects: [...range.getClientRects()].map(({ x, y, width, height }) => ({ x, y, width, height }))
      };
    });
    const busy = components.filter((component) => component.busy === 'true').length;
    maxBusy = Math.max(maxBusy, busy);
    return { elapsedMs: performance.now() - started, count: hosts.length, busy, maxBusy, components,
      states: components.reduce((counts, { state }) => { counts[state] = (counts[state] ?? 0) + 1; return counts; }, {}),
      sameTextNodes: originalNodes.every(({ node }) => document.body.contains(node)),
      exactHTMLRestored: document.body.innerHTML === originalHTML,
      exactTextRestored: originalNodes.every(({ node, text }) => node.data === text) };
  };
  const observer = new MutationObserver(() => {
    const state = snapshot();
    events.push({ elapsedMs: state.elapsedMs, count: state.count, busy: state.busy, states: state.states });
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ['data-state', 'aria-busy'] });
  window.__auroraEvidence = { snapshot, events, stop: () => observer.disconnect() };
}

// Shadow previews must be observed separately: document observers cannot see
// their text and canonical source nodes deliberately remain unchanged.
function observeStreaming() {
  const started = performance.now();
  const entries = new Map(), events = [], frames = [];
  let observerMs = 0, previousFrame = 0, frame = 0, stopped = false;
  const sample = host => {
    const entry = entries.get(host);
    if (!entry) return;
    const text = host.shadowRoot?.querySelector('.preview')?.textContent ?? '';
    if (text === entry.last && host.dataset.state === entry.state) return;
    entry.last = text; entry.state = host.dataset.state;
    const now = performance.now() - started;
    if (host.dataset.streaming === 'true' && text && entry.firstPreviewMs === null) entry.firstPreviewMs = now;
    if (host.dataset.state === 'translated' && entry.completedMs === null) entry.completedMs = now;
    events.push({ id: entry.id, atMs: now, text, source: entry.source, canonical: host.textContent,
      preview: host.dataset.streaming === 'true', busy: host.getAttribute('aria-busy') === 'true',
      state: host.dataset.state, spans: host.shadowRoot?.querySelectorAll('.preview span').length ?? 0 });
  };
  const discover = () => {
    for (const host of document.querySelectorAll('at-translation-text')) {
      if (!entries.has(host)) {
        const entry = { id: entries.size + 1, source: host.textContent, last: null, state: null,
          startedMs: performance.now() - started, firstPreviewMs: null, completedMs: null, observer: null };
        entries.set(host, entry);
        entry.observer = new MutationObserver(() => {
          const before = performance.now(); sample(host); observerMs += performance.now() - before;
        });
        if (host.shadowRoot) entry.observer.observe(host.shadowRoot, { subtree: true, childList: true, characterData: true });
        entry.observer.observe(host, { attributes: true, attributeFilter: ['data-streaming', 'data-state', 'aria-busy'] });
      }
      sample(host);
    }
  };
  const observer = new MutationObserver(() => {
    const before = performance.now(); discover(); observerMs += performance.now() - before;
  });
  observer.observe(document.body, { childList: true, subtree: true });
  const tick = now => {
    if (stopped) return;
    if (previousFrame) frames.push(now - previousFrame);
    previousFrame = now;
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  discover();
  window.__streamEvidence = { events, stop: () => {
    stopped = true; cancelAnimationFrame(frame); observer.disconnect();
    for (const entry of entries.values()) entry.observer.disconnect();
    const sorted = [...frames].sort((a, b) => a - b);
    return { elapsedMs: performance.now() - started, observerMs, events,
      components: [...entries.values()].map(({ observer, last, state, ...entry }) => entry),
      frameIntervals: { count: frames.length, p50: sorted[Math.ceil(sorted.length * .5) - 1] ?? null,
        p95: sorted[Math.ceil(sorted.length * .95) - 1] ?? null, max: sorted.at(-1) ?? null,
        over50Ms: frames.filter(ms => ms > 50).length } };
  } };
}

async function evidenceScreenshot(page, name) {
  const path = join(OUTPUT, `${name}.png`);
  try {
    await page.screenshot({ path, fullPage: true });
    return { path, capturedAt: Date.now() };
  } catch (error) {
    return { path, error: error.message };
  }
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
await cp(EXTENSION_DIR, extension, { recursive: true });
console.log('[build] extension copied', PROFILE_DIR ? '(stable path for reuse)' : '');
summary.extensionSource = EXTENSION_DIR;
// PROBE_ENGINE_FAILURE=1 ships a decode engine that cannot open a session. The
// host must give up on it once, keep answering every request in its own
// document, and say `worker-init` in the status rather than fail the page.
const ENGINE_PROBE = process.env.PROBE_ENGINE_FAILURE === '1';
if (ENGINE_PROBE) {
  await writeFile(
    join(extension, 'hostworker.js'),
    "self.onmessage = (event) => {\n" +
      "  if (event.data?.type !== 'init') return;\n" +
      "  self.postMessage({ type: 'ready', ok: false, error: 'probe: no adapter in this worker', code: 'worker-init' });\n" +
      '};\n'
  );
  console.log('[probe] hostworker.js replaced: the decode engine cannot start');
}

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
    ...(process.env.UNSAFE_WEBGPU === '1' ? ['--enable-unsafe-webgpu'] : []),
    ...(process.platform === 'darwin' ? ['--use-webgpu-adapter=apple'] : []),
    `--disable-extensions-except=${extension}`,
    '--mute-audio',
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
  // The page sets the URL field before it wires its handlers, so a click that
  // lands in between does nothing: click until the status starts moving.
  await options.locator('#downloadModel').click();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const started = await options
      .waitForFunction(
        () => document.querySelector('#modelStatus')?.dataset.kind != null,
        null,
        { timeout: 4000 }
      )
      .then(() => true)
      .catch(() => false);
    if (started) break;
    await options.locator('#downloadModel').click().catch(() => {});
  }
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
let auroraPending;
let streamingCapture;
if (STREAMING) {
  await page.bringToFront();
  await page.evaluate(observeStreaming);
  streamingCapture = (async () => {
    await page.waitForFunction(() => __streamEvidence.events.some(event => event.preview && event.busy &&
      event.canonical === event.source && event.text !== event.source), null, { timeout: PAGE_SECONDS });
    const screenshot = await evidenceScreenshot(page, 'onnx-streaming-preview');
    return { screenshot };
  })().catch(error => ({ error: error.message }));
}
if (AURORA) {
  await page.bringToFront();
  await page.evaluate(observeAurora);
  summary.aurora = { screenshots: {}, initial: await page.evaluate(() => __auroraEvidence.snapshot()) };
  // Start observing before the toggle: even a warm model can finish its first
  // unit while the options UI is still acknowledging the click.
  auroraPending = (async () => {
    await page.waitForFunction(() => document.querySelector('at-translation-text[data-state="translating"][aria-busy="true"]'), null, { timeout: PAGE_SECONDS });
    const pending = await page.evaluate(() => __auroraEvidence.snapshot());
    const screenshot = await evidenceScreenshot(page, 'onnx-aurora-pending');
    const afterScreenshot = await page.evaluate(() => __auroraEvidence.snapshot());
    return { pending, screenshot, afterScreenshot };
  })().catch((error) => ({ error: error.message }));
}
await setTabEnabledUI(options, tabId, true);
console.log('[toggle]', Date.now());
const started = Date.now();
if (AURORA) {
  const captured = await auroraPending;
  summary.aurora.pending = captured.pending ?? null;
  summary.aurora.pendingCaptureError = captured.error ?? null;
  summary.aurora.screenshots.pending = captured.screenshot ?? null;
  summary.aurora.afterPendingScreenshot = captured.afterScreenshot ?? null;
}
let translated = 0;
let host = null;
let tick = 0;
while (Date.now() - started < PAGE_SECONDS) {
  translated = await page.evaluate(() => [...document.querySelectorAll('p')].filter((p) => /[\uAC00-\uD7AF]/.test(p.textContent ?? '')).length);
  if (translated === before.length && (!AURORA || await page.locator('at-translation-text[aria-busy="true"]').count() === 0)) break;
  host = await options.evaluate(() => AT.sendMessage({ type: AT.C.MSG.LOCAL_GET_STATUS })).catch(() => null);
  const content = await options.evaluate(async (id) => AT.api.tabs.sendMessage(id, { type: AT.C.MSG.CONTENT_STATE }), tabId).catch(() => null);
  summary.page ??= {};
  summary.page.content = content ?? null;
  if ((content?.error || content?.status === 'error') && !summary.page.firstError) {
    summary.page.firstError = content;
    console.log('[page] first failure', JSON.stringify(content).slice(0, 400));
  }
  if (++tick % 5 === 0) {
    console.log('[page]', Math.round((Date.now() - started) / 1000) + 's', translated + '/' + before.length,
      host?.status?.state ?? '?', 'content', JSON.stringify(summary.page?.content ?? null).slice(0, 160));
  }
  if (host?.status?.state === 'failed' || content?.error) break;
  await new Promise((done) => setTimeout(done, 1000));
}
// The last status sample can predate the final result; read it once more so
// the reported rates are the session's whole work.
host = (await options.evaluate(() => AT.sendMessage({ type: AT.C.MSG.LOCAL_GET_STATUS })).catch(() => host)) ?? host;
const after = await page.evaluate(() => [...document.querySelectorAll('p')].map((p) => p.textContent));
const lastContent = summary.page?.content ?? null;
const firstError = summary.page?.firstError ?? null;
summary.page = {
  tabId, sequences: before.length, translated, after,
  body: await page.evaluate(() => document.body.innerText.slice(0, 240)),
  seconds: Math.round((Date.now() - started) / 1000),
  host: host?.status ?? null,
  content: lastContent,
  ...(firstError ? { firstError } : {})
};
console.log(
  '[page] finished', translated + '/' + before.length,
  'after', summary.page.seconds + 's',
  'backend', host?.status?.backend ?? '?',
  'rows', host?.status?.rows ?? '?',
  'generations', host?.status?.generations ?? '?',
  'prefill', (host?.status?.prefillTokPerSec ?? '?') + ' tok/s',
  'decode', (host?.status?.decodeTokPerSec ?? '?') + ' tok/s',
  'tokens', (host?.status?.prefillTokens ?? '?') + '/' + (host?.status?.decodeTokens ?? '?')
);
if (translated !== before.length) summary.page.failure = 'not every paragraph came back translated';
if (AURORA) {
  summary.aurora.translated = await page.evaluate(() => __auroraEvidence.snapshot());
  summary.aurora.screenshots.translated = await evidenceScreenshot(page, 'onnx-aurora-translated');
}
if (STREAMING) {
  summary.streaming = { ...await page.evaluate(() => __streamEvidence.stop()), ...await streamingCapture };
}
// A silent fallback would still translate, so the backend is part of the check:
// the shipped build runs the on-device decode on our own kernels.
if (!ENGINE_PROBE) {
  assert.equal(host?.status?.backend, 'kernels', 'the host must answer on the decode kernels');
  assert.ok((host?.status?.rows ?? 0) >= 1, 'the host must report the width of one decode step');
}
if (ENGINE_PROBE) {
  summary.engineProbe = { reason: summary.page.host?.reason ?? null, translated, sequences: before.length };
  console.log('[probe] engine disabled, reason', summary.engineProbe.reason);
  assert.equal(summary.engineProbe.reason, 'worker-init', 'the status names the engine as the reason the page is serial');
}

await setTabEnabledUI(options, tabId, false);
await page.waitForFunction((originals) => [...document.querySelectorAll('p')].every((p, index) => p.textContent === originals[index]), before, { timeout: 30000 });
summary.page.restored = true;
if (AURORA) {
  summary.aurora.restored = await page.evaluate(() => {
    const state = __auroraEvidence.snapshot();
    __auroraEvidence.stop();
    return { ...state, events: __auroraEvidence.events };
  });
  summary.aurora.screenshots.restored = await evidenceScreenshot(page, 'onnx-aurora-restored');
  console.log('[aurora]', JSON.stringify({
    pending: summary.aurora.pending?.states, translated: summary.aurora.translated.states,
    maxBusy: summary.aurora.restored.maxBusy, restored: summary.aurora.restored.exactHTMLRestored
  }));
}

// 4b. Two tabs at once: the engine batches requests that genuinely overlap,
// which one page cannot produce (PAGE_PACKS is 1). TWO_TABS=1 proves it against
// the shipped build: two fixture pages, both enabled, and their request
// intervals must intersect.
if (process.env.TWO_TABS === '1') {
  const secondPage = await context.newPage();
  await secondPage.goto(origin + '/?second', { waitUntil: 'load' });
  await secondPage.bringToFront();
  const secondId = await tabIdFor(options, secondPage);
  // Both pages translating at the same time is the whole point: the first leg
  // disabled its tab while it restored, so switch it back on with the second.
  await setTabEnabledUI(options, secondId, true);
  await setTabEnabledUI(options, tabId, true);
  const bothStarted = Date.now();
  const read = async (id) => {
    const state = await options
      .evaluate((tabId) => AT.api.tabs.sendMessage(tabId, { type: AT.C.MSG.CONTENT_STATE }), id)
      .catch(() => null);
    return state?.bench ?? [];
  };
  let series = { first: [], second: [] };
  // Bounded by wall clock *and* by iterations: a tab whose content script never
  // answers must not turn a timeout into a hang.
  for (let look = 0; look < 60 && Date.now() - bothStarted < 90000; look += 1) {
    series = { first: await read(tabId), second: await read(secondId) };
    if (series.first.length >= 2 && series.second.length >= 2) break;
    await new Promise((done) => setTimeout(done, 1000));
  }
  console.log('[two-tabs] series', JSON.stringify(series));
  const overlaps = [];
  for (const a of series.first) {
    for (const b of series.second) {
      const start = Math.max(a.at, b.at);
      const end = Math.min(a.at + a.ms, b.at + b.ms);
      if (end > start) overlaps.push({ overlapMs: Math.round(end - start), first: { at: a.at, ms: a.ms }, second: { at: b.at, ms: b.ms } });
    }
  }
  summary.twoTabs = {
    first: series.first.map((entry) => ({ at: entry.at, ms: entry.ms, texts: entry.texts })),
    second: series.second.map((entry) => ({ at: entry.at, ms: entry.ms, texts: entry.texts })),
    overlaps
  };
  console.log('[two-tabs]', 'first', JSON.stringify(summary.twoTabs.first), 'second', JSON.stringify(summary.twoTabs.second));
  console.log('[two-tabs] overlapping request pairs', overlaps.length);
  await setTabEnabledUI(options, secondId, false);
  await setTabEnabledUI(options, tabId, false);
  assert.ok(overlaps.length > 0, 'two tabs must have requests in flight at the same time');
  await secondPage.close();
}

// 4c. The same shipped extension and real model, on a separate order fixture.
if (VISUAL_ORDER) {
  const visual = await context.newPage();
  await visual.goto(origin + '/visual-order', { waitUntil: 'load' });
  await visual.bringToFront();
  const visualId = await tabIdFor(options, visual);
  const screenshots = { before: await evidenceScreenshot(visual, 'visual-order-before') };
  await visual.evaluate(observeTextApplications, [
    { category: 'primary', selector: 'main [data-visual]' },
    { category: 'sidebar', selector: 'aside [data-visual]' }
  ]);
  const initial = await visual.evaluate(() => window.__readingEvidence.snapshot());
  summary.visualOrder = { assertionsEnabled: VISUAL_ORDER_ASSERT, initial, screenshots };
  await setTabEnabledUI(options, visualId, true);
  const visualStarted = Date.now();
  let evidence = initial;
  while (Date.now() - visualStarted < PAGE_SECONDS) {
    evidence = await visual.evaluate(() => window.__readingEvidence.snapshot());
    const count = evidence.units.filter((unit) => unit.translated).length;
    if (count > 0 && count < evidence.units.length && !screenshots.partial) {
      screenshots.partial = {
        observedTranslatedIds: evidence.units.filter((unit) => unit.translated).map((unit) => unit.id),
        observedAtMs: evidence.elapsedMs,
        ...await evidenceScreenshot(visual, 'visual-order-partial')
      };
      screenshots.partial.afterCaptureTranslatedIds = await visual.evaluate(() =>
        window.__readingEvidence.snapshot().units.filter((unit) => unit.translated).map((unit) => unit.id));
    }
    if (count === evidence.units.length) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  screenshots.end = await evidenceScreenshot(visual, 'visual-order-translated');
  evidence = await visual.evaluate(() => { window.__readingEvidence.stop(); return window.__readingEvidence.snapshot(); });
  const expectedPrimaryOrder = visualUnits.map(({ id }) => id);
  const renderedPrimaryOrder = initial.units.filter(({ category }) => category === 'primary')
    .sort((a, b) => a.box.top - b.box.top || a.box.left - b.box.left).map(({ id }) => id);
  const domPrimaryOrder = initial.units.filter(({ category }) => category === 'primary').map(({ id }) => id);
  const actualPrimaryOrder = evidence.firstApplications.filter(({ category }) => category === 'primary').map(({ id }) => id);
  const violations = [];
  for (const application of evidence.firstApplications) {
    const preceding = application.category === 'primary'
      ? expectedPrimaryOrder.slice(0, expectedPrimaryOrder.indexOf(application.id))
      : expectedPrimaryOrder;
    const missing = preceding.filter((id) => !evidence.firstApplications.some((earlier) =>
      earlier.id === id && earlier.sequence < application.sequence));
    if (missing.length) violations.push({ applied: application.id, atMs: application.atMs, precedingNotYetApplied: missing });
  }
  const allTranslated = evidence.units.every((unit) => unit.translated);
  Object.assign(summary.visualOrder, {
    evidence, expectedPrimaryOrder, renderedPrimaryOrder, domPrimaryOrder, actualPrimaryOrder, violations, allTranslated,
    firstContentLatencyMs: evidence.firstContentLatencyMs,
    firstPrimaryContentLatencyMs: evidence.firstApplications.find(({ category }) => category === 'primary')?.atMs ?? null,
    totalCompletionMs: allTranslated ? Math.max(...evidence.firstApplications.map(({ atMs }) => atMs)) : null,
    progressive: evidence.batches.some(({ translatedIds }) => translatedIds.length > 0 && translatedIds.length < evidence.units.length),
    partialScreenshot: screenshots.partial ? 'captured; see observed and after-capture unit IDs' : 'no partial state caught by screenshot sampling'
  });
  await setTabEnabledUI(options, visualId, false);
  await visual.waitForFunction((originals) => originals.every(({ id, original }) =>
    document.querySelector(`[data-visual="${id}"]`)?.textContent === original), initial.units, { timeout: 30000 })
    .catch((error) => { summary.visualOrder.restoreError = error.message; });
  summary.visualOrder.restored = await visual.evaluate((originals) => originals.every(({ id, original }) =>
    document.querySelector(`[data-visual="${id}"]`)?.textContent === original), initial.units);
  screenshots.restored = await evidenceScreenshot(visual, 'visual-order-restored');
  console.log('[visual-order]', JSON.stringify({
    firstContentLatencyMs: evidence.firstContentLatencyMs, totalCompletionMs: summary.visualOrder.totalCompletionMs,
    actualPrimaryOrder, violations, restored: summary.visualOrder.restored
  }));
  await visual.close();
}

if (process.env.YOUTUBE_COMMENTS === '1') {
  const { runYouTubeComments } = await import('./youtube-comments.mjs');
  summary.youtubeComments = await runYouTubeComments({
    context, options, output: OUTPUT,
    url: process.env.YOUTUBE_URL || 'https://www.youtube.com/watch?v=DBjiUz0H9HY'
  });
}

// 5. Observe the real watch page without replacing its DOM, dismissing consent,
// logging in, or pretending an inaccessible page was a translation success.
if (process.env.YOUTUBE === '1') {
  const watch = await context.newPage();
  summary.youtube = { status: 'opening', screenshots: {}, mediaSilencedByBrowser: true };
  // Install before navigation so media is stopped even while the page loads.
  // --mute-audio also prevents any sound before these handlers can run.
  await watch.addInitScript(() => {
    const silence = () => document.querySelectorAll('video,audio').forEach((media) => {
      media.muted = true;
      media.pause();
    });
    document.addEventListener('play', silence, true);
    setInterval(silence, 200);
  });
  let watchId = null;
  try {
    try {
      await watch.goto(process.env.YOUTUBE_URL || 'https://www.youtube.com/watch?v=ywN3cX4VEII&hl=ja', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await watch.waitForTimeout(5000);
    } catch (error) {
      summary.youtube.navigationError = error.message;
    }
    const access = await watch.evaluate(() => ({
      url: location.href, title: document.title,
      bodyExcerpt: document.body?.innerText.slice(0, 2400) ?? '',
      blockingDialog: [...document.querySelectorAll('[role="dialog"], ytd-enforcement-message-view-model, #error-screen')]
        .filter((element) => element.getBoundingClientRect().width && element.getBoundingClientRect().height)
        .map((element) => element.textContent.trim().slice(0, 1200)).filter(Boolean)
    }));
    summary.youtube.access = access;
    summary.youtube.screenshots.before = await evidenceScreenshot(watch, 'youtube-before');
    await watch.evaluate(observeTextApplications, [
      { category: 'title', selector: 'ytd-watch-metadata h1, #info-contents h1' },
      { category: 'description', selector: 'ytd-watch-metadata #description-inline-expander, ytd-watch-metadata #description:not(:has(#description-inline-expander)), ytd-video-secondary-info-renderer #description' },
      { category: 'recommendation', selector: '#secondary #video-title, #secondary h3 a[href*="watch?"]' },
      { category: 'comment', selector: 'ytd-comments #content-text' }
    ]);
    summary.youtube.initial = await watch.evaluate(() => window.__readingEvidence.snapshot());
    access.hasTitle = summary.youtube.initial.units.some(({ category }) => category === 'title');
    access.hasDescription = summary.youtube.initial.units.some(({ category }) => category === 'description');
    summary.youtube.missingInitialCategories = ['title', 'description', 'recommendation', 'comment']
      .filter((category) => !summary.youtube.initial.units.some((unit) => unit.category === category));
    if (summary.youtube.navigationError || !access.hasTitle || !access.hasDescription || access.blockingDialog.length) {
      summary.youtube.status = 'inaccessible';
      summary.youtube.reason = summary.youtube.navigationError || (access.blockingDialog.length
        ? 'Visible site blocking dialog or playback error; no bypass attempted'
        : 'Watch title or description unavailable; consent, login, network or site restriction may be responsible');
    } else {
      watchId = await tabIdFor(options, watch);
      await setTabEnabledUI(options, watchId, true);
      const ytStarted = Date.now();
      let evidence;
      while (Date.now() - ytStarted < PAGE_SECONDS) {
        evidence = await watch.evaluate(() => window.__readingEvidence.snapshot());
        const translated = evidence.units.filter((unit) => unit.translated);
        if (translated.length && !summary.youtube.screenshots.partial) {
          summary.youtube.screenshots.partial = {
            observedAtMs: evidence.elapsedMs, observedTranslatedIds: translated.map(({ id }) => id),
            ...await evidenceScreenshot(watch, 'youtube-partial')
          };
        }
        const primary = evidence.units.filter((unit) => unit.category === 'title' || unit.category === 'description');
        if (primary.some((unit) => unit.category === 'description') && primary.every((unit) => unit.translated)) break;
        await new Promise((done) => setTimeout(done, 500));
      }
      const primaryAppearance = evidence?.firstApplications.filter(({ category }) => category === 'title' || category === 'description') ?? [];
      summary.youtube.primaryAppearanceMs = primaryAppearance.length ? Math.max(...primaryAppearance.map(({ atMs }) => atMs)) : null;
      // Exercise the reader's next real action, including lazy-loaded comments.
      // Only scroll; do not inject or reveal site content.
      const beforeScroll = await watch.evaluate(() => scrollY);
      await watch.mouse.wheel(0, 500);
      const secondaryStarted = Date.now();
      while (Date.now() - secondaryStarted < Math.min(PAGE_SECONDS, 60000)) {
        evidence = await watch.evaluate(() => window.__readingEvidence.snapshot());
        if (['comment', 'recommendation'].every((category) =>
          evidence.units.some((unit) => unit.category === category && unit.translated))) break;
        await new Promise((done) => setTimeout(done, 500));
      }
      summary.youtube.scroll = { before: beforeScroll, after: await watch.evaluate(() => scrollY) };
      summary.youtube.evidence = await watch.evaluate(() => { window.__readingEvidence.stop(); return window.__readingEvidence.snapshot(); });
      const primary = summary.youtube.evidence.units.filter((unit) => unit.category === 'title' || unit.category === 'description');
      summary.youtube.descriptionTranslated = primary.some((unit) => unit.category === 'description' && unit.translated);
      summary.youtube.primaryContentAppeared = primary.length > 0 && primary.every((unit) => unit.translated);
      summary.youtube.status = summary.youtube.primaryContentAppeared ? 'observed' : 'translation-incomplete';
      summary.youtube.firstContentLatencyMs = summary.youtube.evidence.firstContentLatencyMs;
      summary.youtube.firstPrimaryContentLatencyMs = summary.youtube.evidence.firstApplications
        .find(({ category }) => category === 'title' || category === 'description')?.atMs ?? null;
      const primaryEnd = Math.max(...summary.youtube.evidence.firstApplications
        .filter(({ category }) => category === 'title' || category === 'description').map(({ sequence }) => sequence));
      summary.youtube.secondaryBeforePrimary = summary.youtube.evidence.firstApplications
        .filter(({ category, sequence }) => (category === 'comment' || category === 'recommendation') && sequence < primaryEnd);
      summary.youtube.secondaryObserved = ['comment', 'recommendation'].filter((category) =>
        summary.youtube.evidence.units.some((unit) => unit.category === category && unit.translated));
      summary.youtube.observationMs = summary.youtube.evidence.elapsedMs;
      summary.youtube.completionScope = 'first translated text in title and description, then comments/recommendations after a real scroll; not full-page or full-description completion';
    }
    summary.youtube.media = await watch.evaluate(() => [...document.querySelectorAll('video,audio')].map((media) => ({ paused: media.paused, muted: media.muted })));
    summary.youtube.screenshots.end = await evidenceScreenshot(watch, 'youtube-end');
  } catch (error) {
    summary.youtube.status = 'observation-error';
    summary.youtube.error = error.message;
    summary.youtube.screenshots.error = await evidenceScreenshot(watch, 'youtube-error');
  } finally {
    if (watchId !== null) await setTabEnabledUI(options, watchId, false);
    await watch.close();
  }
  console.log('[youtube]', JSON.stringify({ status: summary.youtube.status, reason: summary.youtube.reason,
    firstContentLatencyMs: summary.youtube.firstContentLatencyMs, primaryAppearanceMs: summary.youtube.primaryAppearanceMs,
    secondaryObserved: summary.youtube.secondaryObserved }));
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
if (STREAMING) {
  assert.equal(summary.streaming.error, undefined, 'real generation must show a preview before final commit');
  assert.ok(summary.streaming.events.some(event => event.preview && event.busy &&
    event.canonical === event.source && event.text !== event.source), 'stream output must not overwrite canonical source before completion');
  assert.ok(summary.streaming.components.some(component => component.firstPreviewMs !== null &&
    component.completedMs > component.firstPreviewMs), 'a real preview must precede full completion');
  assert.ok(summary.streaming.events.every(event => event.spans <= 5), 'stream render regions must remain bounded');
}
if (AURORA) {
  const evidence = summary.aurora;
  assert.equal(evidence.pendingCaptureError, null, 'installed content script must expose a real pending component before completion');
  assert.ok(evidence.pending.busy > 0, 'capture occurred during actual model inference');
  assert.ok(evidence.pending.components.some((component) => component.busy === 'true' &&
    component.state === 'translating' && component.text === component.originalText &&
    component.slottedOriginal && component.activeAnimations > 0 && component.textRects.some((rect) => rect.width > 0)),
  'pending source is readable, slotted, and actually animated');
  assert.ok(evidence.afterPendingScreenshot.busy > 0, 'the pending screenshot completed before translation finished');
  assert.equal(evidence.translated.busy, 0);
  assert.ok(evidence.translated.count >= before.length);
  assert.ok(evidence.translated.components.every((component) => component.state === 'translated' && component.slottedOriginal));
  assert.equal(evidence.translated.sameTextNodes, true);
  assert.equal(evidence.restored.count, 0, 'restoration removes all presentation wrappers');
  assert.equal(evidence.restored.sameTextNodes, true);
  assert.equal(evidence.restored.exactTextRestored, true);
  assert.equal(evidence.restored.exactHTMLRestored, true);
  for (const capture of Object.values(evidence.screenshots)) assert.equal(capture?.error, undefined, 'visual evidence must be captured');
}
if (summary.visualOrder) {
  assert.deepEqual(summary.visualOrder.renderedPrimaryOrder, summary.visualOrder.expectedPrimaryOrder, 'fixture geometry matches its intended reading order');
  assert.notDeepEqual(summary.visualOrder.domPrimaryOrder, summary.visualOrder.renderedPrimaryOrder, 'fixture DOM deliberately differs from rendered order');
  assert.ok(summary.visualOrder.initial.units.filter(({ category }) => category === 'primary').every(({ initiallyVisible }) => initiallyVisible),
    'all primary fixture units begin in the viewport so sidebar ordering is comparable');
  assert.equal(summary.visualOrder.allTranslated, true, 'every visual fixture heading and paragraph must translate');
  assert.equal(summary.visualOrder.restored, true, 'every visual fixture unit must restore exactly');
  if (VISUAL_ORDER_ASSERT) {
    assert.deepEqual(summary.visualOrder.violations, [], 'earlier primary units must be applied before later units and sidebar');
    assert.deepEqual(summary.visualOrder.actualPrimaryOrder, summary.visualOrder.expectedPrimaryOrder, 'primary application order follows rendered reading order');
    assert.equal(summary.visualOrder.progressive, true, 'the page exposes partial translated content before completion');
  }
}
if (summary.youtube && summary.youtube.status !== 'inaccessible') {
  assert.equal(summary.youtube.status, 'observed', 'the accessible watch title and description must translate');
  assert.deepEqual(summary.youtube.secondaryBeforePrimary, [], 'watch title and description appear before comments or recommendations');
  assert.ok(summary.youtube.media.every(({ paused, muted }) => paused && muted), 'watch media stays paused and muted');
}

// Actual installed extension, original bundled runtime and default .task model.
// No production-module injection, inference doubles, network mocks or bridges.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve, relative } from 'node:path';
import { tmpdir, cpus, totalmem } from 'node:os';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
const root = process.cwd(), extension = resolve('build/chrome');
const out = resolve(process.env.NATIVE_QA_DIR || 'test-results/native-extension');
await mkdir(out, { recursive: true });
const token = process.env.HF_TOKEN || '';
const clean = (v) => token ? String(v).split(token).join('[REDACTED]') : String(v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function bound(p, ms, label) {
  let timer;
  try { return await Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: ${ms} ms driver deadline`)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function inventory(dir) {
  const files = {};
  async function walk(path) { for (const e of await readdir(path, { withFileTypes: true })) {
    const file = join(path, e.name); if (e.isDirectory()) await walk(file);
    else files[relative(dir, file)] = createHash('sha256').update(await readFile(file)).digest('hex');
  } }
  await walk(dir); return Object.fromEntries(Object.entries(files).sort());
}
const before = await inventory(extension);
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const vendor = await inventory(join(root, 'node_modules/@mediapipe/tasks-genai'));
assert.equal(before['vendor/mediapipe/genai_bundle.js'], vendor['genai_bundle.mjs']);
assert.ok(!Object.keys(before).some((p) => /qa-capabilities|fixtures|runtime-double/.test(p)));
const summary = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  subject: 'Installed build/chrome with the shipped runtime and original model',
  runtime: pkg.devDependencies['@mediapipe/tasks-genai'], model: 'translategemma-4b-it-int8-web.task',
  cpu: cpus()[0]?.model, logicalCpus: cpus().length, ram: totalmem(),
  inferenceDouble: false, productionCodeInjection: false, nativeInferenceBridge: false,
  tracing: false, configuration: { maxTokens: 1024 }, results: [], errors: [], consoleMessages: [],
  telemetry: [], fullTranslationRestorePassed: false, stage: 'install' };
const save = () => writeFile(join(out, 'summary.json'), clean(JSON.stringify(summary, null, 2)));
async function stage(name) { summary.stage = name; console.log(JSON.stringify({ stage: name })); await save(); }
async function passed(name, detail = {}) { const item = { name, passed: true, ...detail }; summary.results.push(item); console.log(clean(JSON.stringify(item))); await save(); }
let context, server, welcome, options, page;
const profile = await mkdtemp(join(tmpdir(), 'autotranslate-native-'));
const watchdog = setTimeout(async () => { summary.failure = { stage: summary.stage, message: 'overall driver deadline' }; await save(); process.exit(2); }, 22 * 60000);
async function capture(p, name) {
  if (!p || p.isClosed()) return;
  await bound(p.screenshot({ path: join(out, name + '.png'), fullPage: true, caret: 'initial', timeout: 10000 }), 12000, 'screenshot');
  await writeFile(join(out, name + '.html'), clean(await bound(p.content(), 10000, 'HTML')));
}
async function host(p) {
  return bound(p.evaluate(() => AT.sendMessage({ type: 'at/local-get-status' })), 10000, 'extension host status');
}
try {
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: process.env.HEADED !== '1',
    ignoreDefaultArgs: ['--disable-extensions'], viewport: { width: 1200, height: 850 }, locale: 'en-US',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--use-angle=swiftshader',
      '--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
  context.setDefaultTimeout(30000); summary.browser = context.browser().version();
  const observe = (p) => {
    p.on('pageerror', (e) => summary.errors.push(clean(e.message)));
    p.on('console', (m) => { if (['error', 'warning'].includes(m.type())) summary.consoleMessages.push(clean(m.text()).slice(0, 2000)); });
  };
  context.on('page', observe); context.pages().forEach(observe);
  const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  assert.match(sw.url(), /^chrome-extension:\/\/[^/]+\/background\.js$/);
  const id = sw.url().split('/')[2]; summary.extensionId = id;
  const deadline = Date.now() + 30000;
  while (!welcome && Date.now() < deadline) { welcome = context.pages().find((p) => p.url() === `chrome-extension://${id}/welcome.html`); if (!welcome) await sleep(100); }
  assert.ok(welcome, 'installation opens the real onboarding');
  await welcome.waitForFunction(() => document.querySelector('#targetLang').options.length > 1 && document.querySelector('#status').textContent.length > 0);
  assert.match(await welcome.title(), /Autotranslate/);
  summary.adapter = await welcome.evaluate(async () => { const a = await navigator.gpu?.requestAdapter(); return a ? { vendor: a.info?.vendor, architecture: a.info?.architecture } : null; });
  await welcome.locator('#targetLang').selectOption('ko');
  await capture(welcome, '01-onboarding');
  await passed('installed-extension-and-onboarding', { serviceWorker: sw.url(), adapter: summary.adapter });
  // Choose the source through the real UI. Default context remains 1024.
  options = await context.newPage(); await options.goto(`chrome-extension://${id}/options.html`);
  await options.waitForFunction(() => document.querySelector('#sourceLang').options.length > 1);
  await options.locator('#sourceLang').selectOption('en'); await options.locator('#targetLang').selectOption('ko');
  assert.equal(await options.locator('#localMaxTokens').inputValue(), '1024');
  await options.locator('#save').click(); await options.waitForFunction(() => document.querySelector('#saveStatus').dataset.kind === 'ok');
  await options.close(); options = null;

  await stage('download-and-native-load');
  if (token) await welcome.locator('#modelToken').fill(token);
  assert.equal(await welcome.locator('#download').isDisabled(), false);
  await welcome.locator('#download').click();
  const installStart = performance.now(); let ready = false, last = '';
  while (performance.now() - installStart < 12 * 60000) {
    const at = performance.now();
    const ui = await bound(welcome.evaluate(() => ({ status: document.querySelector('#status').textContent,
      kind: document.querySelector('#status').dataset.kind, ready: !document.querySelector('#start').disabled,
      received: document.querySelector('#progress').value, total: document.querySelector('#progress').max })), 10000, 'onboarding responsiveness');
    const status = await host(welcome);
    const item = { elapsedMs: performance.now() - installStart, responseMs: performance.now() - at, ui, host: status.status };
    summary.telemetry.push(item); await save();
    const key = JSON.stringify([ui.kind, Math.floor(ui.received / (128 * 1024 * 1024)), status.status?.state, status.status?.phase]);
    if (key !== last) { console.log(clean(JSON.stringify(item))); last = key; }
    if (ui.kind === 'error') throw new Error(ui.status);
    if (ui.ready) { ready = true; summary.loadedModel = status.status; break; }
    await sleep(3000);
  }
  assert.ok(ready, 'original model loads and completes native warmup');
  assert.equal(summary.loadedModel.state, 'ready'); assert.equal(summary.loadedModel.loadedBytes, 3896377344);
  await welcome.locator('#modelToken').fill(''); await capture(welcome, '02-model-ready');
  await passed('native-model-loaded-and-warmed', { elapsedMs: performance.now() - installStart, state: summary.loadedModel });

  await stage('translate-original-html');
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title translate="no">Native extension test</title><style>body{font:18px/1.6 system-ui;max-width:800px;margin:40px auto;padding:20px}a{color:#1659a5}pre{background:#eee;padding:12px}</style></head><body><main><h1>Install the application</h1><p id="paragraph">Your documents remain private.</p><p>Read <a href="#guide" id="guide">the installation guide</a> before continuing.</p><pre>npm install</pre><input id="draft" value="user draft"><button id="click" translate="no" onclick="this.dataset.clicks=String(Number(this.dataset.clicks||0)+1)">Click</button></main></body></html>';
  server = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(html); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`; summary.fixtureUrl = origin;
  page = await context.newPage(); await page.goto(origin); assert.equal(await page.title(), 'Native extension test');
  const original = await page.evaluateHandle(() => {
    const elements = [...document.body.querySelectorAll('*')], nodes = []; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n;
    while ((n = w.nextNode())) nodes.push({ node: n, text: n.nodeValue });
    return { html: document.body.innerHTML, nodes, elements, attrs: elements.map((e) => JSON.stringify([...e.attributes].map((a) => [a.name, a.value]))) };
  });
  await capture(page, '03-original');
  options = await context.newPage(); await options.goto(`chrome-extension://${id}/options.html`);
  await options.waitForFunction(() => document.querySelector('#sourceLang').options.length > 1);
  const tabId = await options.evaluate(async (origin) => (await AT.api.tabs.query({})).find((t) => t.url === origin + '/')?.id, origin);
  assert.ok(tabId);
  const start = performance.now(); await welcome.locator('#start').click(); let complete = false;
  while (performance.now() - start < 10 * 60000) {
    const render = await bound(page.evaluate(() => ({ heading: document.querySelector('h1').textContent, paragraph: document.querySelector('#paragraph').textContent, link: document.querySelector('#guide').textContent })), 10000, 'rendered HTML');
    if (!summary.firstTextMs && /[가-힣]/u.test(render.heading)) summary.firstTextMs = performance.now() - start;
    const state = await bound(options.evaluate((tabId) => AT.sendMessage({ type: 'at/get-state', tabId }), tabId), 10000, 'tab state');
    summary.rendered = render; summary.tabState = state; await save();
    console.log(clean(JSON.stringify({ elapsedMs: performance.now() - start, render, state: state.state })));
    if (state.state?.status === 'error') throw new Error(state.state.error || 'extension translation failure');
    if (state.state?.status === 'translated') { assert.ok(Object.values(render).every((s) => /[가-힣]/u.test(s))); complete = true; break; }
    await sleep(3000);
  }
  assert.ok(complete, 'installed extension translated all fixture text');
  summary.translateMs = performance.now() - start; summary.afterTranslate = (await host(options)).status;
  assert.ok(summary.afterTranslate.generations > summary.loadedModel.generations);
  assert.equal(await page.locator('pre').innerText(), 'npm install'); assert.equal(await page.locator('#draft').inputValue(), 'user draft');
  assert.equal(await page.locator('#guide').getAttribute('href'), '#guide');
  await capture(page, '04-translated'); await passed('native-page-translation', { ms: summary.translateMs, firstTextMs: summary.firstTextMs, rendered: summary.rendered, generations: summary.afterTranslate.generations });

  await stage('restore-from-real-options');
  // Reload avoids overwriting settings with the pre-onboarding UI snapshot.
  await options.reload(); await options.waitForFunction(() => document.querySelector('#enabled').checked);
  const restoreAt = performance.now(); await options.locator('#enabled').setChecked(false); await options.locator('#save').click();
  await page.waitForFunction(() => document.querySelector('#paragraph').textContent === 'Your documents remain private.');
  const restored = await original.evaluate((o) => ({ html: document.body.innerHTML === o.html,
    text: o.nodes.every(({ node, text }) => node.nodeValue === text), elements: o.elements.every((e, i) => e === document.body.querySelectorAll('*')[i]),
    attributes: o.elements.every((e, i) => JSON.stringify([...e.attributes].map((a) => [a.name, a.value])) === o.attrs[i]) }));
  assert.ok(Object.values(restored).every(Boolean), JSON.stringify(restored)); summary.restoreMs = performance.now() - restoreAt;
  await capture(page, '05-restored'); await page.locator('#click').click(); assert.equal(await page.locator('#click').getAttribute('data-clicks'), '1');
  await passed('exact-html-restoration-and-events', { ...restored, ms: summary.restoreMs });
  assert.deepEqual(summary.errors, []); summary.fullTranslationRestorePassed = true;
} catch (error) {
  summary.failure = { stage: summary.stage, message: clean(error.message) }; process.exitCode = 1; console.error(JSON.stringify(summary.failure)); await save();
  for (const [p, name] of [[welcome, 'FAIL-onboarding'], [options, 'FAIL-options'], [page, 'FAIL-page']]) {
    if (p && !p.isClosed()) { await p.locator('#modelToken').fill('').catch(() => {}); await capture(p, name).catch(() => {}); }
  }
} finally {
  summary.installedFilesUnchanged = JSON.stringify(before) === JSON.stringify(await inventory(extension));
  if (!summary.installedFilesUnchanged) { summary.fullTranslationRestorePassed = false; process.exitCode = 1; }
  await writeFile(join(out, 'installed-files-before.json'), JSON.stringify(before, null, 2));
  await writeFile(join(out, 'installed-files-after.json'), JSON.stringify(await inventory(extension), null, 2));
  await save(); clearTimeout(watchdog);
  if (context) await bound(context.close(), 15000, 'browser shutdown').catch(() => {});
  if (server) { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  console.log(JSON.stringify({ fullTranslationRestorePassed: summary.fullTranslationRestorePassed, installedFilesUnchanged: summary.installedFilesUnchanged, failure: summary.failure }));
}

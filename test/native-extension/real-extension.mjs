// This is an installed-extension test. There are no inference doubles, injected
// production modules, altered capability globals, network mocks, or native bridges.
// All translation and restoration commands originate in the shipped extension UI.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { tmpdir, cpus, totalmem } from 'node:os';
import { createServer } from 'node:http';
import { chromium } from 'playwright';

const root = process.cwd();
const extension = resolve(root, 'build/chrome');
const output = resolve(process.env.NATIVE_QA_DIR || 'test-results/native-extension');
await mkdir(output, { recursive: true });
const token = process.env.HF_TOKEN || '';
const clean = (value) => token ? String(value).split(token).join('[REDACTED]') : String(value);
const safeUrl = (value) => { try { const url = new URL(value); return url.origin + url.pathname; } catch { return clean(value); } };
async function inventory(directory) {
  const result = {};
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) await visit(file);
      else result[relative(directory, file)] = createHash('sha256').update(await readFile(file)).digest('hex');
    }
  }
  await visit(directory);
  return Object.fromEntries(Object.entries(result).sort());
}
const originalFiles = await inventory(extension);
const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const vendorFiles = await inventory(join(root, 'node_modules/@mediapipe/tasks-genai'));
assert.equal(originalFiles['vendor/mediapipe/genai_bundle.js'], vendorFiles['genai_bundle.mjs'] || vendorFiles['genai_bundle.js'], 'shipped runtime must match the locked dependency');
assert.ok(!Object.keys(originalFiles).some((path) => /qa-capabilities|fixtures|runtime-double/.test(path)), 'no test doubles in installed extension');
await writeFile(join(output, 'installed-files-before.json'), JSON.stringify(originalFiles, null, 2));

const results = [], errors = [], consoleMessages = [], responses = [];
let context, browserCDP, server, welcome, options, fixture, traceStarted = false;
let stage = 'install-extension';
const profile = await mkdtemp(join(tmpdir(), 'autotranslate-real-profile-'));
const summary = {
  commit: process.env.GITHUB_SHA || null,
  subject: 'Unmodified build/chrome installed as a real Manifest V3 extension',
  runtime: { package: '@mediapipe/tasks-genai', version: pkg.devDependencies['@mediapipe/tasks-genai'] },
  manifestVersion: manifest.version,
  model: 'The default model URL and bytes selected by the shipped onboarding page',
  browserFlags: ['--use-angle=swiftshader', '--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
  softwareRendering: true, cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem(),
  inferenceDouble: false, productionCodeInjection: false, nativeInferenceBridge: false,
  results, errors, consoleMessages, responses,
  fullTranslationRestorePassed: false
};
async function checkpoint(name, details = {}) {
  results.push({ name, passed: true, at: new Date().toISOString(), ...details });
  console.log(JSON.stringify(results.at(-1)));
  await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2));
}
function observePage(page) {
  page.on('pageerror', (error) => errors.push({ url: safeUrl(page.url()), error: clean(error.message) }));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') consoleMessages.push({ url: safeUrl(page.url()), type: message.type(), text: clean(message.text()).slice(0, 2000) });
  });
}
async function capture(page, name) {
  if (!page || page.isClosed()) return;
  await page.screenshot({ path: join(output, name + '.png'), fullPage: true, caret: 'initial' });
  await writeFile(join(output, name + '.html'), clean(await page.content()));
}
async function status(page) {
  return page.evaluate(async () => {
    const reply = await AT.sendMessage({ type: 'at/local-get-status' });
    return { ok: reply.ok, status: reply.status, supported: reply.supported, error: reply.error };
  });
}
async function saveOptions(patch) {
  await options.reload();
  await options.waitForFunction(() => document.querySelector('#targetLang').options.length > 1);
  if (patch.enabled !== undefined) await options.locator('#enabled').setChecked(patch.enabled);
  if (patch.targetLang) await options.locator('#targetLang').selectOption(patch.targetLang);
  if (patch.sourceLang) await options.locator('#sourceLang').selectOption(patch.sourceLang);
  await options.locator('#save').click();
  await options.waitForFunction(() => document.querySelector('#saveStatus').dataset.kind === 'ok');
}
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: process.env.HEADED !== '1',
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [...summary.browserFlags, `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    viewport: { width: 1200, height: 850 }, locale: 'en-US', timeout: 60000
  });
  summary.browserVersion = context.browser().version();
  context.setDefaultTimeout(30000);
  context.on('page', observePage);
  for (const page of context.pages()) observePage(page);
  context.on('response', (response) => {
    const url = safeUrl(response.url());
    if (url.includes('huggingface.co') || url.includes('/vendor/mediapipe/')) responses.push({ url, status: response.status(), at: new Date().toISOString() });
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
  const id = worker.url().split('/')[2];
  assert.match(worker.url(), /^chrome-extension:\/\/[^/]+\/background\.js$/);
  summary.extensionId = id;
  summary.workerUrl = worker.url();
  await checkpoint('real-extension-service-worker-started', { extensionId: id, workerUrl: worker.url() });
  welcome = context.pages().find((page) => page.url() === `chrome-extension://${id}/welcome.html`) || await context.newPage();
  if (!welcome.url().endsWith('/welcome.html')) await welcome.goto(`chrome-extension://${id}/welcome.html`);
  await welcome.waitForFunction(() => document.querySelector('#targetLang').options.length > 1 && document.querySelector('#status').textContent.length > 0);
  assert.match(await welcome.title(), /Autotranslate/);
  assert.equal(await welcome.locator('#start').isDisabled(), true);
  await welcome.locator('#targetLang').selectOption('ko');
  await capture(welcome, '01-installed-onboarding');
  summary.beforeModel = await status(welcome);
  summary.defaultModel = await welcome.evaluate(() => ({ ...AT.modelflow.SOURCE }));
  summary.adapter = await welcome.evaluate(async () => {
    if (!navigator.gpu) return { available: false };
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { available: false };
    const info = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : {});
    return { available: true, vendor: info.vendor, architecture: info.architecture, device: info.device,
      description: info.description, features: [...adapter.features], maxBufferSize: adapter.limits.maxBufferSize };
  });
  browserCDP = await context.browser().newBrowserCDPSession();
  summary.targetsBeforeModel = (await browserCDP.send('Target.getTargets')).targetInfos.map(({ type, url }) => ({ type, url: safeUrl(url) }));
  await checkpoint('shipped-onboarding-rendered', { supported: summary.beforeModel.supported, adapter: summary.adapter });
  stage = 'download-and-load-default-model';
  if (await welcome.locator('#download').isDisabled()) throw new Error(`Original extension refused this browser: ${await welcome.locator('#support').innerText()}`);
  if (token) await welcome.locator('#modelToken').fill(token);
  await welcome.locator('#download').click();
  const started = performance.now();
  const deadline = Date.now() + 15 * 60 * 1000;
  let lastProgress = '';
  while (Date.now() < deadline) {
    const ui = await welcome.evaluate(() => ({
      status: document.querySelector('#status').textContent,
      kind: document.querySelector('#status').dataset.kind,
      ready: !document.querySelector('#start').disabled,
      received: document.querySelector('#progress').value,
      total: document.querySelector('#progress').max
    }));
    const progress = `${ui.kind}:${Math.floor(ui.received / (1024 * 1024))}:${ui.ready}`;
    if (progress !== lastProgress) { console.log(JSON.stringify({ stage, ...ui, status: clean(ui.status) })); lastProgress = progress; }
    summary.downloadUI = { ...ui, status: clean(ui.status), elapsedMs: performance.now() - started };
    if (ui.ready) break;
    if (ui.kind === 'error') throw new Error(`The installed extension failed to install its default model: ${clean(ui.status)}`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  assert.equal(await welcome.locator('#start').isDisabled(), false, 'original runtime must load and warm up the real model before any translation is credited');
  await welcome.locator('#modelToken').fill('');
  summary.loadedModel = await status(welcome);
  summary.storedModels = await welcome.evaluate(() => AT.modelstore.list());
  await capture(welcome, '02-real-model-ready');
  assert.equal(summary.loadedModel.status.state, 'ready');
  await checkpoint('default-model-downloaded-loaded-and-warmed-by-bundled-runtime', { model: summary.loadedModel.status, elapsedMs: performance.now() - started });
  // Tracing begins only after credential entry and authenticated download have finished.
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false }); traceStarted = true;

  stage = 'translate-html-through-installed-extension';
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title translate="no">Native extension test</title><style>body{font:18px/1.6 system-ui;max-width:800px;margin:40px auto;padding:20px}a{color:#1659a5}pre{background:#eee;padding:12px}</style></head><body><main><h1>Install the application</h1><p id="paragraph">Your documents remain private.</p><p>Read <a href="#guide" id="guide">the installation guide</a> before continuing.</p><pre>npm install</pre><input id="draft" value="user draft"><button id="click" translate="no" onclick="this.dataset.clicks=String(Number(this.dataset.clicks||0)+1)">Click</button></main></body></html>';
  server = createServer((request, response) => { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(html); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  summary.fixtureUrl = origin;
  fixture = await context.newPage(); await fixture.goto(origin);
  const snapshot = await fixture.evaluateHandle(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); const nodes = []; let node;
    while ((node = walker.nextNode())) nodes.push({ node, text: node.nodeValue });
    return { html: document.body.innerHTML, nodes, elements: [...document.body.querySelectorAll('*')],
      attributes: [...document.body.querySelectorAll('*')].map((element) => JSON.stringify([...element.attributes].map((a) => [a.name, a.value]))) };
  });
  await capture(fixture, '03-original-html');
  const beforeGeneration = summary.loadedModel.status.generations;
  const translateStart = performance.now();
  await welcome.locator('#start').click();
  options = await context.newPage(); await options.goto(`chrome-extension://${id}/options.html`);
  await options.waitForFunction(() => document.querySelector('#targetLang').options.length > 1);
  await fixture.waitForFunction(() => /[가-힣]/u.test(document.querySelector('h1').textContent), null, { timeout: 180000 });
  summary.firstTextMs = performance.now() - translateStart;
  await fixture.waitForFunction(() => /[가-힣]/u.test(document.querySelector('#paragraph').textContent) && /[가-힣]/u.test(document.querySelector('#guide').textContent), null, { timeout: 180000 });
  // Read actual tab reports through the extension's production message handler.
  const tabId = await options.evaluate(async (url) => (await AT.api.tabs.query({})).find((tab) => tab.url === url + '/')?.id, origin);
  assert.ok(tabId, 'actual translated tab is registered in the browser');
  const waitCompleteEnd = Date.now() + 180000;
  do {
    summary.tabState = await options.evaluate((tabId) => AT.sendMessage({ type: 'at/get-state', tabId }), tabId);
    if (summary.tabState.state?.status === 'translated') break;
    if (summary.tabState.state?.status === 'error') throw new Error(summary.tabState.state.error);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } while (Date.now() < waitCompleteEnd);
  assert.equal(summary.tabState.state?.status, 'translated');
  summary.translateMs = performance.now() - translateStart;
  summary.afterTranslate = await status(options);
  assert.ok(summary.afterTranslate.status.generations > beforeGeneration, 'real bundled host reports model generations');
  assert.equal(await fixture.locator('pre').innerText(), 'npm install');
  assert.equal(await fixture.locator('#draft').inputValue(), 'user draft');
  assert.equal(await fixture.locator('#guide').getAttribute('href'), '#guide');
  summary.translatedText = await fixture.locator('main').innerText();
  await capture(fixture, '04-real-extension-translated');
  await checkpoint('actual-extension-translated-fixture', { firstTextMs: summary.firstTextMs, translateMs: summary.translateMs,
    generations: summary.afterTranslate.status.generations - beforeGeneration, text: summary.translatedText });

  stage = 'restore-through-extension-settings';
  const restoreStart = performance.now();
  await saveOptions({ enabled: false });
  await fixture.waitForFunction(() => document.querySelector('#paragraph').textContent === 'Your documents remain private.');
  const restored = await snapshot.evaluate((snapshot) => ({
    html: document.body.innerHTML === snapshot.html,
    text: snapshot.nodes.every(({ node, text }) => node.nodeValue === text),
    elements: snapshot.elements.every((element, index) => element === document.body.querySelectorAll('*')[index]),
    attributes: snapshot.elements.every((element, index) => JSON.stringify([...element.attributes].map((a) => [a.name, a.value])) === snapshot.attributes[index])
  }));
  assert.ok(Object.values(restored).every(Boolean), JSON.stringify(restored));
  await capture(fixture, '05-real-extension-restored');
  await fixture.locator('#click').click(); assert.equal(await fixture.locator('#click').getAttribute('data-clicks'), '1');
  summary.restoreRoundTripMs = performance.now() - restoreStart;
  await checkpoint('actual-extension-restored-original-html-and-node-identities', { ...restored, uiRoundTripMs: summary.restoreRoundTripMs, clickHandlerPreserved: true });
  assert.deepEqual(errors, [], 'no uncaught JavaScript errors');
  summary.fullTranslationRestorePassed = true;
} catch (error) {
  summary.failure = { stage, message: clean(error.message), stack: clean(error.stack) };
  results.push({ name: stage, passed: false, error: clean(error.message) });
  process.exitCode = 1;
  console.error(JSON.stringify(summary.failure));
  if (welcome && !welcome.isClosed()) {
    await welcome.locator('#modelToken').fill('').catch(() => {});
    summary.finalHostStatus = await status(welcome).catch((e) => ({ error: clean(e.message) }));
    await capture(welcome, 'FAIL-actual-extension-onboarding').catch(() => {});
  }
  await capture(options, 'FAIL-actual-extension-options').catch(() => {});
  await capture(fixture, 'FAIL-actual-extension-page').catch(() => {});
} finally {
  summary.installedFilesUnchanged = JSON.stringify(originalFiles) === JSON.stringify(await inventory(extension));
  if (!summary.installedFilesUnchanged) { summary.fullTranslationRestorePassed = false; process.exitCode = 1; }
  await writeFile(join(output, 'installed-files-after.json'), JSON.stringify(await inventory(extension), null, 2));
  await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2));
  if (traceStarted) await context.tracing.stop({ path: join(output, 'real-extension-trace.zip') }).catch(() => {});
  await context?.close().catch(() => {});
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  console.log(JSON.stringify({ fullTranslationRestorePassed: summary.fullTranslationRestorePassed, installedFilesUnchanged: summary.installedFilesUnchanged, results }));
}

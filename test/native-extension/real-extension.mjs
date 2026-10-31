// The shipped build/chrome is installed unchanged. No inference doubles,
// production-code injection, capability replacement or alternate runtime.
// Authenticated profiles are never traced: snapshots can serialize passwords.
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
const maxTokens = Number(process.env.NATIVE_MAX_TOKENS || 1024);
assert.ok(Number.isInteger(maxTokens) && maxTokens >= 128 && maxTokens <= 8192);
const clean = (value) => token ? String(value).split(token).join('[REDACTED]') : String(value);
const safeUrl = (value) => { try { const u = new URL(value); return u.origin + u.pathname; } catch { return clean(value); } };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function bounded(promise, ms, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: driver deadline exceeded (${ms} ms)`)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function inventory(directory) {
  const files = {};
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) await visit(file);
      else files[relative(directory, file)] = createHash('sha256').update(await readFile(file)).digest('hex');
    }
  }
  await visit(directory);
  return Object.fromEntries(Object.entries(files).sort());
}
const before = await inventory(extension);
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const vendor = await inventory(join(root, 'node_modules/@mediapipe/tasks-genai'));
assert.equal(before['vendor/mediapipe/genai_bundle.js'], vendor['genai_bundle.mjs'] || vendor['genai_bundle.js']);
assert.ok(!Object.keys(before).some((p) => /qa-capabilities|fixtures|runtime-double/.test(p)));
const summary = {
  commit: process.env.GITHUB_SHA || null,
  subject: 'Unmodified build/chrome installed as a real Manifest V3 extension',
  runtime: { package: '@mediapipe/tasks-genai', version: pkg.devDependencies['@mediapipe/tasks-genai'] },
  browserFlags: ['--use-angle=swiftshader', '--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
  softwareRendering: true, cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem(),
  inferenceDouble: false, productionCodeInjection: false, nativeInferenceBridge: false,
  tracing: false, configuration: { maxTokens, appliedThrough: 'shipped options UI' }, results: [], errors: [], consoleMessages: [], responses: [],
  fullTranslationRestorePassed: false, stage: 'install-extension'
};
const save = () => writeFile(join(output, 'summary.json'), clean(JSON.stringify(summary, null, 2)));
async function checkpoint(name, details = {}) {
  const entry = { name, passed: true, at: new Date().toISOString(), ...details };
  summary.results.push(entry); console.log(clean(JSON.stringify(entry))); await save();
}
async function stage(name) { summary.stage = name; console.log(JSON.stringify({ stage: name })); await save(); }
function observe(page) {
  page.on('pageerror', (error) => summary.errors.push({ url: safeUrl(page.url()), error: clean(error.message) }));
  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type())) summary.consoleMessages.push({ url: safeUrl(page.url()), type: message.type(), text: clean(message.text()).slice(0, 2000) });
  });
}
async function capture(page, name) {
  if (!page || page.isClosed()) return;
  await bounded(page.screenshot({ path: join(output, name + '.png'), fullPage: true, caret: 'initial', timeout: 10000 }), 12000, 'screenshot');
  await writeFile(join(output, name + '.html'), clean(await bounded(page.content(), 10000, 'HTML snapshot')));
}
async function status(page) {
  return bounded(page.evaluate(async () => {
    const r = await AT.sendMessage({ type: 'at/local-get-status' });
    return { ok: r.ok, status: r.status, supported: r.supported, error: r.error };
  }), 15000, 'read original host status');
}
const profile = await mkdtemp(join(tmpdir(), 'autotranslate-real-profile-'));
let context, server, welcome, options, fixture;
const watchdog = setTimeout(async () => {
  summary.failure = { stage: summary.stage, message: '22-minute overall driver deadline; not a successful test' };
  summary.fullTranslationRestorePassed = false;
  await save(); console.error(JSON.stringify(summary.failure)); process.exit(2);
}, 22 * 60 * 1000);
await writeFile(join(output, 'installed-files-before.json'), JSON.stringify(before, null, 2));
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: process.env.HEADED !== '1', ignoreDefaultArgs: ['--disable-extensions'],
    args: [...summary.browserFlags, `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    viewport: { width: 1200, height: 850 }, locale: 'en-US', timeout: 60000
  });
  summary.browserVersion = context.browser().version(); context.setDefaultTimeout(30000);
  context.on('page', observe); context.pages().forEach(observe);
  context.on('response', (response) => {
    const url = safeUrl(response.url());
    if (url.includes('huggingface.co') || url.includes('/vendor/mediapipe/')) summary.responses.push({ url, status: response.status(), at: new Date().toISOString() });
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
  assert.match(worker.url(), /^chrome-extension:\/\/[^/]+\/background\.js$/);
  const id = worker.url().split('/')[2]; summary.extensionId = id; summary.workerUrl = worker.url();
  await checkpoint('real-extension-service-worker-started', { workerUrl: worker.url() });
  // Observe the extension's own install page; do not open a competing copy.
  const welcomeDeadline = Date.now() + 30000;
  while (!welcome && Date.now() < welcomeDeadline) {
    welcome = context.pages().find((p) => p.url() === `chrome-extension://${id}/welcome.html`);
    if (!welcome) await pause(100);
  }
  assert.ok(welcome, 'the installed extension opened its own onboarding page');
  await welcome.waitForFunction(() => document.querySelector('#targetLang').options.length > 1 && document.querySelector('#status').textContent.length > 0);
  assert.match(await welcome.title(), /Autotranslate/); assert.equal(await welcome.locator('#start').isDisabled(), true);
  await welcome.locator('#targetLang').selectOption('ko');
  summary.beforeModel = await status(welcome);
  summary.defaultModel = await welcome.evaluate(() => ({ ...AT.modelflow.SOURCE }));
  summary.adapter = await welcome.evaluate(async () => {
    const a = await navigator.gpu?.requestAdapter();
    return a ? { available: true, vendor: a.info?.vendor, architecture: a.info?.architecture, features: [...a.features], maxBufferSize: a.limits.maxBufferSize } : { available: false };
  });
  await capture(welcome, '01-installed-onboarding');
  await checkpoint('shipped-onboarding-rendered', { supported: summary.beforeModel.supported, adapter: summary.adapter });
  if (maxTokens !== 1024) {
    await stage('configure-context-through-shipped-options');
    const setup = await context.newPage();
    await setup.goto(`chrome-extension://${id}/options.html`);
    await setup.waitForFunction(() => document.querySelector('#targetLang').options.length > 1);
    await setup.locator('#localMaxTokens').fill(String(maxTokens));
    await setup.locator('#save').click();
    await setup.waitForFunction(() => document.querySelector('#saveStatus').dataset.kind === 'ok');
    await setup.reload();
    await setup.waitForFunction((n) => document.querySelector('#localMaxTokens').value === String(n), maxTokens);
    await checkpoint('context-budget-set-through-original-ui', { maxTokens });
    await setup.close();
  }
  await stage('download-and-load-default-model');
  if (await welcome.locator('#download').isDisabled()) throw new Error(`Extension refused this browser: ${await welcome.locator('#support').innerText()}`);
  if (token) await welcome.locator('#modelToken').fill(token);
  await welcome.locator('#download').click();
  const installStart = performance.now(), installEnd = Date.now() + 15 * 60 * 1000;
  while (Date.now() < installEnd) {
    const ui = await bounded(welcome.evaluate(() => ({ status: document.querySelector('#status').textContent, kind: document.querySelector('#status').dataset.kind,
      ready: !document.querySelector('#start').disabled, received: document.querySelector('#progress').value, total: document.querySelector('#progress').max })), 240000, 'onboarding progress');
    summary.downloadUI = { ...ui, status: clean(ui.status), elapsedMs: performance.now() - installStart };
    console.log(clean(JSON.stringify({ stage: summary.stage, ...summary.downloadUI }))); await save();
    if (ui.ready) break;
    if (ui.kind === 'error') throw new Error(`Original extension model installation failed: ${clean(ui.status)}`);
    await pause(3000);
  }
  assert.equal(await welcome.locator('#start').isDisabled(), false, 'original runtime must load and warm up its model');
  await welcome.locator('#modelToken').fill('');
  summary.loadedModel = await status(welcome); summary.storedModels = await welcome.evaluate(() => AT.modelstore.list());
  assert.equal(summary.loadedModel.status.state, 'ready');
  await capture(welcome, '02-real-model-ready');
  await checkpoint('default-model-downloaded-loaded-and-warmed-by-bundled-runtime', { model: summary.loadedModel.status, elapsedMs: performance.now() - installStart });

  await stage('translate-html-through-installed-extension');
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title translate="no">Native extension test</title><style>body{font:18px/1.6 system-ui;max-width:800px;margin:40px auto;padding:20px}a{color:#1659a5}pre{background:#eee;padding:12px}</style></head><body><main><h1>Install the application</h1><p id="paragraph">Your documents remain private.</p><p>Read <a href="#guide" id="guide">the installation guide</a> before continuing.</p><pre>npm install</pre><input id="draft" value="user draft"><button id="click" translate="no" onclick="this.dataset.clicks=String(Number(this.dataset.clicks||0)+1)">Click</button></main></body></html>';
  server = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(html); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`; summary.fixtureUrl = origin;
  fixture = await context.newPage(); await fixture.goto(origin);
  const snapshot = await fixture.evaluateHandle(() => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), nodes = []; let node;
    while ((node = w.nextNode())) nodes.push({ node, text: node.nodeValue });
    const elements = [...document.body.querySelectorAll('*')];
    return { html: document.body.innerHTML, nodes, elements, attributes: elements.map((e) => JSON.stringify([...e.attributes].map((a) => [a.name, a.value]))) };
  });
  await capture(fixture, '03-original-html');
  options = await context.newPage(); await options.goto(`chrome-extension://${id}/options.html`, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await options.waitForFunction(() => document.querySelector('#targetLang').options.length > 1);
  const tabId = await bounded(options.evaluate(async (url) => (await AT.api.tabs.query({})).find((tab) => tab.url === url + '/')?.id, origin), 15000, 'lookup fixture tab');
  assert.ok(tabId);
  const translateStart = performance.now(); await welcome.locator('#start').click();
  const translateEnd = Date.now() + 10 * 60 * 1000;
  while (Date.now() < translateEnd) {
    summary.rendered = await bounded(fixture.evaluate(() => ({ heading: document.querySelector('h1').textContent, paragraph: document.querySelector('#paragraph').textContent, link: document.querySelector('#guide').textContent })), 15000, 'read actual HTML');
    const hasKorean = (text) => /[가-힣]/u.test(text);
    if (!summary.firstTextMs && hasKorean(summary.rendered.heading)) summary.firstTextMs = performance.now() - translateStart;
    summary.tabState = await bounded(options.evaluate((tabId) => AT.sendMessage({ type: 'at/get-state', tabId }), tabId), 15000, 'read actual tab status').catch((e) => ({ observerError: clean(e.message) }));
    console.log(clean(JSON.stringify({ stage: summary.stage, elapsedMs: performance.now() - translateStart, rendered: summary.rendered, tab: summary.tabState.state }))); await save();
    if (summary.tabState.state?.status === 'error') throw new Error(summary.tabState.state.error || 'Original extension reported a translation error');
    if (summary.tabState.state?.status === 'translated') {
      assert.ok(Object.values(summary.rendered).every(hasKorean), 'real Korean output must reach heading, paragraph and link');
      assert.ok(!summary.tabState.state.error, summary.tabState.state.error); break;
    }
    await pause(5000);
  }
  assert.equal(summary.tabState.state?.status, 'translated', 'page translation completed before driver deadline');
  summary.translateMs = performance.now() - translateStart; summary.afterTranslate = await status(options);
  assert.ok(summary.afterTranslate.status.generations > summary.loadedModel.status.generations, 'bundled host actually generated translations');
  assert.equal(await fixture.locator('pre').innerText(), 'npm install');
  assert.equal(await fixture.locator('#draft').inputValue(), 'user draft');
  assert.equal(await fixture.locator('#guide').getAttribute('href'), '#guide');
  summary.translatedText = await fixture.locator('main').innerText();
  await capture(fixture, '04-real-extension-translated');
  await checkpoint('actual-extension-translated-fixture', { firstTextMs: summary.firstTextMs, translateMs: summary.translateMs, generations: summary.afterTranslate.status.generations - summary.loadedModel.status.generations, text: summary.translatedText });

  await stage('restore-through-extension-settings');
  const restoreStart = performance.now();
  await options.locator('#enabled').setChecked(false); await options.locator('#save').click();
  await options.waitForFunction(() => document.querySelector('#saveStatus').dataset.kind === 'ok');
  await fixture.waitForFunction(() => document.querySelector('#paragraph').textContent === 'Your documents remain private.');
  const restored = await snapshot.evaluate((s) => ({ html: document.body.innerHTML === s.html, text: s.nodes.every(({ node, text }) => node.nodeValue === text),
    elements: s.elements.every((e, i) => e === document.body.querySelectorAll('*')[i]),
    attributes: s.elements.every((e, i) => JSON.stringify([...e.attributes].map((a) => [a.name, a.value])) === s.attributes[i]) }));
  assert.ok(Object.values(restored).every(Boolean), JSON.stringify(restored));
  await capture(fixture, '05-real-extension-restored');
  await fixture.locator('#click').click(); assert.equal(await fixture.locator('#click').getAttribute('data-clicks'), '1');
  summary.restoreRoundTripMs = performance.now() - restoreStart;
  await checkpoint('actual-extension-restored-original-html-and-node-identities', { ...restored, uiRoundTripMs: summary.restoreRoundTripMs, clickHandlerPreserved: true });
  assert.deepEqual(summary.errors, [], 'no uncaught JavaScript errors'); summary.fullTranslationRestorePassed = true;
} catch (error) {
  summary.failure = { stage: summary.stage, message: clean(error.message), stack: clean(error.stack) };
  summary.results.push({ name: summary.stage, passed: false, error: clean(error.message) });
  process.exitCode = 1; console.error(JSON.stringify(summary.failure)); await save();
  const inspect = options && !options.isClosed() ? options : welcome && !welcome.isClosed() ? welcome : null;
  if (inspect) summary.finalHostStatus = await status(inspect).catch((e) => ({ error: clean(e.message) }));
  if (welcome && !welcome.isClosed()) await welcome.locator('#modelToken').fill('', { timeout: 5000 }).catch(() => {});
  await save();
  for (const [p, name] of [[welcome, 'FAIL-actual-extension-onboarding'], [options, 'FAIL-actual-extension-options'], [fixture, 'FAIL-actual-extension-page']]) await capture(p, name).catch(() => {});
} finally {
  const after = await inventory(extension); summary.installedFilesUnchanged = JSON.stringify(before) === JSON.stringify(after);
  if (!summary.installedFilesUnchanged) { summary.fullTranslationRestorePassed = false; process.exitCode = 1; }
  await writeFile(join(output, 'installed-files-after.json'), JSON.stringify(after, null, 2)); await save();
  if (context) await bounded(context.close(), 15000, 'browser cleanup').catch(() => {});
  server?.closeAllConnections(); if (server) await bounded(new Promise((resolve) => server.close(resolve)), 5000, 'fixture cleanup').catch(() => {});
  await bounded(rm(profile, { recursive: true, force: true }), 15000, 'temporary profile cleanup').catch(() => {});
  clearTimeout(watchdog);
  console.log(JSON.stringify({ fullTranslationRestorePassed: summary.fullTranslationRestorePassed, installedFilesUnchanged: summary.installedFilesUnchanged, results: summary.results }));
}
// A failed native renderer must not keep the test driver alive indefinitely.
process.exit(process.exitCode || 0);

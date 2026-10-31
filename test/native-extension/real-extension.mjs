// Actual installed extension, original bundled runtime and default .task model.
// No production-module injection, inference doubles, network mocks or bridges.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve, relative } from 'node:path';
import { tmpdir, cpus, totalmem } from 'node:os';
import { createServer } from 'node:http';
import { chromium, firefox } from 'playwright';
import { unusedPort, installFirefoxAddon } from './firefox-install.mjs';
const family = process.env.QA_BROWSER || 'chromium';
assert.ok(['chromium', 'firefox'].includes(family));
const root = process.cwd(), extension = resolve(family === 'firefox' ? 'build/firefox' : 'build/chrome');
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
    else files[relative(dir, file).replaceAll('\\', '/')] = createHash('sha256').update(await readFile(file)).digest('hex');
  } }
  await walk(dir); return Object.fromEntries(Object.entries(files).sort());
}
const before = await inventory(extension);
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const vendor = await inventory(join(root, 'node_modules/@mediapipe/tasks-genai'));
assert.equal(before['vendor/mediapipe/genai_bundle.js'], vendor['genai_bundle.mjs']);
for (const [name, hash] of Object.entries(before)) {
  if (name.startsWith('vendor/mediapipe/wasm/')) assert.equal(hash, vendor[name.replace('vendor/mediapipe/', '')], `original SDK asset: ${name}`);
}
assert.ok(!Object.keys(before).some((p) => /qa-capabilities|fixtures|runtime-double/.test(p)));
const backend = process.platform === 'darwin' ? 'metal' : 'swiftshader';
const browserFlags = backend === 'metal'
  ? ['--use-angle=metal', '--enable-unsafe-webgpu']
  : ['--use-angle=swiftshader',
      '--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'];
const summary = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  subject: 'Installed ' + (family === 'firefox' ? 'build/firefox' : 'build/chrome') + ' with the shipped runtime and original model', browserFamily: family,
  runtime: pkg.devDependencies['@mediapipe/tasks-genai'], model: 'translategemma-4b-it-int8-web.task',
  cpu: cpus()[0]?.model, logicalCpus: cpus().length, ram: totalmem(), platform: process.platform, backend, browserFlags,
  inferenceDouble: false, productionCodeInjection: false, nativeInferenceBridge: false,
  tracing: false, configuration: { maxTokens: 1024 }, results: [], errors: [], consoleMessages: [],
  telemetry: [], fullTranslationRestorePassed: false, stage: 'install' };
const save = () => writeFile(join(out, 'summary.json'), clean(JSON.stringify(summary, null, 2)));
async function stage(name) { summary.stage = name; console.log(JSON.stringify({ stage: name })); await save(); }
async function passed(name, detail = {}) { const item = { name, passed: true, ...detail }; summary.results.push(item); console.log(clean(JSON.stringify(item))); await save(); }
let context, server, welcome, options, page;
const profile = await mkdtemp(join(tmpdir(), 'autotranslate-native-'));
const watchdog = setTimeout(async () => { summary.failure = { stage: summary.stage, message: 'overall driver deadline' }; await save(); process.exit(2); }, 40 * 60000);
async function capture(p, name) {
  if (!p || p.isClosed()) return;
  await bound(p.bringToFront(), 10000, 'foreground screenshot page');
  if (family === 'firefox') {
    await bound(p.screenshot({ path: join(out, name + '.png'), fullPage: true, caret: 'initial', timeout: 30000 }), 35000, 'Firefox screenshot');
    await writeFile(join(out, name + '.html'), clean(await bound(p.content(), 10000, 'HTML'))); return;
  }
  const session = await context.newCDPSession(p);
  try {
    const { cssContentSize } = await bound(session.send('Page.getLayoutMetrics'), 10000, 'layout metrics');
    const clip = { x: 0, y: 0, width: Math.max(1, cssContentSize.width), height: Math.min(8192, Math.max(1, cssContentSize.height)), scale: 1 };
    const { data } = await bound(session.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: true, clip }), 30000, 'browser compositor capture');
    const png = Buffer.from(data, 'base64');
    assert.ok(png.length > 100 && png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])), 'a genuine PNG screenshot is required');
    await writeFile(join(out, name + '.png'), png);
  } finally { await session.detach().catch(() => {}); }
  await writeFile(join(out, name + '.html'), clean(await bound(p.content(), 10000, 'HTML')));
}
async function host(p) {
  return bound(p.evaluate(() => AT.sendMessage({ type: 'at/local-get-status' })), 10000, 'extension host status');
}
try {
  const firefoxPort = family === 'firefox' ? await unusedPort() : null;
  context = family === 'firefox' ? await firefox.launchPersistentContext(profile, {
    headless: process.env.HEADED !== '1', viewport: { width: 1200, height: 850 }, locale: 'en-US',
    args: ['--start-debugger-server', String(firefoxPort)],
    firefoxUserPrefs: { 'devtools.debugger.remote-enabled': true, 'devtools.debugger.prompt-connection': false, 'devtools.chrome.enabled': true, 'dom.webgpu.enabled': true }
  }) : await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: process.env.HEADED !== '1',
    ignoreDefaultArgs: ['--disable-extensions'], viewport: { width: 1200, height: 850 }, locale: 'en-US',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, ...browserFlags] });
  context.setDefaultTimeout(30000); summary.browser = context.browser().version();
  const observe = (p) => {
    p.on('pageerror', (e) => summary.errors.push(clean(e.message)));
    p.on('console', (m) => { if (['error', 'warning'].includes(m.type())) summary.consoleMessages.push(clean(m.text()).slice(0, 2000)); });
  };
  context.on('page', observe); context.pages().forEach(observe);
  let workerUrl = null;
  if (family === 'firefox') {
    summary.installation = await installFirefoxAddon(firefoxPort, extension);
  } else {
    const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    assert.match(sw.url(), /^chrome-extension:\/\/[^/]+\/background\.js$/);
    workerUrl = sw.url();
  }
  const deadline = Date.now() + 30000;
  while (!welcome && Date.now() < deadline) {
    welcome = context.pages().find((p) => /^(?:chrome|moz)-extension:\/\/[^/]+\/welcome\.html$/.test(p.url()));
    if (!welcome) await sleep(100);
  }
  assert.ok(welcome, 'installation must open the shipped onboarding');
  const id = welcome.url().split('/')[2]; summary.extensionId = id;
  const extensionOrigin = welcome.url().replace('/welcome.html', '');
  assert.ok(welcome, 'installation opens the real onboarding');
  await welcome.waitForFunction(() => document.querySelector('#targetLang').options.length > 1 && document.querySelector('#status').textContent.length > 0);
  assert.match(await welcome.title(), /Autotranslate/);
  summary.adapter = await welcome.evaluate(async () => {
    const a = await navigator.gpu?.requestAdapter();
    return a ? { vendor: a.info?.vendor, architecture: a.info?.architecture, description: a.info?.description,
      features: [...a.features], maxBufferSize: a.limits.maxBufferSize } : null;
  });
  assert.ok(summary.adapter, 'a real WebGPU adapter must be available');
  if (backend === 'metal' && family === 'chromium') assert.equal(summary.adapter.vendor, 'apple', 'Metal verification must not silently fall back to SwiftShader');
  await welcome.locator('#targetLang').selectOption('ko');
  await capture(welcome, '01-onboarding');
  await passed('installed-extension-and-onboarding', { serviceWorker: workerUrl, adapter: summary.adapter });
  // Choose the source through the real UI. Default context remains 1024.
  options = await context.newPage(); await options.goto(`${extensionOrigin}/options.html`);
  await options.waitForFunction(async () => {
    const s = await AT.settings.load();
    return document.querySelector('#sourceLang').value === s.sourceLang && document.querySelector('#targetLang').value === s.targetLang && document.querySelector('#localModel').value === s.localModelId && document.querySelector('#enabled').checked === s.enabled;
  });
  await options.locator('#sourceLang').selectOption('en'); await options.locator('#targetLang').selectOption('ko');
  assert.equal(await options.locator('#localMaxTokens').inputValue(), '1024');
  await options.locator('#save').click(); await options.waitForFunction(() => document.querySelector('#saveStatus').dataset.kind === 'ok');
  await options.close(); options = null;

  await stage('download-and-native-load');
  if (token) await welcome.locator('#modelToken').fill(token);
  assert.equal(await welcome.locator('#download').isDisabled(), false);
  await welcome.locator('#download').click();
  const installStart = performance.now(); let ready = false, last = '';
  while (performance.now() - installStart < 20 * 60000) {
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

  const cases = new Map();
  const shell = (body) => '<!doctype html><html lang="en"><head><meta charset="utf-8"><title translate="no">Native extension test</title><style>body{font:18px/1.6 system-ui;max-width:800px;margin:40px auto;padding:20px}a{color:#1659a5}pre{background:#eee;padding:12px}</style></head><body>' + body + '</body></html>';
  const controls = '<pre>npm install</pre><input id="draft" value="user draft"><button id="click" translate="no" onclick="this.dataset.clicks=String(Number(this.dataset.clicks||0)+1)">Click</button>';
  cases.set('/basic', shell('<main><p id="paragraph">Hello.</p>' + controls + '</main>'));
  cases.set('/article', shell('<main><h1>Install the application</h1><p id="paragraph">Your documents remain private.</p><p>Read <a href="#guide" id="guide">the installation guide</a> before continuing.</p>' + controls + '</main>'));
  server = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(cases.get(req.url) || shell('')); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`; summary.fixtureUrl = origin;
  summary.translationCases = [];
  options = await context.newPage(); await options.goto(`${extensionOrigin}/options.html`);
  await options.waitForFunction(async () => {
    const s = await AT.settings.load();
    return document.querySelector('#sourceLang').value === s.sourceLang && document.querySelector('#targetLang').value === s.targetLang && document.querySelector('#localModel').value === s.localModelId && document.querySelector('#enabled').checked === s.enabled;
  });
  for (const [name, selectors] of [['basic', ['#paragraph']], ['article', ['h1', '#paragraph', '#guide']]]) {
    await stage(`translate-${name}-through-extension`);
    page = await context.newPage(); const url = `${origin}/${name}`; await page.goto(url);
    assert.equal(await page.title(), 'Native extension test');
    const original = await page.evaluateHandle(() => {
      const elements = [...document.body.querySelectorAll('*')], nodes = []; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n;
      while ((n = w.nextNode())) nodes.push({ node: n, text: n.nodeValue });
      return { html: document.body.innerHTML, nodes, elements, attrs: elements.map((e) => JSON.stringify([...e.attributes].map((a) => [a.name, a.value]))) };
    });
    await capture(page, `${name}-before`);
    const tabId = await options.evaluate(async (url) => (await AT.api.tabs.query({})).find((t) => t.url === url)?.id, url);
    assert.ok(tabId);
    const beforeHost = (await host(options)).status;
    const result = { name, telemetry: [] }; summary.translationCases.push(result);
    // Observe rendered mutations without changing the page or any extension API.
    const renderTiming = await page.evaluateHandle((selectors) => {
      const timing = { started: performance.now(), firstMs: null, allMs: null };
      const observer = new MutationObserver(() => {
        const translated = selectors.map((s) => /[가-힣]/u.test(document.querySelector(s).textContent));
        if (timing.firstMs === null && translated.some(Boolean)) timing.firstMs = performance.now() - timing.started;
        if (timing.allMs === null && translated.every(Boolean)) timing.allMs = performance.now() - timing.started;
      });
      observer.observe(document.body, { subtree: true, characterData: true, childList: true });
      return { timing, observer };
    }, selectors);
    const start = performance.now();
    if (name === 'basic') await welcome.locator('#start').click();
    else {
      await options.reload(); await options.waitForFunction(async () => {
    const s = await AT.settings.load();
    return document.querySelector('#sourceLang').value === s.sourceLang && document.querySelector('#targetLang').value === s.targetLang && document.querySelector('#localModel').value === s.localModelId && document.querySelector('#enabled').checked === s.enabled;
  });
      await options.locator('#enabled').setChecked(true); await options.locator('#save').click();
    }
    let complete = false;
    while (performance.now() - start < 30 * 60000) {
      const render = await bound(page.evaluate((selectors) => Object.fromEntries(selectors.map((s) => [s, document.querySelector(s).textContent])), selectors), 10000, 'rendered HTML');
      const state = await bound(options.evaluate((tabId) => AT.sendMessage({ type: 'at/get-state', tabId }), tabId), 10000, 'tab state');
      result.rendered = render; result.tabState = state;
      result.telemetry.push({ elapsedMs: performance.now() - start, render, tab: state.state, host: state.local?.status });
      await save();
      if (state.state?.status === 'error') throw new Error(state.state.error || 'extension translation failure');
      if (state.state?.status === 'translated') { assert.ok(Object.values(render).every((s) => /[가-힣]/u.test(s))); complete = true; break; }
      await sleep(backend === 'metal' ? 200 : 3000);
    }
    assert.ok(complete, `installed extension translated all ${name} fixture text`);
    result.translateMs = performance.now() - start;
    result.renderTiming = await renderTiming.evaluate(({ timing, observer }) => { observer.disconnect(); return timing; });
    await renderTiming.dispose();
    result.firstTextMs = result.renderTiming.firstMs;
    assert.ok(result.firstTextMs !== null, 'actual translated DOM mutations were observed');
    result.afterTranslate = (await host(options)).status;
    assert.ok(result.afterTranslate.generations > beforeHost.generations);
    assert.equal(await page.locator('pre').innerText(), 'npm install'); assert.equal(await page.locator('#draft').inputValue(), 'user draft');
    if (name === 'article') assert.equal(await page.locator('#guide').getAttribute('href'), '#guide');
    await capture(page, `${name}-translated`);
    await passed(`${name}-native-page-translation`, { ms: result.translateMs, firstTextMs: result.firstTextMs, rendered: result.rendered, generations: result.afterTranslate.generations - beforeHost.generations });

    await stage(`restore-${name}-through-extension-options`);
    await options.reload(); await options.waitForFunction(() => document.querySelector('#enabled').checked);
    const restoreAt = performance.now(); await options.locator('#enabled').setChecked(false); await options.locator('#save').click();
    await page.waitForFunction(() => !/[가-힣]/u.test(document.querySelector('#paragraph').textContent));
    const restored = await original.evaluate((o) => ({ html: document.body.innerHTML === o.html,
      text: o.nodes.every(({ node, text }) => node.nodeValue === text), elements: o.elements.every((e, i) => e === document.body.querySelectorAll('*')[i]),
      attributes: o.elements.every((e, i) => JSON.stringify([...e.attributes].map((a) => [a.name, a.value])) === o.attrs[i]) }));
    assert.ok(Object.values(restored).every(Boolean), JSON.stringify(restored)); result.restoreMs = performance.now() - restoreAt;
    await capture(page, `${name}-restored`); await page.locator('#click').click(); assert.equal(await page.locator('#click').getAttribute('data-clicks'), '1');
    await passed(`${name}-exact-html-restoration-and-events`, { ...restored, ms: result.restoreMs });
    result.passed = true;
    if (name === 'basic') summary.basicTranslationRestorePassed = true;
    await original.dispose(); await page.close(); page = null; await save();
  }
  assert.deepEqual(summary.errors, []); summary.fullTranslationRestorePassed = true;

} catch (error) {
  summary.failure = { stage: summary.stage, message: clean(error.message) }; process.exitCode = 1; console.error(JSON.stringify(summary.failure)); await save();
  for (const [p, name] of [[welcome, 'FAIL-onboarding'], [options, 'FAIL-options'], [page, 'FAIL-page']]) {
    if (p && !p.isClosed()) { if (await p.locator('#modelToken').count()) await p.locator('#modelToken').fill('').catch(() => {}); await capture(p, name).catch(() => {}); }
  }
} finally {
  summary.installedFilesUnchanged = JSON.stringify(before) === JSON.stringify(await inventory(extension));
  if (!summary.installedFilesUnchanged) { summary.fullTranslationRestorePassed = false; process.exitCode = 1; }
  await writeFile(join(out, 'installed-files-before.json'), JSON.stringify(before, null, 2));
  await writeFile(join(out, 'installed-files-after.json'), JSON.stringify(await inventory(extension), null, 2));
  await save();
  if (context) await bound(context.close(), 15000, 'browser shutdown').catch(() => {});
  if (server) { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
  await bound(rm(profile, { recursive: true, force: true }), 10000, 'profile cleanup').catch(() => {});
  clearTimeout(watchdog);
  await new Promise((resolve) => process.stdout.write(JSON.stringify({ fullTranslationRestorePassed: summary.fullTranslationRestorePassed, installedFilesUnchanged: summary.installedFilesUnchanged, failure: summary.failure }) + '\n', resolve));
  process.exit(process.exitCode || (summary.fullTranslationRestorePassed ? 0 : 1));
}

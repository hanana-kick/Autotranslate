import assert from 'node:assert/strict';
import test from 'node:test';
import { setTabEnabledUI, tabIdFor, optionsReady } from '../native-extension/tab-control.mjs';
import { cp, mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { chromium, launchOptions, ROOT, OUTPUT, screenshot } from './support.mjs';

// Chromium's REAL extension service worker, offscreen document, runtime IPC,
// scripting injection, storage, IndexedDB and OPFS. ONLY model inference and
// GPU capability are replaced in an isolated copy of the build. Release files
// are never patched. Real TranslateGemma/hardware validation is a separate gate.
let temporary, context, control, server, origin, extensionId;
const errors = [];
const pages = new Map();
const documentHtml = (content) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title translate="no">Autotranslate integration fixture</title></head><body><main>${content}</main></body></html>`;
async function policy(patch) { return control.evaluate((value) => AT.settings.save(value), patch); }
async function model(patch = {}) { return control.evaluate((value) => AT.sendMessage({ type: 'qa/control', ...value }), patch); }
async function until(fn, description, timeout = 10000) {
  const end = Date.now() + timeout;
  do { if (await fn()) return; await new Promise((resolve) => setTimeout(resolve, 30)); } while (Date.now() < end);
  throw new Error(`timed out: ${description}`);
}
async function fixture(path, html) {
  pages.set(path, documentHtml(html));
  const page = await context.newPage();
  await page.goto(`${origin}${path}`);
  return page;
}
async function select(page, value) { await setTabEnabledUI(control, await tabIdFor(control, page), value); }
async function stopPolicy() {
  if (!control || control.isClosed()) return;
  await control.evaluate(async () => {
    for (const tab of await AT.api.tabs.query({})) if (tab.id != null && /^https?:/.test(tab.url || '')) {
      await AT.sendMessage({type:AT.C.MSG.SET_TAB_ENABLED,tabId:tab.id,enabled:false});
    }
  });
  await policy({ enabled: false, siteRules: [] });
  await model({ release: true, failWarmup: false }).catch(() => {});
  for (const page of context.pages()) if (page !== control) await page.close();
}

test.before(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'autotranslate-extension-'));
  const extension = join(temporary, 'extension');
  await cp(join(ROOT, 'build/chrome'), extension, { recursive: true });
  const original = await readFile(join(extension, 'offscreen.html'), 'utf8');
  assert.ok(!original.includes('qa-capabilities'), 'release build contains no test capabilities');
  await cp(join(ROOT, 'test/browser/fixtures/capabilities.js'), join(extension, 'qa-capabilities.js'));
  const workerEntry = join(extension, 'inference-worker.js');
  await writeFile(workerEntry, "importScripts('qa-capabilities.js');\n" + await readFile(workerEntry, 'utf8'));
  await cp(join(ROOT, 'test/browser/fixtures/runtime.mjs'), join(extension, 'vendor/mediapipe/genai_bundle.js'));
  await writeFile(join(extension, 'offscreen.html'), original.replace('<body>', '<body><script src="qa-capabilities.js"></script>'));
  server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(pages.get(request.url) ?? documentHtml(''));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  context = await chromium.launchPersistentContext(join(temporary, 'profile'), {
    ...launchOptions,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [...launchOptions.args, `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    viewport: { width: 1100, height: 800 }, locale: 'en-US'
  });
  context.setDefaultTimeout(10000);
  context.on('page', (page) => page.on('pageerror', (error) => errors.push({ url: page.url(), error: error.message })));
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15000 });
  extensionId = worker.url().split('/')[2];
  control = await context.newPage();
  await control.goto(`chrome-extension://${extensionId}/options.html`);
  await control.waitForFunction(() => !!globalThis.AT?.settings);
  // Wait for the actual host listener, created by the options status probe.
  await until(async () => (await model().catch(() => null))?.ok === true, 'offscreen host');
}, { timeout: 30000 });

test.after(async () => {
  await mkdir(OUTPUT, { recursive: true });
  await writeFile(join(OUTPUT, 'extension-page-errors.json'), JSON.stringify(errors, null, 2));
  if (context) {
    await context.tracing.stop({ path: join(OUTPUT, 'extension-trace.zip') }).catch(() => {});
    await context.close();
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

function check(name, fn) {
  test(name, { timeout: 30000 }, async () => {
    try { await fn(); }
    catch (error) {
      for (const [index, page] of context.pages().entries()) await screenshot(page, `FAIL-extension-${index}`).catch(() => {});
      throw error;
    } finally { await stopPolicy(); }
  });
}

check('onboarding renders and requires a working model before Start', async () => {
  const page = await context.newPage(); await page.goto(`chrome-extension://${extensionId}/welcome.html`);
  await page.waitForFunction(() => document.querySelector('#targetLang').options.length > 1);
  assert.match(await page.title(), /Autotranslate/i);
  assert.ok((await page.locator('main').innerText()).length > 80);
  assert.equal(await page.locator('#start').isDisabled(), true);
  await page.locator('#targetLang').selectOption('ko');
  assert.equal(await page.locator('#targetLang').inputValue(), 'ko');
  await screenshot(page, 'onboarding-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await screenshot(page, 'onboarding-mobile');
});

check('native Fetch streams bytes into real OPFS and persists IndexedDB metadata', async () => {
  const bytes = Buffer.alloc(1024 * 1024 + 7, 165);
  let authorization;
  await context.route('https://model-fixture.invalid/native.task', async (route) => {
    authorization = route.request().headers().authorization;
    await route.fulfill({ status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) }, body: bytes });
  });
  const result = await control.evaluate(async () => {
    const saved = await AT.modelstore.download({ url: 'https://model-fixture.invalid/native.task', token: 'fixture-not-a-real-token' });
    if (!saved.ok) throw new Error(saved.error);
    const file = await AT.modelstore.read(saved.record.id);
    return { id: saved.record.id, size: file.size, first: new Uint8Array(await file.slice(0, 1).arrayBuffer())[0] };
  });
  assert.equal(result.size, bytes.length); assert.equal(result.first, 165);
  assert.equal(authorization, undefined, 'HF tokens must not leave for other hosts');
  await control.reload(); await control.waitForFunction(() => !!globalThis.AT?.modelstore);
  assert.equal(await control.evaluate((id) => AT.modelstore.get(id).then((record) => record?.size), result.id), bytes.length);
  await control.evaluate((id) => AT.modelstore.remove(id), result.id);
});

check('file picker installs through the real UI and starts the extension', async () => {
  const page = await context.newPage(); await page.goto(`chrome-extension://${extensionId}/welcome.html`);
  await page.locator('#targetLang').selectOption('ko');
  await page.locator('#modelFile').setInputFiles({ name: 'fixture.task', mimeType: 'application/octet-stream', buffer: Buffer.alloc(1024 * 1024, 17) });
  await page.waitForFunction(() => !document.querySelector('#start').disabled);
  await screenshot(page, 'model-ready');
  await page.locator('#start').click();
  await until(async () => !!(await control.evaluate(() => AT.settings.load())).localModelId, 'onboarding stores a working model');
  assert.equal((await control.evaluate(() => AT.settings.load())).enabled,false,'setup must not auto-enroll tabs');
  const settings = await control.evaluate(() => AT.settings.load());
  assert.equal(settings.targetLang, 'ko'); assert.ok(settings.localModelId);
});

check('background to offscreen to content translates links safely then restores all nodes', async () => {
  const page = await fixture('/inline', '<p>Read <a href="/privacy" class="policy">privacy policy</a> before you continue.</p>');
  await policy({ sourceLang: 'en', targetLang: 'ja' }); await select(page, true);
  await page.waitForFunction(() => document.querySelector('a').textContent === 'プライバシーポリシー');
  assert.equal(await page.locator('a').getAttribute('href'), '/privacy');
  assert.equal(await page.locator('a').getAttribute('class'), 'policy');
  await screenshot(page, 'extension-inline-translated');
  await select(page, false);
  await page.waitForFunction(() => document.querySelector('p').textContent === 'Read privacy policy before you continue.');
});

check('turning off during native host work restores without waiting for inference', async () => {
  const page = await fixture('/cancel', '<p>Original text</p>');
  await model({ hold: true }); await policy({ sourceLang: 'en', targetLang: 'ko' }); await select(page, true);
  await until(async () => (await model()).pending === 1, 'inference held');
  const start = Date.now(); await select(page, false);
  const tab = await control.evaluate(async (url) => (await AT.api.tabs.query({})).find((item) => item.url === url), page.url());
  await until(async () => (await control.evaluate((id) => AT.api.tabs.sendMessage(id, { type: AT.C.MSG.CONTENT_STATE }), tab.id)).status === 'idle', 'immediate restore ack');
  assert.ok(Date.now() - start < 2500);
  await model({ release: true });
  await page.waitForTimeout(150);
  assert.equal(await page.locator('p').textContent(), 'Original text');
});

check('native MutationObserver catches content inserted during the initial inference', async () => {
  const page = await fixture('/mutation', '<p>First paragraph</p>');
  await model({ hold: true }); await policy({ sourceLang: 'en', targetLang: 'ko' }); await select(page, true);
  await until(async () => (await model()).pending === 1, 'inference held');
  await page.evaluate(() => document.querySelector('main').insertAdjacentHTML('beforeend', '<p id="inserted">Inserted during inference</p>'));
  await model({ release: true });
  await page.waitForFunction(() => document.querySelector('#inserted').textContent === '추론 중 추가된 문단');
});

check('failed replacement keeps the selected model and both native files recoverable', async () => {
  const before = await control.evaluate(() => AT.settings.load());
  await model({ failWarmup: true });
  const outcome = await control.evaluate(async () => AT.modelflow.installFromFile(new File([new Uint8Array(1024 * 1024)], 'fixture.task')));
  assert.equal(outcome.ok, false); assert.equal(outcome.stored, true);
  assert.match(outcome.error, /warmup rejected/);
  assert.equal((await control.evaluate(() => AT.settings.load())).localModelId, before.localModelId);
  assert.equal(await control.evaluate(async (id) => (await AT.modelstore.read(id))?.size, before.localModelId), 1024 * 1024);
  await model({ failWarmup: false });
  await control.evaluate((id) => AT.modelstore.remove(id), outcome.modelId);
});

check('a terminated service worker restores already translated tabs after restart', async () => {
  const page = await fixture('/restart', '<p>Original text</p>');
  await policy({ sourceLang:'en', targetLang: 'ko' }); await select(page, true);
  await page.waitForFunction(() => document.querySelector('p').textContent === '원문 번역');
  const session = await context.newCDPSession(control);
  let version;
  session.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
    for (const entry of versions) if (entry.scriptURL === `chrome-extension://${extensionId}/background.js`) version = entry;
  });
  await session.send('ServiceWorker.enable');
  await until(() => version?.runningStatus === 'running', 'running worker version');
  await session.send('ServiceWorker.stopWorker', { versionId: version.versionId });
  await until(() => version?.runningStatus === 'stopped', 'worker termination');
  const recovered = await control.evaluate(id => AT.sendMessage({type:AT.C.MSG.GET_STATE,tabId:id}),await tabIdFor(control,page));
  assert.equal(recovered.tabEnabled,true,'service-worker sleep does not reset the explicit choice');
  await select(page, false);
  await page.waitForFunction(() => document.querySelector('p').textContent === 'Original text');
  await session.detach();
});

check('two same-site tabs require independent consent, including after activation and reload', async () => {
  const a=await fixture('/consent-a','<p>Original text</p>');
  const b=await fixture('/consent-b','<p>Original text</p>');
  await policy({enabled:true, sourceLang:'en',targetLang:'ko',siteRules:[{pattern:'127.0.0.1',action:'always'}]});
  await a.bringToFront(); await b.bringToFront(); await b.waitForTimeout(350);
  assert.equal(await a.locator('p').innerText(),'Original text'); assert.equal(await b.locator('p').innerText(),'Original text');
  await select(a,true); await a.waitForFunction(()=>document.querySelector('p').textContent==='원문 번역');
  assert.equal(await b.locator('p').innerText(),'Original text');
  await a.reload(); await a.bringToFront();await a.waitForFunction(()=>document.querySelector('p').textContent==='원문 번역');
  await select(b,true);await b.waitForFunction(()=>document.querySelector('p').textContent==='원문 번역');
  await select(a,false);await a.waitForFunction(()=>document.querySelector('p').textContent==='Original text');
  assert.equal(await b.locator('p').innerText(),'원문 번역');
  await a.reload();await a.waitForTimeout(350);assert.equal(await a.locator('p').innerText(),'Original text');
  await screenshot(control,'options-bound-tab-off');
});

check('separate options window remains bound to the originating tab and disables a closed target', async () => {
  const a=await fixture('/window-a','<p>Original text</p>');const b=await fixture('/window-b','<p>Original text</p>');
  await policy({sourceLang:'en',targetLang:'ko'});
  const id=await tabIdFor(control,a);
  const created=context.waitForEvent('page',p=>p!==a&&p!==b&&p!==control);
  assert.equal(await control.evaluate(id=>AT.ui.openPage('options.html','window',id),id),'window');
  const panel=await created;await optionsReady(panel);
  assert.equal(new URL(panel.url()).searchParams.get('tabId'),String(id));
  const kind=await panel.evaluate(async()=>{const t=(await AT.api.tabs.query({active:true,currentWindow:true}))[0];return (await AT.api.windows.get(t.windowId)).type;});
  assert.equal(kind,'popup','real separate browser window, not tabs.create');
  await b.bringToFront();await panel.bringToFront();
  await panel.locator('#enabled').check();await a.waitForFunction(()=>document.querySelector('p').textContent==='원문 번역');
  assert.equal(await b.locator('p').innerText(),'Original text');
  await panel.setViewportSize({width:390,height:780});assert.ok(await panel.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await screenshot(panel,'options-separate-window');
  await a.close();await panel.waitForFunction(()=>document.querySelector('#enabled').disabled&&!document.querySelector('#enabled').checked);
});

check('unbound options cannot silently choose an active web tab', async () => {
  await control.goto('chrome-extension://'+extensionId+'/options.html');await optionsReady(control);
  assert.equal(await control.locator('#enabled').isDisabled(),true);assert.equal(await control.locator('#enabled').isChecked(),false);
});

test('extension UI and injected pages have no uncaught JavaScript errors', () => { assert.deepEqual(errors, []); });

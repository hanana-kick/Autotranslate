// Genuine CPU inference, not a translation stub. The production content script,
// planner, DOM executor, engine, prompts and response parser are used unchanged.
// ONLY the host transport is bridged to llama.cpp because the shipped MediaPipe
// Web runtime requires WebGPU. These timings are NOT MediaPipe benchmarks.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { cpus, totalmem } from 'node:os';
import { runInThisContext } from 'node:vm';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
const root = process.cwd();
const out = resolve(process.env.CPU_QA_DIR || 'test-results/cpu-real');
const endpoint = process.env.LLAMA_URL || 'http://127.0.0.1:8766';
await mkdir(out, { recursive: true });
for (const name of ['constants', 'gemma', 'local', 'targets', 'pagecontext', 'engines']) {
  runInThisContext(await readFile(join(root, 'build/ts/src/lib', `${name}.js`), 'utf8'));
}
const AT = globalThis.AT;
const calls = [], checks = [], errors = [];
let phase = 'warmup';
const post = async (path, payload) => {
  const response = await fetch(endpoint + path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json();
};
const count = async (text) => (await post('/tokenize', { content: text, add_special: false })).tokens.length;
async function generation(prompt, texts, maxTokens) {
  const inputTokens = await count(prompt);
  const available = Math.min(192, maxTokens - inputTokens);
  assert.ok(available > 8, 'the complete prompt leaves room for output');
  const started = performance.now();
  const response = await post('/completion', { prompt, n_predict: available, temperature: 0, top_k: 1,
    seed: 42, stream: false, cache_prompt: false, stop: ['<end_of_turn>', '<eos>'] });
  const record = { phase, texts, prompt, output: response.content, elapsedMs: performance.now() - started,
    inputTokens, timings: response.timings, truncated: response.truncated, stopType: response.stop_type };
  calls.push(record);
  await writeFile(join(out, 'generations.json'), JSON.stringify(calls, null, 2));
  console.log(JSON.stringify({ phase, inputTokens, ms: Math.round(record.elapsedMs), output: response.content }));
  assert.ok(response.content?.trim(), 'real inference returned nonempty text');
  assert.notEqual(response.stop_type, 'limit', 'translation must not be silently cut at the output limit');
  return response.content.trim();
}
async function translateParts(source, target, texts, maxTokens, hint) {
  const prompt = AT.local.buildBatchPrompt(source || null, target, texts, texts.length > 1 ? hint : null);
  const inputTokens = await count(prompt);
  const reserve = Math.max(24, texts.reduce((sum, text) => sum + AT.local.estimateTokens(text), 0));
  if (texts.length > 1 && inputTokens + reserve > maxTokens) {
    const mid = Math.ceil(texts.length / 2);
    return [...await translateParts(source, target, texts.slice(0, mid), maxTokens, hint),
      ...await translateParts(source, target, texts.slice(mid), maxTokens, hint)];
  }
  const reply = await generation(prompt, texts, maxTokens);
  if (texts.length === 1) return [reply];
  const parsed = AT.local.parseNumbered(reply, texts.length);
  if (parsed) return parsed;
  const result = [];
  for (const text of texts) result.push(...await translateParts(source, target, [text], maxTokens, null));
  return result;
}
AT.local.callHost = async (message) => {
  if (message.type === AT.C.MSG.LOCAL_COUNT) {
    const prompt = AT.local.buildTranslatePrompt(message.source || 'en', message.target || 'ko', '');
    return { ok: true, counts: await Promise.all(message.texts.map(count)), overhead: await count(prompt) };
  }
  if (message.type === AT.C.MSG.LOCAL_TRANSLATE) {
    return { ok: true, translations: await translateParts(message.source, message.target, message.texts,
      message.maxTokens, message.context) };
  }
  throw new Error(`unexpected CPU bridge message: ${message.type}`);
};
const shell = (body, lang = 'en') => `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title translate="no">Autotranslate CPU validation</title><style>
body{font:18px/1.6 system-ui;margin:32px auto;max-width:850px;padding:0 24px;color:#222}nav,footer{padding:12px;background:#eee}main{padding:16px 0}a{color:#1458aa}pre{padding:12px;background:#eee}button,input{font:inherit}h1{font-size:28px}p{margin:18px 0}</style></head><body>${body}</body></html>`;
const pages = new Map();
const server = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(pages.get(req.url) || shell('')); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--disable-gpu'] });
const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
await context.tracing.start({ screenshots: true, snapshots: true });
async function open(name, body, source = 'en') {
  pages.set(`/${name}`, shell(body, source));
  const page = await context.newPage();
  page.setDefaultTimeout(180000);
  page.on('pageerror', (error) => errors.push({ name, error: error.message }));
  await page.goto(`${origin}/${name}`);
  for (const file of ['constants', 'pagecontext', 'targets', 'pipeline', 'dom']) {
    await page.addScriptTag({ content: await readFile(join(root, 'build/ts/src/lib', `${file}.js`), 'utf8') });
  }
  await page.exposeFunction('cpuBatch', async (message) => {
    try {
      const result = await AT.engines.translate({ texts: message.texts, source: message.sourceLang,
        target: message.targetLang, role: message.role, context: message.context,
        localModelId: 'real-translategemma-4b-q8-cpu', localMaxTokens: 1024 });
      return { ok: true, ...result };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  await page.evaluate((sourceLang) => {
    window.qa = { started: 0, reports: [], handlers: {}, settings: { enabled: true, sourceLang,
      targetLang: 'ko', maxNodes: 600, showBadge: false, translationKey: 'cpu-q8-ko' } };
    AT.onMessage = (handlers) => Object.assign(qa.handlers, handlers);
    AT.runtime = { getManifest: () => ({ version: 'cpu-audit' }) };
    AT.i18n = { msg: (key) => key };
    AT.sendMessage = (message) => {
      if (message.type === 'at/batch') { qa.started++; return window.cpuBatch(message); }
      qa.reports.push({ ...message, atMs: performance.now() }); return Promise.resolve({ ok: true });
    };
  }, source);
  await page.addScriptTag({ content: await readFile(join(root, 'build/ts/src/content.js'), 'utf8') });
  await page.evaluate(() => {
    qa.original = document.body.innerHTML;
    qa.elements = [...document.body.querySelectorAll('*')];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    qa.nodes = []; let node; while ((node = walker.nextNode())) qa.nodes.push({ node, text: node.nodeValue });
    qa.attributes = qa.elements.map((el) => JSON.stringify([...el.attributes].map((a) => [a.name, a.value])));
    qa.start = () => { qa.startAt = performance.now(); return qa.handlers['at/content-translate']({ settings: qa.settings, decision: { action: 'translate' } }); };
    qa.restore = () => qa.handlers['at/content-restore']();
  });
  return page;
}
async function capture(page, name) {
  // Default caret hiding adds an empty style attribute to inputs. Preserve the
  // real DOM: screenshots must not cause the attribute mismatch being tested.
  await page.screenshot({ path: join(out, `${name}.png`), fullPage: true, caret: 'initial' });
  await writeFile(join(out, `${name}.html`), await page.content());
}
async function exactRestore(page) {
  return page.evaluate(async () => {
    const start = performance.now(); const reply = await qa.restore(); const ms = performance.now() - start;
    return { ms, reply, exactHtml: document.body.innerHTML === qa.original,
      exactText: qa.nodes.every(({ node, text }) => node.nodeValue === text),
      sameElements: qa.elements.every((el, i) => el === document.body.querySelectorAll('*')[i]),
      sameAttributes: qa.elements.every((el, i) => JSON.stringify([...el.attributes].map((a) => [a.name, a.value])) === qa.attributes[i]) };
  });
}
async function check(name, fn) {
  const start = performance.now(); phase = name;
  try { const detail = await fn(); checks.push({ name, passed: true, ms: performance.now() - start, ...detail }); }
  catch (error) {
    checks.push({ name, passed: false, error: error.stack }); process.exitCode = 1;
    for (const [index, page] of context.pages().entries()) await capture(page, `${name}-failure-${index}`).catch(() => {});
    console.error(error);
  } finally {
    await writeFile(join(out, 'checks.json'), JSON.stringify(checks, null, 2));
    for (const page of context.pages()) await page.close();
  }
}
try {
  await generation(AT.local.buildTranslatePrompt('en', 'ko', 'The page is ready.'), ['The page is ready.'], 1024);
  await check('article-translate-cache-restore', async () => {
    const page = await open('article', '<nav>Documentation</nav><main><h1>Install the application</h1><p>The application runs on your computer. Your documents remain private.</p><p>Read <a id="guide" href="#guide">the installation guide</a> before continuing.</p><pre>npm install</pre><input id="draft" value="user draft"><button id="button" translate="no">Click</button></main><footer>Contact support</footer>');
    await page.evaluate(() => { qa.clicks = 0; document.querySelector('#button').addEventListener('click', () => qa.clicks++); document.querySelector('#draft').focus(); });
    await capture(page, 'article-before');
    assert.equal(await page.evaluate(() => document.body.innerHTML === qa.original), true, 'the capture itself must not mutate authored HTML');
    const start = performance.now(), before = calls.length;
    const result = await page.evaluate(() => qa.start());
    const elapsedMs = performance.now() - start;
    assert.equal(result.failed, 0);
    const firstApplyMs = await page.evaluate(() => (qa.reports.find((r) => r.translated > 0)?.atMs ?? performance.now()) - qa.startAt);
    const text = await page.locator('main').innerText();
    assert.match(text, /[가-힣]/u, 'genuine Korean output reached the HTML');
    assert.equal(await page.locator('pre').innerText(), 'npm install');
    assert.equal(await page.locator('#draft').inputValue(), 'user draft');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'draft', 'translation preserves focus');
    assert.ok((await page.locator('#guide').innerText()).trim());
    assert.equal(await page.locator('#guide').getAttribute('href'), '#guide');
    await page.locator('#button').click(); assert.equal(await page.evaluate(() => qa.clicks), 1);
    await capture(page, 'article-translated');
    const changedNodes = await page.evaluate(() => qa.nodes.filter(({ node, text }) => node.nodeValue !== text).length);
    assert.equal(changedNodes, 7, 'all seven eligible text nodes changed through real inference');
    const after = calls.length, cacheStart = performance.now();
    await page.evaluate(() => qa.start());
    const cacheMs = performance.now() - cacheStart;
    assert.equal(calls.length, after, 'unchanged page does not infer again');
    const restore = await exactRestore(page);
    assert.ok(restore.exactHtml && restore.exactText && restore.sameElements && restore.sameAttributes, JSON.stringify(restore));
    await capture(page, 'article-restored'); await page.close();
    return { elapsedMs, firstApplyMs, generations: after - before, changedNodes, cacheMs, restore, result, renderedText: text };
  });
  await check('japanese-to-korean-restore', async () => {
    const page = await open('japanese', '<main><h1>利用案内</h1><p>このアプリはオフラインで動作します。</p><p>設定画面で言語を選択してください。</p></main>', 'ja');
    const start = performance.now(), before = calls.length;
    const result = await page.evaluate(() => qa.start());
    const elapsedMs = performance.now() - start;
    assert.equal(result.failed, 0);
    assert.match(await page.locator('main').innerText(), /[가-힣]/u);
    await capture(page, 'japanese-translated');
    const restore = await exactRestore(page); assert.ok(restore.exactHtml && restore.exactText);
    await page.close(); return { elapsedMs, generations: calls.length - before, restore };
  });
  await check('insertion-during-real-inference', async () => {
    const page = await open('dynamic', '<main><p>The service keeps your files private.</p></main>');
    await page.evaluate(() => { qa.running = qa.start(); });
    await page.waitForFunction(() => qa.started > 0);
    await page.evaluate(() => { const p = document.createElement('p'); p.id = 'inserted'; p.textContent = 'A new message has arrived.'; document.querySelector('main').append(p); });
    await page.evaluate(() => qa.running);
    await page.waitForFunction(() => /[가-힣]/u.test(document.querySelector('#inserted').textContent));
    await capture(page, 'dynamic-translated');
    await page.evaluate(() => qa.restore());
    assert.equal(await page.locator('#inserted').innerText(), 'A new message has arrived.');
    await page.close(); return { observedAndTranslated: true, restoredInsertedText: true };
  });
  await check('restore-during-real-inference', async () => {
    const page = await open('cancel', '<main><p>Please save your document before closing the window.</p></main>');
    await page.evaluate(() => { qa.running = qa.start(); });
    await page.waitForFunction(() => qa.started > 0);
    const restore = await exactRestore(page); assert.ok(restore.exactHtml);
    const result = await page.evaluate(() => qa.running);
    assert.equal(result.status, 'cancelled');
    assert.equal(await page.evaluate(() => document.body.innerHTML === qa.original), true);
    await page.close(); return { restore, result, lateResultDiscarded: true };
  });
  await check('page-edit-during-real-inference', async () => {
    const page = await open('edit', '<main><p id="edit">The original announcement is available.</p></main>');
    await page.evaluate(() => { qa.running = qa.start(); });
    await page.waitForFunction(() => qa.started > 0);
    await page.evaluate(() => { document.querySelector('#edit').firstChild.nodeValue = 'A newer announcement replaces the old message.'; });
    await page.evaluate(() => qa.running);
    await page.waitForFunction(() => /[가-힣]/u.test(document.querySelector('#edit').textContent));
    await page.evaluate(() => qa.restore());
    assert.equal(await page.locator('#edit').innerText(), 'A newer announcement replaces the old message.');
    await page.close(); return { newestSourceRestored: true };
  });
  await check('target-change-restarts-from-source', async () => {
    const page = await open('retarget', '<main><p>Choose a language.</p></main>');
    await page.evaluate(() => qa.start());
    await page.evaluate(() => { qa.settings = { ...qa.settings, targetLang: 'ja', translationKey: 'cpu-q8-ja' }; return qa.start(); });
    await capture(page, 'retarget-japanese');
    assert.match(await page.locator('main').innerText(), /[\u3040-\u30ff\u4e00-\u9fff]/u);
    const restore = await exactRestore(page); assert.ok(restore.exactHtml);
    await page.close(); return { restore };
  });
  assert.deepEqual(errors, []);
} catch (error) {
  for (const [index, page] of context.pages().entries()) await capture(page, `failure-${index}`).catch(() => {});
  process.exitCode = 1; console.error(error);
} finally {
  const summary = { sourceCommit: process.env.GITHUB_SHA || null, runtime: 'llama.cpp b11979 CPU (-ngl 0)',
    model: 'mradermacher/translategemma-4b-it-GGUF Q8_0', modelSha256: 'f5006ddf207becaace1668113a61b31cf8b2e03f0f0baa0d1ca37eb8371d4bc1',
    scope: 'Production content, planner, DOM, engine and prompts; native CPU host bridge, NOT MediaPipe performance',
    cpu: cpus()[0]?.model, logicalCpus: cpus().length, ramBytes: totalmem(), browser: browser.version(),
    origin, viewport: { width: 1100, height: 800 }, checks, generations: calls.length, errors };
  await writeFile(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  await context.tracing.stop({ path: join(out, 'trace.zip') });
  await browser.close(); await new Promise((resolve) => server.close(resolve));
  console.log(JSON.stringify({ checks: checks.length, passed: checks.filter((c) => c.passed).length, generations: calls.length }));
}

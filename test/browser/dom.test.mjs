import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, launchOptions, scripts, screenshot } from './support.mjs';

// Real Chromium DOM and MutationObserver; the translator is deterministic. No
// model-quality or GPU-performance claim is made by these tests.
let browser;
test.before(async () => { browser = await chromium.launch(launchOptions); });
test.after(async () => { await browser?.close(); });

function check(name, fn) {
  test(name, { timeout: 20000 }, async () => {
    const page = await browser.newPage({ viewport: { width: 1100, height: 780 } });
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.setContent('<!doctype html><title translate="no">Autotranslate DOM regression</title><main id="fixture"></main>');
      await scripts(page, ['lib/constants.js', 'lib/pagecontext.js', 'lib/targets.js', 'lib/dom.js', 'lib/pipeline.js']);
      await fn(page);
      assert.deepEqual(errors, [], 'no uncaught browser errors');
    } catch (error) {
      await screenshot(page, `FAIL-dom-${name.replace(/[^a-z0-9]+/gi, '-')}`).catch(() => {});
      throw error;
    } finally { await page.close(); }
  });
}

check('aligned inline text preserves the link and restores exact authored nodes', async (page) => {
  const result = await page.evaluate(async () => {
    const root = document.querySelector('#fixture');
    root.innerHTML = '<p>Read <a href="/privacy" class="link">privacy policy</a> before you continue.</p>';
    const original = root.innerHTML;
    const link = root.querySelector('a');
    let clicked = 0;
    link.addEventListener('click', (event) => { event.preventDefault(); clicked++; });
    const translator = AT.dom.createTranslator({ doc: document,
      translate: async () => ['먼저 \uE0001\uE001개인정보처리방침\uE0002\uE001 을 읽으세요.'] });
    await translator.translateRoot(root);
    link.click();
    const answer = { text: root.textContent, link: link.textContent, href: link.getAttribute('href'), same: link === root.querySelector('a'), clicked };
    translator.restore(root);
    return { ...answer, restored: root.innerHTML === original };
  });
  assert.equal(result.link, '개인정보처리방침');
  assert.equal(result.href, '/privacy');
  assert.equal(result.same, true);
  assert.equal(result.clicked, 1);
  assert.equal(result.restored, true);
});

check('lost markers never move unrelated words into a link including unspaced CJK', async (page) => {
  const result = await page.evaluate(async () => {
    const root = document.querySelector('#fixture');
    root.innerHTML = '<h1>Inline link safety</h1><p>Read <a href="/privacy">privacy policy</a> before you continue.</p>';
    const dictionary = { Read: '読んで', 'privacy policy': 'プライバシーポリシー', 'before you continue.': '続ける前に。', 'Inline link safety': 'リンクの意味を保持' };
    const translator = AT.dom.createTranslator({ doc: document,
      translate: async (texts) => texts.map((text) => dictionary[text] ?? '続ける前にプライバシーポリシーを読んでください。') });
    await translator.translateRoot(root);
    return { link: root.querySelector('a').textContent, text: root.textContent };
  });
  assert.equal(result.link, 'プライバシーポリシー');
  await screenshot(page, 'inline-link-safe');
});

check('late inference cannot replace a newer page edit and the edit remains eligible', async (page) => {
  const result = await page.evaluate(async () => {
    const root = document.querySelector('#fixture'); root.innerHTML = '<p>Old source</p>';
    const node = root.querySelector('p').firstChild;
    let resolve;
    const translator = AT.dom.createTranslator({ doc: document,
      translate: () => new Promise((done) => { resolve = done; }) });
    const running = translator.translateRoot(root);
    node.nodeValue = 'New page value';
    resolve(['오래된 번역']); await running;
    return { text: node.nodeValue, eligible: translator.collect(root).includes(node) };
  });
  assert.deepEqual(result, { text: 'New page value', eligible: true });
});

check('partial paragraph failures retain original segments and retry the whole unit', async (page) => {
  const result = await page.evaluate(async () => {
    const root = document.querySelector('#fixture'); root.innerHTML = '<p>One sentence. Another sentence.</p>';
    const calls = []; let pass = 0;
    const translator = AT.dom.createTranslator({ doc: document, sentences: { split: AT.targets.sentences, maxChars: 900, always: true },
      translate: async (texts) => { calls.push(texts); return pass++ === 0 ? ['첫 문장.', ''] : ['첫 문장.', '다른 문장.']; } });
    await translator.translateRoot(root);
    const intermediate = { text: root.textContent, done: translator.has(root.querySelector('p').firstChild) };
    await translator.translateRoot(root);
    return { intermediate, text: root.textContent, calls };
  });
  assert.equal(result.intermediate.done, false);
  assert.equal(result.intermediate.text, '첫 문장. Another sentence.');
  assert.equal(result.text, '첫 문장. 다른 문장.');
  assert.deepEqual(result.calls[1], ['One sentence.', 'Another sentence.']);
});

check('repeated strings do not hide remaining DOM nodes from the continuation budget', async (page) => {
  const result = await page.evaluate(async () => {
    document.querySelector('#fixture').innerHTML = '<p>Repeated text</p>'.repeat(41);
    const pipeline = AT.pipeline.create({ doc: document, settings: () => ({ maxNodes: 40 }),
      translate: async ({ texts }) => texts.map(() => '반복 문장') });
    const first = await pipeline.translate();
    const last = await pipeline.refresh(null, 40);
    return { first, last, translated: [...document.querySelectorAll('#fixture p')].filter((p) => p.textContent === '반복 문장').length };
  });
  assert.equal(result.first.processedNodes, 40);
  assert.equal(result.first.hasMore, true);
  assert.equal(result.translated, 41);
});

check('detached nodes and exhausted cache entries are not retained indefinitely', async (page) => {
  const result = await page.evaluate(async () => {
    const root = document.querySelector('#fixture'); root.innerHTML = '<p>Temporary value</p>';
    const translator = AT.dom.createTranslator({ doc: document, translate: async (texts) => texts.map(() => '임시 값') });
    await translator.translateRoot(root);
    root.replaceChildren(); translator.restore(document.documentElement);
    return translator.stats();
  });
  assert.equal(result.translated, 0);
  assert.equal(result.cached, 0);
});

async function contentHarness(page) {
  await page.evaluate(() => {
    window.requests = []; window.reports = [];
    AT.sendMessage = async (message) => {
      if (message.type === AT.C.MSG.BATCH) return new Promise((resolve) => requests.push({ message, resolve }));
      reports.push(message); return { ok: true };
    };
    AT.onMessage = (handlers) => { window.handlers = handlers; };
    window.settings = { enabled: true, targetLang: 'ko', sourceLang: 'en', maxNodes: 600, showBadge: true, translationKey: 'test-ko' };
  });
  await scripts(page, ['content.js']);
}

check('real content observer starts before inference and restore acknowledges immediately', async (page) => {
  await page.locator('#fixture').evaluate((root) => { root.innerHTML = '<p>First paragraph</p>'; });
  await contentHarness(page);
  await page.evaluate(() => { window.task = handlers[AT.C.MSG.CONTENT_TRANSLATE]({ settings }); });
  await page.waitForFunction(() => requests.length === 1);
  await page.locator('#fixture').evaluate((root) => { root.insertAdjacentHTML('beforeend', '<p id="late">Inserted during inference</p>'); });
  await page.evaluate(() => { requests[0].resolve({ ok: true, translations: ['첫 문단'] }); });
  await page.waitForFunction(() => requests.some(({ message }) => message.texts.includes('Inserted during inference')));
  const before = Date.now();
  await page.evaluate(() => handlers[AT.C.MSG.CONTENT_RESTORE]());
  assert.ok(Date.now() - before < 1500, 'restore did not wait for the blocked inference');
  assert.equal(await page.locator('#fixture p').first().textContent(), 'First paragraph');
  await page.evaluate(async () => {
    requests.at(-1).resolve({ ok: true, translations: ['늦은 결과'] });
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  assert.equal(await page.locator('#late').textContent(), 'Inserted during inference');
});

check('new session results survive the preceding session arriving late', async (page) => {
  await page.locator('#fixture').evaluate((root) => { root.innerHTML = '<p>Original text</p>'; });
  await contentHarness(page);
  await page.evaluate(() => { window.first = handlers[AT.C.MSG.CONTENT_TRANSLATE]({ settings }); });
  await page.waitForFunction(() => requests.length === 1);
  await page.evaluate(async () => {
    await handlers[AT.C.MSG.CONTENT_RESTORE]();
    window.second = handlers[AT.C.MSG.CONTENT_TRANSLATE]({ settings: { ...settings, targetLang: 'ja', translationKey: 'test-ja' } });
  });
  await page.waitForFunction(() => requests.length === 2);
  await page.evaluate(async () => {
    requests[1].resolve({ ok: true, translations: ['新しい翻訳'] }); await second;
    requests[0].resolve({ ok: true, translations: ['오래된 번역'] }); await first;
  });
  assert.equal(await page.locator('#fixture p').textContent(), '新しい翻訳');
});

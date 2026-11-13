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
      await scripts(page, ['lib/constants.js', 'lib/pagecontext.js', 'lib/targets.js', 'lib/dom.js', 'lib/translationtext.js', 'lib/pipeline.js']);
      await fn(page);
      assert.deepEqual(errors, [], 'no uncaught browser errors');
    } catch (error) {
      await screenshot(page, `FAIL-dom-${name.replace(/[^a-z0-9]+/gi, '-')}`).catch(() => {});
      throw error;
    } finally { await page.close(); }
  });
}

// Real layout and real pipeline selection; only the provider reply is synthetic.
// Matching whole authored strings also works when the DOM layer packs segments.
async function readingOrder(page, html) {
  return page.evaluate(async (markup) => {
    const root = document.querySelector('#fixture');
    root.innerHTML = markup;
    const original = root.innerHTML;
    const units = [...root.querySelectorAll('[data-unit]')];
    const sources = units.map((element) => element.textContent);
    const replacements = sources.map((_text, index) => `번역 문단 ${index + 1}`);
    const boxes = units.map((element) => {
      const rect = element.getBoundingClientRect();
      return { id: element.dataset.unit, top: rect.top, left: rect.left };
    });
    const applied = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const element = (record.target.parentElement)?.closest('[data-unit]');
        if (element && /번역/.test(element.textContent) && !applied.includes(element.dataset.unit)) {
          applied.push(element.dataset.unit);
        }
      }
    });
    observer.observe(root, { subtree: true, characterData: true, childList: true });
    const requests = [];
    const pipeline = AT.pipeline.create({
      doc: document, settings: () => ({ maxNodes: 100 }),
      translate: async ({ texts, role }) => {
        requests.push({ texts, role });
        return texts.map((text) => sources.reduce((value, source, index) => value.replaceAll(source, replacements[index]), text));
      }
    });
    await pipeline.translate();
    await Promise.resolve();
    observer.disconnect();
    const translated = units.every((element, index) => element.textContent === replacements[index]);
    pipeline.restore();
    return { boxes, applied, requests, translated, restored: root.innerHTML === original };
  }, html);
}

check('CSS-reordered text follows rendered rows and inline direction rather than DOM order', async (page) => {
  for (const direction of ['ltr', 'rtl']) {
    const result = await readingOrder(page, `
      <article dir="${direction}" style="display:flex;flex-direction:column">
        <p data-unit="bottom" style="order:3">Bottom battery reserves</p>
        <div style="order:2;display:flex;justify-content:space-between">
          <p data-unit="inline-end" style="order:2">Second inline forecast</p>
          <p data-unit="inline-start" style="order:1">First inline demand</p>
        </div>
        <p data-unit="top" style="order:1">Top winter generation</p>
      </article>`);
    assert.deepEqual(result.applied, ['top', 'inline-start', 'inline-end', 'bottom'], direction);
    assert.ok(result.boxes.find((box) => box.id === 'top').top < result.boxes.find((box) => box.id === 'bottom').top);
    assert.equal(result.translated, true);
    assert.equal(result.restored, true);
  }
});

check('interleaved headings and paragraphs remain above lower comments and sidebar', async (page) => {
  const result = await readingOrder(page, `
    <div style="display:grid;grid-template-columns:720px 240px">
      <aside style="grid-column:2;grid-row:1"><h2 data-unit="sidebar">Suggested energy stories</h2></aside>
      <article style="grid-column:1;grid-row:1;display:flex;flex-direction:column">
        <section class="comments" style="order:5"><p data-unit="comment">Reader response below the story</p></section>
        <h2 data-unit="section" style="order:3">Wind capacity outlook</h2>
        <p data-unit="second" style="order:4">Operators prepare reserves</p>
        <p data-unit="first" style="order:2">Batteries store surplus power</p>
        <h1 data-unit="title" style="order:1">Winter grid storage</h1>
      </article>
    </div>`);
  assert.deepEqual(result.applied, ['title', 'first', 'section', 'second', 'comment', 'sidebar']);
  assert.equal(result.translated, true);
  assert.equal(result.restored, true);
});

check('YouTube watch custom elements put title and description before recommendation sidebar', async (page) => {
  const result = await readingOrder(page, `
    <ytd-watch-flexy style="display:grid;grid-template-columns:720px 240px">
      <div id="secondary" style="grid-column:2;grid-row:1">
        <ytd-watch-next-secondary-results-renderer style="display:block">
          <ytd-compact-video-renderer><h3 data-unit="recommendation">Recommended winter travel</h3></ytd-compact-video-renderer>
        </ytd-watch-next-secondary-results-renderer>
      </div>
      <div id="primary" style="grid-column:1;grid-row:1;display:flex;flex-direction:column">
        <ytd-comments style="order:3;display:block"><ytd-comment-thread-renderer><p data-unit="comment">A viewer asks about storage</p></ytd-comment-thread-renderer></ytd-comments>
        <ytd-watch-metadata style="order:1;display:block">
          <h1 data-unit="title">How winter power reaches homes</h1>
          <ytd-text-inline-expander id="description-inline-expander" style="display:block"><p data-unit="description">This video explains the changing grid</p></ytd-text-inline-expander>
        </ytd-watch-metadata>
      </div>
    </ytd-watch-flexy>`);
  assert.deepEqual(result.applied, ['title', 'description', 'comment', 'recommendation']);
  assert.equal(result.requests.find(({ texts }) => texts.some((text) => text.includes('Recommended winter travel')))?.role, 'aside');
  assert.equal(result.translated, true);
  assert.equal(result.restored, true);
});

check('aligned inline text preserves the link and restores exact authored nodes', async (page) => {
  const result = await page.evaluate(async () => {
    const root = document.querySelector('#fixture');
    root.innerHTML = '<p>Read <a href="/privacy" class="link">privacy policy</a> before you continue.</p>';
    const original = root.innerHTML;
    const link = root.querySelector('a');
    let clicked = 0;
    link.addEventListener('click', (event) => { event.preventDefault(); clicked++; });
    const dictionary = { Read: '읽으세요', 'privacy policy': '개인정보처리방침', 'before you continue.': '계속하기 전에.' };
    const translator = AT.dom.createTranslator({ doc: document,
      translate: async (texts) => texts.map((text) => dictionary[text]) });
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

check('indexed segments never move unrelated words into a link including unspaced CJK', async (page) => {
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
    const calls = []; let missing = true;
    const translator = AT.dom.createTranslator({ doc: document, sentences: { split: AT.targets.sentences, maxChars: 900, always: true },
      translate: async (texts) => {
        calls.push(texts);
        return texts.map((text) => text === 'One sentence.' ? '첫 문장.' : missing ? '' : '다른 문장.');
      } });
    await translator.translateRoot(root);
    const intermediate = { text: root.textContent, done: translator.has(root.querySelector('p').firstChild) };
    const retryAt = calls.length;
    missing = false;
    await translator.translateRoot(root);
    return { intermediate, text: root.textContent, retried: calls.slice(retryAt).flat() };
  });
  assert.equal(result.intermediate.done, false);
  assert.equal(result.intermediate.text, '첫 문장. Another sentence.');
  assert.equal(result.text, '첫 문장. 다른 문장.');
  assert.deepEqual(result.retried, ['One sentence.', 'Another sentence.']);
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
  await page.locator('#fixture').evaluate((root) => {
    root.innerHTML = '<p>Original text</p>';
    window.originalHTML = root.innerHTML;
    window.originalNode = root.firstChild.firstChild;
  });
  await contentHarness(page);
  await page.evaluate(() => { window.first = handlers[AT.C.MSG.CONTENT_TRANSLATE]({ settings }); });
  await page.waitForFunction(() => requests.length === 1);
  await page.evaluate(async () => {
    await handlers[AT.C.MSG.CONTENT_RESTORE]();
    window.second = handlers[AT.C.MSG.CONTENT_TRANSLATE]({ settings: { ...settings, targetLang: 'ja', translationKey: 'test-ja' } });
  });
  await page.waitForFunction(() => requests.length === 2);
  const current = await page.evaluate(async () => {
    const host = document.querySelector('#fixture at-translation-text');
    const pending = { state: host?.dataset.state, busy: host?.getAttribute('aria-busy'), sameText: host?.firstChild === originalNode };
    requests[1].resolve({ ok: true, translations: ['新しい翻訳'] }); await second;
    requests[0].resolve({ ok: true, translations: ['오래된 번역'] }); await first;
    return { pending, sameHost: document.querySelector('#fixture at-translation-text') === host,
      state: host?.dataset.state, busy: host?.getAttribute('aria-busy'),
      sameText: host?.firstChild === originalNode, text: document.querySelector('#fixture p').textContent,
      count: document.querySelectorAll('#fixture at-translation-text').length };
  });
  assert.deepEqual(current, {
    pending: { state: 'translating', busy: 'true', sameText: true },
    sameHost: true, state: 'translated', busy: null, sameText: true, text: '新しい翻訳', count: 1
  });
  await page.evaluate(() => handlers[AT.C.MSG.CONTENT_RESTORE]());
  assert.deepEqual(await page.evaluate(() => ({
    exact: document.querySelector('#fixture').innerHTML === originalHTML,
    sameText: document.querySelector('#fixture p').firstChild === originalNode,
    count: document.querySelectorAll('#fixture at-translation-text').length
  })), { exact: true, sameText: true, count: 0 });
});

check('invalid provider output never reaches DOM or the successful cache', async (page) => {
  const result = await page.evaluate(async () => {
    const root = document.querySelector('#fixture'); root.innerHTML = '<p>Hello.</p>';
    let calls = 0;
    const translator = AT.dom.createTranslator({ doc: document, translate: async () => ++calls === 1 ? ['<pad>'.repeat(946)] : ['안녕하세요.'] });
    let rejected = false;
    try { await translator.translateRoot(root); } catch { rejected = true; }
    const initial = { rejected, text: root.textContent, ...translator.stats() };
    await translator.translateRoot(root);
    const final = root.textContent;
    translator.restore(root);
    return { initial, final, restored: root.textContent, calls };
  });
  assert.equal(result.initial.rejected, true);
  assert.equal(result.initial.text, 'Hello.');
  assert.equal(result.initial.translated, 0);
  assert.equal(result.initial.cached, 0);
  assert.equal(result.final, '안녕하세요.');
  assert.equal(result.restored, 'Hello.');
  assert.equal(result.calls, 2);
});

check('revealed text is translated by the observer without toggling or reinjection', async (page) => {
  await page.locator('#fixture').evaluate(root => {
    root.innerHTML = '<p>Visible original</p><div id="later" style="display:none"><p>Hidden original</p></div><details><summary>More text</summary><p id="detail">Closed detail</p></details>';
  });
  await contentHarness(page);
  await page.evaluate(async () => {
    AT.sendMessage = async message => {
      if (message.type === AT.C.MSG.BATCH) {
        requests.push({ message });
        return { ok: true, translations: message.texts.map(s => '번역 ' + s) };
      }
      reports.push(message); return { ok: true };
    };
    await handlers[AT.C.MSG.CONTENT_TRANSLATE]({ settings });
  });
  assert.equal(await page.locator('#later p').textContent(), 'Hidden original');
  assert.equal(await page.locator('#detail').textContent(), 'Closed detail');
  await page.locator('#later').evaluate(e => { e.style.display = 'block'; });
  await page.locator('details').evaluate(e => { e.open = true; });
  await page.waitForFunction(() => document.querySelector('#later p').textContent.startsWith('번역 ') && document.querySelector('#detail').textContent.startsWith('번역 '));
  await page.evaluate(() => handlers[AT.C.MSG.CONTENT_RESTORE]());
  assert.equal(await page.locator('#later p').textContent(), 'Hidden original');
  assert.equal(await page.locator('#detail').textContent(), 'Closed detail');
});

check('long-lived virtualized DOM keeps bounded records and no extra provider work', async (page) => {
  const result = await page.evaluate(async () => {
    const root = document.querySelector('#fixture'); let calls = 0, peakRecords = 0;
    const translator = AT.dom.createTranslator({ doc: document, translate: async texts => { calls += texts.length; return texts.map(s => '번역 ' + s); } });
    for (let batch = 0; batch < 25; batch++) {
      root.innerHTML = Array.from({ length: 100 }, (_, i) => `<p>Virtual row ${batch * 100 + i}</p>`).join('');
      await translator.translateRoot(root, { limit: 100 });
      peakRecords = Math.max(peakRecords, translator.stats().translated);
    }
    const before = calls;
    await translator.translateRoot(root, { limit: 100 });
    const steady = translator.stats();
    root.replaceChildren(); translator.restore();
    return { peakRecords, steady, final: translator.stats(), extraCalls: calls - before, calls };
  });
  assert.equal(result.calls, 2500);
  assert.equal(result.extraCalls, 0);
  assert.ok(result.peakRecords <= 100);
  assert.ok(result.steady.cached <= 2048);
  assert.equal(result.final.translated, 0);
  assert.equal(result.final.cached, 0);
});

check('identical indexed inline units reuse the verified aligned cache', async (page) => {
  const result = await page.evaluate(async () => {
    const root = document.querySelector('#fixture');
    root.innerHTML = '<p>Read <a href="/guide">the guide</a> now.</p>'.repeat(2);
    const calls = [];
    const translator = AT.dom.createTranslator({ doc: document, translate: async texts => {
      calls.push(texts);
      const dictionary = { 'Read': '읽으세요', 'the guide': '안내서', 'now.': '지금.' };
      return texts.map(s => dictionary[s]);
    } });
    await translator.translateRoot(root);
    return { calls, links: [...root.querySelectorAll('a')].map(a => a.textContent) };
  });
  assert.deepEqual(result.calls, [['Read', 'the guide', 'now.']], 'one indexed batch; the second identical inline unit is cached');
  assert.deepEqual(result.links, ['안내서', '안내서']);
});

check('unrelated successful mutations cannot clear unresolved segment failures', async (page) => {
  const result = await page.evaluate(async () => {
    const root = document.querySelector('#fixture'); root.innerHTML = '<h1>Good title</h1><p id="bad">Broken text</p><section id="later"></section>';
    let rejectBad = true;
    const pipeline = AT.pipeline.create({ doc: document, settings: () => ({ maxNodes: 600 }), translate: async ({ texts }) => {
      if (rejectBad && texts.some(s => s.includes('Broken'))) throw new Error('recorded provider failure');
      return texts.map(s => '번역 ' + s);
    } });
    const first = await pipeline.translate();
    const later = root.querySelector('#later'); later.innerHTML = '<p>New valid content</p>';
    const second = await pipeline.refresh(later);
    rejectBad = false;
    const retry = await pipeline.refresh(root.querySelector('#bad'));
    return { first, second, retry };
  });
  assert.equal(result.first.failed, 1);
  assert.equal(result.second.failed, 1);
  assert.match(result.second.error, /recorded provider failure/);
  assert.equal(result.retry.failed, 0);
  assert.equal(result.retry.error, null);
});

check('invalid aligned pieces are rejected atomically before caching', async (page) => {
  const result = await page.evaluate(async () => {
    const root = document.querySelector('#fixture'); root.innerHTML = '<p>The &lt;pad&gt; token <a href="/guide">guide</a></p>';
    const original = root.innerHTML;
    const translator = AT.dom.createTranslator({ doc: document, translate: async () => ['토큰', '<pad> 안내서'] });
    let failed = false; try { await translator.translateRoot(root); } catch { failed = true; }
    return { failed, unchanged: original === root.innerHTML, ...translator.stats() };
  });
  assert.equal(result.failed, true);
  assert.equal(result.unchanged, true);
  assert.equal(result.cached, 0);
  assert.equal(result.translated, 0);
});

// Inspect the production component's rendered animation, without coupling the
// tests to shadow markup, keyframe names, colors, or animation durations.
async function auroraState(page, selector = '#fixture') {
  return page.locator(selector).evaluate((root) => [...root.querySelectorAll('at-translation-text')].map((host) => {
    const elements = [host, ...host.shadowRoot.querySelectorAll('*')];
    const animations = [...new Set(elements.flatMap((element) => element.getAnimations({ subtree: true })))];
    const range = document.createRange();
    range.selectNodeContents(host);
    return {
      text: host.textContent, state: host.dataset.state, busy: host.getAttribute('aria-busy'),
      slotted: host.shadowRoot.querySelector('slot')?.assignedNodes().includes(host.firstChild),
      readable: [...range.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0) &&
        getComputedStyle(host).visibility === 'visible' && getComputedStyle(host).opacity !== '0',
      activeAnimations: animations.filter((animation) => animation.playState === 'running').length
    };
  }));
}

check('aurora wraps only dispatched units and reveals replies in reading order', async (page) => {
  await page.evaluate(() => {
    const root = document.querySelector('#fixture');
    root.innerHTML = Array.from({ length: 48 }, (_, index) =>
      `<p>Original paragraph ${index + 1} describes how local battery storage supports the electricity grid through changing weather and seasonal demand.</p>`).join('');
    window.originalHTML = root.innerHTML;
    window.originalNodes = [...root.querySelectorAll('p')].map((p) => p.firstChild);
    window.requests = [];
    window.translator = AT.dom.createTranslator({
      doc: document, presentation: AT.translationtext.create(document), concurrency: () => 2,
      translate: (texts) => new Promise((resolve) => requests.push({ texts, resolve }))
    });
    window.finished = false;
    window.task = translator.translateRoot(root).then(() => { finished = true; });
  });
  await page.waitForFunction(() => requests.length === 2);
  const pending = await auroraState(page);
  const dispatched = await page.evaluate(() => requests.flatMap(({ texts }) => texts));
  assert.deepEqual(pending.map(({ text }) => text), dispatched);
  assert.ok(pending.length > 0 && pending.length < 48, 'queued paragraphs stay unwrapped');
  assert.ok(pending.every((host) => host.state === 'translating' && host.busy === 'true' && host.slotted && host.readable));
  assert.ok(pending.every((host) => host.activeAnimations > 0), 'real CSS animation runs while inference is pending');
  await screenshot(page, 'aurora-pending');
  await page.evaluate(async () => {
    requests[1].resolve(requests[1].texts.map((text) => '번역 ' + text));
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  assert.deepEqual((await auroraState(page)).map(({ text }) => text), dispatched, 'later answer waits for the earlier unit');
  await page.evaluate(() => { requests[0].resolve(requests[0].texts.map((text) => '번역 ' + text)); });
  await page.waitForFunction(() => originalNodes.slice(0, requests[0].texts.length + requests[1].texts.length).every((node) => node.data.startsWith('번역 ')));
  await page.evaluate(async () => {
    let replied = 2;
    while (!finished) {
      while (replied < requests.length) {
        const request = requests[replied++];
        request.resolve(request.texts.map((text) => '번역 ' + text));
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await task;
  });
  const completed = await auroraState(page);
  assert.equal(completed.length, 48);
  assert.ok(completed.every((host) => host.state === 'translated' && host.busy !== 'true' && host.text.startsWith('번역 ')));
  assert.deepEqual(completed.map(({ text }) => text), await page.evaluate(() => requests.flatMap(({ texts }) => texts.map((text) => '번역 ' + text))));
  await screenshot(page, 'aurora-translated');
  assert.deepEqual(await page.evaluate(() => {
    const root = document.querySelector('#fixture');
    const same = originalNodes.every((node, index) => root.querySelectorAll('p')[index].contains(node));
    translator.restore(root);
    return { same, exact: root.innerHTML === originalHTML, wrappers: root.querySelectorAll('at-translation-text').length,
      direct: originalNodes.every((node, index) => root.querySelectorAll('p')[index].firstChild === node) };
  }), { same: true, exact: true, wrappers: 0, direct: true });
});

check('aurora preserves inline geometry links and original Text identity', async (page) => {
  await page.evaluate(() => {
    const root = document.querySelector('#fixture');
    root.innerHTML = '<p style="width:330px;font:18px/1.5 system-ui">Read this detailed introduction to <a href="/privacy" class="policy" data-owner="page">our privacy policy and storage practices</a> before continuing with the rest of this multilingual article.</p>';
    window.originalHTML = root.innerHTML;
    window.link = root.querySelector('a');
    window.clicks = 0;
    link.addEventListener('click', (event) => { event.preventDefault(); clicks++; });
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    window.originalNodes = [];
    while (walker.nextNode()) originalNodes.push(walker.currentNode);
    window.geometry = () => originalNodes.map((node) => {
      const range = document.createRange(); range.selectNodeContents(node);
      return [...range.getClientRects()].map(({ x, y, width, height }) => ({ x, y, width, height }));
    });
    window.beforeGeometry = geometry();
    window.requests = [];
    window.translator = AT.dom.createTranslator({ doc: document, presentation: AT.translationtext.create(document),
      translate: (texts) => new Promise((resolve) => requests.push({ texts, resolve })) });
    window.task = translator.translateRoot(root);
  });
  await page.waitForFunction(() => requests.length === 1);
  const boxes = await page.evaluate(() => ({ before: beforeGeometry, pending: geometry() }));
  assert.ok(boxes.before.flat().length > 3, 'fixture actually wraps across lines');
  assert.deepEqual(boxes.pending.map((rects) => rects.length), boxes.before.map((rects) => rects.length));
  boxes.before.forEach((rects, index) => rects.forEach((rect, line) => {
    for (const key of ['x', 'y', 'width', 'height']) {
      assert.ok(Math.abs(rect[key] - boxes.pending[index][line][key]) <= 1, `pending layout preserves ${key}`);
    }
  }));
  assert.deepEqual(await page.evaluate(async () => {
    requests[0].resolve(requests[0].texts.map((_text, index) => ['자세한 소개를 읽으세요', '개인정보처리방침과 보관 관행', '다국어 기사를 계속하기 전에'][index]));
    await task; link.click();
    const root = document.querySelector('#fixture');
    const translated = { sameLink: root.querySelector('a') === link, href: link.getAttribute('href'),
      owner: link.dataset.owner, className: link.className, clicks,
      sameTexts: originalNodes.every((node) => root.contains(node)), linkText: link.textContent };
    translator.restore(root);
    return { ...translated, exact: root.innerHTML === originalHTML, restoredGeometry: JSON.stringify(geometry()) === JSON.stringify(beforeGeometry) };
  }), { sameLink: true, href: '/privacy', owner: 'page', className: 'policy', clicks: 1, sameTexts: true,
    linkText: '개인정보처리방침과 보관 관행', exact: true, restoredGeometry: true });
});

check('aurora pending cancellation restores exact HTML before a late answer', async (page) => {
  await page.evaluate(() => {
    const root = document.querySelector('#fixture'); root.innerHTML = '<p data-page="kept">Original pending source</p>';
    window.originalHTML = root.innerHTML; window.originalNode = root.querySelector('p').firstChild;
    window.pipeline = AT.pipeline.create({ doc: document, presentation: AT.translationtext.create(document),
      settings: () => ({ maxNodes: 100 }), translate: () => new Promise((resolve) => { window.reply = resolve; }) });
    window.task = pipeline.translate();
  });
  await page.waitForFunction(() => typeof reply === 'function');
  assert.equal((await auroraState(page))[0].busy, 'true');
  await page.evaluate(() => pipeline.restore());
  assert.deepEqual(await page.evaluate(() => ({ exact: document.querySelector('#fixture').innerHTML === originalHTML,
    same: document.querySelector('#fixture p').firstChild === originalNode,
    wrappers: document.querySelectorAll('at-translation-text').length })), { exact: true, same: true, wrappers: 0 });
  await page.evaluate(async () => { reply(['늦은 번역']); await task; });
  assert.equal(await page.locator('#fixture').innerHTML(), '<p data-page="kept">Original pending source</p>');
});

check('aurora never resurrects page-replaced text after pending inference', async (page) => {
  for (const replace of ['characterData', 'childList']) {
    const result = await page.evaluate(async (kind) => {
      const root = document.querySelector('#fixture'); root.innerHTML = '<p>Old page text</p>';
      const paragraph = root.firstChild;
      const originalNode = paragraph.firstChild;
      let reply;
      const translator = AT.dom.createTranslator({ doc: document, presentation: AT.translationtext.create(document),
        translate: () => new Promise((resolve) => { reply = resolve; }) });
      const task = translator.translateRoot(root);
      const pending = paragraph.querySelector('at-translation-text')?.dataset.state;
      if (kind === 'characterData') originalNode.data = 'New page text';
      else paragraph.replaceChildren(document.createTextNode('New page text'));
      reply(['오래된 번역']); await task;
      const eligible = translator.collect(root).some((node) => node.data === 'New page text');
      translator.restore(root);
      return { pending, eligible, html: root.innerHTML, wrappers: root.querySelectorAll('at-translation-text').length };
    }, replace);
    assert.deepEqual(result, { pending: 'translating', eligible: true, html: '<p>New page text</p>', wrappers: 0 }, replace);
  }
});

check('aurora partial sentence updates stay busy until settled and restore source', async (page) => {
  await page.evaluate(() => {
    const root = document.querySelector('#fixture'); root.innerHTML = '<p>One sentence. Another sentence.</p>';
    window.originalHTML = root.innerHTML; window.originalNode = root.firstChild.firstChild; window.requests = [];
    window.translator = AT.dom.createTranslator({ doc: document, presentation: AT.translationtext.create(document),
      sentences: { split: AT.targets.sentences, maxChars: 900, always: true },
      translate: (texts) => new Promise((resolve) => requests.push({ texts, resolve })) });
    window.task = translator.translateRoot(root);
  });
  await page.waitForFunction(() => requests.length === 1);
  await page.evaluate(() => requests[0].resolve(['첫 문장.']));
  await page.waitForFunction(() => requests.length === 2);
  const intermediate = (await auroraState(page))[0];
  assert.equal(intermediate.text, '첫 문장. Another sentence.');
  assert.equal(intermediate.state, 'translating');
  assert.equal(intermediate.busy, 'true');
  assert.ok(intermediate.activeAnimations > 0);
  await page.evaluate(async () => { requests[1].resolve(['']); await task; });
  const partial = (await auroraState(page))[0];
  assert.equal(partial.text, '첫 문장. Another sentence.');
  assert.equal(partial.state, 'partial');
  assert.notEqual(partial.busy, 'true');
  await page.waitForFunction(() => {
    const host = document.querySelector('at-translation-text');
    return [host, ...host.shadowRoot.querySelectorAll('*')].every((element) =>
      element.getAnimations({ subtree: true }).every((animation) => animation.playState !== 'running'));
  });
  assert.equal(await page.evaluate(() => {
    translator.restore(document.querySelector('#fixture'));
    return document.querySelector('#fixture').innerHTML === originalHTML && document.querySelector('#fixture p').firstChild === originalNode;
  }), true);
});

for (const media of [{ reducedMotion: 'reduce' }, { forcedColors: 'active' }]) {
  check(`aurora respects ${Object.keys(media)[0]} without hiding text`, async (page) => {
    await page.emulateMedia(media);
    await page.evaluate(() => {
      const root = document.querySelector('#fixture'); root.innerHTML = '<p>Accessible original text</p>';
      window.translator = AT.dom.createTranslator({ doc: document, presentation: AT.translationtext.create(document),
        translate: () => new Promise((resolve) => { window.reply = resolve; }) });
      window.task = translator.translateRoot(root);
    });
    await page.waitForFunction(() => typeof reply === 'function');
    const pending = (await auroraState(page))[0];
    assert.equal(pending.text, 'Accessible original text');
    assert.equal(pending.readable, true);
    assert.equal(pending.busy, 'true');
    assert.equal(pending.activeAnimations, 0);
    await page.evaluate(async () => { reply(['접근 가능한 번역']); await task; });
    const complete = (await auroraState(page))[0];
    assert.equal(complete.text, '접근 가능한 번역');
    assert.equal(complete.readable, true);
    assert.equal(complete.activeAnimations, 0);
    await page.evaluate(() => translator.restore());
    assert.equal(await page.locator('at-translation-text').count(), 0);
    assert.equal(await page.locator('#fixture').textContent(), 'Accessible original text');
  });
}

check('real content observer ignores exact aurora moves but observes external childList edits', async (page) => {
  await page.evaluate(() => {
    document.querySelector('#fixture').innerHTML = '<p>Observed original</p>';
    const create = AT.pipeline.create;
    window.mutationEvidence = { own: 0, external: 0 };
    AT.pipeline.create = (...args) => {
      const pipeline = create(...args);
      const ownsMutation = pipeline.ownsMutation;
      pipeline.ownsMutation = (record) => {
        const own = ownsMutation(record);
        if (own && record.type === 'childList') mutationEvidence.own++;
        if (record.type === 'childList' && [...record.addedNodes].some((node) => node.nodeType === 1 && node.id === 'external')) {
          mutationEvidence.external++;
          if (own) throw new Error('page insertion incorrectly classified as presentation-owned');
        }
        return own;
      };
      return pipeline;
    };
  });
  await contentHarness(page);
  await page.evaluate(() => { window.task = handlers[AT.C.MSG.CONTENT_TRANSLATE]({ settings }); });
  await page.waitForFunction(() => requests.length === 1 && mutationEvidence.own > 0);
  assert.equal((await auroraState(page))[0].busy, 'true');
  await page.locator('#fixture').evaluate((root) => {
    const paragraph = document.createElement('p'); paragraph.id = 'external'; paragraph.textContent = 'Externally inserted text'; root.append(paragraph);
  });
  await page.evaluate(() => requests[0].resolve({ ok: true, translations: ['관찰된 번역'] }));
  await page.waitForFunction(() => requests.some(({ message }) => message.texts.includes('Externally inserted text')));
  assert.ok((await page.evaluate(() => mutationEvidence.external)) > 0);
  await page.evaluate(async () => {
    requests.at(-1).resolve({ ok: true, translations: ['추가된 번역'] });
    await task;
  });
  await page.waitForFunction(() => document.querySelector('#external').textContent === '추가된 번역');
  await page.evaluate(() => handlers[AT.C.MSG.CONTENT_RESTORE]());
  assert.equal(await page.locator('at-translation-text').count(), 0);
  assert.equal(await page.locator('#fixture').innerHTML(), '<p>Observed original</p><p id="external">Externally inserted text</p>');
  assert.equal(await page.evaluate(() => requests.length), 2, 'own structural moves did not enqueue provider work');
});

check('aurora failed inference removes pending decoration without changing source', async (page) => {
  const result = await page.evaluate(async () => {
    const root = document.querySelector('#fixture'); root.innerHTML = '<p data-owner="page">Untranslated source</p>';
    const original = root.innerHTML; const node = root.firstChild.firstChild;
    let reject;
    const translator = AT.dom.createTranslator({ doc: document, presentation: AT.translationtext.create(document),
      translate: () => new Promise((_resolve, fail) => { reject = fail; }) });
    const task = translator.translateRoot(root);
    const pending = root.querySelector('at-translation-text')?.getAttribute('aria-busy');
    reject(new Error('provider unavailable'));
    await task.catch(() => {});
    return { pending, exact: root.innerHTML === original, same: root.firstChild.firstChild === node,
      wrappers: root.querySelectorAll('at-translation-text').length, eligible: translator.collect(root).includes(node) };
  });
  assert.deepEqual(result, { pending: 'true', exact: true, same: true, wrappers: 0, eligible: true });
});

check('aurora translated text has a progressing finite reveal animation', async (page) => {
  const result = await page.evaluate(async () => {
    const root = document.querySelector('#fixture'); root.innerHTML = '<p>Reveal this source smoothly</p>';
    const node = root.firstChild.firstChild;
    let reply;
    const translator = AT.dom.createTranslator({ doc: document, presentation: AT.translationtext.create(document),
      translate: () => new Promise((resolve) => { reply = resolve; }) });
    const task = translator.translateRoot(root);
    reply(['부드럽게 나타나는 번역']); await task;
    const host = root.querySelector('at-translation-text');
    const elements = [host, ...host.shadowRoot.querySelectorAll('*')];
    const reveal = elements.flatMap((element) => element.getAnimations({ subtree: true })).find((animation) =>
      animation instanceof CSSAnimation && animation.playState === 'running' &&
      animation.effect.getComputedTiming().activeDuration > 0 &&
      Number.isFinite(animation.effect.getComputedTiming().activeDuration));
    const before = reveal?.effect.getComputedTiming().progress;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const after = reveal?.effect.getComputedTiming().progress;
    const state = { state: host.dataset.state, text: host.textContent, same: host.contains(node),
      finiteReveal: Boolean(reveal), advancing: typeof before === 'number' && typeof after === 'number' && after > before };
    translator.restore(root);
    return state;
  });
  assert.deepEqual(result, { state: 'translated', text: '부드럽게 나타나는 번역', same: true, finiteReveal: true, advancing: true });
});

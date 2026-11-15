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
    return { boxes, applied, requests, translated, restored: root.innerHTML === original,
      unchanged: units.filter((element, index) => !applied.includes(element.dataset.unit)).map(element => element.dataset.unit) };
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

check('comment bodies and nested replies precede their authors dates and controls', async (page) => {
  const result = await readingOrder(page, `
    <ytd-comments style="display:block">
      <ytd-comment-thread-renderer style="display:block">
        <ytd-comment-view-model style="display:block">
          <a id="author-text" data-unit="author">Reader Alice</a>
          <span id="published-time-text" data-unit="date">Three weeks ago</span>
          <yt-attributed-string id="content-text" style="display:block" data-unit="body">An interesting explanation of the power grid</yt-attributed-string>
          <button><span data-unit="control">Show replies</span></button>
        </ytd-comment-view-model>
        <ytd-comment-replies-renderer style="display:block">
          <ytd-comment-thread-renderer><ytd-comment-view-model style="display:block">
            <a id="author-text" data-unit="reply-author">Reader Bob</a>
            <yt-attributed-string id="content-text" style="display:block" data-unit="reply">Thank you for explaining the battery system</yt-attributed-string>
          </ytd-comment-view-model></ytd-comment-thread-renderer>
        </ytd-comment-replies-renderer>
      </ytd-comment-thread-renderer>
    </ytd-comments>`);
  assert.deepEqual(result.applied.slice(0, 2), ['body', 'reply']);
  assert.ok(!result.requests.some(({ texts }) => texts.includes('Reader Alice') || texts.includes('Reader Bob')));
  assert.equal(result.requests.find(({ texts }) => texts.includes('Show replies'))?.role, 'form');
  assert.deepEqual(result.unchanged, ['author', 'reply-author'], 'semantic author identifiers stay source text');
  assert.equal(result.restored, true);
});

check('generic news forum and div cards share primary-before-sidebar visual ordering', async (page) => {
  await page.locator('#fixture').evaluate(root => { root.outerHTML = '<div id="fixture"></div>'; });
  for (const structure of [
    { open: '<article>', close: '</article>' },
    { open: '<div role="main">', close: '</div>' },
    { open: '<div class="forum replies">', close: '</div>' },
    { open: '<div class="card-grid">', close: '</div>' }
  ]) {
    const result = await readingOrder(page, `
      <div style="display:grid;grid-template-columns:720px 240px">
        <div class="sidebar" style="grid-column:2;grid-row:1"><h2 data-unit="sidebar">Related reading list</h2></div>
        <div style="grid-column:1;grid-row:1">
          ${structure.open}
            <div style="display:flex;flex-direction:column">
              <div data-unit="lower" style="order:3">Lower story card text</div>
              <h1 data-unit="headline" style="order:1">Daily energy report</h1>
              <div data-unit="upper" style="order:2">First story card text</div>
            </div>
          ${structure.close}
        </div>
      </div>`);
    assert.deepEqual(result.applied, ['headline', 'upper', 'lower', 'sidebar'], structure.open);
    assert.equal(result.translated, true);
    assert.equal(result.restored, true);
  }
});

check('substantial generic columns preserve reading flow in LTR and RTL layouts', async (page) => {
  for (const direction of ['ltr', 'rtl']) {
    const result = await readingOrder(page, `
      <div dir="${direction}" style="display:grid;grid-template-columns:400px 400px">
        <div style="grid-column:2;grid-row:1">
          <p data-unit="end-top" style="height:80px">Second column opening</p>
          <p data-unit="end-bottom" style="height:80px">Second column conclusion</p>
        </div>
        <div style="grid-column:1;grid-row:1">
          <p data-unit="start-top" style="height:80px">First column opening</p>
          <p data-unit="start-bottom" style="height:80px">First column conclusion</p>
        </div>
      </div>`);
    assert.deepEqual(result.applied, ['start-top', 'start-bottom', 'end-top', 'end-bottom'], direction);
    assert.equal(result.translated, true);
    assert.equal(result.restored, true);
  }
});

check('CSS multicolumn prose follows authored flow in both inline directions', async (page) => {
  for (const direction of ['ltr', 'rtl']) {
    const result = await readingOrder(page, `
      <article dir="${direction}" style="columns:2;column-fill:auto;height:240px;width:800px">
        <p data-unit="first" style="height:120px;margin:0">First source passage</p>
        <p data-unit="second" style="height:120px;margin:0">Second source passage</p>
        <p data-unit="third" style="height:120px;margin:0">Third source passage</p>
        <p data-unit="fourth" style="height:120px;margin:0">Fourth source passage</p>
      </article>`);
    assert.deepEqual(result.applied, ['first', 'second', 'third', 'fourth'], direction);
    assert.equal(result.translated, true);
    assert.equal(result.restored, true);
  }
});

check('visible supporting text is read before next-screen article prefetch', async (page) => {
  const result = await readingOrder(page, `
    <aside><p data-unit="support">Visible supporting explanation</p></aside>
    <article style="margin-top:850px"><p data-unit="body">Next screen article continuation</p></article>`);
  assert.deepEqual(result.applied, ['support', 'body']);
  assert.equal(result.translated, true);
  assert.equal(result.restored, true);
});

check('nested overflow clips viewport admission and scrolling wakes parked generic sources', async (page) => {
  const result = await page.evaluate(async () => {
    const root = document.querySelector('#fixture');
    root.innerHTML = `<div id="pane" style="height:100px;overflow:auto">
      <div id="first" style="height:300px">First visible card</div>
      <div id="second" style="height:300px">Second parked card</div>
      <div id="third" style="height:300px">Third parked card</div>
    </div>`;
    const pane = root.querySelector('#pane');
    const nodes = ['first', 'second', 'third'].map(id => root.querySelector(`#${id}`).firstChild);
    const sources = nodes.map(node => node.nodeValue);
    const asked = [];
    const pipeline = AT.pipeline.create({
      doc: document, readingWindow: true, settings: () => ({ maxNodes: 100 }),
      translate: async ({ texts }) => {
        asked.push(...texts);
        return texts.map(text => `번역 ${text}`);
      }
    });
    let pass = await pipeline.translate();
    for (let turn = 0; pass.hasMore && turn < 10; turn++) pass = await pipeline.resume();
    const initial = { asked: [...asked], hasMore: pass.hasMore, values: nodes.map(node => node.nodeValue) };
    pane.scrollTop = 300;
    const rank = pipeline.reprioritize();
    pass = await pipeline.resume();
    const moved = { asked: [...asked], hasMore: pass.hasMore, values: nodes.map(node => node.nodeValue) };
    pipeline.restore();
    return { initial, moved, rank, restored: nodes.every((node, index) => node.nodeValue === sources[index]),
      identity: nodes.every((node, index) => root.querySelector(`#${['first', 'second', 'third'][index]}`).firstChild === node) };
  });
  assert.deepEqual(result.initial.asked, ['First visible card']);
  assert.equal(result.initial.hasMore, false);
  assert.deepEqual(result.initial.values, ['번역 First visible card', 'Second parked card', 'Third parked card']);
  assert.deepEqual(result.rank, { visible: 1, queued: 2 });
  assert.deepEqual(result.moved.asked, ['First visible card', 'Second parked card']);
  assert.equal(result.moved.hasMore, false);
  assert.equal(result.moved.values[0], '번역 First visible card');
  assert.equal(result.moved.values[2], 'Third parked card');
  assert.equal(result.restored, true);
  assert.equal(result.identity, true);
});

check('generic semantic names and identifiers stay untouched while short prose and dynamic copies translate', async (page) => {
  const result = await page.evaluate(async () => {
    const root = document.querySelector('#fixture');
    root.innerHTML = `<div><a rel="author">Alice Reader</a><span class="profile-name">Bob Reader</span>
      <div itemscope itemtype="https://schema.org/Person"><span itemprop="name">Carol Reader</span></div>
      <div class="ltx_creator ltx_role_author"><span class="ltx_personname">Ashish Vaswani</span>
        <p class="ltx_author_notes">Contribution details</p></div>
      <span class="card__author-name">Dana Reader</span><span id="profile_userName">Evan Reader</span>
      <p>123,456%</p><p>★ → +</p><p>@reader</p><p>https://example.com/path</p>
      <p>Go</p><p>Thank You</p><p>The Sun Also Rises</p></div>`;
    const original = root.innerHTML, asked = [];
    const translator = AT.dom.createTranslator({ doc: document, translate: async texts => {
      asked.push(...texts); return texts.map(text => `번역 ${text}`);
    } });
    await translator.translateRoot(root);
    const before = asked.length;
    const duplicate = document.createElement('p');
    duplicate.textContent = 'Thank You';
    root.append(duplicate);
    await translator.translateRoot(root);
    const translated = translator.stats().translated;
    const reused = asked.length === before && duplicate.textContent === '번역 Thank You';
    translator.restore(root);
    duplicate.remove();
    return { asked, translated, reused, restored: root.innerHTML === original };
  });
  assert.deepEqual(result.asked, ['Contribution details', 'Go', 'Thank You', 'The Sun Also Rises']);
  assert.equal(result.translated, 5);
  assert.equal(result.reused, true);
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

check('owner-bounded sources never move unrelated words into a link including unspaced CJK', async (page) => {
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

check('partial paragraph failures retain committed text and retry only the missing suffix', async (page) => {
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
  assert.deepEqual(result.retried, ['Another sentence.']);
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

check('trusted expansion gets a bounded turn without promoting unrelated mutations', async (page) => {
  await page.locator('#fixture').evaluate(root => {
    root.innerHTML = `
      <p id="active">Current reading paragraph</p><p id="reading">Remaining main paragraph</p>
      <aside style="position:absolute;top:160px;left:650px;width:350px">
        <details><summary>Expand explanation</summary><p id="expanded">Selected explanation</p></details>
        <p id="counter">Unrelated sidebar counter</p>
      </aside>`;
  });
  await contentHarness(page);
  await page.evaluate(() => { settings.translationConcurrency = 1; window.task = handlers[AT.C.MSG.CONTENT_TRANSLATE]({ settings }); });
  await page.waitForFunction(() => requests.length === 1);
  await page.locator('summary').click();
  await page.locator('#counter').evaluate(element => { element.textContent = 'New unrelated counter'; });
  await page.evaluate(() => requests[0].resolve({ ok: true, translations: ['현재 읽는 문단'] }));
  for (let index = 1; index <= 2; index++) {
    await page.waitForFunction(count => requests.length > count, index);
    await page.evaluate(i => requests[i].resolve({
      ok: true, translations: requests[i].message.texts.map(text => '번역 ' + text)
    }), index);
  }
  await page.waitForFunction(() => requests.length >= 4);
  const order = await page.evaluate(() => requests.slice(0, 4).flatMap(request => request.message.texts));
  assert.deepEqual(order, ['Current reading paragraph', 'Expand explanation', 'Selected explanation', 'Remaining main paragraph']);
  await page.evaluate(() => handlers[AT.C.MSG.CONTENT_RESTORE]());
  assert.equal(await page.locator('#active').textContent(), 'Current reading paragraph');
  assert.equal(await page.locator('#expanded').textContent(), 'Selected explanation');
});

check('scrolling retains the active aurora and source until its quantum commits', async (page) => {
  await page.locator('#fixture').evaluate(root => {
    root.innerHTML = '<p id="active">Current visible source</p><div style="height:1600px"></div><p id="next">Newly visible source</p>';
  });
  await contentHarness(page);
  await page.evaluate(() => { settings.translationConcurrency = 1; window.task = handlers[AT.C.MSG.CONTENT_TRANSLATE]({ settings }); });
  await page.waitForFunction(() => requests.length === 1 && document.querySelector('#active at-translation-text'));
  const before = await page.locator('#active').innerHTML();
  await page.locator('#next').scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('#active').innerHTML(), before, 'scrolling does not remove pending presentation');
  assert.equal(await page.evaluate(() => requests.length), 1, 'one inference quantum remains active');
  await page.evaluate(() => requests[0].resolve({ ok: true, translations: ['완료된 원문'] }));
  await page.waitForFunction(() => requests.length === 2);
  assert.deepEqual(await page.evaluate(() => requests[1].message.texts), ['Newly visible source']);
  await page.evaluate(() => requests[1].resolve({ ok: true, translations: ['새로 보이는 원문'] }));
  await page.waitForFunction(() => document.querySelector('#next').textContent === '새로 보이는 원문');
  await page.evaluate(() => handlers[AT.C.MSG.CONTENT_RESTORE]());
  assert.equal(await page.locator('#active').textContent(), 'Current visible source');
  assert.equal(await page.locator('#next').textContent(), 'Newly visible source');
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

check('identical owner-bounded inline units reuse their translation cache', async (page) => {
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
  assert.deepEqual(result.calls.flat(), ['Read', 'the guide', 'now.'], 'each owned source is generated once');
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
    const retry = await pipeline.translate();
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
      activeAnimations: animations.filter((animation) => animation.playState === 'running').length,
      highlighted: elements.some((element) => {
        const style = getComputedStyle(element);
        return style.backgroundImage !== 'none' || style.boxShadow !== 'none';
      })
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
  assert.ok(pending.every((host) => host.highlighted), 'pending progress has a visible highlight');
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
    let finished = false;
    void task.then(() => { finished = true; });
    const translations = {
      'Read this detailed introduction to': '자세한 소개를 읽으세요',
      'our privacy policy and storage practices': '개인정보처리방침과 보관 관행',
      'before continuing with the rest of this multilingual article.': '다국어 기사를 계속하기 전에'
    };
    let answered = 0;
    for (let turn = 0; !finished && turn < 50; turn++) {
      while (answered < requests.length) {
        const request = requests[answered++];
        request.resolve(request.texts.map(text => translations[text]));
      }
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    if (!finished) throw new Error('owner-bounded requests did not settle');
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
  assert.equal((await auroraState(page))[0].highlighted, false, 'a settled failure clears the painted highlight immediately');
  await page.waitForFunction(() => document.querySelector('at-translation-text').dataset.state === 'partial');
  const partial = (await auroraState(page))[0];
  assert.equal(partial.text, '첫 문장. Another sentence.');
  assert.equal(partial.state, 'partial');
  assert.notEqual(partial.busy, 'true');
  assert.equal(partial.highlighted, false, 'a paused animation must not leave a frozen gradient or shadow');
  await screenshot(page, 'aurora-partial-stopped');
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
    const changed = host.shadowRoot.querySelector('.preview > span');
    const reveal = changed?.getAnimations().find((animation) =>
      animation instanceof CSSAnimation && animation.playState === 'running' &&
      animation.effect.getComputedTiming().activeDuration > 0 &&
      Number.isFinite(animation.effect.getComputedTiming().activeDuration));
    // CSS animations can be pending immediately after the commit microtask.
    // Sample the changed region only once its animation timeline has started.
    await reveal?.ready;
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

check('parked partial text has no highlight and resumes the same aurora and original suffix', async (page) => {
  await page.exposeFunction('captureStopped', () => screenshot(page, 'aurora-partial-stopped'));
  const result = await page.evaluate(async () => {
    const root = document.querySelector('#fixture');
    root.innerHTML = '<p>First source phrase. Second source phrase.</p>';
    const original = root.innerHTML, node = root.firstChild.firstChild;
    let park = false;
    const requests = [];
    const translator = AT.dom.createTranslator({
      doc: document, presentation: AT.translationtext.create(document),
      sentences: { split: AT.targets.sentences, maxChars: 900, always: true },
      shouldYield: () => park,
      translate: (texts) => new Promise(resolve => requests.push({ texts, resolve }))
    });
    const task = translator.translateRoot(root);
    while (requests.length < 1) await new Promise(resolve => setTimeout(resolve, 0));
    const host = node.parentElement, surface = host.shadowRoot.querySelector('.surface');
    const aurora = surface.getAnimations()[0];
    await aurora.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    park = true;
    requests[0].resolve(['첫 문장.']);
    const first = await task;
    const bridged = host.dataset.state === 'translating' && getComputedStyle(surface).backgroundImage !== 'none';
    await new Promise(resolve => setTimeout(resolve, 220));
    const paused = { state: host.dataset.state, busy: host.hasAttribute('aria-busy'),
      background: getComputedStyle(surface).backgroundImage, shadow: getComputedStyle(surface).boxShadow,
      text: node.data, sameAnimation: surface.getAnimations()[0] === aurora, playState: aurora.playState };
    await window.captureStopped();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const phase = aurora.currentTime;
    await new Promise(resolve => setTimeout(resolve, 220));
    const frozen = aurora.currentTime === phase;
    park = false;
    const resumed = translator.translateNodes(first.pending);
    while (requests.length < 2) await new Promise(resolve => setTimeout(resolve, 0));
    const active = { state: host.dataset.state, busy: host.getAttribute('aria-busy'),
      highlighted: getComputedStyle(surface).backgroundImage !== 'none',
      sameHost: node.parentElement === host, sameAnimation: surface.getAnimations()[0] === aurora,
      source: requests[1].texts };
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const advancing = aurora.currentTime > phase;
    requests[1].resolve(['둘째 문장.']); await resumed;
    const completed = node.data;
    translator.restore(root);
    return { bridged, paused, frozen, active, advancing, completed,
      restored: root.innerHTML === original && root.firstChild.firstChild === node };
  });
  assert.equal(result.bridged, true, 'ordinary quantum handoff retains the bounded no-blink grace');
  assert.deepEqual(result.paused, { state: 'partial', busy: false, background: 'none', shadow: 'none',
    text: '첫 문장. Second source phrase.', sameAnimation: true, playState: 'paused' });
  assert.equal(result.frozen, true);
  assert.deepEqual(result.active, { state: 'translating', busy: 'true', highlighted: true,
    sameHost: true, sameAnimation: true, source: ['Second source phrase.'] });
  assert.equal(result.advancing, true);
  assert.equal(result.completed, '첫 문장. 둘째 문장.');
  assert.equal(result.restored, true);
});

for (const partial of [false, true]) {
  check(`observed abort clears pending preview and highlight with partial=${partial}`, async (page) => {
    const result = await page.evaluate(async (partial) => {
      const root = document.querySelector('#fixture');
      root.innerHTML = '<p>First source phrase. Second source phrase.</p>';
      const original = root.innerHTML, node = root.firstChild.firstChild;
      const requests = [];
      let abort = false;
      const translator = AT.dom.createTranslator({
        doc: document, presentation: AT.translationtext.create(document), shouldAbort: () => abort,
        sentences: { split: AT.targets.sentences, maxChars: 900, always: true },
        translate: (texts, progress) => new Promise(resolve => requests.push({ texts, progress, resolve }))
      });
      const task = translator.translateRoot(root);
      window.abortCase = { root, original, node, requests, translator, setAbort: value => { abort = value; } };
      while (requests.length < 1) await new Promise(resolve => setTimeout(resolve, 0));
      if (partial) {
        requests[0].resolve(['첫 문장.']);
        while (requests.length < 2) await new Promise(resolve => setTimeout(resolve, 0));
      }
      const current = requests.at(-1);
      current.progress(0, '아직 확정되지 않은 번역');
      abort = true;
      current.progress(0, '늦은 미리보기');
      const host = root.querySelector('at-translation-text');
      const surface = host?.shadowRoot.querySelector('.surface');
      const stopped = { text: node.data, state: host?.dataset.state ?? null,
        busy: host?.hasAttribute('aria-busy') ?? false,
        background: surface ? getComputedStyle(surface).backgroundImage : 'none',
        shadow: surface ? getComputedStyle(surface).boxShadow : 'none',
        streaming: host?.hasAttribute('data-streaming') ?? false };
      abort = false; // Observed cancellation stays final even if a caller re-enables translation.
      await new Promise(resolve => setTimeout(resolve, 220));
      current.progress(0, '또 다른 늦은 미리보기');
      current.resolve(['늦은 최종 결과']); await task;
      const unchanged = node.data === stopped.text && !root.querySelector('[data-streaming]');
      return { stopped, unchanged };
    }, partial);
    if (partial) await screenshot(page, 'aurora-partial-cancelled');
    Object.assign(result, await page.evaluate(async () => {
      const { root, original, node, requests, translator, setAbort } = abortCase;
      setAbort(false);
      const before = requests.length;
      const retry = translator.translateRoot(root);
      while (requests.length === before) await new Promise(resolve => setTimeout(resolve, 0));
      const retrySource = requests.at(-1).texts;
      translator.restore(root);
      requests.at(-1).resolve(['복원 이후 늦은 결과']); await retry;
      await new Promise(resolve => setTimeout(resolve, 220));
      return { retrySource, restored: root.innerHTML === original && root.firstChild.firstChild === node };
    }));
    assert.deepEqual(result.stopped, { text: partial ? '첫 문장. Second source phrase.' : 'First source phrase. Second source phrase.',
      state: partial ? 'partial' : null, busy: false, background: 'none', shadow: 'none', streaming: false });
    assert.equal(result.unchanged, true);
    assert.deepEqual(result.retrySource, [partial ? 'Second source phrase.' : 'First source phrase.']);
    assert.equal(result.restored, true);
  });
}

check('late completion after restore cannot settle a restarted presentation of the same Text', async (page) => {
  const result = await page.evaluate(async () => {
    const root = document.querySelector('#fixture'); root.innerHTML = '<p>Original source</p>';
    const original = root.innerHTML, node = root.firstChild.firstChild, requests = [];
    const translator = AT.dom.createTranslator({ doc: document, presentation: AT.translationtext.create(document),
      translate: (texts, progress) => new Promise(resolve => requests.push({ texts, progress, resolve })) });
    const old = translator.translateRoot(root);
    requests[0].progress(0, '복원 전 미리보기');
    translator.restore(root);
    const next = translator.translateRoot(root), host = node.parentElement;
    requests[0].progress(0, '복원 후 늦은 미리보기');
    requests[0].resolve(['복원 후 늦은 결과']); await old;
    await new Promise(resolve => setTimeout(resolve, 220));
    const active = { same: node.parentElement === host, state: host.dataset.state, busy: host.getAttribute('aria-busy'),
      highlighted: getComputedStyle(host.shadowRoot.querySelector('.surface')).backgroundImage !== 'none',
      text: node.data, streaming: host.hasAttribute('data-streaming') };
    requests[1].resolve(['새 번역']); await next;
    const completed = node.data;
    translator.restore(root);
    return { active, completed, restored: root.innerHTML === original && root.firstChild.firstChild === node };
  });
  assert.deepEqual(result.active, { same: true, state: 'translating', busy: 'true',
    highlighted: true, text: 'Original source', streaming: false });
  assert.equal(result.completed, '새 번역');
  assert.equal(result.restored, true);
});

check('scoped restore immediately parks active partial text outside its subtree', async (page) => {
  const result = await page.evaluate(async () => {
    const root = document.querySelector('#fixture');
    root.innerHTML = '<p id="scope">Untouched source</p><p id="active">First source phrase. Second source phrase.</p>';
    const original = root.innerHTML, node = root.querySelector('#active').firstChild, requests = [];
    const translator = AT.dom.createTranslator({ doc: document, presentation: AT.translationtext.create(document),
      sentences: { split: AT.targets.sentences, maxChars: 900, always: true },
      translate: (texts) => new Promise(resolve => requests.push({ texts, resolve })) });
    const task = translator.translateNodes([node]);
    while (requests.length < 1) await new Promise(resolve => setTimeout(resolve, 0));
    requests[0].resolve(['첫 문장.']);
    while (requests.length < 2) await new Promise(resolve => setTimeout(resolve, 0));
    translator.restore(root.querySelector('#scope'));
    const host = node.parentElement, surface = host.shadowRoot.querySelector('.surface');
    const parked = { state: host.dataset.state, busy: host.hasAttribute('aria-busy'),
      background: getComputedStyle(surface).backgroundImage, shadow: getComputedStyle(surface).boxShadow,
      text: node.data };
    requests[1].resolve(['늦은 결과']); await task;
    const unchanged = node.data === parked.text;
    translator.restore(root);
    return { parked, unchanged, restored: root.innerHTML === original };
  });
  assert.deepEqual(result.parked, { state: 'partial', busy: false, background: 'none', shadow: 'none',
    text: '첫 문장. Second source phrase.' });
  assert.equal(result.unchanged, true);
  assert.equal(result.restored, true);
});

check('whole-document continuations finish offscreen source while hidden clipped and protected source stays untouched', async (page) => {
  const result = await page.evaluate(async () => {
    const root = document.querySelector('#fixture');
    root.innerHTML = `
      <p data-source style="position:absolute;top:-2000px">Earlier document paragraph</p>
      <p data-source>Visible document paragraph</p>
      <p data-source style="margin-top:3000px">Later document paragraph</p>
      <footer data-source>Document footer information</footer>
      <p data-protected style="display:none">Hidden source paragraph</p>
      <div style="height:20px;overflow:hidden"><p data-protected style="margin-top:100px">Clipped source paragraph</p></div>
      <p data-protected contenteditable="true">Editable source paragraph</p>
      <p data-protected translate="no">Protected source paragraph</p>`;
    const original = root.innerHTML;
    const eligible = [...root.querySelectorAll('[data-source]')];
    const sources = eligible.map(element => element.textContent);
    const protectedNodes = [...root.querySelectorAll('[data-protected]')];
    const protectedSources = protectedNodes.map(element => element.textContent);
    const asked = [];
    const pipeline = AT.pipeline.create({
      doc: document, settings: () => ({ maxNodes: 1, translationConcurrency: 4 }),
      translate: async ({ texts }) => { asked.push(...texts); return texts.map(text => text.toUpperCase()); }
    });
    let pass = await pipeline.translate(), passes = 1;
    while (pass.hasMore && passes < 20) { pass = await pipeline.resume(); passes++; }
    const translated = eligible.every((element, index) => element.textContent === sources[index].toUpperCase());
    const protectedUnchanged = protectedNodes.every((element, index) => element.textContent === protectedSources[index]);
    const restored = pipeline.restore().restored;
    return { translated, protectedUnchanged, asked, sources, passes, hasMore: pass.hasMore, restored,
      exactRestore: root.innerHTML === original, scrollY };
  });
  assert.equal(result.translated, true);
  assert.equal(result.protectedUnchanged, true);
  assert.equal(result.asked[0], 'Visible document paragraph');
  assert.deepEqual(new Set(result.asked), new Set(result.sources));
  assert.equal(result.passes, result.sources.length);
  assert.equal(result.hasMore, false);
  assert.equal(result.scrollY, 0);
  assert.equal(result.restored, result.sources.length);
  assert.equal(result.exactRestore, true);
});

check('production page scheduling keeps ruby and formatted link labels whole without model markers', async (page) => {
  for (const mode of ['aurora', 'immediate']) {
    const result = await page.evaluate(async (mode) => {
      const root = document.querySelector('#fixture');
      root.innerHTML = '<p><ruby>年<rp>（</rp><rt>ねん</rt><rp>）</rp></ruby>金を<strong>受け取り</strong>ます。</p>' +
        '<p><a href="/guide">詳しい<span>説明</span>を読む</a></p>' +
        '<p>QuQu</p><p>年</p><code>保持するコード</code><p class="notranslate">翻訳しない</p><p contenteditable="true">入力欄です</p>';
      const original = root.innerHTML;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      const sources = nodes.map(node => node.data);
      const link = root.querySelector('a');
      let clicked = 0;
      link.addEventListener('click', event => { event.preventDefault(); clicked++; });
      const requests = [];
      const dictionary = { '年金を受け取ります。': '연금을 받습니다.', '詳しい説明を読む': '자세한 설명을 읽기', QuQu: 'QuQu' };
      const pipeline = AT.pipeline.create({
        doc: document, settings: () => ({ maxNodes: 100, translationConcurrency: 8 }),
        workLimit: () => ({ maxChars: 0, maxTexts: 1 }),
        presentation: AT.translationtext.create(document, mode),
        translate: async ({ texts }) => { requests.push(...texts); return texts.map(text => dictionary[text] ?? ''); }
      });
      const pass = await pipeline.translate();
      link.click();
      const state = { requests, failed: pass.failed, error: pass.error,
        paragraph: root.querySelector('p').textContent, ruby: root.querySelector('ruby').textContent,
        link: link.textContent, href: link.getAttribute('href'), sameLink: root.querySelector('a') === link, clicked,
        protected: [...root.querySelectorAll('code, .notranslate, [contenteditable]')].map(element => element.textContent),
        noRubyWrappers: !root.querySelector('ruby at-translation-text'),
        identities: nodes.every(node => root.contains(node)) };
      pipeline.restore();
      return { ...state, restored: root.innerHTML === original && nodes.every((node, index) => node.data === sources[index]) };
    }, mode);
    assert.deepEqual(new Set(result.requests), new Set(['年金を受け取ります。', '詳しい説明を読む', 'QuQu']));
    assert.equal(result.requests.length, 3);
    assert.equal(result.failed, 0);
    assert.equal(result.error, null);
    assert.equal(result.paragraph, '연금을 받습니다.');
    assert.equal(result.ruby, '');
    assert.equal(result.link, '자세한 설명을 읽기');
    assert.equal(result.href, '/guide');
    assert.equal(result.sameLink, true);
    assert.equal(result.clicked, 1);
    assert.equal(result.noRubyWrappers, true);
    assert.deepEqual(result.protected, ['保持するコード', '翻訳しない', '入力欄です']);
    assert.equal(result.identities, true);
    assert.equal(result.restored, true);
  }
});

check('a changed inline member invalidates the entire pending semantic answer', async (page) => {
  const result = await page.evaluate(async () => {
    const root = document.querySelector('#fixture');
    root.innerHTML = '<p>元の<span>文章</span>です。</p>';
    const paragraph = root.firstChild, changed = root.querySelector('span').firstChild;
    let release;
    const requests = [];
    const translator = AT.dom.createTranslator({ doc: document,
      translate: texts => { requests.push(...texts); return new Promise(resolve => { release = resolve; }); } });
    const pending = translator.translateRoot(root);
    for (let turn = 0; !release && turn < 20; turn++) await Promise.resolve();
    if (!release) throw new Error('semantic request was not dispatched');
    changed.data = '編集された文章';
    release(['오래된 번역']);
    await pending;
    const after = paragraph.textContent;
    translator.restore();
    return { requests, after, restored: paragraph.textContent, same: root.querySelector('span').firstChild === changed };
  });
  assert.deepEqual(result.requests, ['元の文章です。']);
  assert.equal(result.after, '元の編集された文章です。');
  assert.equal(result.restored, result.after);
  assert.equal(result.same, true);
});

// Real-page behavior with the installed extension. Only fixture DOM is changed;
// inference, extension globals, extension messages and network are not replaced.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

function fixtureApp() {
  const sources = new Map(), events = [];
  const app = document.querySelector('main');
  const remember = (root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n; while ((n = walker.nextNode())) {
      if (n.parentElement.closest('[data-check]')) sources.set(n, n.nodeValue);
    }
  };
  const note = (name) => events.push({ name, at: performance.now() });
  const add = (parent, id, text, tag = 'p') => {
    const element = document.createElement(tag);
    element.id = id; element.dataset.check = '';
    if (tag === 'a') element.href = '/watch?v=' + id;
    element.textContent = text; parent.append(element); remember(element); return element;
  };
  const text = (id, value, reuse = false) => {
    const element = document.getElementById(id);
    if (reuse) element.firstChild.nodeValue = value; else element.textContent = value;
    remember(element);
  };
  remember(app);
  const documentIdentity = Math.random().toString(36);
  let ticker, ticks = 0, batch = 0, armed = false;
  const stopTicker = () => { clearInterval(ticker); ticker = null; };
  const actions = {
    'arm-late': () => {
      const observer = new MutationObserver(() => {
        if (!/[가-힣]/u.test(document.querySelector('#video-title').textContent)) return;
        observer.disconnect(); note('initial-title-translated');
        setTimeout(() => {
          add(document.querySelector('#comments'), 'late-comment', 'This lesson is very helpful.');
          add(document.querySelector('#feed'), 'late-card', 'Learn to paint the sky.', 'a');
          note('late-content-inserted');
        }, 100);
      });
      observer.observe(app, { childList: true, characterData: true, subtree: true });
      note('late-insertion-armed');
    },
    'edit-node': () => { text('description', 'New videos arrive every Friday.', true); note('same-text-node-edited'); },
    'replace-text': () => { text('video-title', 'Learn to paint a mountain.'); note('text-node-replaced'); },
    'replace-block': () => {
      const next = document.createElement('section'); next.id = 'feed';
      add(next, 'replaced-card', 'Drawing flowers for beginners.', 'a');
      document.querySelector('#feed').replaceWith(next); note('subtree-replaced');
    },
    'busy-feed': () => {
      ticker = setInterval(() => { document.querySelector('#ticker').textContent = String(++ticks); }, 25);
      const messages = ['Wonderful colors in this video.', 'Please make another lesson.', 'The explanation is clear.', 'I will try this tomorrow.'];
      messages.forEach((value, i) => setTimeout(() => {
        add(document.querySelector('#comments'), 'burst-' + i, value); note('burst-insert-' + i);
      }, i * 70));
      note('continuous-mutations-started');
    },
    'stop-ticker': () => { stopTicker(); note('continuous-mutations-stopped'); },
    'arm-scroll': () => { armed = true; note('scroll-armed'); },
    'navigate': () => {
      history.pushState({}, '', '/watch?v=second-video');
      app.innerHTML = '<h1 id="video-title" data-check>How to bake fresh bread.</h1><p id="description" data-check>Use warm water for the dough.</p><section id="comments"><p id="route-comment" data-check>This recipe works perfectly.</p></section><section id="feed"></section>';
      remember(app); note('spa-route-replaced');
    },
    'start-race': () => {
      text('description', 'Before you begin making the bread, carefully prepare all the ingredients and read each instruction. Leave the dough in a warm place until it has doubled in size.');
      add(document.querySelector('#feed'), 'removed-during-flight', 'A guide to growing vegetables.', 'a');
      note('race-original-inserted');
    },
    'finish-race': () => {
      text('description', 'The updated recipe uses less salt.', true);
      document.querySelector('#removed-during-flight').remove();
      note('race-source-replaced');
    },
    'insert-disabled': () => {
      add(document.querySelector('#comments'), 'disabled-comment', 'I saved this recipe for later.');
      note('inserted-while-disabled');
    }
  };
  for (const [name, action] of Object.entries(actions)) {
    document.getElementById(name).addEventListener('click', action);
  }
  new IntersectionObserver((entries) => {
    if (!armed || !entries.some((entry) => entry.isIntersecting)) return;
    armed = false; batch++;
    const group = document.createElement('section'); group.style.minHeight = '300px';
    const names = ['Simple watercolor techniques.', 'Painting the ocean at sunset.', 'How to draw realistic clouds.'];
    add(group, 'scroll-card-' + batch, names[batch - 1], 'a');
    document.querySelector('#feed').append(group); note('scroll-batch-' + batch);
  }).observe(document.querySelector('#sentinel'));
  document.querySelector('#event-check').addEventListener('click', () => note('click-handler-alive'));
  window.fixture = {
    documentIdentity, events, sources,
    get ticks() { return ticks; }, get batch() { return batch; },
    expectedSnapshot() {
      const clone = document.body.cloneNode(true);
      const liveWalker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const cloneWalker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
      const nodes = []; let live, copy;
      while ((live = liveWalker.nextNode()) && (copy = cloneWalker.nextNode())) {
        const value = sources.has(live) ? sources.get(live) : live.nodeValue;
        copy.nodeValue = value; nodes.push({ node: live, source: value });
      }
      const elements = [...document.body.querySelectorAll('*')];
      return { html: clone.innerHTML, nodes, elements,
        attrs: elements.map((e) => JSON.stringify([...e.attributes].map((a) => [a.name, a.value]))) };
    }
  };
}

const fixtureHTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title translate="no">Dynamic video feed test</title>' +
  '<style>body{font:17px/1.6 system-ui;max-width:920px;margin:24px auto}header{position:sticky;top:0;background:white;border:1px solid #aaa;padding:12px;z-index:2}button{margin:3px}main{padding:16px}section{border-top:1px solid #ddd;padding:12px}a{display:block;margin:8px 0}#spacer{height:950px}#sentinel{height:60px}</style></head><body>' +
  '<header translate="no"><strong>Dynamic DOM fixture</strong><span id="ticker">0</span><div>' +
  ['arm-late','edit-node','replace-text','replace-block','busy-feed','stop-ticker','arm-scroll','navigate','start-race','finish-race','insert-disabled','event-check'].map((name) => '<button id="' + name + '">' + name + '</button>').join('') +
  '</div><input id="draft" value="private draft"></header>' +
  '<main><h1 id="video-title" data-check>Learn to draw a tree.</h1><p id="description" data-check>Keep practicing every day.</p><p data-check>Choose a pencil and a sheet of paper.</p><p data-check>Start with the shape of the tree.</p><section id="comments"><p id="comment-seed" data-check>Thank you for this lesson.</p></section><section id="feed"></section></main>' +
  '<div id="spacer" translate="no"></div><div id="sentinel" translate="no">More videos</div><pre>const example = 1;</pre>' +
  '<script>(' + fixtureApp.toString() + ')();</script></body></html>';

export async function runDynamicPage({ context, options, host, capture, stage, passed, summary, save, out }) {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(fixtureHTML);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const page = await context.newPage();
  const result = summary.dynamic = { scenarios: [], fixture: 'YouTube-like deterministic DOM fixture, not youtube.com', passed: false };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const current = async () => (await host(options)).status;
  let tabId;
  async function enabled(value) {
    // Language choices exist before the asynchronous model/store hydration.
    // Read persisted state, then wait for that state to be rendered before acting.
    // A checkbox changed before render() would otherwise be overwritten by load.
    const previous = await options.evaluate(async () => {
      const s = await AT.settings.load();
      return { enabled: s.enabled, localModelId: s.localModelId, sourceLang: s.sourceLang, targetLang: s.targetLang };
    });
    await options.reload();
    await options.waitForFunction((s) =>
      document.querySelector('#localModel').value === s.localModelId &&
      document.querySelector('#enabled').checked === s.enabled &&
      document.querySelector('#sourceLang').value === s.sourceLang &&
      document.querySelector('#targetLang').value === s.targetLang, previous);
    await options.locator('#enabled').setChecked(value);
    assert.equal(await options.locator('#enabled').isChecked(), value);
    await options.locator('#save').click();
    await options.waitForFunction(async (value) =>
      document.querySelector('#saveStatus').dataset.kind === 'ok' &&
      document.querySelector('#enabled').checked === value &&
      (await AT.settings.load()).enabled === value, value);
  }
  async function translated(label, selectors, since = performance.now()) {
    await stage('dynamic-' + label);
    const deadline = performance.now() + 90000;
    let last;
    while (performance.now() < deadline) {
      last = await page.evaluate((selectors) => {
        const nodes = selectors ? selectors.map((s) => document.querySelector(s)) : [...document.querySelectorAll('[data-check]')];
        return nodes.map((n) => ({ id: n?.id || '', text: n?.textContent || '', ok: !!n && /[가-힣]/u.test(n.textContent) }));
      }, selectors || null);
      const status = await current();
      if (status.state === 'error') throw new Error(label + ': ' + status.lastError);
      if (last.length && last.every((n) => n.ok) && status.state === 'ready') {
        const item = { name: label, passed: true, elapsedMs: performance.now() - since, rendered: last, generations: status.generations };
        result.scenarios.push(item); await passed('dynamic-' + label, item); return item;
      }
      await sleep(100);
    }
    throw new Error(label + ': dynamic text was not translated: ' + JSON.stringify(last));
  }
  async function clickTranslate(action, selectors) {
    const before = await current(); const at = performance.now();
    await page.locator('#' + action).click();
    const item = await translated(action, selectors, at);
    assert.ok(item.generations > before.generations, action + ': real inference must occur');
    return item;
  }
  try {
    await stage('dynamic-initial-load');
    await page.goto('http://127.0.0.1:' + server.address().port + '/watch?v=first-video');
    assert.equal(await page.title(), 'Dynamic video feed test');
    assert.equal(await page.evaluate(() => document.readyState), 'complete');
    const identity = await page.evaluate(() => window.fixture.documentIdentity);
    tabId = await options.evaluate(async (url) => (await AT.api.tabs.query({})).find((t) => t.url === url)?.id, page.url());
    assert.ok(tabId);
    const initialTitle = await page.locator('#video-title').elementHandle();
    const reusedText = await page.locator('#description').evaluateHandle((e) => e.firstChild);
    await page.locator('#arm-late').click();
    const at = performance.now(); await enabled(true);
    await translated('initial-and-delayed-insertion', ['#video-title','#description','#comment-seed','#late-comment','#late-card'], at);
    assert.equal(await initialTitle.evaluate((e) => e === document.querySelector('#video-title')), true);
    await capture(page, 'dynamic-01-delayed-translated');

    await clickTranslate('edit-node', ['#description']);
    assert.equal(await reusedText.evaluate((n) => n === document.querySelector('#description').firstChild), true, 'virtualized element reuses its Text node');
    const replacedText = await page.locator('#video-title').evaluateHandle((e) => e.firstChild);
    await clickTranslate('replace-text', ['#video-title']);
    assert.equal(await replacedText.evaluate((n) => n.isConnected), false);
    await clickTranslate('replace-block', ['#replaced-card']);
    assert.equal(await page.locator('#replaced-card').getAttribute('href'), '/watch?v=replaced-card');

    await clickTranslate('busy-feed', ['#burst-0','#burst-1','#burst-2','#burst-3']);
    result.continuousMutationTicks = await page.evaluate(() => window.fixture.ticks);
    assert.ok(result.continuousMutationTicks >= 4, 'mutations continued during translation');
    await page.locator('#stop-ticker').click();
    await capture(page, 'dynamic-02-busy-feed-translated');

    for (let i = 1; i <= 3; i++) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.locator('#arm-scroll').click();
      const at = performance.now();
      await page.locator('#sentinel').scrollIntoViewIfNeeded();
      await translated('infinite-scroll-' + i, ['#scroll-card-' + i], at);
      assert.equal(await page.evaluate(() => window.fixture.batch), i);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await clickTranslate('navigate', ['#video-title','#description','#route-comment']);
    assert.match(page.url(), /second-video$/);
    assert.equal(await page.evaluate(() => window.fixture.documentIdentity), identity, 'SPA navigation must not reload the document');
    assert.equal(await initialTitle.evaluate((e) => e.isConnected), false);
    await capture(page, 'dynamic-03-spa-translated');

    await stage('dynamic-mutation-during-native-inference');
    await page.locator('#start-race').click();
    let inFlight = false;
    for (let i = 0; i < 400; i++) {
      const s = await current();
      if (s.state === 'busy' && s.phase === 'generate') { inFlight = true; result.raceObserved = s; break; }
      await sleep(25);
    }
    assert.ok(inFlight, 'observe actual native generation before replacing its source');
    const raceAt = performance.now(); await page.locator('#finish-race').click();
    await translated('source-replaced-during-inference', ['#description'], raceAt);
    assert.equal(await page.locator('#removed-during-flight').count(), 0);
    await sleep(1200); await translated('no-stale-write-after-race');

    await stage('dynamic-restore-current-source-through-options');
    const expected = await page.evaluateHandle(() => window.fixture.expectedSnapshot());
    const expectedHTML = await expected.evaluate((o) => o.html);
    await writeFile(join(out, 'dynamic-expected-restored.html'), expectedHTML);
    await capture(page, 'dynamic-04-final-translated');
    const restoreAt = performance.now(); await enabled(false);
    await page.waitForFunction(() => [...window.fixture.sources].every(([n, source]) => !n.isConnected || n.nodeValue === source));
    const check = await expected.evaluate((o) => ({ html: document.body.innerHTML === o.html,
      text: o.nodes.every(({node,source}) => node.nodeValue === source),
      elements: o.elements.every((e,i) => e === document.body.querySelectorAll('*')[i]),
      attributes: o.elements.every((e,i) => JSON.stringify([...e.attributes].map((a) => [a.name,a.value])) === o.attrs[i]) }));
    assert.ok(Object.values(check).every(Boolean), JSON.stringify(check));
    result.restoreMs = performance.now() - restoreAt;
    const restoredHTML = await page.locator('body').innerHTML();
    await writeFile(join(out, 'dynamic-actual-restored.html'), restoredHTML);
    result.restoredSHA256 = createHash('sha256').update(restoredHTML).digest('hex');
    result.expectedSHA256 = createHash('sha256').update(expectedHTML).digest('hex');
    assert.equal(result.restoredSHA256, result.expectedSHA256);
    await capture(page, 'dynamic-05-exactly-restored');
    await passed('dynamic-exact-restoration-after-all-mutations', { ...check, ms: result.restoreMs, sha256: result.restoredSHA256 });
    assert.equal(await page.locator('#draft').inputValue(), 'private draft');
    assert.equal(await page.locator('pre').innerText(), 'const example = 1;');
    await page.locator('#event-check').click();
    assert.ok(await page.evaluate(() => window.fixture.events.some((e) => e.name === 'click-handler-alive')));

    await stage('dynamic-disabled-insertion-and-reenable');
    const offGenerations = (await current()).generations;
    await page.locator('#insert-disabled').click(); await sleep(1500);
    assert.equal(await page.locator('#disabled-comment').innerText(), 'I saved this recipe for later.');
    assert.equal((await current()).generations, offGenerations, 'disabled observer must not request inference');
    await enabled(true); await translated('reenable-translates-offline-insertion');
    await sleep(1200);
    const quietGenerations = (await current()).generations;
    await sleep(1500);
    assert.equal((await current()).generations, quietGenerations, 'own DOM writes must not create a translation feedback loop');
    result.noFeedbackGenerations = quietGenerations;
    await enabled(false);
    await page.waitForFunction(() => [...window.fixture.sources].every(([n, source]) => !n.isConnected || n.nodeValue === source));
    result.events = await page.evaluate(() => window.fixture.events);
    result.documentIdentityRetained = await page.evaluate((identity) => window.fixture.documentIdentity === identity, identity);
    result.passed = true; summary.dynamicTranslationRestorePassed = true;
    await passed('dynamic-disabled-reenable-and-no-feedback', { inferenceWhileOff: 0, extraIdleGenerations: 0 });
    await save(); await expected.dispose(); await reusedText.dispose(); await replacedText.dispose(); await initialTitle.dispose();
  } catch (error) {
    result.failure = { stage: summary.stage, message: error.message };
    result.events = await page.evaluate(() => window.fixture?.events).catch(() => []);
    await capture(page, 'FAIL-dynamic-page').catch(() => {}); await save(); throw error;
  } finally {
    await page.close().catch(() => {}); server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, launchOptions, scripts } from './support.mjs';

// Real Chromium CSS layout and Range geometry; only translation is deterministic.
let browser;
test.before(async () => { browser = await chromium.launch(launchOptions); });
test.after(async () => { await browser?.close(); });

async function fixture(run) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  try {
    await page.setContent('<!doctype html><main id="fixture"></main>');
    await scripts(page, ['lib/constants.js', 'lib/dom.js', 'lib/translationtext.js']);
    return await page.evaluate(run);
  } finally { await page.close(); }
}

test('real line-clamped lyrics yield after visible lines, then expand without retranslating the prefix', async () => {
  const result = await fixture(async () => {
    const root = document.querySelector('#fixture');
    root.innerHTML = '<div id="lyrics" style="width:360px;font:16px/24px monospace;white-space:pre-line;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden"></div><p id="ordinary">Other visible comment.</p>';
    const element = root.querySelector('#lyrics');
    const source = ['First visible lyric.', 'Second visible lyric.', ...Array.from({ length: 40 }, (_, i) => `Hidden lyric number ${i}.`)].join('\n');
    const node = document.createTextNode(source);
    element.append(node);
    const ordinary = root.querySelector('#ordinary').firstChild;
    const originalStyle = element.getAttribute('style');
    const requests = [];
    const translator = AT.dom.createTranslator({
      doc: document,
      sentences: { split: (text) => text.match(/[^.]+\./g)?.map((part) => part.trim()) ?? [text], maxChars: 1 },
      translate: async (texts) => { requests.push(...texts); return texts.map((text) => text.toUpperCase()); }
    });
    const first = await translator.translateNodes([node, ordinary]);
    const initial = {
      requests: [...requests], partial: node.nodeValue, pending: first.pending.includes(node),
      deferred: translator.deferred(node), complete: translator.has(node),
      identity: element.firstChild === node && element.childNodes.length === 1,
      style: element.getAttribute('style') === originalStyle
    };
    element.style.webkitLineClamp = 'unset';
    const promoted = !translator.deferred(node);
    await translator.translateNodes(first.pending);
    const finished = node.nodeValue === source.toUpperCase() && translator.has(node);
    const prefixRequests = requests.filter((text) => text === 'First visible lyric.').length;
    translator.restore();
    return { initial, promoted, finished, prefixRequests, restored: node.nodeValue === source && element.firstChild === node };
  });
  assert.deepEqual(result.initial.requests, ['First visible lyric.', 'Second visible lyric.', 'Other visible comment.']);
  assert.equal(result.initial.partial.startsWith('FIRST VISIBLE LYRIC.\nSECOND VISIBLE LYRIC.\nHidden lyric number 0.'), true);
  assert.equal(result.initial.pending, true);
  assert.equal(result.initial.deferred, true);
  assert.equal(result.initial.complete, false);
  assert.equal(result.initial.identity, true);
  assert.equal(result.initial.style, true);
  assert.equal(result.promoted, true);
  assert.equal(result.finished, true);
  assert.equal(result.prefixRequests, 1);
  assert.equal(result.restored, true);
});

test('clipped attributed text keeps its visible prefix bounded with the production shadow presentation', async () => {
  const result = await fixture(async () => {
    const root = document.querySelector('#fixture');
    document.documentElement.style.overflow = 'visible';
    document.body.style.cssText = 'height:0;overflow-y:scroll';
    root.style.marginTop = '1200px';
    root.innerHTML = '<div style="width:680px;height:80px;overflow:hidden;display:flow-root;font:14px/20px sans-serif;white-space:pre-wrap"><yt-attributed-string id="text"></yt-attributed-string></div><p>Other visible comment.</p>';
    const element = root.querySelector('#text');
    const source = '歌詞です（自分用）\n\nしわあわせ\n\n\n' + '僕の時価総額400円の心臓と\n絵に描いたような君の綺麗な心臓を\n'.repeat(20);
    const node = document.createTextNode(source);
    element.append(node);
    window.scrollTo(0, 1100);
    const requests = [];
    const translator = AT.dom.createTranslator({
      doc: document, presentation: AT.translationtext.create(document),
      translate: async (texts) => { requests.push(...texts); return texts.map(text => '번역 ' + text); }
    });
    const first = await translator.translateNodes([node, root.querySelector('p').firstChild]);
    const state = { requests, pending: first.pending.includes(node), complete: translator.has(node),
      sourceSuffix: node.data.endsWith(source.slice(source.indexOf('僕'))), identity: element.contains(node) };
    translator.restore();
    return { ...state, scrollY, bodyHeight: document.body.clientHeight,
      restored: element.firstChild === node && node.data === source && !root.querySelector('at-translation-text') };
  });
  assert.equal(result.requests[0].includes('僕'), false, 'hidden lyrics never enter the visible-prefix request');
  assert.equal(result.requests[1], 'Other visible comment.');
  assert.ok(result.scrollY > 0, 'the viewport has moved beyond the zero-height body origin');
  assert.equal(result.bodyHeight, 0);
  assert.equal(result.pending, true);
  assert.equal(result.complete, false);
  assert.equal(result.sourceSuffix, true);
  assert.equal(result.identity, true);
  assert.equal(result.restored, true);
});

test('nested scaled overflow clips use padding-box geometry and preserve bidi, blank lines and surrogate pairs', async () => {
  const result = await fixture(async () => {
    const root = document.querySelector('#fixture');
    root.innerHTML = '<section style="width:370px;height:54px;padding:4px;border:7px solid black;overflow:hidden;transform:scale(1.15);transform-origin:top left"><div id="text" dir="rtl" style="font:16px/24px monospace;white-space:pre-wrap"></div></section>';
    const element = root.querySelector('#text');
    const source = 'First English אבג lyric 😀.\n\nSecond English אבג lyric 😀.\nThird hidden English lyric.\nFourth hidden English lyric.';
    const node = document.createTextNode(source);
    element.append(node);
    const requests = [];
    const translator = AT.dom.createTranslator({ doc: document,
      translate: async (texts) => { requests.push(...texts); return texts.map((text) => text.toUpperCase()); }
    });
    let result = await translator.translateNodes([node]);
    const first = requests.join('');
    const untouchedSuffix = node.nodeValue.endsWith('Third hidden English lyric.\nFourth hidden English lyric.');
    for (let count = 0; result.pending.length && count < 30; count++) result = await translator.translateNodes(result.pending);
    const finished = node.nodeValue === source.toUpperCase() && translator.has(node);
    const validUnicode = requests.every((text) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text));
    translator.restore();
    return { first, untouchedSuffix, finished, validUnicode, restored: node.nodeValue === source, identity: element.firstChild === node && element.childNodes.length === 1 };
  });
  assert.equal(result.first.includes('First English'), true);
  assert.equal(result.first.includes('Third hidden'), false);
  assert.equal(result.untouchedSuffix, true);
  assert.equal(result.finished, true);
  assert.equal(result.validUnicode, true);
  assert.equal(result.restored, true);
  assert.equal(result.identity, true);
});

test('horizontal ellipsis clips and zero-width newline ranges do not drain a hidden suffix', async () => {
  const results = await fixture(async () => {
    const root = document.querySelector('#fixture');
    const results = [];
    for (const style of [
      'width:190px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis',
      'width:350px;height:24px;white-space:pre-wrap;overflow:clip'
    ]) {
      const element = document.createElement('div');
      element.style.cssText = 'font:16px/24px monospace;' + style;
      const source = 'Visible opening lyric.\n\nHidden second lyric with many more words.\nLast hidden lyric.';
      const node = document.createTextNode(source);
      element.append(node);
      root.append(element);
      const requests = [];
      const translator = AT.dom.createTranslator({ doc: document,
        translate: async (texts) => { requests.push(...texts); return texts.map((text) => text.toUpperCase()); }
      });
      let pass = await translator.translateNodes([node]);
      const bounded = requests.join('').length < source.length && !requests.join('').includes('Last hidden');
      const pending = pass.pending.includes(node);
      for (let count = 0; pass.pending.length && count < 30; count++) pass = await translator.translateNodes(pass.pending);
      const finished = node.nodeValue === source.toUpperCase() && translator.has(node);
      translator.restore();
      results.push({ bounded, pending, finished, restored: node.nodeValue === source });
      element.remove();
    }
    return results;
  });
  for (const result of results) assert.deepEqual(result, { bounded: true, pending: true, finished: true, restored: true });
});

test('restoring during a real clipped continuation discards its reply and retains Text identity', async () => {
  const result = await fixture(async () => {
    const root = document.querySelector('#fixture');
    root.innerHTML = '<p style="font:16px/24px monospace;white-space:pre-line;height:24px;overflow:hidden"></p>';
    const element = root.firstChild;
    const source = 'Visible first lyric.\nHidden second lyric.\nHidden third lyric.';
    const node = document.createTextNode(source);
    element.append(node);
    let release;
    let first = true;
    const translator = AT.dom.createTranslator({ doc: document,
      translate: async (texts) => {
        if (first) { first = false; return texts.map((text) => text.toUpperCase()); }
        return new Promise((resolve) => { release = () => resolve(texts.map((text) => text.toUpperCase())); });
      }
    });
    const prefix = await translator.translateNodes([node]);
    const pending = translator.translateNodes(prefix.pending);
    // The model request starts synchronously after the translator's drain barrier.
    for (let turn = 0; !release && turn < 20; turn++) await Promise.resolve();
    if (!release) throw new Error('clipped continuation did not dispatch its pending source');
    translator.restore();
    release();
    await pending;
    return { restored: node.nodeValue === source, identity: element.firstChild === node, complete: translator.has(node) };
  });
  assert.deepEqual(result, { restored: true, identity: true, complete: false });
});

test('real clipping skips a target-language prefix before presentation and resumes the foreign source', async () => {
  const result = await fixture(async () => {
    const root = document.querySelector('#fixture');
    root.innerHTML = '<div style="font:16px/24px monospace;white-space:pre-wrap;height:24px;overflow:hidden;width:500px"></div>';
    const element = root.firstChild;
    const source = '이미 한국어입니다.\nEnglish reply follows. Last English sentence.';
    const node = document.createTextNode(source);
    element.append(node);
    const requests = [];
    const events = [];
    const translator = AT.dom.createTranslator({
      doc: document,
      sentences: { split: (text) => text.match(/[^.]+\./g)?.map((part) => part.trim()) ?? [text], maxChars: 1 },
      shouldTranslate: (text) => !/[가-힣]/u.test(text),
      translate: async (texts) => { requests.push(...texts); return texts.map((text) => text.toUpperCase()); },
      presentation: {
        begin: () => events.push('begin'), applied: () => events.push('applied'),
        settled: () => events.push('settled'), forget: () => {}, restore: () => {}
      }
    });
    const first = await translator.translateNodes([node]);
    const skipped = requests.length === 0 && events.length === 0 && first.failed === 0 &&
      first.translated === 0 && first.pending.includes(node) && node.nodeValue === source;
    element.style.height = 'auto';
    await translator.translateNodes(first.pending);
    const finished = node.nodeValue === source.toUpperCase() && translator.has(node);
    translator.restore();
    return { skipped, requests, finished, restored: node.nodeValue === source && element.firstChild === node };
  });
  assert.equal(result.skipped, true);
  assert.deepEqual(result.requests, ['English reply follows.', 'Last English sentence.']);
  assert.equal(result.finished, true);
  assert.equal(result.restored, true);
});

test('interactive quanta resume real unclipped and clipped inline comments with exact element ownership', async () => {
  const results = await fixture(async () => {
    const root = document.querySelector('#fixture');
    const results = [];
    for (const clipped of [false, true]) {
      const element = document.createElement('p');
      element.style.cssText = 'width:700px;font:16px/24px monospace;white-space:pre-wrap;' +
        (clipped ? 'height:24px;overflow:hidden' : '');
      const sources = [
        ' \t' + 'abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz0' + '😀' +
          Array.from({ length: 80 }, (_, i) => `bc${i}`).join('') + ' ',
        'link ' + Array.from({ length: 20 }, (_, i) => `word${i}`).join(' '),
        '\nlast ' + Array.from({ length: 20 }, (_, i) => `term${i}`).join(' ') + '\t'
      ];
      const nodes = sources.map((source) => document.createTextNode(source));
      const link = document.createElement('a');
      link.setAttribute('href', '/original');
      link.append(nodes[1]);
      const emphasis = document.createElement('em');
      emphasis.append(nodes[2]);
      element.append(nodes[0], link, emphasis);
      root.append(element);
      const requests = [];
      let dispatched = 0;
      const translator = AT.dom.createTranslator({
        doc: document,
        workLimit: () => ({ maxChars: 64, maxTexts: 1 }),
        shouldYield: () => dispatched >= 1,
        sentences: { always: true, maxChars: 1, split: (text) => text.match(/[^.]+\./g) ?? [text] },
        translate: async (texts) => {
          dispatched++;
          requests.push([...texts]);
          return texts.map((text) => text.toUpperCase());
        }
      });
      let pass = await translator.translateRoot(element);
      const prefix = requests[0][0];
      const initial = {
        bounded: requests.length === 1 && prefix.length <= 64,
        exactSuffix: nodes[0].nodeValue === sources[0].slice(0, 2) + prefix.toUpperCase() + sources[0].slice(2 + prefix.length),
        untouchedInline: nodes[1].nodeValue === sources[1] && nodes[2].nodeValue === sources[2],
        pending: pass.pending.includes(nodes[0]),
        incomplete: !translator.has(nodes[0])
      };
      element.style.height = 'auto';
      let oneRequestPerPass = true;
      for (let count = 0; pass.pending.length && count < 40; count++) {
        dispatched = 0;
        pass = await translator.translateNodes(pass.pending);
        oneRequestPerPass &&= dispatched <= 1;
      }
      const complete = pass.pending.length === 0 &&
        nodes.every((node, index) => translator.has(node) && node.nodeValue === sources[index].toUpperCase());
      const bounded = requests.every((texts) => texts.length === 1 && texts[0].length <= 64);
      const validUnicode = requests.flat().every((text) =>
        !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text));
      translator.restore();
      const restored = nodes.every((node, index) => node.nodeValue === sources[index]);
      const identity = element.firstChild === nodes[0] && link.firstChild === nodes[1] &&
        emphasis.firstChild === nodes[2] && link.getAttribute('href') === '/original';
      dispatched = 0;
      await translator.translateNodes([nodes[0]]);
      nodes[0].nodeValue = 'New page-owned comment. Another sentence.';
      dispatched = 0;
      const edited = await translator.translateNodes([nodes[0]]);
      const sourceEdit = edited.pending.length === 0 && translator.has(nodes[0]) &&
        requests.at(-1)[0] === 'New page-owned comment. Another sentence.';
      translator.restore();
      const restoredEdit = nodes[0].nodeValue === 'New page-owned comment. Another sentence.';
      results.push({ initial, oneRequestPerPass, complete, bounded, validUnicode, restored, identity, sourceEdit, restoredEdit });
      element.remove();
    }
    return results;
  });
  for (const result of results) {
    assert.deepEqual(result.initial, { bounded: true, exactSuffix: true, untouchedInline: true, pending: true, incomplete: true });
    for (const [name, value] of Object.entries(result)) if (name !== 'initial') assert.equal(value, true, name);
  }
});

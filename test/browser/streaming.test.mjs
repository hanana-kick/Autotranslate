import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, launchOptions, scripts, screenshot } from './support.mjs';

// Real renderer, layout, CSS animations and DOM ownership. Provider completion
// is gated independently of its cumulative decoded progress events.
let browser;
test.before(async () => { browser = await chromium.launch(launchOptions); });
test.after(async () => { await browser?.close(); });

function check(name, run) {
  test(name, { timeout: 20000 }, async () => {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.setContent('<!doctype html><title translate="no">Streaming regression</title><main id="fixture"></main>');
      await scripts(page, ['lib/constants.js', 'lib/dom.js', 'lib/translationtext.js']);
      await run(page);
      assert.deepEqual(errors, [], 'no uncaught browser errors');
    } catch (error) {
      await screenshot(page, `FAIL-streaming-${name.replace(/[^a-z0-9]+/gi, '-')}`).catch(() => {});
      throw error;
    } finally { await page.close(); }
  });
}

async function start(page, html = '<p>Original source sentence.</p>') {
  await page.evaluate((markup) => {
    const root = document.querySelector('#fixture');
    root.innerHTML = markup;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    window.source = walker.nextNode();
    window.original = source.data;
    window.originalHTML = root.innerHTML;
    window.presentation = AT.translationtext.create(document);
    window.requests = [];
    window.translator = AT.dom.createTranslator({ doc: document, presentation,
      translate: (texts, progress) => new Promise((resolve, reject) => requests.push({ texts, progress, resolve, reject })) });
    window.task = translator.translateRoot(root);
    window.previewElement = () => document.querySelector('at-translation-text')?.shadowRoot.querySelector('.preview');
    window.emit = (text) => requests[0].progress(0, text);
    window.waitPreview = async (text, prefix = false) => {
      const deadline = performance.now() + 3000;
      while (prefix ? !previewElement()?.textContent.startsWith(text) : previewElement()?.textContent !== text) {
        if (performance.now() > deadline) throw new Error('preview was not rendered: ' + text);
        await new Promise(requestAnimationFrame);
      }
      return previewElement();
    };
  }, html);
  await page.waitForFunction(() => requests.length === 1);
}

check('streaming fades only changes and commits the canonical Text', async (page) => {
  await start(page, '<p style="width:260px;font:18px/1.5 system-ui"><a href="/privacy" data-page="kept">Original source sentence.</a></p>');
  const fade = await page.evaluate(async () => {
    window.link = document.querySelector('#fixture a');
    window.clicks = 0;
    link.addEventListener('click', (event) => { event.preventDefault(); clicks++; });
    emit('번역된 문장');
    const preview = await waitPreview('번역된 문장');
    const changed = preview.lastElementChild;
    const first = Number(getComputedStyle(changed).opacity);
    await new Promise((resolve) => setTimeout(resolve, 65));
    const middle = Number(getComputedStyle(changed).opacity);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const last = Number(getComputedStyle(changed).opacity);
    const host = source.parentElement;
    const slot = host.shadowRoot.querySelector('slot');
    const range = document.createRange();
    range.selectNodeContents(preview);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    const selected = selection.toString(); selection.removeAllRanges();
    return { first, middle, last, source: source.data, hostText: host.textContent,
      hiddenSource: getComputedStyle(slot).display === 'none', selected,
      live: host.getAttribute('aria-live'), busy: host.getAttribute('aria-busy'),
      surfaceOpacity: getComputedStyle(preview.parentElement).opacity,
      readable: [...range.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0) };
  });
  assert.ok(fade.first < fade.middle && fade.middle < fade.last, JSON.stringify(fade));
  assert.equal(fade.last, 1);
  assert.equal(fade.surfaceOpacity, '1', 'the paragraph itself never fades');
  assert.equal(fade.source, 'Original source sentence.');
  assert.equal(fade.hostText, fade.source, 'preview never enters the page light DOM');
  assert.equal(fade.hiddenSource, true);
  assert.equal(fade.selected, '번역된 문장');
  assert.equal(fade.live, null, 'tokens do not produce duplicate live announcements');
  assert.equal(fade.busy, 'true');
  assert.equal(fade.readable, true);

  const stable = await page.evaluate(async () => {
    emit('번역된 문장 새로운');
    const preview = await waitPreview('번역된 문장 새로운');
    const stableNode = preview.firstChild;
    const changed = preview.lastElementChild;
    const animation = changed.getAnimations().find((item) => item.effect.getKeyframes().some((frame) => frame.opacity !== undefined));
    const time = animation.currentTime;
    emit('번역된 문장 새로운 부분');
    await waitPreview('번역된 문장 새로운 부분');
    return { stableText: stableNode.data, sameStable: stableNode === preview.firstChild,
      stableAnimations: preview.getAnimations().length, stableOpacity: getComputedStyle(preview).opacity,
      retained: preview.contains(changed), sameFade: changed.getAnimations().includes(animation),
      timeAdvanced: animation.currentTime > time, source: source.data };
  });
  assert.deepEqual(stable, { stableText: '번역된 문장', sameStable: true, stableAnimations: 0,
    stableOpacity: '1', retained: true, sameFade: true, timeAdvanced: true, source: 'Original source sentence.' });

  assert.deepEqual(await page.evaluate(async () => {
    requests[0].resolve(['정확한 최종 번역.']); await task;
    const host = source.parentElement;
    link.click();
    const result = { source: source.data, same: host.firstChild === source,
      sameLink: document.querySelector('#fixture a') === link, clicks,
      preview: Boolean(previewElement()), reveal: host.hasAttribute('data-reveal'),
      slot: getComputedStyle(host.shadowRoot.querySelector('slot')).display !== 'none' };
    translator.restore();
    return { ...result, restored: document.querySelector('#fixture').innerHTML === originalHTML,
      direct: link.firstChild === source };
  }), { source: '정확한 최종 번역.', same: true, sameLink: true, clicks: 1,
    preview: false, reveal: false, slot: true, restored: true, direct: true });
});

check('streaming coalesces bursts bounds spans and corrects an existing suffix', async (page) => {
  await start(page);
  const result = await page.evaluate(async () => {
    let peakSpans = 0, peakAnimations = 0, peakElements = 0;
    let cumulative = '안정적인 접두사 ';
    for (let index = 0; index < 40; index++) {
      cumulative += `${index}번째 글자 `;
      for (let burst = 0; burst < 8; burst++) emit(cumulative + burst);
      const preview = await waitPreview(cumulative + 7);
      peakSpans = Math.max(peakSpans, preview.children.length);
      peakAnimations = Math.max(peakAnimations, preview.getAnimations({ subtree: true }).length);
      peakElements = Math.max(peakElements, source.parentElement.shadowRoot.querySelectorAll('*').length);
    }
    emit('안정적인 접두사 수정된 결과');
    const preview = await waitPreview('안정적인 접두사 수정된 결과');
    await new Promise((resolve) => setTimeout(resolve, 220));
    const animations = preview.getAnimations({ subtree: true }).filter((animation) => animation.playState === 'running');
    const result = { peakSpans, peakAnimations, peakElements, corrected: preview.textContent,
      source: source.data, running: animations.length, completed: translator.stats().translated };
    requests[0].resolve(['완료된 번역']); await task;
    return result;
  });
  assert.ok(result.peakSpans <= 5, JSON.stringify(result));
  assert.ok(result.peakAnimations <= 6, JSON.stringify(result));
  assert.ok(result.peakElements <= 9, JSON.stringify(result));
  assert.equal(result.corrected, '안정적인 접두사 수정된 결과');
  assert.equal(result.source, 'Original source sentence.');
  assert.equal(result.running, 1, 'only the changed tail aurora remains after fades finish');
  assert.equal(result.completed, 0, 'preview is not counted as a completed translation');
});

check('empty progress failure and restore cancel scheduled previews', async (page) => {
  await start(page);
  assert.deepEqual(await page.evaluate(async () => {
    emit('임시 번역'); await waitPreview('임시 번역');
    emit('');
    const cleared = !previewElement() && !source.parentElement.hasAttribute('data-streaming');
    emit('렌더링되면 안 됩니다');
    translator.restore();
    emit('복원 뒤 늦은 번역');
    requests[0].resolve(['늦은 최종 번역']); await task;
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { cleared, exact: document.querySelector('#fixture').innerHTML === originalHTML,
      same: document.querySelector('#fixture p').firstChild === source,
      wrappers: document.querySelectorAll('at-translation-text').length };
  }), { cleared: true, exact: true, same: true, wrappers: 0 });

  await start(page);
  assert.deepEqual(await page.evaluate(async () => {
    emit('실패할 임시 번역'); await waitPreview('실패할 임시 번역');
    requests[0].resolve(['']);
    let error = null;
    try { await task; } catch (failure) { error = failure.message; }
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { exact: document.querySelector('#fixture').innerHTML === originalHTML,
      wrappers: document.querySelectorAll('at-translation-text').length, completed: translator.stats().translated, error };
  }), { exact: true, wrappers: 0, completed: 0, error: 'empty translation segment' });
});

check('page edits and detach immediately remove stale previews without resurrection', async (page) => {
  for (const kind of ['characterData', 'replace', 'append', 'move', 'detach']) {
    await start(page);
    const result = await page.evaluate(async (kind) => {
      emit('사라져야 하는 미리보기'); await waitPreview('사라져야 하는 미리보기');
      const root = document.querySelector('#fixture');
      const paragraph = root.firstChild;
      const host = source.parentElement;
      if (kind === 'characterData') source.data = 'Site updated source.';
      if (kind === 'replace') host.replaceChildren(document.createTextNode('Site replaced source.'));
      if (kind === 'append') host.appendChild(document.createTextNode(' Site appended text.'));
      if (kind === 'move') root.appendChild(source);
      if (kind === 'detach') paragraph.remove();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const immediate = !host.shadowRoot.querySelector('.preview') && !host.hasAttribute('data-streaming');
      const pageText = root.textContent;
      emit('늦은 미리보기'); requests[0].resolve(['늦은 최종 결과']); await task;
      translator.restore();
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { immediate, pageText, finalText: root.textContent,
        wrappers: root.querySelectorAll('at-translation-text').length };
    }, kind);
    assert.equal(result.immediate, true, kind);
    assert.equal(result.finalText, result.pageText, kind);
    assert.equal(result.wrappers, 0, kind);
    if (kind === 'characterData') assert.equal(result.finalText, 'Site updated source.');
    if (kind === 'replace') assert.equal(result.finalText, 'Site replaced source.');
    if (kind === 'append') assert.equal(result.finalText, 'Original source sentence. Site appended text.');
    if (kind === 'detach') assert.equal(result.finalText, '');
  }
});

for (const media of [{ reducedMotion: 'reduce' }, { forcedColors: 'active' }]) {
  check(`streaming respects ${Object.keys(media)[0]} with readable selectable text`, async (page) => {
    await page.emulateMedia(media);
    await start(page);
    const result = await page.evaluate(async () => {
      emit('접근 가능한 번역');
      const preview = await waitPreview('접근 가능한 번역');
      const range = document.createRange(); range.selectNodeContents(preview);
      const result = { text: preview.textContent, opacity: getComputedStyle(preview.lastElementChild).opacity,
        animations: preview.getAnimations({ subtree: true }).length,
        readable: [...range.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0),
        source: source.data, slotHidden: getComputedStyle(source.parentElement.shadowRoot.querySelector('slot')).display === 'none' };
      requests[0].resolve(['접근 가능한 최종 번역']); await task;
      translator.restore();
      return result;
    });
    assert.deepEqual(result, { text: '접근 가능한 번역', opacity: '1', animations: 0, readable: true,
      source: 'Original source sentence.', slotHidden: true });
  });
}

check('all presentation lifecycle transitions cancel a queued repaint', async (page) => {
  const results = await page.evaluate(async () => {
    const results = [];
    for (const method of ['begin', 'applied', 'settled', 'forget', 'restore', 'clearPreview']) {
      const root = document.querySelector('#fixture');
      root.innerHTML = '<p>Lifecycle original source.</p>';
      const node = root.firstChild.firstChild;
      const presentation = AT.translationtext.create(document);
      presentation.begin(node);
      presentation.preview(node, '기존 미리보기');
      await new Promise((resolve) => setTimeout(resolve, 100));
      presentation.preview(node, '취소되어야 하는 다음 미리보기');
      if (method === 'applied') {
        node.data = 'Canonical translation.';
        presentation.applied(node, true);
      } else if (method === 'settled') presentation.settled(node, 'partial');
      else if (method === 'restore') presentation.restore(root);
      else presentation[method](node);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const host = root.querySelector('at-translation-text');
      results.push({ method, preview: Boolean(host?.shadowRoot.querySelector('.preview')),
        scheduled: Boolean(host?.hasAttribute('data-streaming')), same: root.contains(node),
        text: node.data });
      presentation.restore(root);
    }
    return results;
  });
  for (const result of results) {
    assert.equal(result.preview, false, result.method);
    assert.equal(result.scheduled, false, result.method);
    assert.equal(result.same, true, result.method);
    assert.equal(result.text, result.method === 'applied' ? 'Canonical translation.' : 'Lifecycle original source.');
  }
});

check('inline previews preserve clipping and final hidden source suffix', async (page) => {
  await start(page, '<p style="font:16px/24px monospace;white-space:pre-wrap;height:24px;overflow:hidden;width:500px">Visible first source line.\nHidden source line that must not be consumed.\nAnother hidden source line.</p>');
  const result = await page.evaluate(async () => {
    const sent = requests[0].texts[0];
    emit('보이는 첫 문장.');
    const preview = await waitPreview('보이는 첫 문장.', true);
    const host = source.parentElement;
    const paragraph = document.querySelector('#fixture p');
    const range = document.createRange(); range.selectNodeContents(preview);
    const bounds = paragraph.getBoundingClientRect();
    const inline = getComputedStyle(host).display === 'inline' &&
      getComputedStyle(preview).display === 'inline' &&
      getComputedStyle(preview).position === 'static';
    const withinLine = [...range.getClientRects()].every((rect) =>
      rect.left >= bounds.left && rect.right <= bounds.right && rect.height <= 24);
    requests[0].resolve(['보이는 첫 문장.']); await task;
    const result = { sent, inline, withinLine, same: paragraph.contains(source),
      hiddenPreserved: source.data.includes('Hidden source line that must not be consumed.') &&
        source.data.includes('Another hidden source line.'),
      previewRemoved: !previewElement() };
    translator.restore();
    return { ...result, restored: document.querySelector('#fixture').innerHTML === originalHTML };
  });
  assert.equal(result.sent.includes('Hidden source'), false);
  assert.equal(result.inline, true);
  assert.equal(result.withinLine, true);
  assert.equal(result.same, true);
  assert.equal(result.hiddenPreserved, true);
  assert.equal(result.previewRemoved, true);
  assert.equal(result.restored, true);
});

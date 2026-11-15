import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, launchOptions, scripts, screenshot } from './support.mjs';

// Real renderer, layout, CSS animations and DOM ownership. Provider completion
// is gated independently of its cumulative decoded progress events.
let browser;
test.before(async () => { browser = await chromium.launch(launchOptions); });
test.after(async () => { await browser?.close(); });

function check(name, run, withoutSegmenter = false) {
  test(name, { timeout: 20000 }, async () => {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.setContent('<!doctype html><title translate="no">Streaming regression</title><main id="fixture"></main>');
      if (withoutSegmenter) await page.evaluate(() => {
        window.referenceSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
        Intl.Segmenter = undefined;
      });
      await scripts(page, ['lib/constants.js', 'lib/dom.js', 'lib/translationtext.js']);
      await run(page);
      assert.deepEqual(errors, [], 'no uncaught browser errors');
    } catch (error) {
      await screenshot(page, `FAIL-streaming-${name.replace(/[^a-z0-9]+/gi, '-')}`).catch(() => {});
      throw error;
    } finally { await page.close(); }
  });
}

async function start(page, html = '<p>Original source sentence.</p>', maxChars = 0, mode = 'aurora') {
  await page.evaluate(({ markup, maxChars, mode }) => {
    const root = document.querySelector('#fixture');
    root.innerHTML = markup;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    window.source = walker.nextNode();
    window.original = source.data;
    window.originalHTML = root.innerHTML;
    window.presentation = AT.translationtext.create(document, mode);
    window.requests = [];
    window.translator = AT.dom.createTranslator({ doc: document, presentation,
      workLimit: maxChars ? () => ({ maxChars, maxTexts: 1 }) : undefined,
      translate: (texts, progress) => new Promise((resolve, reject) => requests.push({ texts, progress, resolve, reject })) });
    window.task = translator.translateRoot(root);
    window.previewElement = () => document.querySelector('at-translation-text')?.shadowRoot.querySelector('.preview');
    window.emit = (text) => requests[0].progress(0, text);
    window.waitPreview = async (text, prefix = true) => {
      const deadline = performance.now() + 3000;
      while (prefix ? !previewElement()?.textContent.startsWith(text) : previewElement()?.textContent !== text) {
        if (performance.now() > deadline) throw new Error('preview was not rendered: ' + text);
        await new Promise(requestAnimationFrame);
      }
      return previewElement();
    };
  }, { markup: html, maxChars, mode });
  await page.waitForFunction(() => requests.length === 1);
}

check('immediate mode exposes each streaming update and final canonical text without a reveal wait', async (page) => {
  await start(page, '<p><a href="#target">Original source sentence.</a></p>', 0, 'immediate');
  const result = await page.evaluate(async () => {
    const root = document.querySelector('#fixture'), link = root.querySelector('a');
    const host = source.parentElement, surface = host.shadowRoot.querySelector('.surface');
    let clicks = 0;
    link.addEventListener('click', (event) => { event.preventDefault(); clicks++; });
    emit('첫 번역');
    const first = previewElement()?.textContent;
    emit('최신 번역');
    const preview = previewElement();
    const latest = preview?.textContent;
    const range = document.createRange(); range.selectNodeContents(preview);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    const selected = selection.toString(); selection.removeAllRanges();
    const during = { first, latest, selected, source: source.data, busy: host.getAttribute('aria-busy'),
      same: host.firstChild === source, opacity: getComputedStyle(preview).opacity,
      readable: [...range.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0),
      hiddenSlot: getComputedStyle(host.shadowRoot.querySelector('slot')).display === 'none',
      animations: surface.getAnimations({ subtree: true }).length,
      decoration: getComputedStyle(surface).backgroundImage,
      spans: preview.children.length };
    requests[0].resolve(['정확한 최종 번역.']); await task;
    link.click();
    const final = { canonical: source.data, preview: Boolean(previewElement()),
      slot: getComputedStyle(host.shadowRoot.querySelector('slot')).display !== 'none',
      state: host.dataset.state, busy: host.hasAttribute('aria-busy'),
      same: host.firstChild === source, clicks };
    translator.restore();
    return { during, final, restored: root.innerHTML === originalHTML, identity: link.firstChild === source };
  });
  assert.ok(result.during.first.startsWith('첫 번역'));
  assert.ok(result.during.latest.startsWith('최신 번역'));
  assert.deepEqual(result.during, {
    first: result.during.first, latest: result.during.latest, selected: result.during.latest,
    source: 'Original source sentence.', busy: 'true', same: true, opacity: '1',
    readable: true, hiddenSlot: true, animations: 0, decoration: 'none', spans: 0
  });
  assert.deepEqual(result.final, { canonical: '정확한 최종 번역.', preview: false, slot: true,
    state: 'translated', busy: false, same: true, clicks: 1 });
  assert.equal(result.restored, true);
  assert.equal(result.identity, true);
});

check('switching to immediate flushes queued previews and cancels an in-progress final reveal', async (page) => {
  await start(page);
  const result = await page.evaluate(async () => {
    const host = source.parentElement;
    emit('대기 중인 번역');
    const queued = !previewElement();
    presentation.setMode('immediate');
    const flushed = previewElement()?.textContent.startsWith('대기 중인 번역');
    presentation.setMode('aurora');
    emit('다음 번역');
    const stillPrevious = previewElement()?.textContent.startsWith('대기 중인 번역');
    presentation.setMode('immediate');
    const latest = previewElement()?.textContent.startsWith('다음 번역');
    presentation.setMode('aurora');
    requests[0].resolve(['최종 번역']); await task;
    const revealing = Boolean(previewElement());
    presentation.setMode('immediate');
    const final = !previewElement() && getComputedStyle(host.shadowRoot.querySelector('slot')).display !== 'none';
    const animations = host.shadowRoot.querySelector('.surface').getAnimations({ subtree: true }).length;
    await new Promise((resolve) => setTimeout(resolve, 240));
    const noLatePreview = !previewElement();
    translator.restore();
    presentation.setMode('aurora');
    return { queued, flushed, stillPrevious, latest, revealing, final, animations, noLatePreview,
      restored: document.querySelector('#fixture').innerHTML === originalHTML,
      same: document.querySelector('#fixture p').firstChild === source };
  });
  assert.deepEqual(result, { queued: true, flushed: true, stillPrevious: true, latest: true,
    revealing: true, final: true, animations: 0, noLatePreview: true, restored: true, same: true });
});

check('immediate mode commits non-streaming and partial results directly to the original slot', async (page) => {
  const result = await page.evaluate(() => {
    const root = document.querySelector('#fixture'); root.innerHTML = '<p>Original text.</p>';
    const node = root.firstChild.firstChild;
    const presentation = AT.translationtext.create(document, 'immediate');
    presentation.begin(node);
    const host = node.parentElement;
    node.data = 'Partial translation.';
    presentation.applied(node, false);
    presentation.settled(node, 'partial');
    const partial = { preview: Boolean(host.shadowRoot.querySelector('.preview')),
      state: host.dataset.state, busy: host.hasAttribute('aria-busy'), text: host.textContent };
    presentation.begin(node);
    node.data = 'Final translation.';
    presentation.applied(node, true);
    const final = { preview: Boolean(host.shadowRoot.querySelector('.preview')),
      state: host.dataset.state, busy: host.hasAttribute('aria-busy'), text: host.textContent };
    presentation.restore();
    return { partial, final, same: root.firstChild.firstChild === node };
  });
  assert.deepEqual(result, {
    partial: { preview: false, state: 'partial', busy: false, text: 'Partial translation.' },
    final: { preview: false, state: 'translated', busy: false, text: 'Final translation.' }, same: true
  });
});

check('translated prefix consumes an estimated source prefix in one readable flow', async (page) => {
  await start(page, '<p style="width:300px;font:20px/1.5 system-ui">ABCDEFGHIJKLMNOPQRST</p>');
  const result = await page.evaluate(async () => {
    const host = source.parentElement;
    emit('가');
    const preview = await waitPreview('가');
    const first = preview.textContent;
    const tail = preview.lastChild;
    const changed = preview.lastElementChild;
    const animation = changed.getAnimations()[0];
    animation.pause(); animation.currentTime = 80;
    const incomingOpacity = Number(getComputedStyle(changed).opacity);
    emit('가나');
    await waitPreview('가나');
    const second = preview.textContent;
    const range = document.createRange(); range.selectNodeContents(preview);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    const selected = selection.toString(); selection.removeAllRanges();
    return { first, second, source: source.data, selected, incomingOpacity,
      sameTail: preview.lastChild === tail, tail: tail.data,
      overlay: Boolean(host.shadowRoot.querySelector('.outgoing')),
      position: getComputedStyle(preview).position,
      slot: getComputedStyle(host.shadowRoot.querySelector('slot')).display,
      surfaceOpacity: getComputedStyle(preview.parentElement).opacity };
  });
  assert.deepEqual({ ...result, incomingOpacity: undefined }, {
    first: '가EFGHIJKLMNOPQRST', second: '가나IJKLMNOPQRST',
    source: 'ABCDEFGHIJKLMNOPQRST', selected: '가나IJKLMNOPQRST',
    sameTail: true, tail: 'IJKLMNOPQRST', incomingOpacity: undefined,
    overlay: false, position: 'static', slot: 'none', surfaceOpacity: '1'
  });
  assert.ok(result.incomingOpacity > 0 && result.incomingOpacity < 1);
  await page.evaluate(async () => {
    requests[0].resolve(['번역된 최종 문장.']); await task;
    await new Promise((resolve) => setTimeout(resolve, 220));
  });
  assert.equal(await page.evaluate(() => Boolean(previewElement())), false);
});

check('one surface aurora survives tokens and slow partial pause resume', async (page) => {
  await start(page);
  const result = await page.evaluate(async () => {
    const host = source.parentElement;
    const surface = host.shadowRoot.querySelector('.surface');
    const aurora = surface.getAnimations()[0];
    const before = aurora.currentTime;
    emit('첫 번역'); await waitPreview('첫 번역');
    emit('첫 번역 다음'); await waitPreview('첫 번역 다음');
    const during = surface.getAnimations()[0];
    source.data = '첫 번역 다음';
    presentation.applied(source, false);
    presentation.settled(source, 'partial');
    await new Promise((resolve) => setTimeout(resolve, 50));
    presentation.begin(source);
    const continued = surface.getAnimations()[0];
    const busy = host.getAttribute('aria-busy');
    const advanced = continued.currentTime > before;
    presentation.settled(source, 'partial');
    await new Promise((resolve) => setTimeout(resolve, 240));
    const parked = surface.getAnimations()[0];
    const parkedTime = parked.currentTime;
    const parkedState = host.getAttribute('data-state');
    const parkedBusy = host.hasAttribute('aria-busy');
    const parkedPlayState = parked.playState;
    const parkedPaint = getComputedStyle(surface);
    const parkedUndecorated = parkedPaint.backgroundImage === 'none' && parkedPaint.boxShadow === 'none';
    await new Promise((resolve) => setTimeout(resolve, 100));
    const stillTime = parked.currentTime;
    presentation.begin(source);
    const resumed = surface.getAnimations()[0];
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const resumedPaint = getComputedStyle(surface);
    const resumedDecorated = resumedPaint.backgroundImage !== 'none';
    const result = { sameSurface: surface === host.shadowRoot.querySelector('.surface'),
      sameAnimation: aurora === during && aurora === continued && aurora === parked && aurora === resumed,
      advanced, busy, parked: parkedState, parkedBusy, parkedPlayState, parkedUndecorated, resumedDecorated,
      frozen: Math.abs(stillTime - parkedTime) < 1, resumed: resumed.currentTime > stillTime,
      text: source.data };
    translator.restore();
    requests[0].resolve(['late']); await task;
    return result;
  });
  assert.deepEqual(result, { sameSurface: true, sameAnimation: true, advanced: true,
    busy: 'true', parked: 'partial', parkedBusy: false, parkedPlayState: 'paused',
    frozen: true, resumed: true, parkedUndecorated: true, resumedDecorated: true, text: '첫 번역 다음' });
});

check('canonical measurement restores nested previews and animation after exceptions', async (page) => {
  await start(page);
  const result = await page.evaluate(async () => {
    emit('번역'); const preview = await waitPreview('번역');
    const host = source.parentElement;
    const surface = host.shadowRoot.querySelector('.surface');
    const aurora = surface.getAnimations()[0];
    const fade = preview.lastElementChild.getAnimations()[0];
    let width = 0, nested = false, failure = '';
    try {
      presentation.measureSource(source, () => {
        presentation.measureSource(source, () => {
          const range = document.createRange(); range.selectNodeContents(source);
          width = range.getBoundingClientRect().width;
        });
        nested = host.hasAttribute('data-measuring');
        throw new Error('measurement failed');
      });
    } catch (error) { failure = error.message; }
    const result = { readable: width > 0, nested, failure,
      restored: !host.hasAttribute('data-measuring'),
      slotHidden: getComputedStyle(host.shadowRoot.querySelector('slot')).display === 'none',
      sameAurora: surface.getAnimations()[0] === aurora,
      sameFade: preview.lastElementChild.getAnimations()[0] === fade,
      source: source.data };
    requests[0].resolve(['번역']); await task;
    return result;
  });
  assert.deepEqual(result, { readable: true, nested: true, failure: 'measurement failed',
    restored: true, slotHidden: true, sameAurora: true, sameFade: true, source: 'Original source sentence.' });
});

check('nonstreamed completion reveals without a duplicate source overlay', async (page) => {
  await start(page);
  const result = await page.evaluate(async () => {
    requests[0].resolve(['완료된 번역']); await task;
    const host = source.parentElement;
    const preview = previewElement();
    const result = { canonical: source.data, preview: preview?.textContent,
      outgoing: host.shadowRoot.querySelector('.outgoing')?.textContent,
      same: host.firstChild === source, opacity: getComputedStyle(preview.parentElement).opacity };
    await new Promise((resolve) => setTimeout(resolve, 220));
    return { ...result, handedOff: !previewElement(),
      slotVisible: getComputedStyle(host.shadowRoot.querySelector('slot')).display !== 'none' };
  });
  assert.deepEqual(result, { canonical: '완료된 번역', preview: '완료된 번역',
    outgoing: undefined, same: true, opacity: '1', handedOff: true, slotVisible: true });
});

check('final correction retains the opaque translated prefix', async (page) => {
  await start(page);
  const result = await page.evaluate(async () => {
    emit('유지되는 접두사 '); const preview = await waitPreview('유지되는 접두사 ');
    await new Promise((resolve) => setTimeout(resolve, 220));
    emit('유지되는 접두사 임시');
    await waitPreview('유지되는 접두사 임시');
    const stable = preview.firstChild;
    requests[0].resolve(['유지되는 접두사 최종']); await task;
    const result = { canonical: source.data, preview: preview.textContent,
      stable: stable.data, sameStable: preview.firstChild === stable,
      previewOpacity: getComputedStyle(preview).opacity,
      outgoing: source.parentElement.shadowRoot.querySelector('.outgoing')?.textContent };
    await new Promise((resolve) => setTimeout(resolve, 220));
    return { ...result, handedOff: !previewElement() };
  });
  assert.deepEqual(result, { canonical: '유지되는 접두사 최종', preview: '유지되는 접두사 최종',
    stable: '유지되는 접두사 ', sameStable: true, previewOpacity: '1', outgoing: undefined, handedOff: true });
});

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
      tail: preview.lastChild.data,
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
  assert.equal(fade.selected, '번역된 문장' + fade.tail);
  assert.ok(fade.tail.length > 0 && fade.source.endsWith(fade.tail));
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
    const finalPreview = previewElement()?.textContent;
    const outgoing = source.parentElement.shadowRoot.querySelector('.outgoing');
    const finalOutgoing = outgoing?.textContent;
    await new Promise((resolve) => setTimeout(resolve, 220));
    const host = source.parentElement;
    link.click();
    const result = { source: source.data, same: host.firstChild === source,
      sameLink: document.querySelector('#fixture a') === link, clicks,
      finalPreview, finalOutgoing,
      preview: Boolean(previewElement()), reveal: host.hasAttribute('data-reveal'),
      slot: getComputedStyle(host.shadowRoot.querySelector('slot')).display !== 'none' };
    translator.restore();
    return { ...result, restored: document.querySelector('#fixture').innerHTML === originalHTML,
      direct: link.firstChild === source };
  }), { source: '정확한 최종 번역.', same: true, sameLink: true, clicks: 1,
    finalPreview: '정확한 최종 번역.', finalOutgoing: undefined,
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
      tail: preview.lastChild.data,
      source: source.data, running: animations.length,
      surfaceAnimations: preview.parentElement.getAnimations().length, completed: translator.stats().translated };
    requests[0].resolve(['완료된 번역']); await task;
    return result;
  });
  assert.ok(result.peakSpans <= 5, JSON.stringify(result));
  assert.ok(result.peakAnimations <= 6, JSON.stringify(result));
  assert.ok(result.peakElements <= 10, JSON.stringify(result));
  assert.equal(result.corrected, '안정적인 접두사 수정된 결과' + result.tail);
  assert.ok(result.tail.length > 0 && result.source.endsWith(result.tail));
  assert.equal(result.source, 'Original source sentence.');
  assert.equal(result.running, 0, 'settled translated regions do not animate');
  assert.equal(result.surfaceAnimations, 1, 'only the persistent surface aurora remains');
  assert.equal(result.completed, 0, 'preview is not counted as a completed translation');
});

for (const mode of ['aurora', 'immediate']) {
check(`${mode}: empty progress failure and restore cancel previews`, async (page) => {
  await start(page, undefined, 0, mode);
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

  await start(page, undefined, 0, mode);
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

check(`${mode}: page edits and detach immediately remove stale previews without resurrection`, async (page) => {
  for (const kind of ['characterData', 'replace', 'append', 'move', 'detach']) {
    await start(page, undefined, 0, mode);
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
}

for (const media of [{ reducedMotion: 'reduce' }, { forcedColors: 'active' }]) {
  check(`streaming respects ${Object.keys(media)[0]} with readable selectable text`, async (page) => {
    await page.emulateMedia(media);
    await start(page);
    const result = await page.evaluate(async () => {
      emit('접근 가능한 번역');
      const preview = await waitPreview('접근 가능한 번역');
      const range = document.createRange(); range.selectNodeContents(preview);
      const result = { text: preview.textContent, tail: preview.lastChild.data,
        opacity: getComputedStyle(preview.lastElementChild).opacity,
        animations: preview.getAnimations({ subtree: true }).length,
        readable: [...range.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0),
        source: source.data, slotHidden: getComputedStyle(source.parentElement.shadowRoot.querySelector('slot')).display === 'none' };
      requests[0].resolve(['접근 가능한 최종 번역']); await task;
      translator.restore();
      return result;
    });
    assert.ok(result.tail.length > 0 && result.source.endsWith(result.tail));
    assert.deepEqual(result, { text: '접근 가능한 번역' + result.tail, tail: result.tail,
      opacity: '1', animations: 0, readable: true, source: 'Original source sentence.', slotHidden: true });
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
      await new Promise((resolve) => setTimeout(resolve, 240));
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

check('inline previews preserve clipping while translating the full hidden source', async (page) => {
  await start(page, '<p style="font:16px/24px monospace;white-space:pre-wrap;height:24px;overflow:hidden;width:500px">Visible first source line.\nHidden source line that must not be consumed.\nAnother hidden source line.</p>');
  const result = await page.evaluate(async () => {
    const sent = requests[0].texts[0];
    emit('보이는 첫 문장.');
    const preview = await waitPreview('보이는 첫 문장.', true);
    await new Promise((resolve) => setTimeout(resolve, 220));
    const host = source.parentElement;
    const paragraph = document.querySelector('#fixture p');
    const range = document.createRange(); range.selectNodeContents(preview);
    const bounds = paragraph.getBoundingClientRect();
    const inline = getComputedStyle(host).display === 'inline' &&
      getComputedStyle(preview).display === 'inline' &&
      getComputedStyle(preview).position === 'static';
    const withinLine = [...range.getClientRects()].every((rect) =>
      rect.left >= bounds.left && rect.right <= bounds.right && rect.height <= 24);
    const translation = '보이는 첫 문장.\n숨겨진 문장도 번역합니다.\n마지막 숨겨진 문장입니다.';
    requests[0].resolve([translation]); await task;
    await new Promise((resolve) => setTimeout(resolve, 220));
    const result = { sent, inline, withinLine, same: paragraph.contains(source),
      hiddenTranslated: source.data === translation,
      clippingPreserved: paragraph.clientHeight === 24 && getComputedStyle(paragraph).overflow === 'hidden' };
    translator.restore();
    return { ...result, restored: document.querySelector('#fixture').innerHTML === originalHTML };
  });
  assert.equal(result.sent, 'Visible first source line.\nHidden source line that must not be consumed.\nAnother hidden source line.');
  assert.equal(result.inline, true);
  assert.equal(result.withinLine, true);
  assert.equal(result.same, true);
  assert.equal(result.hiddenTranslated, true);
  assert.equal(result.clippingPreserved, true);
  assert.equal(result.restored, true);
});

check('long wrapped technical paragraph retains an opaque source suffix midstream', async (page) => {
  await start(page, '<article style="width:620px;font:18px/1.6 Georgia"><p>The attention mechanism relates positions in a single sequence to compute a representation of that sequence. This technical paragraph deliberately spans several lines, as an article on arXiv does, while the model has produced only a short translated prefix. Untranslated details, equations described in prose, and the remaining explanation must stay visible until completion.</p></article>');
  const result = await page.evaluate(async () => {
    emit('어텐션 메커니즘은');
    const preview = await waitPreview('어텐션 메커니즘은');
    const tail = preview.lastChild;
    const firstTail = tail.data;
    await new Promise((resolve) => setTimeout(resolve, 220));
    emit('어텐션 메커니즘은 단일 시퀀스의 위치를');
    await waitPreview('어텐션 메커니즘은 단일 시퀀스의 위치를');
    const stable = preview.firstChild;
    const range = document.createRange(); range.selectNodeContents(tail);
    const rects = [...range.getClientRects()];
    return { firstTail, tail: tail.data, source: source.data,
      sameTail: preview.lastChild === tail, stable: stable.data,
      tailIsText: tail.nodeType === Node.TEXT_NODE,
      tailOpacity: getComputedStyle(tail.parentElement).opacity,
      lines: new Set(rects.map((rect) => Math.round(rect.top))).size,
      inline: getComputedStyle(preview).position === 'static',
      overlays: source.parentElement.shadowRoot.querySelectorAll('.outgoing, [data-source-transition]').length };
  });
  assert.equal(result.sameTail, true);
  assert.equal(result.tailIsText, true);
  assert.equal(result.tailOpacity, '1');
  assert.ok(result.firstTail.length > result.tail.length && result.tail.length > 0);
  assert.ok(result.source.endsWith(result.tail));
  assert.equal(result.stable, '어텐션 메커니즘은');
  assert.ok(result.lines >= 3, JSON.stringify(result));
  assert.equal(result.inline, true);
  assert.equal(result.overlays, 0);
  await screenshot(page, 'streaming-technical-paragraph-progressive-tail');
  await page.evaluate(async () => {
    requests[0].resolve(['어텐션 메커니즘에 관한 완성된 기술 문단입니다.']); await task;
    translator.restore();
  });
});

check('bounded streaming resumes after a long pause without repainting committed prefix', async (page) => {
  await start(page, '<p>First source phrase. Second source phrase. Third source phrase.</p>', 22);
  const result = await page.evaluate(async () => {
    emit('첫 번역');
    const firstPreview = await waitPreview('첫 번역');
    const stableNode = firstPreview.firstChild;
    const tailNode = firstPreview.lastChild;
    const host = source.parentElement;
    const surface = host.shadowRoot.querySelector('.surface');
    const aurora = surface.getAnimations()[0];
    requests[0].resolve(['첫 문장.']);
    const first = await task;
    await new Promise((resolve) => setTimeout(resolve, 350));
    const committed = source.data;
    const phase = aurora.currentTime;
    const paused = aurora.playState;
    window.task = translator.translateNodes(first.pending);
    const frame = Promise.withResolvers();
    requestAnimationFrame(frame.resolve);
    await frame.promise;
    requests[1].progress(0, '두 번째');
    const preview = await waitPreview('첫 문장. 두 번째');
    const result = { committed, paused, sameHost: source.parentElement === host,
      sameAnimation: surface.getAnimations()[0] === aurora,
      samePreview: preview === firstPreview, sameStable: preview.firstChild === stableNode,
      sameTail: preview.lastChild === tailNode,
      advanced: aurora.currentTime >= phase, stable: preview.firstChild.data,
      stableOpacity: getComputedStyle(preview).opacity, shown: preview.textContent,
      suffix: preview.lastChild.data };
    requests[1].resolve(['둘째 문장.']); await task;
    translator.restore();
    return { ...result, restored: document.querySelector('#fixture').innerHTML === originalHTML };
  });
  assert.equal(result.paused, 'paused');
  assert.equal(result.sameHost, true);
  assert.equal(result.sameAnimation, true);
  assert.equal(result.samePreview, true);
  assert.equal(result.sameStable, true);
  assert.equal(result.sameTail, true);
  assert.equal(result.advanced, true);
  assert.equal(result.stable, '첫 문장. ');
  assert.equal(result.stableOpacity, '1');
  assert.ok(result.shown.startsWith('첫 문장. 두 번째'));
  assert.ok(result.suffix.endsWith(' Third source phrase.'));
  assert.equal(result.restored, true);
});

check('Firefox without Segmenter keeps multilingual clusters whole while streaming', async (page) => {
  await start(page, '<p>ABCDé👩🏽‍💻🇰🇷가क्ष中文مرحباWXYZ</p>');
  const result = await page.evaluate(async () => {
    const boundaries = new Set([...referenceSegmenter.segment(original)].map(({ index }) => index));
    let previous = 0;
    const samples = [];
    for (const decoded of ['가', '가나', '가나다', '가']) {
      const previousText = previewElement()?.textContent;
      emit(decoded);
      while (previewElement()?.textContent === previousText) {
        const frame = Promise.withResolvers();
        requestAnimationFrame(frame.resolve);
        await frame.promise;
      }
      const preview = await waitPreview(decoded);
      const tail = preview.textContent.slice(decoded.length);
      const consumed = original.length - tail.length;
      samples.push({ whole: boundaries.has(consumed), tail: tail.length > 0 && original.endsWith(tail),
        monotonic: consumed >= previous });
      previous = consumed;
    }
    requests[0].resolve(['완성된 번역']); await task;
    translator.restore();
    return { samples, restored: document.querySelector('#fixture').innerHTML === originalHTML };
  });
  assert.equal(result.restored, true);
  assert.deepEqual(result.samples, Array.from({ length: 4 }, () => ({ whole: true, tail: true, monotonic: true })));
}, true);

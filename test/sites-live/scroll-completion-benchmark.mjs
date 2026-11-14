// Installed-extension, Japanese-only completion benchmark (not part of CI).
// SCROLL_COMPLETION_BENCH=1 SCROLL_LABEL=baseline|candidate SCROLL_ROUNDS=3
// MODEL_DIR=... EXTENSION_DIR=... QA_DIR=... node test/sites-live/run-sites.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { CORPUS } from './chunk-benchmark.mjs';
import { prepareTabEnabledUI, clickPreparedTabEnabledUI, setTabEnabledUI, tabIdFor } from '../native-extension/tab-control.mjs';

const VIEWPORT = { width: 1440, height: 1600 };
const japanese = id => CORPUS.find(unit => unit.id === id && unit.source === 'ja').text;
const comment = japanese('japanese-comment');
const article = japanese('japanese-article');
const extended = japanese('extended-japanese');
const tail = extended.slice(article.length);
const split = tail.indexOf('。', Math.floor(tail.length / 2)) + 1;
const SCENARIOS = [
  { id: 'mixed-short-long', units: [
    { id: 'short-comment', role: 'comment', text: comment.slice(0, comment.indexOf('。') + 1), height: 100 },
    { id: 'long-paragraph', role: 'article', text: extended, height: 800 }
  ] },
  { id: 'four-reading-units', units: [
    { id: 'comment', role: 'comment', text: comment, height: 200 },
    { id: 'article', role: 'article', text: article, height: 360 },
    { id: 'continuation-a', role: 'article', text: tail.slice(0, split), height: 300 },
    { id: 'continuation-b', role: 'article', text: tail.slice(split), height: 300 }
  ] }
];
const CSS = `html{overflow-anchor:none;scroll-behavior:auto}body{margin:0;font:20px/30px sans-serif;background:#fff;color:#111}.spacer{height:${VIEWPORT.height * 4}px}main{width:1280px;margin:0 auto;padding:24px 0}p{box-sizing:border-box;margin:0 0 20px;padding:8px;border:1px solid #ddd;overflow:visible}`;
const digest = value => createHash('sha256').update(value).digest('hex');
const errorText = error => error?.stack || String(error);
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length ? (sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2) : null;
};

// Only page DOM observation: completion is canonical light-DOM text AND every
// presentation host committed, not preview text or the later 160ms reveal fade.
function observePage() {
  const now = () => performance.timeOrigin + performance.now();
  const geometry = element => {
    const r = element.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, documentY: r.y + scrollY,
      contentFitsBox: element.scrollHeight <= element.clientHeight,
      fullyVisible: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth };
  };
  const targets = [...document.querySelectorAll('main p')].map(p => ({
    id: p.id, source: p.textContent, initialGeometry: geometry(p), completedAt: null,
    completedAtPage: null, firstPreviewAt: null, finalText: null, states: [], complete: false
  }));
  const evidence = { timeOrigin: performance.timeOrigin, targets, scrolls: [], firstPreviewAt: null, observedAt: now() };
  const scan = () => {
    const atPage = performance.now(), at = performance.timeOrigin + atPage;
    for (const target of targets) {
      const p = document.getElementById(target.id);
      const hosts = [...p.querySelectorAll('at-translation-text')];
      const states = hosts.map(host => host.dataset.state);
      const preview = hosts.map(host => host.shadowRoot?.querySelector('.preview')?.textContent || '').join('');
      if (preview && hosts.some(host => host.dataset.streaming === 'true')) {
        target.firstPreviewAt ??= at;
        evidence.firstPreviewAt ??= at;
      }
      target.states = states;
      target.complete = hosts.length > 0 && states.every(state => state === 'translated') &&
        !p.querySelector('[aria-busy="true"]') && p.textContent !== target.source && /[가-힣]/u.test(p.textContent);
      if (target.complete) { target.completedAt ??= at; target.completedAtPage ??= atPage; target.finalText = p.textContent; }
      target.currentText = p.textContent;
    }
  };
  const observer = new MutationObserver(scan);
  observer.observe(document.querySelector('main'), { subtree: true, childList: true, characterData: true, attributes: true });
  const timer = setInterval(scan, 16); // Shadow preview only; mutations timestamp final commits.
  const onScroll = event => {
    scan();
    // Chrome event.timeStamp is relative to the document's monotonic time origin.
    const at = performance.timeOrigin + event.timeStamp;
    evidence.scrolls.push({ at, atPage: event.timeStamp, observedAt: now(), y: scrollY,
      completedIds: targets.filter(target => target.complete).map(target => target.id),
      geometry: targets.map(target => ({ id: target.id, ...geometry(document.getElementById(target.id)) })) });
  };
  addEventListener('scroll', onScroll, { passive: true });
  globalThis.__scrollCompletion = {
    evidence, scan,
    snapshot: () => { scan(); return { ...evidence, geometry: targets.map(target => ({ id: target.id, ...geometry(document.getElementById(target.id)) })), capturedAt: now() }; },
    stop: () => { clearInterval(timer); observer.disconnect(); removeEventListener('scroll', onScroll); }
  };
}

async function scrollToRegion(page, destination) {
  const start = await page.evaluate(() => globalThis.__scrollCompletion.evidence.scrolls.length);
  await page.evaluate(async destination => {
    const end = destination === 'targets' ? document.querySelector('main').offsetTop :
      destination === 'above' ? 0 : document.querySelector('main').offsetTop + document.querySelector('main').offsetHeight + 200;
    const from = scrollY;
    for (let step = 1; step <= 10; step++) {
      scrollTo(0, Math.round(from + (end - from) * step / 10));
      await new Promise(resolve => setTimeout(resolve, 35));
    }
  }, destination);
  // Confirmation does not move t0: the actual last event timestamp is retained.
  await page.waitForFunction(start => {
    const events = globalThis.__scrollCompletion.evidence.scrolls;
    return events.length > start && performance.timeOrigin + performance.now() - events.at(-1).at >= 100;
  }, start, { timeout: 10000 });
  return page.evaluate(start => {
    const snapshot = globalThis.__scrollCompletion.snapshot();
    return { firstScrollAt: snapshot.scrolls[start].at, lastScrollAt: snapshot.scrolls.at(-1).at,
      lastScrollAtPage: snapshot.scrolls.at(-1).atPage,
      confirmedAt: snapshot.capturedAt, scrolls: snapshot.scrolls.slice(start), geometryAtRest: snapshot.geometry,
      cohortAtRest: snapshot.targets.map(target => ({ id: target.id, source: target.source,
        completedAt: target.completedAt, complete: target.complete,
        geometry: snapshot.geometry.find(rect => rect.id === target.id) })) };
  }, start);
}

function hostSlice(calls, startIndex, scroll) {
  const selected = calls.slice(startIndex);
  const generations = selected.filter(call => call.generation);
  const events = generations.flatMap(call => [{ at: call.startedAt, delta: 1 },
    ...(call.endedAt === null ? [] : [{ at: call.endedAt, delta: -1 }])]).sort((a, b) => a.at - b.at || a.delta - b.delta);
  let active = 0, maxActive = 0;
  for (const event of events) { active += event.delta; maxActive = Math.max(maxActive, active); }
  return { calls: selected, maxActive,
    requestsBeforeFirstScroll: scroll ? selected.filter(call => call.startedAt < scroll.firstScrollAt).map(call => call.id) : [],
    requestsBeforeLastScroll: scroll ? selected.filter(call => call.startedAt < scroll.lastScrollAt).map(call => call.id) : [],
    generationsInFlightAtLastScroll: scroll ? generations.filter(call => call.startedAt <= scroll.lastScrollAt &&
      (call.endedAt === null || call.endedAt > scroll.lastScrollAt)).map(call => call.id) : [] };
}

export async function runScrollCompletionBenchmark({ context, options, worker, output, extension }) {
  const label = process.env.SCROLL_LABEL || 'candidate';
  const rounds = Number(process.env.SCROLL_ROUNDS || 3);
  const timeoutMs = Number(process.env.SCROLL_TIMEOUT_MS || 240000);
  assert.ok(['baseline', 'candidate'].includes(label), 'SCROLL_LABEL must be baseline or candidate');
  assert.ok(Number.isInteger(rounds) && rounds > 0, 'SCROLL_ROUNDS must be a positive integer');
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0, 'SCROLL_TIMEOUT_MS must be positive');
  const reportPath = join(output, `scroll-completion-${label}.json`);
  const report = { schemaVersion: 1, label, startedAt: new Date().toISOString(), rounds, timeoutMs,
    metric: 'last actual scroll event to ALL eligible visible-at-rest paragraphs committed in final light-DOM text',
    clock: 'page monotonic completion minus last scroll event.timeStamp; epoch performance.timeOrigin + performance.now() only for cross-context host correlation',
    viewport: VIEWPORT, fixtureHash: digest(JSON.stringify({ SCENARIOS, CSS, VIEWPORT })), scenarios: SCENARIOS,
    limits: ['Fixed Japanese sources from chunk-benchmark CORPUS, not an English corpus or public-site SLO.',
      'Final timestamps use MutationObserver delivery; shadow previews are sampled every 16ms.',
      'No screenshots during primary timing; streaming screenshot uses the separate cancellation replay.',
      'Median and maximum only; failed/incomplete cohorts remain in the denominator; no estimated p95.',
      'Revisits measure retained DOM/cache separately, never mixed into fresh-page completion samples.'],
    installedFiles: {}, runs: [], cancellation: null, errors: [] };
  const pages = new Set();
  let wrapped = false;
  const persist = () => writeFile(reportPath, JSON.stringify(report, null, 2));
  const server = createServer((request, response) => {
    const scenario = SCENARIOS.find(item => new URL(request.url, 'http://fixture').pathname === `/${item.id}`);
    if (!scenario) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(`<!doctype html><html lang="ja"><meta charset="utf-8"><title>図書館の案内</title><style>${CSS}</style><div class="spacer" aria-hidden="true"></div><main>${scenario.units.map(unit => `<p id="${unit.id}" class="${unit.role}" style="height:${unit.height}px">${unit.text}</p>`).join('')}</main><div class="spacer" aria-hidden="true"></div></html>`);
  });
  const calls = () => worker.evaluate(() => globalThis.__scrollHost.calls);
  const waitIdle = () => options.waitForFunction(async () => {
    const reply = await AT.sendMessage({ type: AT.C.MSG.LOCAL_GET_STATUS });
    return reply.ok && reply.status?.state === 'ready';
  }, null, { timeout: timeoutMs });
  const exactRestore = page => page.waitForFunction(() => {
    const targets = globalThis.__scrollCompletion.evidence.targets;
    return targets.every(target => document.getElementById(target.id).textContent === target.source) &&
      !document.querySelector('at-translation-text');
  }, null, { timeout: 15000 });
  async function openFixture(scenario, suffix) {
    const page = await context.newPage();
    pages.add(page);
    await page.setViewportSize(VIEWPORT);
    await page.goto(`${report.origin}/${scenario.id}?run=${suffix}`);
    await page.evaluate(observePage);
    const tabId = await tabIdFor(options, page);
    await prepareTabEnabledUI(options, tabId);
    return { page, tabId };
  }
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    report.origin = `http://127.0.0.1:${server.address().port}`;
    for (const name of ['manifest.json', 'background.js', 'content.js', 'lib/pipeline.js', 'lib/engines.js', 'lib/engine.js',
      'lib/dom.js', 'lib/translationtext.js', 'lib/onnxhost.js', 'lib/kernels.js', 'lib/kernelmatmul.js', 'lib/kernelattention.js', 'hostworker.js']) {
      report.installedFiles[name] = digest(await readFile(join(extension, name)));
    }
    report.extensionDirectory = extension;
    report.extensionSource = process.env.EXTENSION_DIR || 'build/chrome';
    report.browser = { version: context.browser()?.version() ?? null, executable: process.env.CHROMIUM_EXECUTABLE || 'playwright chromium',
      headless: process.env.HEADLESS === '1', unsafeWebGPU: process.env.UNSAFE_WEBGPU !== '0', platform: process.platform,
      userAgent: await options.evaluate(() => navigator.userAgent) };
    await options.evaluate(() => AT.settings.save({ sourceLang: 'ja', targetLang: 'ko', debug: false }));
    await options.reload();
    await options.waitForFunction(() => document.body.dataset.ready === 'true');
    const requestedWidth = Number(process.env.TRANSLATION_CONCURRENCY || 2);
    assert.ok([1, 2, 4, 8].includes(requestedWidth));
    const control = options.locator('#parallelTranslation');
    if (await control.evaluate(element => element.tagName === 'SELECT')) {
      await control.selectOption(String(requestedWidth));
    } else {
      assert.ok(requestedWidth <= 2, 'frozen checkbox baseline supports only one/two');
      await control.setChecked(requestedWidth === 2);
    }
    await options.locator('#save').click();
    await options.waitForFunction(width => AT.settings.load().then(settings => settings.translationConcurrency === width), requestedWidth);
    report.settings = await options.evaluate(() => AT.settings.load());
    report.prepared = await options.evaluate(maxTokens => AT.sendMessage({ type: AT.C.MSG.LOCAL_PREPARE, target: 'ko', maxTokens }), report.settings.localMaxTokens);
    assert.equal(report.prepared.ok, true, report.prepared.error);
    report.warmup = await worker.evaluate(async settings => {
      const startedAt = performance.timeOrigin + performance.now();
      const result = await AT.engines.translate({ texts: ['図書館は明日から開館します。'], source: 'ja', target: 'ko',
        localModelId: settings.localModelId, localMaxTokens: settings.localMaxTokens });
      return { startedAt, endedAt: performance.timeOrigin + performance.now(), result };
    }, report.settings);
    assert.ok(report.warmup.result.translations?.every(text => /[가-힣]/u.test(text)), 'Japanese warmup must produce Korean');
    await waitIdle();
    await worker.evaluate(() => {
      const original = AT.local.callHost;
      const clock = () => performance.timeOrigin + performance.now();
      const evidence = globalThis.__scrollHost = { calls: [], active: 0, maxActive: 0 };
      globalThis.__restoreScrollHost = () => { AT.local.callHost = original; };
      AT.local.callHost = async function(message, progress, signal) {
        const generation = message.type === AT.C.MSG.LOCAL_TRANSLATE;
        const entry = { id: evidence.calls.length, generation, type: message.type, texts: message.texts,
          modelId: message.modelId, source: message.source, target: message.target, maxTokens: message.maxTokens,
          startedAt: clock(), endedAt: null, previews: [], result: null, error: null };
        evidence.calls.push(entry);
        if (generation) evidence.maxActive = Math.max(evidence.maxActive, ++evidence.active);
        try {
          const result = await original.call(this, message, progress ? (index, text) => {
            entry.previews.push({ at: clock(), index, text });
            progress(index, text);
          } : progress, signal);
          entry.result = result;
          if (result?.ok === false) entry.error = String(result.error || result.code || 'host returned ok=false');
          return result;
        } catch (error) { entry.error = String(error?.stack || error); throw error; }
        finally { entry.endedAt = clock(); if (generation) evidence.active--; }
      };
    });
    wrapped = true;
    for (let round = 1; round <= rounds; round++) for (const scenario of SCENARIOS) {
      const run = { round, scenario: scenario.id, expectedTargets: scenario.units.length,
        status: 'failed', completionMs: null, errors: [], revisits: [], screenshots: {} };
      report.runs.push(run);
      let page, tabId;
      const startIndex = (await calls()).length;
      const stem = `scroll-${label}-${scenario.id}-${round}`;
      try {
        ({ page, tabId } = await openFixture(scenario, `${label}-${round}`));
        page.on('pageerror', error => run.errors.push(errorText(error)));
        run.beforeEnable = await page.evaluate(() => globalThis.__scrollCompletion.snapshot());
        assert.ok(run.beforeEnable.geometry.every(rect => !rect.fullyVisible && rect.y >= VIEWPORT.height), 'targets begin below the fold');
        await clickPreparedTabEnabledUI(options, tabId, true);
        await page.bringToFront();
        run.beforeScroll = await page.evaluate(() => globalThis.__scrollCompletion.snapshot());
        run.scroll = await scrollToRegion(page, 'targets');
        assert.ok(run.scroll.geometryAtRest.every(rect => rect.fullyVisible && rect.contentFitsBox), 'entire fixed cohort must be visible at rest');
        await page.waitForFunction(() => globalThis.__scrollCompletion.evidence.targets.every(target => target.complete), null, { timeout: timeoutMs });
        run.dom = await page.evaluate(() => globalThis.__scrollCompletion.snapshot());
        assert.ok(run.dom.geometry.every(rect => rect.fullyVisible && rect.contentFitsBox), 'Korean final text must also fit fully in the viewport');
        run.precompletedBeforeFirstScroll = run.dom.targets.filter(target => target.completedAt < run.scroll.firstScrollAt).map(target => target.id);
        run.precompletedAtLastScroll = run.dom.targets.filter(target => target.completedAt <= run.scroll.lastScrollAt).map(target => target.id);
        for (const target of run.dom.targets) target.completionMs = target.completedAtPage - run.scroll.lastScrollAtPage;
        run.completionMs = Math.max(...run.dom.targets.map(target => target.completionMs));
        assert.equal(run.precompletedAtLastScroll.length, 0, 'controlled fresh comparison rejects any precompleted cohort target');
        run.host = hostSlice(await calls(), startIndex, run.scroll);
        assert.ok(run.host.calls.some(call => call.generation), 'fresh cohort must execute actual host generations');
        assert.ok(run.host.calls.every(call => !call.error), 'host failures remain run failures');
        assert.ok(run.host.maxActive <= report.settings.translationConcurrency, 'actual host generation concurrency must respect the page setting');
        run.screenshots.final = `${stem}-final.png`;
        await page.screenshot({ path: join(output, run.screenshots.final) });
        // One round-trip in each direction, only on round one; never primary samples.
        for (const [direction, away] of (round === 1 ? [['up', 'below'], ['down', 'above']] : [])) {
          const revisitStart = (await calls()).length;
          const departure = await scrollToRegion(page, away);
          const returned = await scrollToRegion(page, 'targets');
          const dom = await page.evaluate(() => globalThis.__scrollCompletion.snapshot());
          const revisit = { direction, kind: 'retained-dom/cache', departure, scroll: returned, dom,
            completionMs: dom.targets.every(target => target.complete) ? Math.max(0, Math.max(...dom.targets.map(target => target.completedAt)) - returned.lastScrollAt) : null,
            host: hostSlice(await calls(), revisitStart, returned) };
          run.revisits.push(revisit);
          assert.ok(dom.targets.every(target => target.complete), 'revisit must retain every completed target');
          assert.ok(returned.geometryAtRest.every(rect => rect.fullyVisible), 'revisit cohort remains fully visible');
          assert.equal(revisit.host.calls.filter(call => call.generation).length, 0, 'retained/cache revisit must not regenerate');
        }
        await setTabEnabledUI(options, tabId, false);
        await exactRestore(page);
        run.exactRestore = true;
        run.status = run.errors.length ? 'failed' : 'passed';
      } catch (error) { run.errors.push(errorText(error)); }
      finally {
        if (page && !page.isClosed()) {
          run.lastObservation = await page.evaluate(() => globalThis.__scrollCompletion.snapshot()).catch(error => ({ error: errorText(error) }));
          run.dom ??= run.lastObservation;
          if (!run.screenshots.final) {
            run.screenshots.final = `${stem}-final.png`;
            await page.screenshot({ path: join(output, run.screenshots.final) }).catch(error => run.errors.push(errorText(error)));
          }
          if (tabId !== undefined) await setTabEnabledUI(options, tabId, false).catch(error => run.errors.push(errorText(error)));
          await page.evaluate(() => globalThis.__scrollCompletion.stop()).catch(() => {});
          await page.close(); pages.delete(page);
        }
        await waitIdle().catch(error => run.errors.push(errorText(error)));
        run.host ??= hostSlice(await calls(), startIndex, run.scroll);
        if (run.scroll && run.dom?.targets) {
          run.precompletedBeforeFirstScroll ??= run.dom.targets.filter(target => target.completedAt !== null && target.completedAt < run.scroll.firstScrollAt).map(target => target.id);
          run.precompletedAtLastScroll ??= run.dom.targets.filter(target => target.completedAt !== null && target.completedAt <= run.scroll.lastScrollAt).map(target => target.id);
          for (const target of run.dom.targets) target.completionMs = target.completedAtPage === null ? null : target.completedAtPage - run.scroll.lastScrollAtPage;
        }
        run.incompleteTargetIds = scenario.units.filter(unit => !run.dom?.targets?.find(target => target.id === unit.id)?.completedAt).map(unit => unit.id);
        if (run.errors.length || run.incompleteTargetIds.length) run.status = 'failed';
        await persist();
        console.log('[scroll-completion]', label, scenario.id, round, run.status, run.completionMs);
      }
    }
    const cancellation = report.cancellation = { status: 'failed', errors: [] };
    let page, tabId;
    const cancelStart = (await calls()).length;
    try {
      ({ page, tabId } = await openFixture(SCENARIOS[0], `${label}-cancel`));
      await clickPreparedTabEnabledUI(options, tabId, true);
      await page.bringToFront();
      cancellation.scroll = await scrollToRegion(page, 'targets');
      await page.waitForSelector('at-translation-text[data-state="translating"][data-streaming="true"]', { timeout: timeoutMs });
      cancellation.before = await page.evaluate(() => globalThis.__scrollCompletion.snapshot());
      cancellation.screenshots = { streaming: `scroll-${label}-cancel-streaming.png`, restored: `scroll-${label}-cancel-restored.png` };
      await page.screenshot({ path: join(output, `scroll-${label}-cancel-streaming.png`) });
      await setTabEnabledUI(options, tabId, false);
      await exactRestore(page);
      await waitIdle();
      // Check again after all in-flight work has settled: no late overwrite.
      await exactRestore(page);
      cancellation.after = await page.evaluate(() => globalThis.__scrollCompletion.snapshot());
      cancellation.host = hostSlice(await calls(), cancelStart, cancellation.scroll);
      cancellation.exactRestore = true;
      cancellation.status = 'passed';
      await page.screenshot({ path: join(output, `scroll-${label}-cancel-restored.png`) });
    } catch (error) { cancellation.errors.push(errorText(error)); }
    finally {
      if (page && !page.isClosed()) {
        if (tabId !== undefined) await setTabEnabledUI(options, tabId, false).catch(error => cancellation.errors.push(errorText(error)));
        await page.close(); pages.delete(page);
      }
      cancellation.host ??= hostSlice(await calls(), cancelStart, cancellation.scroll);
      if (cancellation.errors.length) cancellation.status = 'failed';
    }
    report.finalStatus = await options.evaluate(() => AT.sendMessage({ type: AT.C.MSG.LOCAL_GET_STATUS }));
  } catch (error) { report.errors.push(errorText(error)); }
  finally {
    for (const page of pages) await page.close().catch(error => report.errors.push(errorText(error)));
    if (wrapped) {
      report.allHostCalls = await calls().catch(error => ({ error: errorText(error) }));
      await worker.evaluate(() => globalThis.__restoreScrollHost()).catch(error => report.errors.push(errorText(error)));
    }
    report.summary = SCENARIOS.map(scenario => {
      const runs = report.runs.filter(run => run.scenario === scenario.id);
      const successful = runs.filter(run => run.status === 'passed' && Number.isFinite(run.completionMs));
      const values = successful.map(run => run.completionMs);
      return { scenario: scenario.id, expectedRuns: rounds, observedRuns: runs.length, passed: successful.length,
        failedOrMissing: rounds - successful.length, expectedTargets: rounds * scenario.units.length,
        completedTargets: runs.reduce((sum, run) => sum + (run.dom?.targets?.filter(target => target.completedAt !== null).length || 0), 0),
        medianCompletionMs: successful.length === rounds ? median(values) : null,
        maxCompletionMs: successful.length === rounds ? Math.max(...values) : null,
        successfulOnlyMedianMs: median(values), successfulOnlyMaxMs: values.length ? Math.max(...values) : null };
    });
    report.finishedAt = new Date().toISOString();
    report.passed = report.errors.length === 0 && report.summary.every(row => row.failedOrMissing === 0) && report.cancellation?.status === 'passed';
    // Force-close keep-alive fixture sockets BEFORE close(), even when report writing fails.
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await persist();
  }
  console.log('[scroll-completion report]', reportPath);
  assert.equal(report.passed, true, `scroll completion benchmark failed; see ${reportPath}`);
}

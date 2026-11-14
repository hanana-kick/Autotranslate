// Real public pages and the unchanged installed extension. No inference doubles.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareTabEnabledUI, clickPreparedTabEnabledUI, setTabEnabledUI, tabIdFor } from '../native-extension/tab-control.mjs';
import { runYouTubeComments } from '../onnx-live/youtube-comments.mjs';

// Runs in the page world. Records only; never supplies translations or changes
// content/layout. Latencies start at observation, not GPU dispatch timestamps.
function observePresentation() {
  const started = performance.now(), originals = new WeakMap(), hosts = new Map();
  const auroras = new WeakMap();
  let phase = 'initial', enabled = null, timer, elapsedObserverMs = 0;
  const now = () => performance.now() - started;
  const text = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = text.nextNode(); node; node = text.nextNode()) originals.set(node, node.data);
  const rect = host => {
    const r = host.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right,
      visible: r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth };
  };
  function sample() {
    const begin = performance.now();
    for (const host of document.querySelectorAll('at-translation-text')) {
      const node = host.firstChild;
      if (node?.nodeType !== Node.TEXT_NODE) continue;
      let item = hosts.get(host);
      if (!item) {
        item = { id: hosts.size + 1, host, node, source: originals.get(node) ?? node.data,
          dispatchedMs: now(), phase, initialBox: rect(host), firstPreviewMs: null, firstCommitMs: null,
          completeMs: null, states: [], exitedWhileBusy: false, committedOffscreen: false,
          revertedToSource: false, lastText: node.data, previewUpdates: 0, lastPreview: '', maxFadeSpans: 0,
          auroraReplacements: 0, auroraMissingSamples: 0, auroraSamples: 0 };
        hosts.set(host, item);
      }
      const box = rect(host), state = host.dataset.state ?? null;
      if (state !== item.states.at(-1)?.state) item.states.push({ atMs: now(), state, phase });
      if (!box.visible && host.getAttribute('aria-busy') === 'true') item.exitedWhileBusy = true;
      if (state === 'translating' || state === 'partial') {
        const animation = host.shadowRoot?.querySelector('.surface')?.getAnimations()
          .find(animation => animation.animationName === 'at-aurora');
        item.auroraSamples++;
        if (animation) {
          if (auroras.has(host) && auroras.get(host) !== animation) item.auroraReplacements++;
          auroras.set(host, animation);
        } else item.auroraMissingSamples++;
      }
      const preview = host.shadowRoot?.querySelector('.preview');
      const value = preview?.textContent ?? '';
      if (host.dataset.streaming === 'true' && value && value !== item.lastPreview) {
        item.firstPreviewMs ??= now(); item.previewUpdates++; item.lastPreview = value;
      }
      item.maxFadeSpans = Math.max(item.maxFadeSpans, preview?.querySelectorAll(':scope > span').length ?? 0);
      if (node.data !== item.source) {
        item.firstCommitMs ??= now();
        if (!box.visible && node.data !== item.lastText) item.committedOffscreen = true;
      } else if (item.firstCommitMs !== null) item.revertedToSource = true;
      if (state === 'translated' && node.data !== item.source) item.completeMs ??= now();
      item.lastText = node.data; item.box = box;
    }
    elapsedObserverMs += performance.now() - begin;
  }
  const observer = new MutationObserver(sample);
  observer.observe(document.body, { subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ['data-state', 'data-streaming', 'aria-busy'] });
  timer = setInterval(sample, 80);
  const snapshot = () => {
    sample();
    return { elapsedMs: now(), enabledMs: enabled, observerMs: elapsedObserverMs, scrollY,
      units: [...hosts.values()].map(({ host, node, lastPreview, ...item }) => ({ ...item,
        connected: node.isConnected, finalText: node.data, hostConnected: host.isConnected })) };
  };
  window.__siteEvidence = {
    enable() { enabled = now(); return enabled; },
    mark(value) { phase = value; return snapshot(); },
    snapshot,
    stop() { clearInterval(timer); observer.disconnect(); return snapshot(); },
    restored() {
      return [...hosts.values()].map(({ id, node, source, lastText }) => ({ id,
        connected: node.isConnected, exact: node.data === source, source, beforeRestore: lastText, afterRestore: node.data }));
    }
  };
}

function metrics(evidence) {
  const units = evidence?.units ?? [], complete = units.filter(u => u.completeMs !== null);
  const quantile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] : null;
  const completed = complete.map(u => u.completeMs - u.dispatchedMs);
  const previews = units.filter(u => u.firstPreviewMs !== null).map(u => u.firstPreviewMs - u.dispatchedMs);
  return { dispatchedTextNodes: units.length, completedTextNodes: complete.length,
    unfinishedTextNodes: units.length - complete.length,
    firstPreviewFromDispatchP50Ms: quantile(previews, .5), completionFromDispatchP50Ms: quantile(completed, .5),
    completionFromDispatchP95Ms: quantile(completed, .95),
    exitedWhileBusy: units.filter(u => u.exitedWhileBusy).length,
    committedOffscreen: units.filter(u => u.committedOffscreen).length,
    revertedToSourceBeforeRestore: units.filter(u => u.revertedToSource).length,
    detachedNodes: units.filter(u => !u.connected).length,
    maxFadeSpans: Math.max(0, ...units.map(u => u.maxFadeSpans)),
    auroraSamples: units.reduce((sum, u) => sum + u.auroraSamples, 0),
    auroraReplacements: units.reduce((sum, u) => sum + u.auroraReplacements, 0),
    auroraMissingSamples: units.reduce((sum, u) => sum + u.auroraMissingSamples, 0),
    observerMs: evidence?.observerMs ?? 0 };
}

export async function runViewportSites({ context, options, output }) {
  const settings = await options.evaluate(() => AT.settings.save({ targetLang: 'ko', sourceLang: 'auto', debug: false }));
  const report = { startedAt: new Date().toISOString(), browser: context.browser()?.version(), sites: [],
    translationConcurrency: settings.translationConcurrency,
    limits: ['Fresh signed-out profile; no login, consent acceptance or access-control bypass.',
      'One shared real-model session; pages run sequentially and may reuse warm model state.',
      'Text-node dispatch cohorts, not whole paragraph/comment completion or viewport-entry SLO.',
      'Shadow previews sampled every 80ms; observer, screenshots and automation affect latency.',
      'Aurora animation identity is observed while translating/partial; absence under reduced-motion is intentional.',
      'Source reversions may include page-owned updates; individual evidence must be inspected.'] };
  const write = () => writeFile(join(output, 'viewport-sites.json'), JSON.stringify(report, null, 2));
  const sites = [
    { id: 'pixiv', url: process.env.PIXIV || 'https://www.pixiv.net/ranking.php?mode=daily', follow: 'a[href*="/artworks/"]' },
    { id: 'reddit', url: process.env.REDDIT || 'https://www.reddit.com/r/technology/' },
    { id: 'news', url: process.env.NEWS || 'https://www.nasa.gov/news-release/nasa-awards-moon-base-transportation-technology-science-projects/' },
    { id: 'technical-pdf', url: process.env.PDF || 'https://arxiv.org/pdf/1706.03762', pdf: true },
    { id: 'technical-html', url: process.env.TECHNICAL_HTML || 'https://arxiv.org/html/1706.03762' },
    { id: 'youtube', url: process.env.WATCH || 'https://www.youtube.com/watch?v=DBjiUz0H9HY', youtube: true }
  ];
  const only = (process.env.SITES || '').split(',').filter(Boolean);
  for (const site of sites.filter(site => !only.length || only.includes(site.id))) {
    console.log('[matrix] opening', site.id, site.url);
    if (site.youtube) {
      const evidence = await runYouTubeComments({ context, options, output, url: site.url, warmup: 'earlier real-site translation in this matrix' });
      report.sites.push({ id: site.id, ...evidence }); await write(); continue;
    }
    const page = await context.newPage();
    const record = { id: site.id, requestedUrl: site.url, status: 'opening', phases: [], errors: [] };
    let tabId, observer = false;
    page.on('pageerror', error => record.errors.push(error.message));
    const shot = async name => {
      const path = join(output, `${site.id}-${name}.png`);
      await page.screenshot({ path, fullPage: false }); return path;
    };
    const content = () => options.evaluate(async id => ({
      content: await AT.api.tabs.sendMessage(id, { type: AT.C.MSG.CONTENT_STATE }).catch(error => ({ error: error.message })),
      host: await AT.sendMessage({ type: AT.C.MSG.LOCAL_GET_STATUS })
    }), tabId);
    try {
      const response = await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      record.httpStatus = response?.status();
      await page.bringToFront();
      await page.waitForFunction(() => document.body && (document.body.innerText.length > 80 || document.querySelector('embed, pdf-viewer')), null, { timeout: 20000 }).catch(() => {});
      const access = async () => page.evaluate(() => ({ url: location.href, title: document.title,
        text: (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 1200),
        contentType: document.contentType,
        embeds: [...document.querySelectorAll('embed')].map(e => ({ type: e.type, src: e.src })),
        dialogs: [...document.querySelectorAll('[role="dialog"]')].filter(e => e.getBoundingClientRect().width > 0)
          .map(e => e.innerText.slice(0, 400)) }));
      record.access = await access();
      const refusal = /blocked by network security|whoa there|verify you are human|prove your humanity|access denied|captcha|ログインが必要|この作品を閲覧するにはログイン/i;
      if (refusal.test(record.access.text) || [401, 403, 429].includes(record.httpStatus)) {
        record.status = 'blocked'; record.beforeScreenshot = await shot('blocked');
        continue;
      }
      if (site.follow && !/\/artworks\/\d+/.test(new URL(page.url()).pathname)) {
        const link = page.locator(site.follow).filter({ visible: true }).first();
        if (await link.count()) {
          record.followed = await link.getAttribute('href');
          // Ranking cards open a new tab. Navigate the observed public href in
          // this scenario's owned tab instead of waiting on the unchanged list.
          await page.goto(new URL(record.followed, page.url()).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
          await page.waitForSelector('h1', { timeout: 20000 }).catch(() => {});
          record.access = await access();
          if (refusal.test(record.access.text)) { record.status = 'blocked'; record.beforeScreenshot = await shot('blocked'); continue; }
        }
      }
      record.url = page.url();
      record.beforeScreenshot = await shot('before');
      tabId = await tabIdFor(options, page);
      if (site.pdf) {
        record.frames = page.frames().map(frame => frame.url());
        record.pdfViewer = await page.locator('embed[type="application/pdf"], pdf-viewer').count();
        try {
          await prepareTabEnabledUI(options, tabId);
          await clickPreparedTabEnabledUI(options, tabId, true);
        } catch (error) { record.enableError = error.message; }
        record.state = await content();
        record.options = await options.locator('body').innerText();
        await page.bringToFront();
        await page.mouse.move(800, 600); await page.mouse.wheel(0, 900);
        await page.waitForTimeout(1500);
        record.afterScreenshot = await shot('after-scroll');
        record.presentationHosts = await page.locator('at-translation-text').count();
        record.status = record.presentationHosts ? 'observed' : 'no-pdf-translation';
        continue;
      }
      await prepareTabEnabledUI(options, tabId);
      await page.bringToFront();
      await page.evaluate(observePresentation); observer = true;
      await clickPreparedTabEnabledUI(options, tabId, true);
      await page.evaluate(() => __siteEvidence.enable());
      await page.bringToFront();
      const initialY = await page.evaluate(() => scrollY);
      const phases = [['initial', 0, 5000], ['down', 850, 5000], ['down-more', 850, 4000],
        ['up-during-work', -1200, 4000], ['fast-down', 1700, 1000], ['return', null, 6000]];
      for (const [name, delta, dwell] of phases) {
        const before = await page.evaluate(name => __siteEvidence.mark(name), name);
        const dy = delta ?? initialY - before.scrollY;
        if (dy) { await page.mouse.move(600, 600); await page.mouse.wheel(0, dy); }
        // A fixed observation window is the measured scenario, not a readiness wait.
        await page.waitForTimeout(dwell);
        const evidence = await page.evaluate(() => __siteEvidence.snapshot());
        const state = await content();
        const phase = { name, requestedDelta: dy, fromY: before.scrollY, toY: evidence.scrollY,
          atMs: evidence.elapsedMs, metrics: metrics(evidence), state, screenshot: await shot(name) };
        record.phases.push(phase);
        console.log('[matrix]', site.id, name, JSON.stringify(phase.metrics));
      }
      record.evidence = await page.evaluate(() => __siteEvidence.stop()); observer = false;
      record.metrics = metrics(record.evidence);
      record.state = await content();
      record.status = record.metrics.completedTextNodes ? 'observed' : 'no-completed-translation';
    } catch (error) {
      record.status = 'incomplete'; record.error = error.message;
      record.errorScreenshot = await shot('error').catch(() => null);
    } finally {
      if (observer) record.evidence = await page.evaluate(() => __siteEvidence.stop()).catch(() => null);
      if (tabId !== undefined) {
        // A UI attempt can enable the tab before timing out; always request off.
        await setTabEnabledUI(options, tabId, false).catch(error => { record.restoreError = error.message; });
        record.restored = await page.evaluate(() => window.__siteEvidence?.restored()).catch(() => null);
        record.remainingHosts = await page.locator('at-translation-text').count().catch(() => null);
        record.restoredScreenshot = await shot('restored').catch(() => null);
      }
      report.sites.push(record); await write();
      await page.close();
      console.log('[matrix] result', site.id, record.status, record.error ?? '');
    }
  }
  report.finishedAt = new Date().toISOString(); await write();
  return report;
}

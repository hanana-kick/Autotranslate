// Real installed-extension observations only; no provider or page-content replacement.
// Opt in: YOUTUBE_COMMENTS=1 YOUTUBE_COMMENTS_BURST=1 node test/onnx-live/run-onnx.mjs
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareTabEnabledUI, clickPreparedTabEnabledUI, setTabEnabledUI, tabIdFor } from '../native-extension/tab-control.mjs';

function observeComments() {
  const started = performance.now();
  const units = new Map(), byElement = new WeakMap(), hosts = new Map(), byHost = new WeakMap();
  const originals = new WeakMap(), events = [], actions = [], episodes = [], samples = [];
  const overhead = { mutationMs: 0, sampleMs: 0, apiMs: 0, setupMs: 0, totalMs: 0,
    mutationCalls: 0, sampleCalls: 0, apiCalls: 0, setupCalls: 0 };
  let phase = 'setup', observerMs = 0, callbacks = 0, frame = 0, enabledMs = null, stopped = false;
  const timed = (kind, fn) => {
    const start = performance.now();
    try { return fn(); } finally {
      const elapsed = performance.now() - start;
      overhead[`${kind}Ms`] += elapsed; overhead[`${kind}Calls`]++;
      overhead.totalMs += elapsed;
    }
  };
  const now = () => performance.now() - started;
  const rect = element => {
    const r = element.getBoundingClientRect();
    const rendered = !!(r.width && r.height && element.getClientRects().length);
    return { top: r.top, bottom: r.bottom, documentTop: r.top + scrollY,
      visible: rendered && r.bottom > 56 && r.top < innerHeight && r.right > 0 && r.left < innerWidth,
      rendered };
  };
  function unit(element) {
    if (!element?.matches?.('#content-text') || !element.closest('ytd-comments')) return null;
    let item = byElement.get(element);
    if (!item) {
      let thread = element.closest('ytd-comment-thread-renderer');
      while (thread?.parentElement.closest('ytd-comment-thread-renderer')) thread = thread.parentElement.closest('ytd-comment-thread-renderer');
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const nodes = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        originals.set(node, node.data);
        if (/\p{L}/u.test(node.data)) nodes.push({ node, source: node.data });
      }
      const letters = element.textContent.match(/[\p{L}\p{M}]/gu) ?? [];
      const alreadyTargetLanguage = letters.length > 0 && letters.every(letter => /\p{Script=Hangul}/u.test(letter));
      item = { id: units.size + 1, element, nodes, source: element.textContent, discoveredMs: now(),
        alreadyTargetLanguage, kind: element.closest('ytd-comment-replies-renderer') ? 'reply' : 'comment',
        thread: [...document.querySelectorAll('ytd-comment-thread-renderer:not(ytd-comment-replies-renderer *)')].indexOf(thread) + 1,
        firstVisibleMs: null, firstResultMs: null, fullChangeMs: null, hostIds: [],
        wholeComplete: false, episode: null, visibleEpisodes: 0 };
      byElement.set(element, item); units.set(item.id, item);
      events.push({ type: 'discovered', atMs: now(), phase, unit: item.id, kind: item.kind, ...rect(element) });
    }
    return item;
  }
  function closeEpisode(item, atMs, reason) {
    const episode = item.episode;
    if (!episode) return;
    episode.exitMs = atMs; episode.exitReason = reason;
    episode.unfinishedAtExit = episode.category === 'translation' && episode.completedMs === null;
    episode.censored = episode.unfinishedAtExit;
    events.push({ type: episode.unfinishedAtExit ? 'unfinished-exit' : 'visible-exit',
      atMs, phase, unit: item.id, episode: episode.id, reason, deadlineMiss: episode.deadlineMiss });
    item.episode = null;
  }
  function inspectUnit(item, atMs = now()) {
    const position = rect(item.element);
    if (position.visible && item.firstVisibleMs === null) item.firstVisibleMs = atMs;
    const changed = item.nodes.filter(({ node, source }) => item.element.contains(node) && node.isConnected && node.data !== source);
    if (changed.length && item.firstResultMs === null) {
      item.firstResultMs = atMs;
      events.push({ type: 'first-result', atMs, phase, unit: item.id, kind: item.kind, ...position });
    }
    // Preserve the original Text handles: partial/busy hosts never prove whole completion.
    item.wholeComplete = item.nodes.length > 0 && changed.length === item.nodes.length &&
      !item.element.querySelector('at-translation-text[aria-busy="true"], at-translation-text[data-state="partial"]');
    if (item.wholeComplete && item.fullChangeMs === null) {
      item.fullChangeMs = atMs;
      events.push({ type: 'all-text-changed', atMs, phase, unit: item.id, kind: item.kind, ...position });
    }
    if (enabledMs === null || stopped) return;
    if (position.visible && !item.episode) {
      const category = item.alreadyTargetLanguage ? 'already-korean' : !item.nodes.length ? 'no-letter-source' :
        item.wholeComplete ? (item.visibleEpisodes ? 'cached-complete-return' : 'already-complete-entry') : 'translation';
      const episode = { id: episodes.length + 1, unit: item.id, kind: item.kind, category,
        sourceChars: item.source.length, entryMs: atMs, entryPhase: phase, deadlineMs: atMs + 1000,
        completedMs: null, latencyMs: null, deadlineMiss: null, incompleteDeadlineObservedMs: null,
        exitMs: null, exitReason: null, unfinishedAtExit: false, censored: false };
      item.episode = episode; item.visibleEpisodes++; episodes.push(episode);
      events.push({ type: 'visible-entry', atMs, phase, unit: item.id, episode: episode.id, category });
    }
    const episode = item.episode;
    if (episode?.category === 'translation' && episode.completedMs === null) {
      // An offscreen commit cannot establish completion within the visible episode.
      if (position.visible && item.wholeComplete) {
        episode.completedMs = atMs; episode.latencyMs = atMs - episode.entryMs;
        episode.deadlineMiss = episode.latencyMs > 1000;
        events.push({ type: 'whole-comment-complete', atMs, phase, unit: item.id,
          episode: episode.id, latencyMs: episode.latencyMs, deadlineMiss: episode.deadlineMiss });
      } else if (atMs >= episode.deadlineMs && episode.incompleteDeadlineObservedMs === null) {
        episode.deadlineMiss = true; episode.incompleteDeadlineObservedMs = atMs;
        events.push({ type: 'incomplete-deadline', atMs, phase, unit: item.id, episode: episode.id });
      }
    }
    if (episode && !position.visible) closeEpisode(item, atMs, item.element.isConnected ? 'viewport-or-hidden' : 'disconnected');
  }
  function inspectHost(element) {
    let item = byHost.get(element);
    if (!item) {
      const owner = unit(element.closest('#content-text'));
      const text = [...element.childNodes].filter(n => n.nodeType === 3);
      const source = text.map(n => originals.get(n) ?? n.data).join('');
      const category = owner?.kind ?? (element.closest('ytd-comments') ? 'comment-ui' : element.closest('#secondary') ? 'sidebar' : 'other');
      item = { id: hosts.size + 1, element, unit: owner?.id ?? null, category, source,
        startMs: now(), startPhase: phase, position: rect(element), firstCommitMs: null, endMs: null,
        state: element.dataset.state, updates: 0 };
      byHost.set(element, item); hosts.set(item.id, item); owner?.hostIds.push(item.id);
      events.push({ type: 'dispatch', atMs: item.startMs, phase, host: item.id, unit: item.unit,
        category, source: source.slice(0, 100), ...item.position });
    }
    if (element.isConnected && element.textContent.trim() && element.textContent !== item.source && item.firstCommitMs === null) {
      item.firstCommitMs = now(); item.updates++;
      events.push({ type: 'commit', atMs: now(), phase, host: item.id, unit: item.unit, category: item.category, ...rect(element) });
    }
    item.state = element.dataset.state ?? 'removed';
    if (!element.hasAttribute('aria-busy') && item.endMs === null) {
      item.endMs = now();
      events.push({ type: 'settled', atMs: now(), phase, host: item.id, unit: item.unit, state: item.state });
    }
  }
  function discover(element) {
    if (element.nodeType !== 1) return;
    if (element.matches('#content-text')) unit(element);
    for (const child of element.querySelectorAll('#content-text')) unit(child);
    if (element.matches('at-translation-text')) inspectHost(element);
    for (const child of element.querySelectorAll('at-translation-text')) inspectHost(child);
  }
  timed('setup', () => discover(document.body));
  const observer = new MutationObserver(records => timed('mutation', () => {
    const start = performance.now(); callbacks++;
    const touched = new Set();
    for (const record of records) {
      const element = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      const owner = unit(element?.closest('#content-text'));
      if (owner) touched.add(owner);
      const host = element?.closest('at-translation-text');
      if (host) inspectHost(host);
      for (const added of record.addedNodes) discover(added);
    }
    for (const item of touched) inspectUnit(item);
    observerMs += performance.now() - start;
  }));
  observer.observe(document.body, { subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ['data-state', 'data-reveal', 'aria-busy'] });
  const inspectVisible = () => {
    const atMs = now();
    for (const item of units.values()) inspectUnit(item, atMs);
    const waiting = [...units.values()].filter(item => item.episode?.category === 'translation' &&
      !item.wholeComplete);
    let activePresentationHosts = 0, visibleActivePresentationHosts = 0;
    for (const { element } of hosts.values()) {
      if (element.isConnected && element.getAttribute('aria-busy') === 'true') {
        activePresentationHosts++;
        if (rect(element).visible) visibleActivePresentationHosts++;
      }
    }
    samples.push({ atMs, phase, enabled: enabledMs !== null, visibleUnfinishedCount: waiting.length,
      oldestWaitingAgeMs: waiting.length ? Math.max(...waiting.map(item => atMs - item.episode.entryMs)) : 0,
      activePresentationHosts, visibleActivePresentationHosts });
  };
  const scroll = () => {
    if (!frame) frame = requestAnimationFrame(() => timed('sample', () => { frame = 0; inspectVisible(); }));
  };
  addEventListener('scroll', scroll, { passive: true });
  const timer = setInterval(() => timed('sample', inspectVisible), 100);
  timed('sample', inspectVisible);
  const mark = name => {
    phase = name; inspectVisible();
    const action = { name, atMs: now(), scrollY, hostsBefore: hosts.size,
      visible: [...units.values()].filter(u => rect(u.element).visible).map(u => u.id) };
    actions.push(action); return action;
  };
  const visible = kind => { inspectVisible(); return [...units.values()].filter(u => rect(u.element).visible && (!kind || u.kind === kind)).map(u => u.id); };
  const snapshot = () => {
    if (!stopped) inspectVisible();
    return { elapsedMs: now(), enabledMs, scrollY, viewport: { width: innerWidth, height: innerHeight },
      observerMs, callbacks, overhead, actions, events, episodes, samples,
      units: [...units.values()].map(({ element, nodes, episode, ...item }) => ({ ...item, activeEpisode: episode?.id ?? null, source: item.source.slice(0, 180),
        sourceChars: item.source.length, current: element.textContent.slice(0, 180), connected: element.isConnected,
        originalTextNodes: nodes.every(({ node }) => element.contains(node)), ...rect(element) })),
      hosts: [...hosts.values()].map(({ element, ...item }) => ({ ...item, source: item.source.slice(0, 100),
        connected: element.isConnected, current: element.textContent.slice(0, 100) })) };
  };
  window.__commentEvidence = {
    mark: name => timed('api', () => mark(name)),
    visible: kind => timed('api', () => visible(kind)),
    snapshot: () => timed('api', snapshot),
    enable: () => timed('api', () => {
      if (enabledMs === null) { enabledMs = now(); inspectVisible(); }
      return enabledMs;
    }),
    complete: ids => timed('api', () => {
      for (const id of ids) { const item = units.get(id); if (item) inspectUnit(item); }
      return ids.every(id => { const item = units.get(id); return !!item && (item.alreadyTargetLanguage || item.wholeComplete); });
    }),
    stop: () => timed('api', () => {
      if (!stopped) {
        inspectVisible();
        const atMs = now();
        for (const item of units.values()) closeEpisode(item, atMs, 'observation-ended');
        stopped = true;
        observer.disconnect(); removeEventListener('scroll', scroll); cancelAnimationFrame(frame); clearInterval(timer);
      }
      return snapshot();
    }) };
}

export function summarizeCommentSlo(evidence) {
  const episodes = evidence?.episodes ?? [];
  const summarize = group => {
    const eligible = group.filter(episode => episode.category === 'translation');
    const completed = eligible.filter(episode => episode.completedMs !== null);
    const latencies = completed.map(episode => episode.latencyMs).sort((a, b) => a - b);
    const percentile = p => latencies.length ? latencies[Math.ceil(latencies.length * p) - 1] : null;
    const misses = eligible.filter(episode => episode.deadlineMiss === true).length;
    const known = eligible.filter(episode => episode.deadlineMiss !== null).length;
    return { episodes: group.length, translationEpisodes: eligible.length, completed: completed.length,
      alreadyKorean: group.filter(episode => episode.category === 'already-korean').length,
      noLetterSource: group.filter(episode => episode.category === 'no-letter-source').length,
      alreadyCompleteEntries: group.filter(episode => episode.category === 'already-complete-entry').length,
      cachedCompleteReturns: group.filter(episode => episode.category === 'cached-complete-return').length,
      incomplete: eligible.length - completed.length,
      unfinishedExits: eligible.filter(episode => episode.unfinishedAtExit).length,
      censored: eligible.filter(episode => episode.censored).length,
      censoredBeforeDeadline: eligible.filter(episode => episode.censored && episode.deadlineMiss === null).length,
      pendingBeforeDeadline: eligible.filter(episode => episode.exitMs === null && episode.deadlineMiss === null && episode.completedMs === null).length,
      incompleteDeadlineObservations: eligible.filter(episode => episode.incompleteDeadlineObservedMs !== null).length,
      deadlineMisses: misses, deadlineKnownEpisodes: known, deadlineUnknownEpisodes: eligible.length - known,
      deadlineMissRateKnown: known ? misses / known : null,
      deadlineMissRateLowerBoundAll: eligible.length ? misses / eligible.length : null,
      wholeCompletionMs: { p50: percentile(0.5), p95: percentile(0.95), max: latencies.at(-1) ?? null } };
  };
  const bounds = [[0, 80], [81, 160], [161, 320], [321, 640], [641, null]];
  const samples = (evidence?.samples ?? []).filter(sample => sample.enabled);
  const peak = key => samples.reduce((max, sample) => Math.max(max, sample[key]), 0);
  return { deadlineMs: 1000, clock: 'Observed viewport entry after enable confirmation; initially visible units enter at confirmation.',
    lengthUnit: 'Original source UTF-16 code units', latencyPopulation: 'Completed translation episodes only; unfinished episodes remain in counts and deadline denominators.',
    overall: summarize(episodes),
    lengthBuckets: bounds.map(([minChars, maxChars]) => ({ minChars, maxChars,
      ...summarize(episodes.filter(episode => episode.sourceChars >= minChars && (maxChars === null || episode.sourceChars <= maxChars))) })),
    backlog: { sampleCount: samples.length, peakVisibleUnfinishedCount: peak('visibleUnfinishedCount'),
      peakOldestWaitingAgeMs: peak('oldestWaitingAgeMs'), peakActivePresentationHosts: peak('activePresentationHosts'),
      final: samples.at(-1) ?? null },
    presentationHostMeaning: 'Connected aria-busy=true presentation hosts, not GPU requests or GPU concurrency.' };
}

export async function runYouTubeComments({ context, options, output, url }) {
  const report = { url, status: 'opening', phases: [], limitations: [
    'Single live browsing session; content, reply counts and layout can change.',
    'Dispatch times observe presentation hosts, not GPU start. Commit latency includes queueing and ordered DOM writes.',
    'Whole-text completion means all observed letter-bearing Text nodes changed and no host stayed busy or partial. Already-Korean units are excluded from waiting, not counted as translated; unchanged names or links can leave this conservative metric incomplete.',
    'Comments were loaded before enabling translation; model was warm from the four-paragraph smoke page.',
    'The 1s clock begins at observed viewport entry after enable confirmation, not page load or the UI click. Entries already complete at confirmation are separate; cached-complete returns and already-Korean sources are excluded from translation latency.',
    'Viewport observations use scroll animation frames, mutations and 100ms sampling; latency and exit times are observation bounds, not engine timestamps. Short unfinished exits are explicitly censored, not counted as passes.',
    'Observer overhead includes mutation callbacks, interval/scroll samples, setup and API snapshot/cohort processing; browser protocol serialization is not included. Active presentation hosts are not GPU request counts.'
  ] };
  const page = await context.newPage(); let tabId;
  await page.addInitScript(() => {
    const silence = () => document.querySelectorAll('video,audio').forEach(m => { m.muted = true; m.pause(); });
    document.addEventListener('play', silence, true);
  });
  const shot = async name => {
    const path = join(output, `comments-${name}.png`);
    await page.screenshot({ path, fullPage: false, caret: 'initial' }); return path;
  };
  const status = () => options.evaluate(async id => ({
    host: await AT.sendMessage({ type: AT.C.MSG.LOCAL_GET_STATUS }),
    content: await AT.api.tabs.sendMessage(id, { type: AT.C.MSG.CONTENT_STATE }).catch(() => null)
  }), tabId);
  const mark = name => page.evaluate(name => __commentEvidence.mark(name), name);
  async function observePhase(action, kind = null, budget = 20000) {
    const ids = await page.evaluate(kind => __commentEvidence.visible(kind), kind);
    action.cohort = ids;
    let complete = false;
    if (ids.length) complete = await page.waitForFunction(ids => __commentEvidence.complete(ids), ids, { timeout: budget }).then(() => true, () => false);
    const evidence = await page.evaluate(() => __commentEvidence.snapshot());
    const selected = evidence.units.filter(u => ids.includes(u.id));
    const starts = evidence.events.filter(e => e.type === 'dispatch' && e.atMs >= action.atMs);
    const result = { ...action, endedMs: evidence.elapsedMs, complete, budgetMs: budget,
      firstNewResultMs: Math.min(...selected.filter(u => u.firstResultMs !== null && u.firstResultMs >= action.atMs).map(u => u.firstResultMs - action.atMs)),
      cohort: selected, dispatches: starts,
      slo: summarizeCommentSlo({ ...evidence, episodes: evidence.episodes.filter(episode => episode.entryMs >= action.atMs) }),
      state: await status(), screenshot: await shot(action.name) };
    if (!Number.isFinite(result.firstNewResultMs)) result.firstNewResultMs = null;
    report.phases.push(result);
    report.slo = summarizeCommentSlo(evidence);
    await writeFile(join(output, 'youtube-comments-progress.json'), JSON.stringify(report, null, 2));
    console.log('[comments]', JSON.stringify({ phase: action.name, visible: ids.length, complete,
      firstNewResultMs: result.firstNewResultMs, dispatches: starts.length, elapsedMs: result.endedMs - action.atMs }));
    return result;
  }
  async function wheel(name, delta, budget = 20000) {
    const action = await mark(name), before = await page.evaluate(() => scrollY);
    await page.mouse.move(450, 450); await page.mouse.wheel(0, delta);
    await page.waitForFunction(({ before, delta }) => delta > 0 ? scrollY > before + 100 : scrollY < before - 100,
      { before, delta }, { timeout: 5000 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return observePhase(action, null, budget);
  }
  async function burst() {
    const action = await mark('burst-start');
    const result = { ...action, stepIntervalMs: 1000, idleBudgetMs: 5000, steps: [] };
    await page.mouse.move(450, 450);
    for (const [index, delta] of [...Array(6).fill(900), ...Array(6).fill(-900)].entries()) {
      const started = Date.now();
      const step = await mark(`burst-${delta > 0 ? 'down' : 'up'}-${index + 1}`);
      await page.mouse.wheel(0, delta);
      await page.waitForTimeout(Math.max(0, 1000 - (Date.now() - started)));
      const after = await page.evaluate(() => ({ scrollY, atMs: __commentEvidence.snapshot().elapsedMs }));
      result.steps.push({ ...step, delta, after, moved: after.scrollY !== step.scrollY });
    }
    result.arrivalsScreenshot = await shot('burst-arrivals');
    result.idle = await mark('burst-idle');
    await page.waitForTimeout(result.idleBudgetMs);
    const evidence = await page.evaluate(() => __commentEvidence.snapshot());
    result.endedMs = evidence.elapsedMs;
    result.slo = summarizeCommentSlo({ ...evidence,
      episodes: evidence.episodes.filter(episode => episode.entryMs >= action.atMs),
      samples: evidence.samples.filter(sample => sample.atMs >= action.atMs) });
    result.screenshot = await shot('burst-idle');
    result.state = await status();
    report.burst = result;
    await writeFile(join(output, 'youtube-comments-progress.json'), JSON.stringify(report, null, 2));
  }
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('ytd-watch-metadata h1', { timeout: 30000 });
    await page.bringToFront();
    await page.mouse.move(450, 450); await page.mouse.wheel(0, 850);
    await page.waitForSelector('ytd-comment-thread-renderer #content-text', { timeout: 30000 });
    report.access = await page.evaluate(() => ({ title: document.title, url: location.href,
      threads: document.querySelectorAll('ytd-comment-thread-renderer').length,
      dialogs: [...document.querySelectorAll('[role="dialog"]')].filter(e => e.getBoundingClientRect().width && e.getBoundingClientRect().height).map(e => e.textContent.slice(0, 500)) }));
    if (report.access.dialogs.length) throw new Error('Visible dialog; no dismissal or bypass attempted');
    await options.evaluate(() => AT.settings.save({ targetLang: 'ko', sourceLang: 'auto' }));
    tabId = await tabIdFor(options, page);
    await prepareTabEnabledUI(options, tabId);
    await page.bringToFront();
    await page.evaluate(observeComments);
    report.initial = await page.evaluate(() => __commentEvidence.snapshot());
    report.initialScreenshot = await shot('before'); report.baseline = await status();
    const initial = await mark('initial-comments');
    await clickPreparedTabEnabledUI(options, tabId, true);
    report.enabledMs = await page.evaluate(() => __commentEvidence.enable());
    await page.bringToFront();
    await observePhase(initial);
    if (process.env.YOUTUBE_COMMENTS_BURST === '1') await burst();
    if (process.env.YOUTUBE_COMMENTS_REPLIES_ONLY !== '1') {
      await wheel('down-one', 900, 15000);
      await wheel('down-fast', 1800, 1000);
      await wheel('up-during-work', -900, 15000);
      const first = page.locator('ytd-comment-thread-renderer').first();
      const distance = await first.evaluate(e => e.getBoundingClientRect().top - 100);
      if (Math.abs(distance) > 100) await wheel('return-first-comments', distance, 10000);
      else await observePhase(await mark('return-first-comments'), null, 10000);
    }
    const topLevelThreads = page.locator('ytd-comment-thread-renderer:not(ytd-comment-replies-renderer *)');
    const publicReplies = 'ytd-comment-replies-renderer button[aria-label$="replies"]:not([aria-label="Hide replies"]):not([aria-label="Show more replies"]):visible, ytd-comment-replies-renderer button[aria-label$=" reply"]:visible';
    for (const [index, name] of [[0, 'first-thread'], [1, 'second-thread']]) {
      // Nested reply threads are not candidates; the second public expander need not be nth(1).
      let selectedIndex = index === 0 ? 0 : -1;
      if (index === 1) {
        const count = await topLevelThreads.count();
        for (let candidate = 1; candidate < count; candidate++) {
          const control = topLevelThreads.nth(candidate).locator(publicReplies).first();
          if (await control.count() && await control.isEnabled()) { selectedIndex = candidate; break; }
        }
      }
      if (selectedIndex < 0) {
        report.phases.push({ name: `open-${name}`, unavailable: 'No subsequent loaded top-level thread has an available public reply expander' });
        continue;
      }
      const thread = topLevelThreads.nth(selectedIndex);
      const button = thread.locator(publicReplies).first();
      if (!await button.count() || !await button.isEnabled()) {
        report.phases.push({ name: `open-${name}`, unavailable: 'No available public reply expander in this thread' }); continue;
      }
      await button.scrollIntoViewIfNeeded();
      const action = await mark(`open-${name}`);
      action.button = await button.getAttribute('aria-label');
      action.topLevelThread = selectedIndex + 1;
      await button.click();
      await thread.locator('ytd-comment-replies-renderer #content-text').first().waitFor({ state: 'visible', timeout: 15000 });
      action.replyLoadedMs = await page.evaluate(() => __commentEvidence.snapshot().elapsedMs);
      await observePhase(action, 'reply', 20000);
      if (index === 0) {
        const hide = thread.locator('ytd-comment-replies-renderer button[aria-label="Hide replies"]:visible').first();
        if (await hide.count()) {
          await mark('close-first-replies'); await hide.click();
          await wheel('down-after-collapse', 900, 5000);
          await wheel('up-after-collapse', -900, 5000);
          const reopen = await mark('reopen-first-thread');
          await button.click();
          await thread.locator('ytd-comment-replies-renderer #content-text').first().waitFor({ state: 'visible', timeout: 15000 });
          await observePhase(reopen, 'reply', 5000);
          if (await hide.count()) await hide.click();
        } else {
          report.limitations.push('This YouTube threaded-replies UI exposes no visible Hide replies control; hidden legacy controls were not forced.');
          const more = thread.locator('button[aria-label="Show more replies"]:visible').first();
          if (await more.count()) {
            const action = await mark('load-more-first-replies');
            const before = await thread.locator('ytd-comment-replies-renderer #content-text').count();
            await more.scrollIntoViewIfNeeded(); await more.click();
            await page.waitForFunction(before => document.querySelector('ytd-comment-thread-renderer')
              .querySelectorAll('ytd-comment-replies-renderer #content-text').length > before, before, { timeout: 15000 });
            action.replyLoadedMs = await page.evaluate(() => __commentEvidence.snapshot().elapsedMs);
            await observePhase(action, 'reply', 20000);
            await wheel('up-with-replies', -650, 10000);
            await wheel('down-with-replies', 650, 10000);
          }
        }
      }
    }
    report.evidence = await page.evaluate(() => __commentEvidence.snapshot());
    report.finalState = await status();
    report.media = await page.evaluate(() => [...document.querySelectorAll('video,audio')].map(m => ({ paused: m.paused, muted: m.muted })));
    report.status = 'observed';
  } catch (error) {
    report.status = 'incomplete'; report.error = error.message;
    report.evidence = await page.evaluate(() => window.__commentEvidence?.snapshot()).catch(() => null);
    report.errorScreenshot = await shot('error').catch(() => null);
  } finally {
    if (tabId != null) {
      const finalEvidence = await page.evaluate(() => window.__commentEvidence?.stop()).catch(() => null);
      if (finalEvidence) report.evidence = finalEvidence;
      await setTabEnabledUI(options, tabId, false).catch(error => { report.restoreError = error.message; });
      report.restoredHosts = await page.locator('at-translation-text').count().catch(() => null);
      report.restoredScreenshot = await shot('restored').catch(() => null);
    }
    report.slo = summarizeCommentSlo(report.evidence);
    await writeFile(join(output, 'youtube-comments.json'), JSON.stringify(report, null, 2));
    await page.close();
  }
  return report;
}

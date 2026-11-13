// Real sites, real visible browser, real extension and real q4f16 model.
// Not part of `npm test` or CI: it downloads 673 MB, opens a window, and needs
// a GPU with shader-f16 and websites that answer this machine.
//
//   npm run build
//   npm run test:sites                       # every site in SITES
//   SITES=youtube,reddit npm run test:sites  # a subset, by id
//   SITE_SECONDS=120 MIN_TRANSLATED=3 npm run test:sites
//   KEEP_OPEN=1 npm run test:sites           # leave the window open to look at
//   WATCH=<url> REDDIT=<url> NHK=<url> YAHOO=<url> npm run test:sites
//
// Silent in three layers: --mute-audio for the browser itself, an init script
// that mutes every media element a page creates or plays, and a per-poll sweep
// that proves the state. YouTube playback is also paused and kept paused so an ad
// never starts, but the mute is what guarantees no sound.
//
// A site that blocks this machine is recorded as blocked, never worked around:
// no user agent or cookie trickery, no account, no CAPTCHA bypass. A site that
// blocks the run, serves another language, or reports its own error is recorded
// and does not fail it; a site that had Japanese source and translated nothing
// does.
import { chromium, launchOptions } from '../browser/support.mjs';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, cp, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = '/Users/hana/sources/Autotranslate';
const OUT = join(ROOT, 'test-results/browser');
/** A model already on disk: the run installs from it instead of downloading. */
const MODEL_DIR = process.env.MODEL_DIR ? resolve(process.env.MODEL_DIR) : '';
const GRAPH = 'model_q4f16.onnx';
/** The card the options page offers: kept as-is so its identity, and the parts
 *  that sit beside it, are the shipped ones. */
const CARD = `https://huggingface.co/TeamFlaxia/plamo-3-translate-0.8b-onnx/resolve/main/onnx/${GRAPH}`;
const WATCH = process.env.WATCH || 'https://www.youtube.com/watch?v=ywN3cX4VEII&hl=ja';
const REDDIT = process.env.REDDIT || 'https://www.reddit.com/r/LearnJapanese/';
const TARGET = process.env.TARGET || 'ko';
const summary = {
  sites: [],
  errors: [],
  scope: 'real sites, real extension, real q4f16 model, no audio',
  target: TARGET
};
await mkdir(OUT, { recursive: true });

const tmp = await mkdtemp(join(tmpdir(), 'sites-live-'));
const extension = join(tmp, 'extension');
await cp(join(ROOT, 'build/chrome'), extension, { recursive: true });

/**
 * Serves a model directory over a throwaway https origin. It has to stream: the
 * graph is 705 MB and a route.fulfill body is capped at a 512 MB string, which is
 * exactly how an install from disk used to fail with an http-404.
 */
async function serveModelDirectory(dir, work) {
  const key = join(work, 'key.pem');
  const cert = join(work, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=127.0.0.1'
  ], { stdio: 'ignore' });
  const server = createHttpsServer({ key: await readFile(key), cert: await readFile(cert) }, async (request, response) => {
    const name = (request.url ?? '/').split('/').filter(Boolean).pop() ?? '';
    const file = join(dir, name || GRAPH);
    try {
      const size = (await stat(file)).size;
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(size) });
      createReadStream(file).pipe(response);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    origin: `https://127.0.0.1:${port}`,
    close: () => new Promise((done) => {
      server.closeAllConnections?.();
      server.close(() => done(undefined));
    })
  };
}

// MODEL_DIR keeps the shipped download route intact (same card url, same part
// discovery, same byte-count check, same OPFS write) with the network out of it.
const modelServer = MODEL_DIR ? await serveModelDirectory(MODEL_DIR, tmp) : null;
if (modelServer) console.log('[model] serving', MODEL_DIR, 'at', modelServer.origin);

// A visible window on purpose: the sites answer a headed browser where they
// refuse a headless one, and the run is meant to be looked at.
const context = await chromium.launchPersistentContext(join(tmp, 'profile'), {
  // Branded Chrome refuses --load-extension since 137; Chrome for Testing
  // accepts it, and with HEADLESS unset this is still a real visible window.
  ...launchOptions,
  headless: process.env.HEADLESS === '1',
  ignoreDefaultArgs: [...(launchOptions.ignoreDefaultArgs ?? []), '--disable-extensions', '--disable-gpu'],
  args: [...launchOptions.args.filter((arg) => arg !== '--disable-gpu'),
    '--enable-unsafe-webgpu', ...(process.platform === 'darwin' ? ['--use-webgpu-adapter=apple'] : []),
    `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
    '--no-first-run', '--no-default-browser-check',
    // Layer one: the browser itself never unmutes a tab, and nothing autoplays.
    '--mute-audio', '--autoplay-policy=user-gesture-required'],
  // A concrete viewport: a window with none never starts the extension worker.
  viewport: { width: 1280, height: 1000 },
  locale: 'ja-JP',
  // The throwaway certificate the model origin presents.
  ...(modelServer ? { ignoreHTTPSErrors: true } : {})
});
// Layer two: every page, frame and future navigation mutes its own media the
// moment it exists, before a site's player can ask for sound.
await context.addInitScript(() => {
  const silence = (media) => {
    try {
      media.muted = true;
      media.defaultMuted = true;
      media.volume = 0;
      media.setAttribute('muted', '');
    } catch {
      // A media element the page detached mid-write is not worth failing over.
    }
  };
  const all = () => [...document.querySelectorAll('video, audio')];
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function playSilenced() {
    silence(this);
    return play.call(this);
  };
  document.addEventListener('DOMContentLoaded', () => all().forEach(silence), { capture: true });
  const root = document.documentElement ?? document;
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches('video, audio')) silence(node);
        for (const media of node.querySelectorAll('video, audio')) silence(media);
      }
    }
  }).observe(root, { childList: true, subtree: true });
});
context.setDefaultTimeout(60000);
if (modelServer) {
  // Redirected, not answered: the extension still asks the published card for
  // its graph and for the files beside it, and only the bytes come from disk.
  // A rewritten #modelUrl would lose the card's identity, and with it the parts.
  const base = CARD.slice(0, CARD.lastIndexOf('/') + 1);
  await context.route(`${base}**`, (route) => {
    const name = new URL(route.request().url()).pathname.split('/').filter(Boolean).pop() ?? GRAPH;
    return route.continue({ url: `${modelServer.origin}/onnx/${name}` });
  });
}
context.on('page', (page) => page.on('pageerror', (error) => summary.errors.push({ url: page.url(), error: error.message })));
// A headed window starts its worker lazily; give it a page to wake up for.
let worker = context.serviceWorkers()[0];
if (!worker) {
  const blank = await context.newPage();
  await blank.goto('about:blank').catch(() => {});
  try {
    worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
  } catch {
    worker = context.serviceWorkers()[0];
  }
  if (!worker) {
    await blank.reload().catch(() => {});
    worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 30000 });
  }
  await blank.close().catch(() => {});
}
const extensionId = new URL(worker.url()).host;

const options = await context.newPage();
await options.goto(`chrome-extension://${extensionId}/options.html`);
await options.waitForFunction(() => !!globalThis.AT?.settings, null, { timeout: 30000 });
// The region overlay is part of the shipped UI: turn it on, then require the
// shipped checkbox to show it. (The click itself races the page's own render.)
await options.evaluate((target) => AT.settings.save({ targetLang: target, debug: true }), TARGET);
await options.reload();
await options.waitForFunction(() => !!globalThis.AT?.settings, null, { timeout: 30000 });
await options.bringToFront();
await options.waitForFunction(() => document.querySelector('#debug')?.checked === true, null, { timeout: 15000 });
console.log('[debug]', 'region overlay on');
// MODEL_DIR serves the bytes; the card stays the card, so the parts beside it
// are discovered exactly as they are for a real download.
if (modelServer) await options.waitForFunction((expected) => document.querySelector('#modelUrl')?.value === expected, CARD, { timeout: 15000 });
await options.locator('#downloadModel').click();
await options.waitForFunction(
  () => ['ok', 'error'].includes(document.querySelector('#modelStatus')?.dataset.kind),
  null,
  { timeout: 600000 }
);
const install = await options.evaluate(() => ({
  kind: document.querySelector('#modelStatus')?.dataset.kind,
  text: document.querySelector('#modelStatus')?.textContent ?? ''
}));
console.log('[install]', install.kind, install.text);
await options.screenshot({ path: join(OUT, 'sites-options.png') });
if (install.kind !== 'ok') {
  await writeFile(join(OUT, 'sites-live.json'), JSON.stringify({ ...summary, install }, null, 2));
  await context.close();
  await modelServer?.close();
  throw new Error(`install failed: ${install.text}`);
}

/** Enables the per-tab switch through the shipped options path. */
async function enable(tabId) {
  const enabled = await options.evaluate(async (id) => {
    const reply = await AT.sendMessage({ type: AT.C.MSG.GET_STATE, tabId: id });
    return reply.tabEnabled === true;
  }, tabId);
  if (enabled) return;
  await options.evaluate(async (id) => {
    await AT.sendMessage({ type: AT.C.MSG.SET_TAB_ENABLED, tabId: id, enabled: true });
  }, tabId);
}

// --- The sites: one table, one runner, one silence guarantee.

/** Per-poll enforcement. The state is read *before* the write, so `silent` says
 *  whether anything was actually producing sound - a muted, silent or paused
 *  element is not - and then every element is forced silent for the next poll. */
const silenceNow = (page) => page.evaluate(() => {
  const media = [...document.querySelectorAll('video, audio')];
  const state = {
    count: media.length,
    silent: media.every((element) => element.muted || element.volume === 0 || element.paused),
    paused: media.map((element) => element.paused)
  };
  for (const element of media) {
    element.muted = true;
    element.volume = 0;
  }
  return state;
}).catch(() => ({ count: 0, silent: true, paused: [] }));

// Every site is translated the same way; only the text worth counting and the
// floor that counts as proof differ. MIN_TRANSLATED raises that floor per run.
const SITES = [
  { id: 'youtube', url: WATCH, min: 2, selectors: ['#content-text'], pauseVideo: true, scroll: 45000 },
  { id: 'reddit', url: REDDIT, min: 1, waitFor: 45000, selectors: ['shreddit-post [slot="title"]', 'shreddit-post a[slot="full-post-link"]', '.thing .title a'] },
  { id: 'nhk-easy', url: process.env.NHK || 'https://www3.nhk.or.jp/news/easy/', min: 1, selectors: ['h1', 'h2', '.article-main p', '.article-main li'] },
  { id: 'yahoo-news', url: process.env.YAHOO || 'https://news.yahoo.co.jp/', min: 1, selectors: ['h1', 'h2', 'p'] }
];
const ONLY = (process.env.SITES || '').split(',').map((id) => id.trim()).filter(Boolean);
const selected = ONLY.length ? SITES.filter((site) => ONLY.includes(site.id)) : SITES;
/** Seconds a site gets to translate, four minutes by default. */
const BUDGET_MS = Number(process.env.SITE_SECONDS || 240) * 1000;
const MIN_TRANSLATED = Number(process.env.MIN_TRANSLATED || 0);
/** Measurement run: keep translating for the whole budget and report speed. */
const BENCH = process.env.BENCH === '1';
/** The sentences a site uses to refuse an automated browser. One pattern, used
 *  both to read the refusal and to stop waiting for content that will not come. */
const REFUSAL = 'blocked by network security|whoa there|차단되었습니다|verify you are human|prove your humanity|complete the challenge|captcha|アクセスが集中|しばらくお待ちください';
const JAPANESE = /[\u3040-\u30ff\u4e00-\u9fff]/;
const requiredFor = (id) => Math.max(SITES.find((site) => site.id === id)?.min ?? 1, MIN_TRANSLATED);

/**
 * A page's translation speed, from the batch log the content script keeps.
 * The first batch is the cold one: model load, first generation. `median` and
 * `p90` are what the reader feels while the page fills in afterwards.
 */
function summarizeBench(batches) {
  const times = batches.map((batch) => Number(batch.ms) || 0).filter((ms) => ms > 0);
  if (!times.length) return { requests: 0, texts: 0, first: null, second: null, third: null, median: null, p90: null, max: null, perRequest: null, perText: null, medianWarm: null, firstFive: null, series: [] };
  const sorted = [...times].sort((left, right) => left - right);
  const at = (share) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];
  const total = times.reduce((sum, ms) => sum + ms, 0);
  const texts = batches.reduce((sum, batch) => sum + (Number(batch.texts) || 0), 0);
  // Where the time went, when the background reported it: counting tokens for
  // the packer, then the generation itself.
  const mean = (pick) => {
    const values = batches.map(pick).filter((value) => Number.isFinite(value));
    return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
  };
  const warm = times.slice(1);
  return {
    requests: batches.length,
    texts,
    first: times[0],
    second: times[1] ?? null,
    third: times[2] ?? null,
    median: at(0.5),
    p90: at(0.9),
    max: sorted[sorted.length - 1],
    // Comparable across pages, since request sizes differ: total time over
    // requests, and the same over the texts those requests carried.
    perRequest: Math.round(total / times.length),
    perText: texts ? Math.round(total / texts) : null,
    // What a warm page costs once the model is loaded.
    medianWarm: warm.length ? Math.round(warm.reduce((sum, ms) => sum + ms, 0) / warm.length) : null,
    countMs: mean((batch) => Number(batch.countMs)),
    hostMs: mean((batch) => Number(batch.hostMs)),
    chunks: mean((batch) => Number(batch.chunks)),
    // The first screenful: how long until the page looks translated.
    firstFive: times.slice(0, 5).reduce((sum, ms) => sum + ms, 0),
    series: batches.map((batch) => ({
      index: batch.index, at: batch.at, ms: batch.ms, texts: batch.texts, role: batch.role,
      countMs: batch.countMs ?? null, hostMs: batch.hostMs ?? null, chunks: batch.chunks ?? null
    }))
  };
}

function benchLine(bench) {
  if (!bench || !bench.requests) return 'no request recorded';
  return [
    `first ${bench.first}ms`,
    `2nd ${bench.second ?? '-'}ms`,
    `3rd ${bench.third ?? '-'}ms`,
    `median ${bench.median}ms`,
    `p90 ${bench.p90}ms`,
    `max ${bench.max}ms`,
    `${bench.requests} requests / ${bench.texts} texts`,
    `${bench.perRequest}ms per request · ${bench.perText}ms per text`,
    bench.medianWarm === null ? 'cold only' : `warm ${bench.medianWarm}ms`,
    bench.countMs === null ? 'no split' : `count ${bench.countMs}ms · generate ${bench.hostMs}ms · ${bench.chunks} chunk(s)`,
    `first five ${bench.firstFive}ms`
  ].join(' · ');
}
if (!selected.length) {
  console.log('[sites]', 'SITES=' + process.env.SITES + ' matched no site; known ids:', SITES.map((site) => site.id).join(', '));
}

for (const site of selected) {
  const page = await context.newPage();
  const record = {
    id: site.id, url: site.url, blocked: false, blockedReason: null, blockedEvidence: null,
    skipped: null, skipEvidence: null,
    sourceJapanese: false, before: 0, translated: 0, seconds: null, restored: null,
    mutedThroughout: true, pausedThroughout: site.pauseVideo ? true : null, contentError: null,
    overlay: null, overlayCleared: null, bench: null, samples: []
  };
  const finish = async () => {
    await page.screenshot({ path: join(OUT, `sites-${site.id}.png`) }).catch(() => {});
    summary.sites.push(record);
    await page.close().catch(() => {});
    return record;
  };

  try {
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  } catch (error) {
    record.blocked = true;
    record.blockedReason = 'navigation-failed';
    console.log(`[${site.id}]`, 'navigation failed:', String(error.message).split('\n')[0]);
    await finish();
    continue;
  }
  record.url = page.url();
  await page.bringToFront();

  // What the site says, not what the driver guessed: the refusal has to name
  // itself, and the sentence it was read from goes into the record. It is read
  // twice, because a challenge page often replaces the site's own content after
  // load - Reddit renders "Prove your humanity" only once its script has run.
  const readRefusal = () => page.evaluate((pattern) => {
    const text = (document.body?.innerText ?? '').slice(0, 400);
    const matched = text.match(new RegExp(pattern, 'i'));
    return { matched: matched ? matched[0] : null, evidence: text.replace(/\s+/g, ' ').trim().slice(0, 200) };
  }, REFUSAL).catch(() => ({ matched: null, evidence: '' }));
  const block = async (refusal) => {
    record.blocked = true;
    record.blockedReason = 'site-refused';
    record.blockedEvidence = refusal.evidence;
    console.log(`[${site.id}]`, 'blocked by the site; not bypassing it');
    await finish();
  };
  const firstRefusal = await readRefusal();
  if (firstRefusal.matched) {
    await block(firstRefusal);
    continue;
  }

  // A page whose text arrives on scroll needs a nudge before the source exists,
  // and a client-rendered one needs time after its own challenge redirect.
  if (site.waitFor) {
    await page.waitForFunction(({ selectors, pattern }) =>
      document.querySelectorAll(selectors.join(',')).length > 0 ||
      new RegExp(pattern, 'i').test((document.body?.innerText ?? '').slice(0, 400)),
    { selectors: site.selectors, pattern: REFUSAL }, { timeout: site.waitFor }).catch(() => {});
  }
  if (site.scroll) {
    // `scroll` is a deadline, not a count: a comment section that renders after
    // two screens of scrolling may take half a minute to mount, and a page that
    // is still loading when the source is read looks like a page with no source.
    const primeStart = Date.now();
    await page.waitForTimeout(9000);
    while (Date.now() - primeStart < site.scroll) {
      await page.evaluate(() => window.scrollBy(0, 850)).catch(() => {});
      await page.waitForTimeout(1200);
      const found = await page.evaluate((selectors) => document.querySelectorAll(selectors.join(',')).length > 0, site.selectors).catch(() => false);
      if (found) break;
    }
  }
  const secondRefusal = await readRefusal();
  if (secondRefusal.matched) {
    await block(secondRefusal);
    continue;
  }

  // Marked, because the page keeps changing: a live site dropping a headline
  // must not read as a failed restore. Identity is the only stable handle.
  const before = await page.evaluate((selectors) => {
    const nodes = [...document.querySelectorAll(selectors.join(','))];
    for (const [index, node] of nodes.entries()) node.setAttribute('data-at-probe', String(index));
    return nodes.map((node) => node.textContent?.trim() ?? '');
  }, site.selectors).catch(() => []);
  record.before = before.length;
  record.sourceJapanese = before.some((text) => JAPANESE.test(text));
  if (!record.sourceJapanese) {
    // "Nothing to translate" and "the selectors matched nothing" are different
    // facts about a site, and the record should not claim the first for the second.
    record.skipped = before.length ? 'no-japanese-source' : 'no-source-text';
    record.skipEvidence = await page.evaluate(() => ({
      path: location.origin + location.pathname,
      challenge: new URLSearchParams(location.search).has('js_challenge'),
      title: document.title,
      posts: document.querySelectorAll('shreddit-post').length,
      text: (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)
    })).catch(() => null);
    console.log(`[${site.id}]`, record.skipped === 'no-japanese-source'
      ? 'served no Japanese source; nothing to prove about ja->' + TARGET
      : 'matched no text', JSON.stringify(record.skipEvidence));
    await finish();
    continue;
  }

  const tabId = await options.evaluate(async (url) => (await AT.api.tabs.query({})).find((tab) => tab.url === url)?.id, page.url());
  if (tabId === undefined) {
    record.contentError = 'the browser exposed no tab for this page';
    console.log(`[${site.id}]`, record.contentError);
    await finish();
    continue;
  }
  await enable(tabId);

  // The reader scrolls to the text they actually want. Whatever comes into view
  // has to move to the front of the queue, which is what makes the comments of a
  // watch page arrive without waiting for the rest of the page first.
  if (site.scroll) {
    for (let i = 0; i < 4; i += 1) {
      await page.evaluate(() => window.scrollBy(0, 700)).catch(() => {});
      await page.waitForTimeout(800);
    }
  }

  const required = requiredFor(site.id);
  const started = Date.now();
  let korean = [];
  let lastPrint = -15;
  while (Date.now() - started < BUDGET_MS) {
    const mute = await silenceNow(page);
    if (site.pauseVideo) {
      // The player restarts itself after an ad or a focus change; keep it stopped.
      await page.evaluate(() => document.querySelectorAll('video').forEach((video) => video.pause())).catch(() => {});
      mute.paused = await page.evaluate(() => [...document.querySelectorAll('video')].map((video) => video.paused)).catch(() => []);
      if (mute.paused.some((paused) => paused === false)) record.pausedThroughout = false;
    }
    if (!mute.silent) record.mutedThroughout = false;
    korean = await page
      .evaluate((selectors) => [...document.querySelectorAll(selectors.join(','))]
        .map((node) => node.textContent?.trim() ?? '')
        .filter((text) => /[\uAC00-\uD7AF]/.test(text)), site.selectors)
      .catch(() => []);
    const elapsed = Math.round((Date.now() - started) / 1000);
    if (elapsed - lastPrint >= 15) {
      lastPrint = elapsed;
      console.log(`[${site.id}]`, elapsed + 's', 'ko', korean.length, '/', before.length, 'silent', mute.silent);
    }
    // A benchmark measures the page, not the floor: keep it translating.
    if (!BENCH && korean.length >= required) break;
    await page.waitForTimeout(2500);
  }
  record.translated = korean.length;
  record.seconds = Math.round((Date.now() - started) / 1000);
  record.samples = korean.slice(0, 3);
  // The region overlay is the evidence for *where* the pass worked: how many
  // boxes it drew and what its panel says about roles, budget and failures.
  // The panel is redrawn on the pass throttle, so give the last batch its draw.
  await page.waitForTimeout(3000);
  record.overlay = await page.evaluate(() => {
    const layer = document.querySelector('[data-at-overlay]');
    const body = document.querySelector('[data-at-overlay-body]');
    return {
      boxes: layer ? layer.children.length : 0,
      panel: body ? (body.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) : null
    };
  }).catch(() => ({ boxes: 0, panel: null }));
  console.log(`[${site.id}]`, 'overlay', JSON.stringify(record.overlay));
  await page.screenshot({ path: join(OUT, `sites-${site.id}-regions.png`) }).catch(() => {});
  // Per-page translation speed: every batch round trip in the order the page
  // performed them, so the cold first request and the warm ones stay distinct.
  const state = await options.evaluate((id) => AT.api.tabs.sendMessage(id, { type: AT.C.MSG.CONTENT_STATE }), tabId).catch(() => null);
  record.bench = summarizeBench(state?.bench ?? []);
  console.log(`[${site.id}]`, 'bench', benchLine(record.bench));
  if (korean.length < required) {
    // The tab knows why it stopped; the harness only knows that it did.
    record.contentError = state?.error ?? null;
  }

  await options.evaluate((id) => AT.sendMessage({ type: AT.C.MSG.SET_TAB_ENABLED, tabId: id, enabled: false }), tabId).catch(() => {});
  // Two conditions, both about the extension's own change: its Korean output is
  // gone from every node it was asked to translate, and the text on the nodes
  // that are still there is byte-identical to what was captured before enabling.
  const koreanGone = await page.waitForFunction(() => {
    const probes = [...document.querySelectorAll('[data-at-probe]')];
    return probes.length > 0 && probes.every((node) => !/[\uAC00-\uD7AF]/.test(node.textContent ?? ''));
  }, null, { timeout: 30000 }).then(() => true).catch(() => false);
  const restoredTexts = await page.evaluate(() => {
    const probes = [...document.querySelectorAll('[data-at-probe]')];
    const rows = probes.map((node) => ({ index: Number(node.getAttribute('data-at-probe')), text: node.textContent?.trim() ?? '' }));
    for (const node of probes) node.removeAttribute('data-at-probe');
    return rows;
  }).catch(() => []);
  const mismatched = restoredTexts.filter((row) => row.text !== before[row.index]);
  record.restored = koreanGone && restoredTexts.length > 0 && mismatched.length === 0;
  // The overlay is page furniture, not page content: turning the tab off has to
  // take its boxes and its panel with it.
  record.overlayCleared = await page.evaluate(() => ({
    boxes: document.querySelectorAll('[data-at-overlay] *').length,
    panel: Boolean(document.querySelector('[data-at-overlay-panel]'))
  })).then((left) => left.boxes === 0 && left.panel === false).catch(() => false);
  if (!record.restored) {
    // Which text came back wrong is the whole evidence for a restore failure.
    console.log(`[${site.id}]`, 'restore failed', JSON.stringify({
      koreanGone, compared: restoredTexts.length, captured: before.length,
      mismatched: mismatched.slice(0, 3).map((row) => ({ was: (before[row.index] ?? '').slice(0, 60), is: row.text.slice(0, 60) }))
    }));
  }

  await finish();
}
for (const site of summary.sites) {
  if (site.bench?.requests) console.log(`[${site.id}]`, 'BENCH', benchLine(site.bench));
}
for (const site of summary.sites) {
  const verdict = site.blocked ? 'blocked: ' + site.blockedReason
    : site.skipped ? 'skipped: ' + site.skipped
      : `${site.translated}/${requiredFor(site.id)} Korean, silent ${site.mutedThroughout}`
        + (site.pausedThroughout === null ? '' : `, paused ${site.pausedThroughout}`)
        + `, restored ${site.restored}`
        + (site.contentError ? ', error ' + site.contentError : '');
  console.log(`[${site.id}]`, 'VERDICT', verdict);
}
await writeFile(join(OUT, 'sites-live.json'), JSON.stringify(summary, null, 2));
console.log('[report]', join(OUT, 'sites-live.json'));
if (process.env.KEEP_OPEN === '1') {
  console.log('[done] window stays open; stop the runner to close it');
  await new Promise(() => {});
}
await context.close();
await modelServer?.close();

// A blocked or non-Japanese site is recorded and never fails the run; a site
// that had Japanese source and produced nothing does.
const live = summary.sites.filter((site) => !site.blocked && !site.skipped);
const failures = [];
if (!live.some((site) => site.translated > 0)) failures.push('no site produced a Korean translation');
for (const site of live) {
  if (site.translated < requiredFor(site.id)) failures.push(`${site.id}: ${site.translated} of ${requiredFor(site.id)} expected`);
  if (site.mutedThroughout === false) failures.push(`${site.id}: media was audible during the run`);
  if (site.translated > 0 && site.restored !== true) failures.push(`${site.id}: the original text was not restored`);
  if (site.overlayCleared === false) failures.push(`${site.id}: the debug overlay was left on the page`);
}
if (BENCH) console.log('[bench] measurement run; the exit policy is skipped');
else if (failures.length) throw new Error(failures.join('; '));

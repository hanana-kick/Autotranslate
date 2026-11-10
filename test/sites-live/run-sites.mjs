// Real sites, real visible browser, real extension and real q4f16 model.
// Not part of `npm test` or CI: it downloads 673 MB, opens a window, and needs
// a GPU with shader-f16 and websites that answer this machine.
//
//   npm run build
//   npm run test:sites                       # YouTube (paused) + Reddit
//   KEEP_OPEN=1 npm run test:sites           # leave the window open to look at
//   WATCH=<url> REDDIT=<url> npm run test:sites
//
// A site that blocks this machine is recorded as blocked, never worked around:
// no user agent or cookie trickery, no account, no CAPTCHA bypass.
import { chromium, launchOptions } from '../browser/support.mjs';
import { mkdir, mkdtemp, cp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = '/Users/hana/sources/Autotranslate';
const OUT = join(ROOT, 'test-results/browser');
/** A model already on disk: the run installs from it instead of downloading. */
const MODEL_DIR = process.env.MODEL_DIR ? resolve(process.env.MODEL_DIR) : '';
const LOCAL_ORIGIN = 'https://model.local';
const LOCAL_URL = `${LOCAL_ORIGIN}/onnx/model_q4f16.onnx`;
const WATCH = process.env.WATCH || 'https://www.youtube.com/watch?v=ywN3cX4VEII&hl=ja';
const REDDIT = process.env.REDDIT || 'https://www.reddit.com/r/LearnJapanese/';
const TARGET = process.env.TARGET || 'ko';
const summary = {
  watch: { url: WATCH, translated: 0, seconds: null, pausedThroughout: null, samples: [] },
  reddit: { url: REDDIT, blocked: false, titles: 0, translated: 0, seconds: null, samples: [] },
  errors: []
};
await mkdir(OUT, { recursive: true });

const tmp = await mkdtemp(join(tmpdir(), 'sites-live-'));
const extension = join(tmp, 'extension');
await cp(join(ROOT, 'build/chrome'), extension, { recursive: true });

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
    '--no-first-run', '--no-default-browser-check'],
  // A concrete viewport: a window with none never starts the extension worker.
  viewport: { width: 1280, height: 1000 },
  locale: 'ja-JP'
});
context.setDefaultTimeout(60000);
if (MODEL_DIR) {
  await context.route(`${LOCAL_ORIGIN}/**`, async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').filter(Boolean).pop() ?? '';
    const file = join(MODEL_DIR, name === 'model_q4f16.onnx' ? 'model_q4f16.onnx' : name);
    try {
      const size = (await stat(file)).size;
      await route.fulfill({ status: 200, path: file });
    } catch {
      await route.fulfill({ status: 404, body: '' });
    }
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
await options.evaluate((target) => AT.settings.save({ targetLang: target }), TARGET);
await options.reload();
await options.waitForFunction(() => !!globalThis.AT?.settings, null, { timeout: 30000 });
await options.bringToFront();
if (MODEL_DIR) await options.locator('#modelUrl').fill(LOCAL_URL);
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

// --- YouTube: a Japanese stream, playback stopped and kept stopped.
const watch = await context.newPage();
await watch.goto(WATCH, { waitUntil: 'domcontentloaded', timeout: 90000 });
await watch.bringToFront();
await watch.waitForTimeout(9000);
for (let i = 0; i < 10; i += 1) {
  await watch.evaluate(() => window.scrollBy(0, 850));
  await watch.waitForTimeout(1200);
  if (await watch.evaluate(() => document.querySelectorAll('#content-text').length > 0)) break;
}
const watchTab = await options.evaluate(async (url) => (await AT.api.tabs.query({})).find((tab) => tab.url === url)?.id, watch.url());
console.log('[youtube]', JSON.stringify(await watch.title()).slice(0, 90), 'tab', watchTab);
if (watchTab) {
  await enable(watchTab);
  const started = Date.now();
  let pausedThroughout = true;
  while (Date.now() - started < Number(process.env.SITE_SECONDS || 240000)) {
    // The player restarts itself after an ad or a focus change; keep it stopped.
    await watch.evaluate(() => document.querySelectorAll('video').forEach((video) => video.pause())).catch(() => {});
    const paused = await watch.evaluate(() => [...document.querySelectorAll('video')].map((video) => video.paused));
    if (paused.length && paused.some((value) => value === false)) pausedThroughout = false;
    const korean = await watch.evaluate(() => [...document.querySelectorAll('#content-text')]
      .filter((node) => /[\uAC00-\uD7AF]/.test(node.textContent ?? ''))
      .map((node) => node.textContent.trim()));
    const elapsed = Math.round((Date.now() - started) / 1000);
    if (elapsed % 15 < 3) console.log('[youtube]', elapsed + 's', 'translated', korean.length, 'paused', JSON.stringify(paused));
    if (korean.length >= 2) {
      summary.watch = { ...summary.watch, translated: korean.length, seconds: elapsed, pausedThroughout, samples: korean.slice(0, 3) };
      break;
    }
    await watch.waitForTimeout(2500);
  }
  summary.watch.pausedThroughout ??= pausedThroughout;
  if (summary.watch.seconds === null) summary.watch.pausedThroughout = pausedThroughout;
  await watch.screenshot({ path: join(OUT, 'sites-youtube.png') });
}
console.log('[youtube] RESULT', JSON.stringify(summary.watch).slice(0, 600));

// --- Reddit: only the site's own post titles count; an ad iframe translates too.
const reddit = await context.newPage();
const blocked = await reddit
  .goto(REDDIT, { waitUntil: 'domcontentloaded', timeout: 60000 })
  .then(() => reddit.evaluate(() => /blocked by network security|whoa there|차단되었습니다/i.test(document.body.innerText.slice(0, 400))))
  .catch(() => true);
summary.reddit.blocked = blocked;
const redditTab = blocked ? null : await options.evaluate(async (url) => (await AT.api.tabs.query({})).find((tab) => tab.url === url)?.id, reddit.url());
console.log('[reddit]', blocked ? 'blocked by the site; not bypassing it' : 'tab ' + redditTab);
if (redditTab) {
  await reddit.bringToFront();
  await enable(redditTab);
  const titles = () => reddit.evaluate(() => [...document.querySelectorAll('shreddit-post [slot="title"], shreddit-post a[slot="full-post-link"], .thing .title a')]
    .map((node) => node.textContent?.trim() ?? '').filter(Boolean));
  const started = Date.now();
  while (Date.now() - started < Number(process.env.SITE_SECONDS || 240000)) {
    const list = await titles();
    const korean = list.filter((text) => /[\uAC00-\uD7AF]/.test(text));
    const elapsed = Math.round((Date.now() - started) / 1000);
    if (elapsed % 15 < 3) console.log('[reddit]', elapsed + 's', 'ko titles', korean.length, '/', list.length);
    if (korean.length >= 2) {
      summary.reddit = { ...summary.reddit, titles: list.length, translated: korean.length, seconds: elapsed, samples: korean.slice(0, 3) };
      break;
    }
    await reddit.waitForTimeout(2500);
  }
  await reddit.bringToFront();
  await reddit.screenshot({ path: join(OUT, 'sites-reddit.png') });
}
console.log('[reddit] RESULT', JSON.stringify(summary.reddit).slice(0, 500));

await writeFile(join(OUT, 'sites-live.json'), JSON.stringify(summary, null, 2));
console.log('[report]', join(OUT, 'sites-live.json'));
if (process.env.KEEP_OPEN === '1') {
  console.log('[done] window stays open; stop the runner to close it');
  await new Promise(() => {});
}
await context.close();
if (summary.watch.translated < 2) throw new Error('the watch page produced no translated comments');

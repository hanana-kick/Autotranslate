// Live public YouTube smoke check. No page replay, synthetic replacement, login,
// network mock or inference bridge. A consent/bot/network block is a failure,
// never recorded as a successful live-site test.
import assert from 'node:assert/strict';
export async function runYouTube({ context, options, host, capture, stage, passed, summary, save }) {
  const page = await context.newPage();
  const result = summary.youtube = { url: 'https://www.youtube.com/results?search_query=watercolor+tutorial&hl=en', passed: false, coverage: [] };
  async function toggle(enabled) {
    const stored = await options.evaluate(() => AT.settings.load());
    await options.reload();
    await options.waitForFunction((s) => document.querySelector('#localModel').value === s.localModelId && document.querySelector('#enabled').checked === s.enabled, stored);
    await options.locator('#enabled').setChecked(enabled); await options.locator('#save').click();
    await options.waitForFunction(async (enabled) => document.querySelector('#saveStatus').dataset.kind === 'ok' && (await AT.settings.load()).enabled === enabled, enabled);
  }
  try {
    await stage('live-youtube-search'); await toggle(false);
    await page.goto(result.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const reject = page.getByRole('button', { name: /^Reject all$/i });
    if (await reject.count()) await reject.first().click();
    await page.locator('a#video-title[href^="/watch"]').first().waitFor({ state: 'visible', timeout: 45000 });
    const first = page.locator('a#video-title[href^="/watch"]').first();
    result.originalTitle = await first.innerText(); result.watchHref = await first.getAttribute('href');
    assert.match(result.originalTitle, /[A-Za-z]{3}/, 'a genuine English title is needed');
    result.timeOrigin = await page.evaluate(() => performance.timeOrigin);
    await capture(page, 'youtube-01-original-search');
    await toggle(true);
    await first.evaluate((el) => new Promise((resolve, reject) => {
      const deadline = Date.now() + 120000;
      const timer = setInterval(() => {
        if (/[가-힣]/u.test(el.textContent) && !/<pad>/.test(el.textContent)) { clearInterval(timer); resolve(true); }
        else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('live search title was not translated')); }
      }, 100);
    }));
    result.coverage.push('original-search-title-translated');
    // Observe real site insertions while the extension remains enabled. This
    // observer only records source text; it never mutates the site's DOM.
    const additions = await page.evaluateHandle(() => {
      const state = { items: [], known: new WeakSet([...document.querySelectorAll('a#video-title')]) };
      const observer = new MutationObserver(() => {
        for (const node of document.querySelectorAll('a#video-title')) {
          if (state.known.has(node)) continue;
          const source = node.textContent.trim();
          if (!/[A-Za-z]{3}/.test(source) || /[가-힣]/u.test(source)) continue;
          state.known.add(node); if (state.items.length < 30) state.items.push({ node, source });
        }
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      return { state, observer };
    });
    let inserted = false;
    for (let scroll = 0; scroll < 8; scroll++) {
      await page.mouse.wheel(0, 1600); await page.waitForTimeout(1500);
      inserted = await additions.evaluate((o) => o.state.items.some(({ node }) => node.isConnected));
      if (inserted) break;
    }
    assert.ok(inserted, 'YouTube must actually insert a new result; a static page does not count');
    const until = Date.now() + 180000; let translated = false;
    while (Date.now() < until) {
      translated = await additions.evaluate((o) => o.state.items.some(({ node, source }) => node.isConnected && node.textContent !== source && /[가-힣]/u.test(node.textContent) && !/<pad>/.test(node.textContent)));
      if (translated) break; await page.waitForTimeout(250);
    }
    assert.ok(translated, 'newly inserted real YouTube title must auto-translate');
    result.coverage.push('live-infinite-scroll-auto-translated');
    await additions.evaluate((o) => o.observer.disconnect());
    await capture(page, 'youtube-02-dynamic-search-translated');
    await page.evaluate(() => window.scrollTo(0, 0));
    const video = page.locator('a#video-title').filter({ hasText: /./ }).first();
    await video.click(); await page.waitForURL(/\/watch\?/, { timeout: 45000 });
    const timeOrigin = await page.evaluate(() => performance.timeOrigin);
    assert.equal(timeOrigin, result.timeOrigin, 'navigation must be YouTube SPA, not a full page reload');
    const title = page.locator('ytd-watch-metadata h1').first();
    await title.waitFor({ timeout: 45000 });
    await page.waitForFunction(() => /[가-힣]/u.test(document.querySelector('ytd-watch-metadata h1')?.textContent || ''), null, { timeout: 180000 });
    result.coverage.push('live-watch-spa-title-auto-translated');
    await capture(page, 'youtube-03-watch-translated');
    await toggle(false);
    await page.waitForFunction(() => !/[가-힣]/u.test(document.querySelector('ytd-watch-metadata h1')?.textContent || ''), null, { timeout: 20000 });
    result.restoredTitle = await title.innerText();
    assert.ok(result.restoredTitle.trim().length > 3 && !/<pad>/.test(result.restoredTitle));
    result.coverage.push('live-watch-title-restored');
    result.host = (await host(options)).status;
    await capture(page, 'youtube-04-watch-restored');
    result.passed = true; await passed('actual-youtube-search-scroll-spa-restoration', { coverage: result.coverage });
    await additions.dispose(); await save();
  } catch (error) {
    result.failure = error.message; result.finalURL = page.url();
    result.pageText = (await page.locator('body').innerText().catch(() => '')).slice(0, 1200);
    await capture(page, 'FAIL-live-youtube').catch(() => {}); await save(); throw error;
  } finally { await page.close().catch(() => {}); }
}

// Live public YouTube smoke check. No page replay, synthetic replacement, login,
// network mock or inference bridge. Only public, visibly rendered content is
// tested. A blocked player/title is recorded explicitly, never bypassed or
// claimed as verified; public comments and search remain separate assertions.
import assert from 'node:assert/strict';
import { setTabEnabledUI, tabIdFor } from './tab-control.mjs';
export async function runYouTube({ context, options, host, capture, stage, passed, summary, save }) {
  const page = await context.newPage();
  const result = summary.youtube = { url: 'https://www.youtube.com/results?search_query=watercolor+tutorial&hl=en', passed: false, coverage: [] };
  async function toggle(enabled) { if (!page.url().startsWith('https://')) return; await setTabEnabledUI(options, await tabIdFor(options, page), enabled); }
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
    const target = await additions.evaluate((o) => {
      const item = o.state.items.find(({node,source}) => node.isConnected && /[A-Za-z]/.test(source) && !/[가-힣]/u.test(source));
      return item ? { href: item.node.getAttribute('href'), source: item.source } : null;
    });
    assert.ok(target, 'a newly inserted original English result is required');
    await page.locator('a#video-title[href=' + JSON.stringify(target.href) + ']').first().scrollIntoViewIfNeeded();
    const shownAt = performance.now();
    const until = Date.now() + 180000; let translated = false;
    while (Date.now() < until) {
      translated = await additions.evaluate((o, target) => o.state.items.some(({ node, source }) => node.isConnected && node.getAttribute('href') === target.href && node.textContent !== source && /[가-힣]/u.test(node.textContent) && !/<pad>/.test(node.textContent)), target);
      if (translated) break; await page.waitForTimeout(250);
    }
    assert.ok(translated, 'newly inserted real YouTube title must auto-translate');
    result.insertedTitle = target; result.insertedLatencyMs = performance.now() - shownAt;
    result.coverage.push('live-infinite-scroll-auto-translated');
    await additions.evaluate((o) => o.observer.disconnect());
    await capture(page, 'youtube-02-dynamic-search-translated');
    // Search restoration is independently required even if the video player
    // later asks for login. This keeps live-site coverage honest and useful.
    await toggle(false);
    await page.waitForFunction((original) => {
      const node = [...document.querySelectorAll('a#video-title')].find((e) => e.getAttribute('href') === original.href);
      return !!node && node.textContent.replace(/\s+/g, ' ').trim() === original.source.replace(/\s+/g, ' ').trim();
    }, target, { timeout: 30000 });
    result.coverage.push('live-inserted-search-title-exactly-restored');
    await toggle(true);
    await page.evaluate(() => window.scrollTo(0, 0));
    const videoID = new URL(result.watchHref, 'https://www.youtube.com').searchParams.get('v');
    assert.match(videoID, /^[\w-]+$/);
    const video = page.locator('a#video-title[href*=' + JSON.stringify('v=' + videoID) + ']').first();
    await video.click(); await page.waitForURL(/\/watch\?/, { timeout: 45000 });
    const timeOrigin = await page.evaluate(() => performance.timeOrigin);
    assert.equal(timeOrigin, result.timeOrigin, 'navigation must be YouTube SPA, not a full page reload');
    const title = page.locator('ytd-watch-metadata h1:visible').first();
    const titleVisible = await title.waitFor({ timeout: 10000 }).then(() => true, () => false);
    if (titleVisible) {
      await page.waitForFunction(() => [...document.querySelectorAll('ytd-watch-metadata h1')].some((n) => n.getClientRects().length && /[가-힣]/u.test(n.textContent)), null, { timeout: 180000 });
      result.coverage.push('live-watch-spa-title-auto-translated');
      await capture(page, 'youtube-03-watch-translated');
      await toggle(false);
      await page.waitForFunction(() => !/[가-힣]/u.test(document.querySelector('ytd-watch-metadata h1')?.textContent || ''), null, { timeout: 30000 });
      result.restoredTitle = await title.innerText();
      assert.equal(result.restoredTitle.replace(/\s+/g, ' ').trim(), result.originalTitle.replace(/\s+/g, ' ').trim(), 'restore the exact title for the same real video');
      result.coverage.push('live-watch-title-restored');
    } else {
      // YouTube sometimes hides metadata when its player requires sign-in.
      // Do not translate hidden text or circumvent that access restriction.
      const body = await page.locator('body').innerText();
      assert.match(body, /confirm[^\n]*not[^\n]*bot|봇[^\n]*아니|sign in to confirm/i, 'unexpected missing video title');
      result.blockedCapabilities = ['video playback', 'hidden watch title'];
      result.accessRestriction = 'YouTube player requests login; no login or bypass attempted';
      await toggle(false);
      const comments = page.locator('ytd-comment-thread-renderer #content-text:visible').filter({ hasText: /[A-Za-z]{3}/ });
      await comments.first().waitFor({ timeout: 30000 });
      const comment = await comments.first().elementHandle();
      assert.ok(comment, 'a real public visible comment is required');
      result.commentSource = await comment.innerText();
      assert.ok(!/[가-힣]/u.test(result.commentSource), 'the public comment must start untranslated');
      await comment.scrollIntoViewIfNeeded();
      await toggle(true);
      const end = Date.now() + 180000; let changed = false;
      while (Date.now() < end) {
        changed = await comment.evaluate((n) => n.isConnected && /[가-힣]/u.test(n.textContent) && !/<pad>/.test(n.textContent));
        if (changed) break;
        const state = (await host(options)).status;
        if (state.state === 'error') throw new Error(state.lastError || 'live comment inference failed');
        await page.waitForTimeout(250);
      }
      assert.ok(changed, 'public comment after actual SPA navigation must translate');
      result.commentTranslation = await comment.innerText();
      result.coverage.push('live-watch-spa-public-comment-auto-translated');
      await capture(page, 'youtube-03-public-comment-translated');
      await toggle(false);
      const restoreEnd = Date.now() + 30000; let restored = false;
      while (Date.now() < restoreEnd) {
        restored = await comment.evaluate((n, source) => n.isConnected && n.textContent.trim() === source.trim(), result.commentSource);
        if (restored) break; await page.waitForTimeout(100);
      }
      assert.ok(restored, 'public comment must restore exactly');
      result.coverage.push('live-watch-public-comment-exactly-restored');
      await comment.dispose();
    }
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

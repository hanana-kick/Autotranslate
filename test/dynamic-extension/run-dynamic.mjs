// Extend only the test driver. The installed application and inference path are unchanged.
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
let source = await readFile('test/native-extension/real-extension.mjs', 'utf8');
function replace(from, to) {
  assert.equal(source.split(from).length, 2, 'one expected driver anchor: ' + from);
  source = source.replace(from, to);
}
replace("from './firefox-install.mjs'", "from './test/native-extension/firefox-install.mjs'");
replace("from './tab-ui.mjs'", "from './test/native-extension/tab-ui.mjs'");
if (process.env.CHROMIUM_BINARY) {
  replace("channel: 'chromium'", 'executablePath: process.env.CHROMIUM_BINARY');
  const version = 'context.setDefaultTimeout(30000); summary.browser = context.browser().version();';
  replace(version, version + '\n  summary.browserDistribution = "Chrome for Testing stable";\n  assert.equal(summary.browser, process.env.CHROMIUM_VERSION, "run the pinned released browser");');
}
// A stopped renderer must not leave a failed test waiting in evidence cleanup.
replace('  const session = await context.newCDPSession(p);', "  const session = await bound(context.newCDPSession(p), 10000, 'screenshot CDP attachment');");
replace('  } finally { await session.detach().catch(() => {}); }', "  } finally { await bound(session.detach(), 3000, 'screenshot CDP detach').catch(() => {}); }");
source = "import { runTabControls } from './test/tab-control/native.mjs';\nimport { withNativeHostMonitor } from './test/native-extension/host-monitor.mjs';\nimport { runYouTube } from './test/native-extension/youtube.mjs';\nimport { runEndurance } from './test/native-extension/endurance.mjs';\nimport { runDynamicPage } from './test/dynamic-extension/dynamic-page.mjs';\n" + source;
// Observe definitive host failure while fixtures wait for asynchronous DOM writes.
// No errors are converted to passes. Two identical error reports avoid treating
// the supervisor's brief recovery transition as a final failed operation.
const monitor = `
async function monitoredNative(job, label) {
  return withNativeHostMonitor({
    context, optionsURL: options.url(), readHost: host, run: job, label
  });
}
`;
replace('async function host(p) {', monitor + '\nasync function host(p) {');
const anchor = '  assert.deepEqual(summary.errors, []); summary.fullTranslationRestorePassed = true;';
replace(anchor,
  '  await monitoredNative(() => runDynamicPage({ context, options, host, capture, stage, passed, summary, save, out }), "dynamic DOM");\n' +
  '  await monitoredNative(() => runEndurance({ context, options, host, capture, stage, passed, summary, save }), "multitab endurance");\n' +
  '  if (process.env.TAB_UI_QA === "1") await runTabControls({ context, options, host, capture, stage, passed, summary, save, out });\n' +
  '  if (process.env.YOUTUBE_QA === "1") await monitoredNative(() => runYouTube({ context, options, host, capture, stage, passed, summary, save }), "live YouTube");\n' + anchor);
const failure = "    if (p && !p.isClosed()) { if (await p.locator('#modelToken').count()) await p.locator('#modelToken').fill('').catch(() => {}); await capture(p, name).catch(() => {}); }";
replace(failure, `    if (p && !p.isClosed()) {
      try {
        const count = await bound(p.locator('#modelToken').count(), 3000, 'failure token field check');
        if (count) await bound(p.locator('#modelToken').fill(''), 3000, 'failure credential removal');
        await bound(capture(p, name), 45000, 'failure evidence capture');
      } catch (captureError) {
        summary.captureErrors ??= [];
        summary.captureErrors.push({ name, message: clean(captureError.message) });
      }
    }`);
const file = resolve('.native-dynamic-run.mjs');
await writeFile(file, source);
try { await import(pathToFileURL(file).href); }
finally { await unlink(file).catch(() => {}); }

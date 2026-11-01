// Extend the installed-package test driver, never the application or runtime.
// Static, dynamic, endurance and requested live-site checks remain mandatory.
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const anchor = '  assert.deepEqual(summary.errors, []); summary.fullTranslationRestorePassed = true;';
let source = await readFile('test/native-extension/real-extension.mjs', 'utf8');
assert.equal(source.split(anchor).length, 2, 'the original success gate must occur exactly once');
source = source.replace("from './firefox-install.mjs'", "from './test/native-extension/firefox-install.mjs'");
// Select an actual released browser binary, not a provider or capability double.
// All extension installation and native inference assertions remain identical.
if (process.env.CHROMIUM_BINARY) {
  const launch = "channel: 'chromium'";
  assert.equal(source.split(launch).length, 2, 'one Chromium launch configuration');
  source = source.replace(launch, 'executablePath: process.env.CHROMIUM_BINARY');
  const version = 'context.setDefaultTimeout(30000); summary.browser = context.browser().version();';
  assert.ok(source.includes(version));
  source = source.replace(version, version + '\n  summary.browserDistribution = "Chrome for Testing stable";\n  assert.equal(summary.browser, process.env.CHROMIUM_VERSION, "run the pinned released browser");');
}
source = "import { runYouTube } from './test/native-extension/youtube.mjs';\nimport { runEndurance } from './test/native-extension/endurance.mjs';\nimport { runDynamicPage } from './test/dynamic-extension/dynamic-page.mjs';\n" + source;
source = source.replace(anchor,
  '  await runDynamicPage({ context, options, host, capture, stage, passed, summary, save, out });\n  await runEndurance({ context, options, host, capture, stage, passed, summary, save });\n  if (process.env.YOUTUBE_QA === "1") await runYouTube({ context, options, host, capture, stage, passed, summary, save });\n' + anchor);
const failure = "    if (p && !p.isClosed()) { if (await p.locator('#modelToken').count()) await p.locator('#modelToken').fill('').catch(() => {}); await capture(p, name).catch(() => {}); }";
assert.ok(source.includes(failure));
source = source.replace(failure, `    if (p && !p.isClosed()) {
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

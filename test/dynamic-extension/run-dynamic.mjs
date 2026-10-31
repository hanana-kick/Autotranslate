// Extend the established installed-package test driver, not the application.
// The original static cases, SDK checks, credentials handling and package hashes
// remain mandatory. Failure in any dynamic case fails the complete run.
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const anchor = '  assert.deepEqual(summary.errors, []); summary.fullTranslationRestorePassed = true;';
let source = await readFile('test/native-extension/real-extension.mjs', 'utf8');
assert.equal(source.split(anchor).length, 2, 'the original success gate must occur exactly once');
source = "import { runDynamicPage } from './test/dynamic-extension/dynamic-page.mjs';\n" + source;
source = source.replace(anchor,
  '  await runDynamicPage({ context, options, host, capture, stage, passed, summary, save, out });\n' + anchor);
const file = resolve('.native-dynamic-run.mjs');
await writeFile(file, source);
try { await import(pathToFileURL(file).href); }
finally { await unlink(file).catch(() => {}); }

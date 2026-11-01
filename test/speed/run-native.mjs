// Extend only the driver: identical original SDK/model and actual installed ZIP.
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
let source=await readFile('test/native-extension/real-extension.mjs','utf8');
const replace=(a,b)=>{assert.equal(source.split(a).length,2,'driver anchor '+a);source=source.replace(a,b);};
replace("from './firefox-install.mjs'", "from './test/native-extension/firefox-install.mjs'");
replace("channel: 'chromium'",'executablePath: process.env.CHROMIUM_BINARY');
replace("  if (token) await welcome.locator('#modelToken').fill(token);\n  assert.equal(await welcome.locator('#download').isDisabled(), false);\n  await welcome.locator('#download').click();", "  assert.ok(process.env.MODEL_FILE, 'the original model file is required');\n  await welcome.locator('#modelFile').setInputFiles(process.env.MODEL_FILE);");
source="import { runSpeedBenchmark } from './test/speed/native-benchmark.mjs';\n"+source;
replace('  assert.deepEqual(summary.errors, []); summary.fullTranslationRestorePassed = true;',
 '  await runSpeedBenchmark({ context, options, host, capture, stage, passed, summary, save, out });\n  assert.deepEqual(summary.errors, []); summary.fullTranslationRestorePassed = true;');
const file=resolve('.speed-native-run.mjs');await writeFile(file,source);
try{await import(pathToFileURL(file).href);}finally{await unlink(file).catch(()=>{});}

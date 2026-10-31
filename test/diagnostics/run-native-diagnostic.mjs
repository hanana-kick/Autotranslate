// Diagnostic wrapper around the real installed-extension test, never the app.
// Changes are limited to driver flags, portable test paths and read-only evidence.
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
let source = (await readFile('test/native-extension/real-extension.mjs', 'utf8')).replace(/\r\n/g, '\n');
const replace = (from, to) => { assert.ok(source.includes(from), `Missing harness anchor: ${from}`); source = source.replace(from, to); };
replace("files[relative(dir, file)]", "files[relative(dir, file).replaceAll(String.fromCharCode(92), '/')]");
const originalFlags = "'--use-angle=swiftshader',\n      '--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'";
if (process.platform === 'win32') replace(originalFlags, "'--use-angle=d3d11-warp', '--enable-unsafe-webgpu'");
source = "import { observeExtensionRuntime } from './test/diagnostics/observe-extension-runtime.mjs';\n" + source;
replace('let context, server, welcome, options, page;', 'let context, server, welcome, options, page, stopObservation;');
replace('context.setDefaultTimeout(30000);', 'stopObservation = await observeExtensionRuntime(context, out, clean); context.setDefaultTimeout(30000);');
replace("{ vendor: a.info?.vendor, architecture: a.info?.architecture }", "{ vendor: a.info?.vendor, architecture: a.info?.architecture, description: a.info?.description, features: [...a.features] }");
replace("await welcome.locator('#targetLang').selectOption('ko');", "console.log(JSON.stringify({actualAdapter:summary.adapter})); assert.ok(summary.adapter, 'the actual browser must expose WebGPU'); await welcome.locator('#targetLang').selectOption('ko');");
replace("await passed('native-model-loaded-and-warmed',", "summary.originalModelHeader = await welcome.evaluate(async () => { const records = await AT.modelstore.list(); const blob = await AT.modelstore.read(records[0].id); return [...new Uint8Array(await blob.slice(0, 16).arrayBuffer())]; }); await passed('native-model-loaded-and-warmed',");
// The ordinary test still requires both basic and inline-article restoration.
// Observing logs cannot change its pass criteria or return synthetic output.
const file = resolve('.native-observed-run.mjs');
await writeFile(file, source);
try { await import(pathToFileURL(file).href); }
finally { await unlink(file).catch(() => {}); }

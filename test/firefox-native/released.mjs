// Run the original packaged extension in the official Firefox distribution.
// Only browser selection and read-only diagnostics differ from the WebDriver QA.
import assert from 'node:assert/strict';
import { readFile, writeFile, access, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
assert.ok(process.env.FIREFOX_BINARY, 'an explicit official Firefox binary is required');
await access(process.env.FIREFOX_BINARY);
let source = await readFile('test/firefox-native/webdriver.mjs', 'utf8');
function replace(from, to) {
  assert.equal(source.split(from).length, 2, 'one Firefox QA anchor: ' + from);
  source = source.replace(from, to);
}
replace('binary:firefox.executablePath()', 'binary:process.env.FIREFOX_BINARY');
// Firefox can report message-channel closure instead of the original native or
// structured-clone exception. Capture the browser error console separately; it
// is not an inference implementation and cannot change the extension's result.
const diagnostics = `
async function firefoxDiagnostics() {
  const report = {};
  try {
    report.host = await js('return AT.sendMessage({type:"at/local-get-status"})');
    report.background = await js('return browser.runtime.getBackgroundPage().then(b=>({exists:!!b,placement:b?.AT?.local?.hostPlacement?.(),hasHost:!!b?.AT?.localhost}))');
  } catch(error) { report.statusError = clean(error.message); }
  try {
    await command('POST', '/moz/context', { context: 'chrome' });
    report.console = await js(\`return Services.console.getMessageArray().map(m => {
      try { const e = m.QueryInterface(Ci.nsIScriptError);
        return { message:e.errorMessage, source:e.sourceName, line:e.lineNumber,
          category:e.category, time:e.timeStamp, flags:e.flags }; }
      catch { return { message:m.message }; }
    }).filter(m => /moz-extension:|autotranslate|WebGPU|worker|mediapipe|Receiving end|clone|OutOfMemory|out of memory/i.test(String(m.message)+' '+String(m.source))).slice(-120)\`);
  } catch(error) { report.consoleError = clean(error.message); }
  finally { await command('POST','/moz/context',{context:'content'}).catch(()=>{}); }
  return report;
}
`;
replace('try {\n  await wait(async()=>', diagnostics + '\ntry {\n  await wait(async()=>');
const failure = "  if(session) { await fill('#modelToken','').catch(()=>{}); await snapshot('FAIL-current-page').catch(()=>{}); }";
replace(failure, `  if(session) {
    await fill('#modelToken','').catch(()=>{});
    summary.failureDiagnostics = await firefoxDiagnostics();
    await save();
    await snapshot('FAIL-current-page').catch(()=>{});
  }`);
const file = resolve('.firefox-released-run.mjs');
await writeFile(file, source);
try { await import(pathToFileURL(file).href); }
finally { await unlink(file).catch(()=>{}); }

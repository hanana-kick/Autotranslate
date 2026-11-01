// Run the existing real-addon WebDriver test with the runner's official Firefox.
// Only the browser executable and read-only failure evidence differ. The addon,
// model, runtime, UI interactions and pass assertions remain unchanged.
import assert from 'node:assert/strict';
import { readFile, writeFile, access, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
assert.ok(process.env.FIREFOX_BINARY, 'an explicit official Firefox binary is required');
await access(process.env.FIREFOX_BINARY);
let source = await readFile('test/firefox-native/webdriver.mjs', 'utf8');
const anchor = 'binary:firefox.executablePath()';
assert.equal(source.split(anchor).length, 2);
source = source.replace(anchor, 'binary:process.env.FIREFOX_BINARY');
const failure = "  if(session) { await fill('#modelToken','').catch(()=>{}); await snapshot('FAIL-current-page').catch(()=>{}); }";
assert.ok(source.includes(failure));
source = source.replace(failure, `  if(session) {
    await fill('#modelToken','').catch(()=>{});
    summary.failureHost = await js('return AT.sendMessage({type:"at/local-get-status"})').catch(e=>({error:clean(e.message)}));
    summary.failureBackground = await js('return browser.runtime.getBackgroundPage().then(b=>({exists:!!b,placement:b?.AT?.local?.hostPlacement?.(),hasHost:!!b?.AT?.localhost}))').catch(e=>({error:clean(e.message)}));
    await snapshot('FAIL-current-page').catch(()=>{});
  }`);
const file = resolve('.firefox-released-run.mjs');
await writeFile(file, source);
try { await import(pathToFileURL(file).href); }
finally { await unlink(file).catch(()=>{}); }

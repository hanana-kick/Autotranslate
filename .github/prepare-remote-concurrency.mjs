// Temporary, guarded source assembly. Removed before the reviewed source commit.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const base = 'https://api.github.com/repos/' + process.env.GITHUB_REPOSITORY;
const r = await fetch(base + '/git/blobs/3e7108cbe0a2a815a7feb297d0afb6e68671bb8b', {
  headers: { Authorization: 'Bearer ' + process.env.GH_TOKEN, Accept: 'application/vnd.github+json' }
});
assert.ok(r.ok, 'read pinned implementation patch');
const b = await r.json();
const patch = Buffer.from(b.content, 'base64');
assert.equal(createHash('sha256').update(patch).digest('hex'), 'bc4f4bdd7cd47d0daac29e71361d96fd92250e5484d8ce7935a83ffc229dde25');
fs.writeFileSync('/tmp/provider.patch', patch);
// remote.ts is the newly reviewed shared scheduler, not the obsolete per-call pool.
execFileSync('git', ['apply', '--check', '--exclude=src/lib/remote.ts', '/tmp/provider.patch'], { stdio: 'inherit' });
execFileSync('git', ['apply', '--whitespace=fix', '--exclude=src/lib/remote.ts', '/tmp/provider.patch'], { stdio: 'inherit' });
function edit(path, action) { const text = fs.readFileSync(path, 'utf8'); fs.writeFileSync(path, action(text)); }
function once(text, before, after) {
  assert.equal(text.split(before).length, 2, 'unique source anchor: ' + before.slice(0, 100));
  return text.replace(before, after);
}

edit('src/lib/engines.ts', text => {
  text = once(text, '    remoteKey?: string;', '    remoteKey?: string;\n    signal?: AbortSignal;');
  text = once(text, "AT.remote.translate(config, request.remoteKey ?? '', unique, language, target)", "AT.remote.translate(config, request.remoteKey ?? '', unique, language, target, request.signal)");
  const start = text.indexOf('        const message = String((error as Error)?.message ?? error);');
  const end = text.indexOf('\n      }\n      const results', start);
  assert.ok(start > 0 && end > start);
  return text.slice(0, start) + `        const message = String((error as Error)?.message ?? error);
        const code = LOCAL_CODES[String((error as { code?: unknown })?.code)] ?? 'network';
        throw new EngineError(code, message);` + text.slice(end);
});

edit('src/background.ts', text => {
  text = once(text, '  let policyEpoch = 0;', `  let policyEpoch = 0;
  const remoteRequests = new Map<number, Set<AbortController>>();
  function abortRemoteTab(tabId: number): void {
    for (const controller of remoteRequests.get(tabId) ?? []) controller.abort();
    remoteRequests.delete(tabId);
  }
  function abortRemoteAll(): void {
    for (const id of remoteRequests.keys()) abortRemoteTab(id);
    AT.remote.cancelAll();
  }`);
  text = once(text, '    if (enabled) targets.add(id); else targets.delete(id);',
    '    if (enabled) targets.add(id); else { targets.delete(id); abortRemoteTab(id); }');
  text = once(text, '    // No injection on OFF. Missing content scripts simply have nothing to restore.',
    '    abortRemoteTab(tab.id);\n    // No injection on OFF. Missing content scripts simply have nothing to restore.');
  text = once(text, '      settingsCache = loaded;\n      AT.debug = loaded.debug;',
    '      settingsCache = loaded;\n      if (loaded.engineMode === \'remote\') AT.remote.configureConcurrency(loaded.remoteConcurrency);\n      AT.debug = loaded.debug;');
  text = once(text, "    if (changeInfo.status === 'loading') {", "    if (changeInfo.status === 'loading') {\n      abortRemoteTab(tabId);");
  text = once(text, '  api.tabs.onRemoved.addListener((tabId) => {',
    '  api.tabs.onRemoved.addListener((tabId) => {\n    abortRemoteTab(tabId);');
  const tail = `    if (settings.engineMode === 'remote') request.remoteKey = await AT.remote.getKey();
    else localKey = request.localModelId || null;
    const result = await AT.engines.translate(request);
    return { translations: result.translations, detected: result.detected };`;
  text = once(text, tail, `    if (settings.engineMode === 'remote') {
      const controller = new AbortController();
      const set = remoteRequests.get(tabId) ?? new Set<AbortController>();
      remoteRequests.set(tabId, set); set.add(controller);
      const identity = AT.settings.contentSnapshot(settings).translationKey;
      const stillCurrent = () => !controller.signal.aborted && targets.has(tabId) &&
        (targetRevisions.get(tabId) ?? 0) === revision &&
        identity === AT.settings.contentSnapshot(settingsCache ?? settings).translationKey;
      try {
        request.remoteKey = await AT.remote.getKey();
        request.signal = controller.signal;
        if (!stillCurrent()) throw new Error('tab translation was cancelled');
        const result = await AT.engines.translate(request);
        if (!stillCurrent()) throw new Error('tab translation was cancelled');
        return { translations: result.translations, detected: result.detected };
      } finally {
        set.delete(controller);
        if (!set.size && remoteRequests.get(tabId) === set) remoteRequests.delete(tabId);
      }
    }
    localKey = request.localModelId || null;
    const result = await AT.engines.translate(request);
    return { translations: result.translations, detected: result.detected };`);
  text = once(text, "    if (area !== 'local' || !changes[C.STORAGE_KEY]) return;", `    if (area !== 'local') return;
    if (changes[AT.remote.TOKEN_STORAGE_KEY]) abortRemoteAll();
    if (!changes[C.STORAGE_KEY]) return;`);
  text = once(text, '    const committed = settingsCache;\n    const next =', `    const committed = settingsCache;
    if (!previous || !committed || AT.settings.contentSnapshot(previous).translationKey !== AT.settings.contentSnapshot(committed).translationKey) {
      abortRemoteAll();
    }
    if (committed?.engineMode === 'remote') AT.remote.configureConcurrency(committed.remoteConcurrency);
    const next =`);
  text = once(text, 'localKey !== null && localKey !== settings.localModelId ? releaseLocal() : Promise.resolve()',
    "localKey !== null && (settings.engineMode === 'remote' || localKey !== settings.localModelId) ? releaseLocal() : Promise.resolve()");
  text = once(text, "      if (sender.tab) throw new Error('Only extension UI may inspect remote models');",
    "      if (sender.tab && isInjectable(sender.tab.url)) throw new Error('Only extension UI may inspect remote models');");
  text = once(text, '    [C.MSG.TEST_ENGINE]: (message) => testModel(message as AT.background.EngineTestRequest),',
    `    [C.MSG.TEST_ENGINE]: (message, sender) => {
      if (sender.tab && isInjectable(sender.tab.url)) throw new Error('engine testing requires extension UI');
      return testModel(message as AT.background.EngineTestRequest);
    },`);
  return text;
});

// Local snapshots retain their existing shape; only server mode publishes a
// non-secret dispatch budget. Its value is never accepted as server capacity.
edit('src/lib/settings.ts', t => once(t,
  "      remoteConcurrency: s.engineMode === 'remote' ? s.remoteConcurrency : 1,",
  "      ...(s.engineMode === 'remote' ? { remoteConcurrency: s.remoteConcurrency } : {}),"));

edit('src/lib/dom.ts', text => {
  text = once(text, "      const ask = async (texts: string[]): Promise<string[]> => {", `      const inFlight = new Map<string, Promise<string[]>>();
      const ask = async (texts: string[]): Promise<string[]> => {
        const key = keyFor('in-flight', texts);
        const existing = inFlight.get(key);
        if (existing) return existing;
        const work = askUnshared(texts);
        inFlight.set(key, work);
        try { return await work; }
        finally { if (inFlight.get(key) === work) inFlight.delete(key); }
      };
      const askUnshared = async (texts: string[]): Promise<string[]> => {`);
  return text;
});

edit('src/options.ts', text => {
  text = once(text, "    el('remoteSection').hidden = settings!.engineMode !== 'remote';",
    "    el('remoteSection').hidden = settings!.engineMode !== 'remote';\n    el('remoteConcurrency').disabled = settings!.engineMode !== 'remote';");
  text = once(text, "      el('localSection').hidden = remote;",
    "      el('localSection').hidden = remote;\n      el('remoteConcurrency').disabled = !remote;");
  text = once(text, "      const base = AT.remote.normalizeBaseUrl(patch.remoteBaseUrl);", `      if (!Number.isInteger(patch.remoteConcurrency) || patch.remoteConcurrency! < 1 || patch.remoteConcurrency! > 32) {
        throw new Error(AT.i18n.msg('options_remoteConcurrencyInvalid'));
      }
      const base = AT.remote.normalizeBaseUrl(patch.remoteBaseUrl);`);
  return text;
});
for (const locale of ['en', 'ko']) {
  const path = 'src/_locales/' + locale + '/messages.json';
  const messages = JSON.parse(fs.readFileSync(path, 'utf8'));
  messages.options_remoteConcurrency.message = locale === 'ko' ? '동시에 번역할 개수 (전체 ON 탭 합계, 1–32)' : 'Simultaneous translations (all enabled tabs combined, 1–32)';
  messages.options_remoteConcurrencyInvalid = { message: locale === 'ko' ? '동시 번역 개수는 1부터 32까지의 정수로 입력하세요.' : 'Enter a whole number from 1 to 32 for simultaneous translations.' };
  messages.options_remoteMaxNumSeqs.message = locale === 'ko'
    ? '위 숫자는 이 확장이 동시에 전송할 번역 요청의 최대 개수입니다. 서버 max_num_seqs와는 별개이며, 모델 목록 조회 시 지원 서버의 설정값을 표시합니다. 조회 불가여도 직접 정한 개수로 동작합니다.'
    : 'This is the maximum number of translation HTTP requests from this extension, shared across tabs. It is independent of server max_num_seqs. Optional server-info discovery never changes your chosen limit.';
  fs.writeFileSync(path, JSON.stringify(messages, null, 2) + '\n');
}

// Expand the actual installed-extension HTTP test to reject per-tab or nested
// concurrency multiplication and verify remote-only visibility and persistence.
edit('test/browser/remote-http.test.mjs', text => {
  text = once(text, "      await control.locator('#engineMode').selectOption('remote');", `      assert.equal(await control.locator('#remoteSection').isVisible(), false);
      assert.equal(await control.locator('#remoteConcurrency').isDisabled(), true);
      await control.locator('#engineMode').selectOption('remote');
      assert.equal(await control.locator('#remoteConcurrency').isVisible(), true);
      assert.equal(await control.locator('#remoteConcurrency').isDisabled(), false);`);
  text = once(text, "      assert.doesNotMatch(info,/private, must not render/);", `      assert.doesNotMatch(info,/private, must not render/);
      assert.equal(await control.locator('#remoteConcurrency').inputValue(), '3', 'server metadata never overwrites manual limit');`);
  text = once(text, "      const parallel=await context.newPage();await parallel.goto(origin+'/parallel');", `      const parallel=await context.newPage();await parallel.goto(origin+'/parallel');
      const parallel2=await context.newPage();await parallel2.goto(origin+'/parallel');`);
  text = once(text, "      await opt(parallel,true);", "      await Promise.all([opt(parallel,true),opt(parallel2,true)]);");
  text = once(text, "      assert.ok(peakRequests>=2&&peakRequests<=3,'manual concurrency must operate across independent DOM nodes');", `      await parallel2.waitForFunction(()=>[...document.querySelectorAll('main p')].every(e=>/[가-힣]/u.test(e.textContent)),null,{timeout:20000});
      assert.equal(peakRequests,3,'the manual total limit must be reached but NEVER multiplied by two tabs or nested batches');`);
  text = once(text, "      assert.equal(serverRequests.filter(r=>r.path==='/v1/chat/completions').length-beforeParallel,4);", "      assert.equal(serverRequests.filter(r=>r.path==='/v1/chat/completions').length-beforeParallel,8);");
  text = once(text, "      await opt(parallel,false);", `      await Promise.all([opt(parallel,false), opt(parallel2,false)]);
      await control.reload();
      await control.waitForFunction(()=>document.body.dataset.ready==='true');
      assert.equal(await control.locator('#remoteConcurrency').inputValue(), '3');
      await control.locator('#remoteConcurrency').fill('1');
      await control.locator('#save').click();
      await control.waitForFunction(()=>document.querySelector('#saveStatus').dataset.kind==='ok');
      const serial=await context.newPage(); await serial.goto(origin+'/parallel');
      peakRequests=0;
      await opt(serial,true);
      await serial.waitForFunction(()=>[...document.querySelectorAll('main p')].every(e=>/[가-힣]/u.test(e.textContent)),null,{timeout:20000});
      assert.equal(peakRequests,1,'manual 1 must really serialize independent text nodes');
      await opt(serial,false);
      await mkdir('test-results/remote-http',{recursive:true});
      await control.screenshot({path:'test-results/remote-http/options-remote.png',fullPage:true});
      await control.locator('#engineMode').selectOption('local');
      assert.equal(await control.locator('#remoteConcurrency').isVisible(),false);
      assert.equal(await control.locator('#remoteConcurrency').isDisabled(),true);
      await control.locator('#engineMode').selectOption('remote');
      assert.equal(await control.locator('#remoteConcurrency').inputValue(),'1');`);
  return text;
});

edit('docs/openai-compatible.md', text => text + `
## Manual simultaneous translations

The setting is visible and editable **only in OpenAI-compatible mode**. It defaults to 2 and accepts whole numbers 1–32. It counts active translation HTTP requests from **all enabled tabs combined**, not requests per tab and not candidates per response. The shared background scheduler enforces the total, and the DOM engine supplies independent jobs so a single page can actually use it. Local inference stays on its original serial path.

Queued requests are cancelled on tab OFF, navigation/closure or translation-setting changes. In-flight HTTP requests are aborted; the server may still finish computation after a disconnected client. Late results are rejected before DOM writes. Changing the setting cancels obsolete work and retargets only already-enabled tabs. Server-info values are informational: they never override manual concurrency, and lookup failure does not disable server mode.
`);

execFileSync('git', ['diff', '--check'], { stdio: 'inherit' });
execFileSync('git', ['diff', '--exit-code', '--', 'src/lib/local.ts', 'src/lib/localhost.ts', 'src/inference-worker.ts', 'src/lib/ui.ts'], { stdio: 'inherit' });
assert.equal(JSON.parse(fs.readFileSync('package.json','utf8')).version,'0.1.6');
assert.ok(fs.readFileSync('src/background.ts','utf8').includes('lib/remote.js'));
assert.ok(fs.existsSync('test/browser/remote-http.test.mjs'));
console.log('Actual provider integration applied: 0.1.6, shared 1–32 concurrency; local runtime unchanged');

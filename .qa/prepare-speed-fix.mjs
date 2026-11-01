// One-shot, assertion-guarded migration from the published 0.1.3 source.
// Removed before merge. No SDK/model substitution or test-response bypass.
import fs from 'node:fs';
const edit = (path, fn) => { let text=fs.readFileSync(path,'utf8'); const replace=(from,to)=>{if(text.split(from).length!==2)throw Error(path+': non-unique anchor '+from.slice(0,100));text=text.replace(from,to);}; fn(replace);fs.writeFileSync(path,text); };
edit('src/lib/browser.ts', r=>{
 r('    title?: string | null;','    title?: string | null;\n    active?: boolean;\n    lastAccessed?: number;');
 r('    onRemoved: { addListener: (listener: (tabId: number) => void) => void };', '    onRemoved: { addListener: (listener: (tabId: number) => void) => void };\n    onActivated?: { addListener: (listener: (info: { tabId: number; windowId?: number }) => void) => void };');
});
edit('src/background.ts', r=>{
 r('    getSettings()\n      // `translateTab`', '    // Background navigation must not queue an entire unread feed on the shared model.\n    if (tab.active === false) return;\n    getSettings()\n      // `translateTab`');
 r('  api.tabs.onRemoved.addListener((tabId) => {', "  api.tabs.onActivated?.addListener(({ tabId }) => {\n    void api.tabs.get(tabId).then((tab) => {\n      if (!tab || tab.active === false || !isInjectable(tab.url)) return;\n      return translateTab(tabId);\n    }).catch((error) => AT.warn('activated tab translation failed', error));\n  });\n\n  api.tabs.onRemoved.addListener((tabId) => {");
 r('    if (revision !== policyEpoch) return;\n    await Promise.all(tabs.map', '    if (revision !== policyEpoch) return;\n    const eligible = tabs.filter((tab): tab is AT.Tab => tab?.id != null && isInjectable(tab.url));\n    const foreground = eligible.filter((tab) => tab.active === true);\n    // Options/onboarding can be the foreground extension tab. Resume the most\n    // recently used web page, not every open tab. Activation handles the rest.\n    const recipients = new Set((foreground.length ? foreground : eligible.slice().sort((a, b) =>\n      (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0)).slice(0, 1)).map((tab) => tab.id));\n    await Promise.all(tabs.map');
 r("        if (decision.action === 'skip') {\n          await api.tabs.sendMessage(id, { type: C.MSG.CONTENT_RESTORE });", "        if (decision.action === 'skip' || !recipients.has(id)) {\n          // Restore/invalidate stale policy in existing scripts, without injecting\n          // a script or starting inference in an unread tab (also after SW restart).\n          await api.tabs.sendMessage(id, { type: C.MSG.CONTENT_RESTORE });");
});
edit('src/lib/dom.ts', r=>{
 r('  const marker = (index: number) => `\\uE000${index}\\uE001`;\n\n', '');
 r("const key = keyFor('run-v2', items.map((item) => item.source));", "const key = keyFor('run-numbered-v3', items.map((item) => item.source));");
 r("              const marked = items.map((item, index) => (index ? marker(index) : '') + item.core).join('');\n              const reply = await ask([marked]);\n              if (cancelled() || !items.every(owns)) continue;\n              pieces = splitRun(reply[0] ?? '', items.length);", '              // Use the engine\'s existing numbered-segment contract directly.\n              // Private-use markers were normally dropped, wasting one full\n              // generation before the same fragments were translated again.\n              const reply = await ask(items.map((item) => item.core));\n              if (cancelled() || !items.every(owns)) continue;\n              pieces = reply.length === items.length && reply.every(Boolean) ? reply : null;');
});
edit('src/lib/pipeline.ts', r=>{
 r('    refresh: (root?: Element | Document | null, budget?: number) => Promise<Result>;', '    refresh: (root?: Element | Document | null, budget?: number) => Promise<Result>;\n    /** Continue an unchanged plan without collecting/measuring the page again. */\n    resume: (budget?: number) => Promise<Result>;\n    /** External DOM/viewport changes invalidate geometry, never restore records. */\n    invalidatePlan: () => void;');
 r('    let batches = 0;', '    let batches = 0;\n    type Plan = { nodes: Text[]; entries: { id: string; role: AT.targets.TextRole; priority: AT.targets.Priority }[]; cursor: number };\n    let savedPlan: Plan | null = null;');
 r('      epoch = generation\n    ): Promise<Result>', '      epoch = generation,\n      resume = false\n    ): Promise<Result>');
 r('      const collected = dom.collect(start, Number.POSITIVE_INFINITY);', '      const previousPlan = resume ? savedPlan : null;\n      if (!resume) savedPlan = null;\n      const collected = previousPlan ? previousPlan.nodes : dom.collect(start, Number.POSITIVE_INFINITY);');
 r('      const pending = collected.filter((node) => !done.has(node) || !dom.has(node));', '      const pending = previousPlan ? collected : collected.filter((node) => !done.has(node) || !dom.has(node));');
 r('      const ordered = budgeted && remaining.length > 0 ? remaining : pending;\n      const candidates: AT.targets.Candidate[] = ordered.map((node, index) => {', '      const ordered = previousPlan ? previousPlan.nodes : budgeted && remaining.length > 0 ? remaining : pending;\n      const candidates: AT.targets.Candidate[] = previousPlan ? [] : ordered.map((node, index) => {');
 r('      const groups = AT.targets.plan(candidates, { limit, band: height });', '      const plan: Plan = previousPlan ?? { nodes: ordered, cursor: 0,\n        entries: AT.targets.plan(candidates, { band: height }).flatMap((group) =>\n          group.ids.map((id) => ({ id, role: group.role, priority: group.priority }))) };\n      const groups: AT.targets.Group[] = [];\n      const count = Number.isFinite(limit) && limit > 0 ? limit : plan.entries.length;\n      for (const entry of plan.entries.slice(plan.cursor, plan.cursor + count)) {\n        let group = groups[groups.length - 1];\n        if (!group || group.role !== entry.role || group.priority !== entry.priority) {\n          group = { role: entry.role, priority: entry.priority, ids: [] };\n          groups.push(group);\n        }\n        group.ids.push(entry.id);\n      }\n      plan.cursor += groups.reduce((sum, group) => sum + group.ids.length, 0);\n      // Subtree edits cannot replace a saved whole-page plan. The caller will\n      // rediscover once after such an edit, then reuse its remaining queue.\n      const wholePage = root == null || start === request.doc.documentElement;\n      savedPlan = wholePage && plan.cursor < plan.entries.length ? plan : null;');
 r('.filter((node): node is Text => node !== undefined);', '.filter((node): node is Text => node !== undefined && node.isConnected !== false && !dom.has(node));');
 r('processedNodes, hasMore: !cancelled() && ordered.length > processedNodes', 'processedNodes, hasMore: !cancelled() && plan.cursor < plan.entries.length');
 r('      refresh: (root, budget) => schedule(root ?? null, false, budget),', '      refresh: (root, budget) => schedule(root ?? null, false, budget),\n      resume: (budget) => { const epoch = generation; return once(() => run(null, false, budget, epoch, true)); },\n      invalidatePlan: () => { savedPlan = null; },');
 r('        generation++;\n        const restored', '        generation++;\n        savedPlan = null;\n        const restored');
});
edit('src/content.ts', r=>{
 r('    full: boolean;', '    full: boolean;\n    /** Known pending work is not a new mutation and needs no debounce. */\n    continuation: boolean;\n    immediateTimer: boolean;');
 r('    full: false,', '    full: false,\n    continuation: false,\n    immediateTimer: false,');
 r('  function scheduleTick(): void {', '  function scheduleTick(immediate = false): void {');
 r('    if (state.timer !== 0) {', '    if (state.timer !== 0 && immediate && !state.immediateTimer) {\n      clearTimeout(state.timer);\n      state.timer = 0;\n    }\n    if (state.timer !== 0) {');
 r('    state.timer = setTimeout(() => {\n      state.timer = 0;', '    state.immediateTimer = immediate;\n    state.timer = setTimeout(() => {\n      state.timer = 0;\n      state.immediateTimer = false;');
 r('state.full = false; state.dirty = false; state.roots = [];', 'state.full = false; state.continuation = false; state.dirty = false; state.roots = [];');
 r('          if (state.dirty) scheduleTick();', '          if (state.dirty || state.continuation) scheduleTick(state.continuation);');
 r('    }, C.OBSERVER_DEBOUNCE_MS);', '    }, immediate ? 0 : C.OBSERVER_DEBOUNCE_MS);');
 r('    enqueue(changedRegions(records));', '    const regions = changedRegions(records);\n    if (regions === null || regions.length) state.pipeline?.invalidatePlan();\n    enqueue(regions);');
 r("  function takeQueue(): Element[] | 'full' | null {", "  function takeQueue(): Element[] | 'full' | 'continue' | null {");
 r('    return regions.length > 0 ? regions : null;', "    if (regions.length) return regions;\n    if (state.continuation) { state.continuation = false; return 'continue'; }\n    return null;");
 r("    const regions = queue === 'full' ? [document.body ?? document.documentElement] : queue;", "    const continuing = queue === 'continue';\n    const regions = queue === 'full' || continuing ? [document.documentElement] : queue;");
 r('        const result = await pipeline.refresh(region, left);', '        const result = continuing ? await pipeline.resume(left) : await pipeline.refresh(region, left);');
 r('        if (state.dirty) { state.dirty = false; scheduleTick(); }', '        if (state.dirty) { state.dirty = false; scheduleTick(state.continuation); }');
 r('    if (more) requestFullPass();', '    if (more) requestContinuation();');
 r('  function requestFullPass(): void {\n    state.full = true;', '  function requestContinuation(): void {\n    state.continuation = true;\n    scheduleTick(true);\n  }\n\n  function requestFullPass(): void {\n    state.pipeline?.invalidatePlan();\n    state.full = true;');
 r('    state.full = false;\n    state.roots = [];\n    state.working', '    state.full = false;\n    state.continuation = false;\n    state.roots = [];\n    state.working');
 r('      if (result.hasMore) requestFullPass();', '      if (result.hasMore) requestContinuation();');
 r('        if (state.dirty || state.full || state.roots.length) {\n          state.dirty = false;\n          scheduleTick();', '        if (state.dirty || state.full || state.roots.length || state.continuation) {\n          state.dirty = false;\n          scheduleTick(state.continuation);');
 r('      state.full = false;\n      state.roots = [];\n      await report', '      state.full = false;\n      state.continuation = false;\n      state.roots = [];\n      await report');
});
edit('test/dom.test.ts', r=>{
 r("  // A provider preserves explicit segment identities, not length proportions.\n  const { calls, translator, body } = harness(el('div', {}, [paragraph]), (texts) =>\n    texts.map(() => '합계\\uE0001\\uE0015개 항목\\uE0002\\uE001남음')\n  );", "  // The existing numbered engine contract preserves each segment identity.\n  const labels: Record<string, string> = { Total: '합계', '5 items': '5개 항목', left: '남음' };\n  const { calls, translator, body } = harness(el('div', {}, [paragraph]), (texts) =>\n    texts.map((value) => labels[value]!)\n  );");
 r("['Total\\uE0001\\uE0015 items\\uE0002\\uE001left'], 'the run carries verifiable boundaries'", "['Total', '5 items', 'left'], 'the indexed batch carries verifiable boundaries without a wasted marker attempt'");
 r("test('an unaligned short answer falls back without clearing an element'", "test('an indexed inline batch preserves each element without a preliminary generation'");
 r("assert.equal(calls.length, 4, 'an unaligned run is retried per fragment');", "assert.equal(calls.length, 1, 'aligned fragments share one request and no speculative marker generation');");
});
edit('test/background.test.ts', r=>{
 r('type Tab = { id?: number; url?: string; title?: string; ping?: boolean; translated?: number };', 'type Tab = { id?: number; url?: string; title?: string; ping?: boolean; translated?: number; active?: boolean; lastAccessed?: number };');
 r('  removed: Listener[];', '  removed: Listener[];\n  activated: Listener[];');
 r('updated: [], removed: [], storageChanged', 'updated: [], removed: [], activated: [], storageChanged');
 r('get: async (tabId: number) => (tab && tab.id === tabId ? tab : null),', 'get: async (tabId: number) => (tabs?.find((candidate) => candidate.id === tabId) ?? (tab && tab.id === tabId ? tab : null)),');
 r('      onRemoved: { addListener: (fn: Listener) => events.removed.push(fn) },', '      onRemoved: { addListener: (fn: Listener) => events.removed.push(fn) },\n      onActivated: { addListener: (fn: Listener) => events.activated.push(fn) },');
});
fs.appendFileSync('test/background.test.ts', `

test('speed: enabling with twenty open tabs starts only the foreground document', async () => {
  const tabs = Array.from({ length: 20 }, (_, index) => ({ id: index + 1,
    url: 'https://example.test/' + index, active: index === 7, lastAccessed: index }));
  const env = environment({ tabs, settings: { enabled: false } });
  const before = env.AT.settings.normalize({ enabled: false });
  const after = env.AT.settings.normalize({ enabled: true });
  await fire(env.events.storageChanged, { settings: { oldValue: before, newValue: after } }, 'local');
  await settlePolicy();
  const starts = env.recorded.tabMessages.filter((e) => e.message.type === 'at/content-translate');
  assert.deepEqual(starts.map((e) => e.tabId), [8]);
  assert.ok(env.recorded.injected.every((e) => e.target.tabId === 8));
  assert.equal(env.recorded.tabMessages.filter((e) => e.message.type === 'at/content-restore').length, 19,
    'stale inactive policy is still invalidated after worker restart');
  tabs[7]!.active = false; tabs[2]!.active = true;
  await fire(env.events.activated, { tabId: 3 }); await settlePolicy();
  assert.ok(env.recorded.tabMessages.some((e) => e.tabId === 3 && e.message.type === 'at/content-translate'),
    'the deferred page starts on real tab activation');
});

test('speed: options enable chooses only the most recently active web tab', async () => {
  const tabs = [{ id: 1, url: 'https://a.example/', active: false, lastAccessed: 1 },
    { id: 2, url: 'https://b.example/', active: false, lastAccessed: 9 },
    { id: 3, url: 'chrome-extension://id/options.html', active: true, lastAccessed: 10 }];
  const env = environment({ tabs, settings: { enabled: false } });
  await fire(env.events.storageChanged, { settings: {
    oldValue: env.AT.settings.normalize({ enabled: false }), newValue: env.AT.settings.normalize({ enabled: true }) } }, 'local');
  await settlePolicy();
  assert.deepEqual(env.recorded.tabMessages.filter((e) => e.message.type === 'at/content-translate').map((e) => e.tabId), [2]);
});

test('speed: completing a background navigation does not inject or infer', async () => {
  const tab = { id: 3, url: 'https://quiet.example/', active: false };
  const env = environment({ tab, settings: { enabled: true } });
  await fire(env.events.updated, 3, { status: 'complete' }, tab); await settlePolicy();
  assert.equal(env.recorded.injected.length, 0);
  assert.ok(!env.types().includes('at/content-translate'));
});
`);
fs.appendFileSync('test/content.test.ts', `

test('speed: a known continuation yields without the 300 ms mutation debounce', async () => {
  const texts = Array.from({ length: 48 }, (_, i) => 'Unique sentence number ' + i + '.');
  const clock = installClock();
  try {
    const env = environment({ texts });
    const first = await env.send(translateMessage());
    assert.equal(first.translated, 16);
    assert.equal(clock.pending[0]?.delay, 0, 'work already waiting is scheduled immediately');
    await clock.run();
    assert.equal(env.boot.state.pipeline.stats().translated, 32);
    assert.equal(clock.pending[0]?.delay, 0);
    await clock.run();
    assert.equal(env.boot.state.pipeline.stats().translated, 48);
    assert.equal(clock.pending.length, 0, 'the queue terminates without a feedback loop');
    await env.send({ type: 'at/content-restore' });
    assert.deepEqual(pageTexts(env.page.documentElement), texts);
  } finally { clock.restore(); }
});
`);
edit('test/pipeline.test.ts', r=>r("import { load } from './helpers.ts';", "import { load, type ATNamespace } from './helpers.ts';"));
fs.appendFileSync('test/pipeline.test.ts', `

test('speed: 600 nodes over 38 continuations are measured once, not once per slice', async () => {
  const fixture = page(Array.from({ length: 600 }, (_, i) => ({ text: 'Unique phrase ' + i, top: i * 20 })));
  let measurements = 0, requests = 0;
  const translator = pipeline.create({ doc: fixture.document, settings: () => ({ maxNodes: 600 }),
    measure: (node: ATNamespace) => { measurements++; return node.parentElement.getBoundingClientRect(); },
    translate: async (batch: ATNamespace) => { requests += batch.texts.length; return batch.texts.map((s: string) => '»' + s + '«'); } });
  let result = await translator.translate(16), passes = 1;
  while (result.hasMore && passes < 50) { result = await translator.resume(16); passes++; }
  assert.equal(result.translated, 600); assert.equal(requests, 600); assert.equal(passes, 38);
  assert.equal(measurements, 600, 'existing queued candidates reuse their geometry and order');
  assert.equal(result.hasMore, false);
  assert.equal(translator.restore().restored, 600);
});

test('speed: an external change invalidates queued geometry and preserves new text on restore', async () => {
  const fixture = page([{ text: 'First original', top: 0 }, { text: 'Second original', top: 800 }, { text: 'Third original', top: 1600 }]);
  let measurements = 0;
  const translator = pipeline.create({ doc: fixture.document, settings: () => ({ maxNodes: 600 }),
    measure: (node: ATNamespace) => { measurements++; return node.parentElement.getBoundingClientRect(); },
    translate: async (batch: ATNamespace) => batch.texts.map((s: string) => '»' + s + '«') });
  await translator.translate(1);
  fixture.texts[1]!.nodeValue = 'Updated source'; translator.invalidatePlan();
  await translator.resume(1); await translator.resume(1);
  assert.equal(measurements, 5, 'remaining two nodes are measured exactly once after invalidation');
  translator.restore(); assert.equal(fixture.texts[1]!.nodeValue, 'Updated source');
});
`);
edit('test/native-extension/endurance.mjs', r=>r('    await toggle(true);\n    const initial', `    await toggle(true);
    // Activate deferred unread tabs once; subsequent rounds remain concurrent.
    for (const page of tabs) {
      await page.bringToFront();
      await page.waitForFunction(() => /[가-힣]/u.test(document.querySelector('#text').textContent), null, { timeout: 600000 });
    }
    const initial`));
for(const path of ['package.json','package-lock.json','src/manifest.json']) {
 const s=fs.readFileSync(path,'utf8'); if(!s.includes('"version": "0.1.3"'))throw Error('unexpected version '+path);
 fs.writeFileSync(path,s.replaceAll('"version": "0.1.3"','"version": "0.1.4"'));
}
console.log('Applied speed fixes. Original SDK, model and output/restore validation are unchanged.');

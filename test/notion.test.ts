import assert from 'node:assert/strict';
import test from 'node:test';
import { deferred, load, resetGlobals, type ATNamespace } from './helpers.ts';

// Deliberately malformed fixtures and the eval-loaded namespace use the shared dynamic test seam.
type Json = ATNamespace;
type Config = { enabled: boolean; token: string; conceptDatabaseId: string; termDatabaseId: string; conceptDataSourceId: string; termDataSourceId: string; intervalMinutes: number; mapping: Record<string, string>; source?: string; conceptUrl?: string; termUrl?: string };
type Snapshot = { version: number; revision: string; syncedAt: number; concepts: number; entries: Json[] };
type Service = {
  CONFIG_KEY: string; SNAPSHOT_KEY: string; STATE_KEY: string;
  defaults(): Config; loadConfig(): Promise<Config>; saveConfig(patch: unknown): Promise<Config>;
  loadSnapshot(): Promise<Snapshot | null>;
  loadState(): Promise<{ running: boolean; lastAttempt: number; lastSuccess: number; error: string }>;
  sync(): Promise<Snapshot>;
};
const ids = {
  conceptDb: '11111111-1111-1111-1111-111111111111',
  termDb: '22222222-2222-2222-2222-222222222222',
  conceptDs: '33333333-3333-3333-3333-333333333333',
  termDs: '44444444-4444-4444-4444-444444444444',
  conceptPage: '55555555-5555-5555-5555-555555555555',
  conceptUuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  jaPage: '66666666-6666-6666-6666-666666666666',
  koPage: '77777777-7777-7777-7777-777777777777',
  otherPage: '88888888-8888-8888-8888-888888888888',
  otherUuid: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
};
const token = 'secret-do-not-leak-TEST-CREDENTIAL';
function rich(value: string): Json[] { return value ? [{ type: 'text', plain_text: value, text: { content: value } }] : []; }
function textProperty(type: string, value: string): Json { return { type, [type]: rich(value) }; }
function list(results: Json[], more = false, cursor: string | null = null): Json {
  return { object: 'list', results, has_more: more, next_cursor: cursor };
}
function fixture(mapping: Record<string, string>): { conceptSchema: Json; termSchema: Json; concepts: Json[]; terms: Json[] } {
  const field = (type: string): Json => ({ type, [type]: {} });
  return {
    conceptSchema: {
      [mapping.conceptId!]: field('title'), [mapping.conceptType!]: field('select'), [mapping.definition!]: field('rich_text'),
    },
    termSchema: {
      [mapping.term!]: field('title'), [mapping.language!]: field('select'), [mapping.group!]: field('rich_text'),
      [mapping.traits!]: field('multi_select'), [mapping.description!]: field('rich_text'),
      [mapping.conceptRelation!]: { type: 'relation', relation: { data_source_id: ids.conceptDs, database_id: ids.conceptDb } },
    },
    concepts: [{ object: 'page', id: ids.conceptPage, properties: {
      [mapping.conceptId!]: textProperty('title', ids.conceptUuid),
      [mapping.conceptType!]: { type: 'select', select: { name: '일반 개념' } },
      [mapping.definition!]: textProperty('rich_text', 'A feline'),
    } }],
    terms: [
      { object: 'page', id: ids.jaPage, properties: {
        [mapping.term!]: textProperty('title', '猫'), [mapping.language!]: { type: 'select', select: { name: 'ja' } },
        [mapping.group!]: textProperty('rich_text', '기본'),
        [mapping.traits!]: { type: 'multi_select', multi_select: [{ name: '표준어' }, { name: '동물' }] },
        [mapping.description!]: textProperty('rich_text', 'Source description'),
        [mapping.conceptRelation!]: { type: 'relation', relation: [{ id: ids.conceptPage }], has_more: false },
      } },
      { object: 'page', id: ids.koPage, properties: {
        [mapping.term!]: textProperty('title', '고양이'), [mapping.language!]: { type: 'select', select: { name: 'ko' } },
        [mapping.group!]: textProperty('rich_text', '기본'), [mapping.traits!]: { type: 'multi_select', multi_select: [] },
        [mapping.description!]: textProperty('rich_text', ''),
        [mapping.conceptRelation!]: { type: 'relation', relation: [{ id: ids.conceptPage }], has_more: false },
      } },
    ],
  };
}
function setup(t: { after(fn: () => void): void }, customMapping?: Record<string, string>) {
  resetGlobals();
  const at = load('lib/glossary.js', 'lib/notion.js');
  const service = at.notionsync as Service;
  const saved: Json = {};
  const writes: Json[] = [];
  let access = '';
  at.storage = { local: {
    async get(key: string) { return structuredClone({ [key]: saved[key] }); },
    async set(values: Json) { writes.push(structuredClone(values)); Object.assign(saved, structuredClone(values)); },
    async setAccessLevel(value: { accessLevel: string }) { access = value.accessLevel; },
  } };
  const mapping = customMapping || service.defaults().mapping;
  const data = fixture(mapping);
  const calls: { path: string; body: Json | null }[] = [];
  const responses = new Map<string, Json | ((body: Json | null) => Json | Promise<Json>)>();
  responses.set(`databases/${ids.conceptDb}`, { object: 'database', id: ids.conceptDb, data_sources: [{ id: ids.conceptDs }] });
  responses.set(`databases/${ids.termDb}`, { object: 'database', id: ids.termDb, data_sources: [{ id: ids.termDs }] });
  responses.set(`data_sources/${ids.conceptDs}`, { object: 'data_source', id: ids.conceptDs, properties: data.conceptSchema });
  responses.set(`data_sources/${ids.termDs}`, { object: 'data_source', id: ids.termDs, properties: data.termSchema });
  responses.set(`data_sources/${ids.conceptDs}/query`, () => list(data.concepts));
  responses.set(`data_sources/${ids.termDs}/query`, () => list(data.terms));
  const originalFetch = globalThis.fetch;
  let failure: number | Error | null = null;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    assert.ok(url.startsWith('https://api.notion.com/v1/'));
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, `Bearer ${token}`);
    assert.equal(headers['Notion-Version'], '2025-09-03');
    assert.ok(init?.signal instanceof AbortSignal, 'every request has a deadline');
    const path = url.slice('https://api.notion.com/v1/'.length);
    const body = init?.body ? JSON.parse(String(init.body)) as Json : null;
    calls.push({ path, body });
    if (failure instanceof Error) throw failure;
    if (failure !== null) return new Response(JSON.stringify({ message: `API echoed ${token}` }), { status: failure, headers: { 'Retry-After': '0' } });
    assert.equal(init?.method, path.endsWith('/query') ? 'POST' : 'GET');
    const response = responses.get(path);
    assert.ok(response, `unexpected Notion request ${path}`);
    return new Response(JSON.stringify(typeof response === 'function' ? await response(body) : response), { status: 200 });
  };
  t.after(() => { globalThis.fetch = originalFetch; resetGlobals(); });
  async function configure(patch: Json = {}) {
    return service.saveConfig({ source: 'api', token, conceptDatabaseId: ids.conceptDb,
      termDatabaseId: ids.termDb, mapping, ...patch });
  }
  return { at, service, saved, writes, data, mapping, calls, responses, configure,
    access: () => access, fail: (value: number | Error | null) => { failure = value; } };
}

test('configuration defaults, partial secret updates, URLs and trusted storage', async t => {
  const h = setup(t);
  assert.equal(h.service.CONFIG_KEY, 'notionGlossaryConfig.v1');
  assert.equal(h.service.SNAPSHOT_KEY, 'notionGlossarySnapshot.v1');
  assert.equal(h.service.STATE_KEY, 'notionGlossaryState.v1');
  assert.deepEqual(await h.service.loadConfig(), h.service.defaults());
  assert.equal(h.service.defaults().enabled, false);
  assert.equal(h.service.defaults().intervalMinutes, 1440);
  // A fresh install is ready to sync without typing: both shared views ship
  // pre-filled and the public source is the default.
  const defaults = h.service.defaults() as Config & { ready?: unknown };
  assert.equal(defaults.source, 'public');
  assert.match(String(defaults.conceptUrl), /^https:\/\/app\.notion\.com\/p\/.+\?v=[0-9a-f]{32}$/);
  assert.match(String(defaults.termUrl), /^https:\/\/app\.notion\.com\/p\/.+\?v=[0-9a-f]{32}$/);
  assert.notEqual(defaults.conceptUrl, defaults.termUrl);
  const c = await h.configure({ conceptDatabaseId: `https://www.notion.so/workspace/Concepts-${ids.conceptDb.replaceAll('-', '')}?v=other` });
  assert.equal(c.conceptDatabaseId, ids.conceptDb);
  for (const host of ['app.notion.com', 'notion.com', 'team.notion.site', 'notion.so']) {
    const current = await h.service.saveConfig({ conceptDatabaseId: `https://${host}/p/${ids.conceptDb}?view=ignored` });
    assert.equal(current.conceptDatabaseId, ids.conceptDb);
  }
  await assert.rejects(h.service.saveConfig({ conceptDatabaseId: `https://notion.com.attacker.test/p/${ids.conceptDb}` }), /URL/);
  await assert.rejects(h.service.saveConfig({ conceptDatabaseId: `http://app.notion.com/p/${ids.conceptDb}` }), /UUID/);
  assert.equal(h.access(), 'TRUSTED_CONTEXTS');
  assert.equal((await h.service.saveConfig({ enabled: true, intervalMinutes: 0 })).token, token);
  assert.equal((await h.service.saveConfig({ token: '' })).token, '');
  await assert.rejects(h.service.saveConfig({ intervalMinutes: 1 }), /interval/);
  for (const minutes of [5, 15, 60, 360, 1440]) {
    assert.equal((await h.service.saveConfig({ intervalMinutes: minutes })).intervalMinutes, minutes);
  }
  await assert.rejects(h.service.saveConfig({ mapping: { term: '' } }), /column/);
  await assert.rejects(h.service.saveConfig({ termDatabaseId: ids.conceptDb }), /differ/);
  assert.equal((await h.service.loadConfig()).termDatabaseId, ids.termDb);
});

test('full sync joins concept PAGE IDs to UUID titles and stores canonical term fields atomically', async t => {
  const h = setup(t);
  await h.configure();
  const snapshot = await h.service.sync();
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.concepts, 1);
  assert.ok(snapshot.revision);
  assert.ok(snapshot.syncedAt > 0);
  assert.deepEqual(snapshot.entries, [
    { id: ids.jaPage, conceptId: ids.conceptUuid, language: 'ja', term: '猫', group: '기본', traits: ['표준어', '동물'], description: 'Source description' },
    { id: ids.koPage, conceptId: ids.conceptUuid, language: 'ko', term: '고양이', group: '기본', traits: [], description: '' },
  ]);
  assert.deepEqual(await h.service.loadSnapshot(), snapshot);
  assert.deepEqual(h.at.glossary.select(snapshot.entries, '猫です', 'ja', 'ko'), [{ source: '猫', target: '고양이' }]);
  assert.deepEqual(h.at.glossary.select(snapshot.entries, '猫です', 'ja', 'en'), [], 'empty target languages are valid');
  const commit = h.writes.find(value => h.service.SNAPSHOT_KEY in value)!;
  assert.deepEqual(commit[h.service.STATE_KEY], { running: false, lastAttempt: (await h.service.loadState()).lastAttempt, lastSuccess: snapshot.syncedAt, error: '' });
  assert.equal(h.writes.filter(value => h.service.SNAPSHOT_KEY in value).length, 1);
  assert.equal((await h.service.loadConfig()).enabled, false, 'manual sync does not require enabling use');
  assert.equal(h.calls.filter(call => call.path.startsWith('databases/')).length, 2);
});

test('both concept and term query cursors are followed, including an empty intermediate page', async t => {
  const h = setup(t);
  await h.configure();
  const secondConcept = structuredClone(h.data.concepts[0]!);
  secondConcept.id = ids.otherPage;
  secondConcept.properties[h.mapping.conceptId!] = textProperty('title', ids.otherUuid);
  h.data.terms[1]!.properties[h.mapping.conceptRelation!].relation = [{ id: ids.otherPage }];
  h.responses.set(`data_sources/${ids.conceptDs}/query`, body => {
    assert.equal(body?.page_size, 100);
    if (!body?.start_cursor) return list([h.data.concepts[0]!], true, 'concept-next');
    assert.equal(body.start_cursor, 'concept-next');
    return list([secondConcept]);
  });
  h.responses.set(`data_sources/${ids.termDs}/query`, body => {
    if (!body?.start_cursor) return list([h.data.terms[0]!], true, 'term-empty');
    if (body.start_cursor === 'term-empty') return list([], true, 'term-last');
    assert.equal(body.start_cursor, 'term-last');
    return list([h.data.terms[1]!]);
  });
  const snapshot = await h.service.sync();
  assert.equal(snapshot.concepts, 2);
  assert.deepEqual(snapshot.entries.map(entry => entry.conceptId), [ids.conceptUuid, ids.otherUuid]);
  assert.deepEqual(h.at.glossary.select(snapshot.entries, '猫', 'ja', 'ko'), [], 'joining different concepts never invents a target');
  assert.equal(h.calls.filter(call => call.path.endsWith('/query')).length, 5);
});

test('all custom schema mappings govern retrieval and parsing, including rich-text term columns', async t => {
  const mapping = { conceptId: 'UUID', conceptType: 'Kind', definition: 'Meaning', term: 'Written', language: 'Locale', conceptRelation: 'Concept', group: 'Variant', traits: 'Flags', description: 'Notes' };
  const h = setup(t, mapping);
  h.data.termSchema.Written.type = 'rich_text';
  h.data.termSchema.Written.rich_text = {};
  h.data.terms.forEach(page => { page.properties.Written = textProperty('rich_text', page.id === ids.jaPage ? '猫' : '고양이'); });
  await h.configure();
  const snapshot = await h.service.sync();
  assert.equal(snapshot.entries[0]!.term, '猫');
  assert.equal(snapshot.entries[0]!.conceptId, ids.conceptUuid);
  assert.deepEqual(snapshot.entries[0]!.traits, ['표준어', '동물']);
  assert.deepEqual(h.at.glossary.select(snapshot.entries, '猫', 'ja', 'ko'), [{ source: '猫', target: '고양이' }]);
});

test('missing or invalid required columns fail before querying rows', async t => {
  for (const variant of ['missing', 'language-text', 'group-select', 'uuid-number', 'traits-text']) {
    await t.test(variant, async sub => {
      const h = setup(sub);
      await h.configure();
      if (variant === 'missing') delete h.data.termSchema[h.mapping.group!];
      if (variant === 'language-text') h.data.termSchema[h.mapping.language!].type = 'rich_text';
      if (variant === 'group-select') h.data.termSchema[h.mapping.group!].type = 'select';
      if (variant === 'uuid-number') h.data.conceptSchema[h.mapping.conceptId!].type = 'number';
      if (variant === 'traits-text') h.data.termSchema[h.mapping.traits!].type = 'rich_text';
      await assert.rejects(h.service.sync(), /column/);
      assert.equal(h.calls.filter(call => call.path.endsWith('/query')).length, 0);
      assert.equal(await h.service.loadSnapshot(), null);
    });
  }
});

test('relation schema supports database-only and data-source targets, rejects mismatches and inaccessible targets', async t => {
  for (const variant of ['database-only', 'source-only', 'wrong-database', 'wrong-source', 'inaccessible']) {
    await t.test(variant, async sub => {
      const h = setup(sub);
      await h.configure();
      h.data.termSchema[h.mapping.conceptRelation!].relation = variant === 'database-only' ? { database_id: ids.conceptDb }
        : variant === 'source-only' ? { data_source_id: ids.conceptDs }
          : variant === 'wrong-database' ? { database_id: ids.termDb }
            : variant === 'wrong-source' ? { data_source_id: ids.termDs } : {};
      if (variant.endsWith('-only')) assert.equal((await h.service.sync()).entries.length, 2);
      else await assert.rejects(h.service.sync(), /relation/);
    });
  }
});

test('multiple data sources require explicit selection belonging to that database', async t => {
  const h = setup(t);
  await h.configure();
  h.responses.set(`databases/${ids.conceptDb}`, { object: 'database', id: ids.conceptDb, data_sources: [{ id: ids.conceptDs }, { id: ids.otherPage }] });
  await assert.rejects(h.service.sync(), /data source/);
  await h.service.saveConfig({ conceptDataSourceId: ids.termDs });
  await assert.rejects(h.service.sync(), /data source/);
  await h.service.saveConfig({ conceptDataSourceId: ids.conceptDs });
  assert.equal((await h.service.sync()).entries.length, 2);
});

test('failed full sync preserves the previous snapshot and never persists or returns credential echoes', async t => {
  const h = setup(t);
  await h.configure();
  const old = await h.service.sync();
  for (const failure of [401, 403, 404, 429, 500, new Error(`network echoed ${token}`)]) {
    h.fail(failure);
    await assert.rejects(h.service.sync(), error => {
      assert.equal(String(error).includes(token), false);
      return true;
    });
    assert.deepEqual(await h.service.loadSnapshot(), old);
    const state = await h.service.loadState();
    assert.equal(state.running, false);
    assert.equal(state.lastSuccess, old.syncedAt);
    assert.ok(state.error);
    assert.equal(JSON.stringify(state).includes(token), false);
  }
  assert.equal(h.writes.filter(value => h.service.SNAPSHOT_KEY in value).length, 1);
});

test('overlapping sync calls coalesce and a changed configuration cannot commit stale results', async t => {
  const h = setup(t);
  await h.configure();
  const old = await h.service.sync();
  const entered = deferred();
  const release = deferred<Json>();
  h.responses.set(`data_sources/${ids.termDs}/query`, async () => { entered.resolve(); return release.promise; });
  const first = h.service.sync();
  const joined = h.service.sync();
  assert.equal(first, joined);
  await entered.promise;
  assert.equal((await h.service.loadState()).running, true);
  await h.service.saveConfig({ mapping: { group: 'Changed group' } });
  // Even reverting to the original config must invalidate the prior in-flight work.
  await h.service.saveConfig({ mapping: { group: h.mapping.group } });
  const rejected = assert.rejects(first, /configuration changed/);
  release.resolve(list(h.data.terms));
  await rejected;
  assert.deepEqual(await h.service.loadSnapshot(), old);
  assert.equal((await h.service.loadState()).running, false);
  h.responses.set(`data_sources/${ids.termDs}/query`, () => list(h.data.terms));
  const fresh = await h.service.sync();
  assert.equal(fresh.revision, old.revision, 'unchanged canonical content retains its revision');
  assert.equal(h.writes.filter(value => h.service.SNAPSHOT_KEY in value).length, 2);
});

test('direct storage config changes invalidate a sync and stale worker running state is normalized', async t => {
  const h = setup(t);
  await h.configure();
  h.saved[h.service.STATE_KEY] = { running: true, lastAttempt: 12, lastSuccess: 10, error: '' };
  assert.equal((await h.service.loadState()).running, false);
  const entered = deferred();
  const release = deferred<Json>();
  h.responses.set(`data_sources/${ids.termDs}/query`, async () => { entered.resolve(); return release.promise; });
  const running = h.service.sync();
  await entered.promise;
  h.saved[h.service.CONFIG_KEY].enabled = true;
  const rejected = assert.rejects(running, /configuration changed/);
  release.resolve(list(h.data.terms));
  await rejected;
  assert.equal(await h.service.loadSnapshot(), null);
});

test('truncated or invalid relation/row values explicitly fail and retain the old snapshot', async t => {
  for (const variant of ['truncated', 'uuid-not-page', 'missing-target', 'two-concepts', 'empty-group', 'invalid-language', 'invalid-uuid']) {
    await t.test(variant, async sub => {
      const h = setup(sub);
      await h.configure();
      const old = await h.service.sync();
      const props = h.data.terms[0]!.properties;
      if (variant === 'truncated') props[h.mapping.conceptRelation!].has_more = true;
      if (variant === 'uuid-not-page') props[h.mapping.conceptRelation!].relation = [{ id: ids.conceptUuid }];
      if (variant === 'missing-target') props[h.mapping.conceptRelation!].relation = [];
      if (variant === 'two-concepts') props[h.mapping.conceptRelation!].relation.push({ id: ids.otherPage });
      if (variant === 'empty-group') props[h.mapping.group!] = textProperty('rich_text', '');
      if (variant === 'invalid-language') props[h.mapping.language!].select.name = 'ja_XX invalid';
      if (variant === 'invalid-uuid') h.data.concepts[0]!.properties[h.mapping.conceptId!] = textProperty('title', 'not-a-uuid');
      await assert.rejects(h.service.sync());
      assert.deepEqual(await h.service.loadSnapshot(), old);
      assert.equal((await h.service.loadState()).running, false);
    });
  }
});

test('pagination cannot silently commit incomplete, cyclic, duplicate or inconsistent results', async t => {
  for (const variant of ['missing-cursor', 'cycle', 'duplicate', 'inconsistent', 'missing-has-more', 'request-incomplete']) {
    await t.test(variant, async sub => {
      const h = setup(sub);
      await h.configure();
      const old = await h.service.sync();
      let n = 0;
      h.responses.set(`data_sources/${ids.termDs}/query`, () => {
        n++;
        if (variant === 'missing-cursor') return list(h.data.terms, true, null);
        if (variant === 'cycle') return list([], true, 'same');
        if (variant === 'duplicate') return list([h.data.terms[0]!], n === 1, n === 1 ? 'next' : null);
        if (variant === 'missing-has-more') return { object: 'list', results: h.data.terms };
        if (variant === 'request-incomplete') return { ...list(h.data.terms), request_status: { type: 'incomplete', incomplete: {} } };
        return list(h.data.terms, false, 'unexpected');
      });
      await assert.rejects(h.service.sync(), /pagination/);
      assert.deepEqual(await h.service.loadSnapshot(), old);
    });
  }
});

test('inactive rows are excluded and an empty active full sync replaces rather than merges snapshots', async t => {
  const h = setup(t);
  await h.configure();
  const old = await h.service.sync();
  assert.equal(old.entries.length, 2);
  h.data.terms[1]!.in_trash = true;
  const active = await h.service.sync();
  assert.equal(active.entries.length, 1);
  h.data.terms[0]!.archived = true;
  h.data.concepts[0]!.archived = true;
  const empty = await h.service.sync();
  assert.equal(empty.concepts, 0);
  assert.deepEqual(empty.entries, []);
  assert.deepEqual(await h.service.loadSnapshot(), empty);
});

test('canonical content revisions remain stable across identical syncs and row order, and change with terminology', async t => {
  const h = setup(t);
  await h.configure();
  const first = await h.service.sync();
  assert.match(first.revision, /^[0-9a-f]{64}$/);
  h.data.terms.reverse();
  const identical = await h.service.sync();
  assert.equal(identical.revision, first.revision);
  assert.ok(identical.syncedAt >= first.syncedAt);
  const target = h.data.terms.find(page => page.id === ids.koPage)!;
  target.properties[h.mapping.term!] = textProperty('title', '야옹이');
  const changed = await h.service.sync();
  assert.notEqual(changed.revision, first.revision);
  assert.deepEqual(h.at.glossary.select(changed.entries, '猫', 'ja', 'ko'), [{ source: '猫', target: '야옹이' }]);
});

test('property-ID mappings survive schema and row display-name changes and percent-encoded IDs', async t => {
  const h = setup(t);
  const mappings: Record<string, string> = {};
  for (const [schema, rows, prefix] of [
    [h.data.conceptSchema, h.data.concepts, 'c'],
    [h.data.termSchema, h.data.terms, 't'],
  ] as const) {
    let index = 0;
    for (const [name, field] of Object.entries(schema) as [string, Json][]) {
      const id = `${prefix}:${index++}`;
      field.id = encodeURIComponent(id);
      field.name = `Renamed ${name}`;
      const key = Object.keys(h.mapping).find(key => h.mapping[key] === name)!;
      mappings[key] = id;
      delete schema[name];
      schema[`Renamed ${name}`] = field;
      for (const page of rows) {
        const value = page.properties[name];
        value.id = id;
        delete page.properties[name];
        page.properties[`Row display ${name}`] = value;
      }
    }
  }
  await h.configure({ mapping: mappings });
  const snapshot = await h.service.sync();
  assert.equal(snapshot.entries[0]!.conceptId, ids.conceptUuid);
  assert.deepEqual(h.at.glossary.select(snapshot.entries, '猫', 'ja', 'ko'), [{ source: '猫', target: '고양이' }]);
  await h.service.saveConfig({ mapping: { term: 'Renamed 용어' } });
  assert.equal((await h.service.sync()).revision, snapshot.revision, 'name and ID mappings produce identical canonical entries');
});

test('BCP47 select languages beyond the example languages parse and match through native aliases', async t => {
  const h = setup(t);
  await h.configure();
  h.data.terms[0]!.properties[h.mapping.language!].select.name = 'zh-hant-tw';
  h.data.terms[0]!.properties[h.mapping.term!] = textProperty('title', '貓');
  h.data.terms[1]!.properties[h.mapping.language!].select.name = 'fr-fr';
  h.data.terms[1]!.properties[h.mapping.term!] = textProperty('title', 'chat');
  const snapshot = await h.service.sync();
  assert.deepEqual(snapshot.entries.map(entry => entry.language), ['zh-Hant-TW', 'fr-FR']);
  assert.deepEqual(h.at.glossary.select(snapshot.entries, '貓', 'zh-TW', 'fr-CA'), [{ source: '貓', target: 'chat' }]);
});

test('rate-limited requests honor Retry-After and recover, without retrying access failures', async t => {
  const h = setup(t);
  await h.configure();
  const baseFetch = globalThis.fetch;
  const originalTimer = globalThis.setTimeout;
  const waits: number[] = [];
  t.mock.method(globalThis, 'setTimeout', (callback: (...args: unknown[]) => void, milliseconds?: number, ...args: unknown[]) => {
    if (milliseconds !== 20000) waits.push(milliseconds || 0);
    return originalTimer(callback, milliseconds === 20000 ? milliseconds : 0, ...args);
  });
  let limited = false;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith(`data_sources/${ids.termDs}/query`) && !limited) {
      limited = true;
      return new Response(JSON.stringify({ message: token }), { status: 429, headers: { 'Retry-After': '0.25' } });
    }
    return baseFetch(input, init);
  };
  const snapshot = await h.service.sync();
  assert.equal(snapshot.entries.length, 2);
  assert.deepEqual(waits, [250]);
  h.fail(403);
  const before = h.calls.length;
  await assert.rejects(h.service.sync(), /access denied/);
  assert.equal(h.calls.length - before, 1, 'access failures are never retried');
  assert.equal((await h.service.loadState()).error.includes(token), false);
});

test('persistent rate limits and excessive Retry-After fail finitely without replacing snapshots', async t => {
  const h = setup(t);
  await h.configure();
  const previous = await h.service.sync();
  h.fail(429);
  const before = h.calls.length;
  await assert.rejects(h.service.sync(), /bounded retries/);
  assert.equal(h.calls.length - before, 4);
  assert.deepEqual(await h.service.loadSnapshot(), previous);
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ message: token }), { status: 429, headers: { 'Retry-After': '31' } });
  };
  await assert.rejects(h.service.sync(), /30-second bound/);
  assert.equal(calls, 1, 'server-requested delays are never shortened to force retries');
  assert.deepEqual(await h.service.loadSnapshot(), previous);
  assert.equal((await h.service.loadState()).error.includes(token), false);
});

// --- shared-page source (no token) -----------------------------------------

const publicIds = {
  space: '99999999-9999-9999-9999-999999999999',
  conceptBlock: 'aaaaaaaa-1111-1111-1111-111111111111',
  conceptView: 'aaaaaaaa-2222-2222-2222-222222222222',
  termBlock: 'bbbbbbbb-1111-1111-1111-111111111111',
  termView: 'bbbbbbbb-2222-2222-2222-222222222222',
  conceptColl: 'cccccccc-1111-1111-1111-111111111111',
  termColl: 'dddddddd-1111-1111-1111-111111111111',
  conceptPage: 'eeeeeeee-1111-1111-1111-111111111111',
  jaPage: 'eeeeeeee-2222-2222-2222-222222222222',
  koPage: 'eeeeeeee-3333-3333-3333-333333333333',
};
const conceptUrl = `https://app.notion.com/p/ws/${publicIds.conceptBlock}?v=${publicIds.conceptView}`;
const termUrl = `https://app.notion.com/p/ws/${publicIds.termBlock}?v=${publicIds.termView}`;

/** A shared page as its own viewer sees it: schema by property id, rows by
 *  segment arrays, and a first response that carries only part of the rows. */
function publicSetup(t: { after(fn: () => void): void }) {
  resetGlobals();
  const at = load('lib/glossary.js', 'lib/notion.js');
  const service = at.notionsync as Service & { ready(config: Json): boolean };
  const saved: Json = {};
  at.storage = { local: {
    async get(key: string) { return structuredClone({ [key]: saved[key] }); },
    async set(values: Json) { Object.assign(saved, structuredClone(values)); },
    async setAccessLevel() { return undefined; },
  } };
  const m = service.defaults().mapping;
  const conceptSchema = { pTitle: { name: m.conceptId, type: 'title' }, pType: { name: m.conceptType, type: 'select' },
    pDef: { name: m.definition, type: 'rich_text' } };
  const termSchema = { pTerm: { name: m.term, type: 'title' }, pLang: { name: m.language, type: 'select' },
    pGroup: { name: m.group, type: 'rich_text' }, pTraits: { name: m.traits, type: 'multi_select' },
    pDesc: { name: m.description, type: 'rich_text' }, pRel: { name: m.conceptRelation, type: 'relation' } };
  const page = (id: string, properties: Json, alive = true): Json => ({ value: { value: { id, type: 'page', alive, properties } } });
  const conceptRows: Record<string, Json> = {
    [publicIds.conceptPage]: page(publicIds.conceptPage, {
      pTitle: [[publicIds.conceptPage]], pType: [['일반']], pDef: [['A feline']]
    })
  };
  const termRows: Record<string, Json> = {
    [publicIds.jaPage]: page(publicIds.jaPage, {
      pTerm: [['猫']], pLang: [['ja']], pGroup: [['기본']], pTraits: [['표준어']], pDesc: [['Source description']],
      pRel: [['‣', [['p', publicIds.conceptPage, publicIds.space]]]]
    }),
    [publicIds.koPage]: page(publicIds.koPage, {
      pTerm: [['고양이']], pLang: [['ko']], pGroup: [['기본']], pTraits: [], pDesc: [['']],
      pRel: [['‣', [['p', publicIds.conceptPage, publicIds.space]]]]
    })
  };
  const calls: { path: string; body: Json }[] = [];
  const originalFetch = globalThis.fetch;
  let requireLogin = false;
  let withholdBodies = 0;   // how many row bodies the viewer response omits
  let dropFromBatch = '';   // a row the batch endpoint also refuses to return
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    assert.ok(url.startsWith('https://app.notion.com/api/v3/'), url);
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, undefined, 'the shared-page path never sends a credential');
    assert.ok(init?.signal instanceof AbortSignal);
    const path = url.slice('https://app.notion.com/api/v3/'.length);
    const body = JSON.parse(String(init?.body)) as Json;
    calls.push({ path, body });
    const reply = (value: Json) => new Response(JSON.stringify(value), { status: 200 });
    if (path === 'getPublicPageData') return reply({ spaceId: publicIds.space, requireLogin });
    if (path === 'queryCollection') {
      const isConcept = String((body.collectionView as Json).id) === publicIds.conceptView;
      if (!body.loader) {
        const id = isConcept ? publicIds.conceptColl : publicIds.termColl;
        return reply({ collectionIds: [id], recordMap: { collection: { [id]: { value: { value: {
          id, schema: isConcept ? conceptSchema : termSchema } } } }, block: {} } });
      }
      const rows = isConcept ? conceptRows : termRows;
      const ids = Object.keys(rows);
      const carried: Json = {};
      for (const id of ids.slice(0, Math.max(0, ids.length - withholdBodies))) carried[id] = rows[id];
      return reply({ result: { reducerResults: { collection_group_results: { type: 'results', blockIds: ids, hasMore: false } } },
        recordMap: { block: carried } });
    }
    if (path === 'syncRecordValues') {
      const carried: Json = {};
      for (const request of body.requests as Json[]) {
        const id = String((request.pointer as Json).id);
        const row = conceptRows[id] ?? termRows[id];
        if (row && id !== dropFromBatch) carried[id] = row;
      }
      return reply({ recordMap: { block: carried } });
    }
    return new Response('{}', { status: 404 });
  };
  t.after(() => { globalThis.fetch = originalFetch; resetGlobals(); });
  return { service, saved, calls, m,
    configure: (patch: Json = {}) => service.saveConfig({ source: 'public', enabled: true,
      conceptUrl, termUrl, mapping: m, intervalMinutes: 15, ...patch }),
    requireLogin: (value: boolean) => { requireLogin = value; },
    withhold: (count: number) => { withholdBodies = count; },
    drop: (id: string) => { dropFromBatch = id; } };
}

test('a shared page syncs without a token, batches missing rows and keeps the API out', async t => {
  const h = publicSetup(t);
  h.withhold(1);
  await h.configure();
  const snapshot = await h.service.sync();
  assert.equal(snapshot.entries.length, 2);
  assert.equal(snapshot.concepts, 1);
  const byTerm = new Map(snapshot.entries.map(entry => [entry.term, entry]));
  assert.deepEqual([...byTerm.keys()].sort(), ['고양이', '猫'].sort(), 'every row reaches the dictionary');
  assert.equal(byTerm.get('猫')!.conceptId, publicIds.conceptPage, 'the relation resolves to the concept title');
  assert.equal(byTerm.get('고양이')!.conceptId, publicIds.conceptPage);
  assert.deepEqual(byTerm.get('猫')!.traits, ['표준어']);
  assert.equal(byTerm.get('猫')!.description, 'Source description');
  assert.ok(h.calls.some(call => call.path === 'syncRecordValues'), 'rows the viewer omitted are fetched in a batch');
  assert.ok(!h.calls.some(call => String(call.body).includes('token')), 'no credential travels');
  assert.equal(h.saved['notionGlossarySnapshot.v1'].revision, snapshot.revision);
});

test('a shared page that requires login or hides a row fails without replacing the dictionary', async t => {
  const h = publicSetup(t);
  await h.configure();
  const first = await h.service.sync();
  h.requireLogin(true);
  await assert.rejects(h.service.sync(), /requires a login/);
  h.requireLogin(false);
  h.withhold(2);
  h.drop(publicIds.koPage);
  await assert.rejects(h.service.sync(), /without part of its data/);
  assert.equal(h.saved['notionGlossarySnapshot.v1'].revision, first.revision, 'the last complete dictionary survives');
});

test('a public URL needs its view identifier and a Notion host', async t => {
  const h = publicSetup(t);
  await assert.rejects(h.configure({ termUrl: publicIds.termBlock }), /page and view identifiers|URL/);
  await assert.rejects(h.configure({ termUrl: `https://example.test/p/ws/${publicIds.termBlock}?v=${publicIds.termView}` }), /URL/);
  const saved = await h.configure() as Config & { source: string };
  assert.equal(saved.source, 'public');
  assert.equal(h.service.ready(saved), true, 'a public configuration needs no token');
  assert.equal(h.service.ready({ ...saved, termUrl: '' }), false);
});

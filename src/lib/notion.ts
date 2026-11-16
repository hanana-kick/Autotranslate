// Trusted-background-only service. Uses the official data-source API (2025-09-03).
namespace AT.notionsync {
  export const CONFIG_KEY = 'notionGlossaryConfig.v1';
  export const SNAPSHOT_KEY = 'notionGlossarySnapshot.v1';
  export const STATE_KEY = 'notionGlossaryState.v1';
  export type Mapping = {
    conceptId: string; conceptType: string; definition: string; term: string;
    language: string; conceptRelation: string; group: string; traits: string; description: string;
  };
  export type Config = {
    enabled: boolean; token: string; conceptDatabaseId: string; termDatabaseId: string;
    conceptDataSourceId: string; termDataSourceId: string; intervalMinutes: number; mapping: Mapping;
    /** 'api' reads the official API with an integration token; 'public' reads a
     *  shared page through the same viewer endpoints the page itself calls. */
    source: 'api' | 'public';
    conceptUrl: string; termUrl: string;
  };
  export type Snapshot = { version: 1; revision: string; syncedAt: number; concepts: number; entries: AT.glossary.Entry[] };
  export type SyncState = { running: boolean; lastAttempt: number; lastSuccess: number; error: string };

  type ObjectValue = { [key: string]: unknown };
  const mappingKeys: (keyof Mapping)[] = ['conceptId', 'conceptType', 'definition', 'term', 'language', 'conceptRelation', 'group', 'traits', 'description'];
  const idKeys = ['conceptDatabaseId', 'termDatabaseId', 'conceptDataSourceId', 'termDataSourceId'] as const;
  let queue: Promise<unknown> = Promise.resolve();
  let flight: Promise<Snapshot> | null = null;
  let generation = 0;

  // Error text never includes API bodies, credentials, column names or fetched content.
  class SyncError extends Error {}
  function fail(message: string): never { throw new SyncError(message); }
  function object(value: unknown): ObjectValue {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Invalid Notion response or configuration');
    return value as ObjectValue;
  }
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation);
    queue = result.catch(() => undefined);
    return result;
  }
  function store(): NonNullable<AT.StorageApi>['local'] {
    if (!AT.storage?.local) fail('Trusted local storage is unavailable');
    return AT.storage.local;
  }
  async function trusted(): Promise<void> {
    await store().setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
  }
  async function get(key: string): Promise<unknown> { return (await store().get(key))[key]; }

  /** The published dictionary, so a fresh install is ready to sync with no
   *  typing: both shared views are pre-filled and public is the default source. */
  const DEFAULT_CONCEPT_URL = 'https://app.notion.com/p/hananakick/8cfa6c6494fa4947b47c1501eda730ea?v=02afa4a14c9a4077b3dfbf76981b86d0';
  const DEFAULT_TERM_URL = 'https://app.notion.com/p/hananakick/bdf159324cb441fca20a5fb39e515f91?v=e5bfbcb484f14b048c7299035dfd790d';

  export function defaults(): Config {
    return {
      enabled: false, token: '', conceptDatabaseId: '', termDatabaseId: '',
      conceptDataSourceId: '', termDataSourceId: '', intervalMinutes: 1440,
      source: 'public', conceptUrl: DEFAULT_CONCEPT_URL, termUrl: DEFAULT_TERM_URL,
      mapping: { conceptId: '개념 ID', conceptType: '개념 유형', definition: '정의', term: '용어',
        language: '언어', conceptRelation: '원문', group: '표현 묶음', traits: '표현 특성', description: '설명' },
    };
  }
  function uuid(value: unknown): string {
    if (typeof value !== 'string') fail('A valid Notion UUID is required');
    const hex = value.replace(/-/g, '').toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(hex)) fail('A valid Notion UUID is required');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  function configId(value: string): string {
    if (!value.trim()) return '';
    let raw = value.trim();
    if (/^https:\/\//i.test(raw)) {
      let url: URL;
      try { url = new URL(raw); } catch { return fail('Invalid Notion database URL'); }
      if (!['notion.com', 'notion.so', 'notion.site'].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) fail('Invalid Notion database URL');
      const tail = url.pathname.replace(/\/$/, '').split('/').at(-1) || '';
      raw = tail.match(/([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)?.[1] || '';
    }
    return uuid(raw);
  }
  /** Whether this configuration can sync at all, for its own source mode. */
  export function ready(c: Config): boolean {
    if (!c.enabled) return false;
    return c.source === 'public'
      ? Boolean(c.conceptUrl && c.termUrl)
      : Boolean(c.token && c.conceptDatabaseId && c.termDatabaseId);
  }
  function config(patch: unknown, previous: Config): Config {
    const input = object(patch);
    const out = { ...previous, mapping: { ...previous.mapping } };
    if ('enabled' in input) {
      if (typeof input.enabled !== 'boolean') fail('Invalid Notion enabled setting');
      out.enabled = input.enabled;
    }
    if ('source' in input) {
      if (input.source !== 'api' && input.source !== 'public') fail('Invalid Notion source');
      out.source = input.source;
    }
    for (const key of ['conceptUrl', 'termUrl'] as const) {
      if (!(key in input)) continue;
      if (typeof input[key] !== 'string') fail('Invalid public Notion URL');
      out[key] = input[key].trim();
      if (out[key]) viewRef(out[key]);
    }
    if ('token' in input) {
      if (typeof input.token !== 'string' || /[\r\n]/.test(input.token)) fail('Invalid Notion token');
      out.token = input.token.trim();
    }
    for (const key of idKeys) {
      if (!(key in input)) continue;
      if (typeof input[key] !== 'string') fail('Invalid Notion database identifier');
      out[key] = configId(input[key]);
    }
    if ('intervalMinutes' in input) {
      if (typeof input.intervalMinutes !== 'number' || ![0, 5, 15, 60, 360, 1440].includes(input.intervalMinutes)) fail('Invalid Notion sync interval');
      out.intervalMinutes = input.intervalMinutes;
    }
    if ('mapping' in input) {
      const map = object(input.mapping);
      for (const key of mappingKeys) {
        if (!(key in map)) continue;
        if (typeof map[key] !== 'string' || !map[key].trim()) fail('All configured Notion column names are required');
        out.mapping[key] = map[key].trim();
      }
    }
    if (out.conceptDatabaseId && out.conceptDatabaseId === out.termDatabaseId) fail('Concept and term databases must differ');
    if (out.conceptDataSourceId && out.conceptDataSourceId === out.termDataSourceId) fail('Concept and term data sources must differ');
    return out;
  }
  export async function loadConfig(): Promise<Config> {
    const saved = await get(CONFIG_KEY);
    return saved === undefined ? defaults() : config(saved, defaults());
  }
  export function saveConfig(patch: unknown): Promise<Config> {
    return serial(async () => {
      await trusted();
      const previous = await loadConfig();
      const next = config(patch, previous);
      await store().set({ [CONFIG_KEY]: next });
      if (JSON.stringify(previous) !== JSON.stringify(next)) generation++;
      return next;
    });
  }
  function entry(value: unknown): AT.glossary.Entry {
    const item = object(value);
    for (const key of ['id', 'conceptId', 'language', 'term', 'group', 'description']) {
      if (typeof item[key] !== 'string') fail('Invalid local glossary snapshot');
    }
    if (!Array.isArray(item.traits) || !item.traits.every(value => typeof value === 'string')) fail('Invalid local glossary snapshot');
    return item as AT.glossary.Entry;
  }
  export async function loadSnapshot(): Promise<Snapshot | null> {
    const saved = await get(SNAPSHOT_KEY);
    if (saved === undefined || saved === null) return null;
    const snapshot = object(saved);
    if (snapshot.version !== 1 || typeof snapshot.revision !== 'string' || typeof snapshot.syncedAt !== 'number' || typeof snapshot.concepts !== 'number' || !Array.isArray(snapshot.entries)) fail('Invalid local glossary snapshot');
    snapshot.entries.forEach(entry);
    return snapshot as Snapshot;
  }
  export async function loadState(): Promise<SyncState> {
    const saved = await get(STATE_KEY);
    const state = saved && typeof saved === 'object' ? saved as Partial<SyncState> : {};
    return {
      running: !!flight && state.running === true,
      lastAttempt: typeof state.lastAttempt === 'number' ? state.lastAttempt : 0,
      lastSuccess: typeof state.lastSuccess === 'number' ? state.lastSuccess : 0,
      error: typeof state.error === 'string' ? state.error : '',
    };
  }

  async function request(token: string, path: string, body?: ObjectValue): Promise<ObjectValue> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      let retryMilliseconds = 0;
      try {
        const response = await fetch(`https://api.notion.com/v1/${path}`, {
          method: body ? 'POST' : 'GET',
          headers: { Authorization: `Bearer ${token}`, 'Notion-Version': '2025-09-03', 'Content-Type': 'application/json' },
          signal: controller.signal,
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        if (response.status === 429) {
          if (attempt === 3) fail('Notion rate limit persisted after bounded retries; previous snapshot retained');
          const header = response.headers.get('Retry-After');
          const seconds = header === null ? 1 : /^\d+(?:\.\d+)?$/.test(header.trim())
            ? Number(header) : (Date.parse(header) - Date.now()) / 1000;
          // Never shorten a server-requested delay to fit our retry bound.
          if (!Number.isFinite(seconds) || seconds < 0 || seconds > 30) fail('Notion rate-limit retry delay is invalid or exceeds the 30-second bound');
          retryMilliseconds = Math.ceil(seconds * 1000);
        } else {
          if (!response.ok) {
            if (response.status === 401 || response.status === 403 || response.status === 404) fail('Notion access denied: check the integration token and share both databases and their relation targets');
            fail(`Notion request failed (HTTP ${response.status})`);
          }
          return object(await response.json());
        }
      } catch (error) {
        if (error instanceof SyncError) throw error;
        fail(controller.signal.aborted ? 'Notion request timed out' : 'Notion request or response failed');
      } finally { clearTimeout(timer); }
      const delay = Promise.withResolvers<void>();
      setTimeout(delay.resolve, retryMilliseconds);
      await delay.promise;
    }
    return fail('Notion request retry limit exceeded');
  }
  /** What one shared page URL identifies: the workspace, the page block and the
   *  collection view. These are exactly the fields its own viewer posts. */
  type ViewRef = { spaceDomain: string; blockId: string; viewId: string };

  function viewRef(value: string): ViewRef {
    let url: URL;
    try { url = new URL(value.trim()); } catch { return fail('Invalid public Notion URL'); }
    if (url.protocol !== 'https:') fail('Invalid public Notion URL');
    const id = (raw: string | null): string => {
      const hex = (raw ?? '').replace(/-/g, '');
      if (!/^[0-9a-f]{32}$/i.test(hex)) return fail('A public Notion URL needs the page and view identifiers');
      return uuid(hex);
    };
    const viewId = id(url.searchParams.get('v'));
    let spaceDomain: string;
    if (url.hostname === 'app.notion.com' || url.hostname === 'notion.so' || url.hostname === 'www.notion.so') {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] !== 'p' || !parts[1]) return fail('Invalid public Notion URL');
      spaceDomain = decodeURIComponent(parts[1]);
    } else if (url.hostname.endsWith('.notion.site')) {
      spaceDomain = url.hostname.slice(0, -'.notion.site'.length);
    } else {
      return fail('Invalid public Notion URL');
    }
    const tail = url.pathname.replace(/\/$/, '').split('/').at(-1) ?? '';
    return { spaceDomain, blockId: id(tail.match(/[0-9a-f-]{32,36}$/i)?.[0] ?? ''), viewId };
  }

  /** The shared page's own viewer endpoints. No credential is sent because the
   *  page itself sends none; a private page answers as unreadable instead. */
  async function publicRequest(path: string, body: ObjectValue): Promise<ObjectValue> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      let retryMilliseconds = 1000;
      try {
        const response = await fetch(`https://app.notion.com/api/v3/${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'notion-audit-log-platform': 'web',
            'x-notion-active-user-header': ''
          },
          signal: controller.signal,
          body: JSON.stringify(body)
        });
        if (response.status === 429 || response.status >= 500) {
          if (attempt === 3) fail('Notion rate limit or server error persisted; previous snapshot retained');
          const header = response.headers.get('Retry-After');
          retryMilliseconds = header && /^\d+(?:\.\d+)?$/.test(header.trim())
            ? Math.min(30000, Math.ceil(Number(header) * 1000)) : 1000 * (attempt + 1);
        } else {
          if (response.status === 401 || response.status === 403 || response.status === 404) {
            fail('The shared page is not readable: publish it with "Share to web" and use its page URL with the view parameter');
          }
          if (!response.ok) fail(`Notion public request failed (HTTP ${response.status})`);
          return object(await response.json());
        }
      } catch (error) {
        if (error instanceof SyncError) throw error;
        fail(controller.signal.aborted ? 'Notion public request timed out' : 'Notion public request or response failed');
      } finally { clearTimeout(timer); }
      const delay = Promise.withResolvers<void>();
      setTimeout(delay.resolve, retryMilliseconds);
      await delay.promise;
    }
    return fail('Notion public request retry limit exceeded');
  }

  function record(recordMap: ObjectValue, table: string, id: string): ObjectValue {
    const entry = object(object(recordMap)[table])[id];
    if (!entry) fail('The shared page responded without part of its data');
    const first = object(entry);
    const value = object(first.value);
    return object(value.value ?? value);
  }

  /** Internal block segments become the property objects the API path reads. */
  function publicProperty(type: string, segments: unknown): ObjectValue {
    if (!Array.isArray(segments)) fail('Invalid shared page property');
    if (type === 'title' || type === 'rich_text') {
      const parts = segments.map(segment => {
        if (!Array.isArray(segment) || typeof segment[0] !== 'string') fail('Invalid shared page text');
        return { plain_text: segment[0] };
      });
      return { type, [type]: parts };
    }
    if (type === 'multi_select') {
      // The viewer joins several options into one comma-separated value.
      const names: string[] = [];
      for (const segment of segments) {
        if (!Array.isArray(segment) || typeof segment[0] !== 'string') fail('Invalid shared page option');
        for (const name of segment[0].split(',')) if (name.trim()) names.push(name.trim());
      }
      return { type, multi_select: names.map(name => ({ name })) };
    }
    if (type === 'select') {
      const first = segments[0];
      if (!Array.isArray(first) || typeof first[0] !== 'string') fail('Invalid shared page option');
      return { type, select: { name: first[0] } };
    }
    if (type === 'relation') {
      const ids: { id: string }[] = [];
      for (const segment of segments) {
        if (!Array.isArray(segment) || !Array.isArray(segment[1])) continue;
        for (const pointer of segment[1]) {
          if (Array.isArray(pointer) && typeof pointer[1] === 'string') ids.push({ id: uuid(pointer[1]) });
        }
      }
      return { type, relation: ids };
    }
    return fail('A mapped shared-page column has an unsupported type');
  }

  async function publicCollection(value: string): Promise<{ schema: ObjectValue; pages: ObjectValue[] }> {
    const ref = viewRef(value);
    const page = await publicRequest('getPublicPageData', {
      type: 'block-space', name: 'page', blockId: ref.blockId, spaceDomain: ref.spaceDomain,
      requestedOnPublicDomain: false, requestedOnAlternateDomain: true, collectionViewId: ref.viewId,
      showMoveTo: false, saveParent: false, shouldDuplicate: false, projectManagementLaunch: false,
      configureOpenInDesktopApp: false, mobileData: { isPush: false }, demoWorkspaceMode: false
    });
    if (page.requireLogin === true) fail('The shared page requires a login; publish it with "Share to web"');
    const spaceId = uuid(page.spaceId);
    const first = await publicRequest('queryCollection', {
      collectionView: { id: ref.viewId }, collectionViewBlock: { id: ref.blockId },
      clientType: 'notion_app', userTimeZone: timezone(), isFullScreen: true, isMobile: false
    });
    const collectionIds = Array.isArray(first.collectionIds) ? first.collectionIds : [];
    if (collectionIds.length !== 1 || typeof collectionIds[0] !== 'string') {
      fail('The shared page does not contain exactly one collection');
    }
    const collectionId = uuid(collectionIds[0]);
    const collection = record(object(first.recordMap), 'collection', collectionId);
    const rawSchema = object(collection.schema);
    const schema: ObjectValue = {};
    for (const [propertyId, field] of Object.entries(rawSchema)) {
      const entry = object(field);
      if (typeof entry.name !== 'string' || typeof entry.type !== 'string') fail('Invalid shared page schema');
      // The viewer calls rich text "text"; the rest of this module speaks the
      // API's type names, so the two paths validate and read alike.
      schema[propertyId] = { id: propertyId, name: entry.name,
        type: entry.type === 'text' ? 'rich_text' : entry.type };
    }
    // Ask for every row at once, doubling until the view says it has no more.
    let limit = 1000;
    let rows: ObjectValue = {};
    for (;;) {
      rows = await publicRequest('queryCollection', {
        clientType: 'notion_app',
        source: { type: 'collection', id: collectionId, spaceId },
        collectionView: { id: ref.viewId, spaceId },
        loader: { reducers: { collection_group_results: { type: 'results', limit } },
          archiveStatus: 'NON_ARCHIVED', userTimeZone: timezone() }
      });
      const group = object(object(object(rows.result).reducerResults).collection_group_results);
      if (group.hasMore !== true) break;
      if (limit >= 16000) fail('The shared page has more rows than one sync can read');
      limit *= 2;
    }
    const group = object(object(object(rows.result).reducerResults).collection_group_results);
    const ids = Array.isArray(group.blockIds) ? group.blockIds : [];
    if (!ids.length) fail('The shared page returned no rows');
    const blocks: ObjectValue = { ...object(object(rows.recordMap).block) };
    const missing = ids.filter(id => typeof id === 'string' && !blocks[id]) as string[];
    for (let start = 0; start < missing.length; start += 100) {
      const batch = missing.slice(start, start + 100);
      const fetched = await publicRequest('syncRecordValues', {
        requests: batch.map(id => ({ pointer: { table: 'block', id, spaceId }, version: -1 }))
      });
      Object.assign(blocks, object(object(fetched.recordMap).block));
    }
    const pages = ids.map(id => {
      if (typeof id !== 'string') return fail('Invalid shared page row identifier');
      const block = record({ block: blocks }, 'block', id);
      if (block.alive === false || block.type !== 'page') fail('The shared page contains a row that is not a page');
      const properties: ObjectValue = {};
      const values = object(block.properties);
      for (const [propertyId, field] of Object.entries(schema)) {
        const segments = values[propertyId];
        if (segments === undefined) continue;
        properties[propertyId] = publicProperty(String(object(field).type), segments);
      }
      return { id: uuid(id), properties };
    });
    return { schema, pages };
  }

  function timezone(): string {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
  }

  async function dataSource(token: string, databaseId: string, selected: string): Promise<{ id: string; properties: ObjectValue }> {
    const database = await request(token, `databases/${databaseId}`);
    if (database.object !== 'database' || uuid(database.id) !== databaseId || !Array.isArray(database.data_sources)) fail('Invalid Notion database response');
    const ids = database.data_sources.map(value => uuid(object(value).id));
    if (new Set(ids).size !== ids.length) fail('Invalid Notion data-source list');
    const id = selected || (ids.length === 1 ? ids[0] : undefined);
    if (!id || !ids.includes(id)) fail('Select an accessible data source belonging to the configured database');
    const source = await request(token, `data_sources/${id}`);
    if (source.object !== 'data_source' || uuid(source.id) !== id) fail('Invalid Notion data-source response');
    return { id, properties: object(source.properties) };
  }
  function resolveColumn(properties: ObjectValue, configured: string): { name: string; field: ObjectValue } {
    const decode = (value: string): string => {
      try { return decodeURIComponent(value); } catch { return value; }
    };
    const matches = Object.entries(properties).flatMap(([name, value]) => {
      const field = object(value);
      return name === configured || field.name === configured ||
        (typeof field.id === 'string' && decode(field.id) === decode(configured))
        ? [{ name, field }] : [];
    });
    if (matches.length === 0) fail('A mapped Notion column is missing; check mapping and relation sharing permissions');
    if (matches.length !== 1) fail('A mapped Notion column name or ID is ambiguous');
    return matches[0]!;
  }
  function column(properties: ObjectValue, name: string, types: string[]): ObjectValue {
    const field = resolveColumn(properties, name).field;
    if (typeof field.type !== 'string' || !types.includes(field.type)) fail('A mapped Notion column has an unsupported schema type');
    return field;
  }
  function validateSchema(c: Config, concepts: ObjectValue, terms: ObjectValue, conceptSource: string): void {
    const m = c.mapping;
    column(concepts, m.conceptId, ['title']);
    column(concepts, m.conceptType, ['select', 'multi_select', 'rich_text']);
    column(concepts, m.definition, ['rich_text']);
    column(terms, m.term, ['title', 'rich_text']);
    column(terms, m.language, ['select']);
    column(terms, m.group, ['rich_text']);
    column(terms, m.traits, ['multi_select']);
    column(terms, m.description, ['rich_text']);
    const relation = object(column(terms, m.conceptRelation, ['relation']).relation);
    if (!relation.data_source_id && !relation.database_id) fail('The concept relation target is inaccessible; share the related database');
    if (relation.data_source_id && uuid(relation.data_source_id) !== conceptSource) fail('The mapped relation targets a different concept data source');
    if (relation.database_id && uuid(relation.database_id) !== c.conceptDatabaseId) fail('The mapped relation targets a different concept database');
  }
  async function pages(token: string, id: string): Promise<ObjectValue[]> {
    const result: ObjectValue[] = [];
    const seen = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let count = 0; count < 1000; count++) {
      const response = await request(token, `data_sources/${id}/query`, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
      if (response.object !== 'list' || !Array.isArray(response.results) || typeof response.has_more !== 'boolean') fail('Invalid Notion pagination response');
      if (response.request_status !== undefined && object(response.request_status).type === 'incomplete') fail('Notion pagination request is incomplete; full sync was not committed');
      for (const value of response.results) {
        const page = object(value);
        if (page.object !== 'page') fail('Notion query returned a non-page result');
        const pageId = uuid(page.id);
        if (seen.has(pageId)) fail('Notion pagination repeated a page; full sync was not committed');
        seen.add(pageId);
        if (page.archived === true || page.in_trash === true) continue;
        result.push(page);
        if (result.length > 100000) fail('Notion row limit exceeded; full sync was not committed');
      }
      if (!response.has_more) {
        if (response.next_cursor !== null && response.next_cursor !== undefined) fail('Notion pagination ended inconsistently');
        return result;
      }
      if (typeof response.next_cursor !== 'string' || !response.next_cursor || cursors.has(response.next_cursor)) fail('Notion pagination is incomplete or repeated a cursor');
      cursor = response.next_cursor;
      cursors.add(cursor);
    }
    return fail('Notion pagination limit exceeded; full sync was not committed');
  }
  function property(page: ObjectValue, name: string, schema: ObjectValue): ObjectValue {
    const resolved = resolveColumn(schema, name);
    const row = resolveColumn(object(page.properties),
      typeof resolved.field.id === 'string' ? resolved.field.id : resolved.name);
    const p = row.field;
    const expected = resolved.field.type;
    if (p.type !== expected) fail('A Notion row property does not match its mapped schema');
    if (p.has_more === true) fail('A Notion property is truncated; full sync was not committed');
    return p;
  }
  function text(p: ObjectValue): string {
    const values = p[p.type as string];
    if (!Array.isArray(values)) fail('Invalid Notion text property');
    return values.map(value => {
      const part = object(value);
      if (typeof part.plain_text !== 'string') fail('Invalid Notion rich text');
      return part.plain_text;
    }).join('');
  }
  function nonempty(value: string): string {
    if (!value.trim()) fail('A required Notion row value is empty');
    return value;
  }
  function named(p: ObjectValue): string[] {
    if (!Array.isArray(p.multi_select)) fail('Invalid Notion multi-select property');
    return p.multi_select.map(value => {
      const name = object(value).name;
      if (typeof name !== 'string') fail('Invalid Notion multi-select option');
      return name;
    });
  }
  /** Concept and term pages become the canonical entry list; both sources
   *  hand this the same property shapes, so the hash and checks are shared. */
  function assemble(conceptPages: readonly ObjectValue[], concepts: ObjectValue,
    termPages: readonly ObjectValue[], terms: ObjectValue, m: Mapping): { concepts: number; entries: AT.glossary.Entry[] } {
    const conceptIds = new Map<string, string>();
    const immutableIds = new Set<string>();
    for (const page of conceptPages) {
      const id = uuid(text(property(page, m.conceptId, concepts)).trim());
      if (immutableIds.has(id)) fail('Concept UUIDs must be unique');
      immutableIds.add(id);
      conceptIds.set(uuid(page.id), id);
      // Validate mapped metadata even though only canonical term rows are stored.
      const kind = property(page, m.conceptType, concepts);
      if (kind.type === 'rich_text') text(kind);
      else if (kind.type === 'multi_select') named(kind);
      else if (kind.select !== null && typeof object(kind.select).name !== 'string') fail('Invalid concept type');
      text(property(page, m.definition, concepts));
    }
    const entries: AT.glossary.Entry[] = [];
    for (const page of termPages) {
      const relation = property(page, m.conceptRelation, terms);
      if (!Array.isArray(relation.relation) || relation.relation.length !== 1) fail('Each term must relate to exactly one accessible concept page');
      const conceptId = conceptIds.get(uuid(object(relation.relation[0]).id));
      if (!conceptId) fail('A term relation points to an unreadable or inactive concept page; share the relation target');
      const lang = property(page, m.language, terms);
      const selectedLanguage = object(lang.select).name;
      if (typeof selectedLanguage !== 'string' || !/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/i.test(selectedLanguage)) fail('Term language must be a valid BCP47 select option');
      let language: string;
      try { language = Intl.getCanonicalLocales(selectedLanguage)[0] || ''; }
      catch { return fail('Term language must be a valid BCP47 select option'); }
      if (!language) fail('Term language must be a valid BCP47 select option');
      entries.push({
        id: uuid(page.id), conceptId, language,
        term: nonempty(text(property(page, m.term, terms))),
        group: nonempty(text(property(page, m.group, terms))),
        traits: named(property(page, m.traits, terms)),
        description: text(property(page, m.description, terms)),
      });
    }
    entries.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return { concepts: conceptIds.size, entries };
  }

  async function collect(c: Config): Promise<Snapshot> {
    if (c.source === 'public') return collectPublic(c);
    if (!c.token || !c.conceptDatabaseId || !c.termDatabaseId) fail('Configure a Notion token and both databases before syncing');
    const concepts = await dataSource(c.token, c.conceptDatabaseId, c.conceptDataSourceId);
    const terms = await dataSource(c.token, c.termDatabaseId, c.termDataSourceId);
    validateSchema(c, concepts.properties, terms.properties, concepts.id);
    const conceptPages = await pages(c.token, concepts.id);
    const termPages = await pages(c.token, terms.id);
    return finalize(assemble(conceptPages, concepts.properties, termPages, terms.properties, c.mapping));
  }

  /** Shared-page rows arrive without a relation data source, so only the
   *  column types and their targets are checked here. */
  async function collectPublic(c: Config): Promise<Snapshot> {
    if (!c.conceptUrl || !c.termUrl) {
      fail(`Shared page sync needs ${[c.conceptUrl ? '' : 'the concept URL', c.termUrl ? '' : 'the expression URL']
        .filter(Boolean).join(' and ')}`);
    }
    const concepts = await publicCollection(c.conceptUrl);
    const terms = await publicCollection(c.termUrl);
    const m = c.mapping;
    column(concepts.schema, m.conceptId, ['title']);
    column(concepts.schema, m.conceptType, ['select', 'multi_select', 'rich_text']);
    column(concepts.schema, m.definition, ['rich_text']);
    column(terms.schema, m.term, ['title', 'rich_text']);
    column(terms.schema, m.language, ['select']);
    column(terms.schema, m.group, ['rich_text']);
    column(terms.schema, m.traits, ['multi_select']);
    column(terms.schema, m.description, ['rich_text']);
    column(terms.schema, m.conceptRelation, ['relation']);
    return finalize(assemble(concepts.pages, concepts.schema, terms.pages, terms.schema, m));
  }

  /** Stamp the identity every consumer keys on: a digest of the canonical rows. */
  async function finalize(assembled: { concepts: number; entries: AT.glossary.Entry[] }): Promise<Snapshot> {
    const canonical = new TextEncoder().encode(JSON.stringify({ version: 1, entries: assembled.entries }));
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', canonical));
    const revision = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
    return { version: 1, revision, syncedAt: Date.now(), concepts: assembled.concepts, entries: assembled.entries };
  }

  async function run(): Promise<Snapshot> {
    let attempt = Date.now();
    let lastSuccess = 0;
    try {
      const start = await serial(async () => {
        await trusted();
        const c = await loadConfig();
        const state = await loadState();
        lastSuccess = state.lastSuccess;
        attempt = Date.now();
        await store().set({ [STATE_KEY]: { running: true, lastAttempt: attempt, lastSuccess, error: '' } });
        return { c, generation };
      });
      const snapshot = await collect(start.c);
      return await serial(async () => {
        // Read storage again as well as the generation: direct external changes
        // and an A -> B -> A configuration change both invalidate this sync.
        if (generation !== start.generation || JSON.stringify(await loadConfig()) !== JSON.stringify(start.c)) fail('Notion configuration changed during sync; previous snapshot retained');
        await store().set({
          [SNAPSHOT_KEY]: snapshot,
          [STATE_KEY]: { running: false, lastAttempt: attempt, lastSuccess: snapshot.syncedAt, error: '' },
        });
        return snapshot;
      });
    } catch (error) {
      const message = error instanceof SyncError ? error.message : 'Notion sync or local storage failed';
      await serial(async () => {
        await store().set({ [STATE_KEY]: { running: false, lastAttempt: attempt, lastSuccess, error: message } });
      }).catch(() => undefined);
      throw new Error(message);
    }
  }
  /** Coalesce overlapping callers; disabled configs may still be synced manually. */
  export function sync(): Promise<Snapshot> {
    if (flight) return flight;
    flight = run().finally(() => { flight = null; });
    return flight;
  }
}

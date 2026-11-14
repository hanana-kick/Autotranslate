import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SRC, load, resetGlobals, deferred, modelHead, type ATNamespace } from './helpers.ts';

// The options page is a plain script page: constants + browser + rules +
// local + modelstore + modelflow + settings first (the order options.html
// uses), then the controller itself.
const LIBS = [
  'lib/constants.js',
  'lib/browser.js',
  'lib/rules.js',
  'lib/plamo3.js',
  'lib/local.js',
  'lib/modelstore.js',
  'lib/modelflow.js',
  'lib/settings.js'
];

const host = globalThis as ATNamespace;

// The real English catalogue, so assertions read the rendered strings the user
// sees and `$1$`/`$2$` substitution is exercised for real.
const CATALOGUE = JSON.parse(readFileSync(join(SRC, '_locales', 'en', 'messages.json'), 'utf8')) as {
  [key: string]: { message: string };
};

/** Chrome's substitution rules: `$1$`..`$9$` from `subs`, `$$` is a literal `$`. */
function getMessage(key: string | undefined, subs?: string | string[]): string | undefined {
  const entry = key === undefined ? undefined : CATALOGUE[key];
  if (!entry) return undefined;
  const list = subs === undefined ? [] : Array.isArray(subs) ? subs : [subs];
  return entry.message.replace(/\$(\d+)\$|\$\$/g, (match, digit: string | undefined) =>
    digit === undefined ? '$' : list[Number(digit) - 1] ?? match
  );
}

const msg = (key: string, subs?: string | string[]): string => getMessage(key, subs) ?? `[${key}]`;

// --- DOM stand-in -----------------------------------------------------------
// The page only ever touches getElementById / createElement / replaceChildren /
// append / addEventListener / click plus value, checked, hidden, disabled,
// textContent, className, type, dataset and (for the progress bar) max, so a
// hand-rolled tree is enough to inspect what it rendered without pulling in a
// DOM dependency.

type Listener = (...args: unknown[]) => unknown;

/** The one `File` member the page reads when a local model is picked. */
type StubFile = { name: string; size: number };

type Stub = {
  tagName: string;
  id: string;
  value: string | number;
  checked: boolean;
  hidden: boolean;
  disabled: boolean;
  /** `<progress max>`; the page assigns bytes, not percentages. */
  max: number;
  /** `<input type=file>`: the page only ever looks at the first entry. */
  files: StubFile[] | null;
  type: string;
  className: string;
  textContent: string;
  attrs: Record<string, string>;
  dataset: Record<string, string | undefined>;
  children: Stub[];
  parent: Stub | null;
  listeners: Record<string, Listener[]>;
  setAttribute(name: string, value: string): void;
  appendChild(child: Stub): void;
  append(...children: Stub[]): void;
  replaceChildren(...children: Stub[]): void;
  addEventListener(type: string, fn: Listener): void;
  click(): void;
  remove(): void;
  querySelectorAll(selector: string): Stub[];
};


function matchesSelector(node: Stub, selector: string): boolean {
  const tokens = selector.match(/[.#]?[\w-]+|\[[^\]]+\]/g);
  if (!tokens || tokens.length === 0) return false;
  for (const [index, token] of tokens.entries()) {
    if (token.startsWith('[')) {
      const attribute = /^\[([\w-]+)(?:=(.*))?\]$/.exec(token);
      if (!attribute) return false;
      const name = attribute[1]!;
      const held = node.attrs[name];
      if (held === undefined) return false;
      const want = attribute[2]?.replace(/^["']|["']$/g, '');
      if (want !== undefined && held !== want) return false;
    } else if (token.startsWith('.')) {
      if (!node.className.split(/\s+/).includes(token.slice(1))) return false;
    } else if (token.startsWith('#')) {
      if (node.id !== token.slice(1)) return false;
    } else if (index === 0) {
      if (node.tagName !== token.toUpperCase()) return false;
    }
  }
  return true;
}

function makeEl(tagName: string, id = ''): Stub {
  const node: Stub = {
    tagName: tagName.toUpperCase(),
    id,
    value: '',
    checked: false,
    hidden: false,
    disabled: false,
    max: 0,
    files: null,
    type: '',
    className: '',
    textContent: '',
    attrs: {},
    dataset: {},
    children: [],
    parent: null,
    listeners: {},
    setAttribute(name, value) {
      node.attrs[name] = value;
      if (name.startsWith('data-')) {
        const key = name.slice(5).replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
        node.dataset[key] = value;
      }
    },
    appendChild(child) {
      child.remove();
      child.parent = node;
      node.children.push(child);
    },
    append(...children) {
      for (const child of children) node.appendChild(child);
    },
    replaceChildren(...children) {
      for (const child of node.children) child.parent = null;
      node.children = [];
      for (const child of children) node.appendChild(child);
    },
    addEventListener(type, fn) {
      (node.listeners[type] ??= []).push(fn);
    },
    click() {
      for (const fn of [...(node.listeners.click ?? [])]) invoke(fn, { type: 'click' });
    },
    remove() {
      const parent = node.parent;
      if (!parent) return;
      const at = parent.children.indexOf(node);
      if (at >= 0) parent.children.splice(at, 1);
      node.parent = null;
    },
    querySelectorAll(selector) {
      const found: Stub[] = [];
      for (const child of node.children) {
        if (matchesSelector(child, selector)) found.push(child);
        found.push(...child.querySelectorAll(selector));
      }
      return found;
    }
  };
  return node;
}

type StubDocument = {
  fields: Record<string, Stub>;
  body: Stub;
  listeners: Record<string, Listener[]>;
  createElement(tagName: string): Stub;
  getElementById(id: string): Stub | undefined;
  addEventListener(type: string, fn: Listener): void;
  querySelectorAll(selector: string): Stub[];
};

// id, tag and the data-i18n key options.html puts on the button.
const FIELDS: readonly (readonly [string, string, string?])[] = [
  ['localSection', 'div'],
  ['localModel', 'select'],
  ['modelList', 'ul'],
  ['downloadModel', 'button', 'options_download'],
  ['cancelDownload', 'button', 'options_cancel'],
  ['modelFile', 'input'],
  ['pickModel', 'button', 'options_pickFile'],
  ['prepareModel', 'button', 'options_prepare'],
  ['modelProgress', 'progress'],
  ['modelStatus', 'p'],
  ['targetLang', 'select'],
  ['alwaysTranslateLanguages', 'div'],
  ['parallelTranslation', 'select'],
  ['translationRendering', 'select'],
  ['rulePattern', 'input'],
  ['addRule', 'button', 'options_addRule'],
  ['ruleList', 'ul'],
  ['save', 'button', 'options_save'],
  ['saveStatus', 'p']
];

/** options.html puts the `hidden` attribute on these, so the stub starts that way. */
const HIDDEN_AT_BOOT: Record<string, true | undefined> = {
  cancelDownload: true,
  modelFile: true,
  modelProgress: true
};

function makeDocument(): StubDocument {
  const fields: Record<string, Stub> = {};
  const body = makeEl('body');
  const doc: StubDocument = {
    fields,
    body,
    listeners: {},
    createElement: (tagName) => makeEl(tagName),
    getElementById: (id) => fields[id],
    addEventListener: (type, fn) => {
      (doc.listeners[type] ??= []).push(fn);
    },
    querySelectorAll: (selector) => {
      const found: Stub[] = [];
      for (const root of Object.values(fields)) {
        if (matchesSelector(root, selector)) found.push(root);
        found.push(...root.querySelectorAll(selector));
      }
      return found;
    }
  };
  for (const [id, tag, i18nKey] of FIELDS) {
    const node = makeEl(tag, id);
    // options.html carries the label in the markup, so boot must fill it in.
    if (i18nKey) node.setAttribute('data-i18n', i18nKey);
    if (HIDDEN_AT_BOOT[id] === true) node.hidden = true;
    fields[id] = node;
  }
  return doc;
}

// Promises the page started on its own (a click handler, or a click() the
// keydown handler delegates to); drained after every synthetic event.
const pending: Promise<unknown>[] = [];

function invoke(fn: Listener, ...args: unknown[]): void {
  const result = fn(...args) as unknown;
  if (result instanceof Promise) pending.push(result);
}

async function settle(): Promise<void> {
  for (let round = 0; round < 20; round += 1) {
    if (pending.length === 0) return;
    await Promise.all(pending.splice(0, pending.length));
  }
  throw new Error('the options page never settled');
}

/**
 * Lets a chain the page started without awaiting (`void startDownload()`) land:
 * `setImmediate` only runs once the microtask queue has drained.
 */
const idle = (): Promise<void> => {
  const { promise, resolve } = deferred<void>();
  setImmediate(() => setImmediate(resolve));
  return promise;
};

async function fire(node: Stub, type: string, event: ATNamespace = {}): Promise<void> {
  for (const fn of [...(node.listeners[type] ?? [])]) invoke(fn, event);
  await settle();
}

const click = (node: Stub): Promise<void> => fire(node, 'click');

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// --- model store stand-in ---------------------------------------------------
// `AT.modelstore` runs its real logic against the two seams `configure()`
// exposes, so no test opens IndexedDB, OPFS or a socket.

/** The bytes the fake transfer streams: the ONNX q4f16 card's declared size,
 *  so the progress bars are measured against a real file's length. */
const MODEL_BYTES = 705_701_446;

type ModelFixtures = {
  /** Raw metadata rows the fake IndexedDB answers `all()` with. */
  rows?: ATNamespace[];
  /** What the fake `storage.estimate()` answers. */
  estimate?: { usage: number; quota: number; persisted: boolean };
  /** Total bytes the scripted download serves; the card's size is what the
   *  store will hold it against. */
  bytes?: number;
  /** Byte counts the scripted download streams back after the first chunk. */
  chunks?: number[];
  /** The HTTP status the scripted download answers with. */
  status?: number;
};

/** A metadata row `AT.local.normalizeModel` accepts. */
function modelRow(overrides: ATNamespace = {}): ATNamespace {
  return {
    id: 'plamo-3-translate-0.8b-q4f16-a1b2c3',
    name: 'model_q4f16.onnx',
    size: MODEL_BYTES,
    sourceUrl: 'https://models.example.test/files/model_q4f16.onnx',
    createdAt: 1700000000000,
    ...overrides
  };
}

/** What the page asked the store to do, as the wrappers recorded it. */
type ModelCalls = {
  removed: string[];
  downloads: ATNamespace[];
  ingests: ATNamespace[];
  fetchedUrls: string[];
  rows: () => ATNamespace[];
};

function fakeModelstore(AT: ATNamespace, fixtures: ModelFixtures, onBytes: (written: number) => void) {
  const S = AT.local.STORE as ATNamespace;
  const meta = new Map<string, ATNamespace>();
  for (const row of fixtures.rows ?? []) meta.set(String(row.id), row);
  const held = new Set<string>();
  const ages = new Map<string, number>();
  const estimate = fixtures.estimate ?? { usage: 5 * 1024 ** 3, quota: 20 * 1024 ** 3, persisted: true };
  // The store only counts the graph bytes here; no inference parses them, so
  // nobody allocates a gigabyte to watch a progress bar move.
  const parts = new Map<string, number>();
  const head = modelHead();
  const bytes = fixtures.bytes ?? MODEL_BYTES;
  const chunks = fixtures.chunks ?? [Math.max(0, bytes - head.length)];
  const total = head.length + chunks.reduce((sum, size) => sum + size, 0);
  const fetchedUrls: string[] = [];
  const calls: ModelCalls = { removed: [], downloads: [], ingests: [], fetchedUrls, rows: () => [...meta.values()] };
  // One tick per chunk, always past the progress throttle, so every chunk reports.
  const clock = { now: 1000 };
  // One object store, the model records: any other name is a store the
  // extension no longer has, and must fail here rather than quietly persist.
  const storeOf = (name: string) => {
    if (name !== String(S.metaStore)) throw new Error(`unexpected object store ${name}`);
    return meta;
  };

  const driver = {
    get: async (name: string, key: string) => storeOf(name).get(key),
    put: async (name: string, key: string, value: unknown) => {
      storeOf(name).set(key, value as ATNamespace);
    },
    remove: async (name: string, key: string) => {
      storeOf(name).delete(key);
    },
    all: async (name: string) => [...storeOf(name).values()]
  };

  const files = {
    async write(id: string, stream: ATNamespace) {
      const reader = stream.getReader() as ATNamespace;
      let written = 0;
      for (;;) {
        const chunk = (await reader.read()) as ATNamespace;
        if (chunk.done === true) break;
        written += Number(chunk.value?.byteLength ?? 0);
        onBytes(written);
      }
      held.add(id);
      ages.set(id, clock.now);
      return written;
    },
    async read(id: string) {
      return held.has(id) ? { size: MODEL_BYTES } : null;
    },
    async writePart(id: string, name: string, stream: ReadableStream<Uint8Array>) {
      const reader = stream.getReader() as ATNamespace;
      let written = 0;
      for (;;) {
        const chunk = (await reader.read()) as ATNamespace;
        if (chunk.done === true) break;
        written += Number(chunk.value?.byteLength ?? 0);
      }
      parts.set(`${id}/${name}`, written);
      return written;
    },
    async readPart(id: string, name: string) {
      return parts.has(`${id}/${name}`) ? { size: parts.get(`${id}/${name}`)! } : null;
    },
    async remove(id: string) {
      held.delete(id);
      ages.delete(id);
      for (const key of [...parts.keys()]) if (key.startsWith(id + '/')) parts.delete(key);
    },
    async list() {
      return [...held].map((name) => ({ name, lastModified: ages.get(name) ?? clock.now }));
    },
    async estimate() {
      return { ...estimate };
    },
    async persist() {
      return true;
    }
  };

  // The url and the headers are the store's business; the page only ever sees
  // the bytes and the outcome, so nothing is recorded here.
  const fetchImpl = async (url: string, _init: ATNamespace) => {
    fetchedUrls.push(url);
    const status = fixtures.status ?? 200;
    const ok = status >= 200 && status < 300;
    let next = 0;
    // Small parts (config, tokenizer) are served whole; only the graph is chunked.
    const isGraph = /\.onnx$/.test(url);
    const partTotal = isGraph ? total : Math.max(1, chunks[0] ?? 1);
    return {
      ok,
      status,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-length' ? String(partTotal) : null) },
      body: ok
        ? {
            getReader: () => ({
              read: async () => {
                // A non-graph part is served in one chunk and then closes.
                if (!isGraph) {
                  if (next > 0) return { done: true as const };
                  next += 1;
                  clock.now += Number(AT.local.DOWNLOAD_PROGRESS_INTERVAL_MS) + 100;
                  return { done: false as const, value: { byteLength: partTotal } };
                }
                const first = next === 0;
                const size = first ? head.length : chunks[next - 1];
                if (size === undefined) return { done: true as const };
                next += 1;
                clock.now += Number(AT.local.DOWNLOAD_PROGRESS_INTERVAL_MS) + 100;
                // Only `byteLength` is ever read past the header, so nobody
                // allocates the gigabyte the card advertises.
                return { done: false as const, value: first && isGraph ? head : { byteLength: size } };
              },
              cancel: async (_reason: unknown) => undefined
            })
          }
        : null
    };
  };

  return { calls, seams: { driver, files, fetchImpl, now: () => clock.now } };
}

type Reply = ATNamespace | ((message: ATNamespace) => unknown);

type BootOptions = {
  /** The blob storage holds before boot; `undefined` means nothing stored yet. */
  stored?: ATNamespace;
  uiLang?: string;
  replies?: Record<string, Reply>;
  /** What the injected model store holds instead of IndexedDB and OPFS. */
  models?: ModelFixtures;
};

/**
 * Boots the options page the way the browser does: chrome stand-in and a stub
 * document on `globalThis`, the shared libs as classic scripts, then
 * options.js, then the DOMContentLoaded event the controller waits for.
 */
async function boot(options: BootOptions = {}) {
  resetGlobals();
  pending.length = 0;

  const store: ATNamespace = options.stored === undefined ? {} : { settings: clone(options.stored) };
  const writes: ATNamespace[] = [];
  const runtimeMessages: ATNamespace[] = [];
  const replies: Record<string, Reply> = { ...(options.replies ?? {}) };
  const doc = makeDocument();

  const storageLocal = {
    get: async (key: string) => (store[key] === undefined ? {} : { [key]: clone(store[key]) }),
    set: async (items: ATNamespace) => {
      const snapshot = clone(items);
      writes.push(snapshot);
      Object.assign(store, snapshot);
    }
  };

  host.browser = {
    runtime: {
      lastError: null,
      id: 'autotranslate@test',
      getURL: (path: string) => path,
      getManifest: () => ({ version: '0.1.0' }),
      openOptionsPage: async () => {},
      sendMessage: async (message: ATNamespace) => {
        runtimeMessages.push(clone(message ?? {}));
        const reply = replies[String(message?.type)];
        if (reply === undefined) return undefined;
        return await (typeof reply === 'function' ? reply(message) : reply);
      },
      onMessage: { addListener: () => {} }
    },
    i18n: {
      getUILanguage: () => options.uiLang ?? 'en',
      getMessage: (key: string | undefined, subs?: string | string[]) => getMessage(key, subs)
    },
    storage: { local: storageLocal, onChanged: { addListener: () => {} } }
  };
  host.document = doc;

  const AT = load(...LIBS, 'options.js');

  const field = (id: string): Stub => {
    const node = doc.getElementById(id);
    if (!node) throw new Error(`options.html has no #${id}`);
    return node;
  };

  // Both seams plus fetch are fake, so the model card exercises the real store
  // logic without a browser; the wrappers record what the page asked for.
  const progress: ATNamespace[] = [];
  const model = fakeModelstore(AT, options.models ?? {}, (written) => {
    progress.push({
      written,
      value: field('modelProgress').value,
      max: field('modelProgress').max,
      hidden: field('modelProgress').hidden,
      status: field('modelStatus').textContent
    });
  });
  AT.modelstore.configure(model.seams);
  const remove = AT.modelstore.remove as (id: string) => Promise<boolean>;
  const download = AT.modelstore.download as (request: ATNamespace) => Promise<unknown>;
  AT.modelstore.remove = async (id: string) => {
    model.calls.removed.push(id);
    return remove(id);
  };
  AT.modelstore.download = async (request: ATNamespace) => {
    model.calls.downloads.push(request);
    return download(request);
  };
  const ingestOnnx = AT.modelstore.ingestOnnx as (request: ATNamespace) => Promise<unknown>;
  AT.modelstore.ingestOnnx = async (request: ATNamespace) => {
    model.calls.ingests.push(request);
    return ingestOnnx(request);
  };
  // The page hands the transfer to `AT.modelflow`; the real module still runs,
  // so this only records what the page asked it to do.
  const installs: ATNamespace[] = [];
  const installFromUrl = AT.modelflow.installFromUrl as (install: ATNamespace) => Promise<unknown>;
  AT.modelflow.installFromUrl = async (install: ATNamespace) => {
    installs.push(install);
    return installFromUrl(install);
  };
  const importFromFiles = AT.modelflow.installFromFiles as (files: File[]) => Promise<unknown>;
  AT.modelflow.installFromFiles = (files: File[]) => {
    const completion = importFromFiles(files);
    pending.push(completion);
    return completion;
  };

  for (const fn of [...(doc.listeners.DOMContentLoaded ?? [])]) await fn({ type: 'DOMContentLoaded' });
  await settle();

  return {
    AT,
    doc,
    field,
    store,
    writes,
    runtimeMessages,
    replies,
    model: model.calls,
    installs,
    progress,
    /** Make the next storage write fail, the way a full/quota'd store does. */
    failWrites: (message = 'quota exceeded') => {
      storageLocal.set = async () => {
        throw new Error(message);
      };
    }
  };
}

/** A full, already-normalised settings blob (what the page stores). */
function storedSettings(overrides: ATNamespace = {}): ATNamespace {
  return {
    version: 3,
    enabled: true,
    targetLang: 'en',
    sourceLang: 'auto',
    localModelId: '',
    localMaxTokens: 1024,
    maxNodes: 600,
    translationConcurrency: 8,
    translationRendering: 'aurora',
    showBadge: true,
    siteRules: [],
    alwaysTranslateLanguages: [],
    debug: false,
    ...overrides
  };
}

const ruleItems = (list: Stub) => list.querySelectorAll('li.rule');
const savedSettings = (env: { writes: ATNamespace[] }, index = -1): ATNamespace =>
  env.writes.at(index)!.settings as ATNamespace;

const modelItem = (list: Stub, name: string): Stub => {
  const found = list
    .querySelectorAll('li.rule')
    .find((item) => item.querySelectorAll('code')[0]!.textContent === name);
  if (!found) throw new Error(`the model list has no ${name}`);
  return found;
};

test('boot renders the full language catalogue and preserves stored exclusions', async () => {
  const env = await boot({ stored: storedSettings({
    targetLang: 'ko',
    alwaysTranslateLanguages: ['ja', 'de'],
    siteRules: [{ pattern: 'news.example.com', action: 'never' }]
  }) });
  const { AT, field } = env;
  assert.equal(field('targetLang').value, 'ko');
  assert.deepEqual(field('targetLang').children.map((node) => node.value), AT.C.LANGS.map((lang: ATNamespace) => lang.code));
  const languages = field('alwaysTranslateLanguages').querySelectorAll('input');
  assert.deepEqual(languages.map((input) => input.value), AT.C.LANGS.map((lang: ATNamespace) => lang.code));
  assert.deepEqual(languages.filter((input) => input.checked).map((input) => input.value), ['ja', 'de']);
  assert.equal(ruleItems(field('ruleList'))[0]!.querySelectorAll('span.tag')[0]!.textContent, msg('options_ruleNever'));
  assert.equal(field('save').textContent, msg('options_save'));
  assert.equal(field('downloadModel').textContent, msg('options_download'));
  assert.equal(field('pickModel').textContent, msg('options_pickFile'));
  assert.equal(field('prepareModel').textContent, msg('options_prepare'));
  assert.deepEqual(env.writes, [], 'opening preferences never enables translation');
  assert.deepEqual(env.runtimeMessages, [], 'opening global preferences neither reads nor changes tab translation state');
});

test('an empty store starts with no automatic languages or URLs', async () => {
  const { field } = await boot();
  assert.equal(field('targetLang').value, 'en');
  assert.equal(field('localModel').value, '');
  assert.equal(field('localModel').children.length, 1);
  assert.ok(field('alwaysTranslateLanguages').querySelectorAll('input').every((input) => !input.checked));
  assert.equal(field('ruleList').children[0]!.textContent, msg('options_noRules'));
});

test('saving real language edits enables autodetection without erasing internal preferences', async () => {
  const original = storedSettings({
    enabled: false, sourceLang: 'ko', targetLang: 'ko', maxNodes: 900,
    localMaxTokens: 2048, debug: true, showBadge: false,
    alwaysTranslateLanguages: ['ja'],
    siteRules: [{ pattern: 'blocked.example', action: 'never' }]
  });
  const env = await boot({ stored: original });
  const { field } = env;
  field('targetLang').value = 'de';
  for (const input of field('alwaysTranslateLanguages').querySelectorAll('input')) {
    input.checked = input.value === 'en' || input.value === 'de';
  }
  await click(field('save'));
  assert.equal(env.writes.length, 1);
  assert.deepEqual(savedSettings(env), {
    ...original, enabled: true, sourceLang: 'auto', targetLang: 'de', alwaysTranslateLanguages: ['en', 'de']
  }, 'only the explicit preferences change, including a harmless target-language selection');
  assert.equal(field('saveStatus').dataset.kind, 'ok');

  for (const input of field('alwaysTranslateLanguages').querySelectorAll('input')) input.checked = false;
  await click(field('save'));
  assert.deepEqual(savedSettings(env).alwaysTranslateLanguages, [], 'unchecking all languages persists');
  const reopened = await boot({ stored: savedSettings(env) });
  assert.equal(reopened.field('targetLang').value, 'de');
  assert.ok(reopened.field('alwaysTranslateLanguages').querySelectorAll('input').every((input) => !input.checked));
});

test('parallel translation defaults to eight and all select choices persist across reopening', async () => {
  const env = await boot();
  assert.equal(env.field('parallelTranslation').value, '8');
  assert.deepEqual(env.field('parallelTranslation').querySelectorAll('option').map(option => option.value), ['1', '2', '4', '8']);
  await click(env.field('save'));
  assert.equal(savedSettings(env).translationConcurrency, 8);
  for (const width of [1, 2, 4, 8]) {
    const env = await boot();
    env.field('parallelTranslation').value = String(width);
    await click(env.field('save'));
    assert.equal(savedSettings(env).translationConcurrency, width);
    const reopened = await boot({ stored: savedSettings(env) });
    assert.equal(reopened.field('parallelTranslation').value, String(width));
    reopened.field('targetLang').value = 'ja';
    await click(reopened.field('save'));
    assert.equal(savedSettings(reopened).translationConcurrency, width);
  }
});

test('missing or invalid stored concurrency uses the parallel default', async () => {
  const missing = storedSettings();
  delete missing.translationConcurrency;
  for (const stored of [missing, storedSettings({ translationConcurrency: 0 }), storedSettings({ translationConcurrency: '1' })]) {
    const env = await boot({ stored });
    assert.equal(env.field('parallelTranslation').value, '8');
    await click(env.field('save'));
    assert.equal(savedSettings(env).translationConcurrency, 8);
  }
});

test('translation appearance persists and missing or invalid modes retain aurora', async () => {
  for (const mode of ['aurora', 'immediate']) {
    const env = await boot();
    assert.equal(env.field('translationRendering').value, 'aurora');
    assert.deepEqual(env.field('translationRendering').querySelectorAll('option').map(option => option.value),
      ['aurora', 'immediate']);
    env.field('translationRendering').value = mode;
    await click(env.field('save'));
    assert.equal(savedSettings(env).translationRendering, mode);
    const reopened = await boot({ stored: savedSettings(env) });
    assert.equal(reopened.field('translationRendering').value, mode);
    reopened.field('targetLang').value = 'ja';
    await click(reopened.field('save'));
    assert.equal(savedSettings(reopened).translationRendering, mode);
  }
  for (const translationRendering of [undefined, null, 'none']) {
    const env = await boot({ stored: storedSettings({ translationRendering }) });
    assert.equal(env.field('translationRendering').value, 'aurora');
  }
});

test('saving preserves internal preferences changed by another context', async () => {
  const env = await boot({ stored: storedSettings() });
  env.store.settings.maxNodes = 1200;
  env.store.settings.localMaxTokens = 4096;
  env.store.settings.showBadge = false;
  env.field('targetLang').value = 'ja';
  await click(env.field('save'));
  assert.equal(savedSettings(env).maxNodes, 1200);
  assert.equal(savedSettings(env).localMaxTokens, 4096);
  assert.equal(savedSettings(env).showBadge, false);
});

test('a failing storage write is not reported as saved', async () => {
  const env = await boot({ stored: storedSettings() });
  const before = clone(env.store.settings);
  env.failWrites('quota exceeded');
  env.field('targetLang').value = 'ja';

  await click(env.field('save'));

  assert.deepEqual(env.writes, [], 'nothing was written');
  assert.deepEqual(env.store.settings, before, 'storage still holds the old settings');
  assert.match(env.field('saveStatus').textContent, /quota exceeded/, 'an error message, never a success, on a failed save');
  assert.equal(env.field('saveStatus').dataset.kind, 'error');
});

test('the rule list renders stored rules and an empty-state row', async () => {
  const empty = await boot({ stored: storedSettings({ siteRules: [] }) });
  assert.equal(empty.field('ruleList').children.length, 1);
  assert.equal(empty.field('ruleList').children[0]!.className, 'empty');
  assert.equal(empty.field('ruleList').children[0]!.textContent, msg('options_noRules'));

  const env = await boot({
    stored: storedSettings({
      siteRules: [
        { pattern: 'news.example.com', action: 'never' },
        { pattern: 'example.org/news/*', action: 'always' }
      ]
    })
  });
  const items = ruleItems(env.field('ruleList'));
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => item.className), ['rule', 'rule']);
  assert.deepEqual(
    items.map((item) => item.querySelectorAll('span.tag')[0]!.textContent),
    [msg('options_ruleNever'), msg('options_ruleAlways')]
  );
});

test('adding a rule canonicalises the pattern, persists it and re-renders the list', async () => {
  const env = await boot({ stored: storedSettings({ siteRules: [{ pattern: 'news.example.com', action: 'never' }] }) });
  const { field } = env;

  field('rulePattern').value = 'News.Example.com/News/*';
  await click(field('addRule'));

  assert.equal(env.writes.length, 1, 'adding a rule is one save');
  const saved = savedSettings(env);
  assert.deepEqual(saved.siteRules, [
    { pattern: 'news.example.com', action: 'never' },
    // Hosts fold to lower case; a path keeps the casing the server uses.
    { pattern: 'news.example.com/News/*', action: 'always' }
  ], 'the host is folded, the path is kept and new rules always translate');
  assert.equal(field('rulePattern').value, '', 'the input is cleared for the next rule');
  assert.equal(field('saveStatus').dataset.kind, 'ok');
  assert.deepEqual(
    ruleItems(field('ruleList')).map((item) => [item.querySelectorAll('code')[0]!.textContent, item.querySelectorAll('span.tag')[0]!.dataset.action]),
    [
      ['news.example.com', 'never'],
      ['news.example.com/News/*', 'always']
    ],
    'the list is repainted from the reply, not from the input'
  );
});

test('adding an existing exclusion cannot silently turn it into automatic translation', async () => {
  const env = await boot({ stored: storedSettings({ siteRules: [{ pattern: 'news.example.com', action: 'never' }] }) });
  const { field } = env;
  field('rulePattern').value = 'news.example.com';
  await click(field('addRule'));
  assert.deepEqual(env.writes, []);
  assert.equal(field('saveStatus').textContent, msg('options_blockedRule'));
  assert.equal(ruleItems(field('ruleList'))[0]!.querySelectorAll('span.tag')[0]!.dataset.action, 'never');
  await click(ruleItems(field('ruleList'))[0]!.querySelectorAll('button')[0]!);
  field('rulePattern').value = 'news.example.com';
  await click(field('addRule'));
  assert.deepEqual(savedSettings(env).siteRules, [{ pattern: 'news.example.com', action: 'always' }]);
});

test('single and recursive globs persist distinctly with an optional scheme', async () => {
  const env = await boot({ stored: storedSettings() });
  for (const pattern of ['example.com/news/*', 'example.com/news/**', 'https://*.example.org/**']) {
    env.field('rulePattern').value = pattern;
    await click(env.field('addRule'));
  }
  assert.deepEqual(savedSettings(env).siteRules, [
    { pattern: 'example.com/news/*', action: 'always' },
    { pattern: 'example.com/news/**', action: 'always' },
    { pattern: 'https://*.example.org/**', action: 'always' }
  ]);
});

test('a junk rule pattern is refused without touching storage', async () => {
  const env = await boot({ stored: storedSettings({ siteRules: [{ pattern: 'news.example.com', action: 'never' }] }) });
  const { field } = env;

  field('rulePattern').value = '   ';
  await click(field('addRule'));

  assert.deepEqual(env.writes, [], 'nothing is saved for a pattern that cannot be parsed');
  assert.equal(field('saveStatus').textContent, msg('options_badRule'));
  assert.equal(field('saveStatus').dataset.kind, 'error');
  assert.equal(ruleItems(field('ruleList')).length, 1, 'the list still holds only the stored rule');
});

test('Enter in the pattern field adds the rule, any other key does not', async () => {
  const env = await boot({ stored: storedSettings() });
  const { field } = env;

  field('rulePattern').value = 'example.com';
  await fire(field('rulePattern'), 'keydown', { key: 'a' });
  assert.deepEqual(env.writes, [], 'typing a character must not add anything');

  await fire(field('rulePattern'), 'keydown', { key: 'Enter' });
  assert.equal(env.writes.length, 1, 'Enter goes through the Add rule button');
  assert.deepEqual(savedSettings(env).siteRules, [{ pattern: 'example.com', action: 'always' }]);
});

test('removing a rule drops it from storage and from the list', async () => {
  const env = await boot({
    stored: storedSettings({
      siteRules: [
        { pattern: 'news.example.com', action: 'never' },
        { pattern: 'blog.example.org', action: 'always' }
      ]
    })
  });
  const { field } = env;

  const first = ruleItems(field('ruleList'))[0]!;
  await click(first.querySelectorAll('button')[0]!);

  assert.equal(env.writes.length, 1);
  assert.deepEqual(savedSettings(env).siteRules, [{ pattern: 'blog.example.org', action: 'always' }], 'only the clicked host is gone');
  const items = ruleItems(field('ruleList'));
  assert.equal(items.length, 1);
  assert.equal(items[0]!.querySelectorAll('code')[0]!.textContent, 'blog.example.org');
  assert.equal(field('saveStatus').dataset.kind, 'ok');
  assert.deepEqual(
    env.runtimeMessages.map((message) => message.type),
    [],
    'the removal is a storage write, no at/remove-site-rule'
  );
});

test('the installed models render in the picker and the list', async () => {
  const empty = await boot({ stored: storedSettings() });
  assert.equal(empty.field('modelList').children[0]!.className, 'empty');
  assert.equal(empty.field('modelList').children[0]!.textContent, msg('options_noModels'));
  assert.deepEqual(empty.field('localModel').children.map((node) => node.value), ['']);
  assert.equal(empty.field('localModel').children[0]!.textContent, msg('options_localNone'));

  const env = await boot({
    stored: storedSettings({ localModelId: 'alpha-task' }),
    models: {
      rows: [
        modelRow({ id: 'alpha-task', name: 'alpha.onnx' }),
        modelRow({ id: 'beta-task', name: 'beta.onnx', createdAt: 1800000000000 })
      ]
    }
  });
  const { field } = env;

  assert.deepEqual(
    field('localModel').children.map((node) => [node.value, node.textContent]),
    [
      ['', msg('options_localNone')],
      ['beta-task', 'beta.onnx (673 MiB)'],
      ['alpha-task', 'alpha.onnx (673 MiB)']
    ],
    'newest first, each labelled with its size'
  );
  assert.equal(
    field('localModel').children.some((node) => node.value === 'alpha-task'),
    true,
    'the stored model is offered in the picker'
  );

  const items = field('modelList').querySelectorAll('li.rule');
  assert.deepEqual(items.map((item) => item.querySelectorAll('code')[0]!.textContent), ['beta.onnx', 'alpha.onnx']);
  assert.deepEqual(
    items.map((item) => item.querySelectorAll('span.tag')[0]!.textContent),
    ['673 MiB', '● 673 MiB'],
    'the chosen model carries the bullet'
  );
});

test('model status warns when the browser may evict the model', async () => {
  const env = await boot({
    models: {
      rows: [modelRow({ id: 'alpha-task', name: 'alpha.onnx' })],
      estimate: { usage: 5 * 1024 ** 3, quota: 20 * 1024 ** 3, persisted: false }
    }
  });
  assert.equal(
    env.field('modelStatus').textContent,
    msg('options_notPersisted'),
    'an unpinned store is named, not left to vanish between visits'
  );
});

test('the stored model is selected on boot and survives a save nobody touched', async () => {
  const env = await boot({
    stored: storedSettings({ localModelId: 'alpha-task' }),
    models: { rows: [modelRow({ id: 'alpha-task', name: 'alpha.onnx' })] }
  });
  assert.equal(
    env.field('localModel').value,
    'alpha-task',
    'the picker shows the stored model as soon as the page is up'
  );

  await click(env.field('save'));
  await idle();
  assert.equal(savedSettings(env).localModelId, 'alpha-task', 'saving without touching the picker keeps the model');
});

test('deleting the selected model clears the setting and releases the resident copy', async () => {
  const env = await boot({
    stored: storedSettings({ localModelId: 'alpha-task' }),
    models: {
      rows: [modelRow({ id: 'alpha-task', name: 'alpha.onnx' }), modelRow({ id: 'beta-task', name: 'beta.onnx' })]
    }
  });
  const { AT, field } = env;
  const booted = env.runtimeMessages.length;

  await click(modelItem(field('modelList'), 'alpha.onnx').querySelectorAll('button')[0]!);
  await idle();

  assert.deepEqual(env.model.removed, ['alpha-task'], 'the store is asked to delete exactly that id');
  assert.deepEqual(env.model.rows().map((row) => row.id), ['beta-task'], 'its metadata row is gone');
  assert.deepEqual(
    env.runtimeMessages.slice(booted).map((message) => message.type),
    [AT.C.MSG.LOCAL_RELEASE],
    'the model the user was translating with is unloaded'
  );
  assert.equal(savedSettings(env).localModelId, '', 'the setting no longer names a deleted model');
  assert.equal(field('modelStatus').textContent, msg('options_deleted', 'alpha.onnx'));
  assert.equal(field('modelStatus').dataset.kind, 'ok');
  assert.deepEqual(
    field('modelList').querySelectorAll('li.rule').map((item) => item.querySelectorAll('code')[0]!.textContent),
    ['beta.onnx'],
    'the list is repainted from the store'
  );
});

test('deleting an unselected model leaves the settings and the host alone', async () => {
  const env = await boot({
    stored: storedSettings({ localModelId: 'alpha-task' }),
    models: {
      rows: [modelRow({ id: 'alpha-task', name: 'alpha.onnx' }), modelRow({ id: 'beta-task', name: 'beta.onnx' })]
    }
  });
  const { field } = env;
  const booted = env.runtimeMessages.length;

  await click(modelItem(field('modelList'), 'beta.onnx').querySelectorAll('button')[0]!);
  await idle();

  assert.deepEqual(env.model.removed, ['beta-task'], 'the file is still deleted');
  assert.deepEqual(env.runtimeMessages.slice(booted), [], 'nothing to release for a model that never loaded');
  assert.deepEqual(env.writes, [], 'the settings are untouched');
  assert.equal(field('localModel').value, 'alpha-task', 'and the selection stays');
});

test('downloading the ONNX card fetches the graph and its parts, then registers the model', async () => {
  // The store refuses a body whose size drifts more than 5% from the number the
  // page hands it, so the fake transfer has to stream exactly what the card
  // declares. The card is read from a throwaway boot because the fake is fixed
  // when the page boots, and the page decides the size to hand over.
  const card = (await boot({})).AT.local.defaultSource();
  const bytes = Number(card.size);
  const name = String(String(card.url).split('/').pop());
  const env = await boot({
    stored: storedSettings({ localModelId: '' }),
    models: { bytes },
    // The install loads the model once before calling itself finished.
    replies: { 'at/local-prepare': { ok: true } }
  });
  const { AT, field } = env;

  assert.equal(field('modelProgress').hidden, true, 'nothing is in flight before the click');
  assert.equal(env.installs.length, 0, 'boot never downloads');
  assert.equal(env.model.downloads.length, 0, 'boot never downloads');
  assert.equal(env.model.ingests.length, 0, 'boot never installs');

  await click(field('downloadModel'));
  await idle();

  assert.equal(env.installs.length, 1, 'one click is one install');
  const install = env.installs[0]!;
  assert.equal(install.url, card.url);
  assert.ok(install.signal instanceof AbortSignal, 'the install gets a signal the cancel button can abort');
  assert.equal(install.signal.aborted, false);
  assert.equal(typeof install.onProgress, 'function', 'the page draws the progress');

  assert.equal(env.model.downloads.length, 0, 'an ONNX card is not one byte stream');
  assert.equal(env.model.ingests.length, 1, 'the install asks the store for the multi-file ingest');
  const request = env.model.ingests[0]!;
  assert.equal(request.graphUrl, card.url);
  assert.equal(request.expectedSize, bytes, 'the card size is the sanity check the store is given');
  assert.deepEqual(request.parts, card.parts, 'every small file beside the graph is fetched');

  const base = card.url.slice(0, card.url.lastIndexOf('/onnx/') + 1);
  assert.deepEqual(
    env.model.fetchedUrls,
    [card.url, ...(card.parts ?? []).map((part: string) => base + part)],
    'the graph first, then each part from the same directory'
  );

  // Every graph chunk contributes to the progress total.
  assert.deepEqual(
    env.progress.map((tick) => [tick.value, tick.max, tick.hidden]),
    [
      [modelHead().length, bytes, false],
      [bytes, bytes, false]
    ],
    'the first chunk arrives and the body fills the bar'
  );
  assert.equal(
    env.progress[1]!.status,
    msg('options_downloading', [AT.local.formatBytes(bytes), AT.local.formatBytes(bytes)]),
    'and the line reports the bytes'
  );

  assert.equal(field('modelProgress').hidden, true, 'the bar is hidden once the file is stored');
  assert.equal(field('downloadModel').disabled, false, 'the buttons are live again');
  const rows = env.model.rows();
  assert.equal(rows.length, 1, 'a complete file is the only thing registered');
  assert.equal(rows[0]!.name, name, 'named after the url');
  assert.equal(rows[0]!.size, bytes);
  assert.equal(savedSettings(env).localModelId, rows[0]!.id, 'the first model becomes the selected one');
  assert.equal(field('localModel').value, rows[0]!.id, 'and the picker follows');
  assert.equal(
    String(field('modelStatus').textContent).replace(/ stored in \d+ s$/, ''),
    `${name} (${AT.local.formatBytes(bytes)})`,
    'the line names the file and its size'
  );
});

test('selecting an installed model persists it without exposing its token budget', async () => {
  const env = await boot({
    stored: storedSettings({ localMaxTokens: 2048 }),
    models: { rows: [modelRow({ id: 'alpha-task', name: 'alpha.onnx' })] }
  });
  env.field('localModel').value = 'alpha-task';
  await click(env.field('save'));
  assert.equal(savedSettings(env).localModelId, 'alpha-task');
  assert.equal(savedSettings(env).localMaxTokens, 2048);
});

test('loading an installed model selects it only after preparation succeeds', async () => {
  const env = await boot({
    stored: storedSettings({ localModelId: 'alpha-task' }),
    models: { rows: [modelRow({ id: 'alpha-task' }), modelRow({ id: 'beta-task' })] },
    replies: { 'at/local-prepare': { ok: false, error: 'cannot load' } }
  });
  env.field('localModel').value = 'beta-task';
  await click(env.field('prepareModel'));
  await idle();
  assert.equal(env.field('modelStatus').textContent, 'cannot load');
  assert.deepEqual(env.writes, []);
  env.replies['at/local-prepare'] = { ok: true };
  await click(env.field('prepareModel'));
  await idle();
  assert.equal(savedSettings(env).localModelId, 'beta-task');
  assert.equal(env.field('localModel').value, 'beta-task');
  assert.equal(env.field('modelStatus').textContent, msg('options_prepared'));
});

test('disk import uses the real model validation and stored-file workflow', async () => {
  const env = await boot({ replies: { 'at/local-prepare': { ok: true } } });
  const graph = new File([new Uint8Array(3_000_000)], 'model_q4f16.onnx');
  env.field('modelFile').files = [graph];
  await fire(env.field('modelFile'), 'change');
  await idle();
  assert.equal(env.field('modelStatus').dataset.kind, 'error');
  assert.match(env.field('modelStatus').textContent, /missing-tokenizer/);
  assert.deepEqual(env.model.rows(), [], 'incomplete selections do not register a model');
  assert.deepEqual(env.writes, [], 'validation failures do not alter preferences');
  assert.equal(env.field('modelFile').value, '', 'the same selection can be tried again');

  env.field('modelFile').files = [
    graph,
    ...['tokenizer.json', 'tokenizer_config.json', 'config.json'].map((name) => new File(['{}'], name))
  ];
  await fire(env.field('modelFile'), 'change');
  await idle();
  const rows = env.model.rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.sourceUrl, '', 'local imports carry no download URL');
  assert.equal(savedSettings(env).localModelId, rows[0]!.id);
  assert.equal(env.field('localModel').value, rows[0]!.id);
  for (const name of ['tokenizer.json', 'tokenizer_config.json', 'config.json']) {
    assert.equal((await env.AT.modelstore.readPart(rows[0]!.id, name)).size, 2);
  }
  assert.equal(env.field('modelStatus').dataset.kind, 'ok');
  assert.equal(env.field('modelProgress').hidden, true);
  assert.equal(env.field('pickModel').disabled, false);
  assert.deepEqual(env.model.fetchedUrls, [], 'disk import never downloads replacement bytes');
});

test('a stored import that fails to load preserves the working selection', async () => {
  const env = await boot({
    stored: storedSettings({ localModelId: 'working-model' }),
    models: { rows: [modelRow({ id: 'working-model', name: 'working.onnx' })] },
    replies: { 'at/local-prepare': { ok: false, error: 'invalid graph' } }
  });
  env.field('modelFile').files = [
    new File([new Uint8Array(3_000_000)], 'broken.onnx'),
    new File(['{}'], 'tokenizer.json'),
    new File(['{}'], 'tokenizer_config.json')
  ];
  await fire(env.field('modelFile'), 'change');
  await idle();
  assert.equal(env.model.rows().length, 2, 'the failed import remains removable without replacing the working model');
  assert.equal(env.store.settings.localModelId, 'working-model');
  assert.equal(env.field('localModel').value, 'working-model');
  assert.equal(env.field('modelStatus').textContent, msg('options_modelStored', 'invalid graph'));
  assert.equal(env.field('modelStatus').dataset.kind, 'error');
});

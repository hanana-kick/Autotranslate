import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SRC, load, resetGlobals, deferred, type ATNamespace } from './helpers.ts';

// The options page is a plain script page: constants + browser + rules +
// local + modelstore + settings first (the order options.html uses), then the
// controller itself.
const LIBS = [
  'lib/constants.js',
  'lib/browser.js',
  'lib/rules.js',
  'lib/local.js',
  'lib/modelstore.js',
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
  listeners: Record<string, Listener[]>;
  createElement(tagName: string): Stub;
  getElementById(id: string): Stub | undefined;
  addEventListener(type: string, fn: Listener): void;
  querySelectorAll(selector: string): Stub[];
};

// id, tag and the data-i18n key options.html puts on the button.
const FIELDS: readonly (readonly [string, string, string?])[] = [
  ['enabled', 'input'],
  ['autoDetect', 'input'],
  ['showBadge', 'input'],
  ['debug', 'input'],
  ['testEngine', 'button', 'options_test'],
  ['testStatus', 'p'],
  // The on-device card, in the order options.html lists them.
  ['localSupport', 'p'],
  ['localModel', 'select'],
  ['localMaxTokens', 'input'],
  ['localUsage', 'p'],
  ['modelList', 'ul'],
  ['modelUrl', 'input'],
  ['modelToken', 'input'],
  ['downloadModel', 'button', 'options_download'],
  ['cancelDownload', 'button', 'options_cancel'],
  ['modelFile', 'input'],
  ['pickModel', 'button', 'options_pickFile'],
  ['prepareModel', 'button', 'options_prepare'],
  ['modelProgress', 'progress'],
  ['modelStatus', 'p'],
  ['targetLang', 'select'],
  ['sourceLang', 'select'],
  ['maxNodes', 'input'],
  ['rulePattern', 'input'],
  ['ruleAction', 'select'],
  ['addRule', 'button', 'options_addRule'],
  ['ruleList', 'ul'],
  ['save', 'button', 'options_save'],
  ['reset', 'button', 'options_reset'],
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
  const doc: StubDocument = {
    fields,
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

/** Drains microtasks deterministically; never a wall-clock wait. */
const flush = (): Promise<void> =>
  new Promise<void>((resolve) => {
    process.nextTick(resolve);
  });

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

/** The size the catalogue advertises for the one model it offers. */
const MODEL_BYTES = 3896377344;

type ModelFixtures = {
  /** Raw metadata rows the fake IndexedDB answers `all()` with. */
  rows?: ATNamespace[];
  /** The Hugging Face token the fake blob store holds. */
  token?: string;
  /** What the fake `storage.estimate()` answers. */
  estimate?: { usage: number; quota: number; persisted: boolean };
  /** Byte counts the scripted download streams back, one entry per chunk. */
  chunks?: number[];
  /** The HTTP status the scripted download answers with. */
  status?: number;
};

/** A metadata row `AT.local.normalizeModel` accepts. */
function modelRow(overrides: ATNamespace = {}): ATNamespace {
  return {
    id: 'translategemma-4b-it-int8-web-a1b2c3',
    name: 'translategemma-4b-it-int8-web.task',
    size: MODEL_BYTES,
    sourceUrl: 'https://models.example.test/files/translategemma-4b-it-int8-web.task',
    createdAt: 1700000000000,
    ...overrides
  };
}

/** What the page asked the store to do, as the wrappers recorded it. */
type ModelCalls = {
  removed: string[];
  downloads: ATNamespace[];
  fetches: { url: string; init: ATNamespace }[];
  rows: () => ATNamespace[];
};

function fakeModelstore(AT: ATNamespace, fixtures: ModelFixtures, onBytes: (written: number) => void) {
  const S = AT.local.STORE as ATNamespace;
  const meta = new Map<string, ATNamespace>();
  for (const row of fixtures.rows ?? []) meta.set(String(row.id), row);
  const blobs = new Map<string, ATNamespace>();
  if (fixtures.token !== undefined) blobs.set(String(S.settingsKey), { hfToken: fixtures.token });
  const held = new Set<string>();
  const estimate = fixtures.estimate ?? { usage: 5 * 1024 ** 3, quota: 20 * 1024 ** 3, persisted: true };
  const chunks = fixtures.chunks ?? [MODEL_BYTES / 2, MODEL_BYTES / 2];
  const total = chunks.reduce((sum, size) => sum + size, 0);
  const calls: ModelCalls = { removed: [], downloads: [], fetches: [], rows: () => [...meta.values()] };
  // One tick per chunk, always past the progress throttle, so every chunk reports.
  const clock = { now: 1000 };
  const bucket = (name: string) => (name === String(S.metaStore) ? meta : blobs);

  const driver = {
    get: async (name: string, key: string) => bucket(name).get(key),
    put: async (name: string, key: string, value: unknown) => {
      bucket(name).set(key, value as ATNamespace);
    },
    remove: async (name: string, key: string) => {
      bucket(name).delete(key);
    },
    all: async (name: string) => (name === String(S.metaStore) ? [...meta.values()] : [])
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
      return written;
    },
    async read(id: string) {
      return held.has(id) ? { size: MODEL_BYTES } : null;
    },
    async remove(id: string) {
      held.delete(id);
    },
    async estimate() {
      return { ...estimate };
    },
    async persist() {
      return true;
    }
  };

  const fetchImpl = async (url: string, init: ATNamespace) => {
    calls.fetches.push({ url, init });
    const status = fixtures.status ?? 200;
    const ok = status >= 200 && status < 300;
    let next = 0;
    return {
      ok,
      status,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-length' ? String(total) : null) },
      body: ok
        ? {
            read: async () => {
              const size = chunks[next];
              if (size === undefined) return { done: true as const };
              next += 1;
              clock.now += Number(AT.local.DOWNLOAD_PROGRESS_INTERVAL_MS) + 100;
              // Only `byteLength` is ever read, so nobody allocates 3.6 GiB.
              return { done: false as const, value: { byteLength: size } };
            }
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
    version: 1,
    enabled: true,
    autoDetect: true,
    targetLang: 'en',
    sourceLang: 'auto',
    localModelId: '',
    localMaxTokens: 1024,
    maxNodes: 600,
    showBadge: true,
    siteRules: [],
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

test('boot fills the selects, every field and the button labels from storage', async () => {
  const env = await boot({
    stored: storedSettings({
      enabled: false,
      autoDetect: false,
      showBadge: false,
      debug: true,
      targetLang: 'ko',
      sourceLang: 'ja',
      localMaxTokens: 2048,
      maxNodes: 450,
      siteRules: [
        { pattern: 'news.example.com', action: 'never' },
        { pattern: 'example.org/news/*', action: 'always' }
      ]
    })
  });
  const { AT, field } = env;

  assert.equal(field('enabled').checked, false);
  assert.equal(field('autoDetect').checked, false);
  assert.equal(field('showBadge').checked, false);
  assert.equal(field('debug').checked, true);
  assert.equal(field('targetLang').value, 'ko');
  assert.equal(field('sourceLang').value, 'ja');
  assert.equal(field('localMaxTokens').value, '2048');
  assert.equal(field('maxNodes').value, '450');

  assert.deepEqual(
    field('targetLang').children.map((node) => node.value),
    AT.C.LANGS.map((lang: ATNamespace) => lang.code)
  );
  assert.equal(field('targetLang').children[1]!.textContent, '한국어 (ko)');
  const source = field('sourceLang').children;
  assert.equal(source[0]!.value, 'auto');
  assert.equal(source[0]!.textContent, msg('options_sourceAuto'), 'the auto entry comes from the catalogue');
  assert.equal(source.length, AT.C.LANGS.length + 1);

  assert.equal(field('save').textContent, msg('options_save'));
  assert.equal(field('reset').textContent, msg('options_reset'));
  assert.equal(field('addRule').textContent, msg('options_addRule'));
  assert.equal(field('testEngine').textContent, msg('options_test'));
  assert.equal(field('downloadModel').textContent, msg('options_download'));
  assert.equal(field('cancelDownload').textContent, msg('options_cancel'));
  assert.equal(field('pickModel').textContent, msg('options_pickFile'));
  assert.equal(field('prepareModel').textContent, msg('options_prepare'));

  // The on-device card starts from the stored settings: no model selected and
  // the budget it was saved with.
  assert.equal(field('localModel').children.length, 1, 'no model is stored, so only the empty choice is offered');
  assert.equal(field('localModel').value, '');
  assert.equal(field('localMaxTokens').value, '2048');

  const items = ruleItems(field('ruleList'));
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => item.querySelectorAll('code')[0]!.textContent), ['news.example.com', 'example.org/news/*']);
  assert.deepEqual(
    items.map((item) => item.querySelectorAll('span.tag')[0]!.dataset.action),
    ['never', 'always']
  );
  assert.equal(items[0]!.querySelectorAll('button')[0]!.textContent, msg('options_remove'));

  assert.deepEqual(
    env.runtimeMessages.map((message) => message.type),
    [AT.C.MSG.LOCAL_GET_STATUS],
    'boot reads storage; the single background read is the on-device host status'
  );
  assert.deepEqual(env.writes, [], 'boot never writes settings back');
});

test('junk in storage renders a coerced form, never a half-filled one', async () => {
  const env = await boot({
    stored: {
      enabled: 'yes',
      targetLang: 'klingon',
      sourceLang: 'de',
      localModelId: 42,
      localMaxTokens: 'abc',
      maxNodes: {},
      showBadge: 'true',
      debug: 'yes',
      siteRules: [
        { pattern: '!!!', action: 'never' },
        { pattern: 'ok.example.com', action: 'maybe' },
        { pattern: 'good.example.com', action: 'always' }
      ]
    }
  });
  const { field } = env;

  assert.equal(field('targetLang').value, 'en', 'an unknown language falls back to the default target');
  assert.equal(field('sourceLang').value, 'de');
  assert.equal(field('localModel').value, '', 'a non-string model id is dropped');
  assert.equal(field('localMaxTokens').value, '1024', 'a non-numeric budget falls back');
  assert.equal(field('maxNodes').value, '600');
  assert.equal(field('enabled').checked, true);
  assert.equal(field('showBadge').checked, true);
  assert.equal(field('debug').checked, false, 'debug is strictly true');

  const items = ruleItems(field('ruleList'));
  assert.equal(items.length, 1, 'only the rule with a usable pattern and action survives');
  assert.equal(items[0]!.querySelectorAll('code')[0]!.textContent, 'good.example.com');
  assert.deepEqual(env.writes, []);
});

test('an empty store boots the defaults and the empty rule row', async () => {
  const env = await boot();
  const { field } = env;

  assert.equal(field('targetLang').value, 'en', 'the default target is the UI language');
  assert.equal(field('sourceLang').value, 'auto');
  assert.equal(field('localModel').value, '', 'no model is selected on a fresh install');
  assert.equal(field('localModel').children.length, 1);
  assert.equal(field('localMaxTokens').value, '1024');
  assert.equal(field('maxNodes').value, '600');
  assert.deepEqual([field('enabled').checked, field('autoDetect').checked, field('showBadge').checked, field('debug').checked], [true, true, true, false]);

  const list = field('ruleList');
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0]!.className, 'empty');
  assert.equal(list.children[0]!.textContent, msg('options_noRules'));
});

test('saving writes one record with the typed values, coerced', async () => {
  const env = await boot({ stored: storedSettings({ maxNodes: 600 }) });
  const { AT, field } = env;

  field('enabled').checked = true;
  field('autoDetect').checked = false;
  field('showBadge').checked = false;
  field('debug').checked = true;
  field('targetLang').value = 'ja';
  field('sourceLang').value = 'ko';
  field('localMaxTokens').value = '2048';
  field('maxNodes').value = '900';
  await click(field('save'));

  assert.equal(env.writes.length, 1, 'one save is one write');
  assert.deepEqual(
    env.runtimeMessages.map((message) => message.type),
    [AT.C.MSG.LOCAL_GET_STATUS],
    'the page writes storage itself, no at/set-settings round trip'
  );
  const saved = savedSettings(env);
  assert.equal(saved.targetLang, 'ja');
  assert.equal(saved.sourceLang, 'ko');
  assert.equal(saved.autoDetect, false);
  assert.equal(saved.showBadge, false);
  assert.equal(saved.debug, true);
  assert.equal(saved.version, 1);
  assert.equal(typeof saved.localMaxTokens, 'number', 'the budget reaches storage as a number');
  assert.equal(saved.localMaxTokens, 2048);
  assert.equal(saved.maxNodes, 900);
  assert.equal('engine' in saved, false, 'the removed provider settings are not resurrected');
  assert.equal('apiKey' in saved, false);
  assert.equal(AT.debug, true, 'the debug flag reaches the logger');

  assert.equal(field('saveStatus').textContent, msg('options_saved'));
  assert.equal(field('saveStatus').dataset.kind, 'ok');
  assert.equal(field('localMaxTokens').value, '2048', 'the form repaints from what was stored');
});

test('blank limits are clamped to their floors, never stored as NaN', async () => {
  const env = await boot({ stored: storedSettings({ maxNodes: 600 }) });
  const { field } = env;

  field('localMaxTokens').value = '';
  field('maxNodes').value = '';
  await click(field('save'));

  const saved = savedSettings(env);
  assert.equal(saved.localMaxTokens, 128, 'an empty budget clamps to its floor instead of becoming NaN');
  assert.equal(saved.maxNodes, 10);
  assert.equal(Number.isNaN(saved.localMaxTokens), false);
  assert.equal(field('localMaxTokens').value, '128');
  assert.equal(field('maxNodes').value, '10');
});

test('a failing storage write is not reported as saved', async () => {
  const env = await boot({ stored: storedSettings() });
  const before = clone(env.store.settings);
  env.failWrites('quota exceeded');
  env.field('localMaxTokens').value = '3000';

  await assert.rejects(() => click(env.field('save')), /quota exceeded/);

  assert.deepEqual(env.writes, [], 'nothing was written');
  assert.deepEqual(env.store.settings, before, 'storage still holds the old settings');
  assert.equal(env.field('saveStatus').textContent, '', 'no success message on a failed save');
  assert.equal(env.field('saveStatus').dataset.kind, undefined);
});

test('testing the engine probes with exactly the typed target language', async () => {
  const env = await boot({
    stored: storedSettings({ targetLang: 'ko' }),
    replies: { 'at/test-engine': () => ({ ok: true, result: { output: 'ok', detected: 'ko', ms: 1 } }) }
  });
  const { field } = env;

  field('targetLang').value = 'ja';
  await click(field('testEngine'));

  const probes = env.runtimeMessages.filter((message) => message.type === 'at/test-engine');
  assert.equal(probes.length, 1, 'one click is one probe');
  assert.deepEqual(probes[0], {
    type: 'at/test-engine',
    target: 'ja'
  }, 'the probe carries what is typed, not what is stored');
  assert.deepEqual(env.writes, [], 'testing must not save anything');
});

test('a successful probe renders the output and the elapsed time, no leftover placeholders', async () => {
  let resolveProbe!: (value: ATNamespace) => void;
  const probe = new Promise<ATNamespace>((resolve) => {
    resolveProbe = resolve;
  });
  const env = await boot({
    stored: storedSettings(),
    replies: { 'at/test-engine': () => probe }
  });
  const { field } = env;

  const flying = click(field('testEngine'));
  await flush();
  assert.equal(field('testStatus').textContent, msg('options_testing'), 'the row reports the running probe');
  assert.equal(field('testStatus').dataset.kind, 'info');

  resolveProbe({ ok: true, result: { output: 'Hallo Welt', detected: 'de', ms: 42 } });
  await flying;

  const rendered = field('testStatus').textContent;
  assert.equal(rendered, 'Hallo Welt (42 ms)');
  assert.ok(rendered.includes('Hallo Welt'), 'the probe output is shown');
  assert.ok(/42 ms/.test(rendered), 'the elapsed time is shown');
  assert.doesNotMatch(rendered, /\$\d\$/, 'no unexpanded substitution placeholder survives');
  assert.ok(!rendered.includes('$'), 'no dollar sign at all in the rendered status');
  assert.equal(field('testStatus').dataset.kind, 'ok');
});

test('a probe whose engine returned no text still renders a number, not undefined', async () => {
  const env = await boot({
    stored: storedSettings(),
    replies: { 'at/test-engine': { ok: true, result: { output: undefined, detected: null, ms: 7 } } }
  });
  await click(env.field('testEngine'));

  const rendered = env.field('testStatus').textContent;
  assert.equal(rendered, ' (7 ms)');
  assert.ok(!rendered.includes('undefined'), 'a missing output is not spelled out');
  assert.doesNotMatch(rendered, /\$\d\$/);
  assert.equal(env.field('testStatus').dataset.kind, 'ok');
});

test('a failed probe renders the error and never claims success', async () => {
  const env = await boot({ stored: storedSettings() });
  const { field } = env;

  env.replies['at/test-engine'] = { ok: false, error: 'Rate limit exceeded', code: 'rate-limit' };
  await click(field('testEngine'));
  assert.equal(field('testStatus').textContent, '[rate-limit] Rate limit exceeded');
  assert.equal(field('testStatus').dataset.kind, 'error');
  assert.ok(!/ms\)/.test(field('testStatus').textContent), 'a failure never shows a timing line');

  env.replies['at/test-engine'] = { ok: false, error: 'boom' };
  await click(field('testEngine'));
  assert.equal(field('testStatus').textContent, 'boom', 'no empty code bracket without a code');
  assert.equal(field('testStatus').dataset.kind, 'error');
  assert.ok(!field('testStatus').textContent.includes('['));

  delete env.replies['at/test-engine'];
  await click(field('testEngine'));
  assert.equal(
    field('testStatus').textContent,
    `[no-response] no listener answered ${env.AT.C.MSG.TEST_ENGINE}`,
    'a closed channel is reported, not swallowed'
  );
  assert.equal(field('testStatus').dataset.kind, 'error');
  assert.notEqual(field('testStatus').textContent, msg('options_saved'));
  assert.deepEqual(env.writes, [], 'a failed probe writes nothing');
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
  field('ruleAction').value = 'always';
  await click(field('addRule'));

  assert.equal(env.writes.length, 1, 'adding a rule is one save');
  const saved = savedSettings(env);
  assert.deepEqual(saved.siteRules, [
    { pattern: 'news.example.com', action: 'never' },
    { pattern: 'news.example.com/news/*', action: 'always' }
  ], 'the host and path are lower-cased, the typed action kept');
  assert.equal(field('rulePattern').value, '', 'the input is cleared for the next rule');
  assert.equal(field('saveStatus').dataset.kind, 'ok');
  assert.deepEqual(
    ruleItems(field('ruleList')).map((item) => [item.querySelectorAll('code')[0]!.textContent, item.querySelectorAll('span.tag')[0]!.dataset.action]),
    [
      ['news.example.com', 'never'],
      ['news.example.com/news/*', 'always']
    ],
    'the list is repainted from the reply, not from the input'
  );
});

test('re-adding a pattern replaces its action, a scheme-qualified one is its own rule', async () => {
  const env = await boot({ stored: storedSettings({ siteRules: [{ pattern: 'news.example.com', action: 'never' }] }) });
  const { field } = env;

  field('rulePattern').value = 'news.example.com/';
  field('ruleAction').value = 'always';
  await click(field('addRule'));
  assert.deepEqual(savedSettings(env).siteRules, [{ pattern: 'news.example.com', action: 'always' }], 'one rule, flipped action');
  assert.equal(ruleItems(field('ruleList')).length, 1);
  assert.equal(ruleItems(field('ruleList'))[0]!.querySelectorAll('span.tag')[0]!.textContent, msg('options_ruleAlways'));

  field('rulePattern').value = 'https://news.example.com';
  field('ruleAction').value = 'never';
  await click(field('addRule'));
  assert.deepEqual(
    savedSettings(env).siteRules.map((rule: ATNamespace) => rule.pattern),
    ['news.example.com', 'https://news.example.com'],
    'the scheme is part of the rule, so it is kept next to the bare host'
  );
  assert.equal(env.writes.length, 2);
});

test('a junk rule pattern is refused without touching storage', async () => {
  const env = await boot({ stored: storedSettings({ siteRules: [{ pattern: 'news.example.com', action: 'never' }] }) });
  const { field } = env;

  field('rulePattern').value = '   ';
  field('ruleAction').value = 'always';
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
  field('ruleAction').value = 'never';
  await fire(field('rulePattern'), 'keydown', { key: 'a' });
  assert.deepEqual(env.writes, [], 'typing a character must not add anything');

  await fire(field('rulePattern'), 'keydown', { key: 'Enter' });
  assert.equal(env.writes.length, 1, 'Enter goes through the Add rule button');
  assert.deepEqual(savedSettings(env).siteRules, [{ pattern: 'example.com', action: 'never' }]);
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
    [env.AT.C.MSG.LOCAL_GET_STATUS],
    'the removal is a storage write, no at/remove-site-rule'
  );
});

test('reset writes the defaults and repaints the form', async () => {
  const env = await boot({
    uiLang: 'ja',
    stored: storedSettings({
      targetLang: 'ko',
      sourceLang: 'ja',
      localMaxTokens: 2048,
      maxNodes: 900,
      enabled: false,
      autoDetect: false,
      showBadge: false,
      debug: true,
      siteRules: [{ pattern: 'news.example.com', action: 'never' }]
    })
  });
  const { AT, field } = env;

  field('debug').checked = true;
  await click(field('save'));
  assert.equal(AT.debug, true, 'the saved debug flag turns the logger on');
  env.writes.length = 0;

  await click(field('reset'));

  assert.equal(env.writes.length, 1, 'reset is one write');
  const saved = savedSettings(env);
  assert.equal(saved.localModelId, '', 'a reset forgets the chosen model');
  assert.equal(saved.targetLang, 'ja', 'the default target follows the UI language');
  assert.equal(saved.sourceLang, 'auto');
  assert.equal(saved.localMaxTokens, AT.local.DEFAULT_MAX_TOKENS);
  assert.equal(saved.maxNodes, AT.C.DEFAULT_MAX_NODES);
  assert.deepEqual(saved.siteRules, []);
  assert.equal('engine' in saved, false, 'the defaults carry no provider settings');
  assert.equal('endpoints' in saved, false);
  assert.deepEqual([field('enabled').checked, field('autoDetect').checked, field('showBadge').checked, field('debug').checked], [true, true, true, false]);
  assert.equal(field('localModel').value, '');
  assert.equal(field('localMaxTokens').value, '1024');
  assert.equal(field('maxNodes').value, '600');
  assert.equal(field('ruleList').children[0]!.className, 'empty', 'the rule list goes back to the empty row');
  assert.equal(field('saveStatus').textContent, msg('options_resetDone'));
  assert.equal(field('saveStatus').dataset.kind, 'ok');
  assert.equal(AT.debug, false, 'the restored debug flag turns the logger back off');
});

// --- on-device models ------------------------------------------------------

test('the local support line describes the host state', async () => {
  const offline = await boot();
  assert.equal(
    offline.field('localSupport').textContent,
    msg('options_localUnsupported'),
    'a host that never answers counts as unsupported'
  );

  const env = await boot({
    stored: storedSettings(),
    replies: {
      'at/local-get-status': { ok: true, supported: true, status: { state: 'ready', modelName: 'Gemma', loadMs: 12 } }
    }
  });

  assert.equal(
    env.field('localSupport').textContent,
    `${msg('options_stateReady')} · Gemma (12 ms)`,
    'the host describes itself through the catalogue'
  );
});

test('the injected models render in the picker, the list and the usage line', async () => {
  const empty = await boot({ stored: storedSettings() });
  assert.equal(empty.field('modelList').children[0]!.className, 'empty');
  assert.equal(empty.field('modelList').children[0]!.textContent, msg('options_noModels'));
  assert.deepEqual(empty.field('localModel').children.map((node) => node.value), ['']);
  assert.equal(empty.field('localModel').children[0]!.textContent, msg('options_localNone'));

  const env = await boot({
    stored: storedSettings({ localModelId: 'alpha-task' }),
    models: {
      token: 'hf-secret',
      rows: [
        modelRow({ id: 'alpha-task', name: 'alpha.task' }),
        modelRow({ id: 'beta-task', name: 'beta.task', createdAt: 1800000000000 })
      ]
    }
  });
  const { field } = env;

  assert.deepEqual(
    field('localModel').children.map((node) => [node.value, node.textContent]),
    [
      ['', msg('options_localNone')],
      ['beta-task', 'beta.task (3.6 GiB)'],
      ['alpha-task', 'alpha.task (3.6 GiB)']
    ],
    'newest first, each labelled with its size'
  );
  assert.equal(
    field('localModel').children.some((node) => node.value === 'alpha-task'),
    true,
    'the stored model is offered in the picker'
  );
  assert.equal(field('localMaxTokens').value, '1024', 'the budget is the stored number');
  assert.equal(field('modelToken').value, 'hf-secret', 'the token comes back out of the blob store');

  const items = field('modelList').querySelectorAll('li.rule');
  assert.deepEqual(items.map((item) => item.querySelectorAll('code')[0]!.textContent), ['beta.task', 'alpha.task']);
  assert.deepEqual(
    items.map((item) => item.querySelectorAll('span.tag')[0]!.textContent),
    ['3.6 GiB', '● 3.6 GiB'],
    'the chosen model carries the bullet'
  );
  assert.equal(field('localUsage').textContent, msg('options_usage', ['5.0 GiB', '20.0 GiB', '2', '7.3 GiB']));
});

test('the usage line admits when the browser may evict the model', async () => {
  const env = await boot({
    models: {
      rows: [modelRow({ id: 'alpha-task', name: 'alpha.task' })],
      estimate: { usage: 5 * 1024 ** 3, quota: 20 * 1024 ** 3, persisted: false }
    }
  });
  assert.equal(
    env.field('localUsage').textContent,
    `${msg('options_usage', ['5.0 GiB', '20.0 GiB', '1', '3.6 GiB'])} · ${msg('options_notPersisted')}`,
    'an unpinned store is named, not left to vanish between visits'
  );
});

test('the stored model is selected on boot and survives a save nobody touched', async () => {
  const env = await boot({
    stored: storedSettings({ localModelId: 'alpha-task' }),
    models: { rows: [modelRow({ id: 'alpha-task', name: 'alpha.task' })] }
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
      rows: [modelRow({ id: 'alpha-task', name: 'alpha.task' }), modelRow({ id: 'beta-task', name: 'beta.task' })]
    }
  });
  const { AT, field } = env;
  const booted = env.runtimeMessages.length;

  await click(modelItem(field('modelList'), 'alpha.task').querySelectorAll('button')[0]!);
  await idle();

  assert.deepEqual(env.model.removed, ['alpha-task'], 'the store is asked to delete exactly that id');
  assert.deepEqual(env.model.rows().map((row) => row.id), ['beta-task'], 'its metadata row is gone');
  assert.deepEqual(
    env.runtimeMessages.slice(booted).map((message) => message.type),
    [AT.C.MSG.LOCAL_RELEASE],
    'the model the user was translating with is unloaded'
  );
  assert.equal(savedSettings(env).localModelId, '', 'the setting no longer names a deleted model');
  assert.equal(field('modelStatus').textContent, msg('options_deleted', 'alpha.task'));
  assert.equal(field('modelStatus').dataset.kind, 'ok');
  assert.deepEqual(
    field('modelList').querySelectorAll('li.rule').map((item) => item.querySelectorAll('code')[0]!.textContent),
    ['beta.task'],
    'the list is repainted from the store'
  );
});

test('deleting an unselected model leaves the settings and the host alone', async () => {
  const env = await boot({
    stored: storedSettings({ localModelId: 'alpha-task' }),
    models: {
      rows: [modelRow({ id: 'alpha-task', name: 'alpha.task' }), modelRow({ id: 'beta-task', name: 'beta.task' })]
    }
  });
  const { field } = env;
  const booted = env.runtimeMessages.length;

  await click(modelItem(field('modelList'), 'beta.task').querySelectorAll('button')[0]!);
  await idle();

  assert.deepEqual(env.model.removed, ['beta-task'], 'the file is still deleted');
  assert.deepEqual(env.runtimeMessages.slice(booted), [], 'nothing to release for a model that never loaded');
  assert.deepEqual(env.writes, [], 'the settings are untouched');
  assert.equal(field('localModel').value, 'alpha-task', 'and the selection stays');
});

test('downloading a model streams its progress and then registers it', async () => {
  const env = await boot({
    stored: storedSettings({ localModelId: '' }),
    models: { token: 'hf-secret' }
  });
  const { AT, field } = env;

  assert.equal(field('modelUrl').value, AT.local.MODEL_SOURCES[0].url, 'the catalogue url is prefilled');
  assert.equal(field('modelProgress').hidden, true, 'nothing is in flight before the click');
  assert.equal(env.model.downloads.length, 0, 'boot never downloads');

  await click(field('downloadModel'));
  await idle();

  assert.equal(env.model.downloads.length, 1, 'one click is one download');
  const request = env.model.downloads[0]!;
  assert.equal(request.url, AT.local.MODEL_SOURCES[0].url);
  assert.equal(request.token, 'hf-secret', 'the typed token travels with the request');
  assert.equal(request.expectedSize, AT.local.MODEL_SOURCES[0].size, 'the catalogue size is the sanity check');
  assert.equal(env.model.fetches[0]!.init.headers.Authorization, 'Bearer hf-secret');

  assert.deepEqual(
    env.progress.map((tick) => [tick.value, tick.max, tick.hidden]),
    [
      [1948188672, MODEL_BYTES, false],
      [MODEL_BYTES, MODEL_BYTES, false]
    ],
    'every chunk moves the bar'
  );
  assert.equal(env.progress[0]!.status, msg('options_downloading', ['1.8 GiB', '3.6 GiB']), 'and reports the bytes');

  assert.equal(field('modelProgress').hidden, true, 'the bar is hidden once the file is stored');
  assert.equal(field('downloadModel').disabled, false, 'the buttons are live again');
  const rows = env.model.rows();
  assert.equal(rows.length, 1, 'a complete file is the only thing registered');
  assert.equal(rows[0]!.name, 'translategemma-4b-it-int8-web.task', 'named after the url');
  assert.equal(rows[0]!.size, MODEL_BYTES);
  assert.equal(savedSettings(env).localModelId, rows[0]!.id, 'the first model becomes the selected one');
  assert.equal(field('localModel').value, rows[0]!.id, 'and the picker follows');
  assert.match(
    String(field('modelStatus').textContent),
    /^translategemma-4b-it-int8-web\.task \(3\.6 GiB\) stored in \d+ s$/,
    'the line names the file, its size and how long it took'
  );
});

test('saving stores the on-device choices, clamping the budget', async () => {
  const env = await boot({
    stored: storedSettings(),
    models: { rows: [modelRow({ id: 'alpha-task', name: 'alpha.task' })] }
  });
  const { AT, field } = env;

  field('localModel').value = 'alpha-task';
  field('localMaxTokens').value = '2048';
  await click(field('save'));

  assert.equal(env.writes.length, 1, 'one save is one write');
  const saved = savedSettings(env);
  assert.equal(saved.localModelId, 'alpha-task');
  assert.equal(typeof saved.localMaxTokens, 'number', 'the budget reaches storage as a number');
  assert.equal(saved.localMaxTokens, 2048);

  field('localMaxTokens').value = '999999';
  await click(field('save'));

  const second = savedSettings(env);
  assert.equal(second.localMaxTokens, AT.local.MAX_MAX_TOKENS, 'an oversized budget clamps to the ceiling');
  assert.equal(field('localMaxTokens').value, String(AT.local.MAX_MAX_TOKENS), 'the form repaints from storage');
});

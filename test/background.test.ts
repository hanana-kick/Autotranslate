import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SRC, load, resetGlobals, deferred, type ATNamespace } from './helpers.ts';

// The manifest's background scripts, minus the entry point itself: the harness
// boots the page the way the browser would.
const LIBS = [
  'lib/constants.js',
  'lib/browser.js',
  'lib/gemma.js',
  'lib/pagecontext.js',
  'lib/targets.js',
  'lib/rules.js',
  'lib/local.js',
  'lib/modelstore.js',
  'lib/settings.js',
  'lib/engines.js',
  'lib/localhost.js',
  'lib/dom.js'
];
const MENU_IDS = ['translate-page', 'restore-page', 'translate-selection', 'never-site', 'always-site'];
const CONTENT_FILES = [
  'vendor/browser-polyfill.js',
  'lib/constants.js',
  'lib/browser.js',
  'lib/pagecontext.js',
  'lib/targets.js',
  'lib/pipeline.js',
  'lib/dom.js',
  'content.js'
];
/** `AT.local.TARGET_OFFSCREEN`: the routing field that addresses the host. */
const OFFSCREEN_HOST = 'offscreen';

type Recorded = {
  imported: string[] | null;
  menus: ATNamespace[];
  badges: ATNamespace[];
  titles: ATNamespace[];
  tabMessages: ATNamespace[];
  injected: ATNamespace[];
  /** Messages the background addressed to the offscreen host. */
  hostMessages: ATNamespace[];
  /** `chrome.offscreen.createDocument` calls. */
  offscreen: ATNamespace[];
  /** Calls the background made straight into the host module in this page. */
  inline: { place: string | null; handled: string[]; messages: ATNamespace[] };
  optionsOpened: number;
  storage: ATNamespace;
};

const host = globalThis as ATNamespace;

/** The channel resolves with `undefined` when no listener claims the message. */
const silence = undefined as unknown as ATNamespace;

/** A tab as the chrome stand-in reports it. */
type Tab = { id?: number; url?: string; title?: string; ping?: boolean; translated?: number };

/** A message the background sends into a tab. */
type TabMessage = { type: string; text?: string };

/** An event listener background.js registers; the tests fire them with raw arguments. */
type Listener = (...args: unknown[]) => unknown;

/** A runtime listener: it returns true when it will answer asynchronously. */
type MessageListener = (message: ATNamespace, sender: ATNamespace, respond: (payload: unknown) => void) => unknown;


type Events = {
  installed: Listener[];
  startup: Listener[];
  menuClicks: Listener[];
  updated: Listener[];
  removed: Listener[];
  storageChanged: Listener[];
  messages: MessageListener[];
};

type WorkerScope = {
  location: { href: string };
  importScripts?: (...lists: (string | string[])[]) => void;
};

type EnvironmentOptions = {
  settings?: ATNamespace;
  tab?: Tab;
  tabs?: Tab[];
  withImportScripts?: boolean;
  /** Install `chrome.offscreen`: the model runs in a document of its own. */
  withOffscreen?: boolean;
  /** Load the host module into the background page, as Firefox does: `real`
   *  evaluates lib/localhost.js, `stub` installs a scripted stand-in. */
  inlineHost?: 'real' | 'stub';
  /** Which global carries the API: standard `browser` (default) or the
   *  Chrome-only `chrome` fallback that lib/browser.ts resolves. */
  apiGlobal?: 'browser' | 'chrome';
  /** The host document is already open when the background boots. */
  resident?: boolean;
  /** Replies to messages addressed to the host, keyed by message type. */
  hostReplies?: ATNamespace;
};

/** Replies to the messages the background sends into a tab. */
function tabReply(message: TabMessage, tab: Tab = {}) {
  switch (message.type) {
    case 'at/content-ping':
      return tab.ping === false
        ? { ok: false, error: 'no content script' }
        : { ok: true, pong: message.type, translated: tab.translated ?? 0 };
    case 'at/content-translate':
      return { ok: true, status: 'translated', translated: tab.translated ?? 3, detected: 'en' };
    case 'at/content-translate-selection':
      return { ok: true, translated: `\u00bb${message.text}\u00ab` };
    case 'at/content-restore':
      return { ok: true, restored: tab.translated ?? 0 };
    default:
      return { ok: false, error: `unhandled ${message.type}` };
  }
}

/** Stands in for lib/localhost.js when the background page is the host. */
function inlineHostStub(record: { place: string | null; handled: string[]; messages: ATNamespace[] }) {
  let state: ATNamespace = unloadedStatus;
  let report: ((status: ATNamespace) => void) | null = null;
  const publish = (next: ATNamespace) => {
    state = next;
    report?.(next);
    return { status: next };
  };
  return {
    install(place: string, fn: (status: ATNamespace) => void) {
      record.place = place;
      report = fn;
      return state;
    },
    async handle(message: ATNamespace) {
      record.handled.push(message.type);
      record.messages.push(message);
      switch (message.type) {
        case 'at/local-load':
          return publish({ ...readyStatus, modelId: message.modelId });
        case 'at/local-unload':
          return publish({ ...unloadedStatus });
        case 'at/local-status':
          return { status: state };
        case 'at/local-translate': {
          const texts = Array.isArray(message.texts) ? message.texts : [];
          return { translations: texts.map((text: string) => `\u00bb${text}\u00ab`), engine: 'local' };
        }
        default:
          return {};
      }
    }
  };
}

/**
 * Boots background.js the way a browser would: the shared libs first as classic
 * scripts, then the entry point, against a recording `browser` stand-in — the
 * standard name the polyfill installs, so the tests exercise what production
 * calls. One test boots with only `chrome` present to cover the fallback.
 */
function environment({
  settings,
  tab,
  tabs,
  withImportScripts = true,
  withOffscreen = false,
  inlineHost,
  apiGlobal = 'browser',
  resident = false,
  hostReplies
}: EnvironmentOptions = {}) {
  resetGlobals();
  const recorded: Recorded = {
    imported: null,
    menus: [],
    badges: [],
    titles: [],
    tabMessages: [],
    injected: [],
    hostMessages: [],
    offscreen: [],
    inline: { place: null, handled: [], messages: [] },
    optionsOpened: 0,
    storage: settings ? { settings } : {}
  };

  let hasHostDocument = resident === true;
  const events: Events = { installed: [], startup: [], menuClicks: [], updated: [], removed: [], storageChanged: [], messages: [] };

  const dispatch = (message: ATNamespace, sender: ATNamespace = {}) => {
    if (message?.to === OFFSCREEN_HOST) {
      // The host is a document of its own: it answers what it is asked and the
      // background only ever sees the reply.
      recorded.hostMessages.push(message);
      const answer = hostReplies?.[message.type];
      return Promise.resolve((typeof answer === 'function' ? answer(message) : answer) ?? silence);
    }
    // Mirrors the real protocol: a listener returns true when it will answer
    // asynchronously. If none does, the channel closes and the sender resolves
    // with undefined.
    const { promise, resolve } = deferred<ATNamespace>();
    let answered = false;
    const respond = (payload: unknown) => {
      if (answered) return;
      answered = true;
      resolve(payload as ATNamespace);
    };
    const willAnswer = events.messages.map((listener) => listener(message, sender, respond));
    if (!willAnswer.includes(true)) resolve(silence);
    return promise;
  };

  const surface: ATNamespace = {
    runtime: {
      lastError: null,
      id: 'autotranslate@hanana-kick',
      getURL: (path: string) => path,
      openOptionsPage: async () => {
        recorded.optionsOpened += 1;
      },
      sendMessage: (message: ATNamespace) => dispatch(message, {}),
      onMessage: { addListener: (fn: MessageListener) => events.messages.push(fn) },
      onInstalled: { addListener: (fn: Listener) => events.installed.push(fn) },
      onStartup: { addListener: (fn: Listener) => events.startup.push(fn) }
    },
    i18n: {
      getUILanguage: () => 'en',
      getMessage: (key: string) => `[${key}]`
    },
    storage: {
      local: {
        get: async (key: string) => (recorded.storage[key] === undefined ? {} : { [key]: recorded.storage[key] }),
        set: async (value: ATNamespace) => {
          Object.assign(recorded.storage, value);
          // The browser notifies the extension about its own writes; the
          // background relies on this to drop its settings cache.
          const changes = Object.fromEntries(
            Object.keys(value).map((key): [string, { newValue: unknown }] => [key, { newValue: recorded.storage[key] }])
          );
          for (const listener of events.storageChanged) listener(changes, 'local');
        }
      },
      onChanged: { addListener: (fn: Listener) => events.storageChanged.push(fn) }
    },
    action: {
      setBadgeText: async (details: ATNamespace) => recorded.badges.push(details),
      setBadgeBackgroundColor: async (details: ATNamespace) => recorded.badges.push(details),
      setTitle: async (details: ATNamespace) => recorded.titles.push(details)
    },
    tabs: {
      query: async () => tabs ?? (tab ? [tab] : []),
      get: async (tabId: number) => (tab && tab.id === tabId ? tab : null),
      update: async () => {},
      onUpdated: { addListener: (fn: Listener) => events.updated.push(fn) },
      onRemoved: { addListener: (fn: Listener) => events.removed.push(fn) },
      sendMessage: async (tabId: number, message: TabMessage) => {
        recorded.tabMessages.push({ tabId, message });
        return tabReply(message, tab);
      }
    },
    scripting: {
      executeScript: async (details: ATNamespace) => {
        recorded.injected.push(details);
        return [{ result: null }];
      }
    },
    contextMenus: {
      removeAll: async () => {
        recorded.menus = [];
      },
      create: (item: ATNamespace) => recorded.menus.push(item),
      onClicked: { addListener: (fn: Listener) => events.menuClicks.push(fn) }
    },
    // Chrome provides these; without them the background has to say the model
    // cannot run instead of asking for a document that cannot exist.
    ...(withOffscreen
      ? {
          offscreen: {
            createDocument: async (details: ATNamespace) => {
              recorded.offscreen.push(details);
              hasHostDocument = true;
            },
            hasDocument: async () => hasHostDocument,
            closeDocument: async () => {
              hasHostDocument = false;
            }
          }
        }
      : {})
  };

  // Only the standard name unless a test asks for the fallback: with `browser`
  // present, lib/browser.ts never touches `chrome` at all.
  host[apiGlobal] = surface;
  const self: WorkerScope = { location: { href: 'chrome-extension://test/background.js' } };
  if (withImportScripts) {
    self.importScripts = (...lists) => {
      recorded.imported = lists.flat();
    };
  }
  host.self = self;

  const AT = load(...LIBS, 'background.js');
  // A Firefox background page is the host: the module is part of the page (it
  // is in the manifest's scripts) and the background calls it directly.
  if (inlineHost === 'stub') AT.localhost = inlineHostStub(recorded.inline);
  const send = dispatch;
  const browser = surface;
  const types = () => recorded.tabMessages.map((entry) => entry.message.type);
  return { AT, browser, recorded, events, send, fire, types };
}

/** A host that has the model resident, in the shape `normalizeStatus` accepts. */
const readyStatus = {
  target: 'offscreen',
  supported: true,
  reason: null,
  state: 'ready',
  modelId: 'model-a',
  modelName: 'TranslateGemma 4B IT (int8, web)',
  loadedBytes: 3896377344,
  loadMs: 4200,
  generations: 0,
  lastError: null
};

/** The same host after it has dropped the model. */
const unloadedStatus = {
  ...readyStatus,
  state: 'unloaded',
  modelId: null,
  modelName: null,
  loadedBytes: 0,
  loadMs: null
};

/**
 * Fires an event listener list and lets queued work settle. `setImmediate` is a
 * queue hop rather than a clock wait: every pending microtask chain (async
 * handlers, stubbed host replies) has run by the time it fires, so nothing
 * has to be guessed at.
 */
const fire = async (list: Listener[], ...args: unknown[]) => {
  for (const listener of list) await listener(...args);
  await new Promise((resolve) => setImmediate(resolve));
};

test('the worker bootstraps exactly the scripts the manifest lists', () => {
  const { recorded } = environment();
  const manifest = JSON.parse(readFileSync(join(SRC, 'manifest.json'), 'utf8'));
  const expected = manifest.background.scripts.filter((file: string) => file !== 'background.js');
  assert.deepEqual(recorded.imported, expected, 'the worker imports the shared libs in manifest order');
  assert.equal(manifest.background.scripts.at(-1), 'background.js');
});

test('a context with only the chrome global still boots through the abstraction', () => {
  // Chrome hands the raw `chrome` object when the polyfill has not run yet;
  // lib/browser.ts is the one place allowed to read either global, and it
  // prefers the standard name. Everything else sees AT.api and nothing else.
  const { AT, recorded } = environment({ apiGlobal: 'chrome' });
  const manifest = JSON.parse(readFileSync(join(SRC, 'manifest.json'), 'utf8'));
  assert.deepEqual(recorded.imported, manifest.background.scripts.slice(0, -1));
  assert.equal(typeof AT.api, 'object', 'the fallback resolves to a usable handle');
  assert.equal(AT.supportsOffscreen(), false, 'the fallback surface has no offscreen API here');
});

test('the event page boots without importScripts (Firefox)', () => {
  const { AT, recorded } = environment({ withImportScripts: false });
  assert.equal(recorded.imported, null);
  assert.equal(typeof AT.engines.translate, 'function');
});

test('install seeds settings and registers the context menu', async () => {
  const { AT, events, recorded } = environment();
  await fire(events.installed, { reason: 'install' });
  assert.equal(recorded.storage.settings.enabled, true, 'an install starts enabled');
  assert.equal(recorded.storage.settings.localModelId, '', 'and with no on-device model selected');
  assert.equal(
    recorded.storage.settings.localMaxTokens,
    AT.local.DEFAULT_MAX_TOKENS,
    'the token budget starts at the model default'
  );
  assert.deepEqual(recorded.storage.settings.siteRules, []);
  assert.deepEqual(recorded.menus.map((item) => item.id), MENU_IDS);
  for (const item of recorded.menus) {
    assert.match(item.title, /^\[menu.+\]$/, `menu title must come from i18n: ${item.id}`);
    assert.ok(item.contexts.length > 0);
  }
  await fire(events.startup);
  assert.deepEqual(recorded.menus.map((item) => item.id), MENU_IDS, 'startup rebuilds the menu');
});

test('content batches reach the host once per unique text', async () => {
  const { AT, send, recorded } = environment({
    inlineHost: 'stub',
    settings: { localModelId: 'model-a', targetLang: 'ko' }
  });
  const reply = await send({ type: AT.C.MSG.BATCH, texts: ['Hello', 'Hello', 'Good morning'] });
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.translations, ['\u00bbHello\u00ab', '\u00bbHello\u00ab', '\u00bbGood morning\u00ab']);
  const requests = recorded.inline.messages.filter((entry) => entry.type === AT.C.MSG.LOCAL_TRANSLATE);
  assert.equal(requests.length, 1, 'unique texts share one generation');
  assert.deepEqual(requests[0]!.texts, ['Hello', 'Good morning'], 'the duplicate is sent once');
});

test('host failures reach the content script as an error, not a half translation', async () => {
  const { AT, send } = environment({
    settings: { localModelId: 'model-a', targetLang: 'ko' },
    withOffscreen: true,
    resident: true,
    hostReplies: {
      'at/local-translate': () => ({ ok: false, error: 'no webgpu device', code: 'no-webgpu' })
    }
  });
  const reply = await send({ type: AT.C.MSG.BATCH, texts: ['Hello'] });
  assert.equal(reply.ok, false);
  assert.equal(reply.code, 'provider', 'an unknown host reason is still a provider-side failure');
  assert.match(reply.error, /no webgpu device/);
  assert.equal(reply.translations, undefined, 'nothing comes back, so the page keeps its source text');
});

test('navigation injects the content script and asks it to translate', async () => {
  const tab = { id: 7, url: 'https://news.example.com/article', title: 'News', ping: false, translated: 3 };
  const { AT, events, recorded, types } = environment({ tab });
  await fire(events.updated, 7, { status: 'complete' }, tab);

  assert.equal(recorded.injected.length, 1);
  assert.deepEqual(recorded.injected[0], { target: { tabId: 7 }, files: CONTENT_FILES });
  const translate = recorded.tabMessages.find((entry) => entry.message.type === AT.C.MSG.CONTENT_TRANSLATE);
  assert.equal(translate!.tabId, 7);
  assert.equal(translate!.message.decision.action, 'detect', 'no rule means language detection');
  assert.deepEqual(
    translate!.message.settings,
    {
      enabled: true,
      autoDetect: true,
      targetLang: 'en',
      sourceLang: 'auto',
      maxNodes: AT.C.DEFAULT_MAX_NODES,
      showBadge: true
    },
    'the content script gets the bounded snapshot, never the stored blob'
  );
  assert.deepEqual(types(), ['at/content-ping', 'at/content-translate']);
  assert.ok(
    recorded.badges.some((entry) => entry.text === AT.C.BADGE_TEXT),
    'the badge follows the reported count'
  );
});

test('an existing content script is not injected twice', async () => {
  const tab = { id: 7, url: 'https://news.example.com/article', translated: 2 };
  const { events, recorded, types } = environment({ tab });
  await fire(events.updated, 7, { status: 'complete' }, tab);
  assert.deepEqual(recorded.injected, [], 'the ping answered, so no injection');
  assert.deepEqual(types(), ['at/content-ping', 'at/content-translate']);
});

test('the master switch, auto-detect and site rules suppress translation', async () => {
  const tab = { id: 7, url: 'https://news.example.com/article' };
  const cases: [ATNamespace, string][] = [
    [{ enabled: false }, 'disabled'],
    [{ autoDetect: false }, 'auto-off'],
    [{ siteRules: [{ pattern: 'news.example.com', action: 'never' }] }, 'site-never']
  ];
  for (const [settings, reason] of cases) {
    const { events, recorded } = environment({ tab, settings });
    await fire(events.updated, 7, { status: 'complete' }, tab);
    assert.deepEqual(recorded.injected, [], `${reason} must not inject`);
    assert.deepEqual(recorded.tabMessages, [], `${reason} must not message the tab`);
  }
});

test('a site rule of always forces translation without detection', async () => {
  const tab = { id: 7, url: 'https://news.example.com/article', ping: false };
  const { AT, events, recorded } = environment({
    tab,
    settings: { autoDetect: false, siteRules: [{ pattern: 'news.example.com', action: 'always' }] }
  });
  await fire(events.updated, 7, { status: 'complete' }, tab);
  const translate = recorded.tabMessages.find((entry) => entry.message.type === AT.C.MSG.CONTENT_TRANSLATE);
  assert.equal(translate!.message.decision.action, 'translate');
  assert.equal(translate!.message.decision.pattern, 'news.example.com');
});

test('browser and translator pages are left alone', async () => {
  const urls = [
    'https://addons.mozilla.org/en-US/firefox/extensions/',
    'https://chromewebstore.google.com/detail/x',
    'https://translate.google.com/',
    'chrome://extensions',
    'file:///tmp/notes.html'
  ];
  for (const url of urls) {
    const { events, recorded } = environment({ tab: { id: 7, url } });
    await fire(events.updated, 7, { status: 'complete' }, { id: 7, url });
    assert.deepEqual(recorded.injected, [], url);
    assert.deepEqual(recorded.tabMessages, [], url);
  }
});

test('at/get-state reports the tab, the rule and the badge state', async () => {
  const tab = { id: 7, url: 'https://News.example.com/Article', title: 'News' };
  const { AT, send, recorded } = environment({
    tab,
    settings: { siteRules: [{ pattern: 'news.example.com/*', action: 'never' }] }
  });
  const reply = await send({ type: AT.C.MSG.GET_STATE, tabId: 7 });
  assert.equal(reply.ok, true);
  assert.equal(reply.tab.host, 'news.example.com');
  assert.equal(reply.tab.title, 'News');
  assert.equal(reply.canTranslate, true);
  assert.equal(reply.rule, 'never');
  assert.equal(reply.state, null, 'untouched tabs have no state');
  assert.deepEqual(recorded.storage.settings, { siteRules: [{ pattern: 'news.example.com/*', action: 'never' }] }, 'reading state must not write settings');
});

test('settings patches are normalised and stripped before they come back', async () => {
  const { AT, send, recorded } = environment({ settings: { localModelId: 'model-a' } });
  const reply = await send({
    type: AT.C.MSG.SET_SETTINGS,
    patch: {
      maxNodes: 99999,
      localMaxTokens: 99999,
      targetLang: 'klingon',
      siteRules: [{ pattern: 'www.Example.com/', action: 'always' }]
    }
  });
  assert.equal(reply.ok, true);
  assert.equal(reply.settings.maxNodes, 5000);
  assert.equal(reply.settings.targetLang, 'en', 'an unknown language falls back');
  assert.equal(reply.settings.localModelId, undefined, 'the snapshot carries no model selection');
  assert.equal(
    recorded.storage.settings.localMaxTokens,
    AT.local.MAX_MAX_TOKENS,
    'the token budget is clamped to what the host can run'
  );
  assert.deepEqual(recorded.storage.settings.siteRules, [{ pattern: 'example.com', action: 'always' }]);
  assert.equal(recorded.storage.settings.localModelId, 'model-a', 'the stored model survives unrelated patches');
});

test('site rules are canonicalised, replaced and removed by host', async () => {
  const tab = { id: 7, url: 'https://news.example.com/article' };
  const { AT, send, recorded } = environment({ tab });
  const added = await send({ type: AT.C.MSG.SET_SITE_RULE, tabId: 7, action: 'never' });
  assert.equal(added.pattern, 'news.example.com');
  assert.equal(added.settings.siteRules, undefined, 'the content snapshot carries no site rules');
  assert.deepEqual(recorded.storage.settings.siteRules, [{ pattern: 'news.example.com', action: 'never' }]);

  await send({ type: AT.C.MSG.SET_SITE_RULE, pattern: 'WWW.News.Example.COM/', action: 'always' });
  assert.deepEqual(recorded.storage.settings.siteRules, [{ pattern: 'news.example.com', action: 'always' }], 'same host is replaced, not duplicated');

  await send({ type: AT.C.MSG.REMOVE_SITE_RULE, pattern: 'news.example.com' });
  assert.deepEqual(recorded.storage.settings.siteRules, []);

  const invalid = await send({ type: AT.C.MSG.SET_SITE_RULE, pattern: '', tabId: 99 });
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /invalid site pattern/);
  assert.equal(recorded.tabMessages.length, 0, 'rule edits never touch the tab');
});

test('the badge follows reported content-script state', async () => {
  const { AT, send, recorded } = environment();
  await send({ type: AT.C.MSG.STATE_CHANGED, status: 'translated', translated: 4 }, { tab: { id: 3 } });
  assert.deepEqual(recorded.badges.at(-2), { tabId: 3, text: AT.C.BADGE_TEXT });
  assert.equal(recorded.badges.at(-1)!.color, AT.C.BADGE_COLOR);

  const afterReported = recorded.badges.length;
  await send({ type: AT.C.MSG.STATE_CHANGED, status: 'translated', translated: 4 }, {});
  assert.equal(recorded.badges.length, afterReported, 'a report without a tab changes nothing');

  await send({ type: AT.C.MSG.STATE_CHANGED, status: 'idle', translated: 0 }, { tab: { id: 3 } });
  assert.equal(recorded.badges.at(-1)!.text, '');
});

test('hidden badges stay off even for translated pages', async () => {
  const { AT, send, recorded } = environment({ settings: { showBadge: false } });
  await send({ type: AT.C.MSG.STATE_CHANGED, status: 'translated', translated: 9 }, { tab: { id: 4 } });
  assert.deepEqual(recorded.badges, [{ tabId: 4, text: '' }]);
});

test('the popup translate and restore messages drive the tab', async () => {
  const tab = { id: 7, url: 'https://news.example.com/article', translated: 3 };
  const { AT, send, types } = environment({ tab });
  const translated = await send({ type: AT.C.MSG.TRANSLATE_TAB, tabId: 7 });
  assert.equal(translated.ok, true);
  assert.equal(translated.status, 'translated');
  assert.equal(translated.translated, 3);
  assert.equal(translated.reason, 'manual', 'popup clicks are forced, not detected');

  const restored = await send({ type: AT.C.MSG.RESTORE_TAB, tabId: 7 });
  assert.equal(restored.status, 'idle');
  assert.deepEqual(types(), ['at/content-ping', 'at/content-translate', 'at/content-ping', 'at/content-restore']);

  const missing = await send({ type: AT.C.MSG.TRANSLATE_TAB, tabId: 8 });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /no active tab/);
});

test('a message nothing answers is reported instead of hanging', async () => {
  const { AT, send, browser } = environment({ tab: { id: 7, url: 'https://news.example.com/article' } });
  assert.equal(await send({ type: 'at/does-not-exist' }), undefined, 'the raw channel stays silent');

  const unanswered = await AT.sendMessage({ type: 'at/does-not-exist' });
  assert.equal(unanswered.ok, false);
  assert.equal(unanswered.code, 'no-response');
  assert.match(unanswered.error, /no listener answered at\/does-not-exist/);

  const original = browser.runtime.sendMessage;
  browser.runtime.sendMessage = async () => {
    throw new Error('Extension context invalidated.');
  };
  const broken = await AT.sendMessage({ type: AT.C.MSG.GET_STATE });
  assert.equal(broken.ok, false);
  assert.equal(broken.code, 'no-response');
  assert.match(broken.error, /Extension context invalidated/);
  browser.runtime.sendMessage = original;

  const answered = await AT.sendMessage({ type: AT.C.MSG.GET_STATE, tabId: 7 });
  assert.equal(answered.ok, true);
  assert.equal(answered.tab.host, 'news.example.com');
});

test('the model test probes with one sentence through the host', async () => {
  const { AT, send, recorded } = environment({
    inlineHost: 'stub',
    settings: { localModelId: 'model-a', targetLang: 'de' }
  });
  const reply = await send({ type: AT.C.MSG.TEST_ENGINE, target: 'de' });
  assert.equal(reply.ok, true);
  assert.equal(reply.result.output, `\u00bb${AT.engines.TEST_SENTENCE}\u00ab`);
  assert.equal(typeof reply.result.ms, 'number');

  const probes = recorded.inline.messages.filter((entry) => entry.type === AT.C.MSG.LOCAL_TRANSLATE);
  assert.equal(probes.length, 1, 'one sentence, one generation');
  assert.deepEqual(probes[0]!.texts, [AT.engines.TEST_SENTENCE]);
  assert.equal(probes[0]!.modelId, 'model-a', 'the stored selection is the model probed');
  assert.equal(probes[0]!.target, 'de');
});

test('context menu entries act on the clicked tab', async () => {
  const tab = { id: 7, url: 'https://news.example.com/article', translated: 3 };
  const { AT, events, recorded, types } = environment({ tab });

  await fire(events.menuClicks, { menuItemId: 'translate-page' }, tab);
  assert.ok(types().includes(AT.C.MSG.CONTENT_TRANSLATE));

  await fire(events.menuClicks, { menuItemId: 'translate-selection', selectionText: 'some words' }, tab);
  const selection = recorded.tabMessages.at(-1);
  assert.equal(selection!.message.type, AT.C.MSG.CONTENT_TRANSLATE_SELECTION);
  assert.equal(selection!.message.text, 'some words');

  await fire(events.menuClicks, { menuItemId: 'never-site' }, tab);
  assert.deepEqual(recorded.storage.settings.siteRules, [{ pattern: 'news.example.com', action: 'never' }]);
  assert.ok(types().includes(AT.C.MSG.CONTENT_RESTORE), 'never restores the page immediately');

  await fire(events.menuClicks, { menuItemId: 'never-site' }, tab);
  assert.deepEqual(recorded.storage.settings.siteRules, [], 'a second click clears the rule');

  const before = recorded.tabMessages.length;
  await fire(events.menuClicks, { menuItemId: 'translate-page' }, undefined);
  assert.equal(recorded.tabMessages.length, before, 'a click without a tab does nothing');
});

test('closing a tab drops its state and storage edits refresh the cache', async () => {
  const tab = { id: 7, url: 'https://news.example.com/article', translated: 3 };
  const { AT, events, recorded, send } = environment({ tab });
  await send({ type: AT.C.MSG.TRANSLATE_TAB, tabId: 7 });
  const beforeClose = await send({ type: AT.C.MSG.GET_STATE, tabId: 7 });
  assert.equal(beforeClose.state.translated, 3);

  await fire(events.removed, 7);
  const afterClose = await send({ type: AT.C.MSG.GET_STATE, tabId: 7 });
  assert.equal(afterClose.state, null);

  await send({ type: AT.C.MSG.SET_SETTINGS, patch: { targetLang: 'de' } });
  const cached = await send({ type: AT.C.MSG.TRANSLATE_TAB, tabId: 7 });
  assert.equal(cached.ok, true);
  const before = recorded.tabMessages.filter((entry) => entry.message.type === AT.C.MSG.CONTENT_TRANSLATE).at(-1);
  assert.equal(before!.message.settings.targetLang, 'de', 'the cached settings are reused');

  recorded.storage.settings.targetLang = 'ja';
  const stale = await send({ type: AT.C.MSG.TRANSLATE_TAB, tabId: 7 });
  assert.equal(stale.ok, true);
  const stillCached = recorded.tabMessages.filter((entry) => entry.message.type === AT.C.MSG.CONTENT_TRANSLATE).at(-1);
  assert.equal(stillCached!.message.settings.targetLang, 'de', 'an external write is invisible until onChanged fires');

  await fire(events.storageChanged, { settings: { newValue: recorded.storage.settings } }, 'local');
  await send({ type: AT.C.MSG.TRANSLATE_TAB, tabId: 7 });
  const refreshed = recorded.tabMessages.filter((entry) => entry.message.type === AT.C.MSG.CONTENT_TRANSLATE).at(-1);
  assert.equal(refreshed!.message.settings.targetLang, 'ja', 'onChanged invalidates the settings cache');
});

test('the on-device engine gets an offscreen host that loads the selected model', async () => {
  const { AT, send, recorded } = environment({
    settings: { localModelId: 'model-a', localMaxTokens: 512 },
    withOffscreen: true,
    hostReplies: {
      'at/local-load': (message: ATNamespace) => ({ ok: true, status: { ...readyStatus, modelId: message.modelId } })
    }
  });

  const prepared = await send({ type: AT.C.MSG.LOCAL_PREPARE });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.status.state, 'ready');
  assert.equal(prepared.status.modelId, 'model-a');

  assert.equal(recorded.offscreen.length, 1, 'exactly one document is created');
  assert.equal(recorded.offscreen[0]!.url, 'offscreen.html');
  assert.deepEqual(recorded.offscreen[0]!.reasons, ['WORKERS']);
  assert.ok(recorded.offscreen[0]!.justification.length > 0, 'the permission needs a sentence the user reads');

  const load = recorded.hostMessages.find((entry) => entry.type === AT.C.MSG.LOCAL_LOAD);
  assert.ok(load, 'the host is asked to load the model');
  assert.equal(load.to, OFFSCREEN_HOST, 'only the host may answer a host message');
  assert.equal(load.modelId, 'model-a', 'the stored selection is used when the message carries none');
  assert.equal(load.maxTokens, 512);

  await send({ type: AT.C.MSG.LOCAL_PREPARE });
  assert.equal(recorded.offscreen.length, 1, 'a second prepare reuses the open document');
});

test('a browser without the offscreen API hosts the model in its own page', async () => {
  const tab = { id: 7, url: 'https://news.example.com/article', title: 'News' };
  const { AT, send, recorded } = environment({
    tab,
    inlineHost: 'stub',
    settings: { localModelId: 'model-a' }
  });

  const prepared = await send({ type: AT.C.MSG.LOCAL_PREPARE });
  assert.equal(prepared.ok, true, 'the background page can load the model itself');
  assert.equal(prepared.status.state, 'ready');
  assert.equal(recorded.inline.place, 'background', 'the host knows where it is running');
  assert.deepEqual(recorded.inline.handled, [AT.C.MSG.LOCAL_LOAD], 'the call goes straight to the module');
  assert.deepEqual(recorded.hostMessages, [], 'no runtime message is needed when the host is this page');

  const status = await send({ type: AT.C.MSG.LOCAL_GET_STATUS });
  assert.equal(status.ok, true);
  assert.equal(status.supported, true, 'support comes from the host, not from the browser name');

  const released = await send({ type: AT.C.MSG.LOCAL_RELEASE });
  assert.equal(released.ok, true, 'releasing is a call, not a message');
  assert.equal(released.status.state, 'unloaded');
  assert.deepEqual(recorded.offscreen, [], 'no document is ever created here');
});

test('the real host reports a browser without WebGPU before anything is downloaded', async () => {
  const { AT, send, recorded } = environment({
    inlineHost: 'real',
    settings: { localModelId: 'model-a' }
  });

  const status = await send({ type: AT.C.MSG.LOCAL_GET_STATUS });
  assert.equal(status.ok, true);
  assert.equal(status.supported, false, 'no adapter means the model cannot run here');
  assert.equal(status.status.state, 'error');
  assert.equal(status.status.reason, 'no-webgpu');
  assert.deepEqual(recorded.hostMessages, [], 'the background page answers itself');
  assert.deepEqual(recorded.offscreen, [], 'and asks for no document');

  const prepared = await send({ type: AT.C.MSG.LOCAL_PREPARE });
  assert.equal(prepared.ok, false);
  assert.equal(prepared.code, 'config', 'an unsupported browser is a configuration problem');
});

test('the real host reaches the vendored runtime once WebGPU answers', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { gpu: { requestAdapter: async () => ({ name: 'fake adapter' }) } },
    configurable: true
  });
  try {
    const { AT, send, recorded } = environment({
      inlineHost: 'real',
      settings: { localModelId: 'model-a' }
    });
    // The store is not the subject here: answer it so the load reaches the
    // runtime import, which is the step a browser would satisfy.
    AT.modelstore.get = async () => ({
      id: 'model-a',
      name: 'model.task',
      size: 3_900_000_000,
      sourceUrl: '',
      createdAt: 1
    });
    AT.modelstore.read = async () => new Blob();

    const prepared = await send({ type: AT.C.MSG.LOCAL_PREPARE });
    assert.equal(prepared.ok, false);
    assert.equal(prepared.code, 'config');
    // Node truncates the specifier at the first segment, a browser names the
    // whole extension URL; both prove the host asked for the vendored bundle.
    assert.match(prepared.error, /vendor|genai/, 'the host resolved the runtime through runtime.getURL');
    assert.deepEqual(recorded.hostMessages, []);

    const status = await send({ type: AT.C.MSG.LOCAL_GET_STATUS });
    assert.equal(status.supported, true, 'an adapter is enough to call the model runnable');
    assert.equal(status.status.reason, 'runtime-load-failed');
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
});

test('page context from the content script is normalised before the engine sees it', async () => {
  const { AT, recorded, send } = environment({
    inlineHost: 'stub',
    settings: { localModelId: 'model-a', targetLang: 'ko' }
  });

  const reply = await send({
    type: AT.C.MSG.BATCH,
    texts: ['hello'],
    context: { kind: 'product', site: '  Example   Shop ', title: 7, tags: [' shoes '] }
  });
  assert.equal(reply.ok, true);

  const request = recorded.inline.messages.find((entry) => entry.type === AT.C.MSG.LOCAL_TRANSLATE);
  assert.ok(request, 'the batch reached the host');
  assert.equal(
    request.context,
    'This is a product page from Example Shop.',
    'the page sent markup, the extension sent one bounded line'
  );
  assert.deepEqual(recorded.hostMessages, [], 'the inline host is called, not messaged');
});

test('the on-device engine translates through the host in place', async () => {
  const { AT, recorded } = environment({ inlineHost: 'stub' });

  const result = await AT.engines.translate({
    localModelId: 'model-a',
    localMaxTokens: 512,
    texts: ['Good morning', 'Thank you'],
    source: 'en',
    target: 'ko'
  });
  assert.deepEqual(result.translations, ['\u00bbGood morning\u00ab', '\u00bbThank you\u00ab']);
  assert.equal(result.requested, 2, 'both texts were sent once');
  assert.equal(result.detected, null, 'an explicit source is not re-detected');
  assert.deepEqual(recorded.hostMessages, []);
  assert.deepEqual(
    recorded.inline.handled,
    [AT.C.MSG.LOCAL_COUNT, AT.C.MSG.LOCAL_TRANSLATE],
    'the host counts tokens first, then translates'
  );
});

test('the status the popup reads comes from a fresh probe of the host', async () => {
  const tab = { id: 7, url: 'https://news.example.com/article', title: 'News' };
  const { AT, send, recorded } = environment({
    tab,
    withOffscreen: true,
    resident: true,
    settings: { localModelId: 'model-a' },
    hostReplies: { 'at/local-status': () => ({ ok: true, status: readyStatus }) }
  });

  const first = await send({ type: AT.C.MSG.LOCAL_GET_STATUS });
  assert.equal(first.ok, true);
  assert.equal(first.status.state, 'ready', 'the open document is asked');
  assert.equal(first.status.modelName, 'TranslateGemma 4B IT (int8, web)');
  assert.equal(first.supported, true);

  const asked = () => recorded.hostMessages.filter((entry) => entry.type === AT.C.MSG.LOCAL_STATUS).length;
  assert.equal(asked(), 1);
  await send({ type: AT.C.MSG.LOCAL_GET_STATUS });
  assert.equal(asked(), 2, 'every look asks the host, so an idle unload cannot hide behind a cache');
  for (const entry of recorded.hostMessages) assert.equal(entry.to, OFFSCREEN_HOST);

  // The host also pushes when it starts and stops generating; that report is
  // kept, but it never overrides what a fresh probe finds.
  const reported = await send(
    { type: AT.C.MSG.LOCAL_STATUS, status: { ...readyStatus, state: 'busy', generations: 3 } },
    { id: 'host' }
  );
  assert.equal(reported.ok, true);
  assert.equal(reported.status.state, 'busy');

  const before = asked();
  const state = await send({ type: AT.C.MSG.GET_STATE, tabId: 7 }, { id: 'popup' });
  assert.equal(asked(), before + 1, 'opening the popup probes the host');
  assert.equal(state.local.status.state, 'ready', 'the host answer wins over an older pushed state');
  assert.equal(state.local.supported, true);
});

test('the resident model is unloaded when the selection changes', async () => {
  const { AT, events, recorded, send } = environment({
    settings: { localModelId: 'model-a' },
    withOffscreen: true,
    hostReplies: {
      'at/local-load': () => ({ ok: true, status: readyStatus }),
      'at/local-unload': () => ({ ok: true, status: unloadedStatus })
    }
  });
  const unloads = () => recorded.hostMessages.filter((entry) => entry.type === AT.C.MSG.LOCAL_UNLOAD).length;

  await send({ type: AT.C.MSG.LOCAL_RELEASE });
  assert.equal(unloads(), 0, 'nothing is unloaded from a browser with no document');

  const prepared = await send({ type: AT.C.MSG.LOCAL_PREPARE });
  assert.equal(prepared.ok, true);

  await fire(events.storageChanged, { settings: { newValue: recorded.storage.settings } }, 'local');
  assert.equal(unloads(), 0, 'an unrelated edit keeps the model resident');

  recorded.storage.settings.localModelId = 'model-b';
  await fire(events.storageChanged, { settings: { newValue: recorded.storage.settings } }, 'local');
  assert.equal(unloads(), 1, 'the model the user no longer selected is released');
  const unload = recorded.hostMessages.find((entry) => entry.type === AT.C.MSG.LOCAL_UNLOAD);
  assert.equal(unload!.to, OFFSCREEN_HOST);

  const released = await send({ type: AT.C.MSG.LOCAL_RELEASE });
  assert.equal(unloads(), 2, 'the popup can drop the model explicitly');
  assert.equal(released.status.state, 'unloaded');
  assert.equal(released.status.loadedBytes, 0);
});

test('a prepared model stays warm across unrelated settings edits', async () => {
  const { AT, events, recorded, send } = environment({
    settings: { localModelId: 'model-a', autoDetect: true },
    withOffscreen: true,
    hostReplies: {
      'at/local-load': () => ({ ok: true, status: readyStatus }),
      'at/local-unload': () => ({ ok: true, status: unloadedStatus })
    }
  });
  const unloads = () => recorded.hostMessages.filter((entry) => entry.type === AT.C.MSG.LOCAL_UNLOAD).length;
  const edit = async (patch: ATNamespace) => {
    Object.assign(recorded.storage.settings, patch);
    await fire(events.storageChanged, { settings: { newValue: recorded.storage.settings } }, 'local');
  };

  const prepared = await send({ type: AT.C.MSG.LOCAL_PREPARE });
  assert.equal(prepared.ok, true, 'the options page can warm a model before the user translates');
  assert.equal(recorded.offscreen.length, 1);
  assert.equal(recorded.hostMessages.at(-1)!.type, AT.C.MSG.LOCAL_LOAD, 'the chosen model is the one loaded');
  assert.equal(recorded.hostMessages.at(-1)!.modelId, 'model-a');

  // Nothing about the resident model changed, so an unrelated edit must not
  // cost the user another huge load.
  await edit({ autoDetect: false });
  await edit({ targetLang: 'de' });
  assert.equal(unloads(), 0, 'an unrelated edit keeps a prepared model resident');

  // The selection itself changed: keeping it resident would translate with a
  // model nobody chose any more.
  await edit({ localModelId: 'model-b' });
  assert.equal(unloads(), 1, 'a new selection drops the model that was resident');
  const unload = recorded.hostMessages.filter((entry) => entry.type === AT.C.MSG.LOCAL_UNLOAD).at(-1);
  assert.equal(unload!.to, OFFSCREEN_HOST);
  assert.equal(prepared.status.state, 'ready', 'the prepare itself reported the resident model');

  await edit({ localModelId: '' });
  assert.equal(unloads(), 1, 'nothing is unloaded twice');
});


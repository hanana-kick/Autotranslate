import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SRC, load, resetGlobals, fetchStub, json } from './helpers.mjs';

const LIBS = ['lib/constants.js', 'lib/browser.js', 'lib/rules.js', 'lib/settings.js', 'lib/engines.js', 'lib/dom.js'];
const MENU_IDS = ['translate-page', 'restore-page', 'translate-selection', 'never-site', 'always-site'];
const CONTENT_FILES = ['vendor/browser-polyfill.js', 'lib/constants.js', 'lib/browser.js', 'lib/dom.js', 'content.js'];
const LIBRE = 'https://lt.example/translate';

/** Replies to the messages the background sends into a tab. */
function tabReply(message, tab = {}) {
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

/**
 * Boots background.js the way a browser would: the shared libs first as classic
 * scripts, then the entry point, against a recording `chrome` stand-in.
 */
function environment({ settings, tab, tabs, fetchImpl, withImportScripts = true } = {}) {
  resetGlobals();
  const recorded = {
    imported: null,
    menus: [],
    badges: [],
    titles: [],
    tabMessages: [],
    injected: [],
    optionsOpened: 0,
    storage: settings ? { settings } : {}
  };
  const events = { installed: [], startup: [], menuClicks: [], updated: [], removed: [], storageChanged: [], messages: [] };

  // Mirrors the real protocol: a listener returns true when it will answer
  // asynchronously. If none does, the channel closes and the sender resolves
  // with undefined.
  const dispatch = (message, sender = {}) =>
    new Promise((resolve) => {
      let answered = false;
      const respond = (payload) => {
        if (answered) return;
        answered = true;
        resolve(payload);
      };
      const willAnswer = events.messages.map((listener) => listener(message, sender, respond));
      if (!willAnswer.includes(true)) resolve(undefined);
    });

  globalThis.chrome = {
    runtime: {
      lastError: null,
      id: 'autotranslate@hanana-kick',
      getURL: (path) => path,
      openOptionsPage: async () => {
        recorded.optionsOpened += 1;
      },
      sendMessage: (message) => dispatch(message, {}),
      onMessage: { addListener: (fn) => events.messages.push(fn) },
      onInstalled: { addListener: (fn) => events.installed.push(fn) },
      onStartup: { addListener: (fn) => events.startup.push(fn) }
    },
    i18n: {
      getUILanguage: () => 'en',
      getMessage: (key) => `[${key}]`
    },
    storage: {
      local: {
        get: async (key) => (recorded.storage[key] === undefined ? {} : { [key]: recorded.storage[key] }),
        set: async (value) => {
          Object.assign(recorded.storage, value);
          // The browser notifies the extension about its own writes; the
          // background relies on this to drop its settings cache.
          const changes = Object.fromEntries(Object.keys(value).map((key) => [key, { newValue: recorded.storage[key] }]));
          for (const listener of events.storageChanged) listener(changes, 'local');
        }
      },
      onChanged: { addListener: (fn) => events.storageChanged.push(fn) }
    },
    action: {
      setBadgeText: async (details) => recorded.badges.push(details),
      setBadgeBackgroundColor: async (details) => recorded.badges.push(details),
      setTitle: async (details) => recorded.titles.push(details)
    },
    tabs: {
      query: async () => tabs ?? (tab ? [tab] : []),
      get: async (tabId) => (tab && tab.id === tabId ? tab : null),
      update: async () => {},
      onUpdated: { addListener: (fn) => events.updated.push(fn) },
      onRemoved: { addListener: (fn) => events.removed.push(fn) },
      sendMessage: async (tabId, message) => {
        recorded.tabMessages.push({ tabId, message });
        return tabReply(message, tab);
      }
    },
    scripting: {
      executeScript: async (details) => {
        recorded.injected.push(details);
        return [{ result: null }];
      }
    },
    contextMenus: {
      removeAll: async () => {
        recorded.menus = [];
      },
      create: (item) => recorded.menus.push(item),
      onClicked: { addListener: (fn) => events.menuClicks.push(fn) }
    }
  };

  const self = { location: { href: 'chrome-extension://test/background.js' } };
  if (withImportScripts) {
    self.importScripts = (...lists) => {
      recorded.imported = lists.flat();
    };
  }
  globalThis.self = self;
  if (fetchImpl) globalThis.fetch = fetchImpl;

  const AT = load(...LIBS, 'background.js');
  const send = dispatch;
  const chrome = globalThis.chrome;
  const types = () => recorded.tabMessages.map((entry) => entry.message.type);
  return { AT, chrome, recorded, events, send, fire, types };
}

const libreReplies = (translate = (text) => `\u00bb${text}\u00ab`) =>
  fetchStub((url, init) => json(JSON.parse(init.body).q.map((text) => ({ translatedText: translate(text) }))));

/** Fires an event listener list and lets queued work settle. */
const fire = async (list, ...args) => {
  for (const listener of list) await listener(...args);
  await new Promise((resolve) => setTimeout(resolve, 5));
};

test('the worker bootstraps exactly the scripts the manifest lists', () => {
  const { recorded } = environment();
  const manifest = JSON.parse(readFileSync(join(SRC, 'manifest.json'), 'utf8'));
  const expected = manifest.background.scripts.filter((file) => file !== 'background.js');
  assert.deepEqual(recorded.imported, expected, 'the worker imports the shared libs in manifest order');
  assert.equal(manifest.background.scripts.at(-1), 'background.js');
});

test('the event page boots without importScripts (Firefox)', () => {
  const { AT, recorded } = environment({ withImportScripts: false });
  assert.equal(recorded.imported, null);
  assert.equal(typeof AT.engines.translate, 'function');
});

test('install seeds settings and registers the context menu', async () => {
  const { events, recorded } = environment();
  await fire(events.installed, { reason: 'install' });
  assert.equal(recorded.storage.settings.engine, 'google');
  assert.deepEqual(recorded.storage.settings.siteRules, []);
  assert.deepEqual(recorded.menus.map((item) => item.id), MENU_IDS);
  for (const item of recorded.menus) {
    assert.match(item.title, /^\[menu.+\]$/, `menu title must come from i18n: ${item.id}`);
    assert.ok(item.contexts.length > 0);
  }
  await fire(events.startup);
  assert.deepEqual(recorded.menus.map((item) => item.id), MENU_IDS, 'startup rebuilds the menu');
});

test('content batches go to the configured provider once per unique text', async () => {
  const { fetchImpl, calls } = libreReplies();
  const { AT, send } = environment({
    settings: { engine: 'libretranslate', endpoints: { libretranslate: LIBRE }, targetLang: 'ko' },
    fetchImpl
  });
  const reply = await send({ type: AT.C.MSG.BATCH, texts: ['Hello', 'Hello', 'Good morning'] });
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.translations, ['\u00bbHello\u00ab', '\u00bbHello\u00ab', '\u00bbGood morning\u00ab']);
  assert.equal(reply.engine, 'libretranslate');
  assert.equal(calls.length, 1, 'unique texts share one request');
  assert.equal(JSON.parse(calls[0].init.body).q.length, 2);
});

test('provider failures reach the content script as an error, not a half translation', async () => {
  const { fetchImpl } = fetchStub(() => json({ error: 'Rate limit exceeded' }, 429));
  const { AT, send } = environment({
    settings: { engine: 'libretranslate', endpoints: { libretranslate: LIBRE } },
    fetchImpl
  });
  const reply = await send({ type: AT.C.MSG.BATCH, texts: ['Hello'] });
  assert.equal(reply.ok, false);
  assert.equal(reply.code, 'rate-limit');
  assert.equal(reply.translations, undefined);
});

test('navigation injects the content script and asks it to translate', async () => {
  const tab = { id: 7, url: 'https://news.example.com/article', title: 'News', ping: false, translated: 3 };
  const { AT, events, recorded, types } = environment({ tab, fetchImpl: libreReplies().fetchImpl });
  await fire(events.updated, 7, { status: 'complete' }, tab);

  assert.equal(recorded.injected.length, 1);
  assert.deepEqual(recorded.injected[0], { target: { tabId: 7 }, files: CONTENT_FILES });
  const translate = recorded.tabMessages.find((entry) => entry.message.type === AT.C.MSG.CONTENT_TRANSLATE);
  assert.equal(translate.tabId, 7);
  assert.equal(translate.message.decision.action, 'detect', 'no rule means language detection');
  assert.equal(translate.message.settings.apiKey, undefined, 'content never sees the key');
  assert.equal(translate.message.settings.endpoints, undefined);
  assert.equal(translate.message.settings.engine, 'google');
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
  const cases = [
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
  assert.equal(translate.message.decision.action, 'translate');
  assert.equal(translate.message.decision.pattern, 'news.example.com');
});

test('browser and provider pages are left alone', async () => {
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
  const { AT, send, recorded } = environment({ settings: { apiKey: 'secret', engine: 'libretranslate' } });
  const reply = await send({
    type: AT.C.MSG.SET_SETTINGS,
    patch: {
      maxNodes: 99999,
      batchChars: 99999,
      targetLang: 'klingon',
      siteRules: [{ pattern: 'www.Example.com/', action: 'always' }]
    }
  });
  assert.equal(reply.ok, true);
  assert.equal(reply.settings.maxNodes, 5000);
  assert.ok(reply.settings.batchChars <= 5000, 'the batch is clamped to the provider ceiling');
  assert.equal(reply.settings.targetLang, 'en', 'an unknown language falls back');
  assert.equal(reply.settings.apiKey, undefined);
  assert.equal(reply.settings.endpoints, undefined);
  assert.deepEqual(recorded.storage.settings.siteRules, [{ pattern: 'example.com', action: 'always' }]);
  assert.equal(recorded.storage.settings.apiKey, 'secret', 'the stored key survives unrelated patches');
});

test('site rules are canonicalised, replaced and removed by host', async () => {
  const tab = { id: 7, url: 'https://news.example.com/article' };
  const { AT, send, recorded } = environment({ tab });
  const added = await send({ type: AT.C.MSG.SET_SITE_RULE, tabId: 7, action: 'never' });
  assert.equal(added.pattern, 'news.example.com');
  assert.equal(added.settings.siteRules, undefined, 'the content snapshot carries no site rules');
  assert.deepEqual(recorded.storage.settings.siteRules, [{ pattern: 'news.example.com', action: 'never' }]);

  const replaced = await send({ type: AT.C.MSG.SET_SITE_RULE, pattern: 'WWW.News.Example.COM/', action: 'always' });
  assert.deepEqual(recorded.storage.settings.siteRules, [{ pattern: 'news.example.com', action: 'always' }], 'same host is replaced, not duplicated');

  const removed = await send({ type: AT.C.MSG.REMOVE_SITE_RULE, pattern: 'news.example.com' });
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
  assert.equal(recorded.badges.at(-1).color, AT.C.BADGE_COLOR);

  const afterReported = recorded.badges.length;
  await send({ type: AT.C.MSG.STATE_CHANGED, status: 'translated', translated: 4 }, {});
  assert.equal(recorded.badges.length, afterReported, 'a report without a tab changes nothing');

  await send({ type: AT.C.MSG.STATE_CHANGED, status: 'idle', translated: 0 }, { tab: { id: 3 } });
  assert.equal(recorded.badges.at(-1).text, '');
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
  const { AT, send, chrome } = environment({ tab: { id: 7, url: 'https://news.example.com/article' } });
  assert.equal(await send({ type: 'at/does-not-exist' }), undefined, 'the raw channel stays silent');

  const unanswered = await AT.sendMessage({ type: 'at/does-not-exist' });
  assert.equal(unanswered.ok, false);
  assert.equal(unanswered.code, 'no-response');
  assert.match(unanswered.error, /no listener answered at\/does-not-exist/);

  const original = chrome.runtime.sendMessage;
  chrome.runtime.sendMessage = async () => {
    throw new Error('Extension context invalidated.');
  };
  const broken = await AT.sendMessage({ type: AT.C.MSG.GET_STATE });
  assert.equal(broken.ok, false);
  assert.equal(broken.code, 'no-response');
  assert.match(broken.error, /Extension context invalidated/);
  chrome.runtime.sendMessage = original;

  const answered = await AT.sendMessage({ type: AT.C.MSG.GET_STATE, tabId: 7 });
  assert.equal(answered.ok, true);
  assert.equal(answered.tab.host, 'news.example.com');
});

test('the provider test probes with one sentence', async () => {
  const { fetchImpl, calls } = libreReplies((text) => `[${text}]`);
  const { AT, send } = environment({
    settings: { engine: 'libretranslate', endpoints: { libretranslate: LIBRE }, targetLang: 'de' },
    fetchImpl
  });
  const reply = await send({ type: AT.C.MSG.TEST_ENGINE, engine: 'libretranslate' });
  assert.equal(reply.ok, true);
  assert.match(reply.result.output, /^\[.+\]$/);
  assert.equal(reply.result.engine, 'libretranslate');
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].init.body).target, 'de');
});

test('context menu entries act on the clicked tab', async () => {
  const tab = { id: 7, url: 'https://news.example.com/article', translated: 3 };
  const { AT, events, recorded, types } = environment({ tab });

  await fire(events.menuClicks, { menuItemId: 'translate-page' }, tab);
  assert.ok(types().includes(AT.C.MSG.CONTENT_TRANSLATE));

  await fire(events.menuClicks, { menuItemId: 'translate-selection', selectionText: 'some words' }, tab);
  const selection = recorded.tabMessages.at(-1);
  assert.equal(selection.message.type, AT.C.MSG.CONTENT_TRANSLATE_SELECTION);
  assert.equal(selection.message.text, 'some words');

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
  assert.equal(before.message.settings.targetLang, 'de', 'the cached settings are reused');

  recorded.storage.settings.targetLang = 'ja';
  const stale = await send({ type: AT.C.MSG.TRANSLATE_TAB, tabId: 7 });
  assert.equal(stale.ok, true);
  const stillCached = recorded.tabMessages.filter((entry) => entry.message.type === AT.C.MSG.CONTENT_TRANSLATE).at(-1);
  assert.equal(stillCached.message.settings.targetLang, 'de', 'an external write is invisible until onChanged fires');

  await fire(events.storageChanged, { settings: { newValue: recorded.storage.settings } }, 'local');
  await send({ type: AT.C.MSG.TRANSLATE_TAB, tabId: 7 });
  const refreshed = recorded.tabMessages.filter((entry) => entry.message.type === AT.C.MSG.CONTENT_TRANSLATE).at(-1);
  assert.equal(refreshed.message.settings.targetLang, 'ja', 'onChanged invalidates the settings cache');
});

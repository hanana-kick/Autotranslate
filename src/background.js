// Background context: Chrome service worker, Firefox event page.
//
// The manifest declares the same dependency list twice on purpose:
// `background.service_worker` for Chrome, `background.scripts` for Firefox.
// scripts/build.mjs fails the build if the two lists drift apart.
if (typeof self.importScripts === 'function') {
  self.importScripts(
    'vendor/browser-polyfill.js',
    'lib/constants.js',
    'lib/browser.js',
    'lib/rules.js',
    'lib/settings.js',
    'lib/engines.js'
  );
}

(() => {
  const AT = globalThis.AT;
  const C = AT.C;
  const api = AT.api;

  const CONTENT_FILES = Object.freeze([
    'vendor/browser-polyfill.js',
    'lib/constants.js',
    'lib/browser.js',
    'lib/dom.js',
    'content.js'
  ]);

  // Pages where translating is either useless or actively harmful.
  const BLOCKED_HOSTS = new Set([
    'chromewebstore.google.com',
    'chrome.google.com',
    'addons.mozilla.org',
    'translate.google.com'
  ]);

  const MENU = [
    { id: 'translate-page', i18n: 'menuTranslatePage', contexts: ['page'] },
    { id: 'restore-page', i18n: 'menuRestorePage', contexts: ['page'] },
    { id: 'translate-selection', i18n: 'menuTranslateSelection', contexts: ['selection'] },
    { id: 'never-site', i18n: 'menuNeverSite', contexts: ['page'] },
    { id: 'always-site', i18n: 'menuAlwaysSite', contexts: ['page'] }
  ];

  /** @type {Map<number, {status: string, translated: number, error: string|null, targetLang: string|null}>} */
  const tabStates = new Map();
  let settingsCache = null;

  function isInjectable(href) {
    if (typeof href !== 'string' || !/^https?:/i.test(href)) return false;
    try {
      return !BLOCKED_HOSTS.has(new URL(href).hostname.toLowerCase().replace(/^www\./, ''));
    } catch {
      return false;
    }
  }

  async function getSettings({ force = false } = {}) {
    if (force || !settingsCache) {
      settingsCache = await AT.settings.load();
      AT.debug = settingsCache.debug;
    }
    return settingsCache;
  }

  function stateFor(tabId) {
    let state = tabStates.get(tabId);
    if (!state) {
      state = { status: 'idle', translated: 0, error: null, targetLang: null };
      tabStates.set(tabId, state);
    }
    return state;
  }

  async function updateBadge(tabId) {
    if (!AT.action?.setBadgeText) return;
    const settings = await getSettings();
    const state = tabStates.get(tabId);
    const show = state?.status === 'translated' && state.translated > 0 && settings.showBadge;
    const text = show ? C.BADGE_TEXT : '';
    try {
      await AT.action.setBadgeText({ tabId, text });
      if (text) await AT.action.setBadgeBackgroundColor({ tabId, color: C.BADGE_COLOR });
    } catch (error) {
      AT.warn('badge update failed', error);
    }
  }

  async function hasContentScript(tabId) {
    try {
      const pong = await api.tabs.sendMessage(tabId, { type: C.MSG.CONTENT_PING });
      return Boolean(pong?.ok);
    } catch {
      return false;
    }
  }

  async function ensureInjected(tabId) {
    if (await hasContentScript(tabId)) return;
    await AT.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
  }

  // Whether a page should be translated, decided centrally so the content
  // script never has to read settings or site rules.
  function decide(href, settings) {
    if (!settings.enabled) return { action: 'skip', reason: 'disabled' };
    const rule = AT.rules.resolve(settings.siteRules, href);
    if (rule?.action === 'never') return { action: 'skip', reason: 'site-never', pattern: rule.pattern };
    if (rule?.action === 'always') return { action: 'translate', reason: 'site-always', pattern: rule.pattern };
    if (!settings.autoDetect) return { action: 'skip', reason: 'auto-off' };
    return { action: 'detect', reason: 'auto' };
  }

  async function activeTab(tabId) {
    if (tabId != null) return api.tabs.get(tabId);
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    return tabs?.[0] ?? null;
  }

  async function translateTab(tabId, { force = false, decision } = {}) {
    const settings = await getSettings();
    const tab = await activeTab(tabId);
    if (!tab?.id) throw new Error('no active tab');
    if (!isInjectable(tab.url)) throw new Error('this page cannot be translated');
    const plan = decision ?? (force ? { action: 'translate', reason: 'manual' } : decide(tab.url, settings));
    if (plan.action === 'skip') {
      tabStates.delete(tab.id);
      await updateBadge(tab.id);
      return { status: 'skipped', reason: plan.reason };
    }
    await ensureInjected(tab.id);
    const response = await api.tabs.sendMessage(tab.id, {
      type: C.MSG.CONTENT_TRANSLATE,
      decision: plan,
      settings: AT.settings.contentSnapshot(settings)
    });
    if (!response?.ok) throw new Error(response?.error ?? 'the content script did not answer');
    const state = stateFor(tab.id);
    state.status = response.status === 'translated' ? 'translated' : 'idle';
    state.translated = response.translated ?? 0;
    state.error = response.error ?? null;
    state.targetLang = settings.targetLang;
    await updateBadge(tab.id);
    return { status: state.status, translated: state.translated, reason: plan.reason };
  }

  async function restoreTab(tabId) {
    const tab = await activeTab(tabId);
    if (!tab?.id) throw new Error('no active tab');
    if (await hasContentScript(tab.id)) {
      const response = await api.tabs.sendMessage(tab.id, { type: C.MSG.CONTENT_RESTORE });
      if (!response?.ok) throw new Error(response?.error ?? 'the content script did not answer');
    }
    tabStates.delete(tab.id);
    await updateBadge(tab.id);
    return { status: 'idle' };
  }

  async function setSiteRule(message) {
    const settings = await getSettings();
    let pattern = message.pattern;
    if (!pattern && message.tabId != null) {
      const tab = await api.tabs.get(message.tabId);
      pattern = AT.rules.hostPattern(tab?.url);
    } else if (!pattern) {
      const tab = await activeTab();
      pattern = AT.rules.hostPattern(tab?.url);
    }
    const canonical = AT.rules.canonical(pattern);
    if (!canonical) throw new Error(`invalid site pattern: ${pattern ?? '(empty)'}`);
    const siteRules = settings.siteRules.filter((rule) => rule.pattern !== canonical);
    if (message.action) siteRules.push({ pattern: canonical, action: message.action });
    const next = await AT.settings.save({ ...settings, siteRules });
    return { settings: AT.settings.contentSnapshot(next), pattern: canonical };
  }

  async function translateBatch(message) {
    const settings = await getSettings();
    const result = await AT.engines.translate({
      engine: settings.engine,
      endpoints: settings.endpoints,
      apiKey: settings.apiKey,
      texts: message.texts ?? [],
      source: message.sourceLang ?? settings.sourceLang,
      target: message.targetLang ?? settings.targetLang,
      batchChars: settings.batchChars
    });
    return { translations: result.translations, detected: result.detected, engine: result.engine };
  }

  async function testEngine(message) {
    const settings = await getSettings({ force: true });
    const engine = message.engine ?? settings.engine;
    const endpoints = { ...settings.endpoints };
    if (message.endpoint) endpoints[engine] = message.endpoint;
    const result = await AT.engines.test({
      engine,
      endpoints,
      apiKey: message.apiKey ?? settings.apiKey,
      source: settings.sourceLang,
      target: message.target ?? settings.targetLang
    });
    return { result };
  }

  async function getState(message) {
    const settings = await getSettings();
    const tab = await activeTab(message.tabId);
    const rule = tab?.url ? AT.rules.resolve(settings.siteRules, tab.url) : null;
    return {
      tab: tab
        ? { id: tab.id, url: tab.url ?? null, title: tab.title ?? null, host: AT.rules.hostPattern(tab.url) }
        : null,
      canTranslate: isInjectable(tab?.url),
      rule: rule?.action ?? null,
      state: tab?.id != null ? tabStates.get(tab.id) ?? null : null
    };
  }

  async function reportState(message, sender) {
    const tabId = sender?.tab?.id;
    if (tabId == null) return {};
    const state = stateFor(tabId);
    state.status = message.status ?? 'idle';
    state.translated = Number(message.translated) || 0;
    state.error = message.error ?? null;
    await updateBadge(tabId);
    return {};
  }

  function setupMenus() {
    if (!AT.contextMenus) return Promise.resolve();
    return AT.contextMenus.removeAll().then(() => {
      for (const item of MENU) {
        AT.contextMenus.create({
          id: item.id,
          title: AT.i18n.msg(item.i18n),
          contexts: item.contexts
        });
      }
    });
  }

  async function handleMenuClick(info, tab) {
    if (!tab?.id) return;
    switch (info.menuItemId) {
      case 'translate-page':
        await translateTab(tab.id, { force: true });
        break;
      case 'restore-page':
        await restoreTab(tab.id);
        break;
      case 'translate-selection': {
        const settings = await getSettings();
        if (!isInjectable(tab.url)) return;
        await ensureInjected(tab.id);
        await api.tabs.sendMessage(tab.id, {
          type: C.MSG.CONTENT_TRANSLATE_SELECTION,
          text: info.selectionText ?? '',
          settings: AT.settings.contentSnapshot(settings)
        });
        break;
      }
      case 'never-site':
      case 'always-site': {
        const settings = await getSettings();
        const action = info.menuItemId === 'never-site' ? 'never' : 'always';
        const current = AT.rules.resolve(settings.siteRules, tab.url);
        const next = current?.action === action ? null : action;
        await setSiteRule({ tabId: tab.id, action: next });
        if (next === 'never') await restoreTab(tab.id);
        else if (next === 'always') await translateTab(tab.id, { force: true });
        break;
      }
      default:
        break;
    }
  }

  api.runtime.onInstalled.addListener(async (details) => {
    if (details.reason === 'install') await AT.settings.save({});
    settingsCache = null;
    await setupMenus();
  });

  api.runtime.onStartup.addListener(() => {
    setupMenus();
  });

  if (AT.contextMenus?.onClicked) {
    AT.contextMenus.onClicked.addListener((info, tab) => {
      handleMenuClick(info, tab).catch((error) => AT.warn('menu action failed', error));
    });
  }

  api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'complete' || !tab) return;
    if (!isInjectable(tab.url)) {
      tabStates.delete(tabId);
      return;
    }
    getSettings()
      .then((settings) => translateTab(tabId, { decision: decide(tab.url, settings) }))
      .catch((error) => AT.warn('auto translate failed', error));
  });

  api.tabs.onRemoved.addListener((tabId) => {
    tabStates.delete(tabId);
  });

  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[C.STORAGE_KEY]) settingsCache = null;
  });

  AT.onMessage({
    [C.MSG.BATCH]: translateBatch,
    [C.MSG.STATE_CHANGED]: reportState,
    [C.MSG.GET_STATE]: getState,
    [C.MSG.SET_SETTINGS]: async (message) => ({
      settings: AT.settings.contentSnapshot(await AT.settings.save(message.patch ?? {}))
    }),
    [C.MSG.RESET_SETTINGS]: async () => ({
      settings: AT.settings.contentSnapshot(await AT.settings.reset())
    }),
    [C.MSG.SET_SITE_RULE]: setSiteRule,
    [C.MSG.REMOVE_SITE_RULE]: (message) => setSiteRule({ ...message, action: null }),
    [C.MSG.TEST_ENGINE]: testEngine,
    [C.MSG.TRANSLATE_TAB]: (message) => translateTab(message.tabId, { force: true }),
    [C.MSG.RESTORE_TAB]: (message) => restoreTab(message.tabId)
  });
})();

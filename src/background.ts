// Background context: Chrome service worker, Firefox event page.
//
// The manifest declares the same dependency list twice on purpose:
// `background.service_worker` for Chrome, `background.scripts` for Firefox.
// scripts/build.mjs fails the build if the two lists drift apart.

// Only the worker scope has importScripts; the DOM lib types `self` as window,
// so the member is described where the guard below feature-detects it.
interface Window {
  importScripts?: (...files: string[]) => void;
}

namespace AT.background {
  /** What the background remembers about a tab, keyed by tab id. */
  export type TabState = {
    status: string;
    translated: number;
    error: string | null;
    targetLang: string | null;
  };

  /** The verdict the background sends with a translate request. It widens
   *  `AT.rules.Decision`'s always/never with the manual and auto-detect
   *  outcomes; `pattern` echoes the site rule that matched, as stored. */
  export type Plan = {
    action: 'translate' | 'skip' | 'detect';
    reason?: string;
    pattern?: unknown;
  };

  /** at/batch as the content script sends it. */
  export type BatchRequest = {
    texts?: unknown[];
    sourceLang?: string;
    targetLang?: string;
    /** What the content script read off the page, if the module is there. */
    context?: unknown;
    /** Which region of the page the batch came from. */
    role?: unknown;
  };

  /** at/test-engine; every override is optional so stored settings win. */
  export type EngineTestRequest = {
    target?: string;
  };

  /** at/local-prepare: get a model resident in the host. */
  export type LocalRequest = {
    modelId?: string;
    maxTokens?: number;
  };

  /** at/state-changed, reported by the content script about itself. */
  export type StateReport = {
    status?: string;
    translated?: unknown;
    error?: string | null;
  };

  /** at/set-site-rule and at/remove-site-rule; `action: null` deletes. */
  export type SiteRuleRequest = {
    pattern?: string | null;
    tabId?: number;
    action?: AT.SiteRuleAction | null;
  };

  /** at/set-settings. */
  export type SettingsPatch = {
    patch?: Partial<AT.settings.Settings>;
  };

  /** The messages that address a tab, defaulting to the active one. */
  export type TabRequest = {
    tabId?: number;
  };

  /** The content script's reply envelope; nothing in it is trustworthy. */
  export type ContentReply = {
    ok?: boolean;
    status?: string;
    translated?: number;
    error?: string | null;
  };
}

// The one branch that asks about the scope rather than the API, and it has to:
// a service worker gets its shared files from importScripts and nothing is
// loaded yet when the call is made. A Firefox event page is handed the same
// list by the manifest's `background.scripts`, so this branch is also the only
// place the two loading models meet.
if (typeof self.importScripts === 'function') {
  self.importScripts(
    'vendor/browser-polyfill.js',
    'lib/constants.js',
    'lib/browser.js',
    'lib/gemma.js',
    'lib/pagecontext.js',
    'lib/targets.js',
    'lib/rules.js',
    'lib/local.js',
    'lib/modelstore.js',
    'lib/ui.js',
    'lib/settings.js',
    'lib/engines.js',
    'lib/localhost.js'
  );
}

(() => {
  const C = AT.C;
  // The polyfill hands us one object whose members are all optional because no
  // two contexts provide all of them. A background context in either browser
  // has runtime, tabs and storage, so that much optionality is resolved here —
  // and nothing more: `offscreen` is Chrome-only and is reached through
  // AT.supportsOffscreen() / AT.offscreenApi, never assumed.
  type BackgroundApi = Required<Pick<AT.BrowserApi, 'runtime' | 'tabs' | 'storage'>> & AT.BrowserApi;
  const api = AT.api as BackgroundApi;

  const CONTENT_FILES = Object.freeze([
    'vendor/browser-polyfill.js',
    'lib/constants.js',
    'lib/browser.js',
    'lib/pagecontext.js',
    'lib/targets.js',
    'lib/pipeline.js',
    'lib/dom.js',
    'content.js'
  ]);

  // Pages where translating is either useless or actively harmful.
  const BLOCKED_HOSTS: Record<string, true | undefined> = {
    'chromewebstore.google.com': true,
    'chrome.google.com': true,
    'addons.mozilla.org': true,
    'translate.google.com': true
  };

  const MENU: { id: string; i18n: string; contexts: string[] }[] = [
    { id: 'translate-page', i18n: 'menuTranslatePage', contexts: ['page'] },
    { id: 'restore-page', i18n: 'menuRestorePage', contexts: ['page'] },
    { id: 'translate-selection', i18n: 'menuTranslateSelection', contexts: ['selection'] },
    { id: 'never-site', i18n: 'menuNeverSite', contexts: ['page'] },
    { id: 'always-site', i18n: 'menuAlwaysSite', contexts: ['page'] }
  ];

  const tabStates = new Map<number, AT.background.TabState>();
  let settingsCache: AT.settings.Settings | null = null;

  // The on-device model needs a document: a service worker is stopped after
  // seconds of quiet and cannot hold WebAssembly plus WebGPU. Chrome gets one
  // from chrome.offscreen; a Firefox background page already is one and hosts
  // the model itself. Everything the popup shows comes from what the host
  // reports.
  const OFFSCREEN_URL = 'offscreen.html';
  const OFFSCREEN_REASONS = ['WORKERS'];
  const OFFSCREEN_JUSTIFICATION =
    'Runs the translation model the user downloaded, so pages can be translated without a network.';

  let hostStatus: AT.local.LocalStatus | null = null;
  let hostPromise: Promise<void> | null = null;
  let localKey: string | null = null;

  function isInjectable(href: unknown): boolean {
    if (typeof href !== 'string' || !/^https?:/i.test(href)) return false;
    try {
      return BLOCKED_HOSTS[new URL(href).hostname.toLowerCase().replace(/^www\./, '')] !== true;
    } catch {
      return false;
    }
  }

  async function getSettings({ force = false }: { force?: boolean } = {}): Promise<AT.settings.Settings> {
    if (force || !settingsCache) {
      settingsCache = await AT.settings.load();
      AT.debug = settingsCache.debug;
    }
    return settingsCache;
  }

  function stateFor(tabId: number): AT.background.TabState {
    let state = tabStates.get(tabId);
    if (!state) {
      state = { status: 'idle', translated: 0, error: null, targetLang: null };
      tabStates.set(tabId, state);
    }
    return state;
  }

  async function updateBadge(tabId: number): Promise<void> {
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

  async function hasContentScript(tabId: number): Promise<boolean> {
    try {
      const pong = (await api.tabs.sendMessage(tabId, { type: C.MSG.CONTENT_PING })) as AT.background.ContentReply | undefined;
      return Boolean(pong?.ok);
    } catch {
      return false;
    }
  }

  async function ensureInjected(tabId: number): Promise<void> {
    if (await hasContentScript(tabId)) return;
    await AT.scripting!.executeScript({ target: { tabId }, files: CONTENT_FILES });
  }

  // Whether a page should be translated, decided centrally so the content
  // script never has to read settings or site rules. The switch is the whole
  // policy: on means every page is translated into the target language, with a
  // per-site rule able to say otherwise.
  function decide(href: unknown, settings: AT.settings.Settings): AT.background.Plan {
    if (!settings.enabled) return { action: 'skip', reason: 'disabled' };
    const rule = AT.rules.resolve(settings.siteRules, href);
    if (rule?.action === 'never') return { action: 'skip', reason: 'site-never', pattern: rule.pattern };
    if (rule?.action === 'always') return { action: 'translate', reason: 'site-always', pattern: rule.pattern };
    return { action: 'translate', reason: 'auto' };
  }

  async function activeTab(tabId?: number): Promise<AT.Tab | null | undefined> {
    if (tabId != null) return api.tabs.get(tabId);
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    return tabs?.[0] ?? null;
  }

  async function translateTab(
    tabId?: number,
    { force = false, decision }: { force?: boolean; decision?: AT.background.Plan } = {}
  ): Promise<AT.MessageResult> {
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
    const response = (await api.tabs.sendMessage(tab.id, {
      type: C.MSG.CONTENT_TRANSLATE,
      decision: plan,
      settings: AT.settings.contentSnapshot(settings)
    })) as AT.background.ContentReply | undefined;
    if (!response?.ok) throw new Error(response?.error ?? 'the content script did not answer');
    const state = stateFor(tab.id);
    state.status = response.status === 'translated' ? 'translated' : 'idle';
    state.translated = response.translated ?? 0;
    state.error = response.error ?? null;
    state.targetLang = settings.targetLang;
    await updateBadge(tab.id);
    return { status: state.status, translated: state.translated, reason: plan.reason };
  }

  async function restoreTab(tabId?: number): Promise<AT.MessageResult> {
    const tab = await activeTab(tabId);
    if (!tab?.id) throw new Error('no active tab');
    if (await hasContentScript(tab.id)) {
      const response = (await api.tabs.sendMessage(tab.id, { type: C.MSG.CONTENT_RESTORE })) as AT.background.ContentReply | undefined;
      if (!response?.ok) throw new Error(response?.error ?? 'the content script did not answer');
    }
    tabStates.delete(tab.id);
    await updateBadge(tab.id);
    return { status: 'idle' };
  }

  async function setSiteRule(message: AT.background.SiteRuleRequest): Promise<AT.MessageResult> {
    const settings = await getSettings();
    let pattern: string | null = message.pattern ?? null;
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

  async function translateBatch(message: AT.background.BatchRequest): Promise<AT.MessageResult> {
    const settings = await getSettings();
    const request: AT.engines.TranslateRequest = {
      texts: message.texts ?? [],
      source: message.sourceLang ?? settings.sourceLang,
      target: message.targetLang ?? settings.targetLang,
      // The content script sends what the page says about itself; the analyzer
      // is the only thing that decides what it means.
      context: AT.pagecontext.normalize(message.context),
      role: AT.targets.normalizeRole(message.role),
      localModelId: settings.localModelId,
      localMaxTokens: settings.localMaxTokens
    };
    // The host has to exist before the engine layer can ask it anything.
    await ensureHost();
    localKey = request.localModelId || null;
    const result = await AT.engines.translate(request);
    return { translations: result.translations, detected: result.detected };
  }

  async function testModel(message: AT.background.EngineTestRequest): Promise<AT.MessageResult> {
    const settings = await getSettings({ force: true });
    await ensureHost();
    const result = await AT.engines.test({
      source: settings.sourceLang,
      target: message.target ?? settings.targetLang,
      localModelId: settings.localModelId,
      localMaxTokens: settings.localMaxTokens
    });
    return { result };
  }

  async function getState(message: AT.background.TabRequest): Promise<AT.MessageResult> {
    const settings = await getSettings();
    const tab = await activeTab(message.tabId);
    const rule = tab?.url ? AT.rules.resolve(settings.siteRules, tab.url) : null;
    return {
      tab: tab
        ? { id: tab.id, url: tab.url ?? null, title: tab.title ?? null, host: AT.rules.hostPattern(tab.url) }
        : null,
      canTranslate: isInjectable(tab?.url),
      rule: rule?.action ?? null,
      state: tab?.id != null ? tabStates.get(tab.id) ?? null : null,
      local: await localState(true)
    };
  }

  async function reportState(message: AT.background.StateReport, sender: AT.Sender): Promise<AT.MessageResult> {
    const tabId = sender?.tab?.id;
    if (tabId == null) return {};
    const state = stateFor(tabId);
    state.status = message.status ?? 'idle';
    state.translated = Number(message.translated) || 0;
    state.error = message.error ?? null;
    await updateBadge(tabId);
    return {};
  }

  function setupMenus(): Promise<void> {
    const menus = AT.contextMenus;
    if (!menus) return Promise.resolve();
    return menus.removeAll().then(() => {
      for (const item of MENU) {
        menus.create({
          id: item.id,
          title: AT.i18n.msg(item.i18n),
          contexts: item.contexts
        });
      }
    });
  }

  async function handleMenuClick(info: AT.MenuClickInfo, tab?: AT.Tab): Promise<void> {
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
        const action: AT.SiteRuleAction = info.menuItemId === 'never-site' ? 'never' : 'always';
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

  // Chrome's service worker cannot hold WebAssembly plus WebGPU, so the model
  // runs in an offscreen document there. A Firefox background page is a
  // document already, so the same host module (lib/localhost.js) runs in place.
  // Everything below reaches the host through `AT.local.callHost` and never
  // branches on the browser.
  const HOST_PLACEMENT: AT.local.HostPlacement = AT.supportsOffscreen() ? 'offscreen' : 'background';
  AT.local.setHostPlacement(HOST_PLACEMENT);

  async function createOffscreen(): Promise<void> {
    const offscreen = AT.offscreenApi;
    if (!offscreen) throw new Error('this browser has no offscreen API');
    if (await offscreen.hasDocument()) return;
    try {
      await offscreen.createDocument({
        reasons: OFFSCREEN_REASONS,
        url: OFFSCREEN_URL,
        justification: OFFSCREEN_JUSTIFICATION
      });
    } catch (error: unknown) {
      // Two pages can ask at once; whoever loses finds the winner's document.
      if (!(await offscreen.hasDocument())) throw error;
    }
  }

  /** The host module is loaded here already (manifest scripts); in this
   *  placement it only needs somewhere to report what the UI reads. */
  async function installInlineHost(): Promise<void> {
    AT.localhost.install('background', (status) => {
      hostStatus = AT.local.normalizeStatus(status);
    });
  }

  function ensureHost(): Promise<void> {
    hostPromise ??= (HOST_PLACEMENT === 'background' ? installInlineHost() : createOffscreen()).catch(
      (error: unknown) => {
        hostPromise = null;
        throw error;
      }
    );
    return hostPromise;
  }

  async function hostIsUp(): Promise<boolean> {
    if (HOST_PLACEMENT === 'background') return true;
    const offscreen = AT.offscreenApi;
    return offscreen ? (await offscreen.hasDocument()) === true : false;
  }

  function readLocalRequest(
    message: AT.background.LocalRequest,
    settings: AT.settings.Settings
  ): { modelId: string; maxTokens: number } {
    const modelId = typeof message?.modelId === 'string' && message.modelId ? message.modelId : settings.localModelId;
    const maxTokens = Number(message?.maxTokens) > 0 ? Number(message.maxTokens) : settings.localMaxTokens;
    return { modelId, maxTokens };
  }

  async function prepareLocal(message: AT.background.LocalRequest): Promise<AT.MessageResult> {
    const settings = await getSettings({ force: true });
    const { modelId, maxTokens } = readLocalRequest(message, settings);
    if (!modelId) throw new Error('no on-device model is selected');
    await ensureHost();
    const reply = await AT.local.callHost({ type: C.MSG.LOCAL_LOAD, modelId, maxTokens });
    if (!reply?.ok) {
      // The host decides whether its failure is a configuration or a provider
      // problem; dropping that code here would turn every case into a generic one.
      const failure = new Error(String(reply?.error ?? 'the on-device host did not answer')) as Error & {
        code?: string | null;
      };
      failure.code = typeof reply?.code === 'string' ? reply.code : null;
      throw failure;
    }
    hostStatus = AT.local.normalizeStatus(reply.status);
    localKey = modelId;
    return { status: hostStatus };
  }

  async function releaseLocal(): Promise<AT.MessageResult> {
    if (!(await hostIsUp())) return { status: hostStatus ?? AT.local.normalizeStatus(null) };
    const reply = await AT.local.callHost({ type: C.MSG.LOCAL_UNLOAD });
    hostStatus = AT.local.normalizeStatus(reply?.ok ? reply.status : null);
    localKey = null;
    return { status: hostStatus };
  }

  function reportLocal(message: { status?: unknown }): AT.MessageResult {
    hostStatus = AT.local.normalizeStatus(message?.status);
    return { status: hostStatus };
  }

  /** What the UI reads. Asking costs a WebGPU probe, so it only happens when
   *  the on-device engine is in play; otherwise the last report is enough. */
  async function localState(probe: boolean): Promise<{ status: AT.local.LocalStatus; supported: boolean }> {
    if (probe) {
      await ensureHost();
      const reply = await AT.local.callHost({ type: C.MSG.LOCAL_STATUS });
      if (reply?.ok) hostStatus = AT.local.normalizeStatus(reply.status);
    }
    const status = hostStatus ?? AT.local.normalizeStatus(null);
    return { status, supported: status.supported };
  }

  async function getLocalState(): Promise<AT.MessageResult> {
    return await localState(true);
  }

  /**
   * The first run is a setup flow, not a settings page: this opens it. A side
   * panel is the better surface and the page is registered as one, but the
   * browser only lets it open on a user gesture and an install is not one — so
   * this lands in a tab, which is exactly the fallback the page is built for.
   */
  function openWelcome(): void {
    AT.ui.openPage('welcome.html').catch((error: unknown) => AT.warn('opening the welcome page failed', error));
  }

  api.runtime.onInstalled.addListener(async (details) => {
    if (details.reason === 'install') {
      // Nothing translates until the model is installed: the welcome page turns
      // it on as its last step.
      await AT.settings.save({ enabled: false });
      openWelcome();
    }
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

  // A context with storage always has onChanged; the plain-JS version relied on
  // the same guarantee, so the assertion keeps a missing member a TypeError.
  api.storage.onChanged!.addListener((changes, area) => {
    if (area !== 'local' || !changes[C.STORAGE_KEY]) return;
    settingsCache = null;
    // Whatever is resident was loaded for the model the user had chosen;
    // keeping it after they picked another one would translate with a model
    // nobody selected. The engine is not part of this: a model prepared from
    // the options page stays warm while the user translates elsewhere.
    if (localKey === null) return;
    void getSettings()
      .then((settings) => (localKey === settings.localModelId ? undefined : releaseLocal()))
      .catch((error) => AT.warn('releasing the on-device model failed', error));
  });

  // The runtime hands over untrusted JSON: each handler names the payload it
  // reads, and the table narrows the message to that shape once, here.
  AT.onMessage({
    [C.MSG.BATCH]: (message) => translateBatch(message as AT.background.BatchRequest),
    [C.MSG.STATE_CHANGED]: (message, sender) => reportState(message as AT.background.StateReport, sender),
    [C.MSG.GET_STATE]: (message) => getState(message as AT.background.TabRequest),
    [C.MSG.SET_SETTINGS]: async (message) => ({
      settings: AT.settings.contentSnapshot(await AT.settings.save((message as AT.background.SettingsPatch).patch ?? {}))
    }),
    [C.MSG.RESET_SETTINGS]: async () => ({
      settings: AT.settings.contentSnapshot(await AT.settings.reset())
    }),
    [C.MSG.SET_SITE_RULE]: (message) => setSiteRule(message as AT.background.SiteRuleRequest),
    [C.MSG.REMOVE_SITE_RULE]: (message) => setSiteRule({ ...(message as AT.background.SiteRuleRequest), action: null }),
    [C.MSG.TEST_ENGINE]: (message) => testModel(message as AT.background.EngineTestRequest),
    [C.MSG.TRANSLATE_TAB]: (message) => translateTab((message as AT.background.TabRequest).tabId, { force: true }),
    [C.MSG.RESTORE_TAB]: (message) => restoreTab((message as AT.background.TabRequest).tabId),
    [C.MSG.LOCAL_STATUS]: (message) => reportLocal(message as { status?: unknown }),
    [C.MSG.LOCAL_GET_STATUS]: () => getLocalState(),
    [C.MSG.LOCAL_PREPARE]: (message) => prepareLocal(message as AT.background.LocalRequest),
    [C.MSG.LOCAL_RELEASE]: () => releaseLocal()
  });
})();

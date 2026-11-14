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
    translationKey?: string;
    /** What the content script read off the page, if the module is there. */
    context?: unknown;
    /** Which region of the page the batch came from. */
    role?: unknown;
    fragmentConcurrency?: unknown;
  };

  /** at/test-engine; every override is optional so stored settings win. */
  export type EngineTestRequest = {
    target?: string;
    draft?: Partial<AT.settings.Settings>;
  };

  /** at/local-prepare: get a model resident in the host. */
  export type LocalRequest = {
    modelId?: string;
    maxTokens?: number;
    target?: string;
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
    'lib/plamo3.js',
    'lib/pagecontext.js',
    'lib/targets.js',
    'lib/rules.js',
    'vendor/onnxruntime/ort-common.all.js',
    'vendor/onnxruntime/ort-webgpu.all.js',
    'vendor/onnxruntime/transformers.web.js',
    'lib/local.js',
    'lib/modelstore.js',
    'lib/pipelinehost.js',
    'lib/ui.js',
    'lib/settings.js',
    'lib/engines.js',
    'lib/onnxhost.js'
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
    'lib/translationtext.js',
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
  let policyEpoch = 0;
  function requireExtensionUI(sender: AT.Sender): void {
    if ((typeof sender.url === 'string' && !sender.url.startsWith(AT.getURL(''))) ||
        (sender.tab && isInjectable(sender.tab.url))) throw new Error('This operation requires an extension page.');
  }

  // Explicit tab choices and automatic enrollments survive worker suspension,
  // not a browser restart. Manual OFF overrides preferences for this tab's life.
  const TARGETS_KEY = 'translationTargets.v1';
  const AUTOMATIC_KEY = 'translationAutomatic.v1';
  const DISABLED_KEY = 'translationDisabled.v1';
  const LANGUAGES_KEY = 'translationLanguages.v1';
  const targets = new Set<number>();
  const automatic = new Set<number>();
  const disabled = new Set<number>();
  const pageLanguages = new Map<number, { url: string; language: string }>();
  const automaticChecks = new Map<number, number>();
  const targetRevisions = new Map<number, number>();
  const batchControllers = new Map<number, Set<AbortController>>();
  // Keep admission alive while cancelled generations settle; replacing it would
  // let a new tab or settings revision bypass the shared GPU generation limit.
  let batchScheduler: AT.engines.AdjustableFragmentScheduler | undefined;

  function cancelTabBatches(tabId: number): void {
    const controllers = batchControllers.get(tabId);
    batchControllers.delete(tabId);
    for (const controller of controllers ?? []) controller.abort();
  }
  let targetWrites: Promise<void> = Promise.resolve();
  const targetsReady = (async () => {
    const [saved, autoSaved, offSaved, languageSaved] = await Promise.all([
      api.storage.session?.get(TARGETS_KEY),
      api.storage.session?.get(AUTOMATIC_KEY),
      api.storage.session?.get(DISABLED_KEY),
      api.storage.session?.get(LANGUAGES_KEY)
    ]);
    const open = new Set((await api.tabs.query({})).map((tab) => tab?.id));
    const restore = (value: unknown, destination: Set<number>) => {
      if (Array.isArray(value)) for (const id of value) {
        if (Number.isSafeInteger(id) && id >= 0 && open.has(id)) destination.add(id);
      }
    };
    restore(saved?.[TARGETS_KEY], targets);
    restore(autoSaved?.[AUTOMATIC_KEY], automatic);
    restore(offSaved?.[DISABLED_KEY], disabled);
    for (const id of disabled) { targets.delete(id); automatic.delete(id); }
    for (const id of automatic) if (!targets.has(id)) automatic.delete(id);
    for (const id of targets) targetRevisions.set(id, 1);
    const languageRows = languageSaved?.[LANGUAGES_KEY];
    if (Array.isArray(languageRows)) for (const row of languageRows) {
      if (row && open.has(row.id) && typeof row.url === 'string' && typeof row.language === 'string') {
        pageLanguages.set(row.id, { url: row.url, language: row.language });
      }
    }
  })().catch((error) => AT.warn('loading tab consent failed; defaulting OFF', error));

  function persistTargets(): Promise<void> {
    const write = targetWrites.then(async () => {
      await api.storage.session?.set({
        [TARGETS_KEY]: [...targets], [AUTOMATIC_KEY]: [...automatic], [DISABLED_KEY]: [...disabled],
        [LANGUAGES_KEY]: [...pageLanguages].map(([id, value]) => ({ id, ...value }))
      });
    });
    targetWrites = write.catch(() => undefined);
    return write;
  }

  function targetSnapshot(settings: AT.settings.Settings): AT.settings.ContentSnapshot {
    // Legacy settings.enabled is no longer an authorization source.
    return AT.settings.contentSnapshot({ ...settings, enabled: true });
  }

  async function setTabEnabled(tabId: number | undefined, enabled: boolean): Promise<AT.MessageResult> {
    if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean');
    await targetsReady;
    const tab = await activeTab(tabId);
    if (tab?.id == null || !isInjectable(tab.url)) throw new Error('this page cannot be translated');
    const id = tab.id;
    const settings = await getSettings();
    if (enabled && AT.rules.resolve(settings.siteRules, tab.url)?.action === 'never') {
      throw new Error('This site is excluded. Remove its exclusion before enabling this tab.');
    }
    const revision = (targetRevisions.get(id) ?? 0) + 1;
    targetRevisions.set(id, revision);
    cancelTabBatches(id);
    if (enabled) targets.add(id); else targets.delete(id);
    automatic.delete(id);
    if (enabled) disabled.delete(id); else disabled.add(id);
    // Send cancellation immediately; persistence and an old inference must not
    // delay restoring the source. An ON response acknowledges selection, not
    // completion of inference (progress is reported independently).
    const restored = enabled ? Promise.resolve() : restoreTab(id);
    try { await Promise.all([persistTargets(), restored]); }
    catch (error) {
      if (targetRevisions.get(id) === revision) {
        targets.delete(id);
        await restoreTab(id).catch(() => undefined);
      }
      throw error;
    }
    if (targetRevisions.get(id) !== revision) return { enabled: targets.has(id), status: 'cancelled' };
    if (enabled) void translateTab(id).catch((error) => AT.warn('selected tab translation failed', error));
    return { enabled, tabId: id, status: enabled ? 'translating' : 'idle' };
  }

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
      const revision = policyEpoch;
      const loaded = await AT.settings.load();
      // A storage event is newer than a read which started before that event.
      // Never let a delayed old read replace an authoritative enabled/target edit.
      if (revision !== policyEpoch) return getSettings();
      settingsCache = loaded;
      AT.debug = loaded.debug;
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
    // executeScript resolves when the files ran, not when the document kept
    // them: a navigation under it leaves a page with no listener, and the
    // translate message that follows is then lost without an error. Confirm the
    // listener answers, injecting once more, and say so instead of going quiet.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (await hasContentScript(tabId)) return;
      await new Promise<void>((done) => setTimeout(done, 60 * (attempt + 1)));
      if (attempt === 0) await AT.scripting!.executeScript({ target: { tabId }, files: CONTENT_FILES });
    }
    throw new Error('the content script did not answer after injection');
  }

  // Authorized tabs still honor explicit site exclusions.
  function decide(href: unknown, settings: AT.settings.Settings): AT.background.Plan {

    const rule = AT.rules.resolve(settings.siteRules, href);
    if (rule?.action === 'never') return { action: 'skip', reason: 'site-never', pattern: rule.pattern };
    if (rule?.action === 'always') return { action: 'translate', reason: 'site-always', pattern: rule.pattern };
    return { action: 'translate', reason: 'selected-tab' };
  }

  /** Reconcile a live tab with preferences without paying for unread tabs. */
  async function reconcileTab(tabId: number, policy?: AT.settings.Settings, revision?: number): Promise<void> {
    await targetsReady;
    const settings = policy ?? await getSettings();
    const epoch = revision ?? policyEpoch;
    const check = (automaticChecks.get(tabId) ?? 0) + 1;
    automaticChecks.set(tabId, check);
    const selectedRevision = targetRevisions.get(tabId) ?? 0;
    const tab = await api.tabs.get(tabId);
    if (!tab || !isInjectable(tab.url)) return;
    const href = tab.url!;
    const current = () => epoch === policyEpoch && automaticChecks.get(tabId) === check &&
      (targetRevisions.get(tabId) ?? 0) === selectedRevision;
    const manual = targets.has(tabId) && !automatic.has(tabId);
    const rule = AT.rules.resolve(settings.siteRules, href);
    let permitted = manual && rule?.action !== 'never';
    let reason = rule?.action === 'always' ? 'site-always' : 'selected-tab';
    if (!manual && !disabled.has(tabId) && settings.enabled && settings.localModelId && rule?.action !== 'never') {
      permitted = rule?.action === 'always';
      reason = 'site-always';
      if (!permitted && settings.alwaysTranslateLanguages.length && tab.active !== false) {
        const cached = pageLanguages.get(tabId);
        let language = cached?.url === href ? cached.language : '';
        if (!language && api.tabs.detectLanguage) {
          language = await api.tabs.detectLanguage(tabId).catch(() => '');
          // Do not infer a language from undetermined/failed detection.
          if (language && language !== 'und' && current()) pageLanguages.set(tabId, { url: href, language });
        }
        permitted = Boolean(language) && language !== 'und' && !C.sameLanguage(language, settings.targetLang) &&
          settings.alwaysTranslateLanguages.some(code => C.sameLanguage(language, code));
        reason = 'language-always';
      } else if (!permitted && tab.active === false && automatic.has(tabId)) {
        // Revoke if preferences no longer match the cached original language.
        const cached = pageLanguages.get(tabId);
        permitted = cached?.url === href && !C.sameLanguage(cached.language, settings.targetLang) &&
          settings.alwaysTranslateLanguages.some(code => C.sameLanguage(cached.language, code));
      }
    }
    const latest = await api.tabs.get(tabId);
    if (!current() || latest?.url !== href) return;
    if (!permitted || disabled.has(tabId)) {
      if (automatic.delete(tabId)) {
        targets.delete(tabId);
        targetRevisions.set(tabId, selectedRevision + 1);
        await Promise.all([persistTargets(), restoreTab(tabId)]);
      } else if (manual && rule?.action === 'never') await restoreTab(tabId);
      return;
    }
    if (latest.active === false) return;
    if (!targets.has(tabId)) {
      targets.add(tabId);
      automatic.add(tabId);
      targetRevisions.set(tabId, selectedRevision + 1);
      await persistTargets();
      if (epoch !== policyEpoch || automaticChecks.get(tabId) !== check || !targets.has(tabId)) return;
    }
    await translateTab(tabId, { decision: { action: 'translate', reason, ...(rule ? { pattern: rule.pattern } : {}) },
      revision: epoch, policy: settings });
  }

  async function activeTab(tabId?: number): Promise<AT.Tab | null | undefined> {
    if (tabId != null) return api.tabs.get(tabId);
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    return tabs?.[0] ?? null;
  }

  async function translateTab(
    tabId?: number,
    { force = false, decision, revision, policy }: { force?: boolean; decision?: AT.background.Plan;
      revision?: number; policy?: AT.settings.Settings } = {}
  ): Promise<AT.MessageResult> {
    const settings = policy ?? await getSettings();
    const tab = await activeTab(tabId);
    if (tab?.id == null) throw new Error('no active tab');
    if (!isInjectable(tab.url)) throw new Error('this page cannot be translated');
    await targetsReady;
    if (!targets.has(tab.id)) return { status: 'skipped', reason: 'tab-disabled' };
    const targetRevision = targetRevisions.get(tab.id) ?? 0;
    const currentTarget = () => targets.has(tab.id!) && (targetRevisions.get(tab.id!) ?? 0) === targetRevision;
    const plan = decision ?? (force ? { action: 'translate', reason: 'manual' } : decide(tab.url, settings));
    if (plan.action === 'skip') {
      tabStates.delete(tab.id);
      await updateBadge(tab.id);
      return { status: 'skipped', reason: plan.reason };
    }
    await ensureInjected(tab.id);
    if (!currentTarget() || (revision !== undefined && revision !== policyEpoch)) return { status: 'cancelled' };
    // The model answers after the whole pass; without this the popup reads
    // `state: null` and says "not translated yet" while the page is working.
    const pending = stateFor(tab.id);
    pending.status = 'translating';
    pending.targetLang = settings.targetLang;
    pending.error = null;
    await updateBadge(tab.id);
    if (!currentTarget() || (revision !== undefined && revision !== policyEpoch)) return { status: 'cancelled' };
    let response: AT.background.ContentReply | undefined;
    try {
      response = (await api.tabs.sendMessage(tab.id, {
        type: C.MSG.CONTENT_TRANSLATE,
        decision: plan,
        settings: targetSnapshot(settings)
      })) as AT.background.ContentReply | undefined;
    } catch (error: unknown) {
      if (!currentTarget()) return { status: 'cancelled' };
      // Keep the reason the page gave instead of a bare channel error.
      const state = stateFor(tab.id);
      state.status = 'error';
      state.error = String((error as { message?: unknown })?.message ?? error);
      await updateBadge(tab.id);
      throw error;
    }
    if (!currentTarget()) return { status: 'cancelled' };
    if (!response?.ok) {
      const state = stateFor(tab.id);
      state.status = 'error';
      state.error = response?.error ?? 'the content script did not answer';
      await updateBadge(tab.id);
      throw new Error(state.error);
    }
    if (!currentTarget() || response.status === 'cancelled' || (revision !== undefined && revision !== policyEpoch)) {
      return { status: 'cancelled' };
    }
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
    if (tab?.id == null) throw new Error('no active tab');
    cancelTabBatches(tab.id);
    // No injection on OFF. Missing content scripts simply have nothing to restore.
    const response = await api.tabs.sendMessage(tab.id, { type: C.MSG.CONTENT_RESTORE }).catch(() => undefined) as AT.background.ContentReply | undefined;
    if (response && !response.ok) throw new Error(response.error ?? 'the content script did not answer');
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
    const next = await AT.settings.save({ ...settings, siteRules, ...(message.action === 'always' ? { enabled: true } : {}) });
    return { settings: AT.settings.contentSnapshot(next), pattern: canonical };
  }

  async function translateBatch(message: AT.background.BatchRequest, sender: AT.Sender, onProgress?: AT.TranslationProgress, signal?: AbortSignal): Promise<AT.MessageResult> {
    AT.local.throwIfAborted(signal);
    await AT.local.withSignal(targetsReady, signal);
    AT.local.throwIfAborted(signal);
    const tabId = sender.tab?.id;
    if (tabId == null || !targets.has(tabId)) throw new Error('translation is turned off for this tab');
    const revision = targetRevisions.get(tabId) ?? 0;
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const controllers = batchControllers.get(tabId) ?? new Set<AbortController>();
    batchControllers.set(tabId, controllers);
    controllers.add(controller);
    try {
      const settings = await AT.local.withSignal(getSettings(), controller.signal);
      AT.local.throwIfAborted(controller.signal);
      if (message.translationKey && message.translationKey !== AT.settings.contentSnapshot(settings).translationKey) {
        throw AT.local.cancelled();
      }
      if (!batchScheduler) batchScheduler = AT.engines.createFragmentScheduler(settings.translationConcurrency);
      else batchScheduler.setConcurrency(settings.translationConcurrency);
      const scheduler = batchScheduler;
      const requestedWidth = AT.settings.isTranslationConcurrency(message.fragmentConcurrency) ? message.fragmentConcurrency : 1;
      const request: AT.engines.TranslateRequest = {
        signal: controller.signal,
        ...(onProgress ? { onProgress: (index: number, text: string) => {
          if (!controller.signal.aborted && targets.has(tabId) && (targetRevisions.get(tabId) ?? 0) === revision) onProgress(index, text);
        } } : {}),
        texts: message.texts ?? [],
        source: message.sourceLang ?? settings.sourceLang,
        target: message.targetLang ?? settings.targetLang,
        context: AT.pagecontext.normalize(message.context),
        role: AT.targets.normalizeRole(message.role),
        localModelId: settings.localModelId,
        localMaxTokens: settings.localMaxTokens,
        sourceChunkTokens: AT.local.SOURCE_CHUNK_TOKENS,
        fragmentConcurrency: Math.min(settings.translationConcurrency, requestedWidth) as AT.settings.TranslationConcurrency,
        fragmentScheduler: { run: (job, signal) => scheduler.run(job, signal, tabId) }
      };
      // Host loading is shared; cancellation stops this request, not that load.
      await AT.local.withSignal(ensureHost(), controller.signal);
      AT.local.throwIfAborted(controller.signal);
      if (!targets.has(tabId) || (targetRevisions.get(tabId) ?? 0) !== revision) throw AT.local.cancelled();
      localKey = request.localModelId || null;
      const result = await AT.local.withSignal(AT.engines.translate(request), controller.signal);
      AT.local.throwIfAborted(controller.signal);
      return { translations: result.translations, detected: result.detected, timing: result.timing };
    } finally {
      signal?.removeEventListener('abort', abort);
      controllers.delete(controller);
      if (!controllers.size && batchControllers.get(tabId) === controllers) batchControllers.delete(tabId);
    }
  }

  async function testModel(message: AT.background.EngineTestRequest): Promise<AT.MessageResult> {
    const stored = await getSettings({ force: true });
    const settings = message.draft ? AT.settings.normalize({ ...stored, ...message.draft }, stored) : stored;
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
    await targetsReady;
    const settings = await getSettings();
    const tab = await activeTab(message.tabId);
    const rule = tab?.url ? AT.rules.resolve(settings.siteRules, tab.url) : null;
    return {
      tab: tab
        ? { id: tab.id, url: tab.url ?? null, title: tab.title ?? null, host: AT.rules.hostPattern(tab.url) }
        : null,
      canTranslate: isInjectable(tab?.url),
      tabEnabled: tab?.id != null && targets.has(tab.id),
      rule: rule?.action ?? null,
      state: tab?.id != null ? await tabStateOf(tab.id, tab.url) : null,
      local: await localState()
    };
  }

  /**
   * The state of a tab, from memory or from the tab itself. A Chrome service
   * worker is terminated after a quiet spell, so the map is not the truth: the
   * content script knows whether the page in front of the user is translated.
   */
  async function tabStateOf(tabId: number, url?: string): Promise<AT.background.TabState | null> {
    const known = tabStates.get(tabId) ?? null;
    if (known || !isInjectable(url)) return known;
    const reply = (await api.tabs
      .sendMessage(tabId, { type: C.MSG.CONTENT_STATE })
      .catch(() => undefined)) as { ok?: boolean; status?: string; translated?: number; error?: string | null } | undefined;
    if (!reply?.ok) return null;
    const state = stateFor(tabId);
    state.status = typeof reply.status === 'string' ? reply.status : 'idle';
    state.translated = Number(reply.translated) || 0;
    state.error = reply.error ?? null;
    return state;
  }

  async function reportState(message: AT.background.StateReport, sender: AT.Sender): Promise<AT.MessageResult> {
    const tabId = sender?.tab?.id;
    if (tabId == null) return {};
    await targetsReady;
    if (!targets.has(tabId)) return {};
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
        await setTabEnabled(tab.id, true);
        break;
      case 'restore-page':
        await setTabEnabled(tab.id, false);
        break;
      case 'translate-selection': {
        const settings = await getSettings();
        if (!isInjectable(tab.url)) return;
        await targetsReady;
        targets.add(tab.id);
        targetRevisions.set(tab.id, (targetRevisions.get(tab.id) ?? 0) + 1);
        automatic.delete(tab.id);
        disabled.delete(tab.id);
        await persistTargets();
        await ensureInjected(tab.id);
        await api.tabs.sendMessage(tab.id, {
          type: C.MSG.CONTENT_TRANSLATE_SELECTION,
          text: info.selectionText ?? '',
          settings: targetSnapshot(settings)
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
        if (next === 'never') await setTabEnabled(tab.id, false);
        if (next === 'always') await setTabEnabled(tab.id, true);
        break;
      }
      default:
        break;
    }
  }

  // Chrome's service worker cannot hold WebAssembly plus WebGPU, so the model
  // runs in an offscreen document there. A Firefox background page is a
  // document already, so the host module runs in place. Everything below
  // reaches the host through `AT.local.callHost` and never branches on the
  // browser.
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
    AT.onnxhost.install('background', (status) => {
      hostStatus = AT.local.normalizeStatus(status);
    });
  }

  async function ensureHost(): Promise<void> {
    // The document can die after it was created (a GPU crash, the browser
    // reclaiming it). A cached resolved promise would then keep every call
    // pointed at a listener that no longer exists.
    if (hostPromise && HOST_PLACEMENT !== 'background' && !(await hostIsUp())) hostPromise = null;
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
  ): { modelId: string; maxTokens: number; target: string } {
    const modelId = typeof message?.modelId === 'string' && message.modelId ? message.modelId : settings.localModelId;
    const maxTokens = Number(message?.maxTokens) > 0 ? Number(message.maxTokens) : settings.localMaxTokens;
    const target = typeof message?.target === 'string' && message.target ? message.target : settings.targetLang;
    return { modelId, maxTokens, target };
  }

  async function prepareLocal(message: AT.background.LocalRequest): Promise<AT.MessageResult> {
    const settings = await getSettings({ force: true });
    const { modelId, maxTokens, target } = readLocalRequest(message, settings);
    if (!modelId) throw new Error('no on-device model is selected');
    await ensureHost();
    const reply = await AT.local.callHost({ type: C.MSG.LOCAL_LOAD, modelId, maxTokens, target });
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

  /** What the UI reads after probing WebGPU support. */
  async function localState(): Promise<{ status: AT.local.LocalStatus; supported: boolean }> {
    await ensureHost();
    const reply = await AT.local.callHost({ type: C.MSG.LOCAL_QUERY });
    if (reply?.ok) hostStatus = AT.local.normalizeStatus(reply.status);
    const status = hostStatus ?? AT.local.normalizeStatus(null);
    return { status, supported: status.supported };
  }

  async function getLocalState(): Promise<AT.MessageResult> {
    return await localState();
  }

  /**
   * The first run is a setup flow, not a settings page: this opens it. A side
   * panel is the better surface and the page is registered as one, but the
   * browser only lets it open on a user gesture and an install is not one — so
   * this opens a separate setup window without guessing a target web tab.
   */
  function openWelcome(): void {
    AT.ui.openPage('welcome.html', 'window', null).catch((error: unknown) => AT.warn('opening the welcome page failed', error));
  }

  api.runtime.onInstalled.addListener(async (details) => {
    if (details.reason === 'install') {
      // Setup never enrolls a tab. Every tab begins OFF until explicitly selected.
      await AT.settings.save({ enabled: false });
      openWelcome();
    }
    settingsCache = null;
    // Upgrades must retire persisted fields even if no settings UI is opened.
    await getSettings({ force: true });
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

  api.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    try {
      await targetsReady;
      if (changeInfo.status === 'loading' || changeInfo.url) {
        targetRevisions.set(tabId, (targetRevisions.get(tabId) ?? 0) + 1);
        cancelTabBatches(tabId);
        tabStates.delete(tabId);
        pageLanguages.delete(tabId);
        if (automatic.delete(tabId)) {
          targets.delete(tabId);
          await Promise.all([persistTargets(), changeInfo.status === 'loading' ? Promise.resolve() : restoreTab(tabId)]);
        }
      }
      if (changeInfo.status !== 'complete' && !changeInfo.url) return;
      if (!tab || !isInjectable(tab.url)) { await updateBadge(tabId); return; }
      void AT.ui.preparePage('options.html', tabId).catch(() => {});
      await reconcileTab(tabId);
    } catch (error) { AT.warn('auto translate failed', error); }
  });

  api.tabs.onActivated?.addListener(({ tabId }) => {
    void api.tabs.get(tabId).then(async (tab) => {
      if (tab && isInjectable(tab.url)) void AT.ui.preparePage('options.html', tabId).catch(() => {});
      await reconcileTab(tabId);
    }).catch((error) => AT.warn('activated tab translation failed', error));
  });

  api.tabs.onRemoved.addListener((tabId) => {
    cancelTabBatches(tabId);
    tabStates.delete(tabId);
    void targetsReady.then(() => {
      targets.delete(tabId);
      automatic.delete(tabId);
      disabled.delete(tabId);
      pageLanguages.delete(tabId);
      automaticChecks.delete(tabId);
      targetRevisions.delete(tabId);
      return persistTargets();
    }).catch((error) => AT.warn('removing tab consent failed', error));
  });

  /**
   * Pushes a settings change into the tabs that are already translated: the
   * switch and the target language are the two controls a user expects to apply
   * to the page in front of them, wherever they were changed from.
   */
  async function retargetTabs(settings: AT.settings.Settings, previous: AT.settings.Settings, revision: number): Promise<void> {
    const current = AT.settings.contentSnapshot(settings);
    const before = AT.settings.contentSnapshot(previous);
    if (current.translationKey === before.translationKey &&
        settings.translationConcurrency === previous.translationConcurrency &&
        settings.translationRendering === previous.translationRendering &&
        settings.maxNodes === previous.maxNodes && JSON.stringify(settings.siteRules) === JSON.stringify(previous.siteRules) &&
        JSON.stringify(settings.alwaysTranslateLanguages) === JSON.stringify(previous.alwaysTranslateLanguages) &&
        settings.enabled === previous.enabled &&
        // The overlay switch is a page setting too: it draws in the tab.
        settings.debug === previous.debug) return;
    await targetsReady;
    // Existing automatic grants can be revoked; new grants only start active tabs.
    const tabs = await api.tabs.query({});
    if (revision !== policyEpoch) return;
    await Promise.all(tabs.map(async (tab) => {
      if (tab?.id == null || !isInjectable(tab.url)) return;
      const id = tab.id;
      try {
        await reconcileTab(id, settings, revision);
      } catch (error) {
        AT.warn('updating selected tab policy failed', error);
      }
      if (revision === policyEpoch) await updateBadge(id);
    }));
  }

  // A context with storage always has onChanged; the plain-JS version relied on
  // the same guarantee, so the assertion keeps a missing member a TypeError.
  api.storage.onChanged!.addListener((changes, area) => {
    if (area !== 'local' || !changes[C.STORAGE_KEY]) return;
    const revision = ++policyEpoch;
    const edited = changes[C.STORAGE_KEY];
    const previous = edited?.oldValue ? AT.settings.normalize(edited.oldValue) : null;
    // onChanged supplies the committed snapshot. Reading storage again here can
    // race unrelated tab reads and silently cancel a rapid OFF -> ON transition.
    settingsCache = edited?.newValue ? AT.settings.normalize(edited.newValue) : null;
    const committed = settingsCache;
    if (committed && previous &&
        (AT.settings.contentSnapshot(committed).translationKey !== AT.settings.contentSnapshot(previous).translationKey ||
          committed.translationConcurrency !== previous.translationConcurrency || committed.maxNodes !== previous.maxNodes)) {
      for (const tabId of batchControllers.keys()) cancelTabBatches(tabId);
    }
    const next = committed ? Promise.resolve(committed) : getSettings();
    void next.then(async (settings) => {
        if (revision !== policyEpoch) return;
        // Whatever was resident was loaded for the model the user had chosen;
        // keeping it after they picked another one would translate with a model
        // nobody selected. A model prepared from the options page stays warm
        // while the user translates elsewhere.
        // Broadcast cancellation/retargeting immediately; unloading may wait for
        // native inference, and must not hold every page's controls behind it.
        await Promise.all([
          previous ? retargetTabs(settings, previous, revision) : Promise.resolve(),
          localKey !== null && localKey !== settings.localModelId ? releaseLocal() : Promise.resolve()
        ]);
      })
      .catch((error) => AT.warn('applying a settings change failed', error));
  });

  // The runtime hands over untrusted JSON: each handler names the payload it
  // reads, and the table narrows the message to that shape once, here.
  AT.onMessage({
    [C.MSG.BATCH]: (message, sender, onProgress, signal) => translateBatch(message as AT.background.BatchRequest, sender, onProgress, signal),
    [C.MSG.STATE_CHANGED]: (message, sender) => reportState(message as AT.background.StateReport, sender),
    [C.MSG.GET_STATE]: (message) => getState(message as AT.background.TabRequest),
    [C.MSG.SET_TAB_ENABLED]: (message, sender) => {
      // Only extension UI may grant consent; a content script cannot enroll itself.
      if (sender.tab && isInjectable(sender.tab.url)) throw new Error('tab consent requires extension UI');
      return setTabEnabled((message as AT.background.TabRequest).tabId, message.enabled as boolean);
    },
    [C.MSG.SET_SETTINGS]: async (message, sender) => {
      requireExtensionUI(sender);
      return { settings: AT.settings.contentSnapshot(await AT.settings.save((message as AT.background.SettingsPatch).patch ?? {})) };
    },
    [C.MSG.RESET_SETTINGS]: async (_message, sender) => {
      requireExtensionUI(sender);
      return { settings: AT.settings.contentSnapshot(await AT.settings.reset()) };
    },
    [C.MSG.SET_SITE_RULE]: (message, sender) => {
      requireExtensionUI(sender);
      return setSiteRule(message as AT.background.SiteRuleRequest);
    },
    [C.MSG.REMOVE_SITE_RULE]: (message, sender) => {
      requireExtensionUI(sender);
      return setSiteRule({ ...(message as AT.background.SiteRuleRequest), action: null });
    },
    [C.MSG.TEST_ENGINE]: (message, sender) => {
      requireExtensionUI(sender);
      return testModel(message as AT.background.EngineTestRequest);
    },
    [C.MSG.TRANSLATE_TAB]: (message, sender) => {
      if (sender.tab && isInjectable(sender.tab.url)) throw new Error('tab controls require an extension page');
      return setTabEnabled((message as AT.background.TabRequest).tabId, true);
    },
    [C.MSG.RESTORE_TAB]: (message, sender) => {
      if (sender.tab && isInjectable(sender.tab.url)) throw new Error('tab controls require an extension page');
      return setTabEnabled((message as AT.background.TabRequest).tabId, false);
    },
    [C.MSG.LOCAL_STATUS]: (message) => reportLocal(message as { status?: unknown }),
    [C.MSG.LOCAL_GET_STATUS]: () => getLocalState(),
    [C.MSG.LOCAL_PREPARE]: (message) => prepareLocal(message as AT.background.LocalRequest),
    [C.MSG.LOCAL_RELEASE]: () => releaseLocal()
  });
})();

// Single entry point to the extension APIs.
// Load after vendor/browser-polyfill.js and lib/constants.js.
namespace AT {
  /** A tab as far as the background cares; every field comes from the runtime. */
  export type Tab = {
    id?: number;
    url?: string;
    title?: string | null;
  };

  /** A browser-owned channel gives long model preparation an explicit lifetime. */
  export type RuntimePort = {
    name: string;
    postMessage: (message: unknown) => void;
    disconnect: () => void;
    error?: { message?: string };
    sender?: Sender;
    onMessage: { addListener: (listener: (message: unknown) => void) => void };
    onDisconnect: { addListener: (listener: () => void) => void };
  };

  export type RuntimeApi = {
    getURL: (path: string) => string;
    getManifest: () => { version?: string };
    openOptionsPage: () => Promise<void>;
    sendMessage: (message: unknown) => Promise<unknown>;
    connect?: (options: { name: string }) => RuntimePort;
    onConnect?: { addListener: (listener: (port: RuntimePort) => void) => void };
    onMessage: { addListener: (listener: MessageListener) => void };
    onInstalled: { addListener: (listener: (details: { reason?: string }) => void) => void };
    onStartup: { addListener: (listener: () => void) => void };
  };

  export type TabsApi = {
    create: (properties: { url: string; active?: boolean }) => Promise<Tab | undefined>;
    get: (tabId: number) => Promise<Tab | undefined>;
    query: (queryInfo: { active?: boolean; currentWindow?: boolean }) => Promise<(Tab | undefined)[]>;
    sendMessage: (tabId: number, message: unknown) => Promise<unknown>;
    onUpdated: {
      addListener: (listener: (tabId: number, changeInfo: { status?: string }, tab: Tab) => void) => void;
    };
    onRemoved: { addListener: (listener: (tabId: number) => void) => void };
  };

  export type StorageApi = {
    local: {
      get: (key: string) => Promise<{ [key: string]: unknown }>;
      set: (items: { [key: string]: unknown }) => Promise<void>;
    };
    onChanged?: {
      addListener: (
        listener: (changes: { [area: string]: { oldValue?: unknown; newValue?: unknown } }, areaName: string) => void
      ) => void;
    };
  };

  export type ActionApi = {
    setBadgeText: (details: { tabId?: number; text: string }) => Promise<void>;
    setBadgeBackgroundColor: (details: { tabId?: number; color: string }) => Promise<void>;
  };

  export type ScriptingApi = {
    executeScript: (details: { target: { tabId?: number }; files: readonly string[] }) => Promise<unknown>;
  };

  /** Chrome only: the document that hosts the on-device model. */
  export type OffscreenApi = {
    createDocument: (details: { reasons: string[]; url: string; justification?: string }) => Promise<void>;
    hasDocument: () => Promise<boolean>;
    closeDocument: () => Promise<void>;
  };

  /** Chrome only: a document docked to the side of the window. */
  export type SidePanelApi = {
    open: (options: { windowId?: number; tabId?: number }) => Promise<void>;
    setOptions: (options: { path?: string; enabled?: boolean; tabId?: number }) => Promise<void>;
  };

  export type ContextMenusApi = {
    removeAll: () => Promise<void>;
    create: (properties: { id?: string; title: string; contexts?: string[] }) => void;
    onClicked?: { addListener: (listener: (info: MenuClickInfo, tab?: Tab) => void) => void };
  };

  export type MenuClickInfo = {
    menuItemId?: string | number;
    selectionText?: string;
  };

  export type I18nApi = {
    getMessage?: (messageName: string | undefined, substitutions?: string | string[]) => string | undefined;
    getUILanguage?: () => string;
    /** CLD, as a promise: Chrome 47+, Firefox 47+. Absent in Safari. */
    detectLanguage?: (text: string) => Promise<unknown>;
  };

  /** The host object the polyfill installs as `browser`, Chrome as `chrome`. */
  export type BrowserApi = {
    runtime: RuntimeApi;
    tabs?: TabsApi;
    storage?: StorageApi;
    action?: ActionApi;
    scripting?: ScriptingApi;
    offscreen?: OffscreenApi;
    sidePanel?: SidePanelApi;
    contextMenus?: ContextMenusApi;
    i18n?: I18nApi;
  };

  /** Messages cross a trust boundary; only `type` is guaranteed to be there. */
  export type Message = {
    type: string;
    [key: string]: unknown;
  };

  export type Sender = {
    tab?: Tab;
    [key: string]: unknown;
  };

  /** What a handler resolves to; spread into the `{ ok: true, ... }` reply. */
  export type MessageResult = { [key: string]: unknown };

  export type MessageHandler = (
    message: Message,
    sender: Sender
  ) => MessageResult | null | undefined | Promise<MessageResult | null | undefined>;

  export type MessageHandlers = { [type: string]: MessageHandler | undefined };

  /** Every answered message carries `ok`; callers branch on it before reading more. */
  export type Response = {
    ok: boolean;
    [key: string]: unknown;
  };

  type MessageListener = (
    message: Message,
    sender: Sender,
    sendResponse: (response: Response) => void
  ) => boolean | Promise<Response>;

  /** Rejections carry no shape: an Error, a DOMException, or anything a handler threw. */
  type Rejection = { message?: unknown; code?: unknown };

  export type I18n = {
    msg(key: string | undefined, subs?: string | string[]): string;
    apply(root?: Document | Element): void;
  };

  /** Element plus the attribute bag; `dataset` only exists on HTMLElement. */
  type Localized = Element & { dataset: { [name: string]: string | undefined } };

  // `types: []` leaves us without ambient extension globals, so the two host
  // names are declared here instead of trusting an ambient `chrome`.
  type ApiGlobals = { browser?: BrowserApi; chrome?: BrowserApi };
  const globals = globalThis as typeof globalThis & ApiGlobals;

  // The single place the host globals are read. `browser` is the standard name
  // the vendored polyfill installs and the one every caller in this project
  // uses; `chrome` is only the fallback for a page where the polyfill has not
  // run (plain pages in the smoke tests, a Chrome worker before the polyfill).
  // Nothing outside this file may reach for either global.
  const installed = globals.browser ?? globals.chrome;
  if (!installed) {
    throw new Error('Autotranslate: no browser/chrome API available');
  }
  // The listener bodies below run once this file has loaded, where the guard's
  // narrowing no longer holds, so the checked API is captured here.
  const extensionApi: BrowserApi = installed;

  // Writable and deletable: the tests swap the whole API out to fake a context,
  // and a page without an extension context leaves them unset.
  export let api: BrowserApi | undefined;
  export let runtime: RuntimeApi | null | undefined;
  export let tabs: TabsApi | null | undefined;
  export let storage: StorageApi | null | undefined;
  export let action: ActionApi | null | undefined;
  export let scripting: ScriptingApi | null | undefined;
  export let contextMenus: ContextMenusApi | null | undefined;
  /** The `offscreen` surface; named apart from `AT.offscreen`, which is the
   *  Chrome placement of the on-device host, not the API. */
  export let offscreenApi: OffscreenApi | null | undefined;
  /** The `sidePanel` surface; null where the browser has no side panel. */
  export let sidePanelApi: SidePanelApi | null | undefined;

  api = extensionApi;
  runtime = extensionApi.runtime ?? null;
  tabs = extensionApi.tabs ?? null;
  storage = extensionApi.storage ?? null;
  action = extensionApi.action ?? null;
  scripting = extensionApi.scripting ?? null;
  contextMenus = extensionApi.contextMenus ?? null;
  offscreenApi = extensionApi.offscreen ?? null;
  sidePanelApi = extensionApi.sidePanel ?? null;

  /**
   * The one place that answers whether this browser can host a document of its
   * own (`chrome.offscreen`). Firefox has no such API and runs the on-device
   * host in its background page instead, so callers ask this question rather
   * than inspecting the API object or the user agent.
   */
  export function supportsOffscreen(): boolean {
    const surface = extensionApi.offscreen;
    return typeof surface?.createDocument === 'function' && typeof surface?.hasDocument === 'function';
  }

  /**
   * Whether this browser can dock a page to the side of the window. `open` is
   * gated on a user gesture by the browser, so callers must be ready for it to
   * fail and fall back to a tab; this only says the API is there.
   */
  export function supportsSidePanel(): boolean {
    const surface = extensionApi.sidePanel;
    return typeof surface?.open === 'function' && typeof surface?.setOptions === 'function';
  }

  export function getURL(path: string): string {
    return AT.runtime!.getURL(path);
  }

  /** What the detector answered: a BCP-47 code and whether CLD trusted it. */
  export type DetectedLanguage = { code: string; reliable: boolean };

  /**
   * The language of a piece of page text, from the browser's own detector
   * (`i18n.detectLanguage`, CLD). Null when the browser has no detector, the
   * text is empty, or the answer is "undetermined" — the caller then has no
   * source language and says so instead of guessing.
   */
  export async function detectLanguage(text: string): Promise<DetectedLanguage | null> {
    const surface = extensionApi.i18n;
    const detect = surface?.detectLanguage;
    if (typeof detect !== 'function' || !text || !text.trim()) return null;
    try {
      const result = (await detect.call(surface, text)) as
        | { isReliable?: unknown; languages?: unknown }
        | undefined;
      const list = Array.isArray(result?.languages) ? result.languages : [];
      // The API sorts by percentage, so the first entry is the answer; anything
      // that is not a real language code is no answer at all.
      const best = list[0] as { language?: unknown } | undefined;
      const code = typeof best?.language === 'string' ? best.language : '';
      if (!code || code === 'und' || code === 'un') return null;
      return { code, reliable: result?.isReliable === true };
    } catch (error: unknown) {
      AT.warn('language detection failed', error);
      return null;
    }
  }

  export const i18n: I18n = {
    msg(key, subs) {
      const text = extensionApi.i18n?.getMessage?.(key, subs);
      return text || `[${key}]`;
    },
    // Fills textContent for [data-i18n], placeholder for [data-i18n-placeholder]
    // and title for [data-i18n-title].
    apply(root = document) {
      for (const node of root.querySelectorAll('[data-i18n]')) {
        const el = node as Localized;
        el.textContent = AT.i18n.msg(el.dataset.i18n);
      }
      for (const node of root.querySelectorAll('[data-i18n-placeholder]')) {
        const el = node as Localized;
        el.setAttribute('placeholder', AT.i18n.msg(el.dataset.i18nPlaceholder));
      }
      for (const node of root.querySelectorAll('[data-i18n-title]')) {
        const el = node as Localized;
        el.setAttribute('title', AT.i18n.msg(el.dataset.i18nTitle));
      }
    }
  };

  // Wraps a message listener table so handlers can be plain async functions.
  // Return the actual reply Promise through the standard browser API. Firefox
  // owns this pending asynchronous response for the event-page lifetime; the
  // Chrome polyfill converts it to its callback contract. A raw chrome fallback
  // retains sendResponse for hosts that do not support promise listeners.
  const MODEL_PORT = 'autotranslate-model-prepare-v1';

  export function onMessage(handlers: MessageHandlers): void {
    // Only the preparation owner claims this channel; other pages leave it alone.
    if (Object.hasOwn(handlers, C.MSG.LOCAL_PREPARE)) {
      extensionApi.runtime.onConnect?.addListener((port) => {
        if (port.name !== MODEL_PORT) return;
        let active = true, received = false;
        port.onDisconnect.addListener(() => { active = false; });
        port.onMessage.addListener((raw) => {
          if (received) return;
          received = true;
          const message = raw && typeof raw === 'object' ? raw as Message : undefined;
          const handler = message?.type === C.MSG.LOCAL_PREPARE ? handlers[C.MSG.LOCAL_PREPARE] : undefined;
          const reply: Promise<Response> = Promise.resolve().then(async () => {
            if (!handler) throw new Error('unknown model preparation command');
            return { ok: true, ...((await handler(message!, port.sender ?? {})) ?? {}) };
          }).catch((error: unknown) => {
            const failure = error as Rejection;
            return { ok: false, error: String(failure?.message ?? error), code: failure?.code ?? null };
          });
          void reply.then((response) => {
            if (!active) return;
            try { port.postMessage(response); } catch { /* The caller closed its page. */ }
          });
        });
      });
    }
    extensionApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
      // Own properties only: `handlers['constructor']` would otherwise resolve
      // to Object and answer a type nobody handles.
      const handler = Object.hasOwn(handlers, message?.type ?? '') ? handlers[message?.type] : undefined;
      if (!handler) return false;
      const reply: Promise<Response> = Promise.resolve()
        .then(() => handler(message, sender))
        .then((result) => ({ ok: true, ...(result ?? {}) }))
        .catch((error: unknown) => {
          AT.warn(message.type, error);
          const rejection = error as Rejection;
          return {
            ok: false,
            error: rejection?.message ?? String(error),
            code: rejection?.code ?? null
          };
        });
      if (globals.browser === extensionApi) return reply;
      void reply.then(sendResponse);
      return true;
    });
  }

  // A listener that does not recognise the type answers nothing, and the
  // runtime then resolves with undefined (or rejects when the receiving
  // context is gone). Callers all branch on `response.ok`, so collapse both
  // shapes into one failure object instead of leaking rejections.
  function prepareOverPort(message: Message): Promise<Response> {
    return new Promise((resolve) => {
      let settled = false;
      let port: RuntimePort | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (response: Response): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(response);
        try { port?.disconnect(); } catch { /* Already disconnected. */ }
      };
      // Includes two bounded slow software initializations, never an infinite wait.
      timer = setTimeout(() => finish({ ok: false, error: 'model preparation channel timed out', code: 'provider' }), 45 * 60 * 1000);
      try {
        port = extensionApi.runtime.connect!({ name: MODEL_PORT });
        port.onMessage.addListener((response) => {
          if (!response || typeof response !== 'object' || typeof (response as Partial<Response>).ok !== 'boolean') {
            finish({ ok: false, error: 'invalid model preparation response', code: 'no-response' });
          } else finish(response as Response);
        });
        port.onDisconnect.addListener(() => finish({ ok: false,
          error: port?.error?.message ?? 'model preparation channel closed', code: 'no-response' }));
        port.postMessage(message);
      } catch (error: unknown) {
        finish({ ok: false, error: String((error as Rejection)?.message ?? error), code: 'no-response' });
      }
    });
  }

  export async function sendMessage(message: Message | null | undefined): Promise<Response> {
    const type = message?.type ?? 'message';
    // The document-host preparation uses a native operation-scoped channel.
    // Chrome offscreen and every other command retain ordinary messaging.
    if (message && type === C.MSG.LOCAL_PREPARE && !supportsOffscreen() && extensionApi.runtime.connect) {
      return prepareOverPort(message);
    }
    try {
      const response = await extensionApi.runtime.sendMessage(message);
      // The listener owns the payload; whatever object it answered with is
      // handed over untouched and the caller reads `ok` off it.
      if (response && typeof response === 'object') return response as Response;
      return { ok: false, error: `no listener answered ${type}`, code: 'no-response' };
    } catch (error: unknown) {
      const rejection = error as Rejection;
      return {
        ok: false,
        error: rejection?.message ?? String(error),
        code: rejection?.code ?? 'no-response'
      };
    }
  }
}

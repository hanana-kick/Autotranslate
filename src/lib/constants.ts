// Shared constants for every extension context.
// Loaded as a classic script (importScripts in the Chrome service worker,
// <script> tags / background.scripts elsewhere); must be the first AT file
// after the polyfill because every other module reads from AT.C.
namespace AT {
  export type Lang = { code: string; native: string };

  export type EngineMeta = {
    id: string;
    label: string;
    endpoint: string;
    supportsKey: boolean;
    maxChars: number;
    docs: string;
    /** 'local' engines run in this browser, so they have no endpoint. */
    kind?: 'remote' | 'local';
  };

  export type SiteRuleAction = 'always' | 'never';

  export type MessageTypes = {
    BATCH: string;
    STATE_CHANGED: string;
    GET_STATE: string;
    SET_SETTINGS: string;
    RESET_SETTINGS: string;
    SET_SITE_RULE: string;
    REMOVE_SITE_RULE: string;
    TEST_ENGINE: string;
    TRANSLATE_TAB: string;
    RESTORE_TAB: string;
    CONTENT_TRANSLATE: string;
    CONTENT_TRANSLATE_SELECTION: string;
    CONTENT_RESTORE: string;
    CONTENT_PING: string;
    // background -> offscreen document (the on-device host)
    LOCAL_TRANSLATE: string;
    LOCAL_LOAD: string;
    LOCAL_UNLOAD: string;
    LOCAL_COUNT: string;
    // host -> background
    LOCAL_STATUS: string;
    // popup / options -> background; kept apart from the host types so a
    // broadcast never lets the wrong context answer first
    LOCAL_PREPARE: string;
    LOCAL_RELEASE: string;
    LOCAL_GET_STATUS: string;
  };

  export type Constants = {
    STORAGE_KEY: string;
    BADGE_TEXT: string;
    BADGE_COLOR: string;
    DEFAULT_BATCH_CHARS: number;
    DEFAULT_MAX_NODES: number;
    OBSERVER_BATCH_NODES: number;
    SENTENCE_MAX_CHARS: number;
    LOCAL_BATCH_CHARS: number;
    OBSERVER_DEBOUNCE_MS: number;
    PROVIDER_TIMEOUT_MS: number;
    PROVIDER_RETRIES: number;
    PROVIDER_CONCURRENCY: number;
    IGNORE_SELECTOR: string;
    MSG: MessageTypes;
    LANGS: Lang[];
    LANG_CODES: Set<string>;
    isSupportedLang: (code: string | null | undefined) => boolean;
    sameLanguage: (a: string | null | undefined, b: string | null | undefined) => boolean;
    ENGINES: EngineMeta[];
    getEngineMeta: (id: string) => EngineMeta | null;
    ENGINE_LANG_ALIAS: Record<string, Record<string, string>>;
    RTL_LANGS: Record<string, true | undefined>;
    SITE_RULE_ACTIONS: readonly SiteRuleAction[];
  };

  export const C: Constants = {
    STORAGE_KEY: 'settings',
    BADGE_TEXT: '文A',
    BADGE_COLOR: '#1a73e8',
    // Requests longer than this are split into several provider calls.
    DEFAULT_BATCH_CHARS: 1200,
    // Hard ceiling on DOM text nodes touched per run; keeps huge feeds cheap.
    DEFAULT_MAX_NODES: 600,
    // Ceiling for nodes translated by the MutationObserver in one tick.
    OBSERVER_BATCH_NODES: 40,
    // Longer texts are split into sentences before they are sent: about 50
    // Latin tokens, well inside a sentence's worth of meaning. Only a text
    // longer than this pays for the extra round trip.
    SENTENCE_MAX_CHARS: 900,
    // The on-device provider is billed in tokens, so one message may carry far
    // more characters than a cloud provider would accept; the engine then packs
    // them by counting tokens.
    LOCAL_BATCH_CHARS: 4000,
    OBSERVER_DEBOUNCE_MS: 300,
    PROVIDER_TIMEOUT_MS: 15000,
    PROVIDER_RETRIES: 1,
    PROVIDER_CONCURRENCY: 4,
    // Text nodes inside any of these are left untouched.
    IGNORE_SELECTOR: [
      'script',
      'style',
      'noscript',
      'textarea',
      'code',
      'pre',
      'kbd',
      'samp',
      'var',
      'select',
      'option',
      'abbr',
      '[translate="no"]',
      '[data-no-translate]',
      '.notranslate'
    ].join(','),
    MSG: {
      // content script -> background
      BATCH: 'at/batch',
      STATE_CHANGED: 'at/state-changed',
      // popup / options -> background
      GET_STATE: 'at/get-state',
      SET_SETTINGS: 'at/set-settings',
      RESET_SETTINGS: 'at/reset-settings',
      SET_SITE_RULE: 'at/set-site-rule',
      REMOVE_SITE_RULE: 'at/remove-site-rule',
      TEST_ENGINE: 'at/test-engine',
      TRANSLATE_TAB: 'at/translate-tab',
      RESTORE_TAB: 'at/restore-tab',
      // background -> content script
      CONTENT_TRANSLATE: 'at/content-translate',
      CONTENT_TRANSLATE_SELECTION: 'at/content-translate-selection',
      CONTENT_RESTORE: 'at/content-restore',
      CONTENT_PING: 'at/content-ping',
      // background -> offscreen document
      LOCAL_TRANSLATE: 'at/local-translate',
      LOCAL_LOAD: 'at/local-load',
      LOCAL_UNLOAD: 'at/local-unload',
      LOCAL_COUNT: 'at/local-count',
      // host -> background
      LOCAL_STATUS: 'at/local-status',
      // popup / options -> background
      LOCAL_PREPARE: 'at/local-prepare',
      LOCAL_RELEASE: 'at/local-release',
      LOCAL_GET_STATUS: 'at/local-get-status'
    },
    LANGS: [
      { code: 'en', native: 'English' },
      { code: 'ko', native: '한국어' },
      { code: 'ja', native: '日本語' },
      { code: 'zh-CN', native: '简体中文' },
      { code: 'zh-TW', native: '繁體中文' },
      { code: 'ar', native: 'العربية' },
      { code: 'bn', native: 'বাংলা' },
      { code: 'de', native: 'Deutsch' },
      { code: 'es', native: 'Español' },
      { code: 'fa', native: 'فارسی' },
      { code: 'fr', native: 'Français' },
      { code: 'he', native: 'עברית' },
      { code: 'hi', native: 'हिन्दी' },
      { code: 'id', native: 'Bahasa Indonesia' },
      { code: 'it', native: 'Italiano' },
      { code: 'nl', native: 'Nederlands' },
      { code: 'pl', native: 'Polski' },
      { code: 'pt', native: 'Português' },
      { code: 'ru', native: 'Русский' },
      { code: 'th', native: 'ไทย' },
      { code: 'tr', native: 'Türkçe' },
      { code: 'uk', native: 'Українська' },
      { code: 'vi', native: 'Tiếng Việt' }
    ],
    LANG_CODES: new Set<string>(),
    isSupportedLang,
    sameLanguage,
    ENGINES: [
      {
        id: 'google',
        label: 'Google Translate (unofficial endpoint)',
        endpoint: 'https://translate.googleapis.com/translate_a/single',
        supportsKey: false,
        maxChars: 1200,
        docs: 'Keyless but unofficial: subject to rate limits and terms changes.'
      },
      {
        id: 'libretranslate',
        label: 'LibreTranslate',
        endpoint: 'http://127.0.0.1:5000/translate',
        supportsKey: true,
        maxChars: 4000,
        docs: 'Stock LibreTranslate listens on 127.0.0.1:5000; use your own instance or key if required.'
      },
      {
        id: 'local',
        label: 'On-device TranslateGemma (offline)',
        endpoint: '',
        supportsKey: false,
        maxChars: 1500,
        kind: 'local',
        docs: 'Nothing is fetched while translating: download the model once on the options page. Needs Chrome with WebGPU.'
      }
    ],
    getEngineMeta,
    // Provider-specific spellings of the codes in LANGS.
    ENGINE_LANG_ALIAS: {
      google: { 'zh-CN': 'zh-CN', 'zh-TW': 'zh-TW', pt: 'pt-BR' },
      libretranslate: { 'zh-CN': 'zh', 'zh-TW': 'zh', pt: 'pt' }
    },
    // Used only to pick a text direction for the selection card.
    RTL_LANGS: { ar: true, fa: true, he: true, ur: true },
    SITE_RULE_ACTIONS: ['always', 'never']
  };

  C.LANG_CODES = new Set(C.LANGS.map((lang) => lang.code));

  function isSupportedLang(code: string | null | undefined): boolean {
    return typeof code === 'string' && C.LANG_CODES.has(code);
  }

  // 'en-US' matches 'en'; regional variants stay distinct ('zh-CN' vs 'zh-TW').
  function sameLanguage(a: string | null | undefined, b: string | null | undefined): boolean {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const left = a.trim().toLowerCase();
    const right = b.trim().toLowerCase();
    if (!left || !right) return false;
    if (left === right) return true;
    return !right.includes('-') && left.split('-')[0] === right;
  }

  function getEngineMeta(id: string): EngineMeta | null {
    return C.ENGINES.find((engine) => engine.id === id) ?? null;
  }

  // Cheap logging shared by every context; engines and background call it
  // without loading lib/browser.
  export let debug = false;

  export function log(...args: unknown[]): void {
    if (debug) console.debug('[autotranslate]', ...args);
  }

  export function warn(...args: unknown[]): void {
    console.warn('[autotranslate]', ...args);
  }
}

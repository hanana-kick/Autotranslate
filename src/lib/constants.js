// Shared constants for every extension context.
// Loaded as a classic script (importScripts in the Chrome service worker,
// <script> tags / background.scripts elsewhere); must be the first AT file
// after the polyfill because every other module reads from AT.C.
(() => {
  const AT = (globalThis.AT ??= {});

  const C = (AT.C = {
    STORAGE_KEY: 'settings',
    BADGE_TEXT: '文A',
    BADGE_COLOR: '#1a73e8',
    // Requests longer than this are split into several provider calls.
    DEFAULT_BATCH_CHARS: 1200,
    // Hard ceiling on DOM text nodes touched per run; keeps huge feeds cheap.
    DEFAULT_MAX_NODES: 600,
    // Ceiling for nodes translated by the MutationObserver in one tick.
    OBSERVER_BATCH_NODES: 40,
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
    ].join(',')
  });

  // Cheap logging shared by every context; engines.js and background.js call
  // it without loading lib/browser.js.
  AT.debug = false;
  AT.log = (...args) => {
    if (AT.debug) console.debug('[autotranslate]', ...args);
  };
  AT.warn = (...args) => console.warn('[autotranslate]', ...args);

  C.MSG = {
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
    CONTENT_PING: 'at/content-ping'
  };

  // Value is the code sent to providers; `native` is shown in the UI so the
  // picker stays readable whatever the browser UI language is.
  C.LANGS = [
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
  ];

  C.LANG_CODES = new Set(C.LANGS.map((l) => l.code));

  C.isSupportedLang = (code) => typeof code === 'string' && C.LANG_CODES.has(code);

  // 'en-US' matches 'en'; regional variants stay distinct ('zh-CN' vs 'zh-TW').
  C.sameLanguage = (a, b) => {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const left = a.trim().toLowerCase();
    const right = b.trim().toLowerCase();
    if (!left || !right) return false;
    if (left === right) return true;
    return !right.includes('-') && left.split('-')[0] === right;
  };

  // Provider catalogue. Implementations live in lib/engines.js; the metadata is
  // duplicated nowhere so the options page can render itself from this list.
  C.ENGINES = [
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
    }
  ];

  C.getEngineMeta = (id) => C.ENGINES.find((e) => e.id === id) ?? null;

  // Provider-specific spellings of the codes in C.LANGS.
  C.ENGINE_LANG_ALIAS = {
    google: { 'zh-CN': 'zh-CN', 'zh-TW': 'zh-TW', pt: 'pt-BR' },
    libretranslate: { 'zh-CN': 'zh', 'zh-TW': 'zh', pt: 'pt' }
  };

  // Used only to pick a text direction for the selection card.
  C.RTL_LANGS = new Set(['ar', 'fa', 'he', 'ur']);

  C.SITE_RULE_ACTIONS = ['always', 'never'];
})();

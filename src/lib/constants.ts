// Shared constants for every extension context.
// Loaded as a classic script (importScripts in the Chrome service worker,
// <script> tags / background.scripts elsewhere); must be the first AT file
// after the polyfill because every other module reads from AT.C.
namespace AT {
  export type Lang = { code: string; native: string };

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
    CONTENT_STATE: string;
    // background -> offscreen document (the on-device host)
    LOCAL_TRANSLATE: string;
    LOCAL_LOAD: string;
    LOCAL_UNLOAD: string;
    LOCAL_COUNT: string;
    LOCAL_QUERY: string;
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
    DEFAULT_MAX_NODES: number;
    OBSERVER_BATCH_NODES: number;
    SENTENCE_MAX_CHARS: number;
    OBSERVER_DEBOUNCE_MS: number;
    IGNORE_SELECTOR: string;
    MSG: MessageTypes;
    LANGS: Lang[];
    LANG_CODES: Set<string>;
    isSupportedLang: (code: string | null | undefined) => boolean;
    sameLanguage: (a: string | null | undefined, b: string | null | undefined) => boolean;
    RTL_LANGS: Record<string, true | undefined>;
    SITE_RULE_ACTIONS: readonly SiteRuleAction[];
  };

  export const C: Constants = {
    STORAGE_KEY: 'settings',
    BADGE_TEXT: '文A',
    BADGE_COLOR: '#1a73e8',
    // Hard ceiling on DOM text nodes touched per run; keeps huge feeds cheap.
    DEFAULT_MAX_NODES: 600,
    // Ceiling for nodes translated by the MutationObserver in one tick.
    OBSERVER_BATCH_NODES: 40,
    // Longer texts are split into sentences before they are sent: about 50
    // Latin tokens, well inside a sentence's worth of meaning. Only a text
    // longer than this pays for the extra round trip.
    SENTENCE_MAX_CHARS: 900,
    OBSERVER_DEBOUNCE_MS: 300,
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
      // content -> background: what this tab is doing, asked when the worker
      // has no memory of it (MV3 terminates the worker after a quiet spell).
      CONTENT_STATE: 'at/content-state',
      // background -> offscreen document
      LOCAL_TRANSLATE: 'at/local-translate',
      LOCAL_LOAD: 'at/local-load',
      LOCAL_UNLOAD: 'at/local-unload',
      LOCAL_COUNT: 'at/local-count',
      // background -> host: "what is your state?" (`LOCAL_STATUS` travels the
      // other way; sharing one type let the background answer its own question).
      LOCAL_QUERY: 'at/local-query',
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


/** Protocol validity, not linguistic scoring. Never invent a translation when
 * a provider emits control tokens, empty output or a runaway repetition. */
namespace AT {
  export type OutputIssue = 'empty-output' | 'control-token' | 'repeated-output' | 'excessive-output';
  export function outputIssue(source: string, answer: string, partial = false): OutputIssue | null {
    if (!partial && !answer.trim()) return 'empty-output';
    // A page that literally discusses these tokens may legitimately contain them.
    // Newly introduced controls, or more copies than the source, are not prose.
    const controls = /<(?:pad|bos|eos|start_of_turn|end_of_turn)>|<\|(?:endoftext|im_start|im_end)\|>/g;
    for (const token of new Set(answer.match(controls) ?? [])) {
      if (answer.split(token).length > source.split(token).length) return 'control-token';
    }
    const ceiling = Math.min(262144, Math.max(2048, source.length * 24 + 256));
    if (answer.length > ceiling) return 'excessive-output';
    // Only long, newly introduced loops are structural errors. Names, short
    // repeated words and source text which itself repeats must remain legal.
    const repetition = /(.{2,80}?)\1{15,}/gu.exec(answer);
    if (repetition && !source.includes(repetition[0])) return 'repeated-output';
    return null;
  }
}

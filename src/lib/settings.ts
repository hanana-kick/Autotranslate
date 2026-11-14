// Settings: defaults, validation, persistence.
// Load after lib/constants.js, lib/browser.js, lib/rules.js, lib/local.js.
namespace AT.settings {
  const C = AT.C;

  export type TranslationConcurrency = 1 | 2 | 4 | 8;
  export type TranslationRendering = 'aurora' | 'immediate';

  export function isTranslationConcurrency(value: unknown): value is TranslationConcurrency {
    return value === 1 || value === 2 || value === 4 || value === 8;
  }

  export type Settings = {
    version: number;
    enabled: boolean;
    targetLang: string;
    sourceLang: string;
    /** Model id the on-device engine loads; empty means none selected. */
    localModelId: string;
    /** Combined input and output tokens one generation may spend. */
    localMaxTokens: number;
    maxNodes: number;
    /** Shared page-generation limit across tabs; 1 opts into serial translation. */
    translationConcurrency: TranslationConcurrency;
    translationRendering: TranslationRendering;
    showBadge: boolean;
    siteRules: AT.rules.SiteRule[];
    alwaysTranslateLanguages: string[];
    debug: boolean;
  };

  /** What a content script may see: no site rules. `debug` is included because
   *  it draws the translated-region overlay in the page. */
  export type ContentSnapshot = {
    /** Generation-configuration identity. */
    translationKey?: string;
    enabled: boolean;
    targetLang: string;
    sourceLang: string;
    maxNodes: number;
    translationConcurrency?: TranslationConcurrency;
    translationRendering?: TranslationRendering;
    showBadge: boolean;
    debug: boolean;
  };

  /** A stored blob: every key may be missing and no value is trusted. */
  type RawSettings = {
    version?: unknown;
    enabled?: unknown;
    targetLang?: unknown;
    sourceLang?: unknown;
    localModelId?: unknown;
    localMaxTokens?: unknown;
    maxNodes?: unknown;
    translationConcurrency?: unknown;
    translationRendering?: unknown;
    showBadge?: unknown;
    siteRules?: { pattern?: unknown; action?: unknown }[] | null;
    alwaysTranslateLanguages?: unknown;
    debug?: unknown;
  };

  export function defaults(): Settings {
    return {
      version: 3,
      // Nothing translates until onboarding finishes: there is no model yet,
      // and the user has not chosen a target language.
      enabled: false,
      targetLang: uiLang(),
      sourceLang: 'auto',
      localModelId: '',
      localMaxTokens: AT.local.DEFAULT_MAX_TOKENS,
      maxNodes: C.DEFAULT_MAX_NODES,
      translationConcurrency: 8,
      translationRendering: 'aurora',
      showBadge: true,
      siteRules: [],
      alwaysTranslateLanguages: [],
      debug: false
    };
  }

  // Browser UI language -> one of C.LANGS, region folded where we have no
  // regional variant ('ja-JP' -> 'ja'). A UI language the picker does not
  // offer becomes 'en'.
  export function uiLang(): string {
    const raw =
      AT.api?.i18n?.getUILanguage?.() ??
      (typeof navigator !== 'undefined' ? navigator.language : null) ??
      'en';
    const exact = C.LANG_CODES.has(raw) ? raw : null;
    if (exact) return exact;
    const base = raw.toLowerCase().split('-')[0] ?? '';
    if (base === 'zh') return raw.toLowerCase().endsWith('-tw') || raw.toLowerCase().endsWith('-hk') ? 'zh-TW' : 'zh-CN';
    return C.LANG_CODES.has(base) ? base : 'en';
  }

  const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
    const n = typeof value === 'string' ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  };

  // Coerces anything (including old or hand-edited blobs) into a full, known
  // settings object. Unknown keys are dropped, bad values fall back.
  /**
   * `base` is what an unusable value falls back to: the defaults for storage
   * read from scratch, the settings already in hand for a patch, so a bad field
   * in one save cannot silently reset the model the user chose.
   */
  export function normalize(raw: unknown, base: Settings = defaults()): Settings {
    // The blob is whatever storage held; the all-unknown shape forces every
    // field to be narrowed before it is used.
    const input: RawSettings = raw && typeof raw === 'object' ? (raw as RawSettings) : {};
    const siteRules: AT.rules.SiteRule[] = [];
    const seen = new Set<string>();
    // Widened from `readonly SiteRuleAction[]` so an untrusted action is
    // checked against the list the constants own.
    const actions: readonly string[] = C.SITE_RULE_ACTIONS;
    const canonical = typeof input.version === 'number' && input.version < 3
      ? AT.rules.migrateLegacyPattern : AT.rules.canonical;
    for (const rule of Array.isArray(input.siteRules) ? input.siteRules : []) {
      const pattern = canonical(rule?.pattern);
      if (!pattern || typeof rule?.action !== 'string' || !actions.includes(rule.action) || seen.has(pattern)) continue;
      seen.add(pattern);
      siteRules.push({ pattern, action: rule.action as AT.SiteRuleAction });
      if (siteRules.length >= 200) break;
    }
    const alwaysTranslateLanguages = Array.isArray(input.alwaysTranslateLanguages)
      ? [...new Set(input.alwaysTranslateLanguages.filter(
        (code): code is string => typeof code === 'string' && C.isSupportedLang(code)
      ))]
      : [...base.alwaysTranslateLanguages];
    return {
      version: 3,
      enabled: input.enabled === true,
      targetLang:
        typeof input.targetLang === 'string' && C.isSupportedLang(input.targetLang) ? input.targetLang : base.targetLang,
      sourceLang:
        input.sourceLang === 'auto' || (typeof input.sourceLang === 'string' && C.isSupportedLang(input.sourceLang))
          ? input.sourceLang
          : 'auto',
      maxNodes: clampInt(input.maxNodes, 10, 5000, base.maxNodes),
      translationConcurrency: isTranslationConcurrency(input.translationConcurrency)
        ? input.translationConcurrency : base.translationConcurrency,
      translationRendering: input.translationRendering === 'aurora' || input.translationRendering === 'immediate'
        ? input.translationRendering : base.translationRendering,
      showBadge: input.showBadge !== false,
      siteRules,
      alwaysTranslateLanguages,
      localModelId: typeof input.localModelId === 'string' ? input.localModelId.trim().slice(0, 96) : '',
      localMaxTokens: clampInt(
        input.localMaxTokens,
        AT.local.MIN_MAX_TOKENS,
        AT.local.MAX_MAX_TOKENS,
        base.localMaxTokens
      ),
      debug: input.debug === true
    };
  }

  // What a content script is allowed to know: no site rules.
  export function contentSnapshot(normalized?: Settings | null): ContentSnapshot {
    const s = normalized ?? defaults();
    return {
      translationKey: JSON.stringify(['prompt-v3-source64', s.localModelId, s.localMaxTokens, s.sourceLang, s.targetLang]),
      enabled: s.enabled,
      targetLang: s.targetLang,
      sourceLang: s.sourceLang,
      maxNodes: s.maxNodes,
      translationConcurrency: s.translationConcurrency,
      translationRendering: s.translationRendering,
      showBadge: s.showBadge,
      debug: s.debug
    };
  }

  // `AT.storage` is nullable: a context without it fails on the very same
  // missing property the plain-JS version touched.
  export async function load(): Promise<Settings> {
    const stored = await AT.storage!.local.get(C.STORAGE_KEY);
    const raw = stored?.[C.STORAGE_KEY];
    const normalized = normalize(raw);
    // Replace legacy blobs, rather than merging: retired fields (including
    // credentials) must leave persistent storage as well as the public shape.
    if (raw && typeof raw === 'object' &&
        ((raw as RawSettings).version !== normalized.version ||
         Object.keys(raw).some(key => !Object.prototype.hasOwnProperty.call(normalized, key)))) {
      await AT.storage!.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
      await AT.storage!.local.set({ [C.STORAGE_KEY]: normalized });
    }
    return normalized;
  }

  export async function save(patch: Partial<Settings>): Promise<Settings> {
    const current = await load();
    const next = normalize({ ...current, ...patch }, current);
    await AT.storage!.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
    await AT.storage!.local.set({ [C.STORAGE_KEY]: next });
    AT.debug = next.debug;
    return next;
  }

  export async function reset(): Promise<Settings> {
    const next = normalize(defaults());
    await AT.storage!.local.set({ [C.STORAGE_KEY]: next });
    AT.debug = next.debug;
    return next;
  }
}

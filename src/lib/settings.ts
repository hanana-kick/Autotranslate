// Settings: defaults, validation, persistence.
// Load after lib/constants.js, lib/browser.js, lib/rules.js, lib/local.js.
namespace AT.settings {
  const C = AT.C;

  export type Engine = 'local' | 'openai';
  export type ServerSettings = { baseUrl: string; apiKey: string; model: string; timeoutMs: number };

  /** Accept a server root, API base path, or full Chat Completions URL. */
  export function normalizeServerBaseUrl(value: string): string {
    if (!value.trim()) return '';
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('Use an HTTP(S) API URL without credentials, query parameters or a fragment.');
    }
    let path = url.pathname.replace(/\/+$/, '');
    if (path.endsWith('/chat/completions')) path = path.slice(0, -'/chat/completions'.length);
    url.pathname = path || '/v1';
    return url.href.replace(/\/+$/, '');
  }

  export function serverOptions(s: Settings): ServerSettings {
    return { baseUrl: s.serverBaseUrl, apiKey: s.serverApiKey, model: s.serverModel, timeoutMs: s.serverTimeoutMs };
  }

  export function serverConfigured(s: Settings): boolean {
    return !!(s.serverBaseUrl && s.serverModel);
  }

  export type Settings = {
    version: number;
    engine: Engine;
    serverBaseUrl: string;
    /** Browser-local only; excluded from every content-script snapshot. */
    serverApiKey: string;
    serverModel: string;
    serverTimeoutMs: number;
    /** Changes when server config changes; never a credential-derived hash. */
    serverRevision: number;
    enabled: boolean;
    targetLang: string;
    sourceLang: string;
    /** Model id the on-device engine loads; empty means none selected. */
    localModelId: string;
    /** Combined input and output tokens one generation may spend. */
    localMaxTokens: number;
    maxNodes: number;
    showBadge: boolean;
    siteRules: AT.rules.SiteRule[];
    debug: boolean;
  };

  /** What a content script may see: no site rules, no debug flag. */
  export type ContentSnapshot = {
    /** Opaque generation-configuration identity; never includes credentials. */
    translationKey?: string;
    enabled: boolean;
    targetLang: string;
    sourceLang: string;
    maxNodes: number;
    showBadge: boolean;
  };

  /** A stored blob: every key may be missing and no value is trusted. */
  type RawSettings = {
    version?: unknown;
    engine?: unknown;
    serverBaseUrl?: unknown;
    serverApiKey?: unknown;
    serverModel?: unknown;
    serverTimeoutMs?: unknown;
    serverRevision?: unknown;
    enabled?: unknown;
    targetLang?: unknown;
    sourceLang?: unknown;
    localModelId?: unknown;
    localMaxTokens?: unknown;
    maxNodes?: unknown;
    showBadge?: unknown;
    siteRules?: { pattern?: unknown; action?: unknown }[] | null;
    debug?: unknown;
  };

  export function defaults(): Settings {
    return {
      version: 1,
      engine: 'local',
      serverBaseUrl: '',
      serverApiKey: '',
      serverModel: '',
      serverTimeoutMs: 60000,
      serverRevision: 0,
      // Nothing translates until onboarding finishes: there is no model yet,
      // and the user has not chosen a target language.
      enabled: false,
      targetLang: uiLang(),
      sourceLang: 'auto',
      localModelId: '',
      localMaxTokens: AT.local.DEFAULT_MAX_TOKENS,
      maxNodes: C.DEFAULT_MAX_NODES,
      showBadge: true,
      siteRules: [],
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
   * in one save cannot silently reset the engine the user chose.
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
    for (const rule of Array.isArray(input.siteRules) ? input.siteRules : []) {
      const pattern = AT.rules.canonical(rule?.pattern);
      if (!pattern || typeof rule?.action !== 'string' || !actions.includes(rule.action) || seen.has(pattern)) continue;
      seen.add(pattern);
      siteRules.push({ pattern, action: rule.action as AT.SiteRuleAction });
      if (siteRules.length >= 200) break;
    }
    let serverBaseUrl = '';
    try { serverBaseUrl = normalizeServerBaseUrl(typeof input.serverBaseUrl === 'string' ? input.serverBaseUrl.slice(0, 2048) : ''); }
    catch { /* Invalid endpoints fail closed, never fall back to another host. */ }
    return {
      version: 1,
      engine: input.engine === 'openai' ? 'openai' : 'local',
      serverBaseUrl,
      serverApiKey: typeof input.serverApiKey === 'string' && !/[\r\n]/u.test(input.serverApiKey) ? input.serverApiKey.trim().slice(0, 8192) : '',
      serverModel: typeof input.serverModel === 'string' ? input.serverModel.trim().slice(0, 200) : '',
      serverTimeoutMs: clampInt(input.serverTimeoutMs, 5000, 300000, base.serverTimeoutMs),
      serverRevision: clampInt(input.serverRevision, 0, Number.MAX_SAFE_INTEGER, base.serverRevision),
      enabled: input.enabled === true,
      targetLang:
        typeof input.targetLang === 'string' && C.isSupportedLang(input.targetLang) ? input.targetLang : base.targetLang,
      sourceLang:
        input.sourceLang === 'auto' || (typeof input.sourceLang === 'string' && C.isSupportedLang(input.sourceLang))
          ? input.sourceLang
          : 'auto',
      maxNodes: clampInt(input.maxNodes, 10, 5000, base.maxNodes),
      showBadge: input.showBadge !== false,
      siteRules,
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

  // What a content script is allowed to know: no site rules, no debug flag.
  export function contentSnapshot(normalized?: Settings | null): ContentSnapshot {
    const s = normalized ?? defaults();
    return {
      translationKey: s.engine === 'openai'
        ? JSON.stringify(['server-prompt-v1', s.serverRevision, s.sourceLang, s.targetLang])
        : JSON.stringify(['prompt-v2', s.localModelId, s.localMaxTokens, s.sourceLang, s.targetLang]),
      enabled: s.enabled,
      targetLang: s.targetLang,
      sourceLang: s.sourceLang,
      maxNodes: s.maxNodes,
      showBadge: s.showBadge
    };
  }

  // `AT.storage` is nullable: a context without it fails on the very same
  // missing property the plain-JS version touched.
  export async function load(): Promise<Settings> {
    const stored = await AT.storage!.local.get(C.STORAGE_KEY);
    return normalize(stored?.[C.STORAGE_KEY]);
  }

  export async function save(patch: Partial<Settings>): Promise<Settings> {
    const current = await load();
    const next = normalize({ ...current, ...patch }, current);
    next.serverRevision = current.serverRevision;
    if (['serverBaseUrl', 'serverApiKey', 'serverModel', 'serverTimeoutMs'].some((key) =>
      next[key as keyof Settings] !== current[key as keyof Settings])) {
      next.serverRevision = current.serverRevision < Number.MAX_SAFE_INTEGER ? current.serverRevision + 1 : 1;
    }
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

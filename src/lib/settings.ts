// Settings: defaults, validation, persistence.
// Load after lib/constants.js, lib/browser.js, lib/rules.js, lib/local.js.
namespace AT.settings {
  const C = AT.C;

  export type Settings = {
    version: number;
    enabled: boolean;
    autoDetect: boolean;
    targetLang: string;
    sourceLang: string;
    engine: string;
    endpoints: { [engineId: string]: string };
    apiKey: string;
    /** Model id the on-device engine loads; empty means none selected. */
    localModelId: string;
    /** Combined input and output tokens one generation may spend. */
    localMaxTokens: number;
    /** Engine used when on-device translation fails; '' disables the fallback. */
    fallbackEngine: string;
    batchChars: number;
    maxNodes: number;
    showBadge: boolean;
    siteRules: AT.rules.SiteRule[];
    debug: boolean;
  };

  /** What a content script may see: no endpoints, no API key, no site rules. */
  export type ContentSnapshot = {
    enabled: boolean;
    autoDetect: boolean;
    targetLang: string;
    sourceLang: string;
    engine: string;
    batchChars: number;
    maxNodes: number;
    showBadge: boolean;
  };

  /** A stored blob: every key may be missing and no value is trusted. */
  type RawSettings = {
    version?: unknown;
    enabled?: unknown;
    autoDetect?: unknown;
    targetLang?: unknown;
    sourceLang?: unknown;
    engine?: unknown;
    endpoints?: { [engineId: string]: unknown } | null;
    apiKey?: unknown;
    localModelId?: unknown;
    localMaxTokens?: unknown;
    fallbackEngine?: unknown;
    batchChars?: unknown;
    maxNodes?: unknown;
    showBadge?: unknown;
    siteRules?: { pattern?: unknown; action?: unknown }[] | null;
    debug?: unknown;
  };

  const LOCALHOSTS: Record<string, true | undefined> = {
    localhost: true,
    '127.0.0.1': true,
    '[::1]': true
  };

  export function defaults(): Settings {
    return {
      version: 1,
      enabled: true,
      autoDetect: true,
      targetLang: uiLang(),
      sourceLang: 'auto',
      // The on-device engine is the product: a fresh install translates with
      // the local model, not by sending the page to a provider.
      engine: 'local',
      endpoints: Object.fromEntries(C.ENGINES.map((e) => [e.id, e.endpoint])),
      apiKey: '',
      localModelId: '',
      localMaxTokens: AT.local.DEFAULT_MAX_TOKENS,
      // Off by default: choosing the on-device engine must not quietly send
      // text to a provider. The options page offers this as an explicit opt-in.
      fallbackEngine: '',
      batchChars: C.DEFAULT_BATCH_CHARS,
      maxNodes: C.DEFAULT_MAX_NODES,
      showBadge: true,
      siteRules: [],
      debug: false
    };
  }

  // Browser UI language -> one of C.LANGS, region folded where we have no
  // regional variant ('pt-BR' -> 'pt').
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

  export function isValidEndpoint(value: unknown): string | null {
    let url: URL;
    try {
      url = new URL(String(value ?? '').trim());
    } catch {
      return null;
    }
    const okScheme = url.protocol === 'https:' || (url.protocol === 'http:' && LOCALHOSTS[url.hostname] === true);
    if (!okScheme || !url.hostname) return null;
    return url.toString();
  }

  // A fallback must be a real remote engine: falling back to 'local' would
  // loop, and an unknown id would only bury the failure the user should see.
  function pickFallback(value: unknown, fallback: string): string {
    if (value === undefined) return fallback;
    // Anything else was asked for explicitly, so an unusable answer means "no
    // fallback": keeping the previous provider would send a page to the cloud
    // because of a value the user never chose.
    const meta = typeof value === 'string' && value !== '' ? C.getEngineMeta(value) : null;
    return meta && meta.kind !== 'local' ? meta.id : '';
  }

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
    const endpoints: { [engineId: string]: string } = { ...base.endpoints };
    // Every engine id stays a key, `local` included: its entry is never
    // resolved, because `kind: 'local'` asks the model store rather than a URL.
    for (const engine of C.ENGINES) {
      const candidate = isValidEndpoint(input.endpoints?.[engine.id]);
      if (candidate) endpoints[engine.id] = candidate;
    }
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
    return {
      version: 1,
      enabled: input.enabled !== false,
      autoDetect: input.autoDetect !== false,
      targetLang:
        typeof input.targetLang === 'string' && C.isSupportedLang(input.targetLang) ? input.targetLang : base.targetLang,
      sourceLang:
        input.sourceLang === 'auto' || (typeof input.sourceLang === 'string' && C.isSupportedLang(input.sourceLang))
          ? input.sourceLang
          : 'auto',
      engine: typeof input.engine === 'string' && C.getEngineMeta(input.engine) ? input.engine : base.engine,
      endpoints,
      apiKey: typeof input.apiKey === 'string' ? input.apiKey.trim().slice(0, 512) : '',
      batchChars: clampInt(input.batchChars, 100, 8000, base.batchChars),
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
      fallbackEngine: pickFallback(input.fallbackEngine, base.fallbackEngine),
      debug: input.debug === true
    };
  }

  // What a content script is allowed to know: no endpoints, no API key.
  export function contentSnapshot(normalized?: Settings | null): ContentSnapshot {
    const s = normalized ?? defaults();
    return {
      enabled: s.enabled,
      autoDetect: s.autoDetect,
      targetLang: s.targetLang,
      sourceLang: s.sourceLang,
      engine: s.engine,
      batchChars: Math.min(s.batchChars, C.getEngineMeta(s.engine)?.maxChars ?? s.batchChars),
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

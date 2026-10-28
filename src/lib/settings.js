// Settings: defaults, validation, persistence.
// Load after lib/constants.js, lib/browser.js, lib/rules.js.
(() => {
  const AT = (globalThis.AT ??= {});
  const C = AT.C;
  const settings = (AT.settings = {});

  const LOCALHOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
  settings.defaults = () => ({
    version: 1,
    enabled: true,
    autoDetect: true,
    targetLang: settings.uiLang(),
    sourceLang: 'auto',
    engine: 'google',
    endpoints: Object.fromEntries(C.ENGINES.map((e) => [e.id, e.endpoint])),
    apiKey: '',
    batchChars: C.DEFAULT_BATCH_CHARS,
    maxNodes: C.DEFAULT_MAX_NODES,
    showBadge: true,
    siteRules: [],
    debug: false
  });

  // Browser UI language -> one of C.LANGS, region folded where we have no
  // regional variant ('pt-BR' -> 'pt').
  settings.uiLang = () => {
    const raw =
      AT.api?.i18n?.getUILanguage?.() ??
      (typeof navigator !== 'undefined' ? navigator.language : null) ??
      'en';
    const exact = C.LANG_CODES.has(raw) ? raw : null;
    if (exact) return exact;
    const base = raw.toLowerCase().split('-')[0];
    if (base === 'zh') return raw.toLowerCase().endsWith('-tw') || raw.toLowerCase().endsWith('-hk') ? 'zh-TW' : 'zh-CN';
    return C.LANG_CODES.has(base) ? base : 'en';
  };

  const clampInt = (value, min, max, fallback) => {
    const n = typeof value === 'string' ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  };

  settings.isValidEndpoint = (value) => {
    let url;
    try {
      url = new URL(String(value ?? '').trim());
    } catch {
      return null;
    }
    const okScheme = url.protocol === 'https:' || (url.protocol === 'http:' && LOCALHOSTS.has(url.hostname));
    if (!okScheme || !url.hostname) return null;
    return url.toString();
  };

  // Coerces anything (including old or hand-edited blobs) into a full, known
  // settings object. Unknown keys are dropped, bad values fall back.
  settings.normalize = (raw) => {
    const base = settings.defaults();
    const input = raw && typeof raw === 'object' ? raw : {};
    const endpoints = { ...base.endpoints };
    for (const engine of C.ENGINES) {
      const candidate = settings.isValidEndpoint(input.endpoints?.[engine.id]);
      if (candidate) endpoints[engine.id] = candidate;
    }
    const siteRules = [];
    const seen = new Set();
    for (const rule of Array.isArray(input.siteRules) ? input.siteRules : []) {
      const pattern = AT.rules.canonical(rule?.pattern);
      if (!pattern || !C.SITE_RULE_ACTIONS.includes(rule?.action) || seen.has(pattern)) continue;
      seen.add(pattern);
      siteRules.push({ pattern, action: rule.action });
      if (siteRules.length >= 200) break;
    }
    return {
      version: 1,
      enabled: input.enabled !== false,
      autoDetect: input.autoDetect !== false,
      targetLang: C.isSupportedLang(input.targetLang) ? input.targetLang : base.targetLang,
      sourceLang:
        input.sourceLang === 'auto' || C.isSupportedLang(input.sourceLang) ? input.sourceLang : 'auto',
      engine: C.getEngineMeta(input.engine) ? input.engine : base.engine,
      endpoints,
      apiKey: typeof input.apiKey === 'string' ? input.apiKey.trim().slice(0, 512) : '',
      batchChars: clampInt(input.batchChars, 100, 8000, base.batchChars),
      maxNodes: clampInt(input.maxNodes, 10, 5000, base.maxNodes),
      showBadge: input.showBadge !== false,
      siteRules,
      debug: input.debug === true
    };
  };

  // What a content script is allowed to know: no endpoints, no API key.
  settings.contentSnapshot = (normalized) => {
    const s = normalized ?? settings.defaults();
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
  };

  settings.load = async () => {
    const stored = await AT.storage.local.get(C.STORAGE_KEY);
    return settings.normalize(stored?.[C.STORAGE_KEY]);
  };

  settings.save = async (patch) => {
    const current = await settings.load();
    const next = settings.normalize({ ...current, ...patch });
    await AT.storage.local.set({ [C.STORAGE_KEY]: next });
    AT.debug = next.debug;
    return next;
  };

  settings.reset = async () => {
    const next = settings.normalize(settings.defaults());
    await AT.storage.local.set({ [C.STORAGE_KEY]: next });
    AT.debug = next.debug;
    return next;
  };
})();

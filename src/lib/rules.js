// Site rules: pattern -> {always|never}.
// Load after lib/constants.js.
(() => {
  const AT = (globalThis.AT ??= {});
  const C = AT.C;
  const rules = (AT.rules = {});

  function toUrl(href) {
    if (href instanceof URL) return href;
    if (typeof href !== 'string' || !href) return null;
    try {
      return new URL(href);
    } catch {
      return null;
    }
  }

  // Accepts `example.com`, `*.example.com`, `example.com/news/*`,
  // `https://example.com/news/*`. Returns null for unusable input.
  rules.parse = (raw) => {
    if (typeof raw !== 'string') return null;
    const input = raw.trim();
    if (!input || input.length > 200) return null;
    let text = input.toLowerCase();
    let scheme = null;
    const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/.exec(text);
    if (schemeMatch) {
      scheme = schemeMatch[1];
      text = schemeMatch[2];
    }
    let host = text;
    let path = '';
    const slash = text.indexOf('/');
    if (slash >= 0) {
      host = text.slice(0, slash);
      path = text.slice(slash);
    }
    host = stripWww(host.replace(/^\*\./, ''));
    if (!host || !/^[a-z0-9._~%:[\]-]+$/.test(host)) return null;
    return { host, path, scheme };
  };

  const stripWww = (host) => host.replace(/^www\./, '');

  rules.matches = (pattern, href) => {
    const url = toUrl(href);
    if (!url || !pattern) return false;
    if (pattern.scheme && pattern.scheme !== url.protocol.replace(':', '')) return false;
    const host = stripWww(url.hostname.toLowerCase());
    const want = stripWww(pattern.host);
    if (host !== want && !host.endsWith(`.${want}`)) return false;
    if (pattern.path) {
      const prefix = pattern.path.replace(/\*+$/, '');
      const target = `${url.pathname}${url.search}`;
      if (!target.startsWith(prefix)) return false;
    }
    return true;
  };

  // Explicit scheme beats a longer host, a longer host beats a path prefix.
  rules.score = (pattern) => {
    if (!pattern) return -1;
    const labels = stripWww(pattern.host).split('.').length;
    const pathLength = pattern.path ? pattern.path.replace(/\*+$/, '').length : 0;
    return (pattern.scheme ? 1e6 : 0) + labels * 1e3 + pathLength;
  };

  // Highest score wins; on a tie an explicit `never` beats `always` so users
  // can carve exceptions out of a broad "always translate" rule.
  rules.resolve = (siteRules, href) => {
    const url = toUrl(href);
    if (!url || !Array.isArray(siteRules)) return null;
    let best = null;
    for (const rule of siteRules) {
      if (!rule || !C.SITE_RULE_ACTIONS.includes(rule.action)) continue;
      const pattern = rules.parse(rule.pattern);
      if (!pattern || !rules.matches(pattern, url)) continue;
      const candidate = { action: rule.action, pattern: rule.pattern };
      const score = rules.score(pattern);
      if (!best || score > best.score) {
        best = { ...candidate, score };
      } else if (score === best.score && best.action !== 'never' && rule.action === 'never') {
        best = { ...candidate, score };
      }
    }
    return best ? { action: best.action, pattern: best.pattern } : null;
  };

  // Default pattern offered by the UI for a page.
  rules.hostPattern = (href) => {
    const url = toUrl(href);
    if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) return null;
    return stripWww(url.hostname.toLowerCase());
  };

  rules.canonical = (raw) => {
    const parsed = rules.parse(raw);
    if (!parsed) return null;
    // `example.com/` and `example.com` are the same rule; keeping the bare
    // slash would let users store both.
    const scheme = parsed.scheme ? `${parsed.scheme}://` : '';
    const path = parsed.path === '/' ? '' : parsed.path;
    return `${scheme}${parsed.host}${path}`;
  };
})();

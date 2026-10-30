// Site rules: pattern -> {always|never}.
// Load after lib/constants.js.
namespace AT.rules {
  const C = AT.C;

  /** A parsed pattern; `scheme` and `path` stay empty when the rule omitted them. */
  export type Pattern = {
    host: string;
    path: string;
    scheme: string | null;
  };

  /** A rule as storage and the UI agree to store it. */
  export type SiteRule = {
    pattern: string;
    action: AT.SiteRuleAction;
  };

  /** The winning rule for a page; `pattern` is echoed back exactly as stored. */
  export type Decision = {
    action: AT.SiteRuleAction;
    pattern: unknown;
  };

  /** A rule as it arrives from storage: both fields are untrusted. */
  type StoredRule = { pattern?: unknown; action?: unknown } | null | undefined;

  function toUrl(href: unknown): URL | null {
    if (href instanceof URL) return href;
    if (typeof href !== 'string' || !href) return null;
    try {
      return new URL(href);
    } catch {
      return null;
    }
  }

  function stripWww(host: string): string {
    return host.replace(/^www\./, '');
  }

  // Accepts `example.com`, `*.example.com`, `example.com/news/*`,
  // `https://example.com/news/*`. Returns null for unusable input.
  export function parse(raw: unknown): Pattern | null {
    if (typeof raw !== 'string') return null;
    const input = raw.trim();
    if (!input || input.length > 200) return null;
    let text = input.toLowerCase();
    let scheme: string | null = null;
    const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/.exec(text);
    if (schemeMatch) {
      scheme = schemeMatch[1] ?? null;
      text = schemeMatch[2] ?? '';
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
  }

  export function matches(pattern: Pattern | null | undefined, href: unknown): boolean {
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
  }

  // Explicit scheme beats a longer host, a longer host beats a path prefix.
  export function score(pattern: Pattern | null | undefined): number {
    if (!pattern) return -1;
    const labels = stripWww(pattern.host).split('.').length;
    const pathLength = pattern.path ? pattern.path.replace(/\*+$/, '').length : 0;
    return (pattern.scheme ? 1e6 : 0) + labels * 1e3 + pathLength;
  }

  // Highest score wins; on a tie an explicit `never` beats `always` so users
  // can carve exceptions out of a broad "always translate" rule.
  export function resolve(siteRules: unknown, href: unknown): Decision | null {
    const url = toUrl(href);
    if (!url || !Array.isArray(siteRules)) return null;
    const stored: StoredRule[] = siteRules;
    // Widened from `readonly SiteRuleAction[]` so an untrusted action can be
    // tested against the list the constants own without lying about its type.
    const actions: readonly string[] = C.SITE_RULE_ACTIONS;
    let best: (Decision & { score: number }) | null = null;
    for (const rule of stored) {
      if (!rule || typeof rule.action !== 'string' || !actions.includes(rule.action)) continue;
      const pattern = parse(rule.pattern);
      if (!pattern || !matches(pattern, url)) continue;
      const candidate: Decision = { action: rule.action as AT.SiteRuleAction, pattern: rule.pattern };
      const score = AT.rules.score(pattern);
      if (!best || score > best.score) {
        best = { ...candidate, score };
      } else if (score === best.score && best.action !== 'never' && rule.action === 'never') {
        best = { ...candidate, score };
      }
    }
    return best ? { action: best.action, pattern: best.pattern } : null;
  }

  // Default pattern offered by the UI for a page.
  export function hostPattern(href: unknown): string | null {
    const url = toUrl(href);
    if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) return null;
    return stripWww(url.hostname.toLowerCase());
  }

  export function canonical(raw: unknown): string | null {
    const parsed = parse(raw);
    if (!parsed) return null;
    // `example.com/` and `example.com` are the same rule; keeping the bare
    // slash would let users store both.
    const scheme = parsed.scheme ? `${parsed.scheme}://` : '';
    const path = parsed.path === '/' ? '' : parsed.path;
    return `${scheme}${parsed.host}${path}`;
  }
}

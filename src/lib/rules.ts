// Site rules: pattern -> {always|never}.
// Load after lib/constants.js.
namespace AT.rules {
  const C = AT.C;

  /** A parsed pattern; `scheme` and `path` stay empty when the rule omitted them. */
  export type Pattern = {
    host: string;
    path: string;
    scheme: string | null;
    port: string | null;
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

  // Bare hosts include subdomains. Explicit host globs preserve label depth;
  // path globs use * for one segment and ** across separators.
  export function parse(raw: unknown): Pattern | null {
    if (typeof raw !== 'string') return null;
    const input = raw.trim();
    if (!input || input.length > 2048 || /[\s\\]/u.test(input)) return null;
    let text = input, scheme: string | null = null;
    const qualified = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text);
    if (qualified) {
      scheme = qualified[1]!.toLowerCase();
      if (scheme !== 'http' && scheme !== 'https') return null;
      text = text.slice(qualified[0].length);
    }
    const split = text.search(/[/?#]/u);
    const authority = split < 0 ? text : text.slice(0, split);
    let path = split < 0 ? '' : text.slice(split);
    if (path && !path.startsWith('/')) path = '/' + path;
    const parts = /^(\[[0-9a-f:]+\]|[^:]+)(?::(\d{1,5}))?$/i.exec(authority);
    if (!parts) return null;
    let host = parts[1]!.toLowerCase();
    const port = parts[2] ? String(Number(parts[2])) : null;
    if (host.length > 253) return null;
    if (port && (Number(port) < 1 || Number(port) > 65535)) return null;
    if (!/^[a-z0-9.*[\]:-]+$/u.test(host) || host.includes('..')) return null;
    try { new URL(`http://${host.replace(/\*+/g, 'glob')}${port ? ':' + port : ''}`); }
    catch { return null; }
    if (!host.includes('*')) host = stripWww(host);
    return { host, path: path === '/' ? '' : path, scheme, port };
  }

  /** Bounded dynamic programming, not a user-controlled backtracking regexp. */
  function glob(pattern: string, text: string, separator: string): boolean {
    let previous = new Uint8Array(text.length + 1), next = new Uint8Array(text.length + 1);
    previous[0] = 1;
    for (let index = 0; index < pattern.length; index++) {
      const char = pattern[index]!;
      const star = char === '*', deep = star && pattern[index + 1] === '*';
      if (deep) while (pattern[index + 1] === '*') index++;
      next[0] = star ? previous[0]! : 0;
      for (let offset = 1; offset <= text.length; offset++) {
        next[offset] = star
          ? Number(previous[offset] === 1 || (next[offset - 1] === 1 && (deep || text[offset - 1] !== separator)))
          : Number(previous[offset - 1] === 1 && char === text[offset - 1]);
      }
      const swap = previous; previous = next; next = swap;
    }
    return previous[text.length] === 1;
  }

  export function matches(pattern: Pattern | null | undefined, href: unknown): boolean {
    const url = toUrl(href);
    if (!url || !pattern || !['http:', 'https:'].includes(url.protocol)) return false;
    if (pattern.scheme && pattern.scheme !== url.protocol.slice(0, -1)) return false;
    if (pattern.port && pattern.port !== (url.port || (url.protocol === 'https:' ? '443' : '80'))) return false;
    const host = url.hostname.toLowerCase(), want = pattern.host;
    if (want.includes('*')) {
      if (!(want.startsWith('**.') && host === want.slice(3)) && !glob(want, host, '.')) return false;
    } else {
      const actual = stripWww(host);
      if (actual !== want && !actual.endsWith(`.${want}`)) return false;
    }
    if (!pattern.path) return true;
    const target = url.pathname + (pattern.path.includes('?') ? url.search : '') +
      (pattern.path.includes('#') ? url.hash : '');
    return glob(pattern.path, target, '/');
  }

  // Explicit scheme beats a longer host, a longer host beats a path prefix.
  export function score(pattern: Pattern | null | undefined): number {
    if (!pattern) return -1;
    const labels = stripWww(pattern.host).split('.').filter(label => label && !label.includes('*')).length;
    const pathLength = pattern.path.replace(/\*/g, '').length;
    return (pattern.scheme ? 1e8 : 0) + labels * 1e4 + pathLength +
      (pattern.host.includes('*') ? 0 : 1) + (pattern.port ? 100 : 0);
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
    return `${parsed.scheme ? parsed.scheme + '://' : ''}${parsed.host}${parsed.port ? ':' + parsed.port : ''}${parsed.path}`;
  }

  /** Preserve pre-v3 prefix rules when upgrading persisted preferences. */
  export function migrateLegacyPattern(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const text = raw.trim().replace(/^((?:https?:\/\/)?)\*\./i, '$1');
    const parsed = parse(text);
    if (!parsed) return null;
    const prefix = parsed.path.replace(/\*+$/, '');
    return canonical(`${parsed.scheme ? parsed.scheme + '://' : ''}${parsed.host}${parsed.port ? ':' + parsed.port : ''}${prefix ? prefix + '**' : ''}`);
  }
}

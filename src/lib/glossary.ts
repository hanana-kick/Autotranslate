// Pure terminology selection. Native prompt escaping belongs to the model host.
namespace AT.glossary {
  export type Entry = {
    id: string;
    conceptId: string;
    language: string;
    term: string;
    group: string;
    traits: string[];
    description: string;
  };
  export type Pair = { source: string; target: string };
  export type Match = Pair & { start: number; end: number };

  function language(value: string): string {
    const tag = value.toLowerCase().replace(/_/g, '-');
    if (/^zh-(hant|tw|hk|mo)(-|$)/.test(tag)) return 'zh-hant';
    if (tag === 'zh' || /^zh-(hans|cn|sg)(-|$)/.test(tag)) return 'zh-hans';
    return tag.split('-')[0] || '';
  }

  // Guard Latin words and numbers without requiring spaces in Japanese/Korean.
  const word = /[\p{Script=Latin}\p{N}_]/u;
  const katakana = /[\u30A0-\u30FF\u31F0-\u31FF]/u;
  const hiragana = /[\u3041-\u309F]/u;
  // Particles attach to the preceding word, so they may precede a katakana
  // term. Any other hiragana makes the term a fragment of that word:
  // みすみママ is one name, and 마마 alone would replace its head.
  const particle = new Set([...'はがをにでとへもやかねよのさ']);
  function bounded(text: string, start: number, term: string): boolean {
    const first = Array.from(term)[0] || '';
    const last = Array.from(term).at(-1) || '';
    const before = Array.from(text.slice(Math.max(0, start - 2), start)).at(-1) || '';
    const after = Array.from(text.slice(start + term.length, start + term.length + 2))[0] || '';
    return !(word.test(first) && word.test(before)) && !(word.test(last) && word.test(after))
      && !(katakana.test(first) && hiragana.test(before) && !particle.has(before));
  }

  /** The counterpart that keeps the source term's register. A term marked
   *  기본형 is the dictionary's canonical spelling. Otherwise the candidate
   *  whose traits match the source term's own register wins: a specialist
   *  source term pairs with the specialist counterpart, not with a plain
   *  description of the same concept. */
  function sameRegister(candidates: readonly string[], sourceTraits: readonly string[], byTerm: Map<string, string[]>): string | null {
    if (!sourceTraits.length) return null;
    const scored = candidates.map(term => {
      const traits = new Set(byTerm.get(term) ?? []);
      const shared = sourceTraits.filter(trait => traits.has(trait)).length;
      const exact = traits.size === sourceTraits.length && shared === sourceTraits.length;
      return { term, score: exact ? sourceTraits.length + 1 : shared };
    });
    const best = Math.max(...scored.map(entry => entry.score));
    if (best === 0) return null;
    const top = scored.filter(entry => entry.score === best);
    return top.length === 1 ? top[0]!.term : null;
  }

  /** One counterpart per concept: an explicit 기본형 mark, then the term the
   * source usage note names itself, then the candidate with the same register.
   * Remaining variants stay ambiguous. */
  function counterpart(candidates: Set<string>, canonical: Set<string>, note: string,
    sourceTraits: readonly string[], traitsByTerm: Map<string, string[]>): string | null {
    if (candidates.size === 1) return candidates.values().next().value ?? null;
    const marked = [...candidates].filter(term => canonical.has(term));
    if (marked.length === 1) return marked[0]!;
    const named = [...candidates].filter(term => note.includes(term));
    if (named.length === 1) return named[0]!;
    return sameRegister([...candidates], sourceTraits, traitsByTerm);
  }

  type Resolution = { target: string | null; note: string };
  type Compiled = {
    terms: Map<string, Map<string, Set<string>>>;
    identities: Map<string, Map<string, Set<string>>>;
    // A 기본형 mark belongs to one language's spelling. Collecting marks per
    // identity across languages made a Japanese name look canonical in Korean,
    // so its official Korean form lost to the identical spelling variant.
    canonical: Map<string, Map<string, Set<string>>>;
    notes: Map<string, Map<string, Map<string, string>>>;
    // Traits per identity and language, used to pick a counterpart when the
    // dictionary offers several and no mark or usage note singles one out.
    traits: Map<string, Map<string, Map<string, string[]>>>;
    resolved: Map<string, Map<string, Resolution>>;
  };

  // The dictionary is a frozen snapshot replaced wholesale on every sync, so
  // the array identity is a sound cache key. Compiling 1,900 rows costs ~5 ms;
  // without this cache it ran again for every fragment on the page.
  const cache = new WeakMap<readonly Entry[], Compiled>();

  function compile(entries: readonly Entry[]): Compiled {
    const compiled: Compiled = {
      terms: new Map(), identities: new Map(), canonical: new Map(), notes: new Map(),
      traits: new Map(), resolved: new Map()
    };
    for (const entry of entries) {
      if (!entry.term || !entry.conceptId || !entry.group) continue;
      const identity = JSON.stringify([entry.conceptId, entry.group]);
      const lang = language(entry.language);
      let byTerm = compiled.terms.get(lang);
      if (!byTerm) compiled.terms.set(lang, byTerm = new Map());
      let known = byTerm.get(entry.term);
      if (!known) byTerm.set(entry.term, known = new Set());
      known.add(identity);
      let byLanguage = compiled.identities.get(identity);
      if (!byLanguage) compiled.identities.set(identity, byLanguage = new Map());
      let terms = byLanguage.get(lang);
      if (!terms) byLanguage.set(lang, terms = new Set());
      terms.add(entry.term);
      if ((entry.traits ?? []).includes('기본형')) {
        let canonicalByLanguage = compiled.canonical.get(identity);
        if (!canonicalByLanguage) compiled.canonical.set(identity, canonicalByLanguage = new Map());
        let marked = canonicalByLanguage.get(lang);
        if (!marked) canonicalByLanguage.set(lang, marked = new Set());
        marked.add(entry.term);
      }
      const description = entry.description ?? '';
      if (description) {
        let notesByLanguage = compiled.notes.get(identity);
        if (!notesByLanguage) compiled.notes.set(identity, notesByLanguage = new Map());
        let notesByTerm = notesByLanguage.get(lang);
        if (!notesByTerm) notesByLanguage.set(lang, notesByTerm = new Map());
        notesByTerm.set(entry.term, description);
      }
      let traitsByLanguage = compiled.traits.get(identity);
      if (!traitsByLanguage) compiled.traits.set(identity, traitsByLanguage = new Map());
      let traitsByTerm = traitsByLanguage.get(lang);
      if (!traitsByTerm) traitsByLanguage.set(lang, traitsByTerm = new Map());
      traitsByTerm.set(entry.term, [...(entry.traits ?? [])]);
    }
    return compiled;
  }

  function compiled(entries: readonly Entry[]): Compiled {
    let value = cache.get(entries);
    if (!value) cache.set(entries, value = compile(entries));
    return value;
  }

  /** Term -> resolved counterpart for one language pair, resolved once. */
  function resolutions(entries: readonly Entry[], from: string, to: string): Map<string, Resolution> {
    const index = compiled(entries);
    const key = from + '>' + to;
    let map = index.resolved.get(key);
    if (map) return map;
    map = new Map();
    for (const [term, identities] of index.terms.get(from) ?? []) {
      const identity = identities.size === 1 ? identities.values().next().value : undefined;
      if (identity === undefined) {
        map.set(term, { target: null, note: '' });
        continue;
      }
      const note = index.notes.get(identity)?.get(from)?.get(term) ?? '';
      const candidates = index.identities.get(identity)?.get(to);
      const sourceTraits = index.traits.get(identity)?.get(from)?.get(term) ?? [];
      const targetTraits = index.traits.get(identity)?.get(to);
      const target = candidates?.size
        ? counterpart(candidates, index.canonical.get(identity)?.get(to) ?? new Set(), note,
          sourceTraits, targetTraits ?? new Map())
        : null;
      map.set(term, { target, note });
    }
    index.resolved.set(key, map);
    return map;
  }

  function scan(entries: readonly Entry[], text: string, source: string | null, target: string): Match[] {
    if (!source || !text || !target) return [];
    if (entries.length > 100000 || text.length > 1000000) throw new Error('Glossary selection limit exceeded');
    const from = language(source), to = language(target);
    if (!from || !to || from === 'auto' || from === 'und' || from === 'unknown') return [];
    const spans: { start: number; end: number; source: string; target: string | null; note: string }[] = [];
    for (const [term, resolution] of resolutions(entries, from, to)) {
      for (let start = text.indexOf(term); start !== -1; start = text.indexOf(term, start + 1)) {
        if (!bounded(text, start, term)) continue;
        if (spans.length === 100000) throw new Error('Glossary match limit exceeded');
        spans.push({ start, end: start + term.length, source: term, target: resolution.target, note: resolution.note });
      }
    }
    // Select longest spans first, with stable text-position/lexical tie breaks.
    spans.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start || (a.source < b.source ? -1 : 1));
    const selected: typeof spans = [];
    for (const span of spans) {
      if (selected.some(other => span.start < other.end && other.start < span.end)) continue;
      selected.push(span);
    }
    selected.sort((a, b) => a.start - b.start);
    const seen = new Set<string>();
    const matches: Match[] = [];
    for (const span of selected) {
      if (span.target === null) continue;
      const key = JSON.stringify([span.source, span.target]);
      seen.add(key);
      if (seen.size > 256) throw new Error('Glossary prompt pair limit exceeded');
      matches.push({ source: span.source, target: span.target, start: span.start, end: span.end });
    }
    return matches;
  }

  /** Exact, case-preserving matched terms; never translate unknown text ourselves. */
  export function selectSpans(entries: readonly Entry[], text: string, source: string | null, target: string): Match[] {
    return scan(entries, text, source, target);
  }

  export function select(entries: readonly Entry[], text: string, source: string | null, target: string): Pair[] {
    const seen = new Set<string>();
    const pairs: Pair[] = [];
    for (const match of selectSpans(entries, text, source, target)) {
      const key = JSON.stringify([match.source, match.target]);
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ source: match.source, target: match.target });
    }
    return pairs;
  }

}

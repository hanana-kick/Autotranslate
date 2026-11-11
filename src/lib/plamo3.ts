// PLaMo 3 Translate's language vocabulary and its PFML3 prompt frame. The model
// is asked for a translation by naming the task, the languages and the style in
// special-token elements, so what is built here is the contract with the
// runtime: `Plamo3Lang` is the only spelling a prompt may carry, and every
// string that comes off a page is scrubbed of the token markers that would
// otherwise let page text close an element and write the rest of the prompt.
//
// The element order, the language codes and the GGUF workaround below are taken
// from the model card (`pfnet/plamo-3-translate-0.8b` and its GGUF twin) and the
// `chat_template.jinja` shipped with it, which the builders here reproduce byte
// for byte. Re-check all of them when the card is revised.
//
// Load after lib/constants.js.
namespace AT.plamo3 {

  /** The five languages the prompt builders accept, each spelled the way the
   *  model's own `check_lang` accepts it. `native` is what the language is
   *  called in its own script - nothing renders it: every picker builds its
   *  list from `C.LANGS`, which offers en, ko and ja. The card trains on 53
   *  languages; a language outside this table cannot reach a prompt at all. */
  export const LANGS = {
    en: { native: 'English', name: 'English' },
    ja: { native: '日本語', name: 'Japanese' },
    ko: { native: '한국어', name: 'Korean' },
    'zh-hans': { native: '简体中文', name: 'Simplified Chinese' },
    'zh-hant': { native: '繁體中文', name: 'Traditional Chinese' }
  } as const;

  /** Every language the prompt builders accept, so a prompt cannot carry a
   *  spelling the model was never asked with. */
  export type Plamo3Lang = keyof typeof LANGS;

  /** The one code `check_lang` admits that is not a language tag: the easy-Japanese
   *  register. Callers that opt into it pass this literal to `langFor`, which
   *  answers `ja` — the prompt names plain Japanese and the model writes the
   *  simplified register because that is what it was tuned to do. */
  export const EASY_JA = 'ja(easy)';

  /** Our UI codes the model spells differently. The model has no `zh-CN`:
   *  simplified Chinese is `zh-hans` and traditional is `zh-hant`, both in lower
   *  case, because `check_lang` refuses any capital in a language code. */
  const ALIASES: Record<string, Plamo3Lang | undefined> = {
    'zh-CN': 'zh-hans',
    'zh-Hans': 'zh-hans',
    'zh-TW': 'zh-hant',
    'zh-Hant': 'zh-hant'
  };

  export function isPlamo3Lang(code: unknown): code is Plamo3Lang {
    return typeof code === 'string' && Object.hasOwn(LANGS, code);
  }

  /** A configured language code, or null when the model cannot express it.
   *  Underscores are folded first: the settings store may hold `zh_CN`. Nothing
   *  is lower-cased, because `ZH` is not a code anyone configured — `zh-Hans` is,
   *  and only the spellings above are admitted either way. */
  export function langFor(code: string | null | undefined): Plamo3Lang | null {
    if (typeof code !== 'string' || !code) return null;
    if (code === EASY_JA) return 'ja';
    const spelled = code.replace(/_/g, '-');
    const alias = Object.hasOwn(ALIASES, spelled) ? ALIASES[spelled] : undefined;
    if (alias) return alias;
    return isPlamo3Lang(spelled) ? spelled : null;
  }

  /** A source term and the translation the page must use for it. */
  export type Glossary = { source: string; target: string }[];

  export type PromptOptions = {
    target: Plamo3Lang;
    source?: Plamo3Lang | null | undefined;
    context?: string | null | undefined;
    glossary?: Glossary | null | undefined;
    form?: 'plain' | 'polite' | null | undefined;
    history?: { source: string; target: string }[] | null | undefined;
  };

  // The PFML3 element markers, as the card spells them.
  const TAG = '<|plamo:tag|>';
  const MSG = '<|plamo:msg|>';
  const KEY = '<|plamo:key|>';
  const VAL = '<|plamo:val|>';
  const INDEX = '<|plamo:index|>';
  const ITEM = '<|plamo:item|>';

  /** The element the card requires first, always naming the same task. */
  const DATASET = 'translation';
  const LANG_KEY = `${KEY}lang${VAL}`;
  const FORM_KEY = `${KEY}form${VAL}`;

  /**
   * The PFML3 prompt for one translation, on a single line: the card's
   * `chat_template.jinja` element for element — `dataset`, then `context`, then
   * the previous `input`/`output` pairs in document order, then `glossary`, then
   * the current `input` and an `output` element with an empty body for the model
   * to fill.
   *
   * Three rules the card's template enforces by raising, and this function
   * therefore encodes: `source_lang` is optional and its key is left out of both
   * the history `input` elements and the current one when it is missing; `form`
   * exists only for a Japanese target and applies to the current translation
   * alone, so it is dropped for every other target and never written into a
   * history entry; and no user-supplied text may carry a PFML token, which here
   * means it is sanitised rather than rejected, because it came off a page.
   *
   * `<|plamo:bos|>` is deliberately absent: the card says llama.cpp adds the
   * beginning-of-sequence token itself, and a handwritten prompt must not open
   * with it.
   */
  export function buildPrompt(text: string, o: PromptOptions): string {
    const source = o.source ?? null;
    const sourceKey = source === null ? '' : `${LANG_KEY}${source}`;
    const parts: string[] = [`${TAG}dataset${MSG}${DATASET}`];

    const context = o.context ?? null;
    if (context) parts.push(`${TAG}context${MSG}${sanitize(context)}`);

    for (const pair of o.history ?? []) {
      parts.push(`${TAG}input${sourceKey}${MSG}${sanitize(pair.source)}`);
      parts.push(`${TAG}output${LANG_KEY}${o.target}${MSG}${sanitize(pair.target)}`);
    }

    const glossary = o.glossary ?? [];
    if (glossary.length) {
      const terms: string[] = [];
      for (const term of glossary) {
        terms.push(`${INDEX}${sanitize(term.source)}${ITEM}${sanitize(term.target)}`);
      }
      parts.push(`${TAG}glossary${terms.join('')}`);
    }

    parts.push(`${TAG}input${sourceKey}${MSG}${sanitize(text)}`);
    // `form` is a Japanese-style option; the template raises for any other
    // target, so a stray setting is dropped instead of poisoning the prompt.
    const form = o.target === 'ja' ? o.form ?? null : null;
    const formKey = form === null ? '' : `${FORM_KEY}${form}`;
    parts.push(`${TAG}output${LANG_KEY}${o.target}${formKey}${MSG}`);

    return parts.join('');
  }

  /** The prefix every PFML3 token shares. The card's template refuses any input
   *  that contains it, because it would open an element of its own. */
  export const RESERVED = '<|plamo:';

  /** One complete PFML3 token: `<|plamo:` up to the first closing `|>`. A token
   *  is what carries an element boundary, so it is what has to go. */
  const TOKEN = /<\|plamo:[^|>]*\|>/g;

  /**
   * Make page text safe to put inside a PFML3 element by deleting every token it
   * carries: first the complete `<|plamo:...|>` tokens, then any leftover
   * `<|plamo:` prefix, which on its own could still be closed by a `|>` the model
   * produces. Deleting rather than escaping is what the card implies — the
   * template raises on such text, and a translation extension cannot refuse a
   * page node. Stripping one token can splice a new one together, so the two
   * passes repeat until nothing reserved survives.
   */
  export function sanitize(text: string): string {
    let cleaned = text.replace(TOKEN, '');
    while (cleaned.includes(RESERVED)) cleaned = cleaned.replace(TOKEN, '').replace(RESERVED, '');
    return cleaned;
  }

  // ---------------------------------------------------------------------------
  // Script guard
  // ---------------------------------------------------------------------------

  type Script = 'han' | 'kana' | 'hangul' | 'latin';

  /** The scripts that can be evidence against a reply. Each range is a script,
   *  not a language: Han serves Japanese and Chinese alike, kana only Japanese,
   *  Hangul only Korean. Punctuation is deliberately outside every range - the
   *  CJK full stops and commas are shared by all of them and prove nothing.
   *
   *  Latin has no row here on purpose. Letters of it are legitimate in every
   *  language on this list - a URL, a version number, `SAVE10`, a name - so its
   *  presence in an answer can never be the evidence that the answer is wrong.
   *  `NATIVE` still names it, because English is written with it. */
  const SCRIPTS: { script: Script; pattern: RegExp }[] = [
    { script: 'han', pattern: /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/ },
    { script: 'kana', pattern: /[\u3040-\u309F\u30A0-\u30FF\uFF66-\uFF9F]/ },
    { script: 'hangul', pattern: /[\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uAC00-\uD7AF]/ }
  ];

  /** What each language is written with. */
  const NATIVE: Record<Plamo3Lang, readonly Script[]> = {
    en: ['latin'],
    ja: ['han', 'kana'],
    ko: ['hangul'],
    'zh-hans': ['han'],
    'zh-hant': ['han']
  };

  /**
   * Whether a reply is written in a script the target language can appear in.
   *
   * A small model sometimes answers a translation request by handing the source
   * back: a Japanese target answered in Hangul, or a Korean target that stayed in
   * Kanji. Both read as broken translation to the reader, and the runtime cannot
   * tell them from a real answer by length alone. A script the target never
   * writes is the evidence; Latin is always tolerated, because numbers, URLs and
   * product names come back that way in every language, and text with no script
   * at all — empty, digits, punctuation — is answered `true` so that a caller
   * asking "does this need translating" is not told that `12,500` is a failure.
   *
   * The one answer this rejects that a reader might have accepted is a Korean
   * sentence that keeps a Japanese proper noun in Han: the page keeps its own
   * text and asks again, which costs a generation and loses nothing.
   */
  export function checkScript(text: string, target: Plamo3Lang): boolean {
    const native = NATIVE[target];
    for (const { script, pattern } of SCRIPTS) {
      if (native.includes(script)) continue;
      if (pattern.test(text)) return false;
    }
    return true;
  }
}

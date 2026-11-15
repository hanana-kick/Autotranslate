// PLaMo 3 language vocabulary and protection against injected PFML controls.
// Prompts are rendered only by the installed model tokenizer's chat template.
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

}

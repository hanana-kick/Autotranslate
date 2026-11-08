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
  const BOS = '<|plamo:bos|>';

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

  /** The tokens the model emits when the translation is over. The card passes
   *  exactly these to its runtime as stop sequences. */
  export const STOP_TOKENS: readonly string[] = [TAG, BOS];

  /** The chat template the runtime is loaded with. PLaMo is asked through the
   *  completions API with the PFML3 prompt built above, so nothing may render a
   *  prompt through the jinja the converted file carries: the runtime's template
   *  engine cannot compile it (`Unable to generate parser for this template`),
   *  and what is built here is exactly what the model has to receive. */
  export const PASS_THROUGH_TEMPLATE = '{{ prompt }}';

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

  /** Whether text still names a PFML3 token — the card's own refusal condition. */
  export function containsReserved(text: string): boolean {
    return typeof text === 'string' && text.includes(RESERVED);
  }

  // ---------------------------------------------------------------------------
  // GGUF metadata
  // ---------------------------------------------------------------------------

  const GGUF_MAGIC = 'GGUF';
  const GGUF_MAGIC_BYTES = new TextEncoder().encode(GGUF_MAGIC);
  const GGUF_UINT8 = 0;
  const GGUF_INT8 = 1;
  const GGUF_UINT16 = 2;
  const GGUF_INT16 = 3;
  const GGUF_UINT32 = 4;
  const GGUF_INT32 = 5;
  const GGUF_FLOAT32 = 6;
  const GGUF_BOOL = 7;
  const GGUF_STRING = 8;
  const GGUF_ARRAY = 9;
  const GGUF_UINT64 = 10;
  const GGUF_INT64 = 11;
  const GGUF_FLOAT64 = 12;
  const GGUF_MAP = 13;

  const TOKENIZER_MODEL = 'tokenizer.ggml.model';
  const PLAMO = 'plamo3';
  const PLAMO2 = 'plamo2';
  const PLAMO_BYTES = new TextEncoder().encode(PLAMO);
  const PLAMO2_BYTES = new TextEncoder().encode(PLAMO2);
  const decoder = new TextDecoder('utf-8', { fatal: true });

  /** Byte-for-byte equality. The few places that match a fixed word against the
   *  file compare bytes: decoding first would let a decoder's own complaint about
   *  malformed UTF-8 stand in for the message that says what is wrong with the
   *  file, and a corrupt header is exactly the case this has to describe. */
  function same(found: Uint8Array, expected: Uint8Array): boolean {
    return found.byteLength === expected.byteLength && found.every((one, index) => one === expected[index]);
  }

  /** One GGUF metadata value, kept in the shape the file stores it. */
  type GgufValue = number | bigint | boolean | string | GgufValue[];

  /** A read position inside one GGUF buffer. Every read is bounds-checked
   *  against the view, so a truncated or forged file raises before it can hand
   *  back half a value. */
  type Cursor = {
    readonly bytes: Uint8Array;
    readonly view: DataView;
    offset: number;
  };

  function need(at: Cursor, size: number): void {
    if (size > at.view.byteLength - at.offset) {
      throw new TypeError('plamo3: GGUF metadata is truncated');
    }
  }

  /** The next `size` bytes as they lie in the buffer, advancing over them. */
  function take(at: Cursor, size: number): Uint8Array {
    need(at, size);
    const slice = at.bytes.subarray(at.offset, at.offset + size);
    at.offset += size;
    return slice;
  }

  function byte(at: Cursor, signed: boolean): number {
    need(at, 1);
    const value = signed ? at.view.getInt8(at.offset) : at.view.getUint8(at.offset);
    at.offset += 1;
    return value;
  }

  function u16(at: Cursor, signed: boolean): number {
    need(at, 2);
    const value = signed ? at.view.getInt16(at.offset, true) : at.view.getUint16(at.offset, true);
    at.offset += 2;
    return value;
  }

  function u32(at: Cursor, signed: boolean): number {
    need(at, 4);
    const value = signed ? at.view.getInt32(at.offset, true) : at.view.getUint32(at.offset, true);
    at.offset += 4;
    return value;
  }

  function f32(at: Cursor): number {
    need(at, 4);
    const value = at.view.getFloat32(at.offset, true);
    at.offset += 4;
    return value;
  }

  function u64(at: Cursor, signed: boolean): bigint {
    need(at, 8);
    const value = signed ? at.view.getBigInt64(at.offset, true) : at.view.getBigUint64(at.offset, true);
    at.offset += 8;
    return value;
  }

  function f64(at: Cursor): number {
    need(at, 8);
    const value = at.view.getFloat64(at.offset, true);
    at.offset += 8;
    return value;
  }

  /** A stored string: an 8-byte length and that many UTF-8 bytes. Decoding is
   *  fatal, so a value that is not UTF-8 raises instead of arriving as
   *  replacement text a comparison would then have to distrust. */
  function string(at: Cursor): string {
    return decoder.decode(take(at, Number(u64(at, false))));
  }

  function readValue(at: Cursor, type: number): GgufValue {
    switch (type) {
      case GGUF_UINT8:
        return byte(at, false);
      case GGUF_INT8:
        return byte(at, true);
      case GGUF_UINT16:
        return u16(at, false);
      case GGUF_INT16:
        return u16(at, true);
      case GGUF_UINT32:
        return u32(at, false);
      case GGUF_INT32:
        return u32(at, true);
      case GGUF_FLOAT32:
        return f32(at);
      case GGUF_BOOL:
        return byte(at, false) !== 0;
      case GGUF_STRING:
        return string(at);
      case GGUF_ARRAY: {
        const itemType = u32(at, false);
        const items: GgufValue[] = [];
        const count = Number(u64(at, false));
        for (let index = 0; index < count; index += 1) items.push(readValue(at, itemType));
        return items;
      }
      case GGUF_UINT64:
        return u64(at, false);
      case GGUF_INT64:
        return u64(at, true);
      case GGUF_FLOAT64:
        return f64(at);
      case GGUF_MAP:
        // No GGUF writer in circulation emits a map and no runtime reads one, so
        // the walker refuses it rather than guessing at an encoding nothing
        // exercises: a file that really carried one could not load anyway, and a
        // wrong guess here would silently misread every key after it.
        throw new TypeError('plamo3: GGUF map metadata is not supported');
      default:
        throw new TypeError(`plamo3: unknown GGUF metadata type ${type}`);
    }
  }

  /** Walk `count` key/type/value triples, handing each key, its type, its
   *  parsed value and the offset that value starts at to `visit`. The value is
   *  read even where the caller only wants its position: parsing an array of
   *  107,520 vocabulary entries is what lands the cursor on the next key. */
  function walkKVPairs(
    at: Cursor,
    count: number,
    visit: (key: string, type: number, value: GgufValue, valueOffset: number) => void
  ): void {
    for (let index = 0; index < count; index += 1) {
      const key = string(at);
      const type = u32(at, false);
      const valueOffset = at.offset;
      const value = readValue(at, type);
      visit(key, type, value, valueOffset);
    }
  }

  /** Overwrite bytes where they stand. The caller has proved the replacement is
   *  exactly as long as what it replaces, so nothing after them shifts. */
  function overwrite(at: Cursor, offset: number, value: Uint8Array): void {
    for (let index = 0; index < value.length; index += 1) {
      at.view.setUint8(offset + index, value[index] as number);
    }
  }

  /**
   * Retag the tokenizer of a PLaMo 3 GGUF so the vendored runtime can load it.
   *
   * wllama 3.8.1 carries the plamo3 *architecture* — the layers, the attention
   * and the rope table all load — but no `llm_tokenizer_plamo3`, so the file
   * stops at `llama_model_load: error loading model vocabulary: unknown
   * tokenizer: 'plamo3'` before a single token is read. `plamo2` is implemented,
   * and PLaMo 3's vocabulary is the same BPE with the same special-token
   * spellings: every translation checked through the patched file came back
   * byte-identical to the same file read by a runtime that does know plamo3.
   *
   * The rewrite is therefore one value of one key. The walker pairs each value
   * with the key that owns it, so `general.architecture` and the
   * `plamo3.output_weight` tensor names keep their spelling while
   * `tokenizer.ggml.model` becomes `plamo2`. The two tags are the same length,
   * so the six bytes are written where they stand: the buffer is never resized,
   * never shifted and never copied, which matters at 1.78 GB.
   *
   * `patched: false` and an untouched buffer when the file already says `plamo2`
   * or never names a tokenizer; a TypeError when it is not a GGUF file or is too
   * short to hold the metadata it promises.
   */
  export function patchTokenizerTag(bytes: Uint8Array): { bytes: Uint8Array; patched: boolean } {
    const at: Cursor = {
      bytes,
      view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      offset: 0
    };
    if (!same(take(at, GGUF_MAGIC_BYTES.length), GGUF_MAGIC_BYTES)) {
      throw new TypeError('plamo3: not a GGUF file');
    }
    u32(at, false); // version: every GGUF version stores the KV section the same way
    u64(at, false); // n_tensors: the tensor infos sit past the KV section, unread here
    const pairs = Number(u64(at, false));

    let patched = false;
    walkKVPairs(at, pairs, (key, type, value, valueOffset) => {
      if (key !== TOKENIZER_MODEL || type !== GGUF_STRING || value !== PLAMO) return;
      // A stored string is its length and then its bytes, and `valueOffset` is
      // where the value began: the length. The tag itself starts eight bytes
      // past it. Written at the length instead, the file would still name the
      // tokenizer plamo3 and its string length would be garbage - so this reads
      // back what it is about to overwrite before overwriting it.
      const bytesAt = valueOffset + 8;
      if (!same(at.bytes.subarray(bytesAt, bytesAt + PLAMO_BYTES.length), PLAMO_BYTES)) {
        throw new TypeError('plamo3: the tokenizer tag is not where its key said it would be');
      }
      overwrite(at, bytesAt, PLAMO2_BYTES);
      patched = true;
    });
    return { bytes, patched };
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

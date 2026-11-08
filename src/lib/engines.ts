// The translation call. One implementation, on-device: the extension has no
// provider, so there is nothing to fetch, no key to keep and no endpoint to
// validate. The engine is the installed file - PLaMo 3 Translate is the card
// the extension offers, and a file the user imports answers as itself. Runs in
// the background context, which owns the offscreen host.
// Load after lib/constants.js, lib/browser.js.
namespace AT.engines {
  const C = AT.C;

  export const TEST_SENTENCE = 'The extension is configured correctly.';

  // Only the codes the on-device path can produce: a model that cannot load is
  // `config`, a model that cannot answer is `provider`, a generation that ran
  // out of budget is `timeout`, an answer that cannot be used is `format`.
  export type EngineErrorCode = 'config' | 'timeout' | 'provider' | 'format';

  /** Why a well-answered request still could not be used. */
  export type EngineErrorReason = 'count';

  export type EngineErrorExtra = {
    /** The host's own reason code (`no-model`, `no-webgpu`, …), for the UI. */
    detail?: string;
    reason?: EngineErrorReason;
    expected?: number;
    got?: number;
  };

  export interface EngineError extends Error {
    code: EngineErrorCode;
    detail?: string;
    reason?: EngineErrorReason;
    expected?: number;
    got?: number;
  }

  /** The `new`-callable view of the constructor below. */
  export interface EngineErrorConstructor {
    new (code: EngineErrorCode, message: string, extra?: EngineErrorExtra): EngineError;
    prototype: EngineError;
  }

  // Hand-written ES5 constructor, not a class: downlevelling the `extends`
  // would leave instances failing `instanceof EngineError` and losing the own
  // fields the tests read. The object is made from EngineError.prototype so the
  // instanceof chain survives either way.
  export const EngineError: EngineErrorConstructor = function (
    code: EngineErrorCode,
    message: string,
    extra: EngineErrorExtra = {}
  ): EngineError {
    const base = new Error(message);
    const error = Object.create(EngineError.prototype) as EngineError;
    error.name = 'EngineError';
    error.message = base.message;
    if (base.stack !== undefined) error.stack = base.stack;
    error.code = code;
    if (extra.detail !== undefined) error.detail = extra.detail;
    if (extra.reason !== undefined) error.reason = extra.reason;
    if (extra.expected !== undefined) error.expected = extra.expected;
    if (extra.got !== undefined) error.got = extra.got;
    return error;
  } as unknown as EngineErrorConstructor;

  EngineError.prototype = Object.create(Error.prototype);
  EngineError.prototype.constructor = EngineError;

  const snippet = (text: unknown, max = 180) =>
    typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, max) : '';

  // The host reports `AT.local.codeForReason()`; anything else that arrives
  // over the channel is treated as a runtime failure, not a configuration one.
  const LOCAL_CODES: Record<string, EngineErrorCode | undefined> = {
    config: 'config',
    timeout: 'timeout',
    provider: 'provider'
  };

  /**
   * What the page could not tell us: which language the text is really in.
   * `auto` asks the browser's own detector (CLD behind `i18n.detectLanguage`);
   * an explicit setting is reported back as it stands. No prompt ever names the
   * answer — the model's instruction names only the target, and a wrong
   * language claim moves the translation — so this feeds nothing but the
   * popup's "detected" line, and it stays silent about a language the model
   * could not handle in any case.
   */
  async function resolveSource(setting: string | undefined, texts: string[]): Promise<string | null> {
    if (setting && setting !== 'auto') return C.isSupportedLang(setting) ? setting : null;
    const answer = await AT.detectLanguage(texts.join(' ').slice(0, 400));
    if (!answer || !C.isSupportedLang(answer.code)) return null;
    return answer.code;
  }

  export function needsTranslation(text: unknown): boolean {
    return typeof text === 'string' && text.trim().length > 1 && /[\p{L}\p{N}]/u.test(text);
  }

  export type TranslateRequest = {
    /** What kind of page the texts came from, if the caller knows. */
    context?: AT.pagecontext.PageContext | null;
    /** Which part of the page these texts came from. */
    role?: AT.targets.TextRole | null;
    texts?: unknown[];
    /** 'auto' or a C.LANGS code */
    source?: string;
    target?: string;
    /** model id; empty means nothing is selected and the call is a config error */
    localModelId?: string;
    localMaxTokens?: number;
  };

  export type TranslateResult = {
    translations: string[];
    detected: string | null;
    requested: number;
  };

  export type TestResult = {
    output: string | undefined;
    detected: string | null;
    ms: number;
  };

  /**
   * One generation per chunk. The model is the only engine, so a chunk is a
   * prompt: nothing to retry, because a repeat would spend another minute on
   * the same model for the same answer.
   */
  async function translateChunk(
    args: TranslateRequest & {
      texts: string[];
      target: string;
      localModelId: string;
      localMaxTokens: number;
      detected: string | null;
    }
  ): Promise<{ translations: string[] }> {
    // The code the settings page offers has to become the code the model was
    // released with: PLaMo spells Chinese `zh-hans` and `zh-hant` and carries
    // five of the 53 its card lists. A null here is a language the weights never
    // learned, which no retry answers.
    const target = AT.plamo3.langFor(args.target);
    if (!target) {
      throw new EngineError('config', `the on-device model does not translate into ${args.target || 'that language'}`, {
        detail: 'no-target'
      });
    }
    const reply = await AT.local.callHost({
      type: C.MSG.LOCAL_TRANSLATE,
      modelId: args.localModelId,
      texts: args.texts,
      target,
      maxTokens: args.localMaxTokens,
      // Rendered once, here: the host only has to paste bounded lines. The page
      // says what the site is; the region says what this batch is (a menu, a
      // comment), which is what decides register. The budget is fixed in
      // `AT.targets.composeContext`: above it, the line is cut, not grown.
      context: AT.targets.composeContext(
        AT.pagecontext.hint(args.context ?? null),
        AT.targets.roleHint(args.role ?? null)
      )
    });
    if (!reply?.ok) {
      const code = LOCAL_CODES[String(reply?.code)] ?? 'provider';
      throw new EngineError(code, String(reply?.error ?? 'the on-device host did not answer'), {
        detail: snippet(reply?.error ?? '')
      });
    }
    const translations = Array.isArray(reply.translations)
      ? reply.translations.map((text) => (typeof text === 'string' ? text : ''))
      : null;
    if (!translations || translations.length !== args.texts.length) {
      throw new EngineError('format', 'the on-device host returned an unexpected result count', {
        reason: 'count',
        expected: args.texts.length,
        got: translations?.length ?? 0
      });
    }
    return { translations };
  }

  export async function translate(request: TranslateRequest = {}): Promise<TranslateResult> {
    const { texts = [], target, localModelId = '', localMaxTokens = AT.local.DEFAULT_MAX_TOKENS } = request;
    if (!Array.isArray(texts)) throw new EngineError('config', 'texts must be an array');
    if (typeof target !== 'string' || !C.isSupportedLang(target)) {
      throw new EngineError('config', `unsupported target language: ${target}`);
    }
    if (!localModelId) throw new EngineError('config', 'no on-device model is selected', { detail: 'no-model' });
    if (texts.length === 0) return { translations: [], detected: null, requested: 0 };

    const originals = texts.map((text) => (typeof text === 'string' ? text : ''));
    const pending = originals.filter((text) => needsTranslation(text));
    const unique = [...new Set(pending)];
    if (unique.length === 0) return { translations: originals, detected: null, requested: 0 };

    // The packer works in tokens, on the characters-per-token ratios measured
    // against this model's own tokenizer. Every generation reports its real
    // prompt cost back (`AT.local.setCalibration`), so the packing tightens as
    // the page runs instead of trusting one published average.
    const chunks = AT.local.chunkByTokens(unique, localMaxTokens);

    // One detection for the whole request: the detector is a browser call, not
    // part of the model's instruction, and the answer cannot differ per chunk.
    const detected = await resolveSource(request.source, unique);
    const batchOut = new Map<string, string>();
    for (const chunk of chunks) {
      const result = await translateChunk({
        ...request,
        texts: chunk,
        target,
        localModelId,
        localMaxTokens,
        detected
      });
      chunk.forEach((text, index) => batchOut.set(text, result.translations[index] ?? ''));
    }

    const translations = originals.map((text) => {
      if (!needsTranslation(text)) return text;
      const translated = batchOut.get(text);
      // The answer goes through blank included. "No answer" is what tells the
      // page to ask again; a source substituted here would be recorded as a
      // translation, and the node would keep its own language forever.
      return typeof translated === 'string' ? translated : text;
    });
    return { translations, detected, requested: unique.length };
  }

  export async function test(request: TranslateRequest = {}): Promise<TestResult> {
    const started = Date.now();
    const result = await translate({ ...request, texts: [TEST_SENTENCE] });
    return { output: result.translations[0], detected: result.detected, ms: Date.now() - started };
  }
}

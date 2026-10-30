// The translation call. One implementation, on-device TranslateGemma: the
// extension has no provider, so there is nothing to fetch, no key to keep and
// no endpoint to validate. Runs in the background context, which owns the
// offscreen host.
// Load after lib/constants.js, lib/browser.js.
namespace AT.engines {
  const C = AT.C;

  export const TEST_SENTENCE = 'The extension is configured correctly.';

  export type EngineErrorCode =
    | 'config'
    | 'network'
    | 'timeout'
    | 'rate-limit'
    | 'provider'
    | 'http'
    | 'format';

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

  const LOCAL_CODES: Record<string, EngineErrorCode | undefined> = {
    config: 'config',
    network: 'network',
    timeout: 'timeout',
    'rate-limit': 'rate-limit',
    provider: 'provider',
    http: 'http',
    format: 'format'
  };

  /**
   * The source language the model should be told about. An explicit setting
   * wins; `auto` asks the browser's own detector (CLD behind
   * `i18n.detectLanguage`), which is what the page cannot tell us. A detector
   * answer with no code in the model's table leaves the source unknown, and the
   * host then asks for the target without claiming one.
   */
  async function resolveSource(
    setting: string | undefined,
    texts: string[]
  ): Promise<{ lang: AT.gemma.GemmaLang | null; detected: string | null }> {
    if (setting && setting !== 'auto') return { lang: AT.gemma.langFor(setting), detected: null };
    const sample = texts.join(' ').slice(0, 400);
    const answer = await AT.detectLanguage(sample);
    if (!answer) return { lang: null, detected: null };
    return {
      lang: AT.gemma.langForDetected(answer.code),
      detected: C.isSupportedLang(answer.code) ? answer.code : null
    };
  }

  export function needsTranslation(text: unknown): boolean {
    return typeof text === 'string' && text.trim().length > 1 && /[\p{L}\p{N}]/u.test(text);
  }

  export type TranslateRequest = {
    /** What kind of page the texts came from, if the caller knows. */
    context?: AT.pagecontext.PageContext | null;
    /** Which part of the page these texts came from. */
    role?: AT.targets.TextRole | null;
    /** The surrounding block, when the texts are sentences of one. */
    hint?: string | undefined;
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
   * prompt: nothing to retry, because a repeat would spend another minute on the
   * same 4B model for the same answer.
   */
  async function translateChunk(
    args: TranslateRequest & { texts: string[]; target: string; localModelId: string; localMaxTokens: number }
  ): Promise<{ translations: string[]; detected: string | null }> {
    const target = AT.gemma.langFor(args.target);
    if (!target) {
      throw new EngineError('config', `the on-device model does not translate into ${args.target || 'that language'}`, {
        detail: 'no-target'
      });
    }
    const { lang: source, detected } = await resolveSource(args.source, args.texts);
    const reply = await AT.local.callHost({
      type: C.MSG.LOCAL_TRANSLATE,
      modelId: args.localModelId,
      texts: args.texts,
      source: source ?? '',
      target,
      maxTokens: args.localMaxTokens,
      // Rendered once, here: the host only has to paste bounded lines. The page
      // says what the site is; the region says what this batch is (a menu, a
      // comment), which is what decides register. The budget is fixed in
      // `AT.targets.composeContext`: above it, the line is cut, not grown.
      // The page/role line stays one line; the block a sentence came from is
      // its own instruction line in the prompt.
      context: AT.targets.composeContext(
        AT.pagecontext.hint(args.context ?? null),
        AT.targets.roleHint(args.role ?? null)
      ),
      hint: args.hint ?? ''
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
    return { translations, detected };
  }

  export async function translate(request: TranslateRequest = {}): Promise<TranslateResult> {
    const { texts = [], source = 'auto', target, localModelId = '', localMaxTokens = AT.local.DEFAULT_MAX_TOKENS } = request;
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

    /**
     * The model is sized by tokens, so the packing asks the host — which owns
     * the tokenizer — how many tokens each text is, rather than dividing
     * characters by a constant. The estimate is only the fallback for a host
     * that cannot answer (an older document, a failed load).
     */
    const counted = await AT.local.callHost({
      type: C.MSG.LOCAL_COUNT,
      modelId: localModelId,
      maxTokens: localMaxTokens,
      texts: unique,
      source: AT.gemma.isLang(source) ? source : '',
      target: AT.gemma.isLang(target) ? target : '',
      context: AT.pagecontext.hint(request.context ?? null) ?? ''
    });
    const counts = Array.isArray(counted?.counts) ? counted.counts.map((value) => Number(value)) : null;
    const overhead = Number(counted?.overhead);
    let chunks: string[][];
    if (counted?.ok && counts && counts.length === unique.length && Number.isFinite(overhead)) {
      chunks = AT.local.chunkByCounts(unique, counts, localMaxTokens, overhead);
    } else {
      AT.warn('the host did not count tokens, packing by estimate');
      chunks = AT.local.chunkByTokens(unique, localMaxTokens);
    }

    const batchOut = new Map<string, string>();
    let detected: string | null = null;
    for (const chunk of chunks) {
      const result = await translateChunk({ ...request, texts: chunk, target, localModelId, localMaxTokens });
      chunk.forEach((text, index) => batchOut.set(text, result.translations[index] ?? text));
      detected ??= result.detected;
    }

    const translations = originals.map((text) => {
      if (!needsTranslation(text)) return text;
      const translated = batchOut.get(text);
      return typeof translated === 'string' && translated.length > 0 ? translated : text;
    });
    return { translations, detected, requested: unique.length };
  }

  export async function test(request: TranslateRequest = {}): Promise<TestResult> {
    const started = Date.now();
    const result = await translate({ ...request, texts: [TEST_SENTENCE] });
    return { output: result.translations[0], detected: result.detected, ms: Date.now() - started };
  }
}

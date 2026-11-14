// On-device translation dispatch in the background context.
// Load after lib/constants.js, lib/browser.js.
namespace AT.engines {
  const C = AT.C;

  export const TEST_SENTENCE = 'The extension is configured correctly.';

  export type EngineErrorCode =
    | 'config'
    | 'timeout'
    | 'provider'
    | 'cancelled'
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
    timeout: 'timeout',
    provider: 'provider',
    cancelled: 'cancelled',
    format: 'format'
  };

  /**
   * The source language the model should be told about. An explicit setting
   * wins; `auto` asks the browser's own detector (CLD behind
   * `i18n.detectLanguage`), which is what the page cannot tell us. A detector
   * answer with no code in the model's table leaves the source unknown, and the
   * host then asks for the target without claiming one.
   */
  type ResolvedSource = { lang: AT.plamo3.Plamo3Lang | null; detected: string | null };

  async function resolveSource(
    setting: string | undefined,
    texts: string[]
  ): Promise<ResolvedSource> {
    if (setting && setting !== 'auto') {
      return { lang: AT.plamo3.langFor(setting), detected: C.isSupportedLang(setting) ? setting : null };
    }
    const sample = texts.join(' ').slice(0, 400);
    const answer = await AT.detectLanguage(sample);
    if (!answer) return { lang: null, detected: null };
    return {
      lang: AT.plamo3.langFor(answer.code),
      detected: C.isSupportedLang(answer.code) ? answer.code : null
    };
  }

  export function needsTranslation(text: unknown): boolean {
    return typeof text === 'string' && text.trim().length > 1 && /[\p{L}\p{N}]/u.test(text);
  }

  export type TranslateRequest = {
    signal?: AbortSignal;
    /** Cumulative decoded preview; empty text clears an earlier attempt. */
    onProgress?: AT.TranslationProgress | undefined;
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
    /** Interactive pages opt into exact tokenizer-bounded source fragments. */
    sourceChunkTokens?: number;
    fragmentConcurrency?: 1 | 2;
  };

  export type TranslateResult = {
    translations: string[];
    detected: string | null;
    requested: number;
    /** Where a local batch spent its time: counting tokens, then generating. */
    timing?: { countMs: number; hostMs: number; chunks: number };
  };

  export type TestResult = {
    output: string | undefined;
    detected: string | null;
    ms: number;
  };

  /** One generation per chunk, using the model's own tokenizer. */
  async function translateChunk(
    args: TranslateRequest & { texts: string[]; target: string; localModelId: string; localMaxTokens: number },
    resolved?: ResolvedSource
  ): Promise<{ translations: string[]; detected: string | null }> {
    const target = AT.plamo3.langFor(args.target);
    if (!target) {
      throw new EngineError('config', `the on-device model does not translate into ${args.target || 'that language'}`, {
        detail: 'no-target'
      });
    }
    const { lang: source, detected } = resolved ?? await resolveSource(args.source, args.texts);
    AT.local.throwIfAborted(args.signal);
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
      context: AT.targets.composeContext(
        AT.pagecontext.hint(args.context ?? null),
        AT.targets.roleHint(args.role ?? null)
      )
    }, args.onProgress, args.signal);
    AT.local.throwIfAborted(args.signal);
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

  /** Chunk indices are never the caller's indices after filtering and deduplication. */
  function mappedProgress(originals: string[], chunk: string[], progress?: AT.TranslationProgress): AT.TranslationProgress | undefined {
    if (!progress) return undefined;
    const positions = chunk.map(text => originals.flatMap((original, index) => original === text ? [index] : []));
    return (index, text) => {
      if (!Number.isInteger(index) || typeof text !== 'string') return;
      for (const position of positions[index] ?? []) progress(position, text);
    };
  }

  export async function translate(request: TranslateRequest = {}): Promise<TranslateResult> {
    let active = true;
    const previews = new Map<number, string>();
    const progress = request.onProgress;
    const clear = () => {
      active = false;
      for (const index of previews.keys()) progress?.(index, '');
      previews.clear();
    };
    const onProgress: AT.TranslationProgress | undefined = progress ? (index, text) => {
      if (!active || request.signal?.aborted || !Number.isInteger(index) || index < 0 || index >= (request.texts?.length ?? 0) || typeof text !== 'string') return;
      const source = request.texts?.[index];
      if (typeof source !== 'string') return;
      text = text.replace(/[\uD800-\uDBFF]$/u, '');
      const safe = /[\uD800-\uDFFF]/u.test(text) || AT.outputIssue(source, text, true) ? '' : text;
      if (previews.get(index) === safe) return;
      if (safe) previews.set(index, safe); else previews.delete(index);
      progress(index, safe);
    } : undefined;
    AT.local.throwIfAborted(request.signal);
    request.signal?.addEventListener('abort', clear, { once: true });
    try {
      const args = { ...request, onProgress };
      const result = await AT.local.withSignal(translateLocal(args), request.signal);
      AT.local.throwIfAborted(request.signal);
      return result;
    } catch (error) {
      clear();
      throw error;
    } finally {
      active = false;
      request.signal?.removeEventListener('abort', clear);
    }
  }

  /** Parallel generation, but only the contiguous source-order prefix is visible. */
  async function translateFragments(
    request: TranslateRequest & { target: string; localModelId: string; localMaxTokens: number },
    originals: string[], unique: string[], plans: string[][], countMs: number
  ): Promise<TranslateResult> {
    const started = Date.now();
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal?.addEventListener('abort', abort, { once: true });
    if (request.signal?.aborted) abort();
    const states = plans.map(parts => parts.map(() => ({ text: '', done: false })));
    const jobs = plans.flatMap((parts, unit) => parts.map((text, part) => ({ text, unit, part })));
    const positions = unique.map(text => originals.flatMap((original, index) => original === text ? [index] : []));
    const sources = unique.map(text => resolveSource(request.source, [text]));
    let cursor = 0;
    const joined = (parts: string[]) => parts.map(text => text.trim()).filter(Boolean).join(/^(ja|zh)(-|$)/u.test(request.target) ? '' : ' ');
    const publish = (unit: number) => {
      if (controller.signal.aborted) return;
      const prefix: string[] = [];
      for (const part of states[unit]!) {
        prefix.push(part.text);
        if (!part.done) break;
      }
      for (const index of positions[unit]!) request.onProgress?.(index, joined(prefix));
    };
    const run = async () => {
      try {
        while (cursor < jobs.length) {
          AT.local.throwIfAborted(controller.signal);
          const job = jobs[cursor++]!;
          const state = states[job.unit]![job.part]!;
          const resolved = await sources[job.unit]!;
          const result = await translateChunk({
            ...request, texts: [job.text.trim()], signal: controller.signal,
            onProgress: (index, text) => {
              if (index !== 0 || state.done || controller.signal.aborted) return;
              state.text = text;
              publish(job.unit);
            }
          }, resolved);
          const text = result.translations[0] ?? '';
          if (!text.trim() || AT.outputIssue(job.text, text)) {
            throw new EngineError('format', 'the on-device host returned an unusable fragment');
          }
          state.text = text;
          state.done = true;
          publish(job.unit);
        }
      } catch (error) {
        abort();
        throw error;
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(jobs.length, request.fragmentConcurrency === 2 ? 2 : 1) }, run));
      AT.local.throwIfAborted(controller.signal);
      const outputs = new Map(unique.map((text, index) => [text, joined(states[index]!.map(part => part.text))]));
      const resolved = await Promise.all(sources);
      return {
        translations: originals.map(text => outputs.get(text) ?? text),
        detected: resolved.find(source => source.detected)?.detected ?? null,
        requested: unique.length,
        timing: { countMs, hostMs: Date.now() - started, chunks: jobs.length }
      };
    } finally {
      abort();
      request.signal?.removeEventListener('abort', abort);
    }
  }

  async function translateLocal(request: TranslateRequest): Promise<TranslateResult> {
    const { texts = [], source = 'auto', target, localModelId = '', localMaxTokens = AT.local.DEFAULT_MAX_TOKENS } = request;
    if (!Array.isArray(texts)) throw new EngineError('config', 'texts must be an array');
    if (typeof target !== 'string' || !C.isSupportedLang(target)) {
      throw new EngineError('config', `unsupported target language: ${target}`);
    }
    if (!localModelId) throw new EngineError('config', 'no on-device model is selected', { detail: 'no-model' });
    if (texts.length === 0) return { translations: [], detected: null, requested: 0 };

    const originals = texts.map((text) => (typeof text === 'string' ? text : ''));
    const pending = originals.filter((text) => needsTranslation(text) && !AT.isTargetLanguage(text, target));
    const unique = [...new Set(pending)];
    if (unique.length === 0) return { translations: originals, detected: null, requested: 0 };

    /**
     * The model is sized by tokens, so the packing asks the host — which owns
     * the tokenizer — how many tokens each text is, rather than dividing
     * characters by a constant. The estimate is only the fallback for a host
     * that cannot answer (an older document, a failed load).
     */
    const countStarted = Date.now();
    const counted = await AT.local.callHost({
      type: C.MSG.LOCAL_COUNT,
      modelId: localModelId,
      maxTokens: localMaxTokens,
      texts: unique,
      ...(request.sourceChunkTokens ? { sourceChunkTokens: request.sourceChunkTokens } : {}),
      source: AT.plamo3.langFor(source) ?? '',
      target: AT.plamo3.langFor(target) ?? '',
      context: AT.pagecontext.hint(request.context ?? null) ?? ''
    }, undefined, request.signal);
    AT.local.throwIfAborted(request.signal);
    if (counted?.code === 'cancelled') throw AT.local.cancelled();
    const countMs = Date.now() - countStarted;
    if (request.sourceChunkTokens) {
      if (!counted?.ok) {
        throw new EngineError(LOCAL_CODES[String(counted?.code)] ?? 'provider',
          String(counted?.error ?? 'the host did not plan source fragments'));
      }
      const plans = counted?.sourceChunks;
      if (!counted?.ok || !Array.isArray(plans) || plans.length !== unique.length ||
          plans.some((parts, index) => !Array.isArray(parts) || !parts.length ||
            parts.some(part => typeof part !== 'string' || !part.trim()) || parts.join('') !== unique[index])) {
        throw new EngineError('provider', String(counted?.error ?? 'the host did not plan source fragments'));
      }
      return translateFragments({ ...request, target, localModelId, localMaxTokens }, originals, unique, plans, countMs);
    }
    const counts = Array.isArray(counted?.counts) ? counted.counts.map((value) => Number(value)) : null;
    const overhead = Number(counted?.overhead);
    let chunks: string[][];
    if (counted?.ok && counts && counts.length === unique.length && Number.isFinite(overhead)) {
      chunks = AT.local.chunkByCounts(unique, counts, localMaxTokens, overhead);
    } else {
      AT.warn('the host did not count tokens, packing by estimate');
      chunks = AT.local.chunkByTokens(unique, localMaxTokens);
    }

    const hostStarted = Date.now();
    const batchOut = new Map<string, string>();
    let detected: string | null = source !== 'auto' && C.isSupportedLang(source) ? source : null;
    for (const chunk of chunks) {
      AT.local.throwIfAborted(request.signal);
      let active = true;
      const progress = mappedProgress(originals, chunk, request.onProgress);
      try {
        const result = await translateChunk({ ...request, texts: chunk, target, localModelId, localMaxTokens,
          onProgress: progress ? (index, text) => { if (active) progress(index, text); } : undefined });
        chunk.forEach((text, index) => batchOut.set(text, result.translations[index] ?? text));
        detected ??= result.detected;
      } finally { active = false; }
    }

    const translations = originals.map((text) => {
      if (!needsTranslation(text) || AT.isTargetLanguage(text, target)) return text;
      const translated = batchOut.get(text);
      // An empty model answer is not a successful identity translation. Keep
      // the distinction so the DOM can retain the source without marking done.
      return typeof translated === 'string' ? translated : '';
    });
    return {
      translations,
      detected,
      requested: unique.length,
      timing: { countMs, hostMs: Date.now() - hostStarted, chunks: chunks.length }
    };
  }

  export async function test(request: TranslateRequest = {}): Promise<TestResult> {
    const started = Date.now();
    const result = await translate({ ...request, texts: [TEST_SENTENCE] });
    return { output: result.translations[0], detected: result.detected, ms: Date.now() - started };
  }
}

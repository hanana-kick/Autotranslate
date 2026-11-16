// On-device translation dispatch in the background context.
// Load after lib/constants.js, lib/browser.js and lib/settings.js.
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

  /** FIFO within each owner, round-robin between owners; counting uses no slot. */
  export interface FragmentScheduler {
    run<T>(job: () => Promise<T>, signal: AbortSignal, owner?: number): Promise<T>;
  }

  export interface AdjustableFragmentScheduler extends FragmentScheduler {
    setConcurrency(value: AT.settings.TranslationConcurrency): void;
  }

  export function createFragmentScheduler(concurrency: AT.settings.TranslationConcurrency): AdjustableFragmentScheduler {
    type Entry = { start: () => void; cancel: () => void };
    const queues = new Map<number, Entry[]>();
    let active = 0;
    const drain = () => {
      while (active < concurrency && queues.size) {
        const [owner, queue] = queues.entries().next().value!;
        const entry = queue.shift()!;
        queues.delete(owner);
        if (queue.length) queues.set(owner, queue);
        entry.start();
      }
    };
    return {
      setConcurrency(value) { concurrency = value; drain(); },
      run<T>(job: () => Promise<T>, signal: AbortSignal, owner = 0): Promise<T> {
        const { promise, resolve, reject } = Promise.withResolvers<T>();
        if (signal.aborted) { reject(AT.local.cancelled()); return promise; }
        const entry = {
          cancel: () => {
            const queue = queues.get(owner);
            const index = queue?.indexOf(entry) ?? -1;
            if (index >= 0) queue!.splice(index, 1);
            if (queue && !queue.length) queues.delete(owner);
            signal.removeEventListener('abort', entry.cancel);
            reject(AT.local.cancelled());
          },
          start: () => {
            signal.removeEventListener('abort', entry.cancel);
            active++;
            const finish = () => { active--; drain(); };
            // Recheck on admission; an aborted queued job must never reach the host.
            void Promise.resolve().then(() => {
              AT.local.throwIfAborted(signal);
              return job();
            }).then(value => { resolve(value); finish(); }, error => { reject(error); finish(); });
          }
        };
        signal.addEventListener('abort', entry.cancel, { once: true });
        const queue = queues.get(owner);
        if (queue) queue.push(entry); else queues.set(owner, [entry]);
        drain();
        return promise;
      }
    };
  }

  export type TranslateRequest = {
    signal?: AbortSignal;
    /** Cumulative decoded preview; empty text clears an earlier attempt. */
    onProgress?: AT.TranslationProgress | undefined;
    texts?: unknown[];
    /** 'auto' or a C.LANGS code */
    source?: string;
    target?: string;
    /** model id; empty means nothing is selected and the call is a config error */
    localModelId?: string;
    localMaxTokens?: number;
    glossary?: AT.glossary.Entry[];
    fragmentConcurrency?: AT.settings.TranslationConcurrency;
    /** Internal shared admission, independent of this request's worker count. */
    fragmentScheduler?: FragmentScheduler;
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
      glossary: args.glossary
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
    originals: string[], unique: string[], plans: string[][], countMs: number, resolvedSource: ResolvedSource
  ): Promise<TranslateResult> {
    const started = Date.now();
    const controller = new AbortController();
    const abort = () => controller.abort();
    let failure: unknown;
    request.signal?.addEventListener('abort', abort, { once: true });
    if (request.signal?.aborted) abort();
    const states = plans.map(parts => parts.map(() => ({ text: '', done: false })));
    const jobs = plans.flatMap((parts, unit) => parts.map((text, part) => ({ text, unit, part })));
    const positions = unique.map(text => originals.flatMap((original, index) => original === text ? [index] : []));
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
          const resolved = resolvedSource;
          const generate = async () => {
            try {
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
            } catch (error) {
              if (!controller.signal.aborted) failure = error;
              // Invalidate siblings before releasing this shared generation slot.
              abort();
              throw error;
            }
          };
          if (request.fragmentScheduler) await request.fragmentScheduler.run(generate, controller.signal);
          else await generate();
        }
      } catch (error) {
        if (!controller.signal.aborted) failure = error;
        abort();
        throw error;
      }
    };
    try {
      const width = AT.settings.isTranslationConcurrency(request.fragmentConcurrency) ? request.fragmentConcurrency : 1;
      await Promise.all(Array.from({ length: Math.min(jobs.length, width) }, run));
      AT.local.throwIfAborted(controller.signal);
      const outputs = new Map(unique.map((text, index) => [text, joined(states[index]!.map(part => part.text))]));
      return {
        translations: originals.map(text => outputs.get(text) ?? text),
        detected: resolvedSource.detected,
        requested: unique.length,
        timing: { countMs, hostMs: Date.now() - started, chunks: jobs.length }
      };
    } catch (error) {
      throw failure ?? error;
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

    // Planning and generation use the same resolved language and tokenizer.
    const resolved = await resolveSource(source, unique);
    AT.local.throwIfAborted(request.signal);
    const countStarted = Date.now();
    const counted = await AT.local.callHost({
      type: C.MSG.LOCAL_COUNT,
      modelId: localModelId,
      maxTokens: localMaxTokens,
      texts: unique,
      source: resolved.lang ?? '',
      target: AT.plamo3.langFor(target) ?? '',
      glossary: request.glossary
    }, undefined, request.signal);
    AT.local.throwIfAborted(request.signal);
    if (counted?.code === 'cancelled') throw AT.local.cancelled();
    const countMs = Date.now() - countStarted;
    if (!counted?.ok) {
      throw new EngineError(LOCAL_CODES[String(counted?.code)] ?? 'provider',
        String(counted?.error ?? 'the host did not plan source fragments'));
    }
    const plans = counted.sourceChunks;
    if (!Array.isArray(plans) || plans.length !== unique.length ||
        plans.some((parts, index) => !Array.isArray(parts) || !parts.length ||
          parts.some(part => typeof part !== 'string' || !part.trim()) || parts.join('') !== unique[index])) {
      throw new EngineError('provider', 'the host did not plan source fragments');
    }
    return translateFragments({ ...request, target, localModelId, localMaxTokens }, originals, unique, plans, countMs, resolved);
  }

  export async function test(request: TranslateRequest = {}): Promise<TestResult> {
    const started = Date.now();
    const result = await translate({ ...request, texts: [TEST_SENTENCE] });
    return { output: result.translations[0], detected: result.detected, ms: Date.now() - started };
  }
}

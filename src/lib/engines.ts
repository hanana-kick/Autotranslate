// Translation providers. Runs only in the background context, where host
// permissions lift CORS and keep the API key out of content scripts.
// Load after lib/constants.js, lib/browser.js.
namespace AT.engines {
  const C = AT.C;

  export const TEST_SENTENCE = 'The extension is configured correctly.';

  /** A decoded provider body; every field is re-checked before it is used. */
  type Reply = { [key: string]: unknown };

  export type EngineErrorCode =
    | 'config'
    | 'network'
    | 'timeout'
    | 'rate-limit'
    | 'provider'
    | 'http'
    | 'format';

  /** Why a well-answered request still could not be used. */
  export type EngineErrorReason = 'json' | 'shape' | 'split' | 'count';

  export type EngineErrorExtra = {
    status?: number;
    detail?: string;
    reason?: EngineErrorReason;
    expected?: number;
    got?: number;
  };

  export interface EngineError extends Error {
    code: EngineErrorCode;
    status?: number;
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
  // fields that withRetry and the tests read. The object is made from
  // EngineError.prototype so the instanceof chain survives either way.
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
    if (extra.status !== undefined) error.status = extra.status;
    if (extra.detail !== undefined) error.detail = extra.detail;
    if (extra.reason !== undefined) error.reason = extra.reason;
    if (extra.expected !== undefined) error.expected = extra.expected;
    if (extra.got !== undefined) error.got = extra.got;
    return error;
  } as unknown as EngineErrorConstructor;

  EngineError.prototype = Object.create(Error.prototype);
  EngineError.prototype.constructor = EngineError;

  const RETRYABLE: Record<string, true | undefined> = { network: true, timeout: true, 'rate-limit': true };
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const snippet = (text: unknown, max = 180) =>
    typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, max) : '';
  const parseJson = (text: string): Reply | null => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };

  function alias(engineId: string, code: string): string {
    if (!code) return code;
    return C.ENGINE_LANG_ALIAS[engineId]?.[code] ?? code;
  }

  function chunkByChars(items: string[], limit: number): string[][] {
    const chunks: string[][] = [];
    let current: string[] = [];
    let size = 0;
    for (const item of items) {
      const cost = item.length + 1;
      if (current.length && size + cost > limit) {
        chunks.push(current);
        current = [];
        size = 0;
      }
      current.push(item);
      size += cost;
    }
    if (current.length) chunks.push(current);
    return chunks;
  }

  async function mapLimit<T, R>(
    items: T[],
    limit: number,
    worker: (item: T, index: number) => R | Promise<R>
  ): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let cursor = 0;
    const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        results[index] = await worker(items[index]!, index);
      }
    });
    await Promise.all(lanes);
    return results;
  }

  /** The only response member the providers ever read is `text()`. */
  export type FetchResponse = { ok: boolean; status: number; text(): Promise<string> };

  export type FetchInit = {
    method?: string;
    headers?: Record<string, string>;
    body?: string | null | undefined;
    credentials?: string;
    cache?: string;
    signal?: AbortSignal;
  };

  /** Tests inject a stub, so this is deliberately narrower than `typeof fetch`. */
  export type FetchImpl = (url: string, init?: FetchInit) => Promise<FetchResponse>;

  /** Rejections carry no shape: an Error, a DOMException, or anything a provider stub threw. */
  type Rejection = { name?: unknown; message?: unknown };

  type FetchOptions = {
    method?: string;
    headers?: Record<string, string>;
    body?: string | null | undefined;
    fetchImpl?: FetchImpl | undefined;
  };

  type ChunkResult = { translations: string[]; detected: string | null };

  type ChunkArgs = {
    endpoint: string;
    texts: string[];
    source: string;
    target: string;
    apiKey: string;
    fetchImpl?: FetchImpl | undefined;
    /** Only the on-device engine reads these. */
    localModelId: string;
    localMaxTokens: number;
    /** The page the texts came from; only the on-device prompt can use it. */
    context?: AT.pagecontext.PageContext | null;
    /** The region of the page these texts came from, if the caller knows. */
    role?: AT.targets.TextRole | null;
  };

  type ChunkRunner = (args: ChunkArgs) => Promise<ChunkResult>;

  async function fetchJson(url: string, { method = 'GET', headers = {}, body, fetchImpl }: FetchOptions): Promise<Reply> {
    // `fetch` in a worker takes a wider request than the stub surface above;
    // only the listed members are ever set on it.
    const doFetch: FetchImpl | undefined = fetchImpl ?? (globalThis.fetch as FetchImpl | undefined);
    if (typeof doFetch !== 'function') throw new EngineError('network', 'fetch is unavailable');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), C.PROVIDER_TIMEOUT_MS);
    let response: FetchResponse | undefined;
    let text: string | undefined;
    try {
      response = await doFetch(url, {
        method,
        headers: { Accept: 'application/json', ...headers },
        body,
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal
      });
      text = await response.text();
    } catch (error: unknown) {
      const rejection = error as Rejection;
      if (rejection?.name === 'AbortError') {
        throw new EngineError('timeout', `provider did not answer within ${C.PROVIDER_TIMEOUT_MS}ms`);
      }
      throw new EngineError('network', `provider unreachable: ${rejection?.message ?? rejection}`);
    } finally {
      clearTimeout(timer);
    }
    // The `try` either filled both and fell through to here, or threw from its
    // catch; the `finally` only clears the watchdog.
    const answered = response as FetchResponse;
    const payload = text as string;
    if (!answered.ok) {
      // Providers usually explain themselves in a JSON body even on 4xx, which
      // beats showing the user a bare status code.
      const body = parseJson(payload);
      const reported = typeof body?.error === 'string' ? body.error : null;
      const rateLimited = answered.status === 429 || /rate|quota|limit/i.test(reported ?? '');
      const code: EngineErrorCode = rateLimited
        ? 'rate-limit'
        : reported && answered.status < 500
          ? 'provider'
          : 'http';
      throw new EngineError(code, reported ?? `provider answered ${answered.status}`, {
        status: answered.status,
        detail: snippet(reported ?? payload)
      });
    }
    try {
      return JSON.parse(payload);
    } catch {
      throw new EngineError('format', 'provider returned a non-JSON body', {
        reason: 'json',
        detail: snippet(payload)
      });
    }
  }

  async function withRetry<T>(call: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= C.PROVIDER_RETRIES; attempt += 1) {
      try {
        return await call();
      } catch (error: unknown) {
        lastError = error;
        const retryable =
          error instanceof EngineError &&
          (RETRYABLE[error.code] === true || (error.code === 'http' && (error.status ?? 0) >= 500));
        if (!retryable || attempt === C.PROVIDER_RETRIES) throw error;
        await sleep(200 * (attempt + 1));
      }
    }
    throw lastError;
  }

  // Unofficial Google endpoint: one GET per chunk, texts joined by newlines and
  // split back apart. When the split does not line up we redo the chunk one
  // text per request instead of guessing where the boundaries were.
  async function googleChunk({ endpoint, texts, source, target, fetchImpl }: ChunkArgs): Promise<ChunkResult> {
    const url = new URL(endpoint);
    url.searchParams.set('client', 'gtx');
    url.searchParams.set('sl', alias('google', source || 'auto'));
    url.searchParams.set('tl', alias('google', target));
    url.searchParams.set('dt', 't');
    url.searchParams.set('q', texts.join('\n'));
    const data = await fetchJson(url.toString(), { fetchImpl });
    const rows = data?.[0];
    const segments = Array.isArray(rows) ? rows : null;
    if (!segments) {
      throw new EngineError('format', 'unexpected Google response shape', {
        reason: 'shape',
        detail: snippet(JSON.stringify(data ?? null))
      });
    }
    const joined = segments
      .map((segment) => (Array.isArray(segment) && typeof segment[0] === 'string' ? segment[0] : ''))
      .join('');
    const detected = typeof data[2] === 'string' ? data[2] : null;
    const lines = joined.split('\n');
    if (texts.length === 1) {
      // Google breaks long answers into lines of its own; with one text to
      // translate the whole reply is that text's translation. Splitting here
      // would reject perfectly good answers and fail the page.
      return { translations: [joined.trim()], detected };
    }
    if (lines.length !== texts.length) {
      throw new EngineError('format', 'Google batch split mismatch', {
        reason: 'split',
        expected: texts.length,
        got: lines.length
      });
    }
    return { translations: lines, detected };
  }

  /**
   * Which writing system a text is in, for the provider's own
   * detection: `sl=auto` decides once per request, so a Korean page's
   * English title came back untouched when it travelled with the Korean
   * chrome around it. Hangul, Cyrillic, Arabic and everything else are
   * asked separately; Japanese and Chinese share a bucket because they mix
   * kanji and kana in one sentence.
   */
  function scriptOf(text: string): string {
    if (/[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/.test(text)) return 'hangul';
    if (/[\u3040-\u30FF\u4E00-\u9FFF\u3400-\u4DBF]/.test(text)) return 'cjk';
    if (/[\u0400-\u04FF]/.test(text)) return 'cyrillic';
    if (/[\u0600-\u06FF]/.test(text)) return 'arabic';
    if (/[\u0590-\u05FF]/.test(text)) return 'hebrew';
    if (/[\u0E00-\u0E7F]/.test(text)) return 'thai';
    return 'other';
  }

  /** Split a chunk into per-script buckets, keeping every text's position. */
  function bucketByScript(texts: readonly string[]): { indices: number[]; texts: string[] }[] {
    const buckets = new Map<string, { indices: number[]; texts: string[] }>();
    texts.forEach((text, index) => {
      const script = scriptOf(text);
      let bucket = buckets.get(script);
      if (!bucket) {
        bucket = { indices: [], texts: [] };
        buckets.set(script, bucket);
      }
      bucket.indices.push(index);
      bucket.texts.push(text);
    });
    return Array.from(buckets.values());
  }

  // Runs one size-bounded chunk. If Google's newline-joined reply cannot be
  // split back into the inputs, rerun the chunk as one request per text.
  async function googleRun(args: ChunkArgs): Promise<ChunkResult> {
    const buckets = bucketByScript(args.texts);
    if (buckets.length > 1) {
      const out: string[] = new Array<string>(args.texts.length).fill('');
      for (const bucket of buckets) {
        const result = await googleRun({ ...args, texts: bucket.texts });
        bucket.indices.forEach((index, position) => {
          out[index] = result.translations[position] ?? '';
        });
      }
      return { translations: out, detected: null };
    }
    try {
      return await withRetry(() => googleChunk(args));
    } catch (error) {
      if (!(error instanceof EngineError) || error.reason !== 'split') throw error;
      AT.log('google split mismatch, retrying per text', args.texts.length);
      const translations = await mapLimit(args.texts, C.PROVIDER_CONCURRENCY, (text) =>
        // A one-text chunk either answers with one line or throws.
        withRetry(() => googleChunk({ ...args, texts: [text] })).then((result) => result.translations[0]!)
      );
      return { translations, detected: null };
    }
  }

  async function libreTranslateChunk({ endpoint, texts, source, target, apiKey, fetchImpl }: ChunkArgs): Promise<ChunkResult> {
    const payload: { q: string[]; source: string; target: string; format: string; api_key?: string } = {
      q: texts,
      source: alias('libretranslate', source || 'auto'),
      target: alias('libretranslate', target),
      format: 'text'
    };
    if (apiKey) payload.api_key = apiKey;
    const data = await fetchJson(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      fetchImpl
    });
    if (data && typeof data === 'object' && typeof data.error === 'string') {
      const code: EngineErrorCode = /rate|quota|limit/i.test(data.error) ? 'rate-limit' : 'provider';
      throw new EngineError(code, data.error.slice(0, 300));
    }
    const items = Array.isArray(data)
      ? data
      : Array.isArray(data?.contents)
        ? data.contents
        : typeof data?.translatedText === 'string'
          ? [data]
          : null;
    if (!items) {
      throw new EngineError('format', 'unexpected LibreTranslate response shape', {
        reason: 'shape',
        detail: snippet(JSON.stringify(data ?? null))
      });
    }
    if (items.length !== texts.length) {
      throw new EngineError('format', 'LibreTranslate returned an unexpected result count', {
        reason: 'count',
        expected: texts.length,
        got: items.length
      });
    }
    return {
      translations: items.map((item) =>
        typeof item === 'string' ? item : (item?.translatedText ?? '')
      ),
      detected:
        typeof data?.detectedLanguage === 'string'
          ? data.detectedLanguage
          : typeof data?.detected_language === 'string'
            ? data.detected_language
            : null
    };
  }

  async function libreRun(args: ChunkArgs): Promise<ChunkResult> {
    return withRetry(() => libreTranslateChunk(args));
  }

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

  // The on-device engine has no HTTP endpoint: it asks the host that owns the
  // model. One chunk is one generation, so there is nothing to retry — a repeat
  // would spend another minute on the same 4B model.
  async function localChunk(args: ChunkArgs): Promise<ChunkResult> {
    const meta = C.getEngineMeta('local');
    if (meta?.kind !== 'local') throw new EngineError('config', 'the on-device engine is not available');
    if (!args.localModelId) throw new EngineError('config', 'no on-device model is selected', { detail: 'no-model' });
    // The target is TranslateGemma's own code, never the provider-style code:
    // the model only knows the spellings from its language table.
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
      context: AT.targets.composeContext(AT.pagecontext.hint(args.context), AT.targets.roleHint(args.role))
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

  const IMPLEMENTATIONS: { [engineId: string]: ChunkRunner | undefined } = {
    google: googleRun,
    libretranslate: libreRun,
    local: localChunk
  };

  export function needsTranslation(text: unknown): boolean {
    return typeof text === 'string' && text.trim().length > 1 && /[\p{L}\p{N}]/u.test(text);
  }

  export type TranslateRequest = {
    /** id from C.ENGINES */
    engine?: string;
    /** What kind of page the texts came from, if the caller knows. */
    context?: AT.pagecontext.PageContext | null;
    /** Which part of the page these texts came from. */
    role?: AT.targets.TextRole | null;
    endpoints?: { [engineId: string]: string };
    apiKey?: string;
    texts?: unknown[];
    /** 'auto' or a C.LANGS code */
    source?: string;
    target?: string;
    batchChars?: number;
    /** injected by tests */
    fetchImpl?: FetchImpl;
    /** model id for the on-device engine */
    localModelId?: string;
    localMaxTokens?: number;
  };

  export type TranslateResult = {
    translations: string[];
    detected: string | null;
    engine: string;
    requested: number;
  };

  export type TestResult = {
    output: string | undefined;
    detected: string | null;
    engine: string;
    ms: number;
  };

  export async function translate(request: TranslateRequest = {}): Promise<TranslateResult> {
    const {
      engine = 'google',
      endpoints = {},
      apiKey = '',
      texts = [],
      source = 'auto',
      target,
      localModelId = '',
      localMaxTokens = AT.local.DEFAULT_MAX_TOKENS
    } = request;
    const meta = C.getEngineMeta(engine);
    if (!meta) throw new EngineError('config', `unknown engine: ${engine}`);
    if (!Array.isArray(texts)) throw new EngineError('config', 'texts must be an array');
    if (typeof target !== 'string' || !C.isSupportedLang(target)) {
      throw new EngineError('config', `unsupported target language: ${target}`);
    }
    // A local engine runs in this browser and has no URL to validate.
    const endpoint = meta.kind === 'local' ? '' : resolveEndpoint(meta, endpoints);
    const implementation = IMPLEMENTATIONS[engine];
    if (typeof implementation !== 'function') {
      throw new EngineError('config', `engine ${engine} has no implementation`);
    }

    if (texts.length === 0) return { translations: [], detected: null, engine, requested: 0 };

    const originals = texts.map((text) => (typeof text === 'string' ? text : ''));
    const pending = originals.filter((text) => needsTranslation(text));
    const unique = [...new Set(pending)];
    if (unique.length === 0) return { translations: originals, detected: null, engine, requested: 0 };

    const limit = Math.max(
      100,
      Math.min(request.batchChars ?? meta.maxChars, meta.maxChars)
    );
    const args: Omit<ChunkArgs, 'texts'> = {
      endpoint,
      source,
      target,
      apiKey: apiKey ?? '',
      fetchImpl: request.fetchImpl,
      localModelId,
      localMaxTokens,
      context: request.context ?? null,
      role: request.role ?? null
    };
    const run = (chunk: string[]) => implementation({ ...args, texts: chunk });

    /**
     * The model is sized by tokens, so the packing asks the host — which owns
     * the tokenizer — how many tokens each text is, rather than dividing
     * characters by a constant. The estimate is only the fallback for a host
     * that cannot answer (an older document, a failed load).
     */
    const packLocal = async (textsToPack: string[]): Promise<string[][]> => {
      const counted = await AT.local.callHost({
        type: C.MSG.LOCAL_COUNT,
        modelId: localModelId,
        maxTokens: localMaxTokens,
        texts: textsToPack,
        source: AT.gemma.isLang(source) ? source : '',
        target: AT.gemma.isLang(target) ? target : '',
        context: AT.pagecontext.hint(request.context ?? null) ?? ''
      });
      const counts = Array.isArray(counted?.counts) ? counted.counts.map((value) => Number(value)) : null;
      const overhead = Number(counted?.overhead);
      if (!counted?.ok || !counts || counts.length !== textsToPack.length || !Number.isFinite(overhead)) {
        AT.warn('the host did not count tokens, packing by estimate');
        return AT.local.chunkByTokens(textsToPack, localMaxTokens);
      }
      return AT.local.chunkByCounts(textsToPack, counts, localMaxTokens, overhead);
    };

    // Cloud providers are sized by characters (that is what their APIs bill);
    // the model is sized by the tokens one generation can spend.
    // Nothing to count against without a model: the local runner reports that
    // as a config error, and no host is woken for it.
    const chunks =
      meta.kind !== 'local'
        ? chunkByChars(unique, limit)
        : localModelId
          ? await packLocal(unique)
          : AT.local.chunkByTokens(unique, localMaxTokens);
    const batchOut = new Map<string, string>();
    let detected: string | null = null;
    for (const chunk of chunks) {
      const result = await run(chunk);
      chunk.forEach((text, i) => batchOut.set(text, result.translations[i] ?? text));
      detected ??= result.detected;
    }

    const translations = originals.map((text) => {
      if (!needsTranslation(text)) return text;
      const translated = batchOut.get(text);
      return typeof translated === 'string' && translated.length > 0 ? translated : text;
    });
    return { translations, detected, engine, requested: unique.length };
  }

  function resolveEndpoint(meta: AT.EngineMeta, endpoints: { [engineId: string]: string }): string {
    const candidate = endpoints?.[meta.id] ?? meta.endpoint;
    const valid = AT.settings?.isValidEndpoint?.(candidate) ?? null;
    if (!valid) throw new EngineError('config', `invalid endpoint for ${meta.id}: ${candidate}`);
    return valid;
  }

  export async function test(request: TranslateRequest = {}): Promise<TestResult> {
    const started = Date.now();
    const result = await translate({ ...request, texts: [TEST_SENTENCE] });
    return {
      output: result.translations[0],
      detected: result.detected,
      engine: result.engine,
      ms: Date.now() - started
    };
  }
}

// Translation dispatch in the background context. The existing on-device host
// and the explicitly selected OpenAI-compatible HTTP server are independent.
// Server credentials and network requests never pass through page scripts.
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
  ): Promise<{ lang: AT.plamo3.Plamo3Lang | null; detected: string | null }> {
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
    engine?: AT.settings.Engine;
    server?: AT.settings.ServerSettings;
    signal?: AbortSignal;
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
    /** Where a local batch spent its time: counting tokens, then generating. */
    timing?: { countMs: number; hostMs: number; chunks: number };
  };

  export type TestResult = {
    output: string | undefined;
    detected: string | null;
    ms: number;
  };

  /**
   * Existing on-device path: one generation per chunk, using the model's own
   * tokenizer. The compatible-server path below does not call this function.
   */
  async function translateChunk(
    args: TranslateRequest & { texts: string[]; target: string; localModelId: string; localMaxTokens: number }
  ): Promise<{ translations: string[]; detected: string | null }> {
    const target = AT.plamo3.langFor(args.target);
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
    return { translations, detected };
  }

  const SERVER_RESPONSE_LIMIT = 2 * 1024 * 1024;

  function serverConfig(config?: AT.settings.ServerSettings, requireModel = true): AT.settings.ServerSettings {
    if (!config) throw new EngineError('config', 'Configure an OpenAI-compatible server in Options.');
    let baseUrl: string;
    try { baseUrl = AT.settings.normalizeServerBaseUrl(config.baseUrl); }
    catch { throw new EngineError('config', 'Invalid server Base URL. Use HTTP(S), without embedded credentials or query parameters.'); }
    if (!baseUrl) throw new EngineError('config', 'Set the server Base URL in Options.');
    const model = String(config.model ?? '').trim();
    if (requireModel && !model) throw new EngineError('config', 'Set the server model in Options.');
    if (/[\r\n]/u.test(config.apiKey ?? '')) throw new EngineError('config', 'Invalid API key.');
    return { ...config, baseUrl, model, apiKey: (config.apiKey ?? '').trim(),
      timeoutMs: Math.min(300000, Math.max(5000, Number(config.timeoutMs) || 60000)) };
  }

  /** Bound the complete response, not only the initial HTTP headers. */
  async function serverJson(config: AT.settings.ServerSettings, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    if (signal?.aborted) throw new EngineError('provider', 'Server translation cancelled.');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, config.timeoutMs);
    try {
      const response = await fetch(config.baseUrl + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(config.apiKey ? { Authorization: 'Bearer ' + config.apiKey } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer'
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        const code: EngineErrorCode = response.status === 401 || response.status === 403 ? 'config'
          : response.status === 429 ? 'rate-limit' : response.status === 408 || response.status === 504 ? 'timeout' : 'http';
        // Never echo response bodies: providers may reflect credentials or page text.
        throw new EngineError(code, 'Server returned HTTP ' + response.status + (code === 'config' ? '; check the API key and model access.' : '.'));
      }
      const length = Number(response.headers.get('content-length'));
      if (length > SERVER_RESPONSE_LIMIT) { controller.abort(); throw new EngineError('format', 'Server response is too large.'); }
      if (!response.body) throw new EngineError('format', 'Server returned an empty response.');
      const reader = response.body.getReader();
      let size = 0, text = '';
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > SERVER_RESPONSE_LIMIT) { controller.abort(); throw new EngineError('format', 'Server response is too large.'); }
          text += decoder.decode(part.value, { stream: true });
        }
        text += decoder.decode();
      } finally { reader.releaseLock(); }
      try { return JSON.parse(text) as unknown; }
      catch { throw new EngineError('format', 'Server did not return valid JSON.'); }
    } catch (error) {
      if (error instanceof EngineError) throw error;
      if (timedOut) throw new EngineError('timeout', 'Server request timed out.');
      if (signal?.aborted) throw new EngineError('provider', 'Server translation cancelled.');
      throw new EngineError('network', 'Cannot reach the configured server. Check its URL, network access and HTTPS certificate.');
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
    }
  }

  export async function listServerModels(config: AT.settings.ServerSettings): Promise<string[]> {
    const data = await serverJson(serverConfig(config, false), '/models') as { data?: unknown };
    if (!Array.isArray(data?.data)) throw new EngineError('format', 'Server returned an invalid model list. Enter a model ID manually if /models is unsupported.');
    return [...new Set(data.data.map((entry: unknown) => {
      const id = (entry as { id?: unknown } | null)?.id;
      return typeof id === 'string' && id.trim().length <= 200 ? id.trim() : '';
    }).filter(Boolean))].slice(0, 512).sort();
  }

  /** The JSON array a server model answered with, however it wrapped it.
   *
   *  Asked for "ONLY a JSON array", models still hand back
   *  `["읽으세요","튜토리얼을","지금mediately."];` or put a sentence in front of it.
   *  Both are the array the request asked for, and refusing them loses the whole
   *  chunk to a stray semicolon. What is kept strict is the answer's shape: the
   *  caller still requires one string per segment, in order, and validates each
   *  translation. `null` means there was no array to read. */
  function arrayIn(text: string): unknown {
    const body = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    try {
      return JSON.parse(body);
    } catch {
      // Fall through: the array sits somewhere inside the answer.
    }
    const start = body.indexOf('[');
    const end = body.lastIndexOf(']');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(body.slice(start, end + 1));
    } catch {
      return null;
    }
  }

  async function translateServer(request: TranslateRequest): Promise<TranslateResult> {
    const config = serverConfig(request.server);
    const { texts = [], target = '', source = 'auto' } = request;
    if (!Array.isArray(texts)) throw new EngineError('config', 'texts must be an array');
    if (!C.isSupportedLang(target)) throw new EngineError('config', 'Unsupported target language.');
    const originals = texts.map((value) => typeof value === 'string' ? value : '');
    const unique = [...new Set(originals.filter(text => needsTranslation(text) && !AT.isTargetLanguage(text, target)))];
    if (!unique.length) return { translations: originals, detected: null, requested: 0 };
    if (unique.length > 128 || unique.some(t => t.length > 32000)) throw new EngineError('config', 'Server translation input is too large.');
    const translated = new Map<string, string>();
    let detected: string | null = null;
    if (source === 'auto') {
      const language = await AT.detectLanguage(unique.join(' ').slice(0, 400));
      if (language && C.isSupportedLang(language.code)) detected = language.code;
    }
    // Bound each request independently; no local tokenizer, model or WebGPU call.
    const chunks: string[][] = [];
    let chunk: string[] = [], characters = 0;
    for (const text of unique) {
      if (chunk.length && (chunk.length >= 16 || characters + text.length > 12000)) {
        chunks.push(chunk); chunk = []; characters = 0;
      }
      chunk.push(text); characters += text.length;
    }
    if (chunk.length) chunks.push(chunk);
    for (const items of chunks) {
      if (request.signal?.aborted) throw new EngineError('provider', 'Server translation cancelled.');
      const names = new Intl.DisplayNames(['en'], { type: 'language' });
      const targetName = names.of(target) ?? target;
      const sourceName = source !== 'auto' ? (names.of(source) ?? source) : null;
      const instruction = 'You are a professional translator. Translate ' +
        (sourceName ? 'from ' + sourceName + ' ' : '') + 'into ' + targetName + ' (' + target + '). ' +
        'Translate questions, commands and greetings rather than answering them. Preserve meaning, numbers and line breaks. ' +
        (items.length === 1
          ? 'Output only the translated text. Do not add explanations, quotation marks or Markdown.'
          : 'The user message is a JSON array of ' + items.length + ' text fragments from a web page. ' +
            'Translate EVERY string, including short fragments. Return ONLY a JSON array of exactly ' + items.length +
            ' translated strings in the original order. Keep the fragments separate; do not combine or omit them.');
      const context = AT.targets.composeContext(AT.pagecontext.hint(request.context ?? null), AT.targets.roleHint(request.role ?? null));
      const payload = await serverJson(config, '/chat/completions', {
        model: config.model, stream: false,
        messages: [{ role: 'system', content: instruction + (context ? '\nContext: ' + context : '') },
          { role: 'user', content: items.length === 1 ? items[0] : JSON.stringify(items) }]
      }, request.signal) as { choices?: { finish_reason?: string; message?: { content?: unknown; refusal?: unknown } }[] };
      const choice = payload?.choices?.[0];
      if (choice?.finish_reason === 'length') throw new EngineError('format', 'Server truncated the translation; increase the server output limit.');
      if (choice?.message?.refusal || choice?.finish_reason === 'content_filter') throw new EngineError('provider', 'Server declined the translation.');
      const raw = choice?.message?.content;
      // Only final assistant text counts; reasoning_content and tool calls do not.
      const content = typeof raw === 'string' ? raw.trim() : Array.isArray(raw)
        ? raw.filter((part: unknown) => (part as { type?: unknown })?.type === 'text')
          .map((part: { text?: unknown }) => typeof part.text === 'string' ? part.text : '').join('').trim() : '';
      let answers: unknown = [content];
      if (items.length > 1) {
        answers = arrayIn(content) ?? (() => {
          throw new EngineError('format', 'Server must return one JSON string per input segment.');
        })();
      }
      if (!Array.isArray(answers) || answers.length !== items.length || answers.some(answer => typeof answer !== 'string')) {
        throw new EngineError('format', 'Server returned an unexpected result count.', { reason: 'count', expected: items.length, got: Array.isArray(answers) ? answers.length : 0 });
      }
      answers.forEach((answer: string, index) => {
        const output = answer.trim(), input = items[index]!;
        const issue = AT.outputIssue(input, output);
        if (issue) throw new EngineError('format', 'Invalid server translation: ' + issue);
        translated.set(input, output);
      });
    }
    return { translations: originals.map(text => translated.get(text) ?? text), detected, requested: unique.length };
  }

  export async function translate(request: TranslateRequest = {}): Promise<TranslateResult> {
    if (request.engine === 'openai') return translateServer(request);
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
      source: AT.plamo3.langFor(source) ?? '',
      target: AT.plamo3.langFor(target) ?? '',
      context: AT.pagecontext.hint(request.context ?? null) ?? ''
    });
    const countMs = Date.now() - countStarted;
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
      const result = await translateChunk({ ...request, texts: chunk, target, localModelId, localMaxTokens });
      chunk.forEach((text, index) => batchOut.set(text, result.translations[index] ?? text));
      detected ??= result.detected;
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

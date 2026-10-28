// Translation providers. Runs only in the background context, where host
// permissions lift CORS and keep the API key out of content scripts.
// Load after lib/constants.js, lib/browser.js.
(() => {
  const AT = (globalThis.AT ??= {});
  const C = AT.C;
  const engines = (AT.engines = {});

  const TEST_SENTENCE = 'The extension is configured correctly.';

  engines.EngineError = class EngineError extends Error {
    constructor(code, message, extra = {}) {
      super(message);
      this.name = 'EngineError';
      this.code = code;
      Object.assign(this, extra);
    }
  };

  const RETRYABLE = new Set(['network', 'timeout', 'rate-limit']);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const snippet = (text, max = 180) =>
    typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, max) : '';
  const parseJson = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };

  function alias(engineId, code) {
    if (!code) return code;
    return C.ENGINE_LANG_ALIAS[engineId]?.[code] ?? code;
  }

  function chunkByChars(items, limit) {
    const chunks = [];
    let current = [];
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

  async function mapLimit(items, limit, worker) {
    const results = new Array(items.length);
    let cursor = 0;
    const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    });
    await Promise.all(lanes);
    return results;
  }

  async function fetchJson(url, { method = 'GET', headers = {}, body, fetchImpl }) {
    const doFetch = fetchImpl ?? globalThis.fetch;
    if (typeof doFetch !== 'function') throw new engines.EngineError('network', 'fetch is unavailable');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), C.PROVIDER_TIMEOUT_MS);
    let response;
    let text;
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
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new engines.EngineError('timeout', `provider did not answer within ${C.PROVIDER_TIMEOUT_MS}ms`);
      }
      throw new engines.EngineError('network', `provider unreachable: ${error?.message ?? error}`);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      // Providers usually explain themselves in a JSON body even on 4xx, which
      // beats showing the user a bare status code.
      const body = parseJson(text);
      const reported = typeof body?.error === 'string' ? body.error : null;
      const rateLimited = response.status === 429 || /rate|quota|limit/i.test(reported ?? '');
      const code = rateLimited
        ? 'rate-limit'
        : reported && response.status < 500
          ? 'provider'
          : 'http';
      throw new engines.EngineError(code, reported ?? `provider answered ${response.status}`, {
        status: response.status,
        detail: snippet(reported ?? text)
      });
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new engines.EngineError('format', 'provider returned a non-JSON body', {
        reason: 'json',
        detail: snippet(text)
      });
    }
  }

  async function withRetry(call) {
    let lastError;
    for (let attempt = 0; attempt <= C.PROVIDER_RETRIES; attempt += 1) {
      try {
        return await call();
      } catch (error) {
        lastError = error;
        const retryable =
          error instanceof engines.EngineError &&
          (RETRYABLE.has(error.code) || (error.code === 'http' && error.status >= 500));
        if (!retryable || attempt === C.PROVIDER_RETRIES) throw error;
        await sleep(200 * (attempt + 1));
      }
    }
    throw lastError;
  }

  // Unofficial Google endpoint: one GET per chunk, texts joined by newlines and
  // split back apart. When the split does not line up we redo the chunk one
  // text per request instead of guessing where the boundaries were.
  async function googleChunk({ endpoint, texts, source, target, fetchImpl }) {
    const url = new URL(endpoint);
    url.searchParams.set('client', 'gtx');
    url.searchParams.set('sl', alias('google', source || 'auto'));
    url.searchParams.set('tl', alias('google', target));
    url.searchParams.set('dt', 't');
    url.searchParams.set('q', texts.join('\n'));
    const data = await fetchJson(url.toString(), { fetchImpl });
    const segments = Array.isArray(data?.[0]) ? data[0] : null;
    if (!segments) {
      throw new engines.EngineError('format', 'unexpected Google response shape', {
        reason: 'shape',
        detail: snippet(JSON.stringify(data ?? null))
      });
    }
    const joined = segments
      .map((segment) => (Array.isArray(segment) && typeof segment[0] === 'string' ? segment[0] : ''))
      .join('');
    const detected = typeof data[2] === 'string' ? data[2] : null;
    const lines = joined.split('\n');
    if (lines.length !== texts.length) {
      throw new engines.EngineError('format', 'Google batch split mismatch', {
        reason: 'split',
        expected: texts.length,
        got: lines.length
      });
    }
    return { translations: lines, detected };
  }

  // Runs one size-bounded chunk. If Google's newline-joined reply cannot be
  // split back into the inputs, rerun the chunk as one request per text.
  async function googleRun(args) {
    try {
      return await withRetry(() => googleChunk(args));
    } catch (error) {
      if (error.reason !== 'split') throw error;
      AT.log('google split mismatch, retrying per text', args.texts.length);
      const translations = await mapLimit(args.texts, C.PROVIDER_CONCURRENCY, (text) =>
        withRetry(() => googleChunk({ ...args, texts: [text] })).then((result) => result.translations[0])
      );
      return { translations, detected: null };
    }
  }

  async function libreTranslateChunk({ endpoint, texts, source, target, apiKey, fetchImpl }) {
    const payload = {
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
      const code = /rate|quota|limit/i.test(data.error) ? 'rate-limit' : 'provider';
      throw new engines.EngineError(code, data.error.slice(0, 300));
    }
    const items = Array.isArray(data)
      ? data
      : Array.isArray(data?.contents)
        ? data.contents
        : typeof data?.translatedText === 'string'
          ? [data]
          : null;
    if (!items) {
      throw new engines.EngineError('format', 'unexpected LibreTranslate response shape', {
        reason: 'shape',
        detail: snippet(JSON.stringify(data ?? null))
      });
    }
    if (items.length !== texts.length) {
      throw new engines.EngineError('format', 'LibreTranslate returned an unexpected result count', {
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

  async function libreRun(args) {
    return withRetry(() => libreTranslateChunk(args));
  }

  const IMPLEMENTATIONS = { google: googleRun, libretranslate: libreRun };


  engines.needsTranslation = (text) =>
    typeof text === 'string' && text.trim().length > 1 && /[\p{L}\p{N}]/u.test(text);

  /**
   * @param {object} request
   * @param {string} request.engine id from C.ENGINES
   * @param {Record<string,string>} [request.endpoints]
   * @param {string} [request.apiKey]
   * @param {string[]} request.texts
   * @param {string} [request.source] 'auto' or a C.LANGS code
   * @param {string} request.target
   * @param {typeof fetch} [request.fetchImpl] injected by tests
   * @returns {Promise<{translations: string[], detected: string|null, engine: string, requested: number}>}
   */
  engines.translate = async (request = {}) => {
    const { engine = 'google', endpoints = {}, apiKey = '', texts = [], source = 'auto', target } = request;
    const meta = C.getEngineMeta(engine);
    if (!meta) throw new engines.EngineError('config', `unknown engine: ${engine}`);
    if (!Array.isArray(texts)) throw new engines.EngineError('config', 'texts must be an array');
    if (!C.isSupportedLang(target)) {
      throw new engines.EngineError('config', `unsupported target language: ${target}`);
    }
    const endpoint = resolveEndpoint(meta, endpoints);
    const implementation = IMPLEMENTATIONS[engine];
    if (typeof implementation !== 'function') {
      throw new engines.EngineError('config', `engine ${engine} has no implementation`);
    }

    if (texts.length === 0) return { translations: [], detected: null, engine, requested: 0 };

    const originals = texts.map((text) => (typeof text === 'string' ? text : ''));
    const pending = originals.filter((text) => engines.needsTranslation(text));
    const unique = [...new Set(pending)];
    if (unique.length === 0) return { translations: originals, detected: null, engine, requested: 0 };

    const limit = Math.max(
      100,
      Math.min(request.batchChars ?? meta.maxChars, meta.maxChars)
    );
    const args = { endpoint, source, target, apiKey: apiKey ?? '', fetchImpl: request.fetchImpl };
    const run = (chunk) => implementation({ ...args, texts: chunk });

    const chunks = chunkByChars(unique, limit);
    const batchOut = new Map();
    let detected = null;
    for (const chunk of chunks) {
      const result = await run(chunk);
      chunk.forEach((text, i) => batchOut.set(text, result.translations[i] ?? text));
      detected ??= result.detected;
    }

    const translations = originals.map((text) => {
      if (!engines.needsTranslation(text)) return text;
      const translated = batchOut.get(text);
      return typeof translated === 'string' && translated.length > 0 ? translated : text;
    });
    return { translations, detected, engine, requested: unique.length };
  };

  function resolveEndpoint(meta, endpoints) {
    const candidate = endpoints?.[meta.id] ?? meta.endpoint;
    const valid = AT.settings?.isValidEndpoint?.(candidate) ?? null;
    if (!valid) throw new engines.EngineError('config', `invalid endpoint for ${meta.id}: ${candidate}`);
    return valid;
  }

  engines.test = async (request = {}) => {
    const started = Date.now();
    const result = await engines.translate({ ...request, texts: [TEST_SENTENCE] });
    return {
      output: result.translations[0],
      detected: result.detected,
      engine: result.engine,
      ms: Date.now() - started
    };
  };

  engines.TEST_SENTENCE = TEST_SENTENCE;
})();

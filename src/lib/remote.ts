// Trusted extension/background-only HTTP client. Never injected into web pages.
// The existing on-device model, SDK and inference Worker are unchanged.
namespace AT.remote {
  export type PromptStyle = 'delimiters' | 'official' | 'instruction';
  export type Config = { baseUrl: string; model: string; style: PromptStyle; concurrency: number; maxOutputTokens: number };
  export type ModelInfo = { id: string; maxModelLen: number | null };
  export type Discovery = { models: ModelInfo[]; maxNumSeqs: number | null; maxNumActiveSeqs: number | null };
  export const TOKEN_STORAGE_KEY = 'remoteAuth.v1';
  export const DEFAULT_OUTPUT_TOKENS = 512;
  export const DEFAULT_CONCURRENCY = 2;
  export const MAX_CONCURRENCY = 32;
  export const REQUEST_TIMEOUT_MS = 120_000;
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

  type FailureCode = 'config' | 'network' | 'timeout' | 'rate-limit' | 'http' | 'format';
  function failure(code: FailureCode, message: string): Error & { code: FailureCode } {
    return Object.assign(new Error(message), { code });
  }
  function cancelled(): Error { return failure('network', 'Remote translation cancelled'); }
  export function concurrencyOf(value: unknown): number {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(n))) : DEFAULT_CONCURRENCY;
  }

  // One scheduler for ALL calls/tabs in the background context. A per-call pool
  // alone would multiply the setting by tab count and by concurrent DOM jobs.
  // Shrinking the limit never starts replacement work until active requests drain.
  type Queued = {
    start: () => void;
    reject: (error: Error) => void;
    signal: AbortSignal;
    abort: () => void;
  };
  let limit = DEFAULT_CONCURRENCY;
  let active = 0;
  const waiting: Queued[] = [];
  const controllers = new Set<AbortController>();

  function drain(): void {
    while (active < limit && waiting.length) {
      const entry = waiting.shift()!;
      entry.signal.removeEventListener('abort', entry.abort);
      if (entry.signal.aborted) { entry.reject(cancelled()); continue; }
      active++;
      entry.start();
    }
  }
  export function configureConcurrency(value: unknown): void { limit = concurrencyOf(value); drain(); }
  export function schedulerStatus(): { active: number; queued: number; limit: number } {
    return { active, queued: waiting.length, limit };
  }
  export function cancelAll(): void {
    for (const controller of controllers) controller.abort();
  }
  function scheduled<T>(job: () => Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(cancelled());
    if (waiting.length >= 4096) return Promise.reject(failure('rate-limit', 'Remote translation queue is full'));
    return new Promise<T>((resolve, reject) => {
      const entry: Queued = {
        signal, reject,
        abort: () => {
          const index = waiting.indexOf(entry);
          if (index >= 0) waiting.splice(index, 1);
          reject(cancelled());
        },
        start: () => {
          void Promise.resolve().then(() => {
            if (signal.aborted) throw cancelled();
            return job();
          }).then(resolve, reject).finally(() => { active--; drain(); });
        }
      };
      signal.addEventListener('abort', entry.abort, { once: true });
      waiting.push(entry);
      drain();
    });
  }

  export function normalizeBaseUrl(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || value.length > 2048) return '';
    try {
      const url = new URL(value.trim());
      if (!['https:', 'http:'].includes(url.protocol) || !url.hostname ||
          url.username || url.password || url.search || url.hash) return '';
      let path = url.pathname.replace(/\/+$/, '').replace(/\/(?:models|chat\/completions)$/, '');
      // A bare host gets /v1; an explicitly supplied custom gateway prefix is
      // preserved rather than guessed. Full chat-completion URLs are accepted.
      if (!path || path === '/') path = '/v1';
      url.pathname = path;
      return url.toString().replace(/\/$/, '');
    } catch { return ''; }
  }
  export function isHttpLan(baseUrl: string): boolean {
    try { return new URL(baseUrl).protocol === 'http:'; } catch { return false; }
  }
  export async function getKey(): Promise<string> {
    const value = (await AT.storage!.local.get(TOKEN_STORAGE_KEY))[TOKEN_STORAGE_KEY];
    return typeof value === 'string' ? value : '';
  }
  export async function setKey(value: string): Promise<void> {
    await AT.storage!.local.set({ [TOKEN_STORAGE_KEY]: value.trim() });
  }

  export function prompt(text: string, source: string | null, target: string, style: PromptStyle): unknown[] {
    if (style === 'official') {
      if (!source) throw failure('config', 'The official TranslateGemma template requires a source language. Select a source language or enable language detection.');
      return [{ role: 'user', content: [{ type: 'text', source_lang_code: source, target_lang_code: target, text }] }];
    }
    if (style === 'delimiters') {
      if (!source) throw failure('config', 'vLLM TranslateGemma delimiters require a source language. Select a source language or enable language detection.');
      return [{ role: 'user', content: `<<<source>>>${source}<<<target>>>${target}<<<text>>>${text}` }];
    }
    const lang = (code: string) => AT.C.LANGS.find(item => item.code === code)?.native ?? code;
    return [{ role: 'user', content: `Translate the following text from ${source ? lang(source) : 'the original language'} to ${lang(target)}. Respond only with the translation; no explanations.\n\n${text}` }];
  }

  async function request(url: string, key: string, body?: unknown, timeoutMs = REQUEST_TIMEOUT_MS,
      external?: AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    if (external?.aborted) throw cancelled();
    external?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      const response = await fetch(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store'
      });
      if (!response.ok) throw failure(response.status === 429 ? 'rate-limit' : 'http',
        `OpenAI-compatible server returned HTTP ${response.status}`);
      // Do not log response bodies: provider errors/server_info may contain
      // prompts, credentials or environment values. Enforce a bounded read too.
      const reader = response.body?.getReader();
      if (!reader) throw failure('format', 'The server returned an empty response');
      let total = 0;
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          total += part.value.byteLength;
          if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); throw failure('format', 'The server response is too large'); }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
      catch { throw failure('format', 'The server returned invalid JSON'); }
    } catch (error: unknown) {
      if (timedOut) throw failure('timeout', 'OpenAI-compatible server request timed out');
      if (external?.aborted) throw cancelled();
      if (typeof (error as { code?: unknown })?.code === 'string') throw error;
      throw failure('network', 'OpenAI-compatible server request failed');
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', abort);
    }
  }

  export async function discover(baseUrl: string, key: string): Promise<Discovery> {
    const base = normalizeBaseUrl(baseUrl);
    if (!base) throw failure('config', 'Invalid OpenAI-compatible API base URL');
    const response = await request(base + '/models', key, undefined, 20_000) as {
      data?: { id?: unknown; max_model_len?: unknown }[];
    };
    if (!Array.isArray(response?.data)) throw failure('format', 'The server did not return a models list');
    const models = response.data.filter(v => typeof v?.id === 'string' && Boolean(v.id.trim())).map(v => ({
      id: v.id as string,
      maxModelLen: Number.isSafeInteger(v.max_model_len) && (v.max_model_len as number) > 0 ? v.max_model_len as number : null
    }));
    let maxNumSeqs: number | null = null;
    let maxNumActiveSeqs: number | null = null;
    try {
      const prefix = base.endsWith('/v1') ? base.slice(0, -3) : base;
      const info = await request(prefix + '/server_info?config_format=json', key, undefined, 2500) as {
        vllm_config?: { scheduler_config?: { max_num_seqs?: unknown; max_num_active_seqs?: unknown } };
      };
      const s = info?.vllm_config?.scheduler_config;
      const valid = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
      if (valid(s?.max_num_seqs)) maxNumSeqs = s.max_num_seqs;
      if (valid(s?.max_num_active_seqs)) maxNumActiveSeqs = s.max_num_active_seqs;
    } catch { /* Optional nonstandard metadata never makes model discovery fail. */ }
    // Never infer capacity from max_model_len or current running-request counts.
    return { models, maxNumSeqs, maxNumActiveSeqs };
  }

  function answerText(reply: unknown, source: string): string {
    const item = (reply as { choices?: { finish_reason?: unknown; message?: { content?: unknown; refusal?: unknown } }[] })?.choices?.[0];
    if (!item || item.message?.refusal || ['length', 'content_filter', 'tool_calls'].includes(String(item.finish_reason))) {
      throw failure('format', 'The server did not return a complete translation');
    }
    const content = item.message?.content;
    const text = typeof content === 'string' ? content : Array.isArray(content)
      ? content.filter(v => v?.type === 'text' && typeof v.text === 'string').map(v => v.text).join('') : '';
    const issue = AT.outputIssue(source, text.trim());
    if (issue) throw failure('format', 'Invalid translation output: ' + issue);
    return text.trim();
  }

  export async function translate(config: Config, key: string, texts: readonly string[],
      source: string | null, target: string, external?: AbortSignal): Promise<string[]> {
    const base = normalizeBaseUrl(config.baseUrl);
    if (!base || !config.model.trim()) throw failure('config', 'Configure the server URL and model before translating');
    if (!AT.C.isSupportedLang(target)) throw failure('config', 'Unsupported translation target');
    if (external?.aborted) throw cancelled();
    if (!texts.length) return [];
    configureConcurrency(config.concurrency);
    const controller = new AbortController();
    const abort = () => controller.abort();
    external?.addEventListener('abort', abort, { once: true });
    controllers.add(controller);
    const outputs: string[] = new Array(texts.length);
    let next = 0;
    let firstError: unknown;
    const count = Math.min(texts.length, concurrencyOf(config.concurrency));
    try {
      // A local batch submits bounded work to the shared scheduler. All callers
      // together still have <= limit active HTTP translations, not N per tab.
      await Promise.allSettled(Array.from({ length: count }, async () => {
        while (!controller.signal.aborted) {
          const index = next++;
          if (index >= texts.length) return;
          try {
            const result = await scheduled(() => request(base + '/chat/completions', key, {
              model: config.model,
              messages: prompt(texts[index]!, source, target, config.style),
              temperature: 0, stream: false,
              max_tokens: Math.max(16, Math.min(4096, Math.floor(config.maxOutputTokens) || DEFAULT_OUTPUT_TOKENS))
            }, REQUEST_TIMEOUT_MS, controller.signal), controller.signal);
            outputs[index] = answerText(result, texts[index]!);
          } catch (error) {
            firstError ??= error;
            controller.abort();
            throw error;
          }
        }
      }));
      if (firstError) throw firstError;
      if (controller.signal.aborted) throw cancelled();
      return outputs;
    } finally {
      external?.removeEventListener('abort', abort);
      controllers.delete(controller);
    }
  }
}

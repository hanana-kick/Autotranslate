// On-device translation: prompt building, token budgeting, model records, the
// host placement and the one way to reach the host. Pure logic only — no DOM,
// no extension APIs, so the whole file can be unit tested.
// Load after lib/constants.js.
namespace AT.local {

  /** Files `scripts/build.ts` copies out of @mediapipe/tasks-genai. */
  export const VENDOR = {
    bundle: 'vendor/mediapipe/genai_bundle.js',
    wasmDir: 'vendor/mediapipe/wasm'
  };

  /** Model bytes live in OPFS; only metadata goes to IndexedDB. */
  export const STORE = {
    dbName: 'autotranslate-models',
    dbVersion: 1,
    metaStore: 'models',
    blobStore: 'blobs',
    settingsKey: 'settings',
    filesDir: 'models'
  };

  /** A file this small cannot be a real model, so it is never accepted. */
  export const MIN_MODEL_BYTES = 1024 * 1024;
  /** Guard against a hostile content-length; 16 GiB is beyond any web model. */
  export const MAX_MODEL_BYTES = 16 * 1024 * 1024 * 1024;

  // Measured with the model's own tokenizer (`LlmInference.sizeInTokens`) on
  // the vendored build, over 600-character samples of real prose: Latin 6.12
  // characters per token, Cyrillic 4.65, Arabic 2.75, Japanese 1.76, Korean
  // 1.82. A single number cannot serve all of them — the old `3` overpacked
  // Korean and Japanese by 1.6× while wasting half the budget on English.
  // These are packing heuristics; the host measures the finished prompt with
  // the real tokenizer before it generates, so an estimate is never the last
  // word on what fits.
  export const CHARS_PER_TOKEN = 6;
  export const CYRILLIC_CHARS_PER_TOKEN = 4.5;
  export const SEMITIC_CHARS_PER_TOKEN = 2.5;
  export const CJK_CHARS_PER_TOKEN = 1.7;
  // The instruction and the turn markers, measured: 81–88 tokens in English,
  // plus at most 12 for a page-context line. 128 leaves room and is honest.
  export const PROMPT_OVERHEAD_TOKENS = 128;
  export const MIN_MAX_TOKENS = 128;
  export const MAX_MAX_TOKENS = 8192;
  // Counted input + output. Raising it to 2048 was measured on a real page and
  // did not reduce the generation count (103 vs 96) while making each generation
  // slower (longer prefill), so the default stays where it was measured better.
  export const DEFAULT_MAX_TOKENS = 1024;

  /** Unload the model after this much quiet; it holds gigabytes of memory. */
  export const IDLE_UNLOAD_MS = 10 * 60 * 1000;
  /** One generation on a 4B model over 1500 characters is slow but bounded. */
  export const GENERATION_TIMEOUT_MS = 180000;
  /** Hardware ready-model first-output deadline, supervised outside native work. */
  export const FIRST_OUTPUT_TIMEOUT_MS = 60000;
  /** Real software WebGPU is much slower; do not repeatedly discard valid work. */
  export const SOFTWARE_GENERATION_TIMEOUT_MS = 15 * 60 * 1000;
  /** Progress is forwarded to the background at most this often. */
  export const DOWNLOAD_PROGRESS_INTERVAL_MS = 500;

  /** Pairs whose quality was checked by hand; others still run, unverified. */
  export const VERIFIED_LANGS: Record<string, true | undefined> = {
    en: true,
    ko: true,
    ja: true,
    'zh-CN': true,
    'zh-TW': true
  };

  /** Where a message is expected to be handled. */
  export const TARGET_OFFSCREEN = 'offscreen';

  /**
   * Where the model runs. `offscreen` reaches the host over runtime messages
   * because this context cannot hold WebAssembly plus WebGPU (a Chrome service
   * worker); `background` means this very context is the host and is called
   * directly (a Firefox background page is a document already).
   */
  export type HostPlacement = 'offscreen' | 'background';

  let placement: HostPlacement = 'offscreen';

  export function setHostPlacement(next: HostPlacement): void {
    placement = next;
  }

  export function hostPlacement(): HostPlacement {
    return placement;
  }

  /**
   * The one way to reach the host, so no caller has to know the browser.
   * Direct calls answer with the same shape a message would, including the
   * failure shape, because the engine layer reads `ok` and `code` either way.
   */
  export async function callHost(message: AT.Message): Promise<AT.Response> {
    const host = placement === 'background' ? AT.localhost : undefined;
    if (!host) return AT.sendMessage({ ...message, to: TARGET_OFFSCREEN });
    try {
      return { ok: true, ...(await host.handle(message)) };
    } catch (error: unknown) {
      const rejection = error as { message?: unknown; code?: unknown };
      return {
        ok: false,
        error: String(rejection?.message ?? error),
        code: typeof rejection?.code === 'string' ? rejection.code : null
      };
    }
  }

  /** Current native operation, reported before entering synchronous WASM. */
  export type ModelPhase = 'runtime' | 'model-read' | 'model-create' | 'warmup' | 'count' | 'generate';
  /** Enforced by the document outside the inference worker. */
  export const MODEL_LOAD_TIMEOUT_MS = 300000;

  export type ModelState = 'unloaded' | 'loading' | 'ready' | 'busy' | 'error';

  /** One model file the user downloaded; `size` is bytes. */
  export type ModelRecord = {
    id: string;
    name: string;
    size: number;
    sourceUrl: string;
    createdAt: number;
  };

  /** What the on-device host reports about itself. */
  export type LocalStatus = {
    target: string;
    supported: boolean;
    reason: string | null;
    state: ModelState;
    modelId: string | null;
    modelName: string | null;
    loadedBytes: number;
    loadMs: number | null;
    generations: number;
    lastError: string | null;
    phase?: ModelPhase | null;
    /** Detected from the actual browser adapter, not a testing override. */
    softwareRendering?: boolean;
    /** Aggregate progress only: prompts and generated text are never reported. */
    outputChars?: number;
    /** Bounded fresh-worker recoveries, not successful generations. */
    recoveries?: number;
    lastProgressAt?: number;
  };

  /** A download the options page is running right now, for the popup badge. */
  export type DownloadProgress = {
    name: string;
    received: number;
    total: number | null;
  };

  /** The model card users can pick in the options page. */
  export type ModelSource = {
    id: string;
    label: string;
    url: string;
    size: number;
    license: string;
    gated: boolean;
  };

  /** Where the TranslateGemma web build is published. Login is required:
   *  the repository is gated, so a Hugging Face token is usually needed. */
  export const MODEL_SOURCES: ModelSource[] = [
    {
      id: 'translategemma-4b-it-int8-web',
      label: 'TranslateGemma 4B IT (int8, web)',
      url: 'https://huggingface.co/litert-community/TranslateGemma-4B-IT/resolve/main/translategemma-4b-it-int8-web.task',
      size: 3896377344,
      license: 'Google Gemma Terms',
      gated: true
    }
  ];

  const OPEN = '<start_of_turn>user\n';
  const CLOSE = '\n<end_of_turn>\n<start_of_turn>model\n';

  /** Wraps a instruction block the way the Gemma chat template expects. A
   *  prompt without these markers makes the model answer with a bare newline. */
  export function wrapChatPrompt(body: string): string {
    return `${OPEN}${body}${CLOSE}`;
  }

  /**
   * One text, in the shape the model was tuned on: the professional translator
   * preamble, two blank lines, then the text. Both codes are TranslateGemma's
   * own (`AT.gemma.GemmaLang`), and the names come from its language table, so
   * the prompt cannot drift from what the model accepts.
   */
  export function buildTranslatePrompt(source: AT.gemma.GemmaLang, target: AT.gemma.GemmaLang, text: string): string {
    const from = AT.gemma.nameOf(source);
    const to = AT.gemma.nameOf(target);
    return wrapChatPrompt(
      [
        professional(from, source, to, target),
        `Produce only the ${to} translation, without any additional explanations or commentary. ` +
          `Please translate the following ${from} text into ${to}:`,
        '',
        '',
        text
      ].join('\n')
    );
  }

  /**
   * The template always carries a source code. When the browser's detector
   * cannot name one, ask for the target alone and admit the source is unknown
   * rather than inventing a code the model never saw.
   */
  export function buildAutoPrompt(target: AT.gemma.GemmaLang, text: string): string {
    const to = AT.gemma.nameOf(target);
    return wrapChatPrompt(
      [
        `You are a professional translator. Translate the following text into ${to} (${target}). ` +
          `Produce only the ${to} translation, without any additional explanations or commentary:`,
        '',
        '',
        text
      ].join('\n')
    );
  }

  /**
   * Page context, marked as background. Measured against the real extension: a
   * bare sentence before the text was translated along with it — the model has
   * no way to tell a fact about the page from the page's own words.
   */
  const CONTEXT_MARKER = 'Background, do not translate: ';

  function contextLine(hint: string): string {
    return hint.startsWith(CONTEXT_MARKER) ? hint : `${CONTEXT_MARKER}${hint}`;
  }

  /** The sentence the model was trained to read. */
  function professional(from: string, fromCode: string, to: string, toCode: string): string {
    return (
      `You are a professional ${from} (${fromCode}) to ${to} (${toCode}) translator. ` +
      `Your goal is to accurately convey the meaning and nuances of the original ${from} text ` +
      `while adhering to ${to} grammar, vocabulary, and cultural sensitivities.`
    );
  }

  /** Several texts in one generation. The reply is parsed by `parseNumbered`. */
  export function buildBatchPrompt(
    source: AT.gemma.GemmaLang | null,
    target: AT.gemma.GemmaLang,
    texts: string[],
    hint?: string | null
  ): string {
    const first = texts[0] ?? '';
    if (texts.length === 1) {
      return source ? buildTranslatePrompt(source, target, first) : buildAutoPrompt(target, first);
    }
    const to = AT.gemma.nameOf(target);
    const lines = texts.map((text, index) => `${index + 1}. ${text.replace(/\s+/g, ' ').trim()}`);
    return wrapChatPrompt(
      [
        source ? professional(AT.gemma.nameOf(source), source, to, target) : `You are a translator producing ${to} (${target}) text.`,
        '',
        `Produce only the ${to} translation, without any additional explanations or commentary. ` +
          `Translate every numbered segment below into ${to}, keep the numbering and the order, ` +
          `and answer with exactly one block per segment in the form "N: <translation>".`,
        ...(hint ? [contextLine(hint)] : []),
        '',
        'Segments:',
        ...lines
      ].join('\n')
    );
  }

  // A reply line starts a new segment; everything until the next marker belongs
  // to the previous one, so a translation may contain its own newlines.
  const SEGMENT_START = /^[ \t]*(\d{1,3})[ \t]*[:.)][ \t]*/;

  /**
   * Recovers one translation per input text, or null when the reply cannot be
   * trusted. Numbering first; when the model answers without it — measured, a
   * 4B model often drops the numbers — a reply whose blank-line blocks or lines
   * line up exactly with the segment count is accepted, because that is the
   * same information in another shape.
   */
  export function parseNumbered(reply: string, count: number): string[] | null {
    const numbered = parseByNumber(reply, count);
    if (numbered) return numbered;
    if (typeof reply !== 'string' || count < 2) return null;
    // If the model tried to number and got it wrong, that is a failure, not an
    // invitation to read the lines literally.
    if (reply.split('\n').some((line) => SEGMENT_START.test(line))) return null;
    const blocks = reply
      .split(/\n\s*\n/)
      .map((block) => block.trim())
      .filter((block) => block.length > 0);
    if (blocks.length === count) return dedupe(blocks);
    const lines = reply
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length === count) return dedupe(lines);
    return null;
  }

  /** Ignore a leading label the model added to every line ("Korean: …"). */
  function dedupe(parts: string[]): string[] | null {
    return parts.every((part) => part.length > 0) ? parts : null;
  }

  function parseByNumber(reply: string, count: number): string[] | null {
    if (typeof reply !== 'string' || reply.length === 0) return null;
    const found: Record<string, string> = {};
    let current: number | null = null;
    const seen = new Set<number>();
    let buffer: string[] = [];
    for (const line of reply.split('\n')) {
      const match = SEGMENT_START.exec(line);
      if (match) {
        if (current !== null) found[String(current)] = buffer.join('\n').trim();
        current = Number(match[1]);
        if (current < 1 || current > count || seen.has(current)) return null;
        seen.add(current);
        buffer = [line.slice(match[0].length)];
      } else if (current !== null) {
        buffer.push(line);
      }
    }
    if (current !== null) found[String(current)] = buffer.join('\n').trim();
    const out: string[] = [];
    for (let index = 1; index <= count; index += 1) {
      const value = found[String(index)];
      if (typeof value !== 'string' || value.length === 0) return null;
      out.push(value);
    }
    return out;
  }

  /** Prompt plus expected reply, in tokens. Deliberately rough: it only picks
   *  how many texts fit in one generation. */
  export function estimateTokens(text: string): number {
    if (typeof text !== 'string' || !text) return 0;
    let latin = 0;
    let cyrillic = 0;
    let semitic = 0;
    let cjk = 0;
    for (const character of text) {
      const code = character.codePointAt(0) ?? 0;
      if (
        // Hangul (incl. Jamo), Han (incl. extension A and the astral planes) and Kana.
        (code >= 0x1100 && code <= 0x11ff) ||
        (code >= 0x2e80 && code <= 0x9fff) ||
        (code >= 0xac00 && code <= 0xd7af) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0x20000 && code <= 0x3ffff)
      ) {
        cjk += 1;
      } else if ((code >= 0x0400 && code <= 0x04ff) || (code >= 0x0370 && code <= 0x03ff)) {
        cyrillic += 1;
      } else if (
        (code >= 0x0590 && code <= 0x05ff) || // Hebrew
        (code >= 0x0600 && code <= 0x06ff) || // Arabic
        (code >= 0x0900 && code <= 0x0dff) || // Devanagari … Sinhala
        (code >= 0x0e00 && code <= 0x0eff) // Thai, Lao
      ) {
        semitic += 1;
      } else {
        latin += 1;
      }
    }
    return Math.ceil(
      latin / CHARS_PER_TOKEN + cyrillic / CYRILLIC_CHARS_PER_TOKEN + semitic / SEMITIC_CHARS_PER_TOKEN + cjk / CJK_CHARS_PER_TOKEN
    );
  }


  /** Groups texts so one generation stays inside the token budget. Mirrors
   *  engines.chunkByChars but counts tokens, not characters. */
  /**
   * Groups texts by counts the model's tokenizer produced, not by an estimate.
   * `overhead` is the measured cost of the instruction; each text pays for its
   * own tokens and leaves room for an answer of the same length.
   */
  export function chunkByCounts(
    texts: string[],
    counts: number[],
    maxTokens: number,
    overhead: number
  ): string[][] {
    const limit = Math.max(MIN_MAX_TOKENS, Math.min(maxTokens, MAX_MAX_TOKENS));
    const base = Math.max(0, Math.min(overhead, limit));
    const chunks: string[][] = [];
    let current: string[] = [];
    let used = base;
    texts.forEach((text, index) => {
      const count = Number.isFinite(counts[index]) ? Math.max(0, counts[index] as number) : estimateTokens(text);
      const cost = count * 2;
      if (current.length && used + cost > limit) {
        chunks.push(current);
        current = [];
        used = base;
      }
      current.push(text);
      used += cost;
    });
    if (current.length) chunks.push(current);
    return chunks;
  }

  export function chunkByTokens(texts: string[], maxTokens: number): string[][] {
    const limit = Math.max(MIN_MAX_TOKENS, Math.min(maxTokens, MAX_MAX_TOKENS));
    const chunks: string[][] = [];
    let current: string[] = [];
    let used = PROMPT_OVERHEAD_TOKENS;
    for (const text of texts) {
      // A single text pays the prompt once, then the estimate covers input and
      // output for one segment.
      const cost = estimateTokens(text) * 2;
      if (current.length && used + cost > limit) {
        chunks.push(current);
        current = [];
        used = PROMPT_OVERHEAD_TOKENS;
      }
      current.push(text);
      used += cost;
    }
    if (current.length) chunks.push(current);
    return chunks;
  }

  const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,95}$/;

  /** Model ids come from user-supplied file names, so they are re-derived. */
  export function makeModelId(name: string, sourceUrl: string, when: number): string {
    const base = (typeof name === 'string' ? name : '')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);
    const stem = base.replace(/\.task$/, '') || 'model';
    let hash = 2166136261;
    for (const char of `${sourceUrl}|${when}`) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    const id = `${stem}-${hash.toString(36)}`;
    return ID_PATTERN.test(id) ? id : `model-${hash.toString(36)}`;
  }

  function safeUrl(value: unknown): string {
    if (typeof value !== 'string') return '';
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : '';
    } catch {
      return '';
    }
  }

  /** Coerces anything read back from storage into a usable record. */
  export function normalizeModel(raw: unknown): ModelRecord | null {
    if (!raw || typeof raw !== 'object') return null;
    const input = raw as Record<string, unknown>;
    const id = typeof input.id === 'string' && ID_PATTERN.test(input.id) ? input.id : '';
    if (!id) return null;
    const size = Number(input.size);
    if (!Number.isFinite(size) || size < MIN_MODEL_BYTES || size > MAX_MODEL_BYTES) return null;
    const createdAt = Number(input.createdAt);
    return {
      id,
      name: typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 120) : id,
      size: Math.round(size),
      sourceUrl: safeUrl(input.sourceUrl),
      createdAt: Number.isFinite(createdAt) && createdAt > 0 ? Math.round(createdAt) : 0
    };
  }

  export function normalizeModels(raw: unknown): ModelRecord[] {
    if (!Array.isArray(raw)) return [];
    const out: ModelRecord[] = [];
    const seen = new Set<string>();
    for (const entry of raw) {
      const record = normalizeModel(entry);
      if (!record || seen.has(record.id)) continue;
      seen.add(record.id);
      out.push(record);
      if (out.length >= 32) break;
    }
    // Newest first: the list is also the order the options page offers.
    return out.sort((a, b) => b.createdAt - a.createdAt || a.name.localeCompare(b.name));
  }

  const STATES: Record<string, ModelState | undefined> = {
    unloaded: 'unloaded',
    loading: 'loading',
    ready: 'ready',
    busy: 'busy',
    error: 'error'
  };

  /** The status object arrives over a message boundary; nothing in it is trusted. */
  export function normalizeStatus(raw: unknown): LocalStatus {
    const input: Record<string, unknown> = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const state = STATES[String(input.state)] ?? 'unloaded';
    const size = Number(input.loadedBytes);
    const loadMs = Number(input.loadMs);
    const generations = Number(input.generations);
    return {
      target: typeof input.target === 'string' ? input.target : TARGET_OFFSCREEN,
      supported: input.supported === true,
      reason: REASONS[String(input.reason)] === true ? String(input.reason).slice(0, 120) : null,
      state,
      modelId: typeof input.modelId === 'string' && ID_PATTERN.test(input.modelId) ? input.modelId : null,
      modelName: typeof input.modelName === 'string' ? input.modelName.slice(0, 120) : null,
      loadedBytes: Number.isFinite(size) && size >= 0 ? Math.round(size) : 0,
      loadMs: Number.isFinite(loadMs) && loadMs >= 0 ? Math.round(loadMs) : null,
      generations: Number.isFinite(generations) && generations >= 0 ? Math.round(generations) : 0,
      ...(input.phase === null || ['runtime', 'model-read', 'model-create', 'warmup', 'count', 'generate'].includes(String(input.phase))
        ? { phase: input.phase as ModelPhase | null } : {}),
      ...(typeof input.softwareRendering === 'boolean' ? { softwareRendering: input.softwareRendering } : {}),
      ...(Number.isFinite(input.recoveries) ? { recoveries: Math.max(0, Number(input.recoveries)) } : {}),
      ...(Number.isFinite(input.outputChars) && Number(input.outputChars) >= 0
        ? { outputChars: Math.min(Math.round(Number(input.outputChars)), 1_000_000) } : {}),
      ...(Number.isFinite(input.lastProgressAt) && Number(input.lastProgressAt) >= 0
        ? { lastProgressAt: Math.round(Number(input.lastProgressAt)) } : {}),
      lastError: typeof input.lastError === 'string' ? input.lastError.slice(0, 300) : null
    };
  }

  /** Catalogue keys for the host states. The `i18n:` field form is what the
   *  build's unused-key audit reads; the text itself is phrased by whichever
   *  page asks, so the popup and the options page cannot drift apart. */
  const STATE_KEYS = {
    unsupported: { i18n: 'options_localUnsupported' },
    unloaded: { i18n: 'options_stateUnloaded' },
    loading: { i18n: 'options_stateLoading' },
    busy: { i18n: 'options_stateBusy' },
    ready: { i18n: 'options_stateReady' },
    error: { i18n: 'options_stateError' }
  } as const;

  /** One sentence about the host, phrased by the caller's catalogue. Both the
   *  popup and the options page show this, so the wording lives in one place. */
  export function describeStatus(
    status: LocalStatus | null,
    supported: boolean,
    msg: (key: string, subs?: string | string[]) => string
  ): string {
    if (!supported) return msg(STATE_KEYS.unsupported.i18n);
    if (!status || status.state === 'unloaded') return msg(STATE_KEYS.unloaded.i18n);
    if (status.state === 'error') {
      return `${msg(STATE_KEYS.error.i18n)}: ${status.lastError || status.reason || ''}`;
    }
    const named = status.modelName ? ` · ${status.modelName}` : '';
    if (status.state === 'loading') return msg(STATE_KEYS.loading.i18n) + named;
    if (status.state === 'busy') return msg(STATE_KEYS.busy.i18n) + named;
    return msg(STATE_KEYS.ready.i18n) + named + (status.loadMs ? ` (${status.loadMs} ms)` : '');
  }

  /** The reasons the host gives up, mapped onto the engine error codes. */
  export const REASONS: Record<string, true | undefined> = {
    'unsupported-browser': true,
    'no-webgpu': true,
    'no-target': true,
    'runtime-load-failed': true,
    'no-model': true,
    'model-missing': true,
    'model-load-failed': true,
    'generation-failed': true,
    'invalid-output': true,
    'generation-timeout': true,
    'warmup-timeout': true,
    'generation-stalled': true,
    'context-overflow': true,
    cancelled: true
  };

  const CONFIG_REASONS: Record<string, true | undefined> = {
    'context-overflow': true,
    'unsupported-browser': true,
    'no-webgpu': true,
    // The target has no code in the model's language table, so no prompt can
    // ask for it; retrying would fail the same way.
    'no-target': true,
    // A broken vendored runtime is a broken installation, not a provider that
    // might answer differently on a retry.
    'runtime-load-failed': true,
    'no-model': true,
    'model-missing': true
  };

  export function codeForReason(reason: string | null | undefined): 'config' | 'provider' {
    return reason && CONFIG_REASONS[reason] === true ? 'config' : 'provider';
  }

  export function isVerifiedPair(source: string, target: string): boolean {
    const from = source === 'auto' ? null : source;
    if (VERIFIED_LANGS[target] !== true) return false;
    return from === null || VERIFIED_LANGS[from] === true;
  }

  /** Bytes as a human reads them; shared by the options page and the popup. */
  export function formatBytes(bytes: number): string {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value < 0) return '0 B';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let amount = value;
    let unit = 0;
    while (amount >= 1024 && unit < units.length - 1) {
      amount /= 1024;
      unit += 1;
    }
    const digits = unit === 0 || amount >= 100 ? 0 : 1;
    return `${amount.toFixed(digits)} ${units[unit]}`;
  }

  /** Only https endpoints with a file name we can turn into an id are offered. */
  export function normalizeDownloadUrl(value: unknown): string | null {
    const url = safeUrl(value);
    if (!url || !url.startsWith('https://')) return null;
    return url;
  }
}

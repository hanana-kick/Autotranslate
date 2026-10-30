import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const SRC = join(ROOT, 'src');
export const BUILD_TS = join(ROOT, 'build', 'ts', 'src');

/**
 * The namespace is assembled by `eval` at runtime, so there is no static shape
 * to recover across that boundary; the `any` here is deliberate.
 */
export type ATNamespace = Record<string, any>;

/** A fetch init stand-in, narrowed to the members the tests actually read. */
export type FetchInit = {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

/** The Response surface engines.js depends on. */
export type FetchResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  text: () => Promise<string>;
};

export type FetchCall = { url: string; init: FetchInit };

/** Answers one request; it may also throw. */
export type FetchHandler = (url: string, init: FetchInit) => FetchResponse | Promise<FetchResponse>;

/** Loads compiled extension sources as classic scripts, the way the browsers do. */
export function load(...files: string[]): ATNamespace {
  for (const file of files) (0, eval)(readFileSync(join(BUILD_TS, file), 'utf8'));
  return (globalThis as ATNamespace).AT as ATNamespace;
}

export function resetGlobals(): void {
  const host = globalThis as ATNamespace;
  delete host.AT;
  delete host.browser;
  delete host.chrome;
}

/** Minimal Response stand-in: engines.js only ever calls .text(). */
export function response(status: number, body: unknown): FetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  };
}

/** Records every call and answers from `handler`, which may throw. */
export function fetchStub(handler: FetchHandler) {
  const calls: FetchCall[] = [];
  const fetchImpl = async (url: string, init: FetchInit = {}): Promise<FetchResponse> => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { calls, fetchImpl };
}

export function json(body: unknown, status = 200): FetchResponse {
  return response(status, body);
}

/** A promise with its settle functions: tests decide when one resolves. */
export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((fill, fail) => {
    resolve = fill;
    reject = fail;
  });
  return { promise, resolve, reject };
}

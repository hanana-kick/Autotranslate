import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const SRC = join(ROOT, 'src');

/** Loads extension sources as classic scripts, the way the browsers do. */
export function load(...files) {
  for (const file of files) (0, eval)(readFileSync(join(SRC, file), 'utf8'));
  return globalThis.AT;
}

export function resetGlobals() {
  delete globalThis.AT;
  delete globalThis.browser;
  delete globalThis.chrome;
}

/** Minimal Response stand-in: engines.js only ever calls .text(). */
export function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
  };
}

/** Records every call and answers from `handler`, which may throw. */
export function fetchStub(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { calls, fetchImpl };
}

export function json(body, status = 200) {
  return response(status, body);
}

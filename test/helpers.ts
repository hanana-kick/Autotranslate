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

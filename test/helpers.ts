import { readFileSync, statSync } from 'node:fs';
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

export function load(...files: string[]): ATNamespace {
  for (const file of files) {
    // The suites eval the compiled output, so a stale build silently tests the
    // previous revision. Say so instead of reporting a green run for old code.
    const compiled = join(BUILD_TS, file);
    const source = join(SRC, file.replace(/\.js$/, '.ts'));
    try {
      if (statSync(source).mtimeMs > statSync(compiled).mtimeMs) {
        throw new Error(`${file} is older than ${source}: run \`npm run build\` (or \`npx tsc -p tsconfig.json\`) first`);
      }
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes('older than')) throw error;
      // A missing source is fine: some files are generated.
    }
    (0, eval)(readFileSync(compiled, 'utf8'));
  }
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

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

/** How much of a GGUF `AT.modelstore` holds back while it rewrites the tokenizer
 *  tag. A scripted download has to serve that much of its header as real bytes
 *  or the ingest never gets far enough to patch it. */
export const GGUF_PROBE_BYTES = 1 << 20;

/**
 * The head of a PLaMo GGUF file: the magic, version 3, a tensor count and the
 * metadata section `AT.modelstore`'s ingest reads, padded to the size the ingest
 * probes. The tokenizer tag is the one a converted file carries (`plamo3`), and
 * an array of strings sits ahead of it so a walker that only understood scalars
 * would never reach the key.
 */
export function ggufHead(model = 'plamo3', architecture = 'plamo3'): Uint8Array {
  const parts: number[] = [];
  const u32 = (value: number): void => {
    for (let shift = 0; shift < 4; shift += 1) parts.push((value / 2 ** (8 * shift)) & 0xff);
  };
  const u64 = (value: number): void => {
    for (let shift = 0; shift < 8; shift += 1) parts.push(Math.floor(value / 2 ** (8 * shift)) & 0xff);
  };
  const raw = (value: Uint8Array): void => {
    for (const one of value) parts.push(one);
  };
  const string = (value: string): void => {
    const encoded = new Uint8Array(Buffer.from(value, 'utf8'));
    u64(encoded.length);
    raw(encoded);
  };
  raw(new Uint8Array(Buffer.from('GGUF', 'utf8')));
  u32(3); // version
  u64(1); // n_tensors
  u64(4); // n_kv
  string('general.architecture');
  u32(8);
  string(architecture);
  string('tokenizer.ggml.added_tokens');
  u32(9); // array
  u32(8); // of string
  u64(2);
  string('<|plamo:tag|>');
  string('<|plamo:bos|>');
  string('tokenizer.ggml.pre');
  u32(8);
  string('default');
  string('tokenizer.ggml.model');
  u32(8);
  string(model);
  // The rest of the probe is zeros: the walker stops at the last metadata entry,
  // so nothing reads past it.
  const bytes = Uint8Array.from(parts);
  const padded = new Uint8Array(GGUF_PROBE_BYTES);
  padded.set(bytes, 0);
  return padded;
}

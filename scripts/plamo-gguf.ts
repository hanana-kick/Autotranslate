// Builds the BF16 GGUF the PLaMo 3 Translate engine is carded against, from
// PFN's BF16 safetensors, and prints what the publisher needs from the result.
//
//   node scripts/plamo-gguf.ts                    # download, convert, patch, verify
//   node scripts/plamo-gguf.ts --check            # validate the GGUF the cache holds
//   node scripts/plamo-gguf.ts --check --gguf=dist/plamo-3-translate-0.8b-BF16.gguf
//   node scripts/plamo-gguf.ts --patch            # rewrite the tokenizer key, nothing else
//   node scripts/plamo-gguf.ts --dry-run          # print the plan, touch nothing
//   node scripts/plamo-gguf.ts --force            # wipe .cache/plamo and start again
//
// PFN publishes GGUF quants but not BF16: the GGUF card says so itself, "GGUF
// BF16 in that table is a reference value for comparison and is not
// distributed". The on-device engine is carded against the BF16 reference
// weights, so the BF16 GGUF has to come from here — from the safetensors,
// through upstream's own converter, pinned to the release that carries the
// plamo3 model (`src/models/plamo3.cpp`) and registers `Plamo3ForCausalLM` in
// `conversion/plamo.py`.
//
// Everything lands under .cache/plamo/, which is scratch: it can be deleted at
// any time and the next run rebuilds it. Only the downloads are expensive, so
// every step skips work it has already done; `--force` is the only path that
// throws bytes away. No dependencies beyond Node builtins; the converter runs
// in a venv this script owns.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync, createReadStream, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync,
  renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync
} from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CACHE = join(ROOT, '.cache', 'plamo');
const MODEL_DIR = join(CACHE, 'hf');
const LLAMA_DIR = join(CACHE, 'llama.cpp');
const VENV_DIR = join(CACHE, 'venv');
const OUT_DIR = join(CACHE, 'out');
const ARTIFACT = 'plamo-3-translate-0.8b-BF16.gguf';
const GGUF_PATH = join(OUT_DIR, ARTIFACT);
const LLAMA_STAMP = join(CACHE, 'llama.cpp.stamp');
const VENV_STAMP = join(CACHE, 'venv.stamp');

const HF_REPOSITORY = 'pfnet/plamo-3-translate-0.8b';
const HF_BASE = `https://huggingface.co/${HF_REPOSITORY}/resolve/main/`;
const SAFETENSORS_BYTES = 1780709128;
/** Bytes between two progress lines; the weights take minutes, not seconds. */
const PROGRESS_STEP = 32 << 20;

/** The files `convert_hf_to_gguf.py` reads for this architecture: the config,
 *  the tokenizer pair, the remote-code modules `auto_map` points at, the chat
 *  template the GGUF embeds, and the weights. `tokenizer.jsonl` rather than
 *  `tokenizer.json` because the PLaMo vocabulary is a JSONL list the converter
 *  walks line by line. Sizes are the published ones — the weights are the only
 *  file big enough to be worth pinning, and a size mismatch there means the
 *  release moved under us. */
const HF_FILES: { name: string; bytes: number | null }[] = [
  { name: 'config.json', bytes: null },
  { name: 'generation_config.json', bytes: null },
  { name: 'tokenizer_config.json', bytes: null },
  { name: 'special_tokens_map.json', bytes: null },
  { name: 'tokenizer.jsonl', bytes: null },
  { name: 'tokenization_plamo.py', bytes: null },
  { name: 'modeling_plamo.py', bytes: null },
  { name: 'chat_template.jinja', bytes: null },
  { name: 'model.safetensors', bytes: SAFETENSORS_BYTES }
];

/** Pinned, so a rebuild is a rebuild and not whatever landed this week. v0.9.0
 *  is the release that has both halves of plamo3: the inference model and the
 *  HF-side loader. The clone is sparse because the converter is all this script
 *  needs out of a repository that is mostly C++. */
const LLAMA_CPP_REPOSITORY = 'https://github.com/ggml-org/llama.cpp';
const LLAMA_CPP_REF = 'v0.9.0';
/** The clone is cone-mode sparse, which always keeps the files at the root of
 *  the repository, so listing the two directories is enough to get
 *  `convert_hf_to_gguf.py` plus everything it imports. A file cannot be listed
 *  as a pattern: git refuses it (`'convert_hf_to_gguf.py' is not a directory`). */
const LLAMA_CPP_CONVERTER = 'convert_hf_to_gguf.py';
const LLAMA_CPP_SPARSE = ['gguf-py', 'conversion'];

/** Upstream's `requirements/requirements-convert_hf_to_gguf.txt` pins
 *  `torch==2.11.0`, which has no wheel for the Python this machine runs. The
 *  pin is upstream's CI floor, not a requirement of this model, so torch is
 *  installed unpinned from the CPU index — the same `/whl/cpu` index that file
 *  adds itself. `gguf` is deliberately not installed: the pinned clone's
 *  `gguf-py` goes on PYTHONPATH instead, so the metadata writer and the
 *  converter are guaranteed to be the same version. */
const TORCH_INDEX = 'https://download.pytorch.org/whl/cpu';
const CONVERTER_PACKAGES = ['numpy', 'sentencepiece', 'tqdm', 'transformers'];

const EXPECTED_BYTES = 1783495808;
const EXPECTED_TENSORS = 163;
const EXPECTED_ARCHITECTURE = 'plamo3';
const KEY_ARCHITECTURE = 'general.architecture';
const TOKENIZER_MODEL_KEY = 'tokenizer.ggml.model';
const KEY_TOKENIZER_PRE = 'tokenizer.ggml.pre';
const KEY_FILE_TYPE = 'general.file_type';
/** `gguf_type` MOSTLY_BF16: what `--outtype bf16` writes — BF16 matrices with
 *  the 1-D norms left as F32. */
const GGUF_FILE_TYPE_MOSTLY_BF16 = 32;

/** wllama 3.8.1's wasm carries the plamo3 architecture but not
 *  `llm_tokenizer_plamo3`, so an unpatched file stops at load with
 *  `llama_model_load: error loading model vocabulary: unknown tokenizer:
 *  'plamo3'`. `llm_tokenizer_plamo2` is built in and is the same word-piece
 *  reader over this vocabulary: the patched file translated byte-identically to
 *  the unpatched one (4/4 single segments, 33/33 batch lines). Both names are
 *  six ASCII bytes, which is what makes step 6 a two-byte edit rather than a
 *  rewrite of the file. */
const HF_TOKENIZER = 'plamo3';
const WEB_TOKENIZER = 'plamo2';

const GGML_BF16 = 30;
/** Tensor types are reported by name. The numbering is upstream's `ggml_type`
 *  enum, copied rather than imported so this script runs before any Python
 *  exists on the machine. */
const GGML_TYPES: Record<number, string> = {
  0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1', 6: 'Q5_0', 7: 'Q5_1', 8: 'Q8_0', 9: 'Q8_1',
  10: 'Q2_K', 11: 'Q3_K', 12: 'Q4_K', 13: 'Q5_K', 14: 'Q6_K', 15: 'Q8_K',
  16: 'IQ2_XXS', 17: 'IQ2_XS', 18: 'IQ3_XXS', 19: 'IQ1_S', 20: 'IQ4_NL', 21: 'IQ3_S',
  22: 'IQ2_S', 23: 'IQ4_XS', 24: 'I8', 25: 'I16', 26: 'I32', 27: 'I64', 28: 'F64',
  29: 'IQ1_M', 30: 'BF16', 34: 'TQ1_0', 35: 'TQ2_0', 39: 'MXFP4', 40: 'NVFP4'
};
const REPORTED_TENSORS = 5;

/** A GGUF header is magic + version + counts + KV pairs + tensor infos, and
 *  what follows it is 1.7 GB of weights nobody here needs to look at. The
 *  walker reads a prefix and doubles it until the header parses; the tokenizer
 *  metadata (107,520 tokens with scores and types) is a few MB, so the cap only
 *  exists to stop a garbage file being pulled into memory. */
const HEADER_STEP = 1 << 20;
const HEADER_CAP = 256 << 20;
const MAX_ENTRIES = 10000000;

/** The GGUF value tags. `map` is newer than the v0.9.0 converter (it writes
 *  none), but it is part of the header grammar, so walking a file that has one
 *  must not be mistaken for corruption. */
const VALUE_TYPES = {
  uint8: 0, int8: 1, uint16: 2, int16: 3, uint32: 4, int32: 5, float32: 6, bool: 7,
  string: 8, array: 9, uint64: 10, int64: 11, float64: 12, map: 13
} as const;

type GgufValue = string | number | boolean | GgufValue[] | { [key: string]: GgufValue };

/** `valueOffset` is where the value field begins — for a string, its u64
 *  length. `bodyOffset` is what a rewrite wants: the bytes themselves. */
type GgufEntry = { key: string; type: number; value: GgufValue; valueOffset: number; bodyOffset: number };

type TensorInfo = { name: string; dimensions: number[]; type: number; offset: number };

type GgufHeader = {
  version: number;
  tensorCount: number;
  entries: GgufEntry[];
  tensors: TensorInfo[];
  bytes: number;
};

/** Raised while walking a buffer shorter than the header claims; the caller
 *  answers it by reading more of the file. Anything else is a real defect and
 *  surfaces as a TypeError. */
class TruncatedError extends Error {}

/** What the patch step did, for the closing line. */
let tokenizerState = '';

const problems: string[] = [];

const fail = (condition: unknown, message: string): boolean => {
  if (!condition) problems.push(message);
  return Boolean(condition);
};

const text = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const count = (value: number): string => value.toLocaleString('en-US');

const shown = (value: unknown): string => (typeof value === 'string' ? `"${value}"` : String(value));

const typeOf = (type: number): string => GGML_TYPES[type] ?? `type ${String(type)}`;

/** Paths inside the repository print relative to it, the way every other
 *  script reports them; anything else keeps its absolute form rather than
 *  turning into a `../../..` crawl. */
const shownPath = (path: string): string => {
  const rel = relative(ROOT, path);
  return rel.startsWith('..') || rel.startsWith('/') ? path : rel;
};

const venvPython = (): string => join(
  VENV_DIR,
  process.platform === 'win32' ? 'Scripts' : 'bin',
  process.platform === 'win32' ? 'python.exe' : 'python'
);

function note(message: string): void {
  console.log(`  note: ${message}`);
}

// --- gguf -------------------------------------------------------------------

function walkHeader(buffer: Buffer): GgufHeader {
  let position = 0;

  const need = (bytes: number): void => {
    if (position + bytes > buffer.length) throw new TruncatedError();
  };
  const take = (bytes: number, read: (offset: number) => number | bigint): number => {
    need(bytes);
    const value = Number(read(position));
    position += bytes;
    return value;
  };
  const u8 = () => take(1, (offset) => buffer.readUInt8(offset));
  const i8 = () => take(1, (offset) => buffer.readInt8(offset));
  const u16 = () => take(2, (offset) => buffer.readUInt16LE(offset));
  const i16 = () => take(2, (offset) => buffer.readInt16LE(offset));
  const u32 = () => take(4, (offset) => buffer.readUInt32LE(offset));
  const i32 = () => take(4, (offset) => buffer.readInt32LE(offset));
  const f32 = () => take(4, (offset) => buffer.readFloatLE(offset));
  const f64 = () => take(8, (offset) => buffer.readDoubleLE(offset));
  const i64 = () => take(8, (offset) => buffer.readBigInt64LE(offset));
  const u64 = (): number => {
    need(8);
    const value = buffer.readBigUInt64LE(position);
    position += 8;
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new TypeError(`gguf count ${value.toString()} is beyond 2^53`);
    }
    return Number(value);
  };
  const string = (): string => {
    const length = u64();
    need(length);
    const value = buffer.toString('utf8', position, position + length);
    position += length;
    return value;
  };
  /** Every element costs at least one byte, so a count larger than what is
   *  left of the buffer is a truncated header, not something to loop over. */
  const within = (elements: number): number => {
    if (elements > buffer.length - position) throw new TruncatedError();
    return elements;
  };
  const value = (type: number): GgufValue => {
    switch (type) {
      case VALUE_TYPES.uint8: return u8();
      case VALUE_TYPES.int8: return i8();
      case VALUE_TYPES.uint16: return u16();
      case VALUE_TYPES.int16: return i16();
      case VALUE_TYPES.uint32: return u32();
      case VALUE_TYPES.int32: return i32();
      case VALUE_TYPES.float32: return f32();
      case VALUE_TYPES.bool: return u8() !== 0;
      case VALUE_TYPES.string: return string();
      case VALUE_TYPES.array: {
        const elementType = u32();
        const length = within(u64());
        return Array.from({ length }, () => value(elementType));
      }
      case VALUE_TYPES.uint64: return u64();
      case VALUE_TYPES.int64: return i64();
      case VALUE_TYPES.float64: return f64();
      case VALUE_TYPES.map: {
        // count * (string key + its own type tag + value); heterogeneous, so
        // the tag is read per pair rather than once for the map.
        const pairs = within(u64());
        const map: { [key: string]: GgufValue } = {};
        for (let index = 0; index < pairs; index += 1) {
          const name = string();
          map[name] = value(u32());
        }
        return map;
      }
      default:
        throw new TypeError(`unknown ggml value type ${String(type)} at offset ${String(position)}`);
    }
  };

  need(4);
  if (buffer.toString('latin1', 0, 4) !== 'GGUF') {
    throw new TypeError('not a GGUF file: the magic is missing');
  }
  position = 4;
  const version = u32();
  if (version !== 3) throw new TypeError(`gguf v${String(version)} is not supported, expected v3`);
  const tensorCount = u64();
  const kvCount = u64();
  if (tensorCount > MAX_ENTRIES || kvCount > MAX_ENTRIES) {
    throw new TypeError(`gguf header claims ${count(kvCount)} keys and ${count(tensorCount)} tensors`);
  }

  const entries: GgufEntry[] = [];
  for (let index = 0; index < kvCount; index += 1) {
    const key = string();
    const type = u32();
    const valueOffset = position;
    const bodyOffset = type === VALUE_TYPES.string ? valueOffset + 8 : valueOffset;
    entries.push({ key, type, value: value(type), valueOffset, bodyOffset });
  }

  const tensors: TensorInfo[] = [];
  for (let index = 0; index < tensorCount; index += 1) {
    const name = string();
    const rank = u32();
    within(rank);
    const dimensions: number[] = [];
    for (let axis = 0; axis < rank; axis += 1) dimensions.push(u64());
    const type = u32();
    const offset = u64();
    tensors.push({ name, dimensions, type, offset });
  }

  return { version, tensorCount, entries, tensors, bytes: position };
}

function readHeader(file: string): GgufHeader {
  const fd = openSync(file, 'r');
  try {
    let size = HEADER_STEP;
    for (;;) {
      const buffer = Buffer.allocUnsafe(size);
      const read = readSync(fd, buffer, 0, size, 0);
      try {
        return walkHeader(buffer.subarray(0, read));
      } catch (error) {
        if (!(error instanceof TruncatedError)) throw error;
        if (read < size) {
          throw new TypeError(`ends after ${count(read)} bytes, inside its own header`);
        }
        if (size >= HEADER_CAP) {
          throw new TypeError(`has a header larger than ${count(HEADER_CAP)} bytes`);
        }
        size *= 2;
      }
    }
  } finally {
    closeSync(fd);
  }
}

function entryOf(header: GgufHeader, key: string): GgufEntry | undefined {
  return header.entries.find((entry) => entry.key === key);
}

/**
 * Rewrites `tokenizer.ggml.model` from `plamo3` to `plamo2` where it sits.
 *
 * The write is anchored on the KV pair the walker decoded: the key is matched
 * as the string it decoded to, and the bytes offset that walk recorded — past
 * the value's u64 length — is where the six characters are replaced.
 * `general.architecture = "plamo3"`, the other keys that start with the same
 * prefix and the `plamo3.*` tensor names are therefore never candidates.
 * Both spellings are six ASCII bytes, so nothing after the value moves — the
 * tensor infos, the alignment of the data section and every weight byte stay
 * exactly as the converter wrote them, which is why this is a write and not a
 * rewrite. The file is never read whole either: only the header prefix is ever
 * in memory, and the offset written to was measured against that same view.
 */
function patchTokenizerModel(file: string): { patched: boolean; found: string | null; offset: number | null } {
  const header = readHeader(file);
  const entry = entryOf(header, TOKENIZER_MODEL_KEY);
  if (!entry) return { patched: false, found: null, offset: null };
  if (typeof entry.value !== 'string') {
    throw new TypeError(`${TOKENIZER_MODEL_KEY} is not a string (type ${String(entry.type)})`);
  }
  if (entry.value === WEB_TOKENIZER) return { patched: false, found: entry.value, offset: entry.bodyOffset };
  if (entry.value !== HF_TOKENIZER) {
    throw new TypeError(`${TOKENIZER_MODEL_KEY} is "${entry.value}", neither "${HF_TOKENIZER}" nor "${WEB_TOKENIZER}"`);
  }
  const fd = openSync(file, 'r+');
  try {
    writeSync(fd, WEB_TOKENIZER, entry.bodyOffset, 'utf8');
    // The engine reads this file back through another handle; land the patched
    // bytes before the verification pass opens the file again.
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return { patched: true, found: entry.value, offset: entry.bodyOffset };
}

async function digestOf(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file, { highWaterMark: 8 << 20 })) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

// --- steps ------------------------------------------------------------------

/** Fetches one file, picking up where a previous run's `.part` left off. The
 *  body is written straight to disk at the running offset — a 1.7 GB
 *  safetensors must never pass through memory. */
async function download(url: string, dest: string, expected: number | null): Promise<number> {
  const part = `${dest}.part`;
  let size = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let resumed = 0;
    if (existsSync(part)) {
      resumed = statSync(part).size;
      if (resumed === 0) unlinkSync(part);
    }
    const headers: Record<string, string> = { Accept: 'application/octet-stream' };
    if (resumed > 0) headers.Range = `bytes=${String(resumed)}-`;
    const response = await fetch(url, { headers, redirect: 'follow' });
    if (response.status === 416) {
      // The part file already is the whole body, or the host disagrees with its
      // own size; either way, start the file over — once.
      if (existsSync(part)) unlinkSync(part);
      continue;
    }
    if (!response.ok && response.status !== 206) {
      throw new Error(`HTTP ${String(response.status)} for ${url}`);
    }
    if (!response.body) throw new Error(`${url} came back with no body`);
    const partial = response.status === 206;
    if (resumed > 0 && !partial) resumed = 0; // the range was ignored; the body is the whole file

    const declared = Number(response.headers.get('content-length'));
    const total = Number.isFinite(declared) && declared > 0 ? (partial ? resumed + declared : declared) : null;

    const fd = openSync(part, resumed > 0 ? 'r+' : 'w');
    const label = basename(dest);
    const progress = (bytes: number): void => {
      if (total === null) return;
      const percent = String(Math.floor((bytes / total) * 100)).padStart(3, ' ');
      process.stdout.write(`\r  ${label}  ${percent}%  ${count(bytes)} / ${count(total)}`);
    };
    try {
      const body: AsyncIterable<Uint8Array> = response.body as unknown as AsyncIterable<Uint8Array>;
      let written = resumed;
      let reported = resumed;
      if (resumed > 0) progress(resumed); // so a resume is visible rather than mysterious
      for await (const chunk of body) {
        writeSync(fd, chunk, 0, chunk.length, written);
        written += chunk.length;
        if (written - reported >= PROGRESS_STEP) {
          reported = written;
          progress(written);
        }
      }
    } finally {
      closeSync(fd);
      if (total !== null) process.stdout.write('\n');
    }
    renameSync(part, dest);
    size = statSync(dest).size;
    if (total !== null && size !== total) {
      throw new Error(`${basename(dest)} transferred ${count(size)} bytes, the host declared ${count(total)}`);
    }
    break;
  }
  if (size === 0) throw new Error(`${basename(dest)} is empty`);
  if (expected !== null && size !== expected) {
    throw new Error(`${basename(dest)} is ${count(size)} bytes, expected ${count(expected)}`);
  }
  return size;
}

function git(args: string[]): string {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (result.error) throw new Error(`git ${args.join(' ')}: ${text(result.error)}`);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} exited with ${String(result.status)}: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return (result.stdout ?? '').trim();
}

function spawn(exe: string, args: string[], options: { env?: NodeJS.ProcessEnv; quiet?: boolean } = {}): string {
  const result = spawnSync(exe, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: options.quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: options.env ?? process.env
  });
  if (result.error) throw new Error(`${exe} ${args.join(' ')}: ${text(result.error)}`);
  if (result.status !== 0) {
    const tail = options.quiet
      ? `: ${((result.stderr || result.stdout || '').trim().split('\n').slice(-8)).join('\n    ')}`
      : ' (whatever it printed above is the tool\'s own report)';
    throw new Error(`${exe} ${args.join(' ')} exited with ${String(result.status)}${tail}`);
  }
  return (result.stdout ?? '').trim();
}

const stampOf = (path: string): string | null =>
  existsSync(path) ? readFileSync(path, 'utf8').trim() : null;

// --- reporting --------------------------------------------------------------

function report(file: string, header: GgufHeader, bytes: number, sha256: string): void {
  console.log(`  file:      ${shownPath(file)}`);
  console.log(`  size:      ${count(bytes)} bytes (expected ${count(EXPECTED_BYTES)})`);
  console.log(`  sha256:    ${sha256}`);
  console.log(`  tensors:   ${count(header.tensors.length)} (expected ${count(EXPECTED_TENSORS)})`);
  for (const key of [KEY_ARCHITECTURE, TOKENIZER_MODEL_KEY, KEY_TOKENIZER_PRE]) {
    const entry = entryOf(header, key);
    console.log(`  ${key.padEnd(22, ' ')}= ${entry ? shown(entry.value) : '(absent)'}`);
  }
  const histogram = new Map<string, number>();
  for (const tensor of header.tensors) {
    const name = typeOf(tensor.type);
    histogram.set(name, (histogram.get(name) ?? 0) + 1);
  }
  const mix = [...histogram.entries()].map(([name, total]) => `${total} x ${name}`).join(', ');
  console.log(`  types:     ${mix}`);
  for (const tensor of header.tensors.slice(0, REPORTED_TENSORS)) {
    console.log(`  tensor:    ${tensor.name} [${tensor.dimensions.join(' x ')}] ${typeOf(tensor.type)}`);
  }
}

async function verify(file: string, expectedSha256: string | null): Promise<string | void> {
  if (!fail(existsSync(file), `${shownPath(file)} does not exist`)) {
    return 'no GGUF to check; build it with `node scripts/plamo-gguf.ts`';
  }
  let header: GgufHeader;
  try {
    header = readHeader(file);
  } catch (error) {
    fail(false, `${basename(file)}: ${text(error)}`);
    return 'the file is not a GGUF v3 this script can read; rebuild it with --force';
  }
  const bytes = statSync(file).size;
  const sha256 = await digestOf(file);
  report(file, header, bytes, sha256);

  fail(bytes === EXPECTED_BYTES, `${basename(file)} is ${count(bytes)} bytes, expected ${count(EXPECTED_BYTES)}`);
  fail(header.tensors.length === EXPECTED_TENSORS && header.tensorCount === EXPECTED_TENSORS,
    `${basename(file)} declares ${count(header.tensors.length)} tensors, expected ${count(EXPECTED_TENSORS)}`);

  const architecture = entryOf(header, KEY_ARCHITECTURE);
  fail(architecture?.value === EXPECTED_ARCHITECTURE,
    `${KEY_ARCHITECTURE} is ${shown(architecture?.value)}, expected "${EXPECTED_ARCHITECTURE}" — the converter wrote a different model, check ${LLAMA_CPP_REPOSITORY} ${LLAMA_CPP_REF}`);

  const tokenizer = entryOf(header, TOKENIZER_MODEL_KEY);
  if (tokenizer) {
    fail(tokenizer.value === WEB_TOKENIZER,
      `${TOKENIZER_MODEL_KEY} is ${shown(tokenizer.value)}, expected "${WEB_TOKENIZER}"; run \`node scripts/plamo-gguf.ts --patch\`, wllama has no llm_tokenizer_${HF_TOKENIZER} and will refuse to load the file`);
  } else {
    fail(false, `${TOKENIZER_MODEL_KEY} is absent; the converter never wrote it, so --patch has nothing to rewrite — rebuild with --force`);
  }

  // `--outtype bf16` produces GGUF's MOSTLY_BF16: every matrix is BF16 while
  // the 1-D norms stay F32, so "is the first tensor BF16" would fail a correct
  // file. What has to hold is the declared file type and the weight shapes.
  const fileType = entryOf(header, KEY_FILE_TYPE);
  fail(fileType?.value === GGUF_FILE_TYPE_MOSTLY_BF16,
    `${KEY_FILE_TYPE} is ${shown(fileType?.value)}, expected ${String(GGUF_FILE_TYPE_MOSTLY_BF16)} (MOSTLY_BF16) — the conversion was not run with --outtype bf16`);
  const strays = header.tensors.filter((tensor) => tensor.dimensions.length > 1 && tensor.type !== GGML_BF16);
  fail(strays.length === 0,
    `${strays.slice(0, 3).map((tensor) => `${tensor.name} is ${typeOf(tensor.type)}`).join(', ')}${strays.length > 3 ? `, and ${String(strays.length - 3)} more` : ''} among the matrix tensors, expected BF16 — the conversion was not run with --outtype bf16`);

  if (expectedSha256 !== null) {
    fail(sha256 === expectedSha256, `sha256 is ${sha256}, expected ${expectedSha256}`);
  }
  return problems.length === 0 ? undefined : 'the checks above did not pass';
}

function publish(file: string, sha256: string): void {
  console.log('publish');
  console.log(`  artefact   ${shownPath(file)}`);
  console.log(`  sha256     ${sha256}`);
  console.log(`             publish it under this exact name (${ARTIFACT}): the engine keeps what`);
  console.log('             it downloads under the name the URL ends with, and the engine card');
  console.log('             asks for this file.');
  console.log(`  source     add an AT.local.ModelSource { id, label, url, size: ${String(EXPECTED_BYTES)}, license }`);
  console.log('             beside the one AT.local.MODEL_SOURCES already holds; AT.plamo3 downloads');
  console.log('             from that url. modelstore rejects a body whose declared size drifts more');
  console.log(`             than 5% from \`size\`, so pin it to ${String(EXPECTED_BYTES)}.`);
  console.log('  sanity     the card\'s own llama.cpp command, run against this file:');
  console.log(`             llama-server -m ${ARTIFACT} -c 16384 --port 8000 --alias plamo-3-translate --jinja --no-prefill-assistant`);
}

// --- driver -----------------------------------------------------------------

type Args = {
  mode: 'build' | 'check' | 'patch' | 'dry-run';
  gguf: string;
  force: boolean;
  python: string | null;
  sha256: string | null;
  help: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { mode: 'build', gguf: GGUF_PATH, force: false, python: null, sha256: null, help: false };
  for (const arg of argv) {
    if (arg === '--check') args.mode = 'check';
    else if (arg === '--patch') args.mode = 'patch';
    else if (arg === '--dry-run') args.mode = 'dry-run';
    else if (arg === '--force') args.force = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg.startsWith('--gguf=')) args.gguf = arg.slice(7);
    else if (arg.startsWith('--python=')) args.python = arg.slice(9);
    else if (arg.startsWith('--expect-sha256=')) args.sha256 = arg.slice(16).toLowerCase();
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

const USAGE = `usage: node scripts/plamo-gguf.ts [--check|--patch|--dry-run] [options]

  --check                validate the GGUF (size, sha256, tensors, kv) and write nothing
  --patch                rewrite tokenizer.ggml.model plamo3 -> plamo2 in place
  --dry-run              list the steps and the commands they would run
  --gguf=<path>          GGUF to act on (default .cache/plamo/out/${ARTIFACT})
  --python=<exe>         run the converter with this interpreter instead of the cache venv
  --expect-sha256=<hex>  also require this digest from --check
  --force                wipe .cache/plamo first (re-downloads ${count(SAFETENSORS_BYTES)} bytes of weights)
  --help                 this message`;

type Step = { title: string; plan: () => string[]; fix: string; run: () => Promise<string | void> | string | void };

function steps(args: Args): Step[] {
  const python = args.python ?? venvPython();
  const pip = ['install', '--disable-pip-version-check', '--quiet'];
  return [
    {
      title: 'workdir',
      fix: '.cache/plamo has to be writable; if it is in a strange state, re-run with --force',
      plan: () => [args.force
        ? `wipe ${relative(ROOT, CACHE)} and recreate it`
        : `create ${relative(ROOT, CACHE)}, ${relative(ROOT, MODEL_DIR)} and ${relative(ROOT, OUT_DIR)} if missing`],
      run: () => {
        if (args.force && existsSync(CACHE)) {
          rmSync(CACHE, { recursive: true, force: true });
          note('wiped .cache/plamo as asked');
        }
        for (const dir of [CACHE, MODEL_DIR, OUT_DIR]) mkdirSync(dir, { recursive: true });
      }
    },
    {
      title: 'download',
      fix: `check the network and that ${HF_REPOSITORY} is reachable; a half-fetched file resumes on the next run, or delete it from ${relative(ROOT, MODEL_DIR)} first`,
      plan: () => HF_FILES.map((file) => `fetch ${HF_BASE}${file.name}${file.bytes === null ? '' : ` (${count(file.bytes)} bytes)`}`),
      async run() {
        let total = 0;
        let fetched = 0;
        for (const file of HF_FILES) {
          const dest = join(MODEL_DIR, file.name);
          const held = existsSync(dest) ? statSync(dest).size : 0;
          if (held > 0 && (file.bytes === null || held === file.bytes)) {
            total += held;
            continue;
          }
          total += await download(`${HF_BASE}${file.name}`, dest, file.bytes);
          fetched += 1;
        }
        note(`${String(fetched)} of ${String(HF_FILES.length)} files fetched this run, ${count(total)} bytes in ${relative(ROOT, MODEL_DIR)}`);
      }
    },
    {
      title: 'llama.cpp',
      fix: 'git has to reach github.com; pin another release in LLAMA_CPP_REF and re-run with --force if this one stops working',
      plan: () => [
        `git clone --depth 1 --filter=blob:none --sparse --branch ${LLAMA_CPP_REF} ${LLAMA_CPP_REPOSITORY} ${relative(ROOT, LLAMA_DIR)}`,
        `git -C ${relative(ROOT, LLAMA_DIR)} sparse-checkout set ${LLAMA_CPP_SPARSE.join(' ')}`,
        `record the resolved commit in ${relative(ROOT, LLAMA_STAMP)}`
      ],
      run() {
        const ready = existsSync(join(LLAMA_DIR, LLAMA_CPP_CONVERTER)) && stampOf(LLAMA_STAMP) === LLAMA_CPP_REF;
        if (ready) {
          note(`${relative(ROOT, LLAMA_DIR)} holds ${LLAMA_CPP_REPOSITORY} ${LLAMA_CPP_REF}`);
          return;
        }
        if (!git(['--version']).startsWith('git ')) throw new Error('git is not on PATH');
        rmSync(LLAMA_DIR, { recursive: true, force: true });
        git(['clone', '--depth', '1', '--filter', 'blob:none', '--sparse', '--branch', LLAMA_CPP_REF, LLAMA_CPP_REPOSITORY, LLAMA_DIR]);
        git(['-C', LLAMA_DIR, 'sparse-checkout', 'set', ...LLAMA_CPP_SPARSE]);
        const commit = git(['-C', LLAMA_DIR, 'rev-parse', 'HEAD']);
        writeFileSync(LLAMA_STAMP, `${LLAMA_CPP_REF}\n${commit}\n`, 'utf8');
        note(`${LLAMA_CPP_REPOSITORY} ${LLAMA_CPP_REF} at ${commit}, only ${[LLAMA_CPP_CONVERTER, ...LLAMA_CPP_SPARSE].join(', ')}`);
      }
    },
    {
      title: 'converter',
      fix: args.python
        ? `${args.python} needs torch, ${CONVERTER_PACKAGES.join(', ')} and it must be able to import them`
        : `delete ${relative(ROOT, VENV_DIR)} to rebuild it, or pass --python=<exe> for an interpreter that already has torch`,
      plan: () => args.python
        ? [`use ${args.python} with PYTHONPATH=${relative(ROOT, join(LLAMA_DIR, 'gguf-py'))}`]
        : [
          `${process.env.PYTHON ?? 'python3'} -m venv ${relative(ROOT, VENV_DIR)}`,
          `pip install --index-url ${TORCH_INDEX} torch   # unpinned: upstream pins torch==2.11.0 and there is no wheel for it here`,
          `pip install ${CONVERTER_PACKAGES.join(' ')}`,
          'gguf comes from the pinned clone via PYTHONPATH, never from PyPI'
        ],
      run() {
        if (args.python) {
          note(`using ${args.python}; the venv is skipped and gguf-py is put on PYTHONPATH instead`);
          return;
        }
        const spec = `torch@${TORCH_INDEX} ${CONVERTER_PACKAGES.join(' ')}`;
        if (existsSync(venvPython()) && stampOf(VENV_STAMP) === spec) {
          note(`${relative(ROOT, VENV_DIR)} already holds ${spec}`);
          return;
        }
        spawn(process.env.PYTHON ?? 'python3', ['-m', 'venv', VENV_DIR], { quiet: true });
        spawn(venvPython(), ['-m', 'pip', ...pip, '--upgrade', 'pip'], { quiet: true });
        spawn(venvPython(), ['-m', 'pip', ...pip, '--index-url', TORCH_INDEX, 'torch'], { quiet: true });
        spawn(venvPython(), ['-m', 'pip', ...pip, ...CONVERTER_PACKAGES], { quiet: true });
        writeFileSync(VENV_STAMP, `${spec}\n`, 'utf8');
        note(`venv at ${relative(ROOT, VENV_DIR)}: torch from ${TORCH_INDEX} unpinned (see the comment), ${CONVERTER_PACKAGES.join(', ')}`);
      }
    },
    {
      title: 'convert',
      fix: 'the converter prints its own report above; an import error means the venv needs rebuilding (--force), an unsupported-model error means LLAMA_CPP_REF is too old for plamo3',
      plan: () => [`${python} ${relative(ROOT, join(LLAMA_DIR, LLAMA_CPP_CONVERTER))} ${relative(ROOT, MODEL_DIR)} --outtype bf16 --outfile ${shownPath(args.gguf)}`],
      run() {
        if (!args.force && existsSync(args.gguf) && statSync(args.gguf).size === EXPECTED_BYTES) {
          note(`${shownPath(args.gguf)} already reads ${count(EXPECTED_BYTES)} bytes; --force to convert again`);
          return;
        }
        const script = join(LLAMA_DIR, LLAMA_CPP_CONVERTER);
        if (!existsSync(script)) throw new Error(`${relative(ROOT, script)} is missing, so step 3 never finished`);
        mkdirSync(OUT_DIR, { recursive: true });
        spawn(python, [script, MODEL_DIR, '--outtype', 'bf16', '--outfile', args.gguf], {
          env: { ...process.env, PYTHONPATH: join(LLAMA_DIR, 'gguf-py') }
        });
        if (!existsSync(args.gguf)) throw new Error(`${basename(args.gguf)} was never written`);
      }
    },
    {
      title: 'patch',
      fix: `the key is only ever rewritten from "${HF_TOKENIZER}"; anything else means the file did not come from this pipeline — rebuild it with --force rather than editing bytes by hand`,
      plan: () => [`rewrite ${TOKENIZER_MODEL_KEY} "${HF_TOKENIZER}" -> "${WEB_TOKENIZER}" in place at its recorded offset, same length`],
      run() {
        const result = patchTokenizerModel(args.gguf);
        tokenizerState = result.patched
          ? 'rewritten for the web runtime'
          : result.found === null ? 'is absent from the file' : `already reads ${shown(result.found)}`;
        note(`${TOKENIZER_MODEL_KEY}: ${result.patched
          ? `${shown(result.found)} -> ${shown(WEB_TOKENIZER)} at byte ${count(result.offset ?? 0)}, same length so no other byte moved`
          : tokenizerState}`);
      }
    },
    {
      title: 'verify',
      fix: `compare the numbers with the ${HF_REPOSITORY} card; if only the digest moved, the converter did`,
      plan: () => ['read the header, hash the file, print size / sha256 / tensor count / architecture / tokenizer keys'],
      run: () => verify(args.gguf, args.sha256)
    },
    {
      title: 'publish',
      fix: 'nothing to fix; this step only prints',
      plan: () => ['print the artefact name, its digest, the ModelSource fields and the card\'s llama-server command'],
      async run() {
        publish(args.gguf, await digestOf(args.gguf));
      }
    }
  ];
}

function printPlan(list: Step[]): void {
  list.forEach((step, index) => {
    console.log(`${String(index + 1)}. ${step.title}`);
    for (const line of step.plan()) console.log(`     ${line}`);
  });
}

async function run(args: Args): Promise<boolean> {
  const all = steps(args);
  if (args.mode === 'dry-run') {
    console.log('plamo-gguf dry-run: nothing below is downloaded, created or changed');
    printPlan(all);
    return true;
  }
  const selected = args.mode === 'check'
    ? all.filter((step) => step.title === 'verify')
    : args.mode === 'patch'
      ? all.filter((step) => step.title === 'patch')
      : all;

  for (const [index, step] of selected.entries()) {
    console.log(`[${String(index + 1)}/${String(selected.length)}] ${step.title}`);
    try {
      const outcome = await step.run();
      if (outcome) {
        for (const problem of problems) console.error(`  error: ${problem}`);
        console.error(`plamo-gguf failed at ${step.title}: ${outcome}`);
        return false;
      }
    } catch (error) {
      for (const problem of problems) console.error(`  error: ${problem}`);
      console.error(`  error: ${step.title}: ${text(error)}`);
      console.error(`  fix:   ${step.fix}`);
      console.error(`plamo-gguf failed at ${step.title}`);
      return false;
    }
  }
  if (problems.length > 0) return false;
  const summary = args.mode === 'patch'
    ? `${basename(args.gguf)} ${TOKENIZER_MODEL_KEY} ${tokenizerState}`
    : `${basename(args.gguf)} verified at ${count(EXPECTED_BYTES)} bytes, ${count(EXPECTED_TENSORS)} tensors`;
  console.log(`plamo-gguf ok: ${summary}`);
  return true;
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) console.log(USAGE);
  else if (!(await run(args))) process.exitCode = 1;
} catch (error) {
  // Argument and plan mistakes are the user's to fix, so they get a line
  // rather than a stack trace.
  console.error(`  error: ${text(error)}`);
  console.error('  fix:   node scripts/plamo-gguf.ts --help lists the arguments');
  process.exitCode = 1;
}

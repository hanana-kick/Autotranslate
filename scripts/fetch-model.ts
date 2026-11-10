// Fetches the default ONNX card into a directory the tests read from, so a
// measurement never downloads 673 MB again. The bytes land under `weight/`,
// which is git-ignored: they are model files, not source.
//
//   npm run model:fetch                 # weight/plamo-3-translate-0.8b-onnx
//   npm run model:fetch -- --dir <path>
//
// The directory keeps the file names the card uses, which is exactly what the
// live harness serves back over its local origin.
import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CARD = 'https://huggingface.co/TeamFlaxia/plamo-3-translate-0.8b-onnx/resolve/main/onnx/model_q4f16.onnx';
const GRAPH = 'model_q4f16.onnx';
const PARTS = ['config.json', 'generation_config.json', 'tokenizer.json', 'tokenizer_config.json', 'chat_template.jinja'];

function argument(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? '') : '';
}

const dir = resolve(argument('dir') || join(ROOT, 'weight', 'plamo-3-translate-0.8b-onnx'));
await mkdir(dir, { recursive: true });

async function fetchInto(url: string, name: string): Promise<void> {
  const path = join(dir, name);
  const existing = await stat(path).catch(() => null);
  if (existing && existing.size > 0) {
    console.log(`${name}: already here (${existing.size} bytes)`);
    return;
  }
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`${url} answered ${response.status}`);
  const sink = createWriteStream(path);
  await new Promise<void>((done, fail) => {
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
      .pipe(sink)
      .on('finish', () => done())
      .on('error', fail);
  });
  console.log(`${name}: ${(await stat(path)).size} bytes`);
}

const base = CARD.slice(0, CARD.lastIndexOf('/onnx/') + 1);
await fetchInto(CARD, GRAPH);
for (const part of PARTS) await fetchInto(base + part, part);
console.log(`model files in ${dir}`);
console.log(`   npm run test:onnx with MODEL_DIR=${dir}`);

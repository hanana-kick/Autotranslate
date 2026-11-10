// Prepares the `weights/` directory a bundle can carry inside itself, so an
// install has no model to download. The files are the published ONNX export,
// named by `weights/manifest.json`; the build copies exactly what the manifest
// names, and the packaging gate refuses an archive that lost one of them.
//
//   node scripts/bundle-weights.ts --from ~/Downloads/plamo-onnx
//   node scripts/bundle-weights.ts --download        # fetch the q4f16 card
//
// `weights/` is git-ignored: it is 673 MiB of model, not source.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'weights');
const CARD = 'https://huggingface.co/TeamFlaxia/plamo-3-translate-0.8b-onnx/resolve/main/onnx/model_q4f16.onnx';
const PARTS = ['config.json', 'generation_config.json', 'tokenizer.json', 'tokenizer_config.json', 'chat_template.jinja'];

function argument(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? '') : '';
}

async function size(path: string): Promise<number> {
  return (await stat(path)).size;
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((done, fail) => {
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => done())
      .on('error', fail);
  });
  return hash.digest('hex');
}

async function download(url: string, path: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`${url} answered ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  await writeFile(path, bytes);
}

const from = argument('from');
await mkdir(OUT, { recursive: true });

if (from) {
  const source = resolve(from);
  for (const name of ['model_q4f16.onnx', ...PARTS]) {
    await copyFile(join(source, name), join(OUT, name));
  }
} else {
  const graph = 'model_q4f16.onnx';
  await download(CARD, join(OUT, graph));
  const base = CARD.slice(0, CARD.lastIndexOf('/onnx/') + 1);
  for (const part of PARTS) await download(base + part, join(OUT, part));
}

const graph = 'model_q4f16.onnx';
const manifest = {
  name: graph,
  dtype: 'q4f16',
  size: await size(join(OUT, graph)),
  sha256: await sha256(join(OUT, graph)),
  sourceUrl: CARD,
  // The graph first: the build copies what this list names, in this order.
  files: [graph, ...PARTS]
};
await writeFile(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`weights/manifest.json: ${graph} ${manifest.size} bytes, sha256 ${manifest.sha256.slice(0, 16)}...`);
console.log(`bundle it with: npm run build:chrome && npm run build:firefox`);

// Where a decode step's time is spent, from the OS's side: run a pure decode
// loop and read the browser processes' accumulated CPU time around exactly that
// window. Renderer cores = the dispatch path (ORT's proxy worker), GPU-process
// cores = driver-side work.
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { chromium, launchOptions, ROOT } from '../browser/support.mjs';

const EXTENSION = join(ROOT, 'build/chrome');
const MODEL = join(ROOT, process.env.MODEL_DIR || 'weight/plamo-3-translate-0.8b-onnx');
const PAGE_DIR = join(ROOT, 'test/engine-spike');
const STEPS = Number(process.env.STEPS || 12);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8' };

const server = createServer(async (request, response) => {
  try {
    const path = normalize(decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname));
    const file = path.startsWith('/micro/')
      ? join('/tmp/micro', path.slice('/micro/'.length))
      : path.startsWith('/spike-model/')
      ? join(MODEL, path.slice('/spike-model/'.length))
      : path === '/' || path === '/index.html'
        ? join(PAGE_DIR, 'index.html')
        : path === '/spike-page.js'
          ? join(PAGE_DIR, 'spike-page.js')
          : join(EXTENSION, path.slice(1));
    const body = await readFile(file);
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;

/** Accumulated CPU seconds per Playwright browser process. */
function cpuSeconds() {
  const out = execFileSync('ps', ['-Ao', 'pid,time,comm'], { encoding: 'utf8' });
  const rows = new Map();
  for (const line of out.split('\n')) {
    if (!line.includes('ms-playwright')) continue;
    const match = /^\s*(\d+)\s+(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)\s+(.*)$/.exec(line);
    if (!match) continue;
    const [, pid, hours, minutes, seconds, comm] = match;
    const total = Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds);
    const kind = /Renderer/.test(comm) ? 'renderer' : /GPU/.test(comm) ? 'gpu' : 'browser';
    rows.set(pid, { pid, kind, cpu: total, comm: comm.slice(-48) });
  }
  return rows;
}

const work = await mkdtemp(join(tmpdir(), 'sustain-'));
const profile = join(work, 'profile');
await mkdir(profile, { recursive: true });
const context = await chromium.launchPersistentContext(profile, {
  ...launchOptions,
  ignoreDefaultArgs: [...(launchOptions.ignoreDefaultArgs ?? []), '--disable-gpu'],
  args: [
    ...launchOptions.args.filter((arg) => arg !== '--disable-gpu'),
    '--enable-unsafe-webgpu',
    ...(process.platform === 'darwin' ? ['--use-webgpu-adapter=apple'] : [])
  ]
});
const page = await context.newPage();
page.on('pageerror', (error) => console.log('[pageerror]', error.message));
await page.goto(`${origin}/`, { waitUntil: 'load' });
const fresh = await context.newPage();
fresh.on('pageerror', (error) => console.log('[pageerror]', error.message));
fresh.on('console', (message) => console.log('[console]', message.text().slice(0, 240)));
await fresh.goto(`${origin}/`, { waitUntil: 'load' });
const loop = process.env.MODE === 'parity'
  ? await (async () => {
      const prompt = process.env.TEXT
        ? (await fresh.evaluate((text) => window.__tokenize(text), process.env.TEXT)).ids
        : (process.env.PROMPT || '1000,2000,3000').split(',').map(Number);
      const steps = Number(process.env.STEPS || 8);
      const ours = await fresh.evaluate((config) => window.__translateProbe(config), { prompt, steps });
      const ort = await fresh.evaluate(([ids, count]) => window.__ortGenerate(ids, count), [prompt, steps]);
      const matches = ours.generated.every((id, index) => id === ort.ids[index]);
      const ourText = await fresh.evaluate((ids) => window.__decodeIds(ids), ours.generated);
      const ortText = await fresh.evaluate((ids) => window.__decodeIds(ids), ort.ids);
      return {
        promptLength: prompt.length,
        steps,
        ours: ours.generated,
        ort: ort.ids,
        matches,
        ourText,
        ortText,
        msPerToken: ours.msPerToken,
        tokensPerSecond: ours.tokensPerSecond
      };
    })()
  : process.env.MODE === 'layer'
  ? await (async () => {
      const layerIndex = Number(process.env.LAYER || 1);
      const prompt = (process.env.PROMPT || '1000').split(',').map(Number);
      const dump = await fresh.evaluate((payload) => window.__layerDump(payload), prompt);
      const manifest = JSON.parse(execFileSync('cat', ['/tmp/micro/mm/manifest.json'], { encoding: 'utf8' }));
      const layerOnly = JSON.parse(execFileSync('cat', [`/tmp/micro/mm/layer${layerIndex}_only.json`], { encoding: 'utf8' }));
      const model = new Uint8Array(await readFile(`/tmp/micro/mm/layer${layerIndex}_only.onnx`));
      const reference = await fresh.evaluate(async ([bytes, tokens, outNames]) => {
        const ort = globalThis.AT_ORT_WEBGPU;
        const session = await ort.InferenceSession.create(bytes, { executionProviders: ['webgpu'], logSeverityLevel: 3 });
        const meta = session.inputMetadata[0];
        const input = await (async () => {
          const token = tokens[0];
          const embed = new Uint16Array(await (await fetch('/micro/mm/embed.f16.bin')).arrayBuffer());
          return null;
        })();
        void input;
        return { inputs: session.inputNames, outputs: outNames };
      }, [Array.from(model), prompt, Object.keys(layerOnly.outputs)]);
      return { layerIndex, layerOnly: layerOnly.outputs, reference };
    })()
  : process.env.MODE === 'gen'
  ? await (async () => {
      const prompt = (process.env.PROMPT || '1000,2000,3000').split(',').map(Number);
      const steps = Number(process.env.STEPS || 8);
      const dump = await fresh.evaluate((payload) => window.__layerDump(payload), prompt);
      const dims = dump.logits.dims;
      const vocab = dims[dims.length - 1];
      const positions = dims[dims.length - 2];
      const reference = dump.logits.values.slice((positions - 1) * vocab, positions * vocab);
      const result = await fresh.evaluate(
        (config) => window.__translateProbe(config),
        { prompt, steps, reference, collectLayers: process.env.LAYERS === '1', sharedFreq: process.env.SHARED === '1' }
      );
      if (process.env.LAYERS === '1' && result.layers) {
        const perLayer = [];
        for (let i = 0; i < 16; i += 1) {
          const ref = dump[`layer${i}_out`];
          if (!ref) continue;
          const width = ref.dims[ref.dims.length - 1];
          const rows = [];
          for (let p = 0; p < ref.dims[ref.dims.length - 2]; p += 1) {
            const ours = result.layers[p * 16 + i] ?? [];
            let maxAbs = 0;
            let sumAbs = 0;
            for (let j = 0; j < width; j += 1) {
              const diff = Math.abs((ours[j] ?? 0) - ref.values[p * width + j]);
              maxAbs = Math.max(maxAbs, diff);
              sumAbs += diff;
            }
            rows.push({ pos: p, maxAbs: Math.round(maxAbs * 1000) / 1000, meanAbs: Math.round((sumAbs / width) * 1000) / 1000 });
          }
          perLayer.push({ layer: i, rows });
        }
        result.perLayer = perLayer;
      }
      return result;
    })()
  : process.env.MODE === 'attn'
  ? await fresh.evaluate(() => window.__attnProbe())
  : process.env.DUMP
  ? await (async () => {
      const tokens = (process.env.PROMPT || String(process.env.DUMP)).split(',').map(Number);
      const dump = await fresh.evaluate((payload) => window.__layerDump(payload), tokens);
      if (process.env.MODE === 'dump') return dump;
      if (process.env.MODE === 'block') {
        return await fresh.evaluate(([payload, reference]) => window.__blockProbe(payload, reference), [tokens, dump]);
      }
      return await fresh.evaluate((payload) => window.__layerProbe(payload), dump);
    })()
  : await fresh.evaluate(
      (config) => window.__gemvProbe(config),
      {
        repeats: Number(process.env.REPEATS || 7),
        rows: (process.env.ROWS || '1,2,4,8').split(',').map(Number)
      }
    );
const wallMs = 0;
const before = new Map();
const after = new Map();

const processes = [];
for (const [pid, end] of after) {
  const start = before.get(pid);
  if (!start) continue;
  const cpu = end.cpu - start.cpu;
  processes.push({
    kind: end.kind,
    pid,
    cpuSeconds: Math.round(cpu * 100) / 100,
    cores: Math.round((cpu / (wallMs / 1000)) * 100) / 100,
    cpuMsPerStep: Math.round(((cpu * 1000) / STEPS) * 10) / 10
  });
}
processes.sort((a, b) => b.cores - a.cores);
console.log(JSON.stringify({ loop, wallMs, processes }, null, 1));
await context.close();
server.close();
await rm(work, { recursive: true, force: true });

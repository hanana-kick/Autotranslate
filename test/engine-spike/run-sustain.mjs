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
const STEPS = Number(process.env.STEPS || 200);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8' };

const server = createServer(async (request, response) => {
  try {
    const path = normalize(decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname));
    const file = path.startsWith('/spike-model/')
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
const opened = await page.evaluate(() => window.__openModel({ modelBase: '/spike-model/' }));
if (opened?.failure) {
  console.log('[sustain] model load failed', opened.failure);
  await context.close();
  server.close();
  process.exit(1);
}
const before = cpuSeconds();
const wallStart = Date.now();
const loop = await page.evaluate((count) => window.__sustain(count), STEPS);
const wallMs = Date.now() - wallStart;
const after = cpuSeconds();

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

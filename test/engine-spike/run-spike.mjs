// Runs the decode-engine spike in a real Chromium with real WebGPU: serves the
// built bundle at / and the exported graph at /spike-model/, drives
// test/engine-spike/index.html, and writes the numbers to test-results.
//
//   npm run build && node test/engine-spike/run-spike.mjs
//
// Throwaway: it exists to decide whether the engine is built, not to ship.
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { chromium, launchOptions, ROOT, OUTPUT } from '../browser/support.mjs';

const EXTENSION = join(ROOT, 'build/chrome');
const MODEL = join(ROOT, process.env.MODEL_DIR || 'weight/plamo-3-translate-0.8b-onnx');
const PAGE_DIR = join(ROOT, 'test/engine-spike');
const REPORT = join(OUTPUT, 'engine-spike.json');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream'
};

function route(url) {
  const path = normalize(decodeURIComponent(new URL(url, 'http://x').pathname));
  if (path.startsWith('/spike-model/')) return join(MODEL, path.slice('/spike-model/'.length));
  if (path.startsWith('/micro/')) return join('/tmp/micro', path.slice('/micro/'.length));
  if (path === '/' || path === '/index.html') return join(PAGE_DIR, 'index.html');
  if (path === '/spike-page.js') return join(PAGE_DIR, 'spike-page.js');
  return join(EXTENSION, path.slice(1));
}

const server = createServer(async (request, response) => {
  try {
    const file = route(request.url ?? '/');
    const body = await readFile(file);
    response.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store'
    });
    response.end(body);
  } catch {
    console.log('[spike] 404', request.url);
    response.writeHead(404);
    response.end();
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
console.log('[spike] serving', EXTENSION, '+', MODEL, 'at', origin);

const work = await mkdtemp(join(tmpdir(), 'engine-spike-'));
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
page.on('console', (message) => console.log('[page]', message.text().slice(0, 240)));
page.on('pageerror', (error) => console.log('[pageerror]', error.message));
await page.goto(`${origin}/`, { waitUntil: 'load' });

const config = {
  modelBase: '/spike-model/',
  target: 'ko',
  text: 'Batteries keep the grid stable at night by storing the surplus power generated at noon.',
  sizes: [1, 2, 4, 8],
  contexts: [128, 512, 1024],
  widths: [1, 2, 4, 8],
  rollback: false,
  micro: { base: '/micro/' },
  weightRead: '/micro/bigmm.onnx',
  nodeSlope: '/micro/extra2000.onnx',
  variants: {},
  prefixTexts: [
    'コメントありがとうございます。',
    '昨日の会議では予算案について議論しました。',
    'この記事はとても参考になりました。',
    '来月から新しい制度が始まります。',
    '値段が高いのでもう少し待ちます。',
    '設営は思ったより早く終わりました。',
    'ここから駅まで歩いて十分かかります。',
    '写真がとても綺麗ですね。',
    '資料を送っていただけますか。',
    '天気が悪いので中止になりました。',
    '申し込みの締め切りは金曜日です。',
    'その件については後日連絡します。',
    '新しいソフトウェアを導入しました。',
    '会場は駅のすぐ近くにあります。',
    'アンケートにご協力ください。',
    '商品が届くまで一週間かかります。',
    '説明会はオンラインで開催されます。',
    '予約は電話でも受け付けています。',
    'この問題は来週解決する予定です。',
    'お忙しいところありがとうございました。'
  ]
};

// Watch the browser's own processes while the decode loop runs: the renderer
// carries the dispatch path (ORT's proxy worker), the GPU process carries the
// driver. Whichever burns is the answer.
const samples = [];
const sampler = setInterval(() => {
  try {
    const out = execFileSync('ps', ['-Ao', 'pid,%cpu,comm'], { encoding: 'utf8' });
    for (const line of out.split('\n')) {
      if (!/Chromium|Google Chrome|chrome_crashpad|headless/i.test(line)) continue;
      if (!/Renderer|GPU|Helper/.test(line)) continue;
      const [pid, cpu, ...rest] = line.trim().split(/\s+/);
      samples.push({ pid, cpu: Number(cpu), name: rest.join(' ').slice(0, 60) });
    }
  } catch {}
}, 400);
const result = await page.evaluate((payload) => window.__spike(payload), config);

/** CPU seconds per process, from `ps`'s accumulated time. */
function cpuSeconds() {
  const out = execFileSync('ps', ['-Ao', 'pid,time,comm'], { encoding: 'utf8' });
  const rows = new Map();
  for (const line of out.split('\n')) {
    if (!/ms-playwright/.test(line)) continue;
    const match = /^\s*(\d+)\s+(?:(\d+):)?(\d+):(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const [, pid, hours, minutes, seconds, comm] = match;
    const total = Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds);
    const kind = /Renderer/.test(comm) ? 'renderer' : /GPU/.test(comm) ? 'gpu' : 'browser';
    const key = `${pid}:${kind}`;
    rows.set(key, { pid, kind, cpu: total, comm: comm.slice(-40) });
  }
  return rows;
}

// The decode loop, timed on both sides: wall clock from the page, CPU time from
// the OS. CPU seconds over wall seconds is the number of cores this path needs.
if (process.env.SUSTAIN !== '0') {
  const steps = Number(process.env.SUSTAIN_STEPS || 200);
  const before = cpuSeconds();
  const wallStart = Date.now();
  const sustained = await page.evaluate((count) => window.__sustain(count), steps);
  const wallMs = Date.now() - wallStart;
  const after = cpuSeconds();
  const processes = [];
  for (const [key, end] of after) {
    const start = before.get(key);
    if (!start) continue;
    const cpu = end.cpu - start.cpu;
    processes.push({
      kind: end.kind,
      pid: end.pid,
      cpuSeconds: Math.round(cpu * 100) / 100,
      cores: Math.round((cpu / (wallMs / 1000)) * 100) / 100,
      cpuMsPerStep: Math.round((cpu * 1000 / steps) * 10) / 10
    });
  }
  result.sustained = { ...sustained, wallMs, processes: processes.sort((a, b) => b.cores - a.cores) };
  console.log('[sustain]', JSON.stringify(result.sustained));
}

result.seconds = Math.round((Date.now() - started) / 1000);
await mkdir(OUTPUT, { recursive: true });
await writeFile(REPORT, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await context.close();
server.close();
await rm(work, { recursive: true, force: true });

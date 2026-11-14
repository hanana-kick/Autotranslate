// Real WebGPU numerical regression: partition tails, causal windows and reused scratch.
// No model download. ATTENTION_SOURCE can select an isolated experimental module.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { chromium, launchOptions, ROOT, OUTPUT } from '../browser/support.mjs';

const sourcePath = resolve(process.env.ATTENTION_SOURCE ?? join(ROOT, 'src/lib/kernelattention.ts'));
const source = await readFile(sourcePath, 'utf8');
const script = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/shader.js' ? 'text/javascript' : 'text/html');
  res.end(req.url === '/shader.js' ? script : '<!doctype html><title>Attention regression</title><script src="/shader.js"></script>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ ...launchOptions, args: launchOptions.args.filter(a => a !== '--disable-gpu') });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const report = await page.evaluate(async () => {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter');
    const device = await adapter.requestDevice();
    const errors = [], held = [];
    device.addEventListener('uncapturederror', e => errors.push(e.error.message));
    const alloc = (size, usage) => { const b = device.createBuffer({ size, usage }); held.push(b); return b; };
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const rows = 3, heads = 7, dimension = 128, maxTokens = 2048;
    const maxParts = Math.ceil(maxTokens / AT.kernelattention.DECODE_PARTITION);
    const queries = new Float32Array(rows * heads * dimension);
    const keys = new Float32Array(rows * maxTokens * dimension);
    const values = new Float32Array(keys.length);
    let seed = 371;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 - 0.5; };
    for (let i = 0; i < queries.length; i++) queries[i] = random();
    for (let i = 0; i < keys.length; i++) { keys[i] = random(); values[i] = random(); }
    const q = alloc(queries.byteLength, storage), k = alloc(keys.byteLength, storage), v = alloc(values.byteLength, storage);
    const output = alloc(queries.byteLength, storage);
    const partials = alloc(rows * heads * maxParts * AT.kernelattention.DECODE_PARTIAL_FLOATS * 4, storage);
    const positions = alloc(rows * 4, storage), cacheRows = alloc(rows * 4, storage);
    const info = alloc(32, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const staging = alloc(output.size, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    const pipeline = code => device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code }), entryPoint: 'main' } });
    const merge = pipeline(AT.kernelattention.decodeMerge(maxTokens * dimension));
    const group = (pipe, buffers) => device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })) });
    const partialVariants = [AT.kernelattention.DECODE_HEADS_PER_GROUP, AT.kernelattention.DECODE_WIDE_HEADS_PER_GROUP].map(headsPerGroup => {
      const partial = pipeline(AT.kernelattention.decodePartial(maxTokens * dimension, headsPerGroup));
      return { headsPerGroup, partial, partialGroup: group(partial, [q, k, v, partials, info, positions, cacheRows]) };
    });
    const mergeGroup = group(merge, [partials, output, info]);
    const cases = [
      { lengths: [1, 255, 256], window: 2048, mode: 0 },
      { lengths: [257, 511, 512], window: 2048, mode: 0 },
      { lengths: [513, 1023, 1024], window: 2048, mode: 0 },
      { lengths: [1025, 2047, 2048], window: 2048, mode: 0 },
      { lengths: [1, 513, 2048], window: 257, mode: 0 },
      { lengths: [2048, 257, 1], window: 0, mode: 2 },
      { lengths: [2048, 2048, 2048], window: 2048, mode: 1 },
      { lengths: [2049, 1, 513], window: 2048, mode: 0 },
      { lengths: [2049, 2049, 2049], window: 2048, mode: 0 },
      { lengths: [2048, 513, 257], window: 2048, mode: 0, queryScale: 1000 },
      { lengths: [1, 1, 1], window: 2048, mode: 0 },
    ];
    const results = [];
    device.queue.writeBuffer(k, 0, keys); device.queue.writeBuffer(v, 0, values);
    try {
      for (const { headsPerGroup, partial, partialGroup } of partialVariants) for (let index = 0; index < cases.length; index++) {
        const c = cases[index], slots = Uint32Array.from([index % rows, (index + 2) % rows, (index + 1) % rows]);
        const scaledQueries = Float32Array.from(queries, x => x * (c.queryScale ?? 1));
        const lengths = c.lengths;
        const visible = lengths.map(n => n > maxTokens ? 0 : c.window ? Math.min(n, c.window) : n);
        const parts = Math.max(1, Math.ceil(Math.max(...visible) / AT.kernelattention.DECODE_PARTITION));
        device.queue.writeBuffer(q, 0, scaledQueries);
        device.queue.writeBuffer(positions, 0, Uint32Array.from(lengths, n => n - 1));
        device.queue.writeBuffer(cacheRows, 0, slots);
        device.queue.writeBuffer(info, 0, new Uint32Array([heads, rows, c.window, c.mode, parts, 0, 0, 0]));
        const encoder = device.createCommandEncoder();
        const a = encoder.beginComputePass(); a.setPipeline(partial); a.setBindGroup(0, partialGroup);
        a.dispatchWorkgroups(Math.ceil(heads / headsPerGroup) * parts, rows); a.end();
        const b = encoder.beginComputePass(); b.setPipeline(merge); b.setBindGroup(0, mergeGroup); b.dispatchWorkgroups(heads, rows); b.end();
        encoder.copyBufferToBuffer(output, 0, staging, 0, output.size);
        device.queue.submit([encoder.finish()]);
        await staging.mapAsync(GPUMapMode.READ);
        const actual = new Float32Array(staging.getMappedRange().slice(0)); staging.unmap();
        let maxAbsoluteError = 0, maxToleranceRatio = 0;
        for (let row = 0; row < rows; row++) for (let head = 0; head < heads; head++) {
          const end = lengths[row] > maxTokens ? 0 : lengths[row], start = end - visible[row];
          const qbase = (row * heads + head) * dimension, cacheBase = slots[row] * maxTokens * dimension;
          const scores = new Float64Array(end - start);
          let top = -Infinity;
          for (let token = start; token < end; token++) {
            let score = 0;
            if (c.mode !== 2) for (let d = 0; d < dimension; d++) score += scaledQueries[qbase + d] * keys[cacheBase + token * dimension + d];
            scores[token - start] = score; top = Math.max(top, score);
          }
          let denominator = 0;
          for (let t = 0; t < scores.length; t++) { scores[t] = Math.exp(scores[t] - top); denominator += scores[t]; }
          for (let d = 0; d < dimension; d++) {
            let expected = 0;
            if (c.mode !== 1 && denominator) for (let t = 0; t < scores.length; t++) expected += scores[t] / denominator * values[cacheBase + (start + t) * dimension + d];
            const got = actual[qbase + d];
            if (!Number.isFinite(got)) throw new Error(`Nonfinite result case ${index}`);
            const error = Math.abs(got - expected);
            maxAbsoluteError = Math.max(maxAbsoluteError, error);
            maxToleranceRatio = Math.max(maxToleranceRatio, error / (2e-4 + Math.abs(expected) * 2e-4));
          }
        }
        if (maxToleranceRatio > 1) throw new Error(`CPU attention mismatch ${JSON.stringify({ c, maxAbsoluteError, maxToleranceRatio })}`);
        results.push({ ...c, headsPerGroup, parts, slots: [...slots], maxAbsoluteError, maxToleranceRatio });
      }
      if (errors.length) throw new Error(errors.join('\n'));
      return { adapter: adapter.info, cases: results, comparedValues: results.length * queries.length };
    } finally { for (const b of held) b.destroy(); device.destroy(); }
  });
  assert.deepEqual(errors, []);
  assert.equal(report.cases.length, 22);
  await mkdir(OUTPUT, { recursive: true });
  await writeFile(join(OUTPUT, 'attention-regression.json'), JSON.stringify({ sourcePath, ...report }, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}

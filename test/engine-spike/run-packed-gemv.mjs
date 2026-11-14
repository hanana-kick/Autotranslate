// Real WebGPU regression: packed Q4, partial output tiles and 2D dispatch tails.
// Extract private shader generators with the TS parser; execute their actual GPU output.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { chromium, launchOptions, ROOT, OUTPUT } from '../browser/support.mjs';

const sourcePath = resolve(process.env.KERNEL_SOURCE ?? join(ROOT, 'src/lib/kernels.ts'));
const source = await readFile(sourcePath, 'utf8');
const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
const declarations = new Map();
const wanted = new Set(['PACK_GEMV', 'gemvWgsl', 'rowsPerGroup', 'gemvGroups']);
function visit(node) {
  if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && node.name && wanted.has(node.name.getText(ast))) {
    const name = node.name.getText(ast);
    assert.ok(!declarations.has(name), `Ambiguous shader helper ${name}`);
    declarations.set(name, ts.isFunctionDeclaration(node) ? node.getText(ast) : `const ${node.getText(ast)};`);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(declarations.size, wanted.size, 'Missing shader helper');
const script = ts.transpileModule([...declarations.values()].join('\n') + '\nwindow.shaderTest = { PACK_GEMV, gemvWgsl, gemvGroups };', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
}).outputText;
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/shader.js' ? 'text/javascript' : 'text/html');
  res.end(req.url === '/shader.js' ? script : '<!doctype html><title>Packed matrix regression</title><script src="/shader.js"></script>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ ...launchOptions, args: launchOptions.args.filter(a => a !== '--disable-gpu') });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(String(error)));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const report = await page.evaluate(async () => {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter');
    const device = await adapter.requestDevice();
    const errors = [], cases = [];
    device.addEventListener('uncapturederror', e => errors.push(e.error.message));
    const pipeline = code => device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code }), entryPoint: 'main' } });
    const group = (pipe, buffers) => device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })) });
    const pack = pipeline(shaderTest.PACK_GEMV);
    try {
      const fixtures = [
        [7, 128, 1], [9, 256, 3], [32768, 128, 1], [32769, 256, 3], [107521, 128, 8],
        [11, 384, 2, true], [13, 6144, 5, true], [17, 1536, 7, true],
        [7, 384, 1, true], [13, 1536, 4, true], [14, 256, 6, true], [19, 6144, 8, true]
      ];
      for (const [n, k, rows, dense = false] of fixtures) {
        const held = [];
        const alloc = (size, usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC) => {
          const buffer = device.createBuffer({ size: Math.max(16, size), usage }); held.push(buffer); return buffer;
        };
        try {
          const blocks = k / 128, wordsPerRow = k / 8, vectors = Math.ceil(n / 4) * wordsPerRow;
          const words = new Uint32Array(n * wordsPerRow), scales = new Float32Array(n * blocks);
          let seed = 913;
          for (let i = 0; i < words.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; words[i] = seed; }
          for (let row = 0; row < n; row++) for (let block = 0; block < blocks; block++) scales[row * blocks + block] = (1 + (row + block) % 7) / 128;
          const x = new Float32Array(rows * k);
          // Dense dyadic inputs exercise every nibble/component and long K loops
          // while keeping the independent CPU sums exactly representable in F32.
          const nonzero = dense ? Array.from({ length: k }, (_, i) => i)
            : [0, 63, 127, ...(k > 128 ? [128, 255] : [])];
          for (let row = 0; row < rows; row++) for (let j = 0; j < nonzero.length; j++) {
            x[row * k + nonzero[j]] = dense ? ((j * 13 + row * 7) % 31 - 15) / 16
              : (j % 2 ? -1 : 1) * (row + j + 1) / 4;
          }
          const count = rows * n, sentinel = 1234567;
          const output = new Float32Array(count + 4).fill(sentinel);
          const q = alloc(words.byteLength), packed = alloc(vectors * 16), scale = alloc(scales.byteLength), input = alloc(x.byteLength), out = alloc(output.byteLength);
          const usage = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
          const packInfo = alloc(32, usage), info = alloc(32, usage), staging = alloc(output.byteLength, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
          device.queue.writeBuffer(q, 0, words); device.queue.writeBuffer(scale, 0, scales);
          device.queue.writeBuffer(input, 0, x); device.queue.writeBuffer(out, 0, output);
          device.queue.writeBuffer(packInfo, 0, new Uint32Array([n, wordsPerRow, vectors, 0]));
          device.queue.writeBuffer(info, 0, new Uint32Array([n, k, blocks, rows]));
          const gemv = pipeline(shaderTest.gemvWgsl(rows));
          const encoder = device.createCommandEncoder();
          let pass = encoder.beginComputePass();
          pass.setPipeline(pack); pass.setBindGroup(0, group(pack, [q, packed, packInfo]));
          const packGroups = Math.ceil(vectors / 256);
          pass.dispatchWorkgroups(Math.min(4096, packGroups), Math.ceil(packGroups / 4096)); pass.end();
          pass = encoder.beginComputePass();
          pass.setPipeline(gemv); pass.setBindGroup(0, group(gemv, [packed, scale, input, out, info]));
          const grid = shaderTest.gemvGroups(n);
          pass.dispatchWorkgroups(...grid); pass.end();
          encoder.copyBufferToBuffer(out, 0, staging, 0, output.byteLength);
          device.queue.submit([encoder.finish()]);
          await staging.mapAsync(GPUMapMode.READ);
          const actual = new Float32Array(staging.getMappedRange());
          let maxAbs = 0;
          for (let row = 0; row < rows; row++) for (let outputRow = 0; outputRow < n; outputRow++) {
            let expected = 0;
            for (const column of nonzero) {
              const quantized = ((words[outputRow * wordsPerRow + (column >>> 3)] >>> ((column & 7) * 4)) & 15) - 8;
              expected += quantized * scales[outputRow * blocks + (column >>> 7)] * x[row * k + column];
            }
            const error = Math.abs(actual[row * n + outputRow] - expected);
            if (!(error <= 1e-6)) throw new Error(`n=${n} width=${rows} row=${outputRow}: ${actual[row * n + outputRow]} != ${expected}`);
            maxAbs = Math.max(maxAbs, error);
          }
          for (let i = count; i < actual.length; i++) if (actual[i] !== sentinel) throw new Error('Padded output overwrote canary');
          staging.unmap();
          cases.push({ n, k, rows, dense, grid, checkedValues: count, maxAbs });
        } finally { for (const b of held) b.destroy(); }
      }
      if (errors.length) throw new Error(errors.join('\n'));
      return { cases, errors };
    } finally { device.destroy(); }
  });
  assert.deepEqual(pageErrors, []);
  await mkdir(OUTPUT, { recursive: true });
  await writeFile(join(OUTPUT, 'packed-gemv-regression.json'), JSON.stringify({ sourcePath, ...report }, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}

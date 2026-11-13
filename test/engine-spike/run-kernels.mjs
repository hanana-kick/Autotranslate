// Real ONNX weights + our WebGPU kernels; no build, extension, ORT or tokenizer.
//   LENGTHS=128 BATCHES=3 STEPS=4 REPEATS=1 CURRENT_ONLY=1 node test/engine-spike/run-kernels.mjs
//   BASELINE_KERNEL=/tmp/autotranslate-kernel-baseline.ts node test/engine-spike/run-kernels.mjs
//   MODE=heterogeneous LENGTHS=32,128,512 BATCHES=3 STEPS=32 REPEATS=1 ...
//   PREFILL_POSITIONS=32 CURRENT_KERNEL=/tmp/candidate.ts QA_DIR=/tmp/kernel-qa ...
// Defaults: LENGTHS=128,512,1024 BATCHES=1,4,8 STEPS=128 REPEATS=3.
// MODE=uniform|heterogeneous|all; heterogeneous compares queued requests with
// the same requests run individually, with varying prompt and output lengths.
// HEADLESS=0 shows Chrome; PROFILE_RUN=1 uses a fresh, deleted persistent profile.
// MODEL_DIR defaults to weight/plamo-3-translate-0.8b-onnx; MODEL_FILE overrides it.
// VARIANT_KERNELS='{"candidate":"/tmp/candidate.ts"}' adds named source variants.
// WARM_STEPS=4, HETERO_REQUESTS=16, RUN_TIMEOUT_MS=1800000 are configurable.
// VARIANT_OPTIONS='{"current":{"prefillPositions":64},"tile32":{"prefillPositions":32}}'
// computeMs is host-observed submission/queue wait, NOT a GPU timestamp.
// CHECK_LOGITS=1 BATCHES=1 compares all vocabulary logits after the final step;
// its diagnostic copy happens outside the timed workload.
// UNSAFE_WEBGPU=1 opts into experimental browser features; default uses ordinary WebGPU.
// VARIANT_OPTIONS can select matmul:"portable"|"f16"|"matrix" or attention:"decode"|"tiled".
// mixedPositions:8..64 independently caps total tokens in mixed prefill/decode steps.
// VARIANT_SHADERS='{"baseline":{"kernelmatmul":"path.ts","kernelattention":"path.ts"}}'
// Each variant gets isolated shader namespaces; hashes include its exact modules.
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { chromium, launchOptions, ROOT } from '../browser/support.mjs';

function integer(name, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer in ${min}..${max}`);
  return value;
}
function integers(name, fallback, max) {
  const values = (process.env[name] ?? fallback).split(',').map(Number);
  if (!values.length || values.some((n) => !Number.isSafeInteger(n) || n < 1 || n > max)) throw new Error(`Invalid ${name}`);
  return [...new Set(values)];
}
const config = {
  lengths: integers('LENGTHS', '128,512,1024', 2047),
  batches: integers('BATCHES', '1,4,8', 8),
  steps: integer('STEPS', 128, 1, 2047),
  repeats: integer('REPEATS', 3),
  warmSteps: integer('WARM_STEPS', 4, 1, 2047),
  heteroRequests: integer('HETERO_REQUESTS', 16),
  mode: process.env.MODE ?? 'uniform',
  prefillPositions: process.env.PREFILL_POSITIONS ? integer('PREFILL_POSITIONS', 8, 8, 64) : null,
  rows: 8,
  maxTokens: 2048,
  coalesceMs: 1,
  headless: process.env.HEADLESS !== '0',
  profileRun: process.env.PROFILE_RUN === '1',
  checkLogits: process.env.CHECK_LOGITS === '1',
  unsafeWebgpu: process.env.UNSAFE_WEBGPU === '1',
  timeoutMs: integer('RUN_TIMEOUT_MS', 1800000)
};
if (!['uniform', 'heterogeneous', 'all'].includes(config.mode)) throw new Error('MODE must be uniform, heterogeneous or all');
if (config.lengths.some((n) => n + Math.max(config.steps, config.warmSteps) > config.maxTokens)) throw new Error('Prompt length + STEPS/WARM_STEPS must not exceed 2048');
if (config.checkLogits && (config.batches.some((n) => n !== 1) || config.mode !== 'uniform')) {
  throw new Error('CHECK_LOGITS requires BATCHES=1 MODE=uniform');
}
const modelPath = resolve(process.env.MODEL_FILE || join(process.env.MODEL_DIR || join(ROOT, 'weight/plamo-3-translate-0.8b-onnx'), 'model_q4f16.onnx'));
const sources = [];
if (process.env.CURRENT_ONLY !== '1' && process.env.BASELINE_KERNEL) sources.push({ name: 'baseline', path: resolve(process.env.BASELINE_KERNEL) });
sources.push({ name: 'current', path: resolve(process.env.CURRENT_KERNEL || join(ROOT, 'src/lib/kernels.ts')) });
if (process.env.VARIANT_KERNELS) {
  const extra = JSON.parse(process.env.VARIANT_KERNELS);
  if (!extra || Array.isArray(extra) || typeof extra !== 'object') throw new Error('VARIANT_KERNELS must be a name:path object');
  for (const [name, path] of Object.entries(extra)) {
    if (!name || sources.some((source) => source.name === name) || typeof path !== 'string') throw new Error(`Invalid variant ${name}`);
    sources.push({ name, path: resolve(path) });
  }
}
const variantOptions = JSON.parse(process.env.VARIANT_OPTIONS || '{}');
for (const source of sources) {
  source.options = variantOptions[source.name] ?? {};
  for (const [key, value] of Object.entries(source.options)) {
    if (['prefillPositions', 'mixedPositions'].includes(key) && Number.isInteger(value) && value >= 8 && value <= 64) continue;
    if (key === 'matmul' && ['auto', 'portable', 'f16', 'matrix'].includes(value)) continue;
    if (key === 'attention' && ['tiled', 'decode'].includes(value)) continue;
    throw new Error(`Invalid variant option ${source.name}.${key}`);
  }
}
const scripts = new Map();
async function transpile(path) {
  const source = await readFile(path, 'utf8');
  const result = ts.transpileModule(source, {
    fileName: path,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  });
  const errors = result.diagnostics?.filter((d) => d.category === ts.DiagnosticCategory.Error) ?? [];
  if (errors.length) throw new Error(errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n'));
  return { code: result.outputText, sha256: createHash('sha256').update(source).digest('hex') };
}
const weightsSource = await transpile(join(ROOT, 'src/lib/onnxweights.ts'));
scripts.set('/weights.js', weightsSource.code);
const shaderNames = ['kernelmatmul', 'kernelattention'];
const variantShaders = JSON.parse(process.env.VARIANT_SHADERS || '{}');
for (const [variant, overrides] of Object.entries(variantShaders)) {
  if (!sources.some((source) => source.name === variant) || !overrides || Array.isArray(overrides) ||
      typeof overrides !== 'object' || Object.entries(overrides).some(([name, path]) =>
        !shaderNames.includes(name) || typeof path !== 'string')) {
    throw new Error(`Invalid shader overrides for ${variant}`);
  }
}
const shaderSources = [];
const compiledShaders = new Map();
for (const [index, source] of sources.entries()) {
  const modules = [];
  for (const name of shaderNames) {
    const path = resolve(variantShaders[source.name]?.[name] ?? join(ROOT, `src/lib/${name}.ts`));
    if (!compiledShaders.has(path)) compiledShaders.set(path, await transpile(path));
    const compiled = compiledShaders.get(path);
    shaderSources.push({ variant: source.name, name, path, sha256: compiled.sha256 });
    modules.push(compiled.code);
  }
  const compiled = await transpile(source.path);
  source.sha256 = compiled.sha256;
  scripts.set(`/kernel-${index}.js`, `(() => {
    var AT = { onnxweights: window.AT.onnxweights };
    ${modules.join('\n')}
    ${compiled.code}
    window.kernelVariants[${JSON.stringify(source.name)}] = AT.kernels;
  })();`);
}
scripts.set('/bench.js', `(${installBenchmark.toString()})();`);
const html = '<!doctype html><meta charset="utf-8"><title>Kernel benchmark</title>' +
  '<script>window.kernelVariants = Object.create(null)</script><script src="/weights.js"></script>' +
  // Kernel scripts own their shader namespaces so a candidate cannot alter the baseline.
  sources.map((_, index) => `<script src="/kernel-${index}.js"></script>`).join('') + '<script src="/bench.js"></script>';
const modelStat = await stat(modelPath);
const qaDir = resolve(process.env.QA_DIR || join(ROOT, 'test-results/engine-spike'));
await mkdir(qaDir, { recursive: true });
const artifact = join(qaDir, `kernels-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}.json`);
const report = {
  version: 1, startedAt: new Date().toISOString(), config, variants: sources,
  shaderSources,
  model: { path: modelPath, bytes: modelStat.size, mtime: modelStat.mtime.toISOString(), parserSha256: weightsSource.sha256 },
  timingDefinition: 'Step wall includes encode + submission/queue wait + readback. computeMs is host wall time, not GPU timestamps. Pure and mixed phases are separate. First output may occur in prefill.',
  runs: [], comparisons: [], aggregates: [], validationErrors: [], pageErrors: [], console: [], cleanupErrors: []
};
const server = createServer((request, response) => {
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  response.setHeader('cache-control', 'no-store');
  if (path === '/model.onnx') {
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': modelStat.size });
    const stream = createReadStream(modelPath);
    stream.on('error', (error) => response.destroy(error));
    response.on('close', () => stream.destroy());
    stream.pipe(response);
  } else if (path === '/' || scripts.has(path)) {
    response.writeHead(200, { 'content-type': path === '/' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8' });
    response.end(path === '/' ? html : scripts.get(path));
  } else {
    response.writeHead(404);
    response.end();
  }
});
let browser;
let context;
let page;
let work;
let failure;
let interrupt;
const interrupted = new Promise((_, reject) => { interrupt = reject; });
// Mark handled even if interrupted during browser launch rather than evaluation.
interrupted.catch(() => {});
const onSignal = (signal) => interrupt(new Error(`Interrupted by ${signal}`));
const sigint = () => onSignal('SIGINT');
const sigterm = () => onSignal('SIGTERM');
process.on('SIGINT', sigint);
process.on('SIGTERM', sigterm);
async function evaluate(fn, argument) {
  let timer;
  try {
    return await Promise.race([
      page.evaluate(fn, argument), interrupted,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Browser operation exceeded ${config.timeoutMs}ms`)), config.timeoutMs); })
    ]);
  } finally { clearTimeout(timer); }
}
async function save() { await writeFile(artifact, JSON.stringify(report, null, 2) + '\n'); }
try {
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const options = {
    ...launchOptions, headless: config.headless,
    ignoreDefaultArgs: [...(launchOptions.ignoreDefaultArgs ?? []), '--disable-gpu'],
    args: [...launchOptions.args.filter((arg) => arg !== '--disable-gpu'),
      ...(config.unsafeWebgpu ? ['--enable-unsafe-webgpu'] : []),
      ...(process.platform === 'darwin' ? ['--use-webgpu-adapter=apple'] : [])]
  };
  if (config.profileRun) {
    work = await mkdtemp(join(tmpdir(), 'autotranslate-kernels-'));
    context = await chromium.launchPersistentContext(join(work, 'profile'), options);
  } else {
    browser = await chromium.launch(options);
    context = await browser.newContext();
  }
  report.browser = (browser ?? context.browser())?.version() ?? null;
  page = await context.newPage();
  page.on('pageerror', (error) => report.pageErrors.push(error.message));
  page.on('console', (message) => report.console.push({ type: message.type(), text: message.text() }));
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
  report.setup = await evaluate((settings) => window.bench.initialize(settings), config);
  const conditions = [];
  if (config.mode !== 'heterogeneous') {
    for (const length of config.lengths) for (const batch of config.batches) {
      conditions.push({ key: `uniform-${length}-${batch}`, mode: 'uniform', batch,
        requests: Array.from({ length: batch }, (_, id) => ({ id, length, steps: config.steps })) });
    }
  }
  if (config.mode !== 'uniform') {
    for (const batch of config.batches) {
      conditions.push({ key: `heterogeneous-${batch}`, mode: 'heterogeneous', batch,
        requests: Array.from({ length: config.heteroRequests }, (_, id) => ({ id,
          length: config.lengths[id % config.lengths.length], steps: Math.max(1, Math.floor(config.steps * (1 - (id % 3) / 4))) })) });
    }
  }
  report.conditions = conditions;
  for (const condition of conditions) {
    for (let repeat = 0; repeat < config.repeats; repeat += 1) {
      // Reverse each repetition to counter a consistently warmer/faster second variant.
      const order = repeat % 2 ? [...sources].reverse() : sources;
      for (const source of order) {
        const schedules = condition.mode === 'heterogeneous' ? (repeat % 2 ? ['individual', 'batched'] : ['batched', 'individual']) : ['batched'];
        for (const schedule of schedules) {
          const run = await evaluate((job) => window.bench.run(job), { variant: source.name, options: source.options, condition, repeat, schedule });
          run.phases = phaseTotals(run.samples);
          report.runs.push(run);
          console.log(`[kernels] ${source.name} ${condition.key} ${schedule} repeat=${repeat + 1} ${run.wallMs.toFixed(1)}ms ${run.outputTokens} outputs`);
          await save();
        }
      }
    }
  }
  report.expectedRuns = conditions.reduce((sum, condition) => sum + (condition.mode === 'heterogeneous' ? 2 : 1), 0) * config.repeats * sources.length;
  if (report.runs.length !== report.expectedRuns) throw new Error(`Expected ${report.expectedRuns} runs, received ${report.runs.length}`);
  report.comparisons = compareRuns(report.runs);
  report.aggregates = aggregateRuns(report.runs);
  report.validationErrors = await evaluate(() => window.bench.errors);
  if (report.validationErrors.length || report.pageErrors.length) throw new Error('GPU validation or page errors; see artifact');
} catch (error) {
  failure = error;
  report.error = error.stack ?? String(error);
} finally {
  // Only collect the small failure snapshot; never wait on an in-flight runner.
  if (page && !page.isClosed()) {
    try {
      const snapshot = await Promise.race([
        page.evaluate(() => window.bench?.snapshotAndDestroy()),
        new Promise((resolve) => { const timer = setTimeout(() => resolve(null), 3000); timer.unref(); })
      ]);
      if (snapshot) {
        report.validationErrors = snapshot.errors;
        if (failure) report.failedRun = snapshot.active;
      }
    } catch (error) { report.cleanupErrors.push(String(error)); }
  }
  try { await context?.close(); } catch (error) { report.cleanupErrors.push(String(error)); }
  try { await browser?.close(); } catch (error) { report.cleanupErrors.push(String(error)); }
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  if (work) await rm(work, { recursive: true, force: true }).catch((error) => report.cleanupErrors.push(String(error)));
  process.off('SIGINT', sigint);
  process.off('SIGTERM', sigterm);
  report.finishedAt = new Date().toISOString();
  report.comparisons = compareRuns(report.runs);
  report.aggregates = aggregateRuns(report.runs);
  await save();
  console.log(JSON.stringify({ artifact, runs: report.runs.length, mismatchedComparisons: report.comparisons.filter((entry) => !entry.equal).length, error: report.error ?? null }));
}
if (failure) throw failure;
if (report.validationErrors.length || report.cleanupErrors.length) throw new Error('GPU or cleanup errors; see artifact');

function phaseTotals(samples) {
  const result = {};
  for (const sample of samples) {
    const phase = result[sample.phase] ??= { steps: 0, inputTokens: 0, outputTokens: 0, wallMs: 0, computeMs: 0, encodeMs: 0, readbackMs: 0 };
    phase.steps += 1;
    for (const key of ['inputTokens', 'outputTokens', 'wallMs', 'computeMs', 'encodeMs', 'readbackMs']) phase[key] += sample[key];
  }
  for (const phase of Object.values(result)) {
    phase.inputWallTokensPerSecond = phase.wallMs ? phase.inputTokens * 1000 / phase.wallMs : null;
    phase.outputWallTokensPerSecond = phase.wallMs ? phase.outputTokens * 1000 / phase.wallMs : null;
    phase.inputComputeTokensPerSecond = phase.computeMs ? phase.inputTokens * 1000 / phase.computeMs : null;
    phase.outputComputeTokensPerSecond = phase.computeMs ? phase.outputTokens * 1000 / phase.computeMs : null;
  }
  return result;
}
function aggregateRuns(runs) {
  const groups = new Map();
  for (const run of runs) {
    run.phases = phaseTotals(run.samples);
    const key = `${run.variant}/${run.condition}/${run.schedule}`;
    const group = groups.get(key) ?? { key, variant: run.variant, condition: run.condition, schedule: run.schedule, repeats: 0, wallMs: 0, inputTokens: 0, outputTokens: 0, samples: [] };
    group.repeats += 1;
    for (const field of ['wallMs', 'inputTokens', 'outputTokens']) group[field] += run[field];
    group.samples.push(...run.samples);
    groups.set(key, group);
  }
  return [...groups.values()].map(({ samples, ...group }) => ({ ...group, phases: phaseTotals(samples), outputWallTokensPerSecond: group.outputTokens * 1000 / group.wallMs }));
}
function compareRuns(runs) {
  const comparisons = [];
  for (let a = 0; a < runs.length; a += 1) for (let b = a + 1; b < runs.length; b += 1) {
    const left = runs[a], right = runs[b];
    if (left.condition !== right.condition || left.repeat !== right.repeat) continue;
    const kind = left.variant !== right.variant && left.schedule === right.schedule ? 'variants'
      : left.variant === right.variant && left.schedule !== right.schedule ? 'scheduling' : null;
    if (!kind) continue;
    const sequences = left.outputs.map((output) => {
      const other = right.outputs.find((entry) => entry.id === output.id);
      let firstMismatch = null, differingTokens = 0;
      for (let index = 0; index < Math.max(output.tokens.length, other?.tokens.length ?? 0); index += 1) {
        if (output.tokens[index] !== other?.tokens[index]) { firstMismatch ??= index; differingTokens += 1; }
      }
      return { id: output.id, equal: !!other && differingTokens === 0, firstMismatch, differingTokens };
    });
    comparisons.push({ kind, left: a, right: b, condition: left.condition, repeat: left.repeat,
      equal: left.outputs.length === right.outputs.length && sequences.every((entry) => entry.equal), sequences });
  }
  return comparisons;
}

function installBenchmark() {
  let adapter, device, matrixSubgroupSize, model, settings, activeRunner;
  const destroyedDevices = new WeakSet();
  const referenceLogits = new Map();
  const errors = [];
  const bench = window.bench = { errors, active: null };
  const now = () => performance.now();
  const destroyDevice = () => {
    if (!device) return;
    destroyedDevices.add(device);
    device.destroy();
    device = null;
  };
  const openDevice = async () => {
    adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter');
    ({ device, matrixSubgroupSize } = await window.kernelVariants.current.openDevice(adapter));
    const current = device;
    current.addEventListener('uncapturederror', (event) => errors.push({ type: event.error.constructor.name, message: event.error.message }));
    current.lost.then((info) => {
      if (!destroyedDevices.has(current)) errors.push({ type: 'device-lost', reason: info.reason, message: info.message });
    });
  };
  const limitsOf = (limits) => {
    const result = {};
    for (const name in limits) if (typeof limits[name] === 'number') result[name] = limits[name];
    return result;
  };
  bench.initialize = async (config) => {
    settings = config;
    const started = now();
    if (!navigator.gpu) throw new Error('WebGPU unavailable');
    adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter');
    const info = adapter.info ?? await adapter.requestAdapterInfo?.();
    await openDevice();
    const deviceMs = now() - started;
    const fetched = now();
    const response = await fetch('/model.onnx');
    if (!response.ok) throw new Error(`Model fetch ${response.status}`);
    const buffer = await response.arrayBuffer();
    const fetchMs = now() - fetched;
    const parsed = now();
    model = AT.onnxweights.parse(buffer);
    return { deviceMs, fetchMs, parseMs: now() - parsed, totalMs: now() - started, modelBytes: buffer.byteLength,
      vocab: model.vocab, hidden: model.hidden, layers: model.layers.length,
      adapter: Object.fromEntries(['vendor', 'architecture', 'device', 'description', 'isFallbackAdapter'].map((key) => [key, info?.[key] ?? adapter[key] ?? null])),
      matrixSubgroupSize,
      adapterFeatures: [...adapter.features], adapterLimits: limitsOf(adapter.limits), deviceFeatures: [...device.features], deviceLimits: limitsOf(device.limits),
      userAgent: navigator.userAgent };
  };
  // Fixed arithmetic prompts, valid for this model's vocabulary. No random state
  // or special EOS IDs; the exact prompt is retained beside every output.
  function prompt(length, id) {
    if (model.vocab <= 32) throw new Error('Unexpected vocabulary');
    return Array.from({ length }, (_, index) => 32 + ((index * 1543 + id * 7919 + 17) % (model.vocab - 32)));
  }
  function validate(outcomes, requests, samples) {
    if (outcomes.length !== requests.length) throw new Error(`Expected ${requests.length} outcomes, received ${outcomes.length}`);
    const seen = new Set();
    for (const output of outcomes) {
      const request = requests.find((item) => item.id === output.id);
      if (!request || seen.has(output.id)) throw new Error(`Unknown/duplicate outcome ${output.id}`);
      seen.add(output.id);
      if (!output.ok) throw new Error(`Request ${output.id}: ${output.error}`);
      if (output.tokens.length !== request.steps) throw new Error(`Request ${output.id}: expected ${request.steps} outputs, received ${output.tokens.length}`);
      if (output.tokens.some((token) => !Number.isInteger(token) || token < 0 || token >= model.vocab)) throw new Error(`Invalid output token in ${output.id}`);
    }
    if (!samples.length) throw new Error('Missing onStep samples; kernel source must include benchmark instrumentation');
    for (const sample of samples) {
      if (!['prefill', 'decode', 'mixed'].includes(sample.phase)) throw new Error('Invalid sample phase');
      for (const field of ['inputTokens', 'outputTokens', 'activeRows', 'context', 'encodeMs', 'computeMs', 'readbackMs', 'wallMs']) {
        if (!Number.isFinite(sample[field]) || sample[field] < 0) throw new Error(`Invalid sample ${field}`);
      }
    }
    const input = samples.reduce((sum, sample) => sum + sample.inputTokens, 0);
    const output = samples.reduce((sum, sample) => sum + sample.outputTokens, 0);
    if (input !== requests.reduce((sum, request) => sum + request.length, 0)) throw new Error(`Incorrect sampled prompt count ${input}`);
    if (output !== requests.reduce((sum, request) => sum + request.steps, 0)) throw new Error(`Incorrect sampled output count ${output}`);
  }
  bench.run = async ({ variant, options, condition, repeat, schedule }) => {
    if (activeRunner) throw new Error('Concurrent runners forbidden');
    if (errors.length) throw new Error('Previous GPU error');
    const record = bench.active = { variant, options, condition: condition.key, repeat, schedule, batch: condition.batch,
      requests: condition.requests.map((request) => ({ ...request, prompt: prompt(request.length, request.id) })), samples: [], outputs: [] };
    const began = now();
    // A fresh device also releases any buffers an older baseline did not track.
    // Model bytes stay parsed once in this page; setup time is not throughput.
    destroyDevice();
    await openDevice();
    record.deviceMs = now() - began;
    let samples = [], outcomes = [];
    let onComplete = null;
    record.warmup = { samples, outputs: outcomes };
    let failed;
    let logitsBuffer;
    // Observe allocation only; every buffer and operation remains a real WebGPU
    // object. The full vocabulary output has a unique size in this model.
    const measuredDevice = settings.checkLogits ? new Proxy(device, {
      get(target, key) {
        if (key === 'createBuffer') return (descriptor) => {
          const buffer = target.createBuffer(descriptor);
          if (descriptor.size === settings.rows * model.vocab * 4 &&
              (descriptor.usage & GPUBufferUsage.STORAGE)) logitsBuffer = buffer;
          return buffer;
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
      set(target, key, value) { return Reflect.set(target, key, value, target); }
    }) : device;
    device.pushErrorScope('validation');
    device.pushErrorScope('out-of-memory');
    device.pushErrorScope('internal');
    try {
      const created = now();
      activeRunner = await window.kernelVariants[variant].create({ device: measuredDevice, model, maxTokens: settings.maxTokens,
        rows: settings.rows, coalesceMs: settings.coalesceMs, eosTokens: [],
        matrixSubgroupSize,
        ...(settings.prefillPositions !== null && variant !== 'baseline' ? { prefillPositions: settings.prefillPositions } : {}),
        ...options,
        onStep: (sample) => samples.push({ ...sample }),
        onDone: (outcome) => {
          outcomes.push({ ...outcome, ...(outcome.ok ? { tokens: [...outcome.tokens] } : {}) });
          onComplete?.(outcome);
        } });
      await device.queue.onSubmittedWorkDone();
      record.createMs = now() - created;
      record.runnerRows = activeRunner.rows();
      record.execution = activeRunner.execution?.() ?? null;
      if (record.runnerRows !== settings.rows) throw new Error(`Expected ${settings.rows} runner rows, received ${record.runnerRows}`);
      async function execute(requests, individual) {
        const width = individual ? 1 : condition.batch;
        // Keep at most `batch` requests outstanding, immediately replenishing
        // retired slots. Individual mode uses the identical admission path.
        let cursor = 0;
        const addNext = () => {
          if (cursor >= requests.length) return;
          const request = requests[cursor++];
          activeRunner.add({ id: request.id, prompt: request.prompt, maxNewTokens: request.steps });
        };
        onComplete = (outcome) => { if (outcome.ok) addNext(); };
        try {
          for (let index = 0; index < width; index += 1) addNext();
          await activeRunner.drain();
        } finally { onComplete = null; }
      }
      const warmRequests = record.requests.map((request) => ({ ...request, steps: settings.warmSteps }));
      const warmStarted = now();
      await execute(warmRequests, schedule === 'individual');
      validate(outcomes, warmRequests, samples);
      record.warmup.wallMs = now() - warmStarted;
      samples = record.samples;
      outcomes = record.outputs;
      const statsBefore = activeRunner.stats();
      const started = now();
      await execute(record.requests, schedule === 'individual');
      record.wallMs = now() - started;
      await device.queue.onSubmittedWorkDone();
      validate(outcomes, record.requests, samples);
      if (settings.checkLogits) {
        if (!logitsBuffer) throw new Error('Vocabulary output buffer not found');
        const staging = device.createBuffer({ size: model.vocab * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        let values;
        try {
          const encoder = device.createCommandEncoder();
          encoder.copyBufferToBuffer(logitsBuffer, 0, staging, 0, model.vocab * 4);
          device.queue.submit([encoder.finish()]);
          await staging.mapAsync(GPUMapMode.READ);
          values = new Float32Array(staging.getMappedRange().slice(0));
          staging.unmap();
        } finally { staging.destroy(); }
        if (values.some((value) => !Number.isFinite(value))) throw new Error('Nonfinite logits');
        const key = `${condition.key}/${repeat}`;
        const reference = referenceLogits.get(key);
        if (!reference) {
          referenceLogits.set(key, { variant, values });
          record.logits = { referenceVariant: variant, count: values.length };
        } else {
          let dot = 0, aa = 0, bb = 0, error2 = 0, absolute = 0, maxAbs = 0;
          for (let i = 0; i < values.length; i++) {
            const a = reference.values[i], b = values[i], delta = a - b;
            dot += a * b; aa += a * a; bb += b * b; error2 += delta * delta;
            absolute += Math.abs(delta); maxAbs = Math.max(maxAbs, Math.abs(delta));
          }
          const cosine = dot / Math.sqrt(aa * bb);
          const relativeL2 = Math.sqrt(error2 / aa);
          record.logits = { referenceVariant: reference.variant, count: values.length,
            cosine, relativeL2, meanAbs: absolute / values.length, maxAbs };
          if (!Number.isFinite(cosine) || cosine < 0.99999 || relativeL2 > 0.005) {
            throw new Error(`Logits differ: ${JSON.stringify(record.logits)}`);
          }
        }
      }
      record.outputs.sort((a, b) => a.id - b.id);
      record.inputTokens = record.requests.reduce((sum, request) => sum + request.length, 0);
      record.outputTokens = record.outputs.reduce((sum, outcome) => sum + outcome.tokens.length, 0);
      const statsAfter = activeRunner.stats();
      record.statsDelta = Object.fromEntries(Object.entries(statsAfter).map(([key, value]) => [key, value - (statsBefore[key] ?? 0)]));
    } catch (error) {
      failed = error;
      record.error = error.stack ?? String(error);
    } finally {
      try { await device.queue.onSubmittedWorkDone(); } catch (error) { failed ??= error; }
      activeRunner?.dispose();
      activeRunner = null;
      for (const type of ['internal', 'out-of-memory', 'validation']) {
        const error = await device.popErrorScope();
        if (error) errors.push({ variant, condition: condition.key, type, message: error.message });
      }
      record.totalMs = now() - began;
      destroyDevice();
    }
    if (errors.length) throw new Error(`GPU validation/device failure: ${JSON.stringify(errors)}`);
    if (failed) throw failed;
    return record;
  };
  bench.snapshotAndDestroy = () => {
    activeRunner?.dispose();
    activeRunner = null;
    destroyDevice();
    return { errors, active: bench.active };
  };
}

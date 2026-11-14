// Run prepare-hymt2.sh first. Test-only native /completion; never an extension backend.
// HYMT_ARTIFACT_DIR=/tmp/autotranslate-hymt2 HYMT_OUTPUT=test-results/model-comparison/hymt2 node test/model-comparison/hymt2-benchmark.mjs
import assert from 'node:assert/strict';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import os from 'node:os';
import { CORPUS } from '../sites-live/chunk-benchmark.mjs';

const COMMIT = 'f8b355a9eab32a23df26ae61ff1aacf2bb44ca38';
const REVISION = '9df5c824a00a744fb0512a29c640466f4d97dfb0';
const SHA256 = 'cc497fe8f033b52b3b8b00a7669e9661435432f9d4cd43f7ed24400c01507a93';
const root = resolve(process.env.HYMT_ARTIFACT_DIR ?? '/tmp/autotranslate-hymt2');
const context = Number(process.env.HYMT_CONTEXT ?? 2048);
const output = resolve(process.env.HYMT_OUTPUT ?? 'test-results/model-comparison/hymt2');
const rounds = Number(process.env.HYMT_ROUNDS ?? 2);
const kinds = (process.env.HYMT_KINDS ?? 'single,pool').split(',');
assert.ok(kinds.length && kinds.every(kind => ['single', 'pool'].includes(kind)), 'Unknown benchmark kind');
const port = Number(process.env.HYMT_PORT ?? 18791);
const threads = Number(process.env.HYMT_THREADS ?? 4);
const model = join(root, 'Hy-MT2-1.8B-1.25Bit.gguf');
const binary = join(root, 'build-compatible/bin/llama-server');
const base = `http://127.0.0.1:${port}`;
const sampling = { temperature: 0, top_k: 0, top_p: 1, min_p: 0, repeat_penalty: 1, seed: 42 };
const instruction = 'Translate the following text into Korean. Note that you should only output the translated result without any additional explanation:';
const poolInstruction = instruction;
const plans = [
  ...CORPUS.map(unit => ({ id: unit.id, kind: 'single', language: unit.source, items: [unit], source: unit.text, instruction })),
  ...['en', 'ja'].map(language => {
    const items = CORPUS.filter(unit => unit.source === language);
    return { id: `pool-${language}`, kind: 'pool', language, items, source: items.map((unit, index) => `${index + 1}. ${unit.text.replace(/\s+/gu, ' ').trim()}`).join('\n'), instruction: poolInstruction };
  })
];
const flags = ['--model', model, '--host', '127.0.0.1', '--port', String(port), '--jinja', '-ngl', '0',
  '--ctx-size', String(context), '--predict', '4096', '--parallel', '1', '--threads', String(threads), '--threads-batch', String(threads),
  '--batch-size', '512', '--ubatch-size', '512', '--no-cache-prompt', '--cache-ram', '0', '--no-context-shift', '--no-webui', '--no-warmup'];
const report = {
  startedAt: new Date().toISOString(), target: 'ko', rounds, kinds, corpus: CORPUS,
  model: { repository: 'tencent/Hy-MT2-1.8B-1.25Bit-GGUF', revision: REVISION, path: model, expectedSha256: SHA256 },
  runtime: { repository: 'sjl623/llama.cpp', commit: COMMIT, binary, flags,
    compatibility: 'Producer-era PR revision: STQ1_0 tensor type 42 / file type 41 matches unchanged requested GGUF. Rebased PR head 1e411d8 assigns tensor type 42 to Q2_0 and was not used.',
    buildFlags: ['CMAKE_BUILD_TYPE=Release', 'GGML_METAL=OFF', 'GGML_BLAS=OFF', 'GGML_ACCELERATE=ON', 'LLAMA_BUILD_TESTS=OFF', 'LLAMA_BUILD_EXAMPLES=OFF', 'LLAMA_BUILD_UI=OFF'] },
  hardware: { platform: os.platform(), arch: os.arch(), release: os.release(), cpus: os.cpus().map(c => c.model), memoryBytes: os.totalmem() },
  conditions: { sampling, maxNPredict: 4096, context, concurrency: 1, cachePrompt: false, glossary: null, pageContext: null,
    firstStreamDefinition: 'First received nonempty native SSE content delta, measured from fetch start; not browser paint.',
    wallDefinition: 'Fetch start to final SSE stream EOF; excludes precomputed template/tokenization and model startup.',
    samplingDeviation: 'Controlled greedy baseline: temperature 0, top_k 0, top_p 1, min_p 0, repeat_penalty 1; not model-card recommendation 0.7/20/0.6/1.05.',
    completenessCaveat: 'EOS and numbered-item coverage are structural checks, not proof of semantic completeness or translation quality.',
    comparisonCaveat: 'Native CPU STQ1_0 runtime, not WebGPU; tokenizers and prompt templates differ across models.' },
  plans, warmup: [], runs: [], summaries: [], errors: []
};
const save = () => writeFile(join(output, 'benchmark.json'), JSON.stringify(report, null, 2));
async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function json(path, body) {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}
function mapping(plan, text) {
  if (plan.kind === 'single') return { items: [{ id: plan.items[0].id, output: text }], missing: text.trim() ? [] : [plan.items[0].id], duplicates: [], unexpected: [], inOrder: true, preamble: '' };
  const matches = [...text.matchAll(/^\s*(\d+)\.\s+/gmu)];
  const numbers = matches.map(match => Number(match[1]));
  const items = matches.map((match, index) => ({ number: numbers[index], id: plan.items[numbers[index] - 1]?.id ?? null,
    output: text.slice(match.index + match[0].length, matches[index + 1]?.index ?? text.length).trim() }));
  return { items, missing: plan.items.filter((_, index) => !items.some(item => item.number === index + 1 && item.output)).map(item => item.id),
    duplicates: numbers.filter((number, index) => numbers.indexOf(number) !== index), unexpected: numbers.filter(number => number < 1 || number > plan.items.length),
    inOrder: numbers.every((number, index) => number === index + 1), preamble: text.slice(0, matches[0]?.index ?? text.length).trim() };
}
async function run(plan, round) {
  const result = { id: plan.id, kind: plan.kind, language: plan.language, round, promptTokens: plan.promptTokens.length,
    sourceTokens: plan.sourceTokens, nPredict: plan.nPredict, output: '', firstStreamMs: null, firstStreamText: null, streamEvents: [], errors: [] };
  const begun = performance.now();
  try {
    assert.ok(plan.nPredict > 0, `${plan.id}: full prompt (${plan.promptTokens.length} tokens) exceeds ${context}-token context; source is not truncated`);
    const response = await fetch(base + '/completion', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: plan.promptTokens, ...sampling, stream: true, n_predict: plan.nPredict, cache_prompt: false, return_tokens: true }),
      signal: AbortSignal.timeout(600000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    let buffer = '';
    function consume(event) {
      const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') return;
      const value = JSON.parse(data), ms = performance.now() - begun;
      if (value.error) throw new Error(JSON.stringify(value.error));
      result.streamEvents.push({ ms, ...value });
      if (typeof value.content === 'string' && value.content) {
        result.firstStreamMs ??= ms;
        result.firstStreamText ??= value.content;
        result.output += value.content;
      }
      if (value.stop) result.final = value;
    }
    for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
      buffer += chunk.replaceAll('\r\n', '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) { consume(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2); }
    }
    if (buffer.trim()) consume(buffer);
    if (!result.final) result.errors.push('Missing final native completion event');
  } catch (error) { result.errors.push(String(error.stack ?? error)); }
  result.wallMs = performance.now() - begun;
  result.mapping = mapping(plan, result.output);
  if (result.final) {
    const f = result.final;
    result.outputTokens = f.tokens_predicted;
    result.actualPromptTokens = f.tokens_evaluated;
    result.timings = f.timings;
    result.finish = { stop: f.stop, type: f.stop_type, truncated: f.truncated, stoppingWord: f.stopping_word };
    if (f.tokens_evaluated !== plan.promptTokens.length) result.errors.push('Prompt token count mismatch');
    if (f.timings?.prompt_n !== plan.promptTokens.length) result.errors.push('Full prefill not observed; unexpected reuse or protocol mismatch');
    if (f.stop_type !== 'eos' || f.truncated) result.errors.push(`Not a clean EOS: ${f.stop_type}, truncated=${f.truncated}`);
  }
  if (!result.output.trim()) result.errors.push('Empty output');
  if (result.mapping.missing.length || result.mapping.duplicates.length || result.mapping.unexpected.length || !result.mapping.inOrder || result.mapping.preamble) result.errors.push('Numbered item mapping failed');
  result.structurallyComplete = result.errors.length === 0;
  console.log(JSON.stringify({ id: result.id, round, prompt: result.actualPromptTokens, output: result.outputTokens, firstMs: result.firstStreamMs,
    wallMs: result.wallMs, stop: result.finish?.type, errors: result.errors }));
  return result;
}
let server, log, exitPromise;
try {
  assert.ok(Number.isInteger(rounds) && rounds >= 2, 'At least two warm measured rounds are required');
  await mkdir(output, { recursive: true });
  report.model.bytes = (await stat(model)).size;
  report.model.sha256 = await sha256(model);
  assert.equal(report.model.bytes, 461860800);
  assert.equal(report.model.sha256, SHA256);
  report.runtime.binarySha256 = await sha256(binary);
  report.runtime.sourceArchiveSha256 = await sha256(join(root, 'llama-compatible.tar.gz'));
  assert.equal(report.runtime.sourceArchiveSha256, 'a973cf30ed7583d4e60fe256b0c2a579560a306f72e01f7e51c6b11d8d42be00');
  const version = spawnSync(binary, ['--version'], { encoding: 'utf8' });
  report.runtime.version = version.stdout + version.stderr;
  assert.equal(version.status, 0, report.runtime.version);
  report.runtime.cmakeCache = await readFile(join(root, 'build-compatible/CMakeCache.txt'), 'utf8');
  await save();
  log = createWriteStream(join(output, 'server.log'));
  const startup = performance.now();
  server = spawn(binary, flags, { stdio: ['ignore', 'pipe', 'pipe'] });
  exitPromise = new Promise(resolve => server.once('exit', (code, signal) => resolve({ code, signal })));
  await new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('Server startup deadline exceeded')), 120000);
    const fail = error => { clearTimeout(timer); reject(error); };
    server.once('error', fail);
    server.once('exit', (code, signal) => fail(new Error(`Server exited during startup: ${code}/${signal}`)));
    for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => {
      log.write(chunk);
      text = (text + chunk.toString()).slice(-32000);
      if (/listening on http:\/\/127\.0\.0\.1:/u.test(text)) { clearTimeout(timer); resolve(); }
    });
  });
  report.startupMs = performance.now() - startup;
  report.props = await json('/props');
  for (const plan of plans) {
    plan.userPrompt = `${plan.instruction}\n\n${plan.source}`;
    plan.prompt = (await json('/apply-template', { messages: [{ role: 'user', content: plan.userPrompt }] })).prompt;
    assert.equal(typeof plan.prompt, 'string');
    plan.promptTokens = (await json('/tokenize', { content: plan.prompt, add_special: false, parse_special: true })).tokens;
    plan.sourceTokens = (await json('/tokenize', { content: plan.source, add_special: false, parse_special: false })).tokens.length;
    plan.nPredict = Math.min(4096, context - plan.promptTokens.length - 1);
  }
  report.warmup.push(await run(plans[0], 'warmup'));
  await save();
  for (let round = 1; round <= rounds; round++) {
    const selected = plans.filter(plan => kinds.includes(plan.kind));
    const ordered = round % 2 ? selected : [...selected].reverse();
    for (const plan of ordered) { report.runs.push(await run(plan, round)); await save(); }
  }
  for (const kind of ['single', 'pool']) {
    const rows = report.runs.filter(row => row.kind === kind);
    if (!rows.length) continue;
    const sum = key => rows.reduce((total, row) => total + (row[key] ?? 0), 0);
    const promptMs = rows.reduce((total, row) => total + (row.timings?.prompt_ms ?? 0), 0);
    const decodeMs = rows.reduce((total, row) => total + (row.timings?.predicted_ms ?? 0), 0);
    report.summaries.push({ kind, requests: rows.length, structurallyComplete: rows.filter(row => row.structurallyComplete).length,
      wallMs: sum('wallMs'), promptTokens: sum('actualPromptTokens'), outputTokens: sum('outputTokens'),
      meanFirstStreamMs: sum('firstStreamMs') / rows.length, prefillTokensPerSecond: sum('actualPromptTokens') * 1000 / promptMs,
      decodeTokensPerSecond: sum('outputTokens') * 1000 / decodeMs, outputTokensPerWallSecond: sum('outputTokens') * 1000 / sum('wallMs') });
  }
  if (report.runs.some(row => !row.structurallyComplete)) process.exitCode = 1;
} catch (error) {
  report.errors.push(String(error.stack ?? error)); process.exitCode = 1;
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill('SIGTERM');
    const timer = setTimeout(() => server.kill('SIGKILL'), 10000);
    report.serverExit = await exitPromise;
    clearTimeout(timer);
  } else if (exitPromise) report.serverExit = await exitPromise;
  if (log) { log.end(); await once(log, 'finish'); }
  report.finishedAt = new Date().toISOString();
  await mkdir(output, { recursive: true });
  await save();
  console.log(JSON.stringify({ output, summaries: report.summaries, errors: report.errors, serverExit: report.serverExit }, null, 2));
}

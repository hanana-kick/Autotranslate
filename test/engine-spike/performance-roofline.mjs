#!/usr/bin/env node
// Arithmetic only: consume actual parsed-model inventory and WebGPU calibration.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const input = resolve(process.argv[2] ?? '');
assert.ok(process.argv[2], 'Usage: node performance-roofline.mjs profile.json [report.json]');
const output = resolve(process.argv[3] ?? 'test-results/browser/tps-roofline.json');
const raw = await readFile(input);
const profile = JSON.parse(raw);
assert.deepEqual(profile.validationErrors, []);
assert.deepEqual(profile.pageErrors, []);
const { weightInventory: inventory, bandwidth, layers, hidden, vocab } = profile.setup;
assert.ok(bandwidth?.samples.length >= 5, 'Needs PROFILE_DISPATCH=1 calibration');
assert.equal(layers, 16);
assert.equal(hidden, 1536);
assert.equal(vocab, 107520);
assert.equal(inventory.matrices.length, layers * 4 + 1);
const sum = xs => xs.reduce((a, b) => a + b, 0);
const matrices = inventory.matrices;
for (const m of matrices) {
  assert.equal(m.block, 128);
  assert.equal(m.packedBytes, m.n * m.k / 2);
  assert.equal(m.scaleBytes, m.n * m.k / 128 * 4);
}
const matrixBytes = sum(matrices.map(m => m.packedBytes + m.scaleBytes));
const parameters = sum(matrices.map(m => m.n * m.k));
const head = matrices.find(m => m.name === 'head');
assert.ok(head);
const projectionParameters = parameters - head.n * head.k;
const headBytes = head.packedBytes + head.scaleBytes;
const weightBytes = matrixBytes + inventory.normsAndFrequenciesBytes;
const queryHeads = 16, kvHeads = 1, headDimension = 128, scalarBytes = 4;
const kvBytesPerToken = 2 * layers * kvHeads * headDimension * scalarBytes;
const embeddingRowBytes = inventory.embeddingBytes / vocab;
const peakGBs = 153;
const calibrations = [
  { label: 'Apple whole-chip advertised peak', GBs: peakGBs },
  { label: 'WebGPU streaming probe median (scenario, NOT ceiling)', GBs: bandwidth.medianReadGBs },
];
const decode = [];
for (const previousTokens of [128, 512, 1024, 2047]) {
  for (const batch of [1, 2, 4, 8]) {
    // Each step writes one new KV row and reads prior+new rows. Ideal GQA reuse.
    const idealBytes = weightBytes + batch * (embeddingRowBytes + kvBytesPerToken * (previousTokens + 2));
    // Current shader reads K/V once per query head; cache may service the repeats.
    const shaderLogicalBytes = weightBytes + batch * (embeddingRowBytes + kvBytesPerToken * (1 + queryHeads * (previousTokens + 1)));
    const denseEquivalentOps = batch * (2 * parameters + 4 * layers * queryHeads * headDimension * (previousTokens + 1));
    decode.push({ previousTokens, batch, idealBytes, shaderLogicalBytes, denseEquivalentOps,
      bounds: calibrations.map(({ label, GBs }) => ({ label, GBs,
        idealStepMs: 1e3 * idealBytes / (GBs * 1e9),
        aggregateTPS: batch * GBs * 1e9 / idealBytes,
        sequenceTPS: GBs * 1e9 / idealBytes,
        noKvCacheReuseAggregateTPS: batch * GBs * 1e9 / shaderLogicalBytes,
      })) });
  }
}
const prefill = [128, 512, 1024].map(tokens => ({ tokens,
  // Final prompt position only runs the vocabulary projection.
  denseEquivalentOps: 2 * tokens * projectionParameters + 2 * head.n * head.k +
    4 * layers * queryHeads * headDimension * tokens * (tokens + 1) / 2,
  requiredEffectiveDenseTFLOPsFor1000TPS: (2 * tokens * projectionParameters + 2 * head.n * head.k +
    4 * layers * queryHeads * headDimension * tokens * (tokens + 1) / 2) / tokens * 1000 / 1e12,
}));
const targetRows = [{ batch: 1, previousTokens: 128, aggregateTPS: 240 },
  { batch: 1, previousTokens: 1024, aggregateTPS: 210 },
  { batch: 8, previousTokens: 128, aggregateTPS: 850 },
  { batch: 8, previousTokens: 1024, aggregateTPS: 600 }];
const targets = targetRows.map(t => {
  const row = decode.find(r => r.batch === t.batch && r.previousTokens === t.previousTokens);
  return { ...t, sequenceTPS: t.aggregateTPS / t.batch,
    stepBudgetMs: 1000 * t.batch / t.aggregateTPS,
    idealRequiredGBs: row.idealBytes * t.aggregateTPS / t.batch / 1e9,
    requiredEffectiveDenseTFLOPs: row.denseEquivalentOps * t.aggregateTPS / t.batch / 1e12,
    rationale: 'Engineering target, not a prediction; compare equal-token, non-instrumented warm runs.' };
});
const attribution = profile.runs.map(run => {
  const steps = run.gpuProfile.filter(s => s.phase === 'decode');
  const times = {};
  for (const step of steps) for (const pass of step.passes) {
    const key = pass.family === 'matmul' ? `matmul-${pass.shape.n}x${pass.shape.k}` : pass.family;
    times[key] = (times[key] ?? 0) + pass.gpuMs;
  }
  const span = sum(steps.map(s => s.spanGpuMs));
  return { condition: run.condition, steps: steps.length, spanGpuMsPerStep: span / steps.length,
    families: Object.entries(times).map(([family, ms]) => ({ family, gpuMsPerStep: ms / steps.length, spanPercent: 100 * ms / span })) };
});
const report = {
  provenance: { profile: input, sha256: createHash('sha256').update(raw).digest('hex'), model: profile.model,
    hardware: 'Apple M5, 24 GiB unified memory', browser: profile.browser,
    peakBandwidthSource: 'https://www.apple.com/newsroom/2025/10/apple-unleashes-m5-the-next-big-leap-in-ai-performance-for-apple-silicon/' },
  formulas: { decodeTPS: 'min(B * bandwidth / stepBytes, B * effectiveCompute / stepOps); overhead further reduces throughput',
    stepBytes: 'weights + B * (embedding row + KV bytes/token * (previousTokens + 2))',
    denseOps: 'B * (2 * matrixParameters + 4 * layers * queryHeads * headDimension * (previousTokens + 1))' },
  caveats: [
    'Conditional streamed-weight roofline: no persistent whole-model cache, perfect weight/GQA reuse, free activations/dispatch/readback. Not an unconditional physical maximum.',
    '153 GB/s is shared whole-chip bandwidth, not a browser allocation or guaranteed sustained GPU rate.',
    'Measured streaming median is a sensitivity scenario, not a universal maximum. DVFS/cache/workload affect it.',
    'Logical per-query-head KV reads are not necessarily DRAM reads; cache can reuse them.',
    'No measured effective compute roof supplied. Dense-equivalent FLOPs exclude Q4 unpacking, softmax, normalization and address arithmetic. Apple neural TOPS are not WebGPU FLOPs.',
    'GPU per-pass timestamps are quantized (observed 65.536 microsecond steps); aggregate many passes. Profiling adds passes/query handling and is not throughput acceptance.',
    'Batch TPS is aggregate, not per request. Prefill and autoregressive longest-sequence latency remain; whole-page millisecond completion is not implied.',
  ],
  footprint: { parameters, matrixBytes, headBytes, weightBytes, embeddingBytes: inventory.embeddingBytes,
    embeddingRowBytes, kvBytesPerToken, denseEquivalentMatrixOpsPerToken: 2 * parameters },
  bandwidth, decode, prefill, targets, attribution,
};
assert.equal(matrixBytes, 385204224);
assert.equal(kvBytesPerToken, 16384);
assert.ok(decode.every(r => r.bounds.every(b => b.aggregateTPS > 0 && b.sequenceTPS <= b.aggregateTPS)));
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.table(decode.filter(r => [128, 1024].includes(r.previousTokens) && [1, 8].includes(r.batch)).map(r => ({
  L: r.previousTokens, B: r.batch, peakTPS: r.bounds[0].aggregateTPS.toFixed(1),
  calibratedTPS: r.bounds[1].aggregateTPS.toFixed(1), noKvReusePeakTPS: r.bounds[0].noKvCacheReuseAggregateTPS.toFixed(1),
})));
console.table(targets);
console.log(`Saved ${output}`);

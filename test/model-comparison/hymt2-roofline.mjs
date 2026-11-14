#!/usr/bin/env node
// Static, read-only GGUF analysis: no model execution, GPU access, or downloads.
// Run: node test/model-comparison/hymt2-roofline.mjs [model.gguf] [report.json]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, openSync, closeSync, readSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const modelPath = resolve(process.argv[2] ?? '/tmp/autotranslate-hymt2/Hy-MT2-1.8B-1.25Bit.gguf');
const outputPath = resolve(process.argv[3] ?? 'test-results/model-comparison/hymt2/roofline.json');
const benchmarkPath = 'test-results/model-comparison/hymt2/context-2048/benchmark.json';
const expectedSha256 = 'cc497fe8f033b52b3b8b00a7669e9661435432f9d4cd43f7ed24400c01507a93';
const sourceCommit = 'f8b355a9eab32a23df26ae61ff1aacf2bb44ca38';
const appleUrl = 'https://www.apple.com/newsroom/2025/10/apple-unleashes-m5-the-next-big-leap-in-ai-performance-for-apple-silicon/';
const bandwidth = 153e9; // Apple's decimal GB/s, not GiB/s; shared whole-chip peak.
const memoryBytes = 24 * 2 ** 30;
const layouts = {
  0: { name: 'F32', elementsPerBlock: 1, bytesPerBlock: 4 },
  14: { name: 'Q6_K', elementsPerBlock: 256, bytesPerBlock: 210 },
  42: { name: 'STQ1_0', elementsPerBlock: 256, bytesPerBlock: 42 },
};
const sum = values => values.reduce((a, b) => a + b, 0);
const hash = createHash('sha256');
for await (const chunk of createReadStream(modelPath)) hash.update(chunk);
const sha256 = hash.digest('hex');
assert.equal(sha256, expectedSha256, 'This calculator is pinned to the exact producer-era STQ artifact');

// Buffered little-endian GGUF v3 reader. Tokenizer arrays are consumed, not retained.
class Reader {
  constructor(path) {
    this.fd = openSync(path, 'r');
    this.offset = 0;
    this.start = -1;
    this.length = 0;
    this.buffer = Buffer.allocUnsafe(65536);
  }
  take(size) {
    assert.ok(Number.isSafeInteger(size) && size >= 0);
    if (this.offset < this.start || this.offset + size > this.start + this.length) {
      if (size > this.buffer.length) this.buffer = Buffer.allocUnsafe(size);
      this.start = this.offset;
      this.length = readSync(this.fd, this.buffer, 0, this.buffer.length, this.offset);
      assert.ok(this.length >= size, 'Unexpected end of GGUF');
    }
    const value = this.buffer.subarray(this.offset - this.start, this.offset - this.start + size);
    this.offset += size;
    return value;
  }
  u32() { return this.take(4).readUInt32LE(); }
  u64() {
    const value = Number(this.take(8).readBigUInt64LE());
    assert.ok(Number.isSafeInteger(value));
    return value;
  }
  string() { return this.take(this.u64()).toString('utf8'); }
  value(type) {
    if (type === 8) return this.string();
    if (type === 9) {
      const elementType = this.u32();
      const count = this.u64();
      for (let i = 0; i < count; i++) this.value(elementType);
      return { elementType, count, valuesOmitted: true };
    }
    const readers = {
      0: [1, 'readUInt8'], 1: [1, 'readInt8'], 2: [2, 'readUInt16LE'], 3: [2, 'readInt16LE'],
      4: [4, 'readUInt32LE'], 5: [4, 'readInt32LE'], 6: [4, 'readFloatLE'], 7: [1, 'readUInt8'],
      10: [8, 'readBigUInt64LE'], 11: [8, 'readBigInt64LE'], 12: [8, 'readDoubleLE'],
    };
    assert.ok(readers[type], `Unsupported GGUF metadata type ${type}`);
    const [size, method] = readers[type];
    const value = this.take(size)[method]();
    if (typeof value === 'bigint') {
      assert.ok(Number.isSafeInteger(Number(value)));
      return Number(value);
    }
    return type === 7 ? Boolean(value) : value;
  }
}
const reader = new Reader(modelPath);
const metadata = {};
const tensors = [];
let version, tensorCount, metadataCount, headerBytes;
try {
  assert.equal(reader.take(4).toString(), 'GGUF');
  version = reader.u32();
  assert.equal(version, 3);
  tensorCount = reader.u64();
  metadataCount = reader.u64();
  for (let i = 0; i < metadataCount; i++) {
    const key = reader.string();
    metadata[key] = reader.value(reader.u32());
  }
  for (let i = 0; i < tensorCount; i++) {
    const name = reader.string();
    const dimensions = Array.from({ length: reader.u32() }, () => reader.u64());
    const type = reader.u32();
    const offset = reader.u64();
    const layout = layouts[type];
    assert.ok(layout, `Unknown tensor type ${type}`);
    assert.equal(dimensions[0] % layout.elementsPerBlock, 0);
    const elements = dimensions.reduce((a, b) => a * b, 1);
    tensors.push({ name, dimensions, type, typeName: layout.name, offset, elements,
      payloadBytes: elements / layout.elementsPerBlock * layout.bytesPerBlock });
  }
  headerBytes = reader.offset;
} finally {
  closeSync(reader.fd);
}
const alignment = metadata['general.alignment'] ?? 32;
const dataOffset = Math.ceil(headerBytes / alignment) * alignment;
const fileBytes = statSync(modelPath).size;
const sorted = [...tensors].sort((a, b) => a.offset - b.offset);
for (let i = 0; i < sorted.length; i++) {
  const tensor = sorted[i];
  const next = sorted[i + 1]?.offset ?? fileBytes - dataOffset;
  tensor.allocatedSpanBytes = next - tensor.offset;
  tensor.paddingBytes = tensor.allocatedSpanBytes - tensor.payloadBytes;
  assert.ok(tensor.paddingBytes >= 0 && tensor.paddingBytes < alignment);
  assert.equal(tensor.offset % alignment, 0);
}
const architecture = metadata['general.architecture'];
const field = name => metadata[`${architecture}.${name}`];
const config = { architecture, layers: field('block_count'), hidden: field('embedding_length'),
  feedForward: field('feed_forward_length'), queryHeads: field('attention.head_count'),
  kvHeads: field('attention.head_count_kv'), keyDimension: field('attention.key_length'),
  valueDimension: field('attention.value_length'), vocabulary: metadata['tokenizer.ggml.tokens'].count,
  ggufContextLimit: field('context_length'), evaluatedContextLimit: 2048 };
assert.equal(metadata['general.file_type'], 41);
assert.equal(config.keyDimension, config.valueDimension);
const projections = tensors.filter(t => t.type === 42);
const norms = tensors.filter(t => t.type === 0);
const head = tensors.find(t => t.name === 'token_embd.weight');
assert.equal(projections.length, 224);
assert.equal(norms.length, 129);
assert.ok(norms.every(t => t.name.endsWith('norm.weight')));
assert.equal(head.type, 14);
assert.deepEqual(head.dimensions, [config.hidden, config.vocabulary]);
assert.ok(!tensors.some(t => t.name === 'output.weight'), 'Expected tied embedding/output head');
assert.equal(projections.length + norms.length + 1, tensors.length);
const projectionBytes = sum(projections.map(t => t.payloadBytes));
const normBytes = sum(norms.map(t => t.payloadBytes));
const weightBytes = projectionBytes + normBytes + head.payloadBytes;
const parameters = sum(tensors.map(t => t.elements));
const projectionParameters = sum(projections.map(t => t.elements));
const embeddingRowBytes = head.payloadBytes / config.vocabulary;
const denseOps = 2 * (projectionParameters + head.elements);
const kvElementsPerToken = config.layers * config.kvHeads * (config.keyDimension + config.valueDimension);
const attentionOps = previousTokens => 4 * config.layers * config.queryHeads * config.keyDimension * (previousTokens + 1);
const kvBytes = (previousTokens, scalarBytes) => ({ read: previousTokens * kvElementsPerToken * scalarBytes,
  write: kvElementsPerToken * scalarBytes });
const decodeRows = [];
for (const precision of [{ name: 'F32', bytes: 4 }, { name: 'F16', bytes: 2 }]) {
  for (const previousTokens of [256, 1024, 2048]) {
    const kv = kvBytes(previousTokens, precision.bytes);
    for (const batch of [1, 2, 4, 8]) {
      for (const reuse of ['ideal-shared-weights', 'no-weight-reuse']) {
        const stepBytes = weightBytes * (reuse === 'ideal-shared-weights' ? 1 : batch)
          + batch * (embeddingRowBytes + kv.read + kv.write);
        const stepOps = batch * (denseOps + attentionOps(previousTokens));
        decodeRows.push({ kvPrecision: precision.name, previousTokens, batch, reuse,
          weightReadBytes: weightBytes * (reuse === 'ideal-shared-weights' ? 1 : batch),
          embeddingReadBytes: batch * embeddingRowBytes, kvReadBytes: batch * kv.read,
          kvWriteBytes: batch * kv.write, stepBytes, secondsLowerBound: stepBytes / bandwidth,
          aggregateTokensPerSecondUpperBound: batch * bandwidth / stepBytes,
          perSequenceTokensPerSecondUpperBound: bandwidth / stepBytes,
          denseEquivalentOpsPerStep: stepOps, arithmeticIntensityOpsPerByte: stepOps / stepBytes,
          computeOpsPerSecondNeededAtBandwidthCeiling: stepOps * bandwidth / stepBytes,
          residentWeightsAndKvBytes: weightBytes + batch * (previousTokens + 1) * kv.write,
          headShareOfStepBytes: head.payloadBytes * (reuse === 'ideal-shared-weights' ? 1 : batch) / stepBytes });
      }
    }
  }
}

const benchmarkBytes = await readFile(benchmarkPath);
const benchmark = JSON.parse(benchmarkBytes);
assert.equal(benchmark.model.sha256, sha256);
assert.equal(benchmark.conditions.context, config.evaluatedContextLimit);
const singles = benchmark.runs.filter(r => r.kind === 'single' && Number.isInteger(r.round));
const rounds = [...new Set(singles.map(r => r.round))];
const cases = singles.filter(r => r.round === rounds[0]).map(r => ({ id: r.id,
  promptTokens: r.actualPromptTokens, outputTokens: r.outputTokens, decodeStepsAfterPrefill: r.outputTokens - 1 }));
for (const round of rounds) {
  for (const row of singles.filter(r => r.round === round)) {
    const first = cases.find(c => c.id === row.id);
    assert.equal(row.outputTokens, first.outputTokens);
    assert.equal(row.actualPromptTokens, first.promptTokens);
    assert.ok(row.actualPromptTokens + row.outputTokens < config.evaluatedContextLimit);
  }
}
const corpusTokens = sum(cases.map(c => c.outputTokens));
const corpusDecodeSteps = sum(cases.map(c => c.decodeStepsAfterPrefill));
const corpusRows = [];
// All prompts are already prefilled for this decode-only thought experiment.
// Longest-first non-preemptive jobs, compacting finished slots, no cross-item context packing.
for (const scalarBytes of [4, 2]) {
  for (const batch of [1, 2, 4, 8]) {
    const queue = cases.map(c => ({ ...c, done: 0 })).sort((a, b) => b.decodeStepsAfterPrefill - a.decodeStepsAfterPrefill);
    let active = [], ticks = 0, kvTraffic = 0;
    while (queue.length || active.length) {
      while (active.length < batch && queue.length) active.push(queue.shift());
      for (const job of active) {
        const kv = kvBytes(job.promptTokens + job.done, scalarBytes);
        kvTraffic += kv.read + kv.write;
        job.done++;
      }
      ticks++;
      active = active.filter(job => job.done < job.decodeStepsAfterPrefill);
    }
    for (const reuse of ['ideal-shared-weights', 'no-weight-reuse']) {
      const weightReads = reuse === 'ideal-shared-weights' ? ticks : corpusDecodeSteps;
      const traffic = weightReads * weightBytes + corpusDecodeSteps * embeddingRowBytes + kvTraffic;
      for (const utilization of [1, 0.75, 0.5, 0.25]) {
        corpusRows.push({ kvPrecision: scalarBytes === 4 ? 'F32' : 'F16', batch, reuse,
          assumedBandwidthUtilization: utilization, scheduleTicks: ticks, weightReadBytes: weightReads * weightBytes,
          kvReadWriteBytes: kvTraffic, totalBytes: traffic, decodeSecondsLowerBound: traffic / (bandwidth * utilization) });
      }
    }
  }
}
const prefill = promptTokens => ({ promptTokens,
  denseEquivalentProjectionOps: 2 * promptTokens * projectionParameters,
  lastPositionHeadOps: 2 * head.elements,
  causalAttentionOps: 2 * config.layers * config.queryHeads * config.keyDimension * promptTokens * (promptTokens + 1),
  idealOnceReadWeightsPlusEmbeddingAndF32KvWriteBytes: weightBytes + promptTokens * (embeddingRowBytes + kvElementsPerToken * 4),
  caveat: 'Ideal weight/activation reuse, causal attention; logits at final prompt position only. Not a measured prefill speed; real tiling reloads weights/activations and may compute masked attention.' });
const noKvStepSeconds = (weightBytes + embeddingRowBytes) / bandwidth;
const longestDecodeChain = Math.max(...cases.map(c => c.decodeStepsAfterPrefill));
// Current-engine geometry and prior same-source token count supplied by the comparison assignment.
// This is a static matrix-payload comparison, not a new PLaMo measurement.
const plamo = { layers: 16, hidden: 1536, queryHeads: 16, kvHeads: 1, headDimension: 128,
  feedForward: 6144, vocabulary: 107520, qkvOutput: 2304, attentionOutputInput: 2048,
  q4BlockElements: 128, q4BlockPackedBytes: 64, q4BlockScaleBytes: 4,
  embeddingScalarBytes: 2, recordedDecodeStepsPerEightSources: 3435 };
const plamoProjectionParameters = plamo.layers * (plamo.hidden * plamo.qkvOutput
  + plamo.attentionOutputInput * plamo.hidden + 3 * plamo.hidden * plamo.feedForward);
const plamoHeadParameters = plamo.hidden * plamo.vocabulary;
const plamoBytesPerWeight = (plamo.q4BlockPackedBytes + plamo.q4BlockScaleBytes) / plamo.q4BlockElements;
const plamoMatrixBytes = (plamoProjectionParameters + plamoHeadParameters) * plamoBytesPerWeight;
const hyMatrixBytes = projectionBytes + head.payloadBytes;
const plamoKvElements = 2 * plamo.layers * plamo.kvHeads * plamo.headDimension;
const plamoComparison = {
  source: 'Current-engine geometry and same-eight-source 3435 decode steps supplied by parent assignment; arithmetic only, not a new benchmark or parsed PLaMo file.',
  inputs: plamo, q4BytesPerWeightIncludingF32Scales: plamoBytesPerWeight,
  plamoProjectionParameters, plamoHeadParameters,
  plamoProjectionBytes: plamoProjectionParameters * plamoBytesPerWeight,
  plamoQ4HeadBytes: plamoHeadParameters * plamoBytesPerWeight,
  plamoStreamingMatrixBytes: plamoMatrixBytes, hyStreamingMatrixBytes: hyMatrixBytes,
  hyToPlamoStreamingMatrixRatio: hyMatrixBytes / plamoMatrixBytes,
  hyMatrixTrafficIncreasePercent: 100 * (hyMatrixBytes / plamoMatrixBytes - 1),
  plamoResidentF16EmbeddingBytes: plamoHeadParameters * plamo.embeddingScalarBytes,
  plamoEmbeddingLookupBytesPerStep: plamo.hidden * plamo.embeddingScalarBytes,
  plamoResidentMatricesAndEmbeddingBytes: plamoMatrixBytes + plamoHeadParameters * plamo.embeddingScalarBytes,
  hyTiedHeadAndEmbeddingResidentBytes: head.payloadBytes,
  hyToPlamoKvElementsRatio: kvElementsPerToken / plamoKvElements,
  nominalOutputCountRatio: corpusTokens / plamo.recordedDecodeStepsPerEightSources,
  postPrefillHyToRecordedPlamoStepRatio: corpusDecodeSteps / plamo.recordedDecodeStepsPerEightSources,
  nominalWeightTrafficPerCorpusRatio: corpusTokens * hyMatrixBytes / (plamo.recordedDecodeStepsPerEightSources * plamoMatrixBytes),
  postPrefillWeightTrafficPerCorpusRatio: corpusDecodeSteps * hyMatrixBytes / (plamo.recordedDecodeStepsPerEightSources * plamoMatrixBytes),
  sameContextRows: [256, 1024, 2048].map(L => ({
    previousTokens: L, plamoF32KvReadWriteBytes: (L + 1) * plamoKvElements * 4,
    hyF32KvReadWriteBytes: (L + 1) * kvElementsPerToken * 4,
    plamoMatricesLookupAndF32KvBytes: plamoMatrixBytes + plamo.hidden * 2 + (L + 1) * plamoKvElements * 4,
    hyMatricesLookupAndF32KvBytes: hyMatrixBytes + embeddingRowBytes + (L + 1) * kvElementsPerToken * 4,
  })),
  caveats: [
    'PLaMo Q4 has 64 packed bytes + one F32 scale per 128 weights: 4.25 effective bpw, not nominal 4. Geometry totals exclude norms and all runtime overhead for both matrix-only figures.',
    'PLaMo full F16 embedding is resident storage, not streamed in full every step; only one 1536-element row is looked up. Hy embedding is tied to the full Q6 output head, which DOES stream for vocabulary logits.',
    '2599 Hy outputs include first outputs from prefill/EOS; 2591 is post-prefill decode. PLaMo 3435 is a recorded decode-step metric; phase/EOS/tokenizer conventions are not guaranteed identical. The two ratios bracket this particular first-token accounting difference, not every possible difference.',
    'Lower output-token count can offset larger matrix bytes across this corpus, but is not evidence of better semantic completeness, effective GPU speed, or equal context lengths. Hy has 8x KV elements/token at equal precision and cached-token count.',
    'A 1.25-bit model name alone does NOT promise less decode bandwidth than the existing PLaMo model; its larger architecture and Q6 vocabulary head outweigh the low-bit projection format.',
  ],
};
const report = {
  schemaVersion: 1,
  kind: 'Static conditional bandwidth roofline; not a CPU/GPU/browser benchmark',
  reproduction: 'node test/model-comparison/hymt2-roofline.mjs [model.gguf] [report.json]',
  provenance: {
    apple: { url: appleUrl, publicationDate: '2025-10-15', confirmed: '2026-11-14',
      quote: 'M5 offers unified memory bandwidth of 153GB/s', decimalBytesPerSecond: bandwidth,
      limitation: 'Whole-chip advertised peak shared with CPU/display/other workloads; not sustained WebGPU bandwidth or a WebGPU compute specification.' },
    quantizationLayouts: { url: `https://github.com/sjl623/llama.cpp/blob/${sourceCommit}/ggml/src/ggml-common.h`,
      sourceCommit, lines: '280-286 STQ1_0; 356-366 Q6_K', layouts,
      warning: 'Type42 means STQ1_0 only in this pinned producer-era format, not current upstream enumeration.' },
    model: { path: modelPath, sha256, fileBytes, repository: benchmark.model.repository, revision: benchmark.model.revision },
    existingCpuBenchmark: { path: benchmarkPath, sha256: createHash('sha256').update(benchmarkBytes).digest('hex'),
      measuredBackend: 'Native CPU, Metal OFF; copied historical observations, never rerun here',
      rounds: rounds.length, sourcesPerRound: cases.length, outputTokensPerRound: corpusTokens,
      meanCorpusWallSeconds: sum(singles.map(r => r.wallMs)) / rounds.length / 1000,
      weightedDecodeTokensPerSecond: benchmark.summaries.find(s => s.kind === 'single').decodeTokensPerSecond,
      warning: 'CPU time is not a WebGPU predictor; observed wall includes prefill unlike these decode-only bounds.' },
  },
  inputs: { bandwidthBytesPerSecond: bandwidth, assumedPhysicalMemoryBytes: memoryBytes,
    hardwareSource: 'Apple M5 / 24GiB recorded in existing benchmark.hardware', config, metadata,
    contexts: [256, 1024, 2048], batches: [1, 2, 4, 8], utilizationAssumptions: [1, 0.75, 0.5, 0.25] },
  gguf: { version, tensorCount, metadataCount, headerBytes, alignment, dataOffset,
    tensorPayloadBytes: weightBytes, totalTensorPaddingBytes: sum(tensors.map(t => t.paddingBytes)),
    fileNonPayloadBytes: fileBytes - weightBytes, tensors },
  currentPlamoComparison: plamoComparison,
  footprint: { parameters, projectionParameters, projectionBytes, q6HeadBytes: head.payloadBytes,
    normBytes, embeddingRowBytes, uniqueWeightBytes: weightBytes, actualWeightedBitsPerParameter: weightBytes * 8 / parameters,
    misleadingNominal125BitBytes: parameters * 1.25 / 8,
    q6HeadFractionOfWeightTraffic: head.payloadBytes / weightBytes,
    q6HeadFractionOfParameters: head.elements / parameters,
    noKvStreamedWeightsTokensPerSecondCeiling: 1 / noKvStepSeconds,
    noKvStreamedWeightsMillisecondsPerStepFloor: noKvStepSeconds * 1000 },
  equations: {
    payload: 'sum(tensor_elements / quant_block_elements * quant_block_bytes), checked against each on-disk offset span; no file header/tokenizer in hot loop',
    kv: 'K+V elements/token = layers * KV_heads * (key_dim + value_dim); read = L * elements * scalar_bytes; write = elements * scalar_bytes',
    decode: 'W = STQ_projection_bytes + full_Q6_tied_head_bytes + F32_norm_bytes; E = one_Q6_embedding_row; ideal_bytes = W + B*(E+KV_read+KV_write); no_reuse_bytes = B*(W+E+KV_read+KV_write)',
    bandwidth: 'step_time >= step_bytes/(153e9*u); aggregate_tps <= B*153e9*u/step_bytes, conditional on stated traffic model',
    denseEquivalent: '2*(projection_parameter_count + tied_head_parameter_count) per output step; multiply-add counts as 2',
    attention: '4*layers*query_heads*head_dim*(L+1) per token for QK and AV; includes new token attention, GQA KV loaded once per group',
    compute: 'step_time >= max(step_bytes/(153e9*u), dense_equivalent_ops/P_effective); P_effective for the actual STQ/Q6 WebGPU kernels is UNKNOWN',
    prefill: 'for P prompt tokens: 2*P*projection_parameters + 2*head_parameters + 2*layers*query_heads*head_dim*P*(P+1); last-position logits only',
    corpus: 'Actual G outputs require G-1 post-prefill decode steps (first output comes from prefill logits); KV previous lengths P..P+G-2. Sum bytes over the explicitly simulated schedule.',
    fluidRelaxation: 'N*W/B is a perfectly occupied weight-only lower bound, NOT a feasible completion-time claim for eight unequal autoregressive requests; longest-chain and integer rounds also constrain time.',
  },
  assumptions: [
    'Weights remain compressed in device-visible unified DRAM, not expanded to F16/F32; STQ is 42 bytes/256 = 1.3125 bpw including its scale; Q6_K is 210/256 = 6.5625 bpw.',
    'Each step streams each needed weight once from DRAM. Batch weight reuse means one tile load serves B independent sequences inside shared kernels, not B concurrent full model instances.',
    'No persistent full-model on-chip cache residency is assumed. DRAM residency in 24GiB is capacity, not cache residency or zero-bandwidth access. Cache-resident norms/embedding rows or parts of weights can reduce DRAM bytes; these are conditional streamed-weight ceilings, not universal physical limits.',
    'Norm coefficients counted once per step although Q/K normalization reuses them across heads. One embedding row is conservatively charged even though it is a subset of the later full tied-head read; perfect cache reuse can remove this tiny extra charge.',
    'KV uses grouped-query reuse: each stored K/V loaded once across its four query heads, current K/V available in registers for attention. Non-fused kernels may reread KV. F16 is an optional hypothetical cache format, not measured/supported here.',
    'L is previous cached token count; L=2048 is a sensitivity point beyond an additional decode within a strict 2048 context. Actual jobs obey prompt+output<2048. GGUF advertised 262144 is not the evaluated runtime capacity.',
    'Excluded traffic/work: activation spills, attention scores, logits materialization/readback, dequantization/scaling/lookup instructions, normalization/softmax/RoPE/nonlinearities, dispatches, scheduling, synchronization, sampling, tokenization, DOM paint, startup/download/upload, and OS/browser contention.',
    'Dense-equivalent operations are an accounting convention, not literal STQ instruction counts or a known GPU FLOPS roof. No invented M5 TFLOPS, Neural Engine TOPS, or Metal4 accelerator rate is substituted for unknown effective WebGPU compute.',
    '25/50/75% utilization are explicitly hypothetical sensitivity scenarios, not measured efficiencies or promised realistic browser throughput. Compute/overhead can lower throughput further.',
    'Corpus schedule assumes all eight prompts prefilled for free and admits completed slots immediately; full ideal B occupancy is only a relaxation. Tail effects and longest autoregressive chain are explicitly retained in the schedule.',
    'Context packing is not batching. Numbered pooling at 2048 truncated English and merged Japanese items in saved quality review; increasing capacity did not fix Japanese merging. Never count fewer/incomplete outputs as a speedup.',
  ],
  decodeDenseEquivalentOpsPerToken: denseOps,
  decodeRows,
  prefillRows: [256, 1024, 2048].map(prefill),
  corpus: { cases, outputTokensPerPass: corpusTokens, postPrefillDecodeSteps: corpusDecodeSteps,
    firstTokensAccountedInPrefill: cases.length, longestDecodeChain,
    postPrefillWeightOnlySecondsFloorAtAnyBatch: longestDecodeChain * noKvStepSeconds,
    perfectOccupancyWeightOnlyRelaxations: [1, 2, 4, 8].map(batch => ({ batch,
      fractionalSeconds: corpusDecodeSteps * noKvStepSeconds / batch,
      integerAndLongestChainSecondsFloor: Math.max(Math.ceil(corpusDecodeSteps / batch), longestDecodeChain) * noKvStepSeconds,
      caveat: 'No KV/compute/prefill; fractional occupancy is a relaxation, not the actual unequal-job schedule.' })),
    prefillInputs: cases.map(c => ({ id: c.id, ...prefill(c.promptTokens) })), rows: corpusRows },
  hundredMilliseconds: {
    targetSeconds: 0.1, corpusRequiredOutputTokensPerSecond: corpusTokens / 0.1,
    corpusRequiredDenseEquivalentDecodeOpsPerSecond: corpusDecodeSteps * denseOps / 0.1,
    streamedWeightOnlyMaxDecodeRounds: Math.floor(0.1 / noKvStepSeconds),
    streamedWeightOnlyMaxNewDecodeTokensBatch8: 8 * Math.floor(0.1 / noKvStepSeconds),
    minimumWeightOnlyBandwidthForLongestChainBytesPerSecond: longestDecodeChain * (weightBytes + embeddingRowBytes) / 0.1,
    conclusion: 'The observed 2599-token eight-source corpus cannot finish fresh in 100ms under this streamed-weight B<=8 model, even with zero prefill/KV/compute/dispatch cost. A larger page with comparable or greater output cannot either. This is conditional, not a claim about cached translations or an unspecified fully cache-resident/different decoding architecture.',
  },
  bottleneckPriority: [
    'First prove correct browser-native STQ/Q6 execution and full output coverage; do not switch production to a native-only model or equate CPU throughput with WebGPU.',
    'For actual throughput, prioritize true cross-sequence shared-weight batch kernels for BOTH STQ projections and the full Q6 output head; isolate independent contexts rather than concatenate numbered items.',
    'The large Q6 tied vocabulary head is a first-class bandwidth target, not a tiny embedding lookup. Optimize fused quantized matmul and on-device argmax/sampling; do not silently change weights/vocabulary to improve the bound.',
    'At larger context/batch, reduce KV traffic via GQA reuse and evaluate F16 KV correctness/support; maintain compressed weights and avoid needless materialization/readback.',
    'Only after actual throughput gains, optimize visible-first ordering/streaming paint and honest progress; these improve perceived latency, not complete-page tokens/second.',
  ],
};
assert.equal(dataOffset + sum(tensors.map(t => t.allocatedSpanBytes)), fileBytes);
assert.equal(corpusTokens, 2599);
assert.equal(corpusDecodeSteps, 2591);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Exact GGUF: ${fileBytes} bytes; payload ${weightBytes}; ${parameters} parameters; ${report.footprint.actualWeightedBitsPerParameter.toFixed(4)} weighted bpw`);
console.log(`STQ ${(projectionBytes / 1e6).toFixed(3)} MB; full Q6 head ${(head.payloadBytes / 1e6).toFixed(3)} MB (${(100 * head.payloadBytes / weightBytes).toFixed(2)}%); norms ${normBytes} B; lookup ${embeddingRowBytes} B`);
console.log('Conditional full-153GB/s ceilings; L=previous cached tokens; milliseconds per batch step:');
console.table(decodeRows.map(r => ({ KV: r.kvPrecision, L: r.previousTokens, B: r.batch,
  reuse: r.reuse === 'ideal-shared-weights' ? 'shared' : 'none', MB: +(r.stepBytes / 1e6).toFixed(2),
  ms: +(r.secondsLowerBound * 1000).toFixed(3), aggregateTPS: +r.aggregateTokensPerSecondUpperBound.toFixed(1),
  sequenceTPS: +r.perSequenceTokensPerSecondUpperBound.toFixed(1) })));
console.log('Actual 8-source corpus decode-only floors, including unequal-sequence tails (F32 KV, shared weights):');
console.table(corpusRows.filter(r => r.kvPrecision === 'F32' && r.reuse === 'ideal-shared-weights').map(r => ({
  B: r.batch, assumedUtilization: r.assumedBandwidthUtilization, rounds: r.scheduleTicks, seconds: +r.decodeSecondsLowerBound.toFixed(3) })));
console.log(`CPU historical corpus: ${report.provenance.existingCpuBenchmark.meanCorpusWallSeconds.toFixed(3)}s (NOT WebGPU). 100ms weight-only bound: <=${report.hundredMilliseconds.streamedWeightOnlyMaxNewDecodeTokensBatch8} new decode tokens at B8, versus ${corpusDecodeSteps} required after prefill.`);
console.log(`Current PLaMo matrices ${(plamoMatrixBytes / 1e6).toFixed(3)} MB vs Hy ${(hyMatrixBytes / 1e6).toFixed(3)} MB: Hy +${plamoComparison.hyMatrixTrafficIncreasePercent.toFixed(2)}%/step, 8x KV at equal precision/context. Corpus matrix-traffic ratio ${plamoComparison.nominalWeightTrafficPerCorpusRatio.toFixed(4)} nominal / ${plamoComparison.postPrefillWeightTrafficPerCorpusRatio.toFixed(4)} post-prefill; different token/phase conventions apply.`);
console.log(`Saved ${outputPath}`);

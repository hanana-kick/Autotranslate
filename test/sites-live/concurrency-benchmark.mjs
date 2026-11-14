// Engine-capacity experiment, NOT a production/UI concurrency setting.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CORPUS } from './chunk-benchmark.mjs';

const WIDTHS = [1, 2, 4, 8];
const quantile = (values, p) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : null;
};
const phase = (before, after, name) => {
  const elapsed = status => status[`${name}Tokens`] === 0 ? 0 : status[`${name}Tokens`] * 1000 / status[`${name}TokPerSec`];
  const tokens = after[`${name}Tokens`] - before[`${name}Tokens`];
  const ms = elapsed(after) - elapsed(before);
  return { tokens, ms, tokPerSec: tokens * 1000 / ms };
};

export async function runConcurrencyBenchmark({ context, options, worker, output, extension }) {
  const settings = await options.evaluate(() => AT.settings.load());
  assert.equal(settings.translationConcurrency, 1, 'leave production/UI concurrency at its existing default');
  assert.equal(CORPUS.length, 8);
  const config = { localModelId: settings.localModelId, localMaxTokens: 2048, target: 'ko' };
  const report = {
    startedAt: new Date().toISOString(), experiment: 'independent-one-source-engine-capacity',
    browser: context.browser()?.version(), config, physicalKernelContext: 2048,
    productionConcurrency: settings.translationConcurrency, widths: WIDTHS, rounds: 2, corpus: CORPUS,
    warmup: [], runs: [], comparisons: [], summaries: [], installedFiles: {},
    limits: [
      'One complete original source per AT.engines.translate call in the real installed service worker; no numbered pooling.',
      'Ordered refill queue keeps up to the requested width active; each request retains its source ID.',
      'No glossary, page context, role hint or result cache; output budgeting and native kernels remain unchanged.',
      'Widths 4 and 8 are engine-capacity experiments, not supported UI settings.',
      'First preview is a streaming callback, not DOM paint. Timings include production counting and host routing.',
      'Preview gaps measure consecutive nonempty streaming callbacks after the first preview; they are not individual GPU token intervals or DOM paint.',
      'Two warmed rounds reverse width order; one shared model session, no concurrent external GPU benchmarks.',
      'Phase milliseconds are reconstructed from cumulative host counts/rates and may reflect rate rounding; not GPU timestamp-query timings.',
      'Published prefill/decode counters exclude mixed-step time/tokens; the installed host does not expose those kernel counters.',
      'Host call overlap demonstrates in-flight requests, not by itself the number of GPU rows per step; no new profiling API is exported.',
      'Byte mismatches can be floating-point batch differences; full outputs/end clauses need inspection before claiming useful throughput.'
    ]
  };
  const save = () => writeFile(join(output, 'concurrency-benchmark.json'), JSON.stringify(report, null, 2));
  try {
    for (const name of ['lib/engines.js', 'lib/onnxhost.js', 'lib/kernels.js', 'lib/kernelmatmul.js', 'lib/kernelattention.js', 'hostworker.js']) {
      report.installedFiles[name] = createHash('sha256').update(await readFile(join(extension, name))).digest('hex');
    }
    report.hardware = await options.evaluate(async () => {
      const adapter = await navigator.gpu?.requestAdapter();
      const info = adapter?.info;
      return { userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency,
        adapter: info ? Object.fromEntries(['vendor', 'architecture', 'device', 'description', 'subgroupMinSize', 'subgroupMaxSize'].map(k => [k, info[k]])) : null,
        features: adapter ? [...adapter.features] : [],
        limits: adapter ? Object.fromEntries(['maxBufferSize', 'maxStorageBufferBindingSize', 'maxComputeWorkgroupStorageSize', 'maxComputeInvocationsPerWorkgroup'].map(k => [k, adapter.limits[k]])) : null };
    });
    const prepared = await options.evaluate(() => AT.sendMessage({ type: AT.C.MSG.LOCAL_PREPARE, target: 'ko', maxTokens: 2048 }));
    assert.equal(prepared.ok, true, prepared.error);
    report.prepared = prepared;
    const counted = await options.evaluate(async ({ config, texts }) => AT.local.callHost({
      type: AT.C.MSG.LOCAL_COUNT, modelId: config.localModelId, maxTokens: config.localMaxTokens, target: 'ko', texts
    }), { config, texts: CORPUS.map(u => u.text) });
    assert.equal(counted.ok, true, counted.error);
    assert.equal(counted.counts.length, CORPUS.length);
    report.counts = counted;

    async function run(width, units) {
      const result = await worker.evaluate(async ({ width, units, config }) => {
        const original = AT.local.callHost;
        const status = async () => {
          const reply = await original({ type: AT.C.MSG.LOCAL_QUERY });
          if (!reply.ok) throw new Error(reply.error);
          return reply.status;
        };
        const before = await status(), calls = [], items = new Array(units.length), started = performance.now();
        let cursor = 0, active = 0, peakActive = 0, firstPreviewMs = null;
        AT.local.callHost = async function(message, ...args) {
          const call = { type: message.type, ids: (message.texts ?? []).map(text => units.find(u => u.text === text)?.id ?? null),
            count: message.texts?.length ?? 0, source: message.source, target: message.target, context: message.context,
            maxTokens: message.maxTokens, atMs: performance.now() - started };
          calls.push(call);
          try {
            const reply = await original(message, ...args);
            call.ok = reply.ok; call.error = reply.error; return reply;
          } finally { call.completedMs = performance.now() - started; call.ms = call.completedMs - call.atMs; }
        };
        async function slot() {
          while (cursor < units.length) {
            const index = cursor++, unit = units[index];
            const item = { id: unit.id, source: unit.text, startMs: performance.now() - started,
              firstPreviewMs: null, lastPreviewMs: null, previewGapMs: [],
              previewUpdates: 0, previewClears: 0, firstPreview: null, translation: '', issue: null };
            items[index] = item;
            active++; peakActive = Math.max(peakActive, active);
            try {
              const reply = await AT.engines.translate({ ...config, texts: [unit.text], source: unit.source,
                context: null, role: null, onProgress: (position, text) => {
                  if (position !== 0) { item.issue = 'progress index outside independent request'; return; }
                  if (!text) { item.previewClears++; return; }
                  const now = performance.now() - started;
                  firstPreviewMs ??= now;
                  if (item.firstPreviewMs === null) { item.firstPreviewMs = now; item.firstPreview = text; }
                  if (item.lastPreviewMs !== null) item.previewGapMs.push(now - item.lastPreviewMs);
                  item.lastPreviewMs = now;
                  item.previewUpdates++;
                } });
              item.translation = reply.translations[0] ?? '';
              item.resultCount = reply.translations.length;
              item.timing = reply.timing;
              item.issue ??= AT.outputIssue(unit.text, item.translation) ?? null;
            } catch (error) { item.error = String(error.stack ?? error); item.issue = String(error.message ?? error); }
            finally {
              item.completedMs = performance.now() - started;
              item.ms = item.completedMs - item.startMs;
              item.previewLatencyMs = item.firstPreviewMs === null ? null : item.firstPreviewMs - item.startMs;
              active--;
            }
          }
        }
        try { await Promise.all(Array.from({ length: Math.min(width, units.length) }, () => slot())); }
        finally { AT.local.callHost = original; }
        const ms = performance.now() - started, after = await status();
        return { width, ms, firstPreviewMs, peakActive, items, calls, before, after };
      }, { width, units, config });
      result.generations = result.after.generations - result.before.generations;
      result.phases = { prefill: phase(result.before, result.after, 'prefill'), decode: phase(result.before, result.after, 'decode') };
      return result;
    }

    report.warmup.push(await run(1, [CORPUS[0], CORPUS[4]]));
    await save();
    for (let round = 1; round <= 2; round++) {
      for (const width of round === 1 ? WIDTHS : [...WIDTHS].reverse()) {
        const result = await run(width, CORPUS);
        result.round = round;
        report.runs.push(result);
        await save();
        assert.equal(result.after.backend, 'kernels', 'backend substitution invalidates comparison');
        assert.equal(result.items.length, 8);
        assert.equal(result.peakActive, width);
        assert.ok(result.calls.filter(c => c.type === 'at/local-translate').every(c => c.count === 1));
        console.log('[concurrency]', JSON.stringify({ round, width, ms: result.ms, firstPreviewMs: result.firstPreviewMs,
          generations: result.generations, issues: result.items.filter(i => i.issue).length, phases: result.phases }));
      }
    }
    for (const run of report.runs) {
      const baseline = report.runs.find(r => r.round === run.round && r.width === 1);
      for (const item of run.items) {
        const reference = baseline.items.find(i => i.id === item.id);
        const normalize = text => text.replace(/\s+/g, ' ').trim();
        // Shared source prefixes are intentional in the corpus, so only unrelated
        // sources' final clauses are used as contamination review flags.
        const foreignTails = baseline.items.filter(other => other.id !== item.id &&
          !other.source.includes(item.source) && !item.source.includes(other.source) && other.translation.length > 40)
          .filter(other => item.translation.includes(other.translation.slice(-40))).map(other => other.id);
        report.comparisons.push({ round: run.round, width: run.width, id: item.id,
          exact: item.translation === reference.translation, normalizedEqual: normalize(item.translation) === normalize(reference.translation),
          baselineChars: reference.translation.length, outputChars: item.translation.length,
          lengthRatio: reference.translation.length ? item.translation.length / reference.translation.length : null,
          sourceEnd: item.source.slice(-240), baselineEnd: reference.translation.slice(-240), outputEnd: item.translation.slice(-240),
          terminalPunctuation: /[.!?。！？]["'”’)]?$/u.test(item.translation.trim()), foreignTailMatches: foreignTails,
          issue: item.issue });
      }
    }
    for (const width of WIDTHS) {
      const runs = report.runs.filter(r => r.width === width), items = runs.flatMap(r => r.items);
      const totalMs = runs.reduce((sum, r) => sum + r.ms, 0);
      const phases = Object.fromEntries(['prefill', 'decode'].map(name => {
        const tokens = runs.reduce((sum, r) => sum + r.phases[name].tokens, 0);
        const ms = runs.reduce((sum, r) => sum + r.phases[name].ms, 0);
        return [name, { tokens, ms, tokPerSec: tokens * 1000 / ms }];
      }));
      report.summaries.push({ width, rounds: runs.length, sourceOutputs: items.length, totalMs, meanCorpusMs: totalMs / runs.length,
        sourceTokPerSec: counted.counts.reduce((a, b) => a + b, 0) * runs.length * 1000 / totalMs,
        sourceCharsPerSec: CORPUS.reduce((sum, u) => sum + [...u.text].length, 0) * runs.length * 1000 / totalMs,
        outputChars: items.reduce((sum, item) => sum + [...item.translation].length, 0),
        outputLengths: items.map(item => ({ id: item.id, chars: [...item.translation].length })),
        generations: runs.reduce((sum, r) => sum + r.generations, 0),
        hostTranslateCalls: runs.reduce((sum, r) => sum + r.calls.filter(c => c.type === 'at/local-translate').length, 0),
        previewLatencyP50Ms: quantile(items.map(i => i.previewLatencyMs), .5),
        previewLatencyP90Ms: quantile(items.map(i => i.previewLatencyMs), .9),
        previewGapP90Ms: quantile(items.flatMap(i => i.previewGapMs), .9),
        completionLatencyP50Ms: quantile(items.map(i => i.ms), .5), completionLatencyP90Ms: quantile(items.map(i => i.ms), .9),
        invalidItems: items.filter(i => i.issue).length,
        exactVsWidth1: report.comparisons.filter(c => c.width === width && c.exact).length, phases });
    }
    assert.equal(report.runs.flatMap(r => r.items).length, 64);
    report.finishedAt = new Date().toISOString();
    console.log('[concurrency-summary]', JSON.stringify(report.summaries, null, 2));
  } catch (error) { report.error = String(error.stack ?? error); throw error; }
  finally { await save(); }
}

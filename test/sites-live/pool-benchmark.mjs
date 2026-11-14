// Pooled whole-source translation through the unchanged installed native engine.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CORPUS } from './chunk-benchmark.mjs';

const POLICIES = [{ id: 'single', budget: 0 }, { id: 'pool-256', budget: 256 },
  { id: 'pool-512', budget: 512 }, { id: 'pool-all', budget: Infinity }];
const quantile = (values, p) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] : null;
};

export async function runPoolBenchmark({ context, options, worker, output }) {
  const rounds = Number(process.env.POOL_ROUNDS ?? 2);
  assert.ok(Number.isInteger(rounds) && rounds > 0 && rounds <= 8);
  const settings = await options.evaluate(() => AT.settings.load());
  assert.equal(settings.translationConcurrency, 1, 'pool size is varied, not concurrency');
  const prepared = await options.evaluate(() => AT.sendMessage({ type: AT.C.MSG.LOCAL_PREPARE, target: 'ko', maxTokens: 2048 }));
  assert.equal(prepared.ok, true, prepared.error);
  const config = { localModelId: settings.localModelId, localMaxTokens: 2048, target: 'ko' };
  const report = { startedAt: new Date().toISOString(), browser: context.browser()?.version(), config,
    physicalKernelContext: 2048, concurrency: 1, rounds, corpus: CORPUS, plans: [], warmup: [], runs: [], diagnostics: [], summaries: [],
    limits: [
      'Whole original sources, grouped by language in fixed source order; no glossary, page context or role hints.',
      'Source-token pool budgets are soft only for a single source longer than the budget; no source is fragmented.',
      'The harness does not replace production dispatch: native hosts may use independent rows; serial runtime hosts may use numbered prompts.',
      'AT.engines.translate is called in the real installed service worker; host-call tracing observes but does not replace inference.',
      'Native kernels are physically fixed at 2048 tokens; larger nominal host budgets do not increase KV capacity.',
      'First-preview is an engine streaming callback, not DOM paint or viewport-entry latency.',
      'Offline pool planning is excluded; production per-request counting, parsing and retries are included.',
      'Published pure prefill/decode counters exclude mixed-step work; wall time and complete outputs cover the whole workload.',
      'Automatic output checks and result counts do not establish semantic completeness; inspect complete translations.',
      'Reversed policy order in alternate rounds; one warm shared model, no result cache added.'
    ] };
  const save = () => writeFile(join(output, 'pool-benchmark.json'), JSON.stringify(report, null, 2));
  try {
    const counted = await options.evaluate(async ({ config, texts }) => AT.local.callHost({ type: AT.C.MSG.LOCAL_COUNT,
      modelId: config.localModelId, maxTokens: config.localMaxTokens, target: 'ko', texts }), { config, texts: CORPUS.map(u => u.text) });
    assert.equal(counted.ok, true, counted.error);
    assert.equal(counted.counts.length, CORPUS.length);
    report.counts = counted;
    const pools = ['en', 'ja'].map(source => ({ source, units: CORPUS.flatMap((unit, i) => unit.source === source ? [{ ...unit, tokens: counted.counts[i] }] : []) }));
    for (const policy of POLICIES) for (const pool of pools) {
      const groups = []; let current = [], tokens = 0;
      for (const unit of pool.units) {
        if (current.length && (policy.budget === 0 || tokens + unit.tokens > policy.budget)) {
          groups.push(current); current = []; tokens = 0;
        }
        current.push(unit); tokens += unit.tokens;
      }
      if (current.length) groups.push(current);
      report.plans.push({ policy: policy.id, source: pool.source, groups: groups.map(group => group.map(u => u.id)),
        sourceTokens: pool.units.reduce((n, u) => n + u.tokens, 0) });
    }
    async function run(plan, localMaxTokens = 2048) {
      const groups = plan.groups.map(ids => ids.map(id => CORPUS.find(u => u.id === id)));
      return worker.evaluate(async ({ plan, groups, config }) => {
        const original = AT.local.callHost;
        const status = async () => {
          const reply = await original({ type: AT.C.MSG.LOCAL_QUERY });
          if (!reply.ok) throw new Error(reply.error);
          return reply.status;
        };
        const before = await status(), calls = [], results = [], started = performance.now();
        let firstPreviewMs = null;
        // Observe actual engine sub-batches, including the counter request.
        AT.local.callHost = async function(message, ...args) {
          const call = { type: message.type, count: message.texts?.length ?? 0, texts: message.texts,
            atMs: performance.now() - started };
          calls.push(call);
          try { const reply = await original(message, ...args); call.ok = reply.ok; call.error = reply.error; return reply; }
          finally { call.ms = performance.now() - started - call.atMs; }
        };
        try {
          for (const group of groups) {
            const begin = performance.now(), previews = group.map(() => ({ firstMs: null, updates: 0, clears: 0 }));
            try {
              const reply = await AT.engines.translate({ ...config, texts: group.map(u => u.text), source: plan.source,
                context: null, role: null, onProgress: (index, text) => {
                  if (!previews[index]) throw new Error('progress index outside source group');
                  if (!text) { previews[index].clears++; return; }
                  firstPreviewMs ??= performance.now() - started;
                  previews[index].firstMs ??= performance.now() - begin;
                  previews[index].updates++;
                } });
              results.push({ ids: group.map(u => u.id), ms: performance.now() - begin, timing: reply.timing, previews,
                items: group.map((u, index) => ({ id: u.id, source: u.text, translation: reply.translations[index] ?? '',
                  issue: AT.outputIssue(u.text, reply.translations[index] ?? '') ?? null })) });
            } catch (error) {
              results.push({ ids: group.map(u => u.id), ms: performance.now() - begin, previews, error: String(error.message ?? error),
                items: group.map(u => ({ id: u.id, source: u.text, translation: '', issue: String(error.message ?? error) })) });
            }
          }
        } finally { AT.local.callHost = original; }
        const ms = performance.now() - started, after = await status();
        return { policy: plan.policy, source: plan.source, localMaxTokens: config.localMaxTokens, ms, firstPreviewMs,
          results, calls, before, after, valid: results.every(r => r.items.every(i => !i.issue)) };
      }, { plan, groups, config: { ...config, localMaxTokens } });
    }
    await save();
    for (const source of ['en', 'ja']) {
      const plan = report.plans.find(p => p.policy === 'pool-all' && p.source === source);
      report.warmup.push(await run(plan));
    }
    for (let round = 0; round < rounds; round++) {
      const policies = round % 2 ? [...POLICIES].reverse() : POLICIES;
      for (const policy of policies) for (const source of (round % 2 ? ['ja', 'en'] : ['en', 'ja'])) {
        const plan = report.plans.find(p => p.policy === policy.id && p.source === source);
        const result = await run(plan);
        assert.equal(result.after.backend, 'kernels', 'backend substitution invalidates comparison');
        result.round = round + 1;
        report.runs.push(result); await save();
        console.log('[pool]', round + 1, policy.id, source, JSON.stringify({ ms: Math.round(result.ms),
          firstPreviewMs: result.firstPreviewMs, outerRequests: result.results.length,
          hostGroups: result.calls.filter(c => c.type === 'at/local-translate').map(c => c.count),
          generations: result.after.generations - result.before.generations, valid: result.valid }));
      }
    }
    // Test the nominal maximum separately: it must never be reported as an 8192-token kernel.
    for (const source of ['en', 'ja']) {
      const result = await run(report.plans.find(p => p.policy === 'pool-all' && p.source === source), 8192);
      report.diagnostics.push(result); await save();
      console.log('[pool-nominal8192]', source, JSON.stringify({ ms: Math.round(result.ms),
        generations: result.after.generations - result.before.generations, valid: result.valid }));
    }
    for (const policy of POLICIES) {
      const runs = report.runs.filter(r => r.policy === policy.id), totalMs = runs.reduce((n, r) => n + r.ms, 0);
      const items = runs.flatMap(r => r.results.flatMap(g => g.items));
      const phaseRate = prefix => {
        let tokens = 0, ms = 0;
        for (const r of runs) {
          tokens += r.after[`${prefix}Tokens`] - r.before[`${prefix}Tokens`];
          ms += r.after[`${prefix}Tokens`] * 1000 / r.after[`${prefix}TokPerSec`] - r.before[`${prefix}Tokens`] * 1000 / r.before[`${prefix}TokPerSec`];
        }
        return { tokens, ms, tokPerSec: tokens * 1000 / ms };
      };
      report.summaries.push({ policy: policy.id, samples: runs.length, sourceItems: items.length,
        outerRequests: runs.reduce((n, r) => n + r.results.length, 0), hostRequests: runs.reduce((n, r) => n + r.calls.filter(c => c.type === 'at/local-translate').length, 0),
        generations: runs.reduce((n, r) => n + r.after.generations - r.before.generations, 0), totalMs,
        firstPreviewP50Ms: quantile(runs.map(r => r.firstPreviewMs), .5), poolCompletionP50Ms: quantile(runs.map(r => r.ms), .5),
        invalidItems: items.filter(i => i.issue).length,
        sourceTokPerSec: counted.counts.reduce((a, b) => a + b, 0) * rounds * 1000 / totalMs,
        sourceCharsPerSec: CORPUS.reduce((n, u) => n + [...u.text].length, 0) * rounds * 1000 / totalMs,
        prefill: phaseRate('prefill'), decode: phaseRate('decode') });
    }
    report.finishedAt = new Date().toISOString();
    console.log('[pool-summary]', JSON.stringify(report.summaries, null, 2));
  } catch (error) { report.error = String(error.stack ?? error); throw error; }
  finally { await save(); }
}

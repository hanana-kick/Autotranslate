// Coarse deterministic DOM regression gate, not native model performance.
// Large headroom avoids treating shared-runner noise as a kernel benchmark.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const dir = process.env.PLANNER_QA_DIR || 'test-results/planner';
const report = JSON.parse(await readFile(join(dir, 'summary.json'), 'utf8'));
assert.equal(report.failed, 0, 'all planner acceptance cases must pass');
const budgets = new Map([[100, [100, 250, 50]], [1000, [350, 1000, 100]], [4000, [1000, 3000, 300]]]);
const checks = [];
for (const item of report.performance) {
  const [first, total, restore] = budgets.get(item.size);
  for (const sample of item.samples) {
    assert.equal(sample.requests, item.size, 'no missing or duplicate unique input requests');
    assert.ok(sample.passes <= Math.ceil(item.size / 600), 'continuation has bounded progress');
  }
  const passed = item.medianFirstMs <= first && item.medianTotalMs <= total && item.medianRestoreMs <= restore;
  checks.push({ size: item.size, passed, observed: [item.medianFirstMs, item.medianTotalMs, item.medianRestoreMs], ceilingsMs: [first, total, restore] });
}
await writeFile(join(dir, 'performance-budget.json'), JSON.stringify({ scope: 'DOM-only gross regression budgets; identity provider', checks }, null, 2));
assert.ok(checks.length === 3 && checks.every(c => c.passed), JSON.stringify(checks));
console.log(JSON.stringify({ performanceBudgetPassed: true, checks }));

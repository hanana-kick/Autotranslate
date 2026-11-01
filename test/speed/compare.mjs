import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
const root=process.env.SPEED_RESULTS||'test-results/speed';
const baseline=JSON.parse(await readFile(root+'/baseline/speed.json','utf8'));
const candidate=JSON.parse(await readFile(root+'/candidate/speed.json','utf8'));
for(const report of [baseline,candidate]) {
  assert.equal(report.passed,true,'both actual-extension runs must complete');
  assert.equal(report.samples.length,9,'three workloads, three measured repetitions');
  assert.ok(report.samples.every(s=>s.restored&&s.completed>0&&Number.isFinite(s.totalMs)), 'no failed or un-restored samples may disappear');
}
const median=a=>a.slice().sort((a,b)=>a-b)[Math.floor(a.length/2)];
const checks=['cached','inline','foreground'].map(name=>{
  const a=baseline.samples.filter(s=>s.name===name),b=candidate.samples.filter(s=>s.name===name);
  assert.equal(a.length,3);assert.equal(b.length,3);
  const before=median(a.map(s=>s.totalMs)),after=median(b.map(s=>s.totalMs));
  return {name,baselineMedianMs:before,candidateMedianMs:after,ratio:after/before,
    baselineMedianFirstMs:median(a.map(s=>s.firstMs)),candidateMedianFirstMs:median(b.map(s=>s.firstMs)),
    baselineGenerations:a.map(s=>s.generations),candidateGenerations:b.map(s=>s.generations),
    baselineRecoveries:a.map(s=>s.recoveries),candidateRecoveries:b.map(s=>s.recoveries),
    passed:after<=before*0.90};
});
const report={scope:'Matched same-machine original-model installed Chrome extensions; 0.1.3 versus candidate; three repetitions per workload, not a universal device speed claim',checks};
await writeFile(root+'/comparison.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
assert.ok(candidate.samples.filter(s=>s.name==='foreground').every(s=>s.unreadChanged===0),'unread tabs cannot compete');
assert.ok(checks.every(c=>c.passed),'each targeted regression must improve its median by at least ten percent');

// Real installed-extension engine experiment. No production settings/policy changes.
// CHUNK_BENCH=1 MODEL_DIR=... node test/sites-live/run-sites.mjs
// CHUNK_COMPARE=1 compares whole/128/64-token serial requests and 64-token widths 2/4/8.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const CORPUS = [
  { id: 'short-comment', source: 'en', role: 'comment', text: 'I watched this twice because I missed the final explanation. Thank you for showing the original recording instead of only the edited version.' },
  { id: 'context-comment', source: 'en', role: 'comment', text: 'At first I thought the camera was broken, but the second example changed my mind. The dark area is a shadow from the bridge, not a defect in the sensor. If you pause at 02:14, you can see the same shadow on the other side of the road. Please keep that comparison in the next video because it explains the problem much better than the diagram.' },
  { id: 'long-comment', source: 'en', role: 'comment', text: 'I tried the method from your previous video on an old laptop, and the results were more complicated than I expected. The first run took almost a minute, but the next three runs finished in about twelve seconds each. I initially assumed that the new settings had solved the problem. After restarting the application, however, the long delay came back. It turned out that the program was loading the model from disk on the first request and keeping it in memory afterward. That means the comparison should separate startup time from the time spent translating each paragraph. I still prefer the new version because the text appears gradually and I can start reading before the whole response is ready. Could you include both measurements in your next test?' },
  { id: 'technical-paragraph', source: 'en', role: 'article', text: 'An inference server can improve total throughput by processing several independent sequences in the same model execution step. This does not mean that the latency of every request will decrease. A longer prompt requires additional prefill work before its first output token can be generated, while a larger decode batch shares memory bandwidth across more sequences. The scheduler must therefore balance the amount of pending input against the deadlines of requests that are already producing output. Cancellation also needs explicit ownership: a response from an obsolete request must not overwrite text that now belongs to another operation. For an interactive translation interface, useful measurements include the delay before the first visible translation, the completion time of an entire paragraph, and the proportion of requests that return valid output. Reporting only aggregate tokens per second can hide a slow or unreliable reading experience. A fair experiment keeps the model, source material, output limit, and concurrency unchanged while varying the input chunk budget.' },
  { id: 'japanese-comment', source: 'ja', role: 'comment', text: '最初は説明が速すぎると思いましたが、実際に自分のパソコンで試してみると意味が分かりました。設定を変更した直後だけ速くなるのではなく、再起動した後も同じ結果になるか確認することが大切ですね。特に、最初の一回にかかる時間と、その後の処理時間を分けて紹介してくれた点が参考になりました。次回は長い文章でも同じ比較を見てみたいです。' },
  { id: 'japanese-article', source: 'ja', role: 'article', text: '市の図書館は来月から電子書籍の貸し出しサービスを拡大します。利用者は図書館に登録した番号でログインし、自宅から資料を借りることができます。ただし、すべての本が同時に利用できるわけではありません。出版社との契約によって貸し出せる人数が決まっているため、人気のある本には予約が必要です。貸し出し期間は十四日間で、期限を過ぎると自動的に返却されます。図書館は、紙の本を廃止する計画はないと説明しています。電子書籍は来館が難しい人に新しい選択肢を提供するものであり、従来の閲覧室や相談窓口も引き続き利用できます。また、操作に不安がある人のために、毎週土曜日に無料の説明会を開く予定です。担当者は、利用状況を半年間調べたうえで、対象となる資料や対応する端末を増やすか判断すると話しています。個人の読書履歴を広告会社に提供することはありません。' }
];
CORPUS.push(
  { id: 'extended-technical', source: 'en', role: 'article', minimumTokens: 257,
    text: CORPUS.find(u => u.id === 'technical-paragraph').text + ' Consider a page containing a title, several long comments, and a list of recommended articles. The reader normally starts near the top, so completing a distant recommendation before the active comment provides little immediate value. A scheduler that continually switches between comments can also leave several partially translated sentences on screen. Increasing the input budget may reduce that fragmentation, but it must not remove the ability to react when the reader scrolls or opens a reply. Work that has already started can finish under its original identity, while work that has not started can be reordered. The application should retain the original source separately from the displayed translation, because replacing the source with a partial answer makes later continuation unreliable. Measurements should distinguish successful completion from a response that merely contains characters in the target language. A fluent answer can still omit a qualification, reverse a negation, or change a number. Finally, a setting that performs well on short English comments may behave differently on a long Japanese article, so both source languages and several length ranges should be included before choosing a default.' },
  { id: 'extended-japanese', source: 'ja', role: 'article', minimumTokens: 257,
    text: CORPUS.find(u => u.id === 'japanese-article').text + '説明会では、スマートフォンの文字を大きくする方法や、音声読み上げ機能の使い方も紹介します。参加するために新しい端末を購入する必要はなく、手持ちの機器を持参できます。利用者登録がまだ済んでいない場合は、住所を確認できる書類を窓口に持ってきてください。家族の番号を共有することはできませんが、子どもには保護者の同意を得たうえで専用の番号を発行します。通信環境が不安定な地域については、図書館内で資料を端末に保存してから持ち帰る方法を案内する予定です。保存した資料も貸し出し期限を過ぎると読めなくなるため、長期保存用のファイルとして配布されるわけではありません。サービスの拡大に伴う予算は、今年度の資料購入費とは別に確保されています。そのため、電子書籍を増やした分だけ紙の本の購入数を減らすという説明は正しくありません。市は来月末に最初の利用状況を公表しますが、その数字だけで事業の成功を判断しない方針です。担当者は、利用者数に加えて、読みたい資料を見つけられたか、困ったときに支援を受けられたかも調べる必要があると強調しています。問い合わせは電話と窓口の両方で受け付け、電子メールを使えない人も申し込めます。' }
);
const compareLengths = process.env.CHUNK_COMPARE === '1';
const POLICIES = compareLengths ? [
  { id: 'whole-serial', whole: true, concurrency: 1 },
  { id: 'tokens-128-serial', tokens: 128, concurrency: 1 },
  { id: 'tokens-64-serial', tokens: 64, concurrency: 1 },
  ...[2, 4, 8].map(concurrency => ({ id: `tokens-64-parallel-${concurrency}`, tokens: 64, concurrency }))
] : [{ id: 'chars-64', chars: 64 }, ...[64, 128, 256].map(tokens => ({ id: `tokens-${tokens}`, tokens }))];

// Historical 64 UTF-16-character policy, retained as a benchmark baseline.
function charChunks(source) {
  const chunks = [];
  while (source) {
    let end = Math.min(64, source.length);
    if (end < source.length) {
      if (/[\uD800-\uDBFF]/u.test(source[end - 1])) end--;
      const prefix = source.slice(0, end);
      const sentences = [...prefix.matchAll(/[.!?。！？](?=\s|$)|\n+/gu)];
      const spaces = [...prefix.matchAll(/\s+/gu)];
      const boundary = sentences.at(-1) ?? spaces.at(-1);
      if (boundary && /\S/u.test(prefix.slice(0, boundary.index + boundary[0].length))) end = boundary.index + boundary[0].length;
    }
    chunks.push(source.slice(0, end)); source = source.slice(end);
  }
  return chunks;
}

const quantile = (values, p) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : null;
};
const phase = (before, after, prefix) => {
  const tokens = after[`${prefix}Tokens`] - before[`${prefix}Tokens`];
  // Host publishes cumulative counts and rates, not cumulative phase durations.
  const elapsed = status => status[`${prefix}Tokens`] === 0 ? 0 : status[`${prefix}Tokens`] * 1000 / status[`${prefix}TokPerSec`];
  const ms = elapsed(after) - elapsed(before);
  assert.ok(tokens >= 0 && (tokens === 0 ? ms === 0 : ms > 0), `${prefix} counters must advance in one uninterrupted session`);
  return { tokens, ms };
};

export async function runChunkBenchmark({ context, options, worker, output, extension }) {
  assert.notEqual(process.env.TRANSLATION_CONCURRENCY, '2', 'leave production/UI concurrency unchanged');
  const rounds = Number(process.env.CHUNK_ROUNDS ?? 4);
  assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 12);
  const selected = process.env.CHUNK_CASES?.split(',').filter(Boolean);
  if (selected) assert.ok(selected.every(id => CORPUS.some(u => u.id === id)), 'unknown corpus ID');
  const corpus = selected ? CORPUS.filter(u => selected.includes(u.id)) : CORPUS;
  const settings = await options.evaluate(() => AT.settings.load());
  assert.equal(settings.translationConcurrency, 1);
  const config = { localModelId: settings.localModelId, localMaxTokens: compareLengths ? 2048 : settings.localMaxTokens, target: 'ko' };
  const prepared = await options.evaluate(maxTokens => AT.sendMessage({ type: AT.C.MSG.LOCAL_PREPARE, target: 'ko', maxTokens }), config.localMaxTokens);
  assert.equal(prepared.ok, true, prepared.error);
  const report = {
    startedAt: new Date().toISOString(), browser: context.browser()?.version(), config,
    productionConcurrency: settings.translationConcurrency, experiment: compareLengths ? 'same-source-length-and-concurrency' : 'serial-chunk-budget', rounds,
    corpus, policies: POLICIES, plans: [], warmup: [], runs: [], summaries: [], installedFiles: {},
    limits: [
      'Unchanged installed extension and real model; invokes AT.engines.translate in its service worker.',
      'First-preview timing is a validated engine streaming callback, not a browser paint or viewport-entry latency.',
      'One complete source at a time; chunks may overlap only within that source and are reassembled in source order.',
      'Source token counts use the host tokenizer. Token-budget partitioning is prepared offline and excluded from timed work.',
      'Each timed request still includes production token counting, prompt construction, generation, validation and built-in retries.',
      'No DOM/result cache; one warm shared model session. Native prefix reuse, if present, is not disabled.',
      'Comparison mode pairs forward/reverse policy order and rotates each pair; fixed English/Japanese corpus, not a public-site SLO.',
      'Phase rates are derived from cumulative host count/rate differences; successful-output throughput is reported separately.',
      'Source tok/s uses the unchanged unsplit source count; splitting can change tokenization and adds per-request prompt overhead.',
      'Pure prefill/decode host counters exclude mixed-step work; phase TPS is not total useful-source throughput.',
      'Widths 4/8 are engine-capacity experiments, not production/UI settings. No extra glossary or previous-chunk context.',
      'First ordered preview/completion refers to the first source chunk, not whichever parallel chunk finishes first.',
      'Automatic validity checks cannot establish semantic completeness or translation quality; inspect saved full outputs.'
    ]
  };
  const save = () => writeFile(join(output, 'chunk-benchmark.json'), JSON.stringify(report, null, 2));
  const count = async texts => {
    const counts = [];
    for (let at = 0; at < texts.length; at += 200) {
      const reply = await options.evaluate(async ({ texts, config }) => AT.local.callHost({
        type: AT.C.MSG.LOCAL_COUNT, modelId: config.localModelId, maxTokens: config.localMaxTokens, target: 'ko', texts
      }), { texts: texts.slice(at, at + 200), config });
      assert.equal(reply.ok, true, reply.error);
      assert.equal(reply.counts?.length, Math.min(200, texts.length - at));
      counts.push(...reply.counts);
    }
    return counts;
  };
  async function tokenChunks(source, budget, language) {
    const chunks = [];
    while (source) {
      const sentences = [...new Intl.Segmenter(language, { granularity: 'sentence' }).segment(source)].map(x => x.index + x.segment.length);
      let ends = [...new Intl.Segmenter(language, { granularity: 'word' }).segment(source)].map(x => x.index + x.segment.length);
      let counts = await count(ends.map(end => source.slice(0, end).trim()));
      let fit = ends.filter((end, index) => counts[index] <= budget);
      if (!fit.length) {
        ends = [...new Intl.Segmenter(language, { granularity: 'grapheme' }).segment(source)].map(x => x.index + x.segment.length);
        counts = await count(ends.map(end => source.slice(0, end).trim()));
        fit = ends.filter((end, index) => counts[index] <= budget);
      }
      assert.ok(fit.length, 'at least one grapheme must fit the source budget');
      const end = sentences.filter(end => fit.includes(end)).at(-1) ?? fit.at(-1);
      chunks.push(source.slice(0, end)); source = source.slice(end);
    }
    return chunks;
  }
  async function run(unit, plan) {
    return worker.evaluate(async ({ unit, plan, config }) => {
      const status = async () => {
        const reply = await AT.local.callHost({ type: AT.C.MSG.LOCAL_QUERY });
        if (!reply.ok) throw new Error(reply.error);
        return reply.status;
      };
      const before = await status();
      const start = performance.now();
      let firstPreviewMs = null, firstOrderedPreviewMs = null, firstCompleteMs = null, firstOrderedCompleteMs = null;
      let cursor = 0, active = 0, peakActive = 0;
      const parts = new Array(plan.chunks.length);
      async function slot() {
        while (cursor < plan.chunks.length) {
          const index = cursor++, source = plan.chunks[index].trim(), begun = performance.now();
          let previewMs = null, previewUpdates = 0, clearedPreviews = 0;
          active++; peakActive = Math.max(peakActive, active);
          try {
            const result = await AT.engines.translate({ ...config, source: unit.source, role: unit.role, context: null, texts: [source],
              onProgress: (_index, text) => {
                if (!text) { clearedPreviews++; return; }
                previewUpdates++;
                const now = performance.now();
                firstPreviewMs ??= now - start;
                if (index === 0) firstOrderedPreviewMs ??= now - start;
                previewMs ??= now - begun;
              }
            });
            const answer = result.translations[0] ?? '';
            const issue = AT.outputIssue(source, answer);
            const completedMs = performance.now() - start;
            if (!issue) {
              firstCompleteMs ??= completedMs;
              if (index === 0) firstOrderedCompleteMs = completedMs;
            }
            parts[index] = { index, source, answer, issue: issue ?? null, startedMs: begun - start, completedMs,
              ms: performance.now() - begun, previewMs, previewUpdates, clearedPreviews, timing: result.timing };
          } catch (error) {
            parts[index] = { index, source, answer: '', issue: String(error.message ?? error),
              startedMs: begun - start, completedMs: performance.now() - start,
              ms: performance.now() - begun, previewMs, previewUpdates, clearedPreviews };
          } finally { active--; }
        }
      }
      await Promise.all(Array.from({ length: Math.min(plan.concurrency, plan.chunks.length) }, () => slot()));
      const completionMs = performance.now() - start;
      const after = await status();
      return { id: unit.id, policy: plan.policy, firstPreviewMs, firstOrderedPreviewMs, firstCompleteMs, firstOrderedCompleteMs,
        completionMs, peakActive, parts, valid: parts.every(p => !p.issue), output: parts.map(p => p.answer).join(' '), before, after };
    }, { unit, plan, config });
  }
  try {
    for (const name of ['lib/engines.js', 'lib/onnxhost.js', 'lib/kernels.js', 'lib/kernelmatmul.js', 'lib/kernelattention.js', 'hostworker.js']) {
      report.installedFiles[name] = createHash('sha256').update(await readFile(join(extension, name))).digest('hex');
    }
    const planningStart = performance.now();
    for (const unit of corpus) {
      const [sourceTokens] = await count([unit.text]);
      if (unit.minimumTokens) assert.ok(sourceTokens >= unit.minimumTokens, 'extended corpus must exceed the largest budget');
      const partitions = new Map();
      for (const policy of POLICIES) {
        const key = policy.whole ? 'whole' : policy.chars ? `chars-${policy.chars}` : `tokens-${policy.tokens}`;
        if (!partitions.has(key)) {
          const chunks = policy.whole ? [unit.text] : policy.chars ? charChunks(unit.text) : await tokenChunks(unit.text, policy.tokens, unit.source);
          assert.equal(chunks.join(''), unit.text, 'partition must preserve every source character');
          const counts = await count(chunks.map(s => s.trim()));
          assert.ok(counts.every(n => Number.isFinite(n) && n > 0));
          if (policy.tokens) assert.ok(counts.every(n => n <= policy.tokens));
          partitions.set(key, { chunks, counts });
        }
        report.plans.push({ id: unit.id, policy: policy.id, concurrency: policy.concurrency ?? 1,
          sourceTokens, ...partitions.get(key) });
      }
    }
    report.planningMs = performance.now() - planningStart;
    await save();
    // Warm every partition policy on a long input, before taking counter deltas.
    const warm = corpus.find(u => u.id === 'technical-paragraph') ?? corpus[0];
    for (const policy of POLICIES) {
      const result = await run(warm, report.plans.find(p => p.id === warm.id && p.policy === policy.id));
      assert.equal(result.after.backend, 'kernels', 'no backend substitution in this experiment');
      report.warmup.push(result);
    }
    for (let round = 0; round < rounds; round++) {
      const shift = (compareLengths ? Math.floor(round / 2) * 2 : round) % POLICIES.length;
      const policies = [...POLICIES.slice(shift), ...POLICIES.slice(0, shift)];
      if (compareLengths && round % 2) policies.reverse();
      const ordered = [...corpus.slice(round % corpus.length), ...corpus.slice(0, round % corpus.length)];
      for (const policy of policies) {
        for (const unit of ordered) {
          const plan = report.plans.find(p => p.id === unit.id && p.policy === policy.id);
          const result = await run(unit, plan);
          assert.equal(result.after.backend, 'kernels');
          result.round = round + 1;
          result.prefill = phase(result.before, result.after, 'prefill');
          result.decode = phase(result.before, result.after, 'decode');
          report.runs.push(result);
          await save();
          console.log('[chunk]', round + 1, policy.id, unit.id, JSON.stringify({ requests: result.parts.length,
            firstPreviewMs: Math.round(result.firstPreviewMs), completionMs: Math.round(result.completionMs), valid: result.valid }));
          assert.ok(result.peakActive <= plan.concurrency);
          assert.equal(result.parts.length, plan.chunks.length);
        }
      }
    }
    for (const policy of POLICIES) {
      const runs = report.runs.filter(r => r.policy === policy.id);
      const all = runs.flatMap(r => r.parts);
      const totalMs = runs.reduce((n, r) => n + r.completionMs, 0);
      const sourceTokens = runs.reduce((n, r) => n + report.plans.find(p => p.id === r.id && p.policy === policy.id).sourceTokens, 0);
      const validSourceTokens = runs.filter(r => r.valid).reduce((n, r) => n + report.plans.find(p => p.id === r.id && p.policy === policy.id).sourceTokens, 0);
      const phaseRate = key => {
        const ms = runs.reduce((n, r) => n + r[key].ms, 0);
        return ms > 0 ? runs.reduce((n, r) => n + r[key].tokens, 0) * 1000 / ms : null;
      };
      report.summaries.push({ policy: policy.id, samples: runs.length, requests: all.length, validUnits: runs.filter(r => r.valid).length,
        invalidChunks: all.filter(p => p.issue).length, totalMs, firstPreviewP50Ms: quantile(runs.map(r => r.firstPreviewMs), .5),
        meanCompletionMs: totalMs / runs.length,
        orderedPreviewP50Ms: quantile(runs.map(r => r.firstOrderedPreviewMs), .5),
        orderedPreviewP95Ms: quantile(runs.map(r => r.firstOrderedPreviewMs), .95),
        orderedFirstCompleteP50Ms: quantile(runs.map(r => r.firstOrderedCompleteMs), .5),
        chunkRequestP95Ms: quantile(all.map(p => p.ms), .95),
        chunkSourceTokens: runs.reduce((n, r) => n + report.plans.find(p => p.id === r.id && p.policy === r.policy).counts.reduce((a, b) => a + b, 0), 0),
        firstPreviewP95Ms: quantile(runs.map(r => r.firstPreviewMs), .95), completionP50Ms: quantile(runs.map(r => r.completionMs), .5),
        completionP95Ms: quantile(runs.map(r => r.completionMs), .95), sourceTokPerSec: sourceTokens * 1000 / totalMs,
        validSourceTokPerSec: validSourceTokens * 1000 / totalMs, prefillTokPerSec: phaseRate('prefill'), decodeTokPerSec: phaseRate('decode'),
        prefillTokens: runs.reduce((n, r) => n + r.prefill.tokens, 0), decodeTokens: runs.reduce((n, r) => n + r.decode.tokens, 0),
        generations: runs.reduce((n, r) => n + r.after.generations - r.before.generations, 0) });
    }
    report.finishedAt = new Date().toISOString();
    console.log('[chunk-summary]', JSON.stringify(report.summaries, null, 2));
  } catch (error) {
    report.error = String(error.stack ?? error); throw error;
  } finally { await save(); }
}

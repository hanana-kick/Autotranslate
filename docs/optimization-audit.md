# Optimization audit — 2026-10-31

This audit evaluates scheduling/DOM overhead and functional translation/restoration, not linguistic quality. Production sources are unchanged from `c2530e80b6680df4889a26d321888e6e7228f7c6`; this follow-up adds tests and evidence workflows only. The priority findings below remain unresolved. Do not interpret the prior unit-test success as proof that this new acceptance matrix passes.

## Native DOM planner audit

Run: https://github.com/hanana-kick/Autotranslate/actions/runs/41176151919

Actual Chromium 143 loaded the production `targets`, `pipeline`, and `dom` modules. Identity responses were used **only** to expose actual request order and isolate planning/execution overhead without model time. These are not claimed as translations. The same matrix was run locally in Chromium 144.

**15 adversarial acceptance scenarios: 2 pass, 13 unmet.** This is not a representative real-web quality score. The visible-UI case deliberately asks for viewport-first rather than the existing content-first policy. Hidden-content eligibility also expresses the optimization goal of not spending foreground inference on invisible text; visibility changes would need to be observed if this policy is implemented.

| Case | Observed result |
| --- | --- |
| display:none | Hidden prose still becomes an inference request. |
| visibility:hidden / opacity:0 / closed details | All three hidden strings are requested. |
| display:contents | Visible text is placed after distant prose because its parent has no box. |
| Visible UI versus distant article | Distant article wins; this is the existing content-first policy, not an accidental comparator reversal. |
| Partial overlap at viewport top | top=-5 is treated as an earlier band and placed after prose at top=2000. |
| Horizontal offscreen content | x=-2000 is not considered; it precedes visible text. |
| Native button | A button inside main is classified as article, not form. |
| ARIA navigation ancestor | A child role=link masks the ancestor role=navigation. |
| Deep main | Sixteen wrappers exceed the twelve-ancestor scan and article becomes unknown. |
| Generic thread container | class=thread-page makes both original post and heading into comments. |
| Hidden prefix and small budget | A hidden 100-node navigation region consumes the scan window; the first ten requests are hidden, visible prose is not reached. |
| Initial page already scrolled | In a 4,500-node page scrolled to row 4,499, the first requests start around row 3,980, not the viewport. |
| maxNodes=5000 | A 5,002-node page processes 4,001 nodes and returns hasMore=false. |
| Protected regions | PASS: code, translate=no, and editable content stay untouched. |
| Basic native landmarks | PASS: heading, main prose, and explicit comment remain distinct. |

Root causes: the plan comparator does not use its computed visibility priority; role rank precedes location globally; parent rectangles are not actual text visibility; native/ARIA ancestor evidence is inconsistent; a capped DOM prefix excludes the viewport before ranking; scan truncation is not represented separately from processed-node count.

### CPU overhead (no model inference)

Five samples per size; medians on the Actions Chromium runner. `total` includes collection, planning, identity-response application and continuation passes, but excludes restore. Do not mix these measurements with model latency.

| Unique text nodes | Until first request | Total | Restore |
| ---: | ---: | ---: | ---: |
| 100 | 6.3 ms | 9.6 ms | 0.3 ms |
| 1,000 | 26.1 ms | 74.5 ms | 0.9 ms |
| 4,000 | 50.4 ms | 532.0 ms | 2.6 ms |

A separate local Chromium sampling profile of 4,000 nodes found `prune()` at 285.3 ms self time and `stats()` at 120.5 ms, versus 657.1 ms total under profiling. Profiling adds overhead; these are not the unprofiled timings above. `onApply(stats().translated)` scans the growing original-record map on each applied unit, before the content script's progress throttle. Incremental completion counters and periodic/removal-driven cleanup are better optimization targets than replacing the tiny sorting comparator.

## Genuine CPU translation and native HTML lifecycle

Run: https://github.com/hanana-kick/Autotranslate/actions/runs/41175998701

**6/6 lifecycle checks passed; 19 actual model generations including warmup; no uncaught browser JavaScript errors.**

Environment: GitHub Actions Ubuntu; AMD EPYC 9V74 host with **4 allocated logical CPUs**, 16,760,344,576 bytes RAM; Chromium 143, 1100×800 viewport. llama.cpp b11979 ran with `-ngl 0 -t 4 -tb 4 -c 4096 -np 1`. Model: TranslateGemma 4B IT Q8_0, 4,130,417,920 bytes, revision `35a7486e128b19642cdc72d7b91b21ba388aaf42`, SHA-256 `f5006ddf207becaace1668113a61b31cf8b2e03f0f0baa0d1ca37eb8371d4bc1`. The runtime asset digest and model hash were checked before execution.

The **production content script, DOM planner/executor, translation engine, prompt builders, and reply parser** were executed. The model transport was bridged to native llama.cpp. Browser message transport was a test adapter, not an installed extension's service worker/offscreen path. This is genuine inference, but **not the shipped MediaPipe task/runtime, not a WebGPU benchmark, and not evidence that the installed extension supports CPU inference**. The existing 17-test extension lifecycle suite covers browser APIs separately with an inference double.

| Check | Result |
| --- | --- |
| English article → Korean → cached re-run → restore | 7 eligible text nodes changed; all original HTML/text/attributes and element identities restored. Code/input/href/focus/click handler preserved. |
| Japanese page → Korean → restore | 3 text nodes translated and exact restore passed. |
| Inserted content while a real request is pending | MutationObserver translated the inserted node and restored its source. |
| Restore while a real request is pending | Restore returned without waiting; late reply discarded. Physical interruption of CPU inference is not claimed. |
| Page rewrites a node during a pending request | New source was translated; restore returned the newer source, not the stale one. |
| Korean → Japanese target change | New translation starts from source, and exact restoration passed. |

| Measurement | Observed |
| --- | ---: |
| English article, 7 nodes / 8 generations | 30.156 s |
| First applied article result | 3.417 s |
| Cached unchanged-page pass | 2.752 ms; **0 additional generations** |
| Article restore | 0.2 ms |
| Japanese page, 3 generations | 11.051 s |
| Restore while request pending | 0.3 ms |

These are single-run observations, not latency guarantees. The CPU bridge disables prompt-cache reuse (`cache_prompt:false`). Its prefill cost cannot be generalized to MediaPipe or the user's hardware.

### Concrete wasted inference

The inline sentence `Read <a>the installation guide</a> before continuing.` required a marked whole-sentence attempt and then three fragment requests when the real model dropped the markers. Total: **4 generations / 13.441 s**. The discarded first attempt alone cost **4.480 s**, 14.9% of this page's 30.156 s. Safe fallback preserves link ownership; avoiding a predictably unusable initial format is a separate optimization problem. This observation is one sample, not a measured universal marker-failure rate.

## Automation and evidence

- `.github/workflows/planner-audit.yml`: native DOM acceptance matrix, fails with a nonzero exit while criteria remain unmet. No continue-on-error or success laundering. It is a separate audit, not silently included in the existing release gate.
- `.github/workflows/cpu-optimization.yml`: downloads hash-verified genuine weights/runtime and runs all six cases; uploads HTML snapshots, screenshots, raw prompts/outputs/timings, server log, and Playwright trace. Weights are not uploaded as artifacts.
- The first CPU attempt exposed a harness issue: Playwright's default caret-hiding screenshot left an empty `style` attribute on an input. This was reproduced independently and fixed with `caret:'initial'`; an additional assertion now ensures the before screenshot itself did not change authored HTML. DOM equality assertions were not removed or weakened.
- Production optimization fixes are **not** part of this audit follow-up; main and release assets remain unchanged.

Reproduce planner checks with Node 24 after `npm ci`, `npm run build`, and installing the pinned test tooling (`npm install --no-save --package-lock=false --ignore-scripts playwright@1.57.0`, `npx playwright install chromium`):

```sh
PLANNER_ENFORCE=1 node test/optimization/planner-audit.mjs
```

To reproduce real inference, start the pinned CPU `llama-server` with the arguments above, then run:

```sh
LLAMA_URL=http://127.0.0.1:8766 node test/optimization/cpu-real.mjs
```

The endpoint must be loopback and dedicated to the test. Inputs are synthetic public fixtures, not user browsing content. See the workflow for exact model/runtime downloads and hash checks. Language quality, Firefox runtime, arbitrary public-site compatibility, mobile extension execution, and actual MediaPipe CPU/GPU performance are outside this audit.

# DOM optimization audit — 2026-10-31

This audit concerns scheduling/DOM overhead, not linguistic quality. The production planner/executor tested here is unchanged by the inference-host compatibility work. The findings remain unresolved. For actual installed-extension inference/restoration results, use `native-extension-testing.md` and the PR's native checks.

## Native DOM planner audit

Actions run: `41176151919`. Actual Chromium 143 loaded the production targets, pipeline and DOM modules. Identity responses were used **only to expose request order and isolate planner overhead**; they are not translations or whole-extension E2E evidence. The same matrix was reproduced locally in Chromium 144.

**15 adversarial cases: 2 pass, 13 unmet.** This is not a representative real-web quality score. The visible-UI case asks for viewport-first behavior rather than the current content-first policy. Hidden-content eligibility represents the optimization goal of avoiding foreground inference on invisible text; implementing it also requires visibility-change observation.

| Case | Observed result |
| --- | --- |
| display:none | Hidden prose becomes a request. |
| visibility:hidden / opacity:0 / closed details | All three hidden strings are requested. |
| display:contents | Visible text is placed after distant prose because the parent has no box. |
| Visible UI versus distant article | Distant article wins under the current content-first policy. |
| Partial overlap at viewport top | top=-5 is placed after prose at top=2000. |
| Horizontal offscreen content | x=-2000 is ignored and can precede visible text. |
| Native button | A button inside main is classified as article, not form. |
| ARIA navigation ancestor | Child role=link masks ancestor role=navigation. |
| Deep main | Sixteen wrappers exceed the twelve-ancestor scan. |
| Generic thread container | class=thread-page makes the original post and heading comments. |
| Hidden prefix with small budget | A hidden 100-node menu consumes the scan window; visible prose is not reached. |
| Initially scrolled page | A 4,500-node page scrolled to row 4,499 first processes nodes around row 3,980. |
| maxNodes=5000 | A 5,002-node page processes 4,001 nodes and returns hasMore=false. |
| Protected regions | PASS: code, translate=no and editable content remain untouched. |
| Basic native landmarks | PASS: heading, main prose and explicit comment remain distinct. |

The computed visibility priority is not used by the comparator; role rank precedes location globally. Parent rectangles do not establish text visibility. Native/ARIA evidence and ancestor scanning are inconsistent. Capping the DOM prefix can exclude the viewport before ranking, and scan truncation is not represented independently from processed-node count.

## CPU overhead without inference

Five samples per size, Actions Chromium medians. Total includes collection, planning, identity-response application and continuation, not restore or model inference.

| Text nodes | First request | Total | Restore |
| ---: | ---: | ---: | ---: |
| 100 | 6.3 ms | 9.6 ms | 0.3 ms |
| 1,000 | 26.1 ms | 74.5 ms | 0.9 ms |
| 4,000 | 50.4 ms | 532.0 ms | 2.6 ms |

A separate instrumented local 4,000-node profile found prune() at 285.3 ms self time and stats() at 120.5 ms out of 657.1 ms total. Do not mix profiled and unprofiled timings. onApply(stats().translated) repeatedly scans a growing map before progress throttling. Incremental counters and periodic/removal-driven cleanup are the optimization targets.

## Reproduction

With Node 24, built sources and pinned Playwright/Chromium:

```sh
PLANNER_ENFORCE=1 node test/optimization/planner-audit.mjs
```

The audit intentionally exits nonzero while criteria remain unmet; it is not silently waived or represented as a pass.

## Superseded alternate-engine experiment

Earlier history contains a llama.cpp bridge experiment. It did not test the installed extension's original inference path and is **not evidence of extension correctness or performance**. Its workflow and script have been removed. Do not use its timings or pass counts in extension release claims. Actual original-runtime CPU software-WebGPU and Metal results are documented separately in `native-extension-testing.md`.

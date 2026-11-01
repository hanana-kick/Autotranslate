# DOM optimization audit — 2026-11-01

This report concerns target eligibility, scheduling and DOM overhead, not linguistic quality or inference performance. Actual installed-extension verification is documented separately in `native-extension-testing.md`.

## Current acceptance result

[Actions run 41273951631](https://github.com/hanana-kick/Autotranslate/actions/runs/41273951631), source `8341a369e5db2d7d7834a46df89801687a4d311d`: **15/15 real-DOM acceptance cases passed, zero failed**. The earlier 2026-10-31 run `41176151919` had 2/15 passes; that is a historical baseline, not the current status.

The test loads the compiled production constants, page-context, target, pipeline and DOM modules in actual Chromium. Identity responses are used only to inspect request order and isolate planner overhead. They are not translations and cannot establish native extension E2E success. These deliberately adversarial cases are not a representative web-quality score.

| Acceptance case | Current behavior |
| --- | --- |
| display:none | Hidden prose is not requested. |
| visibility:hidden / opacity:0 / closed details | Hidden text is excluded; reveal changes are observed by the content script. |
| display:contents | Visible text geometry precedes distant prose. |
| Visible UI versus distant article | Viewport priority precedes semantic tie-breakers. |
| Partial viewport-top overlap | Partially visible text precedes distant text. |
| Horizontal offscreen content | Horizontal visibility is considered. |
| Native button | Classified as form rather than surrounding article. |
| ARIA navigation ancestor | Landmark evidence survives a child role=link. |
| Deep main | Main/article evidence survives sixteen wrappers. |
| Generic thread container | thread-page alone does not reclassify the entire post as comments. |
| Hidden prefix with small budget | Hidden menu text does not consume the eligible discovery budget. |
| Initially scrolled 4,500-node page | Current visible cohort is discovered and scheduled before offscreen text. |
| maxNodes=5000 on 5,002 nodes | Remaining work is reported, not silently truncated at 4,001. |
| Protected regions | Code, translate=no and editable content remain untouched. |
| Basic native landmarks | Heading, article and explicit comment remain distinct. |

Discovery and translation limits are separate. Actual text Range rectangles supply geometry; one Range per document is reused instead of retaining a live Range for every node. Completion counters are incremental. Detached restoration records are pruned at pass boundaries rather than on every statistics read. Mutation work is scoped and coalesced; its native execution is tested by the installed-extension workflow.

## Current CPU baseline, excluding inference

Five samples per size; medians from the same run. Environment: Ubuntu, Node 24.22.1, Chromium 156.0.8078.4, four logical CPUs (AMD EPYC 7763), 16,760,344,576 bytes RAM. `provenance.json` records the source commit and SHA-256 of every compiled module tested.

Total includes discovery, planning, identity-response application and continuation. Restore is measured separately.

| Eligible text nodes | First request | Total DOM work | Restore |
| ---: | ---: | ---: | ---: |
| 100 | 13.1 ms | 17.8 ms | 0.4 ms |
| 1,000 | 41.1 ms | 109.9 ms | 1.6 ms |
| 4,000 | 129.9 ms | 446.4 ms | 3.7 ms |

All samples requested each unique input exactly once and used no more than `ceil(nodes / 600)` passes. Coarse regression budgets passed at every size. The budgets are intentionally broader than normal shared-runner variation, not latency guarantees.

More complete discovery and real visibility measurements add first-pass work. The old run's lower first-request timings must not be presented as equivalent work: it missed eligible content and used an older browser. These measurements do not establish a controlled before/after speedup or native model throughput. The present table is the reproducible baseline for subsequent optimization.

## Reproduction and release gate

With Node 24, locked dependencies and Playwright 1.64.1:

```sh
npm ci
npm run build
npm install --no-save --package-lock=false --ignore-scripts playwright@1.64.1
npx playwright install --with-deps chromium
PLANNER_ENFORCE=1 node test/optimization/planner-audit.mjs
node test/optimization/check-budget.mjs
```

`planner-audit.yml` watches every planner dependency and preserves all fifteen case results, performance samples, source provenance and budget checks. Acceptance or budget failure exits nonzero. The release workflow requires this audit in addition to browser regressions, original-model native E2E and type/unit/package checks.

## Superseded alternate-engine experiment

Earlier history contains a llama.cpp bridge experiment. It did not test the installed extension's original inference path and is not evidence of extension correctness or performance. Its workflow and script were removed. Native software-WebGPU and Metal results must be reported independently, with their actual SDK, model, browser and device.

# Translation performance: 0.1.4

## Removed scheduling overhead

The identified 0.1.3 scheduling regressions were outside the locked inference SDK/model:

- A settings change started all open eligible tabs against one serial model. Version 0.1.4 starts active web tabs, or one most-recently-visited web tab when Options is foreground. Never-read background navigations are deferred until activation. OFF and policy invalidation still restore existing scripts in every tab, including after a service-worker restart. Previously activated pages retain their dynamic observers; this is not a promise to cancel all background native computation.
- A known 16-node continuation used the 300 ms mutation debounce. It now yields with a zero-delay task. New external mutations still coalesce. For a static 600-node page, 38 slices no longer require 37 artificial 300 ms waits.
- Unchanged full-page continuations reuse ordered candidates instead of collecting/measuring all remaining nodes again. External DOM and viewport changes invalidate geometry; restoration and every write still check the current source/session.
- Inline fragments go straight to the engine's existing indexed segment contract. They no longer spend a speculative generation on private-use markers that are often omitted. Numbered output is still validated; malformed responses can still require safe per-fragment fallback. Links are never assigned text by proportional length.

Version 0.1.4 retains `@mediapipe/tasks-genai@0.10.30`, the original TranslateGemma `.task`, output validation, Worker isolation and bounded recovery. The native host code is unchanged. These changes do not establish that upstream native stalls, model startup or all possible devices have become faster.

## Deterministic regression checks

The exact production candidate passed Node 24 CI: **447 tests, zero failures/skips**, type checks and both package builds ([run 41291877433](https://github.com/hanana-kick/Autotranslate/actions/runs/41291877433)). New tests require:

- 20 open web tabs: only the foreground tab starts; all other scripts get invalidation/restoration without injection. Activation starts a deferred tab.
- Options foreground: only one most recently visited web tab starts.
- A background navigation does not trigger inference.
- 48 nodes: three 16-node slices, zero-delay continuations, no feedback loop, exact restoration.
- 600 nodes: 38 slices, 600 geometry measurements rather than repeated full-page measurement, exactly 600 unique requests in the deterministic adapter.
- External edits invalidate saved geometry and restore the latest authored text.

These counts are contract tests, not native model timing claims.

## Actual installed-extension comparison

[Native speed regression 41292616366](https://github.com/hanana-kick/Autotranslate/actions/runs/41292616366), initial attempt, source `d34aa25003cc7a4a1f2c952ed7e7d4c8ff3dffbb`. [Raw benchmark artifact](https://github.com/hanana-kick/Autotranslate/actions/runs/41292616366/artifacts/13078011950).

The untouched v0.1.3 release ZIP and actual candidate package ran sequentially on the **same Apple M1 Virtual / 7 GiB macOS runner / Chrome for Testing 156.0.8078.80 / real Apple WebGPU**. Each had a fresh browser profile and installed the same original model file through the shipped file picker. The SDK, model and extension messages were not replaced. Installed file hashes were unchanged; no page JavaScript errors or console warnings were collected.

Three measured repetitions per scenario per version; medians include UI activation, production scheduling, inference and visible DOM application. Model installation/loading is outside these warm-page timings.

| Scenario | v0.1.3 median | v0.1.4 median | Time reduction | Actual generation counts per repetition |
| --- | ---: | ---: | ---: | --- |
| 600 text nodes, four repeated sentences; real inference plus production cache | 27,047.4 ms | 8,349.1 ms | 69.1% | 4 -> 4 |
| Four link-containing sentences / twelve owned text nodes | 20,573.7 ms | 14,695.9 ms | 28.6% | 16 -> 7 |
| Four foreground sentences with eight unread background tabs | 53,319.6 ms | 8,529.7 ms | 84.0% | 28 -> 4 |

All **18 measured cases** completed and restored the exact authored body HTML, element identities, attributes and input state. Every measured recovery delta was zero. Candidate unread background translation count was zero; the baseline had translated 24 background nodes by foreground completion. The inline result still used seven generations, not four: safe numbered-response fallback is not assumed to disappear.

No samples were omitted. Candidate foreground completion times were 18,216.3 / 8,529.7 / 8,273.8 ms; the first slower sample remains in the evidence. These are three same-profile samples per version in sequential order, not a randomized cross-device benchmark or certification of linguistic quality. A 600-node repeated-text workload is not 600 unique model generations.

Candidate ZIP SHA-256: `f1b0ba6edbfd0c9389d64931b89063bc3ffb790101190b0642cd3c064d01ed0e`.
Baseline ZIP SHA-256: `1d3bc155f64c5c8ff59ec708bca78926ecc5aab981a36da6b87c32eb64a69016`.

## Remaining cold-start risk

Separate from the matched benchmark, the first five-profile native QA attempt completed four profiles but profile 2 failed **before any translation**: `onboarding responsiveness: 10000 ms driver deadline` after the full model had been received, during native warmup with zero output. This is retained in [artifact 13077779265](https://github.com/hanana-kick/Autotranslate/actions/runs/41292616366/artifacts/13077779265). Its root cause is not established. An isolated retry uses a new profile and the same unchanged package; its result must be reported separately, never described as five first-attempt successes.

The host/runtime initialization path was not modified in this performance change. Functional completion does not prove that model startup or native-runtime instability has been fixed. Firefox remains unshipped under issue #2.

## Automated release requirements

`test/speed/run-native.mjs` uses the real installed extension and original model. `test/speed/native-benchmark.mjs` observes rendered DOM and uses shipped Options controls; it does not inject production modules or mock translation. `test/speed/compare.mjs` requires both sets of nine samples, exact restoration, zero unread candidate writes and at least 10% median improvement in each targeted workload.

The Release workflow calls the paired native benchmark as well as five-profile original-model static/dynamic/multitab QA, deterministic browser regressions, planner acceptance and reproducible packaging. Failure in any required check blocks publication. A successful contract test or planner-only identity-response benchmark is not substituted for the native speed comparison.

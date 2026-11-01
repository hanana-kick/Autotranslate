# Translation performance: 0.1.4 candidate

## Removed scheduling overhead

The 0.1.3 regression was outside the locked inference SDK/model:

- A settings change started all open eligible tabs against one serial model. The candidate starts active web tabs, or one most-recently-visited web tab when Options is foreground. Never-read background navigations are deferred until activation. OFF and policy invalidation still restore existing scripts in every tab, including after a service-worker restart. Previously activated pages retain their dynamic observers; this is not a promise to cancel all background native computation.
- A known 16-node continuation used the 300 ms mutation debounce. It now yields with a zero-delay task. New external mutations still coalesce. For a static 600-node page, 38 slices no longer require 37 artificial 300 ms waits.
- Unchanged full-page continuations reuse ordered candidates instead of collecting/measuring all remaining nodes again. External DOM and viewport changes invalidate geometry; restoration and every write still check the current source/session.
- Inline fragments go straight to the engine's existing indexed segment contract. They no longer spend a speculative generation on private-use markers that are often omitted. Numbered output is still validated; malformed responses can still require safe per-fragment fallback. Links are never assigned text by proportional length.

Version 0.1.4 retains the original `@mediapipe/tasks-genai@0.10.30`, original TranslateGemma `.task`, output validation, Worker isolation and bounded recovery. It does not establish that upstream native stalls, model startup or all possible devices have become faster.

## Deterministic regression checks

The exact production candidate passed Node 24 CI: 447 tests, zero failures/skips, type checks and both package builds (run 41291877433). New tests require:

- 20 open web tabs: only the foreground tab starts; all other scripts get invalidation/restoration without injection. Activation starts a deferred tab.
- Options foreground: only one most recently visited web tab starts.
- A background navigation does not trigger inference.
- 48 nodes: three 16-node slices, zero-delay continuations, no feedback loop, exact restoration.
- 600 nodes: 38 slices, 600 geometry measurements rather than repeated full-page measurement, exactly 600 unique requests in the deterministic adapter.
- External edits invalidate saved geometry and restore the latest authored text.

These counts are contract tests, not native model timing claims.

## Native acceptance

`test/speed/run-native.mjs` installs the original model through the shipped file picker in the actual extension. `test/speed/native-benchmark.mjs` records three repetitions each of:

1. A 600-node page with four repeated sentences: real initial model calls plus the production cache and content scheduler.
2. Four inline sentences with links: twelve owned text nodes, real model generations and exact restoration.
3. Four foreground sentences with eight unread background tabs: actual UI policy, serial inference contention and background-write counts.

The workflow runs the untouched v0.1.3 release ZIP and candidate on the same Mac/Chrome with the same model file. It records model, browser and package provenance, actual rendered timings, generation/recovery counts and DOM restoration. The candidate must not write translated text in the unread tabs. Each scenario's median must improve by at least 10%; no failed sample is omitted. Three same-profile samples per version, run sequentially, are not a cross-device or linguistic-quality benchmark.

The original five-profile static/dynamic/multitab tests and deterministic browser/planner gates remain separate requirements. Native timing results are not yet certified by this document; inspect the completed Native speed regression workflow before merge/release. Model startup is recorded separately from the warm-page timings. Firefox remains unshipped under issue #2.

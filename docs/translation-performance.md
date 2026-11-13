# Translation performance: 0.1.4

## Removed scheduling overhead

The identified 0.1.3 scheduling regressions were outside the locked inference SDK/model:

- A settings change started all open eligible tabs against one serial model. Version 0.1.4 starts active web tabs, or one most-recently-visited web tab when Options is foreground. Never-read background navigations are deferred until activation. OFF and policy invalidation still restore existing scripts in every tab, including after a service-worker restart. Previously activated pages retain their dynamic observers; this is not a promise to cancel all background native computation.
- A known 16-node continuation used the 300 ms mutation debounce. It now yields with a zero-delay task. New external mutations still coalesce. For a static 600-node page, 38 slices no longer require 37 artificial 300 ms waits.
- Unchanged full-page continuations reuse ordered candidates instead of collecting/measuring all remaining nodes again. External DOM and viewport changes invalidate geometry; restoration and every write still check the current source/session.
- Inline fragments go straight to the engine's existing indexed segment contract. They no longer spend a speculative generation on private-use markers that are often omitted. Numbered output is still validated; malformed responses can still require safe per-fragment fallback. Links are never assigned text by proportional length.

Version 0.1.4 retains `@mediapipe/tasks-genai@0.10.30`, the original TranslateGemma `.task`, output validation, Worker isolation and bounded recovery. The native host code is unchanged. These changes do not establish that upstream native stalls, model startup or all possible devices have become faster.

> **Superseded since 0.1.7.** The MediaPipe/TranslateGemma engine, its Worker and its speed
> harnesses were removed; the shipped on-device engine is now the published PLaMo 3 Translate ONNX
> export run by Transformers.js over WebGPU. The 0.1.4 numbers and the native-SDK statements below
> describe the engine that was current then, not the one in this tree.

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

The host/runtime initialization path was not modified in this performance change. Functional completion does not prove that model startup or native-runtime instability has been fixed. Firefox still ships no archive, so none of these numbers claim it.

## Automated release requirements

`npm run test:onnx` (`test/onnx-live/run-onnx.mjs`) installs the built extension and translates a
real page with the published graph and real WebGPU; it observes the rendered DOM and uses the
shipped Options controls, and injects no production module. It is a correctness gate, not a
matched-speed benchmark: there is no paired native benchmark in this repository any more, because
the runtime it compared against no longer ships.

The Release workflow runs the deterministic browser regressions, the planner acceptance and
reproducible packaging. Failure in any required check blocks publication. A successful contract
test or planner-only identity-response benchmark is not substituted for live on-device evidence.

## Current page-selection change: visual order and first readable result

This change freezes the inference implementation and changes only page planning
and DOM execution. Three separate causes of bottom-first presentation were
removed:

1. The planner explicitly preferred comments over every other content role.
2. It bucketed a whole viewport band by role, then ordered each bucket by DOM
   position. CSS-reordered paragraphs and intervening headings were not kept in
   rendered order.
3. Concurrent requests wrote their answers immediately on completion, letting a
   shorter lower request appear before an unfinished upper request.

The new planner sorts individual text boxes before grouping adjacent compatible
items. Nearby primary reading content precedes supporting UI; distant primary
content does not block visible UI indefinitely. Watch-page primary and secondary
columns supply the semantic distinction missing from YouTube's custom elements.
The executor keeps bounded concurrent inference and a separate ordered commit
chain. A failed upper request releases later commits rather than blocking the
whole page. Long paragraphs keep exact untranslated source suffixes, and partial
results remain incomplete and restorable.

`test/onnx-live/run-onnx.mjs` now supports `VISUAL_ORDER=1`. It records real DOM
applications, source boxes, first-content latency, whole-fixture completion,
partial screenshots and exact restoration using the installed extension and
real model. The fixture has reversed DOM order, CSS reading order, interleaved
headings and an early-DOM sidebar. `EXTENSION_DIR` selects a preserved build;
`VISUAL_ORDER_ASSERT=0` records a known-bad baseline without asserting that its
order is correct. All completion and restore checks still run.

`YOUTUBE=1` records the real watch title, description, recommendations and
comments, then performs a normal scroll to expose lazy comments. Site failures
are reported, not bypassed. A translated description prefix is evidence of first
readable content, **not** a claim that the whole description or page finished.
The primary acceptance metric is useful content appearing in reading order;
smaller requests do not imply higher engine tok/s or faster total-page completion.

### Installed-extension observations

Apple M5, Chrome for Testing 143, PLaMo 0.8B Q4F16, ordinary WebGPU. One sequential
baseline/current pair used the same installed-model profile, warming the host
with the existing four-paragraph page before the visual-order fixture. These
are latency observations, not a sustained throughput benchmark:

| Visual-order fixture metric | Frozen engine with old page policy | New page policy |
| --- | ---: | ---: |
| Title first visible | 456.7 ms | 312.2 ms |
| First body paragraph visible | 2,869.9 ms | 835.4 ms |
| All 12 units complete | 3,278.9 ms | 2,977.1 ms |
| Reading-order violations | 8 | 0 |

The baseline applied `section → title → body-8 … body-1`. The new policy applied
`title → body-1 → body-2 → section → body-3 … body-8`, then the sidebar.
Both runs translated all units and restored the exact source. The current
partial screenshot shows only the title translated while every paragraph and
sidebar remains in its original language.

The separate four-paragraph smoke page took 2 seconds before and 3 seconds after
the change (coarse harness polling), with 2 versus 3 model generations. Smaller
requests can cost more prompts and total time; the visual fixture's speedup
must not be generalized to every page.

Build and tools type-check passed. All 90 targeted Node cases and 17 Chromium
DOM cases passed across the initial run and focused corrections. Coverage
includes LTR/RTL CSS order, interleaved roles, watch-column semantics, reverse
reply completion, progressive paragraph prefixes, restore/source ownership,
and re-ranking an unsent tail while an earlier request is still running.

Reports and screenshots:
`test-results/browser/visual-order-baseline/run/`,
`test-results/browser/visual-order-current/`, and
`test-results/browser/visual-order-dom/`.

The real YouTube watch-page run, with the current rendered recommendation-title
selector, observed these first translated appearances:

| Region | Time from enabling translation |
| --- | ---: |
| Video title | 562.0 ms |
| Description prefix | 1,864.3 ms |
| Recommendation title | 2,823.7 ms |
| Comment | 4,360.9 ms |

The title and description appeared before either supporting region. A normal
500-pixel scroll exposed comments; the initial page had 20 recommendation titles
but no loaded comments. At the observation boundary, one of 20 discovered
comments and one of 20 recommendations had translated: this proves ordering and
incremental delivery, not completion of the whole watch page. Media stayed
paused/muted, with no page errors, count warnings or empty segments.

The earlier run in `visual-order-current/` recorded title, description and
comments but missed recommendation titles because its observation selector
used an obsolete site class. It is not evidence that recommendations were absent.
The corrected run is `test-results/browser/visual-order-youtube/`; consolidated
measurements are in `visual-order-current/summary.json`.

## Inline translation-state presentation

The engine and reading-order policy are unchanged. `src/lib/translationtext.ts`
provides a per-session presentation manager for the installed content script.
Dispatched `Text` nodes become slotted children of `at-translation-text`; queued
nodes are untouched. The inline shadow surface animates a low-opacity cyan/violet
gradient on a 3.4-second cycle. Each committed result has a finite 200 ms opacity
reveal, including progressive paragraph prefixes. Partial failure stops the busy
effect; failure without a committed prefix unwraps the readable source.

The original text node and outer link elements remain the same objects. Exact
wrapper-move mutation records are filtered, not arbitrary mutations under a
component. External edits and late responses from superseded sessions remain
subject to the existing source-ownership checks. Restoration also unwraps
pending nodes with no committed translation. Reduced motion and forced colors
disable animation and decoration. Invalid wrapping containers retain ordinary
translation without visual feedback.

Chromium's extension isolated world does not provide a usable custom-element
registry. There the manager attaches the native shadow surface and slot directly
to the custom-tag host; ordinary page realms register the element class. Neither
path injects code into the page's main world or substitutes a mock component.
This distinction was caught by the installed-extension run after the page-world
DOM tests had passed.

### Focused verification

Chrome build/package and tools TypeScript checks passed. All 76 targeted
DOM/pipeline/content Node tests and 27 Chromium DOM tests passed. The browser
cases exercise in-flight-only decoration, out-of-order responses, finite reveal
progress, multiline geometry, link handlers, original-node identity, partial
failure, cancellation, late sessions, page edits, observer feedback, and both
accessibility preferences.

A separate manual-response preview of the production renderer was inspected
in light and dark themes, then translated and restored without browser errors.
That preview checks appearance, not model inference or latency. The glow was
visible behind the original text without hiding glyphs; restoration removed
all component hosts. Browser regression artifacts are in
`test-results/browser/aurora-dom/`.

The corrected installed-extension run used Chrome 143, Apple WebGPU, and the
local PLaMo 0.8B Q4F16 weights, without a provider seam or artificial model delay.
The pending screenshot captured a readable original heading with an active
animation; completion left five translated components (heading plus four
paragraphs), none busy. At most four components were busy simultaneously.
Disabling translation removed every host and restored the exact original HTML
and the same original text nodes. All four paragraphs completed within the
harness's coarse two-second observation window. This is a functional smoke
result, not a controlled throughput comparison.

Report and pending/translated/restored screenshots:
`test-results/browser/aurora-extension-native/`. The earlier failed report in
`aurora-extension/` predates the isolated-world fix and is not a latency result.
The 27 Chromium DOM cases also passed after that fix, with artifacts in
`aurora-dom-native/`.

Reproduce after building Chrome (use a fresh throwaway profile):

```sh
UNSAFE_WEBGPU=0 HEADED=1 AURORA=1 \
  MODEL_DIR=weight/plamo-3-translate-0.8b-onnx \
  QA_DIR=test-results/browser/aurora-extension-native npm run test:onnx
```

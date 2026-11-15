# Translation performance: 0.1.4

> **Current shipping format: ONNX only.** The extension retains the existing
> PLaMo 3 q4f16 custom WebGPU kernels and ONNX Runtime fallback. GGUF loading,
> tokenizers, shaders and benchmark entry points have been removed. GGUF
> measurements below are historical evidence, not currently supported paths.
> Historical ONNX-only cutover measurements predate the 0.1.13 correction below.

## Report-driven ONNX correction (0.1.13)

Removed synthetic page/role prompts and their retry policy. Source planning now
uses exact tokenizer costs and the model/backend context rather than source64.
The model template receives the requested source language; its BOS is no longer
duplicated during encoding. A non-EOS result is rejected as incomplete.

Inline text and ruby base text share one owner-bounded source even when the
page dispatches one request entry. This reduces repeated prompt/prefill work
without assigning surrounding prose to links. Full clipped text is translated
under its existing CSS clip. Model-approved identity output is settled rather
than retried.

The q4f16 kernels retain fused dispatch and batching while rounding graph
boundaries to FP16. This is not bitwise ORT parity or a standalone kernel speed
claim. Removing duplicate BOS corrected the reproduced `52` → `5` error;
precision-boundary changes alone did not.

Verification details and artifacts: [validation contract](testing.md).
The old per-region hints, numbered inline alignment and source64 descriptions
below are historical, not the current translation contract.

Installed-extension measurement: the same 8-unit Japanese fixture went from
20 model requests with incomplete ruby/clipped text and an echo error to
8 requests and a settled page observed at 0.533 s. This is a 60% request
reduction, not a valid whole-page speed ratio against the failed baseline.
BOOTH and Nenkin first reported completion at 10.058 s and 4.019 s respectively
(1-second sampling). Large pages still miss three seconds. The evidence uses
eight slots and immediate rendering, excludes installation/warmup, and does
not establish a general latency percentile.


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

## YouTube comment sessions (v0.1.10)

Measured the public video `https://www.youtube.com/watch?v=DBjiUz0H9HY` with
the unchanged published Chrome extension, Apple M5, Chrome 143.0.7499.4,
1100×800 viewport and local PLaMo 0.8B Q4F16/WebGPU. Source was automatic,
target Korean. Model installation and the harness's initial warmup are excluded.
The two fresh-profile sessions saw different live comment ordering; they are
not identical repeated samples and must not be averaged.

Times below start at enable, scroll or click and end at an actual change of the
original comment text. Completion is conservative text-change coverage, not a
translation-quality assertion.

| Session / action | First new visible result | Observed coverage |
| --- | ---: | --- |
| Scroll / enable | 5.862 s | 2 of 4 visible comments wholly changed within 20.100 s |
| Scroll / down 900 px | 4.544 s | 2 complete, 1 partial of 7 visible comments within 15.293 s |
| Scroll / up during pending work | 4.472 s | All 7 newly visible comments changed by 9.740 s; 2 others already translated |
| Scroll / return to first comments | No new dispatch | All 4 retained their translations |
| Scroll / open first thread | 7.826 s | All 5 visible replies changed by 14.360 s |
| Reply-focused / open first thread | 2.346 s | All 6 visible replies changed by 8.599 s |
| Reply-focused / show more replies | 5.040 s | All 3 newly visible foreign-language replies changed by 5.605 s |
| Reply-focused / open second thread | 1.983 s | All 4 new foreign-language replies changed by 2.297 s |

The first thread advertises 58 replies; these numbers cover loaded visible
cohorts, not all 58. One newly loaded Korean reply did not change and exhausted
the observation window; that is not a 20-second foreign-text translation
failure. Scrolling back over 7 completed replies produced no new dispatch.
The brief fast-down phase moved away after 1.139 seconds with no result.

### Selection and latency findings

- Visible top-to-bottom ordering worked in the observed cohorts, including a
  Japanese reply discovered after English siblings but rendered above them.
  Previously completed reply bodies were not dispatched again on return.
- The scroll session selected 168 presentation fragments: 117 comment UI,
  43 comment-body and 8 reply-body fragments. Thus 69.6% were non-body UI,
  **not** 69.6% of inference time. Authors, dates and reply controls competed
  with prose. `targets.ts` classifies comment context before button/form
  context; the entire comment thread supplies that context.
- A collapsed 836-character lyric comment was submitted beyond its visible
  prefix. Its fragment waited 16.209 seconds from dispatch to commit; a
  following 15-character comment waited 13.498 seconds. Request timestamps
  and ordered-commit code indicate about 11.33 seconds of head-of-line
  waiting for the short comment. This attribution is an inference from
  correlated events, not a per-fragment GPU trace.
- In the scroll session, replies loaded 0.426 seconds after the click, but
  first visible-reply dispatch occurred at 2.412 seconds and its first
  result at 7.826 seconds. Meanwhile an ordinary comment 4,504 pixels below
  the viewport was dispatched 0.955 seconds after the click. The current
  wave continued before newly visible work took priority; this is not
  evidence that the vertical comparator itself is reversed.
- Already-Korean reply text was submitted and rewritten with a literal
  `outputlangko` prefix in both sessions. The reply-focused session also
  ended with content error `empty translation segment`, although its four
  newly opened foreign-language replies had translated. The trace does not
  establish which input caused that error.

Next changes should separate comment prose from metadata/UI, bound work on
collapsed long comments, reconsider visibility between pending work units,
and skip already-target-language fragments before generation. Engine changes
were deliberately excluded from this measurement task.

### Evidence and limits

Raw reports and screenshots:
`test-results/browser/youtube-comments-DBjiUz0H9HY/` and
`test-results/browser/youtube-comments-DBjiUz0H9HY-replies/`.
The first directory's `summary.json` consolidates both sessions.
The release ZIP SHA-256 was
`74bdae82b1c17c409131a00aad47d3d3efa8635e90239263d4ecced972568c8a`.
Actual translated reply screenshots were visually inspected; disabling
translation left zero component hosts in both sessions.

The observer is read-only. Its measured callback time was 134 ms over 62.458 s
and 216.6 ms over 63.223 s (0.215% and 0.343%); this excludes indirect layout
overhead. After recording, instrumentation was corrected to attribute nested
replies to root threads and not count failed unwrapping as a host commit.
A focused browser smoke passed for both corrections. Reported latencies use
original-text events, unaffected by those corrections; raw host commits and
raw nested thread ordinals should not be used interchangeably with them.
These observations establish neither token throughput nor broad website
compatibility, and the recorded translation error prevents an all-pass claim.

## Comment-priority corrections after v0.1.10

Comment prose and reply bodies retain primary reading-order priority. Authors,
dates and other comment metadata are supporting UI; nested buttons remain form
controls instead of inheriting the entire thread's comment role. The DOM adapter
recognizes comment-body evidence separately from thread ancestry, including
YouTube's nested reply view models. Metadata is no longer primary content.

Scroll invalidation now stops refilling the active request window immediately;
the debounce schedules continuation rather than delaying invalidation. Already
dispatched requests still commit normally. Unsent and partial nodes are returned
to the planner without being recorded as failures or swept work. Multiple
mutation regions, or a mutation with unfinished page work, compete in one visual
plan rather than being translated in mutation-delivery order. A lone insertion
on a completed page retains the smaller subtree scan.

Target-language exclusion runs before presentation and model dispatch. The
current deterministic guard recognizes Hangul-only Korean prose, including short
replies with punctuation, numbers and emoji. It does not infer languages from
shared scripts or skip mixed Korean/foreign prose. Direct engine callers receive
unchanged skipped fragments in their original positions without paying token
counting or generation costs for them.

The native host decodes generated tokens only. The fallback removes the exact
tokenizer-decoded prompt prefix rather than searching for the last occurrence
of source text. This addresses decoded `outputlangko` headers without replacing
ordinary occurrences of that string in user prose. Invalid outputs remain
explicit failures.

Clipped text uses rendered Range geometry and ancestor clipping styles to split
the visible prefix from its hidden continuation. The executor stores source
offsets and committed translations instead of replacing or splitting page-owned
Text nodes. A completed visible prefix yields its unfinished node to the
planner; hidden continuations rank below ordinary pending text. Expanding the
container rechecks clipping and promotes newly visible source. Continuation
does not resend committed prefixes, and restoration keeps the exact original
source and node identity. Language-skipped fragments remain unchanged within
mixed-language partial text rather than being treated as model echoes.

The first installed-extension correction run exposed a root-overflow edge:
YouTube propagates scrolling from a zero-height body to the viewport. Treating
that body as a local clipping box incorrectly classified visible text as hidden.
Clipping now excludes viewport-propagated root/body overflow and boxless
`display:contents` ancestors. The browser regression reproduces a scrolled,
zero-height body with the production shadow presentation, not just an isolated
line-clamped paragraph.

### Corrected-build verification and live results

Chrome build and tooling type checks passed. The 186 targeted Node cases passed.
The 34 browser cases passed across focused runs: the old whole-paragraph retry
expectation was updated to require only the missing suffix, and the final
root-overflow correction was checked with its specific browser regression.
This is not a claim that the full suite was rerun after that final correction.

The corrected working-tree extension was then installed with the real local
model on the same video, M5, Chrome 143 and 1100×800 viewport:

| Action | First visible result | Coverage |
| --- | ---: | --- |
| Enable comments | 2.772 s | First 5 bodies by 2.775 s; clipped sixth prefix by 3.119 s |
| Scroll down | 0.984 s | First newly visible result; the 836-character lyric suffix remained deferred |
| Open first thread | 6.143 s | 4 visible foreign replies by 9.188 s; Korean reply unchanged |
| Show more replies | 2.721 s | 3 newly loaded foreign replies by 3.665 s; Korean reply unchanged |

The first comment-UI dispatch was at 8.024 seconds, after all six initial visible
bodies/prefixes. Both observed Korean replies had zero presentation dispatches
and unchanged source text; no `outputlang` header was observed in comment/reply
output. Upward return over the completed replies produced no new dispatch.
Restoration removed all component hosts. Initial-comment and expanded-reply
screenshots were visually inspected.

The 596- and 836-character clipped comments retained partial components and
original hidden suffixes; these are intentionally not whole-comment completion
results. The live observer therefore sometimes exhausted its whole-text waiting
budget despite a translated visible prefix. Comment ordering changed relative
to the earlier release measurements, so no controlled speedup ratio is claimed.
The second root comment had no public reply expander in this session.

Remaining measured limits: opening replies still waited 4.212 seconds before
dispatch (DOM load: 0.756 seconds), because already executing requests are not
preempted. Intermediate scroll phases reported the model returning unchanged
source text; these errors were not suppressed. Final content/host errors were
null, but this does not certify every fragment or translation quality.

Final raw report, screenshots and compact `summary.json`:
`test-results/browser/youtube-comments-DBjiUz0H9HY-priority-fixes-final/`.
The preceding `youtube-comments-DBjiUz0H9HY-priority-fixes/` directory records
the diagnostic build before the propagated-overflow fix, not final behavior.
No release or push was performed for these corrections.

## Whole-comment one-second latency budget

The interactive target is **whole-comment completion within 1,000 ms of
observed viewport entry**, with no accumulating visible backlog. First-prefix
paint, cached returns and already-Korean text do not satisfy a new translation
deadline. Unfinished exits are censored, not counted as successful translations.
Long collapsed comments retain their hidden suffix and consequently remain
incomplete under this conservative whole-comment metric.

The local-engine comment path now uses one outstanding model request and one
source text per request, with a 64 UTF-16-code-unit source quantum. Boundaries
prefer sentences/words and never split a surrogate pair. This is not an output
token cap: every original source suffix remains resumable and restorable.
Unclipped long text and oversized inline runs use the same bounded mechanism.
Short comments bypass unnecessary sentence splitting.

After every request the pipeline re-collects and re-ranks eligible work.
Viewport changes yield at that boundary and schedule the next task without
waiting for the previous 300 ms scroll debounce. Visible comments keep the
interactive mode active even after their translation completes. Admission is
limited to visible text and primary content within the next screen; distant
work and clipped suffixes stay parked until visibility changes. Unchanged failed
fragments do not retry on each unrelated page mutation, but remain reported
as failures. Source edits or a new translation session make them eligible again.
Unattempted work behind a failed request remains pending rather than failed.

This bounds stale queued work, not inference duration or incoming comment rate.
Already executing GPU work is not preempted. Smaller fragments may increase
prompt overhead and reduce cross-fragment context; translation fluency is not
certified by these scheduling tests. The engine kernels are unchanged.

### Installed-extension evaluation

The current local Chrome build was installed in a fresh profile with the real
673 MiB model on the same YouTube video, M5, Chrome 143, 1100×800 viewport.
The model was warm after the four-paragraph smoke scenario. No release was made.
The scenario included six downward and six upward scrolls at one-second
intervals, five seconds idle, ordinary scrolling, reply expansion, more replies,
and another public reply thread. Initial and expanded-reply screenshots were
visually inspected; restoration left zero presentation hosts.

**The one-second whole-comment target is not met.**

| Measurement | Observed value |
| --- | ---: |
| Translation viewport episodes | 88 |
| Whole-completed episodes | 31 |
| Unfinished exits | 57 |
| Whole-completion p50 / p95 / maximum, completed episodes only | 0.950 / 3.752 / 4.434 s |
| Known deadline misses | 47 / 64 (73.4%) |
| Exits before deadline with unknown outcome | 24 |
| Peak visible unfinished comments | 8 |
| Peak observed waiting age, including collapsed hidden suffixes | 31.847 s |
| Burst-only completed / translation episodes | 10 / 58 |
| Burst-only known misses / known deadlines | 25 / 35 |
| Visible unfinished after burst's 5 s idle | 1 |
| Final visible unfinished comments | 0 |

Episodes are viewport visits, not unique comments. Completed returns (47),
already-complete entries (5), and Korean episodes (5) are separate from the
translation denominator. The 57 unfinished exits include 24 unknown short exits
and 33 known misses. Long collapsed comments remain incomplete by design; this
is not proof of outstanding GPU work, nor may they be silently dropped to claim
the whole-comment SLO. The burst's completed-only p95 was 0.9995 s, but its 48
unfinished episodes make that percentile alone misleading.

The first initial prefix appeared 0.743 s after enabling; the first whole
142-character comment completed 1.596 s after enable confirmation. The next
four short comments completed at 1.942, 2.201, 2.552 and 3.071 s: sequential
service still produces head-of-line delay even when individual requests are
short. First-thread reply presentation dispatch started 0.527 s after the click
(previous corrected session: 4.212 s); its first result arrived at 1.328 s and
the visible foreign cohort completed by 4.837 s. The second public thread's
visible cohort completed by 0.957 s after the click. Live ordering changed, so
these are separate observations, not a controlled speedup ratio.

The final rolling 200-request log contained 55 comment requests, median 328 ms,
maximum 801 ms, totalling 20.771 s. It also contained 99 aside, 40 metadata and
6 form requests, totalling 21.554 s. These are request intervals, not a complete
session accounting: completed comment work permits visible sidebar/UI work.
Reducing that secondary work cannot by itself remove the initial sequence of
whole-comment completions. Queue bounds do not raise model service capacity;
64-character fragments also repeat prompt costs.

The final content status still reported unchanged-source model output; this
error was retained, not hidden or repeatedly retried. Final host error was null.
Observer processing totalled 1.846 s over 90.984 s (about 2.0%), including
mutation, sampling, setup and API calls, excluding protocol serialization.
This run does not certify translation quality or indefinite backlog stability.

Chrome build and tooling types passed. All 101 targeted Node cases and 35
targeted browser cases passed across focused runs; repetitive uppercase fixture
strings were corrected after the output repetition guard rejected them.
A standalone accounting check covered completed, missed, unfinished, censored,
Korean and cached populations.

Raw report and screenshots:
`test-results/browser/youtube-comments-DBjiUz0H9HY-latency/`.
The next capacity decision must distinguish whole-comment tail latency from
prefix responsiveness: small-request scheduling improves interruption points,
but whole-comment p95 and burst deadline misses remain the acceptance criteria.

## Streaming aurora presentation

Generation now publishes real cumulative translation previews before its final
answer. Kernel and runtime workers forward generated-token progress without
additional GPU readbacks; the host decodes only generated IDs and buffers
unfinished Unicode. Worker notifications are bounded to approximately 40 ms.
The document fallback uses Transformers.js `TextStreamer` with the prompt and
special tokens excluded.

Operation-scoped runtime ports carry indexed previews through the same
authorized background and offscreen dispatch paths. Deduplication and batching
map progress back to the original text positions. A reset clears a failed
attempt before a retry. Final validation, completion accounting and caching
still require the final answer; previews do not satisfy the one-second
whole-comment SLO.

The aurora component renders previews inside its shadow root while preserving
the original light-DOM Text node. It coalesces updates on a 40 ms cadence with
animation-frame scheduling. A preview combines the translated prefix with the
estimated unconsumed source suffix. Consumption advances monotonically over
grapheme boundaries using token-like text weights, not a one-character-to-one-
character mapping. It is a display estimate, not linguistic alignment or a
completion claim; canonical write-back still waits for validated output.

Only the changed middle fades in over 160 ms. The stable prefix and original
suffix stay opaque in one inline flow; no whole-source overlay is crossfaded.
The persistent surface carries the aurora independently of token updates.
Partial work pauses that same animation after the 180 ms continuation grace;
resuming it does not recreate the animation. Final output exposes the canonical
Text after its finite reveal.

Restore, failure, source edits and detachment discard previews and pending
repaints. Reduced-motion and forced-colors modes keep text readable without
the visual effects. Shadow text changes do not wake the page's translation
mutation observer. Preview length can still change line wrapping; the paragraph
is not permanently height-frozen.

### Streaming verification results

The earlier streaming implementation passed Chrome build/tooling types, 289
targeted Node cases and 43 browser cases across focused runs. Those archived
results predate the progressive-replacement change below and are not its
verification. They exercised indexed/deduplicated previews, unfinished Unicode,
invalid final output,
retry resets, frame-local ports, exact restoration, external page edits,
clipped suffixes, bounded rendering regions and actual fade progression.
Test fixture corrections used a genuinely foreign-script response to exercise
the existing script-retry policy and retained the empty-answer failure contract.

The installed Chrome extension then ran the real model on M5 with
`STREAMING=1 YOUTUBE_COMMENTS=1 YOUTUBE_COMMENTS_REPLIES_ONLY=1`.
The four-paragraph smoke page completed 4/4 translations in the harness's
two-second sample, on the kernel backend with three generations. All five
text components (title plus paragraphs) displayed actual token previews before
their final commit, while their canonical original Text nodes stayed unchanged.

| Installed smoke measurement | Value |
| --- | ---: |
| Observed busy preview updates | 16 |
| Maximum fading spans in a component | 3 (limit: 5) |
| First title preview after presentation dispatch | 521 ms |
| First paragraph preview after presentation dispatch | 277 ms |
| Preview lead before final commit across five components | 155–646 ms |
| Animation-frame interval p50 / p95 | 8.3 / 9.3 ms |
| Frames over 50 ms / sampled intervals | 4 / 246 |
| Largest sampled frame interval | 200 ms |

This 2.619-second observation included screenshot and automation work. It is
evidence of working previews, not a controlled measurement of incremental
render overhead; the four long frame intervals must not be omitted. The
stream observer itself consumed approximately 0.1 ms, which is not the
component's rendering cost. The real in-progress screenshot and translated
YouTube reply screenshots were visually inspected.

The YouTube reply scenario completed with null final content error and zero
remaining component hosts after restore. Its layout exposed only one initial
comment, so its timings are not directly comparable to the preceding
six-comment session. Whole-comment p50/p95 among 14 completed viewport episodes
were 2.181/4.357 s; 7 other episodes left before a known deadline, and 11 of 14
known deadlines missed one second. Streaming improves the first visible
translation, not the previously unmet whole-comment capacity target.

Raw reports and screenshots:
`test-results/browser/streaming-fade-live/`.
The original streaming feature shipped in v0.1.11. The following stability
changes are newer than that release and its measurements above.

## Viewport and presentation stability

Local page translation now uses the same bounded scheduling policy for news,
articles, forums, card feeds and unmarked div layouts: one request per turn,
up to 64 UTF-16 source units (without splitting surrogate pairs). Semantic HTML,
ARIA landmarks and generic structural markers identify supporting regions;
otherwise unmarked text is treated as content and ordered by rendered position.
No comment/YouTube detection is needed to activate viewport scheduling.

Visible work and next-screen primary content are admitted; far or locally
clipped suffixes remain parked, not completed or discarded. Scrolling changes
future dispatch only: an already active request commits its result even after
leaving the viewport, provided its source still belongs to the same session.
Remaining source resumes from its original offset when read again. Page edits,
detachment and explicit restore still invalidate obsolete output.

Nested scrollers are observed in the capture phase. Measurement intersects
text rectangles with ancestor clipping boxes, including scaled boxes. A
temporary shadow-only measurement scope exposes canonical source geometry
synchronously during a preview, then restores the presentation before paint.
This prevents a hidden source slot from falsely deferring the next quantum.

The 64-unit scheduling quantum trades batching throughput for bounded
interruption points; this change does not establish the whole-comment 1s SLO
or certify every site's custom structure.

Verification: tooling types and the Chrome build passed. All 122 focused Node
cases and 64 distinct browser cases passed across the initial run and targeted
correction runs. The first browser run exposed two accessibility assertions
and a completion-timing assertion: reduced-motion/forced-colors completion now
hands off immediately, and the consent test waits for the finite visual handoff.
The source-crossfade screenshot was visually inspected.

Evidence: `test-results/browser/viewport-stability/`. The installed-extension
scenario used deterministic inference, not the real model. Public sites and
Firefox were not re-exercised for these stability changes.

### Real public-site follow-up

The current Chrome build ran on macOS 27.2 / Chromium 143 with the real
705,701,446-byte q4f16 model on the `kernels` backend, without unsafe WebGPU.
Tested ZIP SHA-256:
`0f83f1cc257633a49bbc856fbb1e60f82c31ced7559d810f52d8ed26d34b5141`.
The fresh signed-out sessions began at 2026-11-13 15:35:55Z and 15:40:27Z.
No production code changed during this evaluation.

| Actual surface | Completed / dispatched Text nodes | First-preview p50 from dispatch | Completed-node p50 / p95 |
| --- | ---: | ---: | ---: |
| Pixiv artwork 151917034 | 47 / 60 | 136 ms | 151 / 359 ms |
| NASA Moon Base news article | 32 / 38 | 127 ms | 221 / 3,542 ms |
| arXiv 1706.03762 HTML control | 28 / 47 | 134 ms | 185 / 13,473 ms |

Each HTML scenario observed about 26 seconds of scrolling down/up, fast
departure and return. The counts are not whole-page coverage. Long-node
completion includes time deliberately parked offscreen; the HTML control's
longest node paused and resumed before finishing at 15.54 seconds.
All 145 tracked source Text nodes restored exactly; no source reversions
before explicit restore were observed. Offscreen commits were recorded for
8 Pixiv, 9 NASA and 10 paper nodes. Maximum simultaneous fade spans was four.

This is **not a clean compatibility pass**:

- Pixiv, NASA and paper HTML all ended with unchanged-output errors. The
  unfinished sets included 12, 5 and 16 unwrapped, unchanged sources respectively:
  URLs, email addresses, counts, identifiers and names such as `SpaceX`.
  These should not all be treated as failed prose translations.
- The paper HTML screenshot `technical-html-down.png` visibly shows doubled,
  overlapping original/translated lines in the abstract. Crossfading a changing
  prefix together with its unchanged source tail causes a real readability
  defect; bounded span counts and successful restoration do not prove good UI.
- The actual PDF viewer loaded `https://arxiv.org/pdf/1706.03762`, but the
  injected outer document reported idle, zero translations and zero requests.
  Its body contained an `application/pdf` embed, not accessible prose Text
  nodes. The HTML control is additional evidence, **not PDF support**.
- Reddit `/r/technology/` returned a “Prove your humanity” CAPTCHA. No account,
  challenge solution or alternate access route was used; translation remains
  unverified for that site in this session.

YouTube used `DBjiUz0H9HY`: initial comments, down/up while work was active,
12 one-second burst scrolls, two reply expanders and loading more replies.
The reply cohorts completed, but ordinary comment cohorts retained incomplete
work. Of 114 translation viewport episodes, 26 completed and 88 were unfinished;
44 exited before a known deadline. Completed-only whole-comment p50/p95 were
1.934/8.099 seconds. The one-second deadline missed in 62 of 70 known episodes
(88.6%). Burst work completed only 6/71 episodes, with 31/37 known deadline
misses; its fast completed-only percentile must not be presented as overall
success. Final content retained an unchanged-output error; restore removed all
presentation hosts. The player remained paused and muted.

Evidence: `test-results/browser/site-matrix-live/` and
`test-results/browser/site-matrix-followup/`. The initial Pixiv attempt failed
in the harness because a ranking link opened another tab; the corrected
observed-href navigation was then exercised successfully. The initial raw
YouTube report inherited a smoke-page warmup note: this matrix actually warmed
the model on preceding real sites. The harness now labels its warmup source.
These are instrumented single sessions, not controlled throughput comparisons
or a semantic translation-quality certification.

### Reading-priority investigation

The public-site evidence above measures the policy before the reading-policy
adjustment below. A direct probe of that earlier `AT.targets.plan` produced:
generic visible author (y=60), visible heading (y=90), right-column opening
(y=100), left-column continuation (y=300), below-fold article (y=1000),
visible sidebar prose (y=100). These are synthetic candidate coordinates,
not a claim about any visitor's gaze.

Causes in that earlier implementation:

- `targets.plan` ranks visible content, near-below content, then visible
  supporting regions. Thus prefetch can outrank something actually visible.
- `unknown` is content, necessary for generic div/card layouts, but it also
  promotes unlabeled bylines, identifiers and counts. `roleOf` alone cannot
  decide whether a string needs translation.
- Sorting individual boxes by y then inline position interleaves columns.
  The candidate contract has no reading-region or column identity.
- `pipeline` admits 64-character, one-text inference quanta. This bounds
  interruption latency, but a whole comment can require several requests.
  Fast first-preview times do not establish the one-second comment goal.
- Scroll invalidates future work without canceling the active request.
  Retaining that invariant is necessary; discarded previews or source
  restoration are not acceptable scheduling strategies.

[NN/g's eyetracking evidence](https://www.nngroup.com/articles/text-scanning-patterns-eyetracking/)
describes heading-led scanning, selective scanning and sustained reading,
depending on task and layout; RTL reverses horizontal preference. It does not
justify a universal YouTube role order or treating viewport coordinates as
measured attention.

Research recommendations (implementation status follows below):

1. Separate eligibility from rank. Exclude confidently non-linguistic whole
   strings (URLs, emails, numeric counters), not arbitrary short words or
   names. Preserve them as source rather than recording successful translation.
2. Use a reading unit (paragraph, comment, card caption) for queue ownership
   and completion metrics, retaining bounded internal inference quanta.
3. Rank explicit selection and focused/expanded content first, then visible
   reading regions, visible supporting text, and only then speculative
   next-screen work. A click must not promote unrelated descendants forever.
4. Infer reading regions from semantic containers plus rendered geometry;
   order within each region in its writing direction. Prefer continuing a
   visible partial unit over starting another equivalent unit; avoid letting
   a long unit monopolize the screen. Neither DOM order alone nor global y/x
   is sufficient for multi-column layouts.
5. Bound prefetch by available service time and viewport stability. Park future
   offscreen work without destroying its display. Do not spend a second model
   call deciding priority before the first visible text can be translated.

Compare baseline versus this candidate on identical pages/scroll traces and
the same model, with warm/cold sessions separated. Include generic div cards,
article sidebars, multi-column/RTL layouts and nested scrollers alongside
YouTube. Report viewport-entry-to-first-preview and whole-unit completion
p50/p95, one-second deadline misses, unfinished/censored units, oldest visible
wait, offscreen dispatch share, and planner main-thread time. Keep translation
quality and exact restoration checks alongside latency: shrinking requests
until the text loses context is not an improvement. CAPTCHA-blocked Reddit
and inaccessible PDF prose remain separate coverage limits.

### Progressive source replacement verification

Implemented source consumption is a script-weighted, grapheme-safe display
estimate. Each request retains at least its last 10% and a readable source
grapheme until validated completion. The frontier does not move backwards on
shorter previews. This is not model-token alignment: temporary mixed-language
boundaries may occur inside words. It adds no inference request.

The 285 focused Node cases and 67 distinct browser cases passed across the
initial runs and targeted corrections. Initial failures exposed obsolete
whole-page scheduling/engine-field assertions, leaking test continuation
timers, and a reveal assertion sampling a pending animation. Tests now advance
bounded work explicitly and isolate timers; the reveal test observes the
changed span after `animation.ready`. The scheduler also publishes failure
counts before propagating a fully refused pass, rather than leaving a zero
count in its debug summary. Chrome/Firefox builds and package validation passed.
Firefox rendering was not exercised; the browser suite did exercise the
Segmenter-unavailable fallback in Chromium.

Real installed Chrome / Chromium 143.0.7499.4 ran NASA news and arXiv
1706.03762 HTML with the real local q4f16 model and without unsafe WebGPU,
starting 2026-11-13 16:02:11Z. This rendering run used ZIP SHA-256
`4403ffbc882aa20c2590bfd9a4232cebcd1abc7307f7a010033a0e580ac32057`;
the subsequent failure-summary correction was verified with the focused
content/pipeline tests and rebuilt packages, not another public-site run.

| Observed surface | Completed / dispatched Text nodes | First-preview p50 | Aurora samples | Animation replacements / missing samples | Exact restores |
| --- | ---: | ---: | ---: | ---: | ---: |
| NASA article | 26 / 32 | 145 ms | 1,386 | 0 / 0 | 32 / 32 |
| arXiv HTML | 26 / 42 | 140 ms | 1,461 | 0 / 0 | 42 / 42 |

Both pages retained unchanged-output model errors; unfinished nodes remain in
the denominators. No pre-restore source reversions were observed and no hosts
remained after restore. The actual arXiv abstract and NASA paragraph screenshots
show a single inline flow with translated prefixes and readable original tails,
without the former overlapping paragraph overlays. Animation identity samples
support continuity during translation/parking, not an all-frame flicker proof.
The deterministic long-paragraph screenshot was inspected as well.

Evidence: `test-results/browser/progressive-source/` and
`test-results/browser/progressive-source-live/viewport-sites.json`. Browser
regressions ran concurrently with the live session: these timings are not a
controlled throughput comparison, a priority-policy improvement, or proof of
the one-second whole-comment target. Pixiv, Reddit, PDF and YouTube were not
rerun for this change.

### Reading-policy adjustment and compact automatic preferences

The scheduler now uses visible main content, visible supporting text, then
near-viewport prefetch. Semantic containers and substantial grid/flex branches
provide reading-region identity; CSS multicolumn text follows document flow.
LTR/RTL inline order is respected. Ambiguous small branches retain geometric
ordering rather than guessing separate columns.

Trusted focus, selection and explicit expansion can promote a visible region
for at most two inference quanta. A visible partial unit has a bounded
continuation preference and yields after two consecutive quanta. Mere DOM
mutation does not earn attention priority. Initial planning and reprioritization
share candidate metadata. The active single-flight request remains intact
when scrolling changes future eligibility; offscreen partial display is parked.

Settings expose model management, target language, URL globs and a source-language
checklist. URL or native browser language matching enrolls active tabs only;
manual OFF lasts until the tab closes and overrides automatic enrollment.
Original detected language and enrollment survive service-worker suspension in
session storage. Settings v3 migrates previous path-prefix rules to glob
equivalents, preserving their reach. Unknown language detection does not enroll.

This implements the ordering/attention portion of the research, not a
service-time-adaptive prefetch controller, gaze model or inference-speed change.
It does not establish a one-second whole-comment completion guarantee.

### Parallel translation feasibility review (before opt-in implementation)

Current page admission, not the native kernel capacity, serializes a reading
window. `pipeline.ts` serializes passes, admits one Text node per viewport wave,
limits work to 64 characters / one text, and gives the DOM executor concurrency
one. `PAGE_PACKS=4` therefore does not mean four simultaneous visible comments.

The native worker already supports independent requests with continuous batching:
`hostworker.ts` passes `kernels.POSITIONS` (8) as the request-slot capacity.
Completed slots are recycled while other requests continue. This is capacity,
not observed occupancy. `ENGINE_BATCH=4` controls the ORT worker fallback's
fixed cohort, not the native kernel slot count. `HOST_POOL_SIZE=1` remains the
actual model-worker count.

The DOM executor's parallel short-pack path has ordered preview/commit gates,
but bounded partial fragments use its serial path. Changing a concurrency
constant or applying `Promise.all` to page groups is insufficient: mutable
role/context/run ownership, fragment continuation and commit order must remain
per-job. Packing two comments into one numbered prompt is also different from
two independent GPU request slots.

Cancellation is another prerequisite. Tab OFF increments authorization revisions
and restores the page immediately; streaming-port disconnection suppresses
responses. Neither currently propagates a per-job cancellation to the host.
The kernel already exposes `drop(id)` for queued removal or termination after
the current GPU step, but the host's observed DROP path is generation timeout.
Parallel admission must connect tab/session cancellation to that primitive,
settle pending host requests/timers, and stop subsequent chunks without stopping
other tabs' shared worker. Scrolling should still finish admitted quanta and
only change future admission.

**Recommendation, not implemented or benchmarked:** retain one model worker;
admit at most two independent visible reading units, one bounded quantum each.
Extend ordered progress/commit ownership to fragments. Release ordering gates
per quantum, not after a whole long comment. Preserve bounded reader-intent
priority, re-rank after each wave, and avoid filling capacity with speculative
offscreen work while visible text waits.

Compare widths 1/2/4 on identical pages and scroll traces with warm/cold runs
separated. Measure first valid preview and whole-comment completion p50/p95,
unfinished units, one-second misses, oldest visible wait, real active GPU rows,
aggregate tok/s versus per-request token latency, and OFF-to-last-GPU-step.
Verify source/link identity, exact restore and late-result isolation alongside
speed. More aggregate throughput may increase the first comment's latency;
existing historical engine batching results do not prove a gain for the current
reading-window workload. No parallelism settings were changed in this review.

### Site-independent selection and decision-model assessment

Eligibility, scheduling and source ownership are separate decisions. Semantic
author/person/profile metadata is stronger evidence for a name than its spelling.
Capitalization and single-word length are not sufficient: “May”, “Apple”, short
replies and CJK prose must remain eligible without explicit metadata. Numeric or
symbol-only strings and recognizable standalone IDs/URLs can be excluded before
inference. Names mentioned inside ordinary sentences remain prose.

Recommendation: keep deterministic semantic/geometry policy on the critical
path. A second generative model adds a dependency before first translation and
may compete for the same GPU; no benefit has been measured. If ambiguous-region
false positives remain material, evaluate a small batched CPU classifier using
DOM/structural features, cached per source/structure revision. It must never
override explicit no-translate/editability rules. Evaluate precision/recall and
latency on held-out domains, CJK/RTL, generic forums, news, technical prose and
virtualized feeds—not YouTube alone. A model cannot repair stale source ownership
or unstable scheduling.

### Notion glossary research — proposal, not an implemented connector

No Notion URL, database ID or authorized connection was supplied or found in
repository references; the user's actual glossary/schema was not inspected.
The [upstream PLaMo template](https://huggingface.co/pfnet/plamo-3-translate-0.8b/raw/main/chat_template.jinja)
accepts `glossary: [{source, target}]`, and `lib/plamo3.ts` can serialize PFML3
glossary pairs. The production tokenizer-template call does not yet supply
them. Existing page-context terms are definitions, not bilingual glossary pairs.

Recommended user-controlled interchange format:

```json
{
  "schemaVersion": 1,
  "version": "2026-11-14.1",
  "entries": [{
    "source": "dashboard",
    "target": "대시보드",
    "sourceLang": "en",
    "targetLang": "ko",
    "caseSensitive": false,
    "wholeWord": true,
    "scope": {"hosts": ["docs.example.com"], "pathPrefixes": ["/product/"]},
    "doNotTranslate": false
  }]
}
```

Provide JSON import/export and UTF-8 CSV with the same entry columns; CSV scope
is a quoted JSON object. Map Notion title/rich-text/select/checkbox columns to
these fields and preview invalid/conflicting rows before activation. Empty scope
is global; wildcard languages require explicit `*`. Local overrides precede
shared entries, narrower scope precedes global scope, and longest term wins.
Reject equal-priority conflicts. Do not execute regex/code from imported data.
Use Unicode-aware word boundaries, not ASCII-only `\\b`.

Match terms locally against the canonical source, language pair and site scope.
Send only matching `{source,target}` pairs, sanitized for reserved PFML markers,
to the model's native glossary parameter. Proposed starting budget: at most
12 pairs and 10% of available input tokens, whichever is smaller; tune against
quality and latency. Count the fully rendered prompt before final packing.
Both plain and contextual generation/retry paths must retain the glossary.

These are preferred terminology hints, not a guarantee. Exact standalone
`doNotTranslate` units can bypass inference; embedded protected spans require
validated preservation or constrained generation. Blind translated-string
replacement is unsafe. Do not claim guaranteed terminology merely because a
pair was included in the prompt.

Integration choices:

| Source | Updates | Credentials / infrastructure |
| --- | --- | --- |
| Local JSON/CSV | User imports a new version | No network credential |
| Published versioned JSON exported from Notion | Conditional fetch of a stable release | No shared Notion token in the extension |
| Private Notion data source | Opt-in polling + Sync now | Read-only connection authorized for that database |
| Notion webhook relay | Change events + periodic reconciliation | Public HTTPS backend; extension is not a webhook endpoint |

The [Notion query API](https://developers.notion.com/reference/query-a-data-source)
uses `POST /v1/data_sources/{id}/query`; retrieve the parent database's data-source
list and select the intended ID explicitly. Its current examples pin
`Notion-Version: 2026-03-11`. Follow opaque pagination cursors until completion,
request only mapped properties, and reject `request_status.type="incomplete"`
(the documented 10,000-result query cap). Read-content capability and sharing
the parent database with the connection are required. Honor
[request limits and Retry-After](https://developers.notion.com/reference/request-limits).

For a backend-free extension, recommend periodic polling (proposed default six
hours) using [extension alarms](https://developer.chrome.com/docs/extensions/reference/api/alarms),
plus a manual refresh. Add the permission, recreate missing alarms on startup,
and make no exact-time guarantee across device sleep. One sync at a time:
fetch into staging, validate all rows/pages, compile indexes, then atomically
activate an immutable local snapshot. Keep the last known-good version offline.
Full refresh reconciles deletions; edited-time polling alone does not. Strict
remote consistency needs immutable published versions and a before/after
publication marker, because paginated reads are not a documented transaction.

Cache identity must include the effective glossary content hash alongside source,
language/model/prompt/context identity. Pin a snapshot to each translation
operation; activation changes new operations, not individual tokens midstream.
Re-translation of displayed text should be an explicit coherent operation.

Never put Notion tokens in URLs, logs, export files, content scripts, prompts or
`storage.sync`. Prefer session credentials; persistent storage needs explicit
consent and trusted-context restrictions, not a “secure vault” claim. Fetch
glossaries in the background without uploading visited page text or URLs.
Distributed OAuth requires a backend-held client secret; a published JSON
release avoids distributing a shared private token. If a backend is desired,
[webhooks](https://developers.notion.com/reference/webhooks) require signature
verification, current-record fetches, duplicate/out-of-order handling and
periodic reconciliation.

### Request cancellation for opt-in admission

Operation ports now carry cancellation by disconnect, not by serializing an
AbortSignal. `AT.sendMessage(message, onProgress?, signal?)` and the fourth
local message-handler argument propagate cancellation through the background,
token counting, translation chunks and host job ownership. Tab OFF, navigation
and relevant policy invalidation cancel matching requests; unrelated tabs keep
their own jobs. Cancelled work does not retry or fall back to another backend.

Native kernel cancellation drops queued jobs or retires an active row after its
already-submitted GPU step, then reuses the slot on the next loop iteration.
The ORT worker fallback has fixed cohorts: an abandoned row can retain its
tensor/cache position until surviving rows finish. The document/inline fallback
releases the caller promptly but keeps its execution queue occupied until the
physical generation promise settles. Shared model initialization is not aborted
merely because one caller cancels. These are cancellation boundaries, not a
claim that already-submitted GPU work can be interrupted mid-kernel.

### Generic eligibility, coherent units and idle prefetch

Foreground reading-window work now admits visible units only. After the visible
queue drains and the viewport stays stable for 500ms, a visible document may
prefetch forward offscreen prose, one bounded 64-character quantum at a time.
Idle discovery is limited by `maxNodes`; this is page-level spare capacity, not
a global GPU-utilization prediction. Scroll, new visible work and document
visibility changes stop future idle admission without discarding active source
ownership. Failures do not keep an idle retry loop alive.

Reading units continue for up to 32 quanta rather than yielding every two.
Viewport changes and explicit reader intent override continuity; exceptionally
long units still yield. Successful fragment results can be reused within the
session cache scope. Standalone nonlinguistic identifiers and semantic author
metadata are excluded without suppressing ordinary prose mentioning names.

The settings checkbox selects width one (default) or two independent visible
units. Each unit advances one bounded fragment at a time; immutable per-request
context and ordered progress/commit gates isolate concurrent results. Idle
prefetch stays width one. Changing admission width does not invalidate the
model/language translation cache or reload the model.

### Source-budget experiment: current 64 characters versus larger token chunks

Evidence: `test-results/browser/chunk-budget-native/chunk-benchmark.json`.
Real installed Chrome extension, Chromium 143, q4f16 native kernels, Korean
target, concurrency one, configured input/output window 1024. Six fixed
English/Japanese sources (19–156 source tokens), four warm rounds per policy,
balanced rotating order. No production policy change was made.

| Source budget | Requests | First preview p50 | Whole-source completion p50 | Completion p95 | Source tok/s | Prefill tok/s | Decode tok/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Current 64 characters | 228 | 89.6ms | 3310.1ms | 5909.4ms | 26.42 | 646.4 | 104.8 |
| 64 tokens | 48 | 127.0ms | 2542.7ms | 5546.2ms | 31.28 | 738.1 | 102.2 |
| 128 tokens | 28 | 148.4ms | 1848.5ms | 5086.1ms | 34.13 | 841.7 | 108.6 |
| 256 tokens | 24 | 172.8ms | 1864.0ms | 4962.6ms | 34.96 | 854.0 | 110.0 |

Each row has 24 whole-source samples. First preview is an engine streaming
callback, not browser paint. Partition planning is excluded; production token
counting, prompt construction, validation and built-in retry policy are included.
Phase rates use differences of host cumulative counters/rates, not the final
shared-session rate. Whole-source valid throughput equals source throughput in
this cohort because no automatic output check rejected any fragment.

128 tokens reduced total timed work by 22.58% (80.09s to 62.00s) and processed
source throughput increased 29.16%. Prefill work fell from 6128 to 2568 tokens
while decode output remained similar (6304 versus 6256 tokens). This supports
reducing repeated per-fragment work, not claiming that larger chunks make the
same decode tokens arbitrarily faster.

The 256-token arm took 60.53s, only 2.37% less time than 128 tokens. Five of the
six sources produce identical requests in those two arms, and repeated outputs
are identical for each source/policy across rounds. Different latency for the
same requests demonstrates run-to-run timing variation; this is not evidence
that 256 is generally better. Only the 156-token technical paragraph distinguishes
the two budgets, so the larger-source experiment below tests both above 256.

Manual output inspection found substantial boundary damage at 64 characters:
the technical paragraph's “does not mean ... latency ... will decrease” lost its
negation, and sentence continuations became isolated fragments. Both larger
arms retained that negation and complete sentence structure. They still made
semantic errors: the long comment's “previous video ... old laptop” became
“이전 레버 노트북”. Automatic validity 24/24 is not semantic quality 24/24.

#### Longer-source check and a hidden truncation failure

Evidence: `test-results/browser/chunk-budget-long-native/chunk-benchmark.json`.
A separate fresh model session used the same configuration and four rotated
rounds on two extended sources: 335 English tokens and 318 Japanese tokens.
These are eight samples per policy, not additional short-source repetitions.

| Source budget | Requests | First preview p50 | Completion p50 | Completion p95 | Source tok/s | Prefill tok/s | Decode tok/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Current 64 characters | 236 | 94.3ms | 9777.6ms | 13971.1ms | 30.38 | 628.4 | 118.0 |
| 64 tokens | 52 | 121.7ms | 8748.8ms | 10296.0ms | 36.62 | 812.1 | 117.6 |
| 128 tokens | 24 | 196.3ms | 8520.1ms | 10960.5ms | 36.34 | 990.0 | 112.4 |
| 256 tokens | 16 | 335.3ms | 9071.9ms | 14613.1ms | 32.88 | 891.7 | 92.6 |

128 tokens cut total timed work by 16.39%; 64 tokens cut it by 17.04%.
That small difference does not establish either as the universal optimum.
256 tokens was slower than both and, critically, returned incomplete content.
Its throughput and completion figures above include the truncated output;
they must not be interpreted as successful full-translation throughput.

All automatic checks reported valid output, but manual inspection found the
first 256-token-budget fragment cut off mid-sentence in both sources:

- English: the 247-token fragment ended its translation at “하지만, 독자가”,
  omitting the scroll/reply condition and the final sentence about active work.
- Japanese: the 242-token fragment ended at “읽을 수 없”, omitting the rest
  of the retention restriction and the sentence about the separate budget.

Outputs were identical across four rounds per source/policy: all eight long
256-budget samples therefore contain this loss, despite automatic validity 8/8.
128-budget outputs retained those clauses, though this is not a comprehensive
semantic-quality certification.

Offline calculation using the installed model's actual tokenizer, chat template
and unchanged production budget helpers is saved in
`chunk-budget-long-native/output-budget-analysis.json`. Actual source counts
matched the benchmark partitions exactly.

| First fragment | Actual prompt tokens | Host output ceiling | Re-encoded returned output tokens |
| --- | ---: | ---: | ---: |
| English, 256 budget | 263 | 675 | 674 |
| Japanese, 256 budget | 258 | 608 | 608 |

The returned lengths and abrupt endings are consistent with output-cap
termination. The benchmark did not receive an explicit finish reason, so that
runtime reason cannot be read back directly. Code inspection found why such
termination can escape validation:

- `local.ts:568–573` reserves prompt space using estimated tokens, although
  input packing used actual tokenizer counts. At a 1024-token window this
  reserves more space than the actual prompt on these examples.
- `onnxhost.ts:792–808` derives an answer ceiling from that estimate and checks
  usable script/runaway output, not semantic completeness.
- `kernels.ts:907–917` marks EOS and token-limit termination done through the
  same result path; the worker result has tokens but no distinguishing finish
  reason. The host's output validator accepts these partial Korean strings.

Recommendation: replace 64-character fragmentation with sentence-aware
64–128-source-token work; 128 is the initial candidate, not a proven global
optimum. Do not raise the default to 256 on this result. Before admitting larger
chunks, unify prompt budgeting around actual token counts, reserve adequate
target-language output space, and propagate EOS-versus-length termination so
truncated output cannot be committed as complete. Increasing the context budget
alone would not repair missing termination semantics.

No production engine or scheduling change was applied during this experiment.
The harness and reproducible commands were added; the identified output-budget
and finish-reason issues remain unfixed. First-token timing is not screen paint,
long-source completion remains well above one second, and this sample does not
establish the requested 1000-prefill-tok/s minimum.

### Hy-MT2 1.8B STQ compatibility assessment

The requested [official GGUF](https://huggingface.co/tencent/Hy-MT2-1.8B-1.25Bit-GGUF)
is not loadable by the current ONNX/Q4 native engine. This is a model/backend
port, not a configuration or model-file substitution. No production port was
implemented for this assessment.

The actual GGUF is v3, architecture `hunyuan-dense`, with 354 tensors and
461,860,800 bytes (440.465 MiB). It contains 224 STQ projections, 129 F32 norm
tensors and one Q6_K tied embedding/output matrix. The 1.25-bit designation
does not describe every tensor: STQ blocks use 42 bytes per 256 weights
(1.3125 bits/weight), while the Q6_K embedding/output occupies about 193.57 MiB.

The model card points to [llama.cpp PR 22836](https://github.com/ggml-org/llama.cpp/pull/22836),
which was open/unmerged at inspection. Its head
`1e411d8f5a1e23525fa3265dfb4bd76265465397` implements STQ CPU kernels, including
ARM NEON; it does not provide STQ Metal or WebGPU matmul support.

**Artifact/runtime format mismatch:** the published GGUF stores STQ tensors as
type 42 and `general.file_type=41`; that PR head assigns type 42 to Q2_0, STQ
to 43, and the STQ file type to 42. Observed projection payload size matches
STQ exactly (2048×512 / 256 × 42 = 172032 bytes). Benchmark setup must use a
verified matching revision or a clearly documented derived artifact, never
silently interpret the official file as Q2_0. Preserve the original hash.

The benchmark resolved this with producer-era PR revision
[`f8b355a9eab32a23df26ae61ff1aacf2bb44ca38`](https://github.com/sjl623/llama.cpp/commit/f8b355a9eab32a23df26ae61ff1aacf2bb44ca38),
whose enum IDs match the official file. It successfully loaded and translated
with the **unchanged** GGUF; no quantization-ID rewriting was performed.

| Area | Existing PLaMo native path | Hy-MT2 requirement |
| --- | --- | --- |
| Loader | PLaMo-specific ONNX node extraction | GGUF metadata/tensors and checked format IDs |
| Projections | Symmetric Q4, block 128 | STQ block-256 GEMV and prefill GEMM |
| Embedding/output | FP16 embedding, separate Q4 head | Q6_K lookup and tied Q6_K output projection |
| Attention | 16 query heads, one KV head | 16 query heads, four KV heads in prefill and decode |
| Normalization | QK norm before RoPE, post-sublayer norms, epsilon 1e-6 | QK norm after RoPE, Hunyuan pre-norm graph, epsilon 1e-5 |
| RoPE | Per-layer ONNX frequencies | GGUF effective base 11158840, scaling none |
| Tokenizer/prompt | PLaMo Unigram/PFML3, token-zero workaround | Hunyuan BPE/pretokenizer and explicit translation instruction |
| EOS | Native defaults [1,16] | Model EOS 120020 |
| Completion | No EOS/length distinction | Explicit termination metadata end to end |

The [HF configuration](https://huggingface.co/tencent/Hy-MT2-1.8B/raw/main/config.json)
specifies theta 10000 and dynamic alpha 1000; the GGUF converter already folds
this into `10000 × 1000^(128/126) ≈ 11158840`. Applying alpha again is wrong.
Its token 0 is `!`, not PLaMo unknown: copying the existing byte-fallback
workaround would corrupt legitimate text. Merely changing fused-QKV dimensions
is also unsafe: current geometry assumes one KV head and would infer 22 query
heads from the Hy fused width instead of the actual 16.

Reusable foundations include WebGPU device/buffer management, scheduling,
residual/SiLU/argmax operations and reduction/tiling structure. Q4 decoding,
KV addressing, norm order, model graph, tokenizer and stopping need deliberate
adaptation. STQ alone is insufficient because embedding and output use Q6_K.

Calculated with current F32 KV storage, Hy needs 128 KiB/token/slot versus
PLaMo 16 KiB: 256 MiB versus 32 MiB per 2048-token slot. Eight such slots
would consume 2 GiB versus 256 MiB before weights and activations. The GGUF
262144-token metadata limit is not a practical allocation promise on this
device. These are geometry calculations, not measured memory or speed.

STQ weights can be losslessly repacked as ternary Q4 codes 7/8/9 with the
original scales, but projection storage grows about 3.14× (FP16 scales) or
3.24× (resident F32 scales). Q6_K conversion is separate, and graph changes
remain necessary. Expanding to existing representations forfeits the intended
low-bit resident-memory/bandwidth advantage. No browser-port speedup is proven.

Local implementation references: `onnxweights.ts:266–347`,
`kernels.ts:104–168,424,566–647,704–733,907–938`,
`kernelattention.ts:22–88,199–575`, `hostworker.ts:97–104,175–248`,
and `onnxhost.ts:142–177,749–757`. Upstream graph semantics:
[Hunyuan graph](https://github.com/ggml-org/llama.cpp/blob/1e411d8f5a1e23525fa3265dfb4bd76265465397/src/models/hunyuan-vl.cpp#L115-L167);
[RoPE conversion](https://github.com/ggml-org/llama.cpp/blob/1e411d8f5a1e23525fa3265dfb4bd76265465397/conversion/hunyuan.py#L261-L285).

### Whole-source pool experiment, without glossary context

Measured on Apple M5 / 24 GiB through the installed extension's native WebGPU
engine (`test/sites-live/pool-benchmark.mjs`). Eight fixed whole sources:
five English (677 source tokens) and three Japanese (505), Korean target,
no glossary/page/role context, concurrency one, physical context 2048.
Two warm rounds reverse policy and language order. Source budgets are soft
only when one whole source exceeds the budget; no source is fragmented.
These are concatenated numbered prompts, **not independent parallel sequences**.

| Pool policy | Requests / eight sources | Mean eight-source time | First-preview p50 | Prefill tok/s | Decode tok/s | Visibly truncated items / 16 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| One source/request | 8 | 36.17 s | 107 ms | 878 | 100 | 0 |
| 256 source tokens | 5 | 37.25 s | 313 ms | 793 | 97 | 0 |
| 512 source tokens | 3 | 35.33 s | 520 ms | 866 | 98 | 2 |
| Entire language pool | 2 | 30.94 s | 850 ms | 702 | 82 | 4 |

First-preview is the nearest-rank p50 across four language-pool runs, not
DOM paint, per-item availability or a large-sample latency guarantee. Phase
rates use differences of cumulative native counters; complete wall time
includes production counting/parsing. The unchanged parser made no fallback
generations in these runs: host request and generation counts matched.
Outputs were identical between rounds for every policy/language.

**The apparent 14.5% full-pool time saving is not a valid throughput win.**
It generated 4742 decode tokens versus 6870 for single-source requests,
because the last source was cut short in each language. English
`extended-technical` stops after its opening two sentences and a replacement
character. Japanese `extended-japanese` stops at `따라서 전자책을 �`,
omitting the remaining budget, evaluation and contact information. The same
Japanese truncation occurs in the 512 policy. All were nevertheless accepted
by the existing automatic validator and numbered-result parser.

The 256 policy preserved the reviewed source clauses but was 3.0% slower
than single requests here; it is not evidence for increasing the default.
The 512 policy's 2.3% apparent saving includes incomplete Japanese output.
Clause review is not a quality certification: for example, single-source
`long-comment` mistranslates the opening old-laptop/previous-video phrase as
`이전 레버 노트북`, while grouped versions improve that phrase.

The separate nominal-8192 diagnostic does **not** allocate an 8192-token
kernel. It permits Japanese to finish (1424 decoded tokens), but English
still stops inside the final source at `텍스트를 덮어서는 안 되는 �`.
English has 702 prefill and 1345 decode steps, reaching the physical
2048-token boundary (the selected final token is not another decode step).
At nominal 2048 the earlier English/Japanese stops are consistent with the
host's estimated prompt/output budget. The runtime does not report an
EOS-versus-length termination reason, so the artifact cannot directly prove
which stop branch fired.

Priorities before enlarging pools: use actual prompt token counts and
language-aware output reserves; align host budget with actual KV capacity;
propagate EOS/length termination; reject or explicitly continue incomplete
mapped items. Small visible items should retain independent completion;
only spare-budget background work is a candidate for larger concatenated
pools. No production batching policy or kernel was changed by this test.

Raw timings, complete outputs, source IDs, observed host calls and nominal
budget diagnostics:
`test-results/browser/pool-budget-native/pool-benchmark.json`.

### Hy-MT2 measured comparison: native CPU versus current WebGPU

Same eight sources (6029 Unicode characters), Korean target, no glossary,
one request at a time, two warm repetitions, 2048 context. This compares
the available **model/backend combinations**, not isolated model quality or
equally optimized GPU kernels. Hy uses four CPU threads, STQ ARM kernels;
PLaMo uses the installed extension's native WebGPU path. Tokenizers differ,
so compare fixed-source wall time as well as each runtime's own token rates.

| Single-source policy | Mean time / eight sources | Source characters/s | Prefill tok/s | Decode tok/s | Mean first stream / individual source |
| --- | ---: | ---: | ---: | ---: | ---: |
| PLaMo 0.8B Q4F16, WebGPU | 36.17 s | 166.67 | 878.05 | 100.29 | 236 ms |
| Hy-MT2 1.8B STQ, native CPU ×4 | 86.93 s | 69.35 | 78.43 | 42.92 | 3298 ms |

All sixteen Hy single-source requests ended with explicit EOS. All repeated
outputs matched exactly. Native CPU Hy was 2.40× slower for this workload;
this does not predict a future STQ WebGPU implementation's speed. Neither
the four-thread setting nor this old compatible runtime was established as
the fastest native configuration.

Quality is mixed, not a demonstrated model replacement win. Hy correctly
renders the old-laptop/previous-video opening that PLaMo mangles, and retains
the reviewed longer-source clauses. But Hy translates `来月` (next month)
as `내년` (next year) in `extended-japanese`, and uses `인페어런트 서버`
for inference server. It also adds “or reduce” to the library's “whether to
increase” decision. These are inspected examples, not a reference-scored
quality benchmark.

Hy whole-language pools averaged 81.65 seconds per eight-source pass at
2048 context, but **zero of four pooled requests were structurally complete**:

- English: 839 prompt + 1208 output tokens, `stop_type=limit`; all five
  labels exist but the final source ends mid-sentence.
- Japanese: 1104 prompt + 769 output tokens, `stop_type=eos`; only labels
  1 and 2 exist. The third article's continuation is merged into item 2,
  so the original three DOM targets cannot be safely mapped. EOS alone
  does not establish completeness.

The native harness uses the official default translation instruction and
Hunyuan chat template, greedy sampling (temperature 0, repeat penalty 1),
not the card's stochastic recommendation (0.7 / top-k 20 / top-p 0.6 /
repeat penalty 1.05). It precomputes template/tokenization outside request
wall time; PLaMo includes production per-request counting/parsing.
No prompt cache, context shifting, parallel requests or competing inference
workload was enabled. Startup is excluded (Hy server ready: 293 ms; PLaMo
reported model load: 1643 ms; these are different startup boundaries).

Official artifact revision: `9df5c824a00a744fb0512a29c640466f4d97dfb0`.
GGUF SHA-256:
`cc497fe8f033b52b3b8b00a7669e9661435432f9d4cd43f7ed24400c01507a93`.
Compatible runtime revision is pinned above. Release build uses
`GGML_METAL=OFF`, `GGML_BLAS=OFF`, `GGML_ACCELERATE=ON`; runtime uses
`-ngl 0 --ctx-size 2048 --parallel 1 --threads 4 --threads-batch 4
--batch-size 512 --ubatch-size 512 --no-cache-prompt --cache-ram 0
--no-context-shift`. Request output cap is
`min(4096, context - actualPromptTokens - 1)`.

Reproducible harness: `test/model-comparison/hymt2-benchmark.mjs`.
Full outputs, stream events, actual tokens, stop reasons, flags and hashes:
`test-results/model-comparison/hymt2/context-2048/benchmark.json`.
The temporary native `/completion` service is benchmark-only, not an
application backend or reintroduced OpenAI-compatible integration.

The genuine **8192-context native diagnostic** fixes the English length cut:
1514 output tokens, EOS, all five mapped items, including the final clauses.
It does not fix Japanese: the 769-token output is byte-identical to 2048,
still merging items 2 and 3. Only two of four pooled requests are structurally
complete. Mean full-corpus time is 80.24 seconds; prefill/decode rates are
83.32/40.11 tok/s. This different-capacity run is diagnostic, not a fair
2048-context speed comparison. Even the completed English pool omits
“better than the diagram” from item 2.

Diagnostic evidence:
`test-results/model-comparison/hymt2/context-8192-pools/benchmark.json`;
semantic review: `test-results/model-comparison/hymt2/quality-review.json`.
The native benchmark commands exit nonzero for the observed completeness
failures, while both temporary servers exited normally. Larger context alone
cannot make numbered concatenation safe: stable per-source mapping and
semantic coverage remain separate requirements.

### Hy-MT2 browser roofline: capacity is not throughput

The extension must run without a native companion. The following is a
**conditional bandwidth bound**, not a Hy WebGPU measurement or a promise.
`test/model-comparison/hymt2-roofline.mjs` reads the checksum-pinned GGUF
tensor metadata and verifies every quantized payload against its offset span.
Apple specifies [153 GB/s of whole-chip unified bandwidth for M5](https://www.apple.com/newsroom/2025/10/apple-unleashes-m5-the-next-big-leap-in-ai-performance-for-apple-silicon/);
that is not measured sustained browser bandwidth or available WebGPU FLOPS.

The real weight payload is 456.771 decimal MB, or 2.0402 effective bits per
parameter across mixed tensor formats. STQ projections occupy 253.231 MB;
the tied Q6_K vocabulary head occupies 202.974 MB, **44.44% of weight traffic**.
The entire vocabulary head is needed for each next-token decision; it cannot
be counted as just a one-row embedding lookup.

Current PLaMo Q4 matrices with F32 block scales total 385.204 MB per streamed
step. Hy matrices total 456.205 MB: **18.43% more**, despite the lower-bit
projection format. Hy also stores eight times as many KV elements per token
at equal precision/context. This corpus produces fewer Hy tokens, reducing
matrix-only traffic over the corpus to roughly 0.89× PLaMo, but that excludes
the larger KV traffic, compute and all scheduling overhead. Token counts and
phase/EOS conventions differ; this is not a measured speed advantage.

Let W be all streamed weights, B the number of independent sequences, L
previous cached tokens, and s the KV bytes/scalar. With perfect cross-sequence
weight sharing and GQA KV reuse, the optimistic per-step bytes are:

```text
W + B × (embedding_row + (L + 1) × 32 layers × 4 KV heads × 256 × s)
aggregate tok/s <= B × 153e9 / step_bytes
```

No full-model on-chip residency is assumed; keeping weights in unified RAM
does not eliminate the reads. Persistent cache reuse can change this traffic
model. Activations, dequantization, softmax/RoPE, dispatch, synchronization,
tokenization, startup and prefill are excluded from the decode bound.

| Independent sequences | F32 KV, L=1024 aggregate ceiling | Hypothetical F16 KV ceiling |
| --- | ---: | ---: |
| 1 | 259 tok/s | 292 tok/s |
| 2 | 422 tok/s | 518 tok/s |
| 4 | 616 tok/s | 844 tok/s |
| 8 | 799 tok/s | 1231 tok/s |

These assume all 153 GB/s is usable. A 50% bandwidth scenario halves the
rates; it is a sensitivity assumption, not a measured efficiency. Compute
may impose a lower ceiling: a decode token requires about 3.58 billion
dense-equivalent projection/head operations plus attention, but STQ lookup
instructions are not ordinary dense FLOPs. Effective WebGPU compute is
unknown; Metal 4/Neural Engine marketing rates cannot substitute for it.

For the measured eight sources, Hy requires 2591 post-prefill decode steps.
A longest-first, rolling four/eight-slot schedule has a **3.64-second
decode-only bandwidth floor** with F32 KV at full peak; at assumed 50%
utilization it is 7.29 seconds. All prompts are unrealistically assumed
prefilled for free here. The longest individual output still needs 752
sequential decode steps, so dividing all token work by eight understates the
tail. This is a schedule-specific thought experiment, not measured latency.
Even ignoring KV and compute, 100 ms allows at most 264 new decode tokens
at B=8 under the streamed-weight model, not this corpus's 2591.

Decision: do not port Hy solely for its bit-width label. First use the current
browser engine's existing shared-weight independent rows. A future Hy port
must optimize both STQ projections **and Q6 head**, then GQA KV reuse and
validated lower-precision KV. Perceived-latency changes come after complete,
correct throughput is measured. Equations, all tensor sizes, F16/F32
sensitivities and unequal-length schedule calculations are retained in
`test-results/model-comparison/hymt2/roofline.json`.

Prefill is a separate compute question. For a 1024-token prompt, the recorded
geometry needs approximately 3.30 trillion dense-equivalent operations
(projections, causal attention and one final vocabulary head), about
3.22 billion per input token. Sustaining 1000 input tok/s would therefore
require roughly 3.22 trillion dense-equivalent operations/s in this workload,
before other overhead. This is a required rate, not a claimed M5/WebGPU
capability. Without measuring the actual STQ/Q6 shader arithmetic, bandwidth
alone cannot establish a numerical prefill maximum.

### Independent WebGPU sequence throughput

Before changing the host, `CONCURRENCY_BENCH=1` exercised the installed
extension with the same eight complete sources and 1/2/4/8 independent
one-source requests in flight. It does not concatenate text, change output
budgets, enable unsafe browser features or create additional GPU sessions.
Two warm rounds reversed width order on Apple M5 / 24 GiB / Chrome 143.

| In-flight sources | Mean eight-source completion | Source characters/s | Throughput relative to one | First-preview p50 per request |
| --- | ---: | ---: | ---: | ---: |
| 1 | 35.630 s | 169.21 | 1.000× | 187 ms |
| 2 | 29.754 s | 202.63 | 1.197× | 205 ms |
| 4 | 27.129 s | 222.24 | 1.313× | 495 ms |
| 8 | 24.678 s | 244.30 | 1.444× | 1321 ms |

All 64 outputs were byte-identical to their width-one source result, with
7778 output characters per width across two rounds. Reviewed final clauses
were retained; no concurrency-induced truncation or cross-source mixing was
observed. Existing model wording errors remain. Unlike numbered pooling's
apparent win, this is a gain with equal complete output.

The kernel already has eight KV slots, continuous refill and width-specialized
GEMV sharing weights. Native host calls are not serialized. The unused link
was multi-text `onnxhost.translateChunk`: it still made one numbered prompt
even when the resident worker supported independent rows. The API-width
experiment bypasses that packing by issuing separate single-source calls.
It proves available engine throughput, not a whole-page UI speedup.

Pure decode rates were 102/122/134/148 tok/s respectively. The public host
counters omit mixed prefill/decode steps; decreasing counted decode tokens
at larger widths does not indicate shorter outputs. Full workload wall time
and equal output text are the primary comparison. Preview latency is a
callback timestamp, not paint, and clearly worsens as width rises.

Current viewport planning separately limits each request to one text/64
source characters and supplies one request by default or two when the
existing concurrency option is enabled (`pipeline.ts`). Therefore making
multi-text host calls faster does not automatically fill eight slots in the
viewport path. UI concurrency, selection policy and source fragmentation
remain unchanged in this engine-stage work; the experiment must not be sold
as a 44% improvement on every website.

After the engine-stage proof, the next integration work is to supply bounded
independent sentence units while preserving source ownership and cancellation,
then measure complete source characters/second with the real page scheduler.
Only afterward should first-readable-sentence/viewport-entry latency drive
admission priority, streaming paint and prefetch/cache tuning. Cache hits and
work moved before visibility must not be counted as higher inference throughput.

Artifacts:
`test-results/browser/concurrency-throughput-baseline/concurrency-benchmark.json`
and `completeness-review.json`. Installed host SHA-256:
`c67eb96a81ad15acca7bc944be60ced5de7c7761cc7c6c8c1569ce0beea66188`.

### Native host cutover and installed-extension acceptance

`onnxhost.translateChunk` now feeds independent source sequences to the
resident WebGPU worker, bounded by its advertised capacity (currently eight).
It refills completed slots instead of waiting for a fixed cohort, preserves
original result/progress indexes, and keeps each source's output budget.
Batch cancellation or failure aborts only that batch's sibling rows and
settles them before returning; unrelated requests retain their ownership.
The serial runtime fallback retains numbered packing. No shader arithmetic,
model weights, UI concurrency setting or viewport policy changed.

After rebuilding Chrome, the same pool experiment was run once with two
reversed-order rounds. English five-source and Japanese three-source pools
still run sequentially, so this differs from the cross-language eight-request
capacity experiment above.

| Current native request grouping | Mean eight-source completion | Source characters/s | Complete output characters / two rounds |
| --- | ---: | ---: | ---: |
| Single sources | 32.814 s | 183.73 | 7778 |
| 256-token outer packs | 30.452 s | 197.98 | 7778 |
| 512-token outer packs | 31.375 s | 192.16 | 7778 |
| Full language pools, independent rows | 25.791 s | 233.76 | 7778 |

Full language pools improved throughput by **27.2%** versus individual
requests in this acceptance run (21.4% less time). This is not an A/B estimate
against the old incomplete numbered-pool output. Absolute timing drift is
material: single-source corpus rounds took 38.744/26.885 seconds, while
full pools took 27.297/24.285 seconds. Two rounds do not establish a general
performance guarantee.

All **72 checked outputs** (64 measured + eight nominal-8192 diagnostics)
were byte-identical to each source's current single-request output. Previously
cut English and Japanese endings are retained. Every policy now performs
eight independent generations per corpus pass, even when only two outer
host requests are made; this is not retry overhead. The physical context
remains 2048 per sequence, so this does not solve an oversized individual
source or add a general EOS/length distinction.

Verification: `npm run build:chrome` succeeded; all 37 focused
`test/onnxhost.test.ts` tests passed, including bounded slot refill,
out-of-order index ownership, batch cancellation/failure isolation and the
serial fallback. The real installed-extension run completed with no automatic
output issues and closed its browser/model server. Raw evidence:
`test-results/browser/pool-independent-native/pool-benchmark.json`.

Next-stage admission should not simply force eight visible requests: the
capacity experiment increased per-request first-preview p50 from 187 ms to
1321 ms. First connect sentence-level work to available engine rows and
measure completed-page throughput; then reserve admission for the next
readable sentence and bound mixed-prefill interference. Streaming paint,
cache reuse and offscreen prefetch should be evaluated separately as
perceived-latency mechanisms, not inference speedups.

### Current PLaMo kernel roofline and GPU attribution

`test/engine-spike/performance-roofline.mjs` consumes the actual parsed weight
inventory and a `PROFILE_DISPATCH=1` run. On the current Apple M5 / 24 GiB,
Chrome 143 exposes ordinary WebGPU subgroups and shader-f16, but not the
experimental subgroup-matrix path. No native companion or unsafe feature flag
is used.

The 65 Q4 matrices contain 725,090,304 weights and occupy **385,204,224 bytes**
including FP32 block scales. The separate 330 MB FP16 embedding is CPU-resident;
only the selected embedding row is looked up per sequence/step, not the full
table. FP32 KV costs 16 KiB per cached token per sequence.

For batch width \(B\), previous context \(L\), streamed weight bytes \(W\),
and bandwidth \(D\), the ideal shared-weight/GQA memory bound is
\(TPS \le B D / [W + B(E + 16384(L+2))]\).
The two extra KV rows account for reading the new row and writing it.
Compute also bounds throughput:
\(TPS \le B F / [B(2P + 4\ell h d(L+1))]\).
Here \(F\) must be effective compute for this kernel, not advertised neural
TOPS; Q4 unpacking, normalization and softmax add work beyond these dense
equivalent operations. Dispatch, activation traffic and readback reduce both
bounds further.

| Previous context | Batch | Ideal 153 GB/s aggregate tok/s | Streaming-probe median scenario tok/s |
| --- | ---: | ---: | ---: |
| 128 | 1 | 394.6 | 195.6 |
| 128 | 8 | 3039.6 | 1506.9 |
| 1024 | 1 | 380.2 | 188.5 |
| 1024 | 8 | 2353.3 | 1166.7 |

153 GB/s is Apple's shared whole-chip specification, not a browser bandwidth
allocation. The browser's 256 MiB read-and-sum probe measured 65–128 GB/s,
median 75.85 GB/s; this is a workload-specific sensitivity scenario, **not a
hardware ceiling**. The formulas assume weights stream once per step and KV
is reused across all query heads. The current attention shader logically
reads KV for each of 16 query heads; caching determines how much reaches DRAM.
At 1024/B8, treating all those reads as DRAM lowers the peak-bandwidth scenario
from 2353 to 483 aggregate tok/s. Neither extreme is a measured prediction.

The instrumented baseline attributes about 64–93% of decode GPU span to
matrix multiplication, depending on context/batch; attention reaches 22% at
1024/B8. Argmax is a smaller contributor. Per-pass timestamps are quantized
in observed 65.536 microsecond steps, so attribution aggregates many passes.
Instrumentation adds overhead: use non-instrumented, interleaved equal-token
runs for acceptance, not these profiling rates.

Engineering targets for this iteration are single-sequence 150 tok/s at
128 context / 120 at 1024, and B8 aggregate 400 / 300 respectively. These imply
6.67/8.33 ms single-step and 20/26.67 ms batch-step budgets; they are targets,
not guaranteed outcomes. The ideal memory requirements are 58.2/48.3 GB/s
single and 20.1/19.5 GB/s batched. Batch arithmetic still scales with its live
rows: 400 aggregate tok/s needs at least 0.587 effective dense-equivalent
TFLOP/s before unpacking and other costs. A 1000 tok/s prefill target requires
roughly 1.13–1.19 effective dense-equivalent TFLOP/s for 128–1024-token prompts.
The autoregressive dependency and longest output chain remain; these bounds
do not support millisecond completion of arbitrary whole pages.

Evidence: `test-results/browser/tps-profile-baseline/` and
`test-results/browser/tps-roofline.json`. Hardware specification:
https://www.apple.com/newsroom/2025/10/apple-unleashes-m5-the-next-big-leap-in-ai-performance-for-apple-silicon/

#### Selected decode changes

The 64-thread GEMV assigns two output rows to each sixteen-lane team.
Aligned `vec4<f32>` activation loads are reused for both outputs, while the
Q4 unpacking, per-output dot order and final sixteen-lane sum stay unchanged.
Live-width specialization still avoids allocating unused row accumulators.
This is portable FP32 arithmetic, not lower precision or an experimental API.

Greedy selection now scans 4096-token chunks in parallel, then merges each
original lane's chunk winners before the existing reduction. Strict-greater
comparisons preserve original tie order (which is not simply lowest global
token ID), sentinel and NaN handling. Scratch is 27 KiB per sequence for this
vocabulary, allocated once with the runner; the extra reduction costs one
dispatch. Full vocabulary logits remain available.

Selection compared baseline, chunked argmax alone, paired GEMV plus argmax,
subgroup attention and compact attention on identical 64-output-token runs,
three interleaved rounds, 128/1024 prompts and batch widths 1/8. All 120
variant comparisons matched token-for-token. Paired GEMV plus argmax was
selected; neither attention alternative justified replacing the portable
baseline. Prefill GEMM, KV precision, model weights, output limits and viewport
admission policy remain unchanged.

#### Integrated acceptance

Final A/B used the immutable baseline and integrated production source, three
interleaved rounds, 96 generated tokens per sequence, EOS disabled, ordinary
Chrome WebGPU and no timestamp instrumentation. Rates aggregate counted
tokens over counted phase wall time, not averages of individual rates.

| Prompt tokens | Live sequences | Baseline decode tok/s | New decode tok/s | Gain |
| ---: | ---: | ---: | ---: | ---: |
| 128 | 1 | 177.4 | 185.6 | 4.6% |
| 128 | 2 | 249.5 | 355.8 | 42.6% |
| 128 | 4 | 273.9 | 520.6 | 90.1% |
| 128 | 8 | 271.9 | 592.9 | 118.1% |
| 1024 | 1 | 148.3 | 158.2 | 6.6% |
| 1024 | 2 | 202.7 | 292.5 | 44.3% |
| 1024 | 4 | 229.5 | 404.7 | 76.3% |
| 1024 | 8 | 214.6 | 385.3 | 79.5% |

Batch rates are aggregate, not per-sequence. All four iteration targets
(150/120 single, 400/300 B8) were exceeded. Single decode remains far below
the conditional 380–395 tok/s peak-memory roof; this is a modest single-row
gain, not a twofold single-request acceleration. Prefill stayed essentially
unchanged, 1181–1711 tok/s across these conditions. B4 beats B8 on long-context
decode, so maximum slot count is not universally maximum throughput.

All 24 final A/B comparisons matched (17,280 generated tokens across both
variants). Additional 1/129/2044-token prompt cases compared all 107,520 final
logits with **zero difference**, including completion at the 2048-token
physical boundary. Eleven unequal requests at widths 3/8 exercised mixed
prefill/decode, retirement and refill; all eight baseline/current and
batched/individual comparisons matched. No GPU validation or cleanup errors.

`npm run build:chrome` succeeded. The rebuilt extension was installed in a
fresh ordinary Chrome session, loaded the real model and translated the fixed
eight whole English/Japanese sources in two reversed-order rounds:

| Independent request width | Eight-source completion | Pure decode tok/s | Preview p50 |
| ---: | ---: | ---: | ---: |
| 1 | 21.852 s | 168.4 | 143 ms |
| 2 | 13.314 s | 283.6 | 137 ms |
| 4 | 11.030 s | 344.3 | 249 ms |
| 8 | 10.397 s | 366.4 | 848 ms |

All 64 translations matched both the new single-request result and the
historical baseline byte-for-byte; no missing-output gain. Each width produced
7778 output characters across two rounds. Width eight improved whole-corpus
throughput 2.10x versus width one **within this rebuilt-extension experiment**.
Historical absolute timings were not interleaved with this run, so do not
attribute their entire difference to the shader change. Pure-phase counters
omit mixed steps; full corpus completion is the end-to-end acceptance metric.
Preview callbacks are not paint measurements.

The default viewport still admits one request, or two with the existing
option; widths 4/8 above measure engine capacity, not new UI behavior.
Increasing width trades individual completion/preview latency for throughput.
This work does not claim instantaneous whole-page translation.

Evidence: `test-results/browser/tps-acceptance.json` links the complete final,
logit, heterogeneous and installed-extension reports. Installed kernel SHA-256:
`45be5f215c24a45716dff829cee94859c94c3e221e4bcd93ad65b0995e1e7806`.

### Further single/batch decode optimization

This iteration uses the preceding paired-GEMV/parallel-argmax implementation
as its immutable baseline (`test-results/browser/tps2-baseline/`), not the
older scalar-activation implementation. Additional warm decode targets at
128/1024-token prompts are **200/180 tok/s single** and **800/500 aggregate
tok/s at width eight**. Step budgets are 5/5.56 ms and 10/16 ms respectively.
The current-model roofline calculator now records these higher targets;
the previous JSON report retains the previous iteration's targets.

Fresh per-pass GPU attribution on that baseline:

| Initial context | Width | Matrix share | Attention share | Norm share |
| ---: | ---: | ---: | ---: | ---: |
| 128 | 1 | 76.8% | 4.8% | 10.3% |
| 128 | 8 | 85.6% | 6.0% | 5.1% |
| 1024 | 1 | 65.1% | 19.2% | 8.9% |
| 1024 | 8 | 55.3% | 40.4% | 2.7% |

Argmax is now below 0.3% of GPU span; optimizing it again cannot close the
remaining gap. At 1024/B8 attention alone takes 7.34 ms, versus 1.21 ms at
B1. Matrix activation reuse/occupancy, long-context attention parallelism
and normalization dispatches are the measured next targets. This attribution
is intrusive and timer-quantized, not the performance acceptance run.

Combining all layer dispatches into one compute pass preserved output but
only improved single decode about 3%, with long B8 decode and prefill
regressions. It is not selected as a universal dispatch change. WebGPU
permits dispatch-to-dispatch synchronization within a compute pass:
https://github.com/gpuweb/gpuweb/blob/main/spec/index.bs

Evidence: `test-results/browser/tps2-profile/`, `tps2-dispatch-check/` and
`tps2-roofline.json`. The new streaming-read median was 102.4 GB/s; its change
from the prior calibration is another reason not to treat one probe's median
as a universal hardware maximum.

#### Selected architecture and memory tradeoff

Decode Q4 is prepared once on the GPU: each aligned `vec4<u32>` contains
corresponding packed words from four adjacent output rows. One sixteen-lane
team reuses each activation vector for those four outputs. Each sequence
accumulates a `vec4<f32>` across output rows using nibble-ordered FMAs, instead
of four scalar dot accumulators across K. Weight precision remains unchanged;
FP32 accumulation order changes, so full-logit and generated-output checks are
required. The final sequential sixteen-lane sum is unchanged.
Width-specialized pipelines are selected for exactly the active/head row
count, so their redundant uniform row guards have been removed.

Layer matrices retain row-major Q4 for prefill GEMM and a packed decode copy.
Scales are shared. The head always uses GEMV, so its original GPU Q4 buffer is
destroyed after preparation; no extra CPU weight copy is created.
For this exact model, persistent extra layer Q4 payload is **267 MiB**.
Initialization transiently adds another **78.75 MiB** for the original head;
packing uniforms are also released. These are buffer payloads, not measured
process RSS or a total driver-memory claim. GPU preparation adds one
initialization submission and no per-token packing work.

Beyond 512 visible tokens, attention uses 256-token partitions with
128-thread workgroups and a stable FP32 merge. Workgroups are ordered by
partition, then query head, so neighboring heads access the same KV interval.
Short-only steps retain the original decode; tiled prefill is unchanged.
Short peers in a mixed-length decode cohort also use partitions. Empty partitions
explicitly overwrite their statistics and values, preventing stale state
after mixed-length scheduling or slot reuse. The merge rescales each partial
by `exp(partialMax - globalMax)` before summing its numerator/denominator.
Shared per-run scratch is 4.125 MiB at the default 64 activation rows;
it is reused across layers and freed with the runner.

The first head-major partition experiment helped single decode but regressed
batch decode. Partition-major ordering was essential in the measured batch
improvement. Larger GEMV tiles alone, head-only packing, blanket compute-pass
coalescing and Q/K preparation fusion were not selected. The final production
path removes experimental selection flags and the obsolete row-major GEMV;
it does not add a native backend, unsafe browser feature, precision reduction
or shortened output budget.

Additional batch experiments rejected after ordinary-browser A/B runs:
8×32/8×64 shared-memory GEMM, subgroup reductions, two-/four-sequence row
tiling, shared-partial padding and uniform-upload caching. None beat the
selected packed GEMV reliably. Vector-output accumulation did: in its
two-round screening B8 decode rose from 805.3 to 884.1 tok/s at context 128
and 566.9 to 597.1 at context 1024, with identical generated tokens.
This screening compares against packed scalar-dot GEMV, not the iteration's
immutable paired-GEMV baseline; final acceptance is reported separately.

The subsequent 48-run grid exposed a short-B8 target miss (791.4 tok/s),
despite faster isolated screenings. It was not counted as an 800-tok/s pass.
Post-normalization, residual addition and the following pre-normalization
are now fused into one workgroup per activation row. Both original RMS
reduction trees and residual outputs are retained; a barrier prevents the
second reduction from overwriting statistics still being consumed by peers.
The next layer consumes the preceding MLP output directly, and the final
chain uses the final normalization weights. This removes **64 dispatches
per full-model step**, the standalone add kernel and the post-norm scratch.
The one-layer diagnostic retains its own final chain.

In two-round screening against vector GEMV without this fusion, short single
decode improved 220.8→229.4 tok/s and short B8 885.7→907.7; long single
196.5→205.4, while long B8 was essentially unchanged (599.6→598.5).
All generated IDs matched. Scale repacking, larger workgroups, explicit
component unrolling and shortened activation lifetimes did not justify
additional memory or complexity and were not integrated.

#### Numerical boundary verification

`test/engine-spike/run-attention.mjs` compares the production split-context
attention against independent CPU softmax on real WebGPU. Eleven cases cover
partition boundaries, causal/window limits, permuted cache rows, invalid/empty
rows, reused scratch and large query magnitudes. All 12,672 values passed;
maximum absolute error was 2.47e-8. Evidence:
`test-results/browser/tps2-attention-final/attention-regression.json`.

Full-model checks additionally compare complete generated token sequences
for unequal prompt lengths, refill and changing live widths. A full-vocabulary
logit comparison is necessary for the vector-FMA accumulation change; matching
greedy tokens alone does not establish numerical equivalence.

#### Final ordinary-browser kernel acceptance

Apple M5 / 24 GiB, Chrome 143, ordinary WebGPU (`UNSAFE_WEBGPU=0`), unchanged
PLaMo Q4 model. Three interleaved rounds per case, 96 generated tokens per
sequence, 48 runs. Rates include decode submission/wait/readback, exclude
initialization/warmup, and are total output tokens divided by total phase
wall time—not the best run. Batch rates are aggregate across live sequences.

| Initial context | Width | Baseline decode tok/s | Current decode tok/s | Gain | Current prefill tok/s |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 128 | 1 | 185.3 | 229.1 | 23.7% | 1635.4 |
| 128 | 2 | 353.9 | 429.0 | 21.2% | 1550.6 |
| 128 | 4 | 512.4 | 656.6 | 28.1% | 1489.8 |
| 128 | 8 | 587.4 | 809.6 | 37.8% | 1476.0 |
| 1024 | 1 | 157.6 | 201.7 | 28.0% | 1223.5 |
| 1024 | 2 | 290.2 | 348.3 | 20.0% | 1214.1 |
| 1024 | 4 | 399.9 | 483.4 | 20.9% | 1193.8 |
| 1024 | 8 | 384.4 | 562.5 | 46.3% | 1164.5 |

All four additional decode targets (200/180 single, 800/500 B8) passed this
protocol. Short B8 has only 1.2% margin above its target; these measurements
are not a minimum-rate guarantee under arbitrary system load or temperature.
All 17,280 generated tokens matched across baseline/current comparisons.
Mixed-length/refill checks at widths 3/8 also matched batched and individual
scheduling: 2,176 generated tokens across eight runs.

Five full-vocabulary checks (107,520 logits each, prompts 1/257/513/1025/2044)
passed the existing numerical thresholds. Worst relative L2 was 2.774e-4,
maximum absolute error 0.009895, minimum cosine 0.9999999645. Logits are not
bit-identical: vector FMAs and fused normalization change FP32 rounding, even
though generated IDs matched these cases. No weight/KV precision was reduced.

Evidence: `test-results/browser/tps2-accept-throughput/`,
`tps2-accept-logits/`, `tps2-accept-heterogeneous/`.

The final intrusive GPU profile still attributes 83.1% of short-B8 span to
matmul. At long B8, matmul is 61.9% and attention (including merge) 33.0%.
Mean spans were 4.255/8.105 ms at context 128 (B1/B8) and 4.832/12.255 ms
at context 1024. Dispatch counts are now 196 for short decode and 212 for
partitioned decode. Quantized timestamp attribution is diagnostic, not the
throughput acceptance timing. Evidence: `tps2-accept-profile/`.

#### Installed extension acceptance

`npm run build:chrome` succeeded. A fresh, visible Chrome instance installed
the rebuilt extension and real model, then ran the existing independent-source
concurrency benchmark through the extension engine and host worker. Eight
whole English/Japanese sources, widths 1/2/4/8, two reversed-order rounds;
no glossary, cache substitution or shortened output budget. The installed
kernel hash matched `build/chrome/lib/kernels.js`.

| Width | Previous corpus seconds | Current corpus seconds | Previous decode tok/s | Current decode tok/s | Current preview p50 ms |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 21.852 | 17.880 | 168.4 | 209.1 | 152.4 |
| 2 | 13.314 | 10.806 | 283.6 | 357.3 | 146.0 |
| 4 | 11.030 | 8.866 | 344.3 | 441.3 | 251.3 |
| 8 | 10.397 | 8.373 | 366.4 | 470.1 | 829.5 |

The previous column comes from `tps-extension/concurrency-benchmark.json`;
this installed-extension comparison is historical, not interleaved A/B.
Current pure-prefill rates were 1111–1415 tok/s. Host phase counters exclude
mixed steps; whole-corpus wall time includes them. Unequal lengths, growing
contexts and draining cohorts explain why real-corpus decode differs from
the fixed-width kernel benchmark.

All **64 complete translations** were byte-identical both to the corresponding
historical output and the current width-one reference; zero invalid items.
No source was truncated. Width-eight throughput does not make each individual
request fastest: preview p50 remained 829.5 ms versus 152.4 ms at width one.
This is installed-extension engine/worker verification, not a new live-site
scrolling or paint-latency test. The production/UI default remains one request,
with its existing two-request option; widths four/eight are capacity experiments.

Evidence: `test-results/browser/tps2-extension/concurrency-benchmark.json`,
`tps2-extension/sites-options.png`, and `tps2-acceptance.json`.

### Raised decode targets: dispatch waste and KV reuse

The preceding accepted production implementation is preserved as
`test-results/browser/tps3-baseline/`. This iteration raises warm targets at
128/1024-token prompts to **240/210 tok/s single** and **850/600 aggregate
tok/s at width eight**. Required step budgets are 4.167/4.762 ms and
9.412/13.333 ms respectively. Model, output budgets, F32 decode/KV precision,
ordinary WebGPU and the interleaved acceptance protocol remain unchanged.

The roofline calculator records these targets in `tps3-roofline.json`.
Ideal required bandwidth is 93.1/84.5 GB/s for single and 42.8/39.0 GB/s for
B8; required effective dense compute is 0.352/0.333 and 1.247/0.951 TFLOP/s.
These are necessary workload rates, not promised hardware performance.
The preceding streaming probe's 71.9 GB/s median is not a ceiling: actual
decode already exceeds that probe-based model, which omits cache behavior.

The vocabulary projection needs 13,440 eight-output workgroups, but the
previous 4096×4 rectangle dispatched 16,384. Fully padded groups clamped their
reads and performed the matrix work before discarding stores. Balanced
3360×4 dispatch removes those 2,944 redundant groups. WGSL now flattens
`workgroup_id` using `num_workgroups.x`; any wholly padded final tile exits
uniformly before barriers. Per-output arithmetic and weight layout are unchanged.
The new real-GPU packed-GEMV regression covers output tails and both sides
of the 4096-group dispatch boundary against independent CPU results.

Paired-head long attention reuses each K/V vector for two query heads inside
one 128-thread workgroup. The launch grid is
`ceil(heads / DECODE_HEADS_PER_GROUP) * parts` by active rows. It preserves
per-head accumulation order, the partial-buffer format and stable merge.
Per-workgroup shared memory increases from 3,600 to 7,184 bytes; persistent
scratch/KV allocation is unchanged. Odd heads and empty partitions remain
explicitly guarded.

In two-round screening, long B8 improved 597.7→678.4 tok/s while long single
was essentially unchanged (203.1→203.4). All generated tokens matched.
The paired shader also passed the existing 12,672-value CPU-reference test,
including odd head count, window/tail limits and reused scratch.
Larger 32-/64-lane GEMV teams increased batch cost rather than reducing it;
both were rejected. Evidence: `tps3-reuse-check/`, `tps3-team-check/`,
`tps3-attention-reference/`, `tps3-matrix-boundary/`.

#### Selected single-request path

- Single-row GEMV accumulates unscaled Q4 contributions within each
  quantization block before applying its scale. Wider batches retain scaled
  weight reuse. This reduces single-row scale multiplications; FP32 association
  changes, so full-logit and complete-output comparisons remain required.
- Q/K RMSNorm is fused with RoPE; K additionally writes its cache and copies V.
  Shared FP32 normalized values preserve the original reduction tree and
  rotation expressions. This removes 32 dispatches and the `qN`/`kN` buffers
  (544 KiB at 64 activation rows), with at most seven storage bindings.
- One-row steps share a compute pass. Multi-row steps retain separate passes.
  A contiguous prefix of requested head rows reads `n1` directly; non-prefix
  rows retain the gather copy, with the shared pass closed before copying.
- A per-runner 256-KiB binary16→Float32 lookup replaces repeated exponent
  calculations in CPU embedding conversion. Entries use the original converter,
  preserving its values. GPU embedding expansion performed similarly but was
  rejected in favor of this smaller implementation with no new GPU buffer.

The selected lookup path's three-round single-request screening measured
240.8/219.8 tok/s at prompts 128/1024 with 128 generated tokens. Its GPU
embedding alternative measured 240.3/219.7. These are screening figures, not
the final 96-token interleaved acceptance grid. Independent dual-accumulator
chains regressed short single decode and were rejected.

The profiler marks multi-family shared passes `combined`; their entire GPU
duration must not be attributed to the final argmax pipeline. Batched steps
still expose per-family timestamps. Q RMSNorm+RoPE has its own diagnostic
family, while fused K preparation remains in `rope-kv`.

#### Final raised-target acceptance

Apple M5, 24 GiB; Chrome 143, ordinary WebGPU; unchanged 705,701,446-byte
Plamo 0.8B Q4F16 model and FP32 decode/KV. The final grid interleaves the
preserved baseline and current production over three rounds, widths 1/2/4/8,
128/1024-token prompts and 96 generated tokens per sequence: 48 runs.
Rates are total phase tokens divided by total phase wall time, not best runs.
Initialization and warmup are excluded.

| Prompt tokens | Width | Baseline decode tok/s | Current decode tok/s | Gain | Target | Current prefill tok/s |
| --- | --- | --- | --- | --- | --- | --- |
| 128 | 1 | 227.8 | 240.8 | 5.7% | 240 | 1739 |
| 128 | 2 | 442.4 | 456.5 | 3.2% | — | 1680 |
| 128 | 4 | 693.4 | 733.6 | 5.8% | — | 1643 |
| 128 | 8 | 847.8 | 885.1 | 4.4% | 850 | 1599 |
| 1024 | 1 | 208.3 | 217.7 | 4.5% | 210 | 1316 |
| 1024 | 2 | 359.2 | 395.4 | 10.1% | — | 1294 |
| 1024 | 4 | 499.5 | 578.9 | 15.9% | — | 1272 |
| 1024 | 8 | 583.4 | 688.9 | 18.1% | 600 | 1231 |

All four raised targets pass this protocol. Widths above one report aggregate
throughput, not per-request speed. Short single decode clears its target by
only 0.34%; this is not a minimum-throughput guarantee under arbitrary load.

Correctness checks on the final production source:

- Packed GEMV: 991,277 independently computed CPU-reference values, exact for
  the sparse dyadic fixtures; output canaries intact.
- Attention: 11 cases / 12,672 values; maximum absolute error 2.468e-8.
- Five full 107,520-logit vectors at prompt lengths 1/257/513/1025/2044:
  minimum cosine 0.9999999029, maximum relative L2 4.408e-4 and maximum
  absolute difference 0.009795. FP32 reassociation is not bit-identical.
- All 17,280 generated IDs in the throughput grid match baseline.
- Unequal-length/refill checks at widths 3/8, batched versus individual:
  all comparisons match across 2,176 generated IDs.

The final timestamp diagnostic samples 15 decode steps per condition.
Single-row shared-pass GPU spans average 3.827/4.290 ms at contexts 128/1024,
with 164/180 dispatches; these combined passes cannot identify individual
kernel costs. B8 spans average 9.271/10.975 ms. Its matrix kernels account
for 7.786/7.633 ms (approximately 84%/70% of the span); attention including
merge accounts for 0.821/2.621 ms (9%/24%). Matrix work remains the largest
measured batched cost, followed by long-context attention. Timestamp
quantization makes summed pass durations differ slightly from the outer
span, including a -0.066 ms short-B8 residual; this is not negative overhead.
Profiling is diagnostic and separate from the uninstrumented throughput grid.

#### Rebuilt extension verification

`npm run build:chrome` succeeded. Visible Chrome loaded the rebuilt extension
and installed the model through its options surface. Eight complete English
and Japanese sources ran at widths 1/2/4/8 in two reversed-order rounds,
without result-cache reuse, glossary or shortened outputs.

| Width | Previous corpus seconds | Current corpus seconds | Current decode tok/s | Preview callback p50 ms |
| --- | --- | --- | --- | --- |
| 1 | 17.880 | 16.911 | 221.6 | 136 |
| 2 | 10.806 | 10.385 | 373.5 | 147 |
| 4 | 8.867 | 8.414 | 467.5 | 245 |
| 8 | 8.373 | 7.774 | 510.3 | 809 |

The previous column is historical `tps2-extension`, not interleaved A/B.
All 64 complete translations are byte-identical to that report and to the
current width-one outputs; no item errors. Variable request lengths, mixed
prefill/decode steps and batch draining distinguish this workload from the
fixed-width kernel grid. Higher aggregate throughput does not imply lower
first-preview latency. Preview callbacks do not measure DOM paint.

This verifies the installed extension's real engine/worker path, not live-site
scrolling or content-selection behavior. Default width one and the existing
width-two setting remain unchanged; widths four/eight are capacity experiments.
Measured TypeScript hashes match the final sources, and installed engine,
host, worker and kernel JavaScript hashes match `build/chrome`.

Evidence under `test-results/browser/`: `tps3-acceptance.json` indexes the
exact reports and provenance; `tps3-accept-{matrix,attention,logits,throughput,
heterogeneous,profile}/` contain raw checks; `tps3-extension/` contains the
corpus report and `sites-options.png`; `tps3-roofline.json` records the target
math. The final streaming probe's approximately 70.6 GB/s remains a diagnostic
microbenchmark, not a hardware ceiling.

### Matrix-focused optimization

Baseline: the preceding raised-target production source, preserved in
`test-results/browser/matrix4-baseline/`. Ordinary WebGPU, model, decode/KV
precision and request scheduling remain unchanged.

The preceding B8 profile attributes approximately 7.6 ms to matrix kernels
at long context: MLP expansion 2.98 ms, MLP contraction 1.72 ms, vocabulary
projection 1.59 ms, QKV 0.73 ms and attention output projection 0.61 ms.
This makes the MLP the largest matrix target, not just the vocabulary head.

Initial isolated candidates retained correct generated tokens but failed
to provide a useful broad throughput improvement:

- Explicit eight-nibble unrolling and vectorized shared-memory reduction:
  small single-row differences, no consistent batch gain.
- Signed-nibble extraction via XOR/sign-extension: regressed batch decode.
- Eight-lane K teams / sixteen outputs per workgroup: slight single gain,
  batch regression.
- Scalar activation loads to reduce live registers: B8 regressed roughly
  15–17%; vector loads remain important.
- Two-output vectors with 64-thread groups: B8 regressed roughly 8–9%.

These candidates were not installed. Screening evidence:
`matrix4-screen/`, `matrix4-arithmetic-screen/`, `matrix4-register-screen/`.
Each comparison interleaves candidates with its current baseline; absolute
rates across separate sessions are not causal comparisons.

#### Selected change: two-row Q4 scale factoring

The accepted implementation extends the existing single-row scale factoring
only to width two. For each lane and 128-weight quantization block, eight
nibbles are accumulated without their scale, then the scale is applied once
per output and request. This replaces 32 scalar scale multiplications with
eight scalar FMAs for two requests, retaining the 64 dot-product FMAs.
There are no additional GPU buffers, dispatches, device features or host
per-token allocations. The existing 16-lane final reduction is unchanged.

Applying the same factoring to wide batches regressed throughput: extra block
accumulators do not pay for themselves when scaled weights already serve
many requests. Widths 3–8 retain their previous arithmetic; width one was
already factored. The choice is made once when generating each pipeline.

Two-row screening improved 455.7→470.1 tok/s at prompt 128 and
390.2→401.3 at prompt 1024. A separate three-round short-context screen
measured 441.2→450.8. These are small gains, not a new performance tier.
Wider output register tiles, subgroup reduction and packed-prefill weight
loads were also rejected. No experimental subgroup language features or
unsafe browser flags were added to production.

The packed-matrix CPU-reference test now covers widths 1–8, every nibble via
dense dyadic inputs, long K=6144, partial tiles and output canaries. The
full-logit benchmark now snapshots all rows in a uniform batch, with an
explicit complete-final-step check, so width-two changes are validated
directly rather than only through single-row logits.

#### Final matrix acceptance

Three interleaved rounds, 96 generated tokens per sequence, identical model
and ordinary WebGPU on the same M5/24-GiB system. Initialization is excluded;
phase rates divide summed tokens by summed wall time. All 48 runs passed.

| Prompt tokens | Width | Baseline decode tok/s | Current decode tok/s | Change |
| --- | --- | --- | --- | --- |
| 128 | 1 | 236.1 | 233.8 | -0.97% |
| 128 | 2 | 432.4 | 443.1 | +2.47% |
| 128 | 4 | 665.1 | 661.4 | -0.56% |
| 128 | 8 | 816.5 | 820.1 | +0.45% |
| 1024 | 1 | 213.4 | 213.3 | -0.03% |
| 1024 | 2 | 379.6 | 390.0 | +2.74% |
| 1024 | 4 | 551.0 | 548.4 | -0.47% |
| 1024 | 8 | 676.0 | 671.6 | -0.65% |

Only width-two arithmetic changed. Other widths show sub-1% variation, not
an improvement claim. Current prefill is 1,193–1,556 tok/s and its kernel
is unchanged. Absolute rates differ from the earlier TPS3 session: the
short-context 240/850 targets were not reproduced by either baseline or
current in this grid. No claim is made that prior targets are guaranteed
minimums or that this change restores all of them.

The separate timestamp diagnostic samples 31 steps per condition. B2 matrix
time falls 3.537→3.383 ms at prompt 128 (-4.36%) and 3.402→3.328 ms at
prompt 1024 (-2.18%). MLP contraction contributes the clearest reduction:
0.856→0.759 ms and 0.786→0.717 ms. Individual timestamp bins are quantized;
these are attribution measurements, not the throughput acceptance rates.

Final correctness:

- Packed matrix: 12 fixtures, 991,778 independent CPU-reference values,
  all exact for these dyadic inputs; no validation errors or canary writes.
- Full logits: 1,612,800 values across widths 1/2 and prompt lengths
  1/257/513/1025/2044. Single-row logits are bit-identical. Two-row maximum
  absolute difference is 2.766e-5, maximum relative L2 1.092e-6, minimum
  cosine 0.9999999999992969; generated tokens match throughout.
- Throughput grid: all 17,280 generated IDs match baseline.
- Unequal-length/refill checks: all comparisons match across 2,176 IDs.

`npm run build:chrome` passed. Visible Chrome installed the rebuilt extension
and ran eight complete sources at widths 1/2/4/8 in two reversed-order rounds.
All 64 full translations are byte-identical to `tps3-extension`, and every
width matches current width one. No item issues. Current two-request corpus
time is 10.281 seconds, decode 378.7 aggregate tok/s and preview callback p50
142.7 ms. The historical corpus time was 10.385 seconds; this is not an
interleaved extension A/B and must not be treated as a causal speedup estimate.
Widths one/four/eight currently take 17.075/8.387/7.862 seconds respectively.

This is installed-engine/worker verification, not a live-site scrolling or
paint-latency test. Existing concurrency settings are unchanged. Final source
hashes match the measured variants and installed JavaScript hashes match
`build/chrome`. Experimental shader files were removed; the baseline and
measurement reports remain.

Evidence: `test-results/browser/matrix4-acceptance.json` indexes
`matrix4-accept-{reference,logits,throughput,refill,profile}/` and
`matrix4-extension/`, including the actual options-surface screenshot.

## Eight-request long-context attention

Eight active decode rows now share each partition's K/V loads across four
query heads instead of two. The existing long-context gate (>512 tokens)
still applies. Smaller active batches, including the tail of a draining
eight-request queue, retain the two-head pipeline; short-context attention
and matrix kernels are unchanged.

Both pipelines use one explicit bind-group layout and reuse the existing
per-layer bindings. The four-head shader increases workgroup storage from
7,184 to 14,352 bytes, below WebGPU's default 16 KiB limit. Global partial
scratch, KV allocation, partition size (256), merge format, model precision
and request scheduling do not change. Static shader generation preserves
the per-head reduction order and handles incomplete query-head groups.

This selection is deliberately narrow: screening at context 1024 improved
eight-row decode from 743.3 to 782.5 aggregate tok/s, but enabling the same
four-head path for one row reduced 221.9 to 212.3 tok/s. Sharing more heads
is not universally faster. Request-axis GEMV tiling, eight-row shared-memory
GEMM, vector-dot GEMV and smaller attention partitions were also measured;
none improved the eight-row target and none was retained.

The independent attention regression now covers both head-group widths
with seven query heads, including an incomplete group, sliding windows,
partition tails, invalid positions, scratch reuse and large scores.

### Eight-request acceptance

Apple M5 / 24 GiB, Chrome 143, ordinary WebGPU, unchanged Q4F16 model.
Three interleaved baseline/current repeats per condition, 96 generated
tokens per row; even repeats reverse variant order. Values below are
aggregate output tok/s from phase totals, not per-request throughput.

| Context | Active rows | Before tok/s | After tok/s | Change |
| --- | ---: | ---: | ---: | ---: |
| 128 | 1 | 233.5 | 234.6 | +0.5% |
| 128 | 2 | 432.8 | 435.2 | +0.5% |
| 128 | 4 | 644.8 | 648.1 | +0.5% |
| 128 | 8 | 799.0 | 798.8 | −0.02% |
| 1024 | 1 | 209.6 | 207.4 | −1.1% |
| 1024 | 2 | 387.2 | 386.5 | −0.2% |
| 1024 | 4 | 550.3 | 549.9 | −0.1% |
| 1024 | 8 | 662.0 | 716.4 | +8.2% |

The gain is confined to the intended long-context eight-row path. Prefill
at context 1024 / eight rows was unchanged: 1190.7 → 1190.9 input tok/s.
Unchanged paths varied by up to 1.1%; do not attribute their small changes
to this optimization.

Separate timestamp profiling at context 1024 / eight rows, averaged over
31 decode steps, measured attention-partial time 2.638 → 1.858 ms and
whole-step GPU span 11.401 → 10.515 ms. Matrix passes remain the largest
cost at 7.907 ms per step after the change; this optimization does not
solve that remaining bottleneck. Profiling is separate from throughput.

Verification:

- Independent CPU attention reference: 22 cases / 59,136 values; maximum
  absolute error 2.9444e-5 on the large-score case, within the existing
  tolerance (maximum tolerance ratio 0.114).
- Full-model logits: 4,838,400 values exactly equal to baseline across
  contexts 128, 511, 513, 1024 and 2044, widths one/eight.
- Generated IDs matched in all comparisons: 360 logit-check, 17,280
  throughput, 2,176 heterogeneous-refill and 512 profiling tokens across
  both variants. Refill covers widths three/eight and eleven requests.
- No WebGPU validation/page errors in these checks; Chrome build passed.
- Actual installed extension: 64 outputs across widths one/two/four/eight
  and two reversed-order rounds matched both width one and the preceding
  acceptance outputs byte for byte. Installed JS hashes include the
  changed attention module. The options screenshot was inspected.

| Installed extension width | Decode tok/s | Mean eight-source corpus | Preview callback p50 |
| ---: | ---: | ---: | ---: |
| 1 | 219.1 | 17.080 s | 143 ms |
| 2 | 379.9 | 10.253 s | 144 ms |
| 4 | 465.1 | 8.484 s | 251 ms |
| 8 | 506.0 | 7.861 s | 824 ms |

The mixed-length installed corpus did **not** measurably improve versus
the preceding acceptance (506.2 tok/s, 7.862 s at width eight). That is a
historical comparison, not an interleaved extension A/B. Eight simultaneous
requests do not remain eight long-context active rows throughout decoding,
so the kernel gain must not be presented as a general extension speedup.
Wider queues also trade later previews for aggregate throughput.

The installed benchmark exercises real worker/host/model execution, not
live-site scrolling or translated DOM paint. Phase counters exclude mixed
steps; preview latency is a callback measurement. Four/eight widths remain
engine-capacity experiments, not new UI options. No scheduler, default
concurrency or application behavior changed.

Evidence: `test-results/browser/batch8-acceptance.json` indexes the frozen
baseline, rejected candidate measurements, `batch8-accept-*` reports and
`batch8-extension/` output, screenshot and installed-file hashes. Temporary
candidate shaders and probe scripts were removed after verification.

## Matrix optimization plan informed by upstream engines

Status: design/research only; no new kernel performance is claimed here.
Baseline is `batch8-acceptance.json`, not upstream CUDA benchmark numbers.
Scope remains the browser engine, with the model, Q4 block128 format,
FP32 decode activations/accumulation and application admission unchanged.

### Upstream evidence and portability

- [Marlin's design](https://github.com/IST-DASLab/marlin#techniques) combines
  load-time weight/scale rearrangement, activation reuse, multiple warps
  per output tile, striped work partitioning and carefully scheduled
  dequantization. Its advertised speedups use NVIDIA tensor cores and
  FP16 operands; they are not predictions for our FP32 WebGPU kernel.
- [vLLM's dense Marlin kernel](https://github.com/vllm-project/vllm/blob/main/csrc/quantization/marlin/marlin_template.h)
  implements shape-specialized tiles, an eight-row mode, data-parallel
  plus split-K work distribution and FP32 temporary reduction. Its global
  lock/atomic protocols are not a portable WebGPU implementation strategy.
- [vLLM's Marlin weight preparation](https://github.com/vllm-project/vllm/blob/main/vllm/model_executor/kernels/linear/mixed_precision/marlin.py)
  repacks weights and permutes scales after loading, rather than converting
  the entire weight matrix on each inference step.
- [llama.cpp Metal GEMV](https://github.com/ggml-org/llama.cpp/blob/master/ggml/src/ggml-metal/kernels/mul_mv.metal)
  has format-specialized block dot products, activation reuse across output
  rows and subgroup reductions. Its Q4_0 dot helper uses masked nibbles,
  transformed activations and a block-sum zero-offset correction. Our
  block128 layout differs; its constants and arithmetic cannot be copied.
- [llama.cpp Metal GEMM](https://github.com/ggml-org/llama.cpp/blob/master/ggml/src/ggml-metal/kernels/mul_mm.metal)
  includes a native tensor-operation path. Ordinary Chrome's measured
  adapter exposes subgroups and shader-f16, but not subgroup matrices.
  Native Metal tensor operations and CUDA asynchronous-copy/cache-policy
  controls are therefore not assumed available to this plan.

These links track upstream main/master as inspected for this plan.
Implementation experiments must record the upstream revision they use.

### Stage A: retain output tiles, divide K within a workgroup

First target: Down, B=8, N=1536, K=6144, 16 layers. Current aggregate
GPU time is 1.837 ms per decode step. Keep the existing eight-output tile,
16-lane K microteam, vector loads and eight-request weight reuse.
Assign disjoint contiguous quantization blocks to two/four 32-thread teams
within one workgroup. This differs from previously rejected wider-lane
teams and request-axis tiling: each team retains the current microkernel,
while neither full-K weights nor dequantization are duplicated per request.

| Candidate | Threads/workgroup | Shared partial storage | Blocks/team | Workgroups/matrix |
| --- | ---: | ---: | ---: | ---: |
| A0 baseline | 32 | 4 KiB | 48 | 192 |
| A1 internal K split | 64 | 8 KiB | 24 | 192 |
| A2 internal K split | 128 | 16 KiB | 12 | 192 |

Shared partials use deterministic FP32 reduction after a workgroup barrier.
Keep all barriers uniform, handle padded outputs and do not add shared
arrays beyond the stated 16 KiB budget. Benefit is a hypothesis: more
execution teams and shorter dependency chains can be offset by reduced
occupancy and extra reduction work.

Compare with A3/A4: separate-workgroup Split-K of two/four parts, followed
by a deterministic reduction dispatch. These produce 384/768 workgroups
and require 96/192 KiB of global partials for B8 Down, reused across layers.
Measure both dispatches together. No spinlocks or floating-point atomics.
Only after a net win consider folding the merge into the following norm.
Do not apply Split-K indiscriminately to the vocabulary head, whose current
13,440 output workgroups already expose much more parallel work.

If Down succeeds, assess the N=1536, K=2048 output projection separately.
Select a winning route by actual shape, active width and supported features;
batch drain must not keep using an eight-row pipeline on fewer rows.

### Stage B: complete runtime-layout preparation

Target Gate/Up and vocabulary head, together 4.655 ms per B8 step.
`PACK_GEMV` already transposes Q4 words into four-output vectors; do not
reimplement this existing optimization. The remaining scale reads are
four scalar accesses at `[output * blocks + block]`.

- B1: prepare contiguous `vec4<f32>` scales at
  `[outputGroupOf4 * blocks + block]`, retaining exactly the same values.
  Keep Q4 layout and arithmetic unchanged to isolate layout effects.
- B2: on the measured fixed-32 subgroup path, load a scale vector once
  per four-output team and broadcast it with uniform subgroup operations.
  Use subgroup lane ownership explicitly, not an assumed mapping from
  local invocation IDs. Retain B1 or the baseline on unsupported devices.
- B3: specialize N/K/block-count and interior addressing for the five
  model matrix shapes. Do not force full loop unrolling; previous unrolling
  did not yield a useful broad batch win.

Measure B1, B2 and B3 independently before combining winners. Scale caching
may already make B1/B2 inexpensive; no large gain is assumed. Existing
prefill shaders still need their compatible scale representation. A second
packed scale copy for these two targets costs about 14.6 MB, which must be
included in load-time and peak-memory accounting. Allocate only retained
layouts; do not add a new persistent checkpoint format.

### Stage C: only evidence-backed arithmetic redesign

If A/B leave the target unmet, investigate the llama.cpp-style block-dot
algebra, preserving Q4 weights and FP32 activations:
`scale * (sum(unsignedNibble * activation) - 8 * sum(activation))`.
Hoist reusable activation transforms/sums across output rows and evaluate
mask-based nibble access. The block is 128 weights here, not Q4_0's block.
This changes rounding and can increase live block accumulators; ordinary
wide-batch scale factoring already regressed, so algebra alone is not a
reason to repeat that candidate. Require an explicit reduction in inner-loop
work without an uncontrolled increase in register state before testing.

W4A8 is a separate accuracy-changing research track, not an implementation
dependency. Neither FP16 activation conversion nor INT8 activation
quantization belongs in the exact-layout candidates above.

### Engine utilization, separate from matrix acceleration

[vLLM's chunked-prefill policy](https://github.com/vllm-project/vllm/blob/main/docs/configuration/optimization.md#chunked-prefill)
prioritizes pending decodes and fills the remaining token budget with
prefill chunks. Our engine already has refill, mixed steps, reused
pipelines/bindings and tiled prefill; these must not be advertised as new.

After the matrix winners are selected, record active rows and elapsed time
for pure-decode, pure-prefill and mixed steps. On a fixed corpus this reveals
how much work actually uses the eight-row route. Only then compare bounded
mixed token budgets of 8/16/32/64 while preserving decode priority, request
identity, cancellation and KV ownership. Do not wait to fill eight slots.
Keep application target selection unchanged. Do not copy vLLM's server-scale
8192+ token budgets into an interactive browser.

Paged KV allocation and prefix caching can address memory/prefill reuse,
not the measured 7.907 ms of per-step matrix execution. CUDA Graphs and
persistent lock-based CUDA scheduling are not direct WebGPU ports.

### Experiment protocol and adoption gates

1. Preserve the current source/model/build hashes. Use existing source
   override experiments; install only selected candidates, with no runtime
   experimental setting or universal backend abstraction.
2. Screen the five matrix shapes at B8; include B1/2/4 and drain widths in
   correctness checks. Separate hot repeated-matrix timings from realistic
   traversal of the model's 385 MB matrix inventory. Hot-cache results
   alone cannot justify adoption.
3. Run the independent CPU packed-matrix reference, including dense K6144,
   block/output tails and padded canaries. Repacking must be value-exact.
   Changed reduction association must pass existing numerical tolerances,
   full-model logits and deterministic token/corpus comparisons; never
   weaken tolerances to admit a faster candidate.
4. Benchmark 128/1024 contexts, widths 1/2/4/8, 96-token decodes and at least
   three interleaved A/B repetitions, reversed on alternate rounds.
   Timestamp profiling is separate and includes merges/fusions, not just
   the faster partial kernel. Measure load/compile time and GPU memory too.
5. Proposed adoption gate: target matrix-plus-merge time improves >=10%
   and targeted full-model B8 decode improves >=3%, beyond measured run
   variation. Smaller widths/prefill must not show a reproducible >2%
   regression. Reject candidates that only improve isolated hot kernels.
6. Run heterogeneous refill/drain/cancellation scenarios and the actual
   installed-extension corpus. Require no output issues or validation
   errors; compare complete outputs. For an end-to-end improvement claim,
   require >=5% lower corpus completion time without >5% regression in
   preview p90 or decode inter-token p90 under the same arrivals. Record
   mixed-step time explicitly. A kernel-only win must be labeled as such.

Planning milestones, not predictions: matrix time 7.907 -> <=6.3 ms is the
first target. Holding the prior measured non-matrix residual constant gives
approximately 837 aggregate tok/s at context 1024. Approximately 1000 tok/s
would require <=4.74 ms matrix time, about a 40% reduction. These estimates
combine separately measured profile and wall timings; only a new full-model
and installed-extension measurement can establish achieved throughput.

## Matrix-plan implementation experiments (ordinary Chrome WebGPU)

Executed the preceding plan on Apple M5 / 24 GiB with Chrome for Testing
143 and the 705,701,446-byte PLaMo Q4F16 ONNX graph. No native host or
experimental WebGPU feature was enabled. The source and installed extension
baseline are frozen under `test-results/browser/matrix5-baseline/`.

### Rejected decode-kernel candidates

Implemented and measured, rather than assuming that CUDA techniques transfer:

- Down-projection K splitting: two/four teams within a workgroup and
  two/four global partials followed by a merge. CPU references included
  uneven/empty partitions, dense K6144, partial outputs and output canaries.
  All four passed; the merge and shared-memory costs did not establish a win.
- Packed GateUp/head scales, with and without fixed-32-subgroup broadcast.
  Both passed exact packing/output references, but their extra 14,598,144
  persistent bytes were not justified by consistent full-model improvement.
- Static shape specialization, shorter activation live ranges and scale-bias
  FMA scheduling. Correct outputs, no reproducible adoption-gate improvement.
- Fused feature-major activation writes, padded shared-memory reductions and
  smaller output microtiles. Their transpose/reduction costs outweighed reuse.
- Exact nibble-to-float bitcasting and a row-major two-output microtile with
  fewer live accumulators. Neither justified replacement of the current GEMV.

| Paired full-model screen, context 128 | Baseline B8 decode tok/s | Candidate B8 decode tok/s | Decision |
| --- | ---: | ---: | --- |
| Feature-major activation layout | 748.45 | 692.18 | Reject |
| Feature-major layout, padded reduction | 844.36 | 774.88 | Reject |
| Feature-major layout, smaller microtile | 844.36 | 694.72 | Reject |
| Exact nibble bitcast | 782.82 | 797.60 | No demonstrated end-to-end gain |
| Row-major two-output microtile | 470.96 | 386.16 | Reject |

Rates are total emitted pure-decode tokens divided by total measured
pure-decode wall time over four alternating-order repetitions, not averages
of per-run rates. Compare only within a row: substantial run-to-run drift
prevents comparing rates from different sessions. For example, the first
seven-candidate screen's unchanged baseline moved from 396 to 685 to 701
tok/s. Power telemetry reported AC power and no recorded thermal/performance
warning; the cause of the drift is not established.

All completed candidate full-model comparisons produced identical generated
token IDs with no page/WebGPU validation errors. The feature-major candidate
also passed full-vocabulary logits checks at contexts 128 and 513. Numerical
correctness is necessary but not sufficient: none of these decode candidates
is shipped. Disposable candidate code/probes were removed; reports retain
source hashes, options, samples and comparisons in `matrix5-*-screen/`,
`matrix5-profile-screen/` and `matrix5-transposed-logits/` beneath
`test-results/browser/`.

### Mixed-budget experiment: retain the latency bound

Compared the existing 32-position mixed budget with 8, 16 and 64, then
confirmed 32 versus 64 over four alternating-order repetitions at widths
2/4/8. The confirmation uses eleven heterogeneous requests with prompt
lengths cycling through 32/128/512/1024 and 544 generated tokens per corpus.
Queued and individually executed requests produced identical token IDs.

| Concurrent requests | Mean corpus ms, budget 32 | Mean corpus ms, budget 64 | Mixed-step p90 ms, budget 32 | Mixed-step p90 ms, budget 64 |
| --- | ---: | ---: | ---: | ---: |
| 2 | 7522.3 | 6321.8 | 57.7 | 92.3 |
| 4 | 6682.0 | 5367.0 | 53.6 | 79.4 |
| 8 | 7002.1 | 6407.9 | 58.1 | 109.3 |

The wider budget reduces repeated weight traversal while consuming prompts,
but makes already-decoding requests wait longer between mixed steps. These
are kernel-step wall times, not per-request token intervals or DOM paint.
They show a clear latency risk rather than meeting the adoption gate; the
default remains 32. The 8/16/64 alternatives remain existing diagnostic
overrides, not new user settings. Source: `matrix5-mixed-confirm/` (48 runs,
zero token mismatches or WebGPU/page errors). Do not report the noisier
two-round `matrix5-mixed-screen/` result as an achieved production speedup.

### Additional register/shared-memory experiments

Two interleaved request-row tiles split B8 into independent four-row or
two-row workgroups, keeping adjacent groups on the same weights without
partial-output buffers or a merge. Both passed 991,778 independent CPU
output comparisons, canaries and full-model logits/token checks. Four
alternating-order runs at context 128 measured 567.98 aggregate decode
tok/s for the baseline, 490.94 for four-row tiles and 416.51 for two-row
tiles. Reducing live accumulators did not repay the repeated weight work.

Portable GEMM experiments padded shared activation rows alone, padded
activation and weight rows together, and enlarged the FP16 output tile
from 32 to 64. Each passed 18 independent CPU cases (18,696 outputs),
including dense K6144, both tile heights, partial rows/outputs and canaries,
with zero error on the exactly representable fixtures. All full-model
generated tokens and logits checks also passed.

| GEMM experiment, B8 context 1024 | Baseline prefill tok/s | Candidate prefill tok/s |
| --- | ---: | ---: |
| Padded activation rows | 1030.6 | 987.6 |
| Padded activation and weight rows | 1030.6 | 946.8 |
| 64-output tiles at both heights | 1054.6 | 1043.1 |

The short-context 64-output screen appeared faster (940.4 -> 1219.6
prefill tok/s), but the three long-context repetitions did not reproduce
the gain. These are screening results, not production improvements.
Reports: `matrix5-rowtile-screen/`, `matrix5-gemm-pad-screen/`,
`matrix5-gemm-n64-screen/` and their corresponding reference directories.

### Narrow FP16 GEMM candidate (rejected after installed verification)

The `src/lib/kernelmatmul.ts` candidate used a 32-token x 64-output tile for narrow
FP16 GEMM, with 128 invocations and 12 KiB shared memory instead of
64 invocations and 8 KiB. Each invocation still computes a 4x4 register
microtile with the same ascending-K FP32 FMA order and existing FP16 staged
operands. Staged activations are reused across twice as many output channels;
the output-axis workgroup count halves. Q4 layout/scales do not change.

The `src/lib/kernels.ts` candidate selected the corresponding output dispatch width.
Wide FP16 GEMM remains 64x32; portable FP32 remains 32x32. Pure-decode
GEMV, attention, the 32-position mixed budget, decode priority, request/KV
ownership and application scheduling are unchanged. There are no extra
persistent buffers, pipelines, model-layout copies or experimental features.
The additional 4 KiB is per-workgroup shared storage for the narrow FP16
shader, not a persistent model allocation.

The isolated three-round heterogeneous B8 screen consistently improved:
mean corpus completion 6295.9 -> 5565.7 ms (-11.6%); mean mixed-step time
42.69 -> 37.51 ms; mixed-step p90 50.1 -> 42.3 ms. Eleven queued requests
with different prompt/output lengths matched individual execution exactly.
Source: `matrix5-narrow64-screen/`. This is a mixed/prefill GEMM change,
not evidence that pure B8 decode reached the earlier 837/1000 tok/s planning
targets. Installed-extension acceptance is measured separately below.

Integrated numerical checks passed: 24 CPU-reference cases / 37,800 values,
including 65/67-output tile boundaries, with zero fixture error and intact
canaries. Forced-32-position prefill at lengths 33/129 and widths 1/2/4/8
passed full-vocabulary logits tolerances and exact generated-token checks.
The 36-run heterogeneous confirmation at widths 2/4/8 also had zero token
mismatches or WebGPU/page errors. Four existing host regressions passed for
out-of-order completion, refill, sibling cancellation/invalid-output
isolation and late-frame rejection. Chrome build completed successfully.

The integrated timing confirmation did **not** reproduce the initial
improvement uniformly:

| Concurrent requests | Baseline mean corpus ms | Candidate mean corpus ms | Baseline mixed-step p90 ms | Candidate mixed-step p90 ms |
| --- | ---: | ---: | ---: | ---: |
| 2 | 5958.1 | 5674.5 | 42.7 | 40.0 |
| 4 | 6001.0 | 6015.0 | 49.8 | 51.5 |
| 8 | 6863.2 | 7300.9 | 54.6 | 64.0 |

Each cell pools three alternating-order repetitions; retain the slower
samples rather than removing them as outliers. In B8's last repetition,
even individual execution moved from 9157 to 11877 ms, although that path
mostly uses unchanged wide-prefill/GEMV kernels. This establishes timing
variability, not its cause and not an excuse to claim the initial -11.6%
as production improvement. Sources: `matrix5-final-reference/`,
`matrix5-final-logits/` and `matrix5-final-heterogeneous/`.

### Installed Chrome ABBA result and final disposition

Installed frozen baseline A, candidate A, candidate B, frozen baseline B in
four fresh visible Chrome profiles, serially and without unsafe WebGPU.
Each session ran two warmed rounds with reversed widths 1/2/4/8 and eight
complete real source texts per corpus. Model installation used the shipped
UI/OPFS path; translations used the installed service worker and kernel
backend, without glossary or result cache. This is an installed engine
benchmark, not a live-site scrolling or Aurora DOM-paint test.

| Width | Baseline corpus seconds | Candidate corpus seconds | Observed completion-time reduction |
| --- | ---: | ---: | ---: |
| 1 | 34.172 | 36.996 | -8.3% |
| 2 | 23.407 | 22.170 | 5.3% |
| 4 | 20.852 | 18.576 | 10.9% |
| 8 | 19.198 | 18.645 | 2.9% |

Each time pools four corpus rounds per build. For B8, first-preview p90
was 2469.3 -> 2340.9 ms and streaming-callback gap p90 was 67.2 -> 63.8 ms.
The host's pure-prefill rates were 761.9 -> 917.8 tok/s and pure-decode
rates 200.2 -> 202.1 tok/s, excluding mixed steps. These noisy observations
are not causal speedup claims: the unchanged baseline's B1 corpus varied
from 43.77 to 22.69 seconds. Neither clock/thermal causation nor a stable
overall gain is established.

Separate intrusive GPU profiling of 106 full 32-row mixed steps per build
measured targeted matrix passes at 30.794 -> 30.586 ms (-0.7%), while the
whole profiled step span was 39.683 -> 40.537 ms. This misses the >=10%
matrix gate, and the installed B8 corpus misses the >=5% completion gate.
The nominal B1 slowdown also cannot be ignored or explained away.
**Reject the candidate: restore the original kernels and the 32-position
mixed budget. No engine speedup is shipped from this experiment.**

All 256 installed translations completed without output issues. All 128
cross-build final-text pairs matched exactly, as did comparisons across
widths within each session. Installed hashes were stable across the two
sessions of each build; only `lib/kernels.js` and `lib/kernelmatmul.js`
differed between builds. The candidate and final baseline options screenshots
were inspected: local model installed, Korean target, production concurrency
option still off. The runtime-verified baseline is rebuilt for delivery.

Retained changes are measurement support: `EXTENSION_DIR` for frozen-build
comparisons, streaming-gap metrics and inclusion of `kernelmatmul.js` in
installed hashes. All disposable candidate/probe sources are removed.
Reports: `matrix5-final-profile/` and
`matrix5-installed-{baseline,current}-{a,b}/`; aggregate acceptance evidence
is `test-results/browser/matrix5-acceptance.json`. In these historical
reports, `current` means the rejected candidate, not the final shipped state.

The measured work does not meet the earlier decode milestones. Split-K,
scale-layout preparation, register/shared-memory tiling and a larger mixed
budget have now been tested rather than assumed beneficial. Further claims
need reproducible full-model and installed-browser evidence, not the
favorable initial screen or a faster isolated partial kernel.

## Same-source request length versus parallel chunks

Evidence: `test-results/browser/length6-comparison/chunk-benchmark.json`
and `analysis.json`. Real installed Chrome 143 on the same Apple M5, PLaMo
Q4F16 model, ordinary WebGPU, Korean target, 2048-token context/output
window. The six installed engine hashes match the restored baseline above.
No kernel, application scheduling or production concurrency setting changed.

Compared the same English technical document (335 source tokens) and Japanese
library article (318) at six policies over four warmed rounds: 48 document
runs / 240 fragment requests, excluding warmups. Each source finishes before
the next starts. Adjacent rounds reverse policy order; each pair rotates its
starting policy. Token-aware partitioning prefers sentence boundaries and
preserves every source character. Planning/token counts took 8.45 seconds
offline and are excluded; normal per-request counting and prompting remain
inside measured time.

| Request policy | Peak overlapping requests | Mean document completion s | Ordered first preview p50 ms | Fixed-source tok/s | Pure prefill tok/s | Pure decode tok/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Whole document, serial | 1 | 11.157 | 529 | 29.26 | 757.91 | 88.91 |
| Up to 128 tokens, serial | 1 | 10.136 | 213 | 32.21 | 724.73 | 100.67 |
| Up to 64 tokens, serial | 1 | 10.330 | 138 | 31.61 | 637.10 | 102.21 |
| Up to 64 tokens, width 2 | 2 | 5.849 | 221 | 55.82 | 862.53 | 185.88 |
| Up to 64 tokens, width 4 | 4 | 4.222 | 361 | 77.32 | 883.67 | 268.35 |
| Up to 64 tokens, width 8 | 6–7 | 3.339 | 594 | 97.78 | 893.49 | 348.17 |

The 64-token partition produces seven English chunks
`[50,42,45,55,59,58,32]` and six Japanese chunks `[55,63,53,57,51,39]`;
there are not eight active requests in the width-8 condition. The 128-token
partition produces three chunks per document. `peakActive` measures
overlapping installed engine calls, not a new per-step GPU-row trace.

Fixed-source TPS divides the unchanged whole-source token count by complete
document wall time. Pure phase counters exclude mixed steps; parallel decode
TPS is aggregate, not each request's rate. First preview refers specifically
to source chunk zero and is a validated worker callback, not DOM paint.
In width 8, the first callback from *any* chunk was 407 ms p50, but the
ordered first preview was 594 ms. Reporting the former as top-of-document
latency would hide the reading-order cost.

### Interpretation

- Splitting alone mainly improves time to first text. Serial 64-token
  chunks finish only 1.08x faster overall, with per-round ratios ranging
  from 0.84x to 1.25x; that total-time advantage is not robust.
- Parallel processing of identical 64-token chunks is the strong result:
  widths 2/4/8 are 1.91x / 2.64x / 3.34x faster than whole-document serial
  execution. Every round showed the advantage; width 8 ranged from
  2.96x to 3.63x. It improved both sources, not just one language.
- More parallelism does not minimize leading-text latency. Width 2 keeps
  the first ordered preview near the short-serial case while cutting total
  completion substantially. Width 8 maximizes this corpus's throughput,
  but its leading preview is slower than whole-document serial execution.
- Shortening requests has real overhead: serial 64-token splitting raised
  measured prefill input from 2740 to 3468 tokens over the same eight
  source runs (+26.6%). Raw source tokenization changes only 2612 -> 2636;
  the remaining increase is repeated per-request prompt work. It is not
  free to split a document into arbitrarily tiny pieces.

Recommendation for this measured cohort: sentence-aware chunks capped near
64 source tokens, with width 2–4 for visible text, rather than one long
request or always maximizing concurrency. A visible-first policy that starts
the leading chunk before filling remaining slots is a possible next
experiment, **not implemented or measured here**. Background work may favor
higher width when leading-text latency is irrelevant. These two documents
do not establish a universal page policy or a one-second completion SLO.

### Output review

All 240 requests passed automatic output checks, with no backend substitution
or extra generations beyond request count. Partitions/reassembled request
ownership match the original source order. Every 64-token output was
byte-identical across widths 1/2/4/8 and all four rounds for each document.
Thus parallelism did not change the translations in this cohort.

Manual review of both complete documents at whole/128/64 partition sizes
found no mid-sentence cutoff or missing final clause. The Japanese outputs
preserved the 14-day deadline, Saturday sessions, six-month review, privacy
and family-number restrictions, separate funding/no paper-book purchase cut,
and phone/counter access.

This is **not** a clean semantic-quality pass. English mistranslations remain:
whole-document translation corrupts the application/source-retention clause
into “작업 작업은 표시된 번역과 별도로 분리해야 합니다”; 64-token chunks
render “application” as “응용 과제”. “Qualification” becomes “자격 요건”
across variants, and the 128-token final clause weakens “source languages”
to “원본 소스”. Longer context did not guarantee a better translation.
The automatic validity flag must not be presented as semantic completeness.

## Installed-extension source-token rollout (Japanese only)

The application now uses the host tokenizer to split interactive source text
at 64 tokens, preferring sentences and falling back to word/grapheme boundaries.
The DOM still owns a bounded 480-character quantum so scrolling can re-rank
later work. Two visible units each receive one slot; a lone visible unit can
use both internally. Out-of-order fragments are buffered behind the leading
source-order prefix. Idle prefetch stays serial. New settings default to two
slots; an explicitly saved serial choice is preserved.

English was excluded from this evaluation, not removed from supported
application languages. No new glossary/history context was added.

Real installed Chrome, real local q4f16 weights, Japanese-to-Korean fixtures,
warm shared model, content → background → host path:
`test-results/browser/page-fragments-verified/page-fragments.json`.
Each condition below has one sample, not a statistical performance estimate.

| Visible fixture | Slots | First displayed preview ms | Complete page ms | Generated source tok/s |
|---|---:|---:|---:|---:|
| Long paragraph | 1 | 335.0 | 10784.7 | 29.49 |
| Long paragraph | 2 | 435.8 | 7968.4 | 39.91 |
| Comment + long paragraph | 1 | 311.0 | 14819.4 | 25.44 |
| Comment + long paragraph | 2 | 421.5 | 12240.9 | 30.80 |

The long paragraph's six fragments contained `[55,63,38,54,49,59]`
source tokens. The paired fixture added a 59-token comment. Rates above
divide these actual fragment-source counts by end-to-end completion time;
they are **not pure decode TPS**, output-token rates, or whole-page
millisecond completion claims. Planning, IPC, generation, scheduling and
presentation are included. Browser automation/screenshot capture can affect
latency.

Two slots reduced completion time by 26% for the long paragraph and 17% for
the paired fixture in this run, but delayed the first visible preview by
about 101/111ms. Serial/parallel full outputs were identical in each fixture.
The page never exceeded its selected one/two active host-request limit.
Streaming screenshots retained the untranslated Japanese suffix while the
Korean prefix replaced it. Every completed scenario restored its exact
source on OFF; cancellation during streaming also restored exactly and left
zero presentation hosts/auroras.

The initial run also completed all translation/restore/cancellation checks,
but its fixture HTTP server prevented process exit. Explicit connection
shutdown fixed the harness; the complete rerun above exited successfully.
Its timings differ from the initial run, reinforcing that this is rollout
smoke evidence rather than a stable latency distribution. No broad semantic
quality or public-site SLO is established.

Verification: TypeScript checks; Chrome/Firefox build and package gates;
607 Node cases exercised, with changed-contract failures corrected and the
affected suites rerun (final background/content run: 82/82, preceding
engine/pipeline focused cases passed); installed-extension browser regression
suite 17/17, plus the real-model Japanese scenario above.

## Scroll-stop completion: shared fragment admission

The acceptance metric is now the time from the **last actual scroll event**
until **all eligible visible-at-rest targets have final committed translations**.
First preview latency is not the success criterion. The harness confirms
100ms of scroll quiet but retains the preceding event timestamp as t0.
Work begun while scrolling remains included as in-flight work; no fresh
cohort target was already complete at t0. Cached revisits are separate.

### Change

`AT.engines.createFragmentScheduler` provides FIFO admission of individual
generations. The background shares one scheduler across overlapping batches
from a tab, capped at its stored one/two-slot setting. Every visible parallel
unit can request two internal workers, so completion of a short unit frees
its slot for another fragment of a long unit immediately. Counting does not
occupy a generation slot. Idle prefetch retains one worker.

Queued cancellation removes work before generation. A failed fragment
cancels only its own request's siblings, while other units continue.
OFF/navigation/settings invalidation preserves tab ownership and cannot
let stale cleanup remove a newer scheduler. Ordered source-prefix display,
exact restoration, 64-source-token partitions, 480-character DOM quanta,
model weights and GPU kernels are unchanged.

### Actual installed Chrome evaluation

Frozen baseline: the verified build from `5b71786`, copied before rebuilding.
Both builds used the same Japanese-to-Korean fixtures, 1440×1600 viewport,
warm q4f16 model and two-slot setting. Three rounds per scenario per build;
baseline rounds ran before candidate rounds. Installed hashes differ only
for `background.js`, `lib/pipeline.js` and `lib/engines.js`.

| Visible-at-rest cohort | Baseline median ms | Shared-slot median ms | Observed median reduction | Baseline range ms | Shared-slot range ms |
|---|---:|---:|---:|---:|---:|
| Short comment + long paragraph | 12822.0 | 10151.7 | 20.8% | 10150.1–13135.4 | 9963.9–10420.1 |
| Four reading units | 10372.8 | 10347.8 | 0.2% | 9931.0–12275.8 | 10122.5–10823.6 |

The mixed-length scenario confirms the intended borrowing behavior: in the
candidate's first round, the short comment released its slot at t0+677ms
and the long paragraph's next fragment started immediately, before its
first fragment finished at t0+2812ms. The baseline waited for the long
paragraph's first fragment to finish before dispatching its second.
This is host-request admission evidence, not a GPU utilization measurement.

The four-unit result is effectively unchanged: a 25ms median difference
does not establish an improvement against this variation. Even the mixed
scenario has overlapping ranges, and the baseline's fastest round is near
the candidate median. Report 20.8% as the observed median reduction in
this experiment, **not a stable or universal speedup**. More simultaneous
work can lengthen individual generations; filling slots alone does not
guarantee faster completion for every viewport. Fixed DOM-wave boundaries
and single-request tails remain.

All 12 fresh runs passed, with 18/18 targets complete per build and no
omitted failures. Every paired full output was identical across builds.
Actual peak host generations remained two. Scroll-away/back checks in both
directions retained completed DOM, issued no new generations and had zero
remaining completion time. In-flight cancellation restored exact originals
and left no presentation hosts, including after the host became idle.
Final and restored screenshots were inspected.

Evidence:
- `test-results/browser/scroll-completion-baseline/scroll-completion-baseline.json`
- `test-results/browser/scroll-completion-shared/scroll-completion-candidate.json`
- `test-results/browser/scroll-completion-comparison.json`

Verification: TypeScript checks; 156 focused engine/background/pipeline/content
cases exercised (155 initially passed; the new borrowing test's empty-clear
callback expectation was corrected and its rerun passed); Chrome/Firefox
build and package verification; the real-model scroll scenarios above.
No cold-start, public-site or sub-second full-viewport completion claim is made.

## Quantified viewport-completion targets on M5

These are proposed acceptance targets, not achieved public-site results.
The hardware check reports Apple M5, 10 GPU cores and 24 GiB unified memory.
Apple specifies 153 GB/s shared whole-chip bandwidth; this is not sustained
WebGPU bandwidth. The main display uses a 3200x1350 logical desktop, whereas
the historical public-page sample below used a 1280x1000 CSS viewport.
Do not scale text workload by display pixel area.

### Observed workload and provisional standard

Re-analysis of `test-results/browser/site-matrix-live/youtube-comments.json`
uses seven whole-viewport comment cohorts from the Japanese video
`https://www.youtube.com/watch?v=DBjiUz0H9HY`. Exclude the three reply-only
cohorts (`open-first-thread`, `load-more-first-replies`, `open-second-thread`),
already-Korean units and sources without Japanese kana. Authors and IDs
are outside the comment-body selector. Counts include revisits.

| Population | Measured value |
| --- | ---: |
| Whole-viewport observations / distinct comment bodies | 7 / 40 |
| Mean eligible bodies per observation | 7.57 |
| Range of eligible bodies per observation | 5–10 |
| Mean original UTF-16 code units per observation | 1031 |
| Range of original code units per observation | 286–1843 |

This is a single-page convenience sample, not a cross-site average.
An intersecting comment contributes its entire source, including text beyond
the viewport or a collapsed preview. Several stored source strings are
truncated to 180 characters, but `sourceChars` retains their full lengths.
Do not tokenize those prefixes and call the result the full workload.

The independent Japanese calibration in
`test-results/browser/length6-comparison/chunk-benchmark.json` contains
868 source code units / 318 source tokens. Its 64-token serial partition
generated 886 decode tokens. Applying those ratios gives approximately
378 source / 1052 generated tokens per sampled viewport: **an estimate from
one calibration document**, not measured token counts for those comments.
Adopt a provisional standard of **8 bodies, 400 source tokens, approximately
1100 generated tokens**, and report actual tokens on every future run.
Prompt overhead is additional; fragment length and longest output must also
be recorded. English is excluded from this performance population.

### Hardware feasibility

At context 128, the existing ideal streamed-weight roofline gives 784.8
aggregate decode tok/s at B2 and 3039.6 at B8. Generating 1100 tokens alone
therefore costs at least 1.40s / 0.362s under those optimistic assumptions,
before prefill, dispatch, UI work and unequal sequence tails. Larger contexts
make this worse. These are conditional bandwidth bounds, not measured rates.
Fresh completion in 200ms requires 5500 aggregate output tok/s, already above
both scenarios. Kernel optimization alone cannot satisfy that target under
this execution model.

The Japanese calibration completed in mean 5.032s at width 2 and 3.177s at
width 8; the latter actually had six live fragments. Linear workload scaling
to the sampled mean gives approximately 6.0s / 3.8s. This is a planning
estimate, not a public-page prediction. Production currently admits two
generations. The newer installed-extension scroll fixtures still measured
10.152s and 10.348s medians for their different two-/four-body workloads.

### Acceptance targets

Measure from the last actual scroll event to all eligible bodies at that
position having final translated text painted, with no remaining source
overlay or busy effect. Count quiet-period detection and final animation
inside the interval; first preview is not completion. Fix the cohort at
scroll stop, retain unfinished cases as deadline misses, and separately
report new arrivals, warm/cold model state and cache/pretranslation coverage.

| Workload/state | Proposed p50 | Proposed p95 |
| --- | ---: | ---: |
| Warm, ordinary scrolling; provisional standard viewport | 100ms | 200ms |
| Warm, entirely unseen standard viewport; no prior translation | 4s | 6s |

The first row is the **instant-completion SLO**; 500ms is a long-tail alert,
not an alternative definition of instant. The second is an engineering
milestone requiring improved scheduling/concurrency, not an instant claim.
Model loading is reported separately and is not covered by these warm SLOs.
Existing four-/three-round experiments do not establish population p95.

Reserving 50ms of the 200ms budget for selection/presentation leaves 150ms
for inference. Using the calibration's end-to-end work-equivalent throughput
allows only about 26 residual output tokens at width 2 or 42 at width 8:
roughly **98% / 97% of a 1100-token workload must already be processed**.
These rounded requirements are optimistic necessary conditions, not
sufficient ones: a new request still pays prefill and a sequential tail.
In practice aim for all visible bodies to have completed cached results.
The 50ms presentation allocation is a target, not the current fade duration.

Track **whole-viewport readiness**, not just per-body cache hit rate.
For illustration only, independent 95% per-body readiness gives
`0.95 ** 8 = 66.3%` all-ready viewports; 95% all-ready requires
`0.95 ** (1 / 8) = 99.36%` per body. Real hits are correlated, so measure
the viewport event directly. Reuse completed translations and pretranslate
likely next content while the current screen is being read; a new distant
scroll jump remains a fresh-inference case rather than a hidden SLO pass.

This analysis reuses recorded browser experiments and recomputes counts,
token calibration and budgets locally. It adds no new live-browser speed
measurement and makes no claim of Reddit/Pixiv/news/PDF-wide average load.

## PLaMo 3 ONNX versus GGUF: direct browser kernels

The four user-provided files in `weight/plamo-3-translate-0.8b-GGUF/`
now load directly from the extension's model file picker. This is not
a llama.cpp/native companion integration or a GGUF-to-ONNX conversion.
The parser validates PLaMo 3 geometry and preserves packed GGML weights;
the existing scheduler/attention engine dispatches per-matrix quantized
GEMV/GEMM kernels. Embedded vocabulary, special tokens and chat template
produce the tokenizer sidecars during import. Unsupported architectures
fail rather than falling back to ONNX Runtime.

ONNX describes a computational graph and tensors; GGUF stores tensors
and model/tokenizer metadata, with the architecture supplied by the
inference engine. Neither container itself determines throughput.
These files differ in quantization policy as well as container, so
this comparison does not isolate a pure container-format speed effect.

### Weight traffic and numerical checks

| Variant | File bytes | Matrix bytes per decode step | Embedding bytes |
| --- | ---: | ---: | ---: |
| ONNX q4f16 | 705701446 | 385204224 | 330301440 |
| GGUF Q2_K | 410138816 | 352923648 | 54190080 |
| GGUF Q3_K_M | 486385856 | 412397568 | 70963200 |
| GGUF Q4_0 | 547543232 | 451620864 | 92897280 |
| GGUF Q4_K_M | 573126848 | 477204480 | 92897280 |

Matrix bytes sum packed linear weights and their scales, excluding norms,
KV/activation traffic and repeated reads. ONNX counts its uploaded FP32
scales. This is an inventory-based lower bound, not measured DRAM traffic.
GGUF embeddings are decoded one requested row at a time; shrinking this
table saves storage/residency but does not save a full-table read per token.
All four GGUF files have a 135475200-byte Q6_K output matrix, versus
87736320 bytes for ONNX Q4 including scales. Q4_K_M therefore has about
24% more per-step matrix bytes than ONNX despite its smaller file;
Q2_K reduces that inventory by only about 8.4%.

The names are mixed-precision policies, not uniform bit widths. Q4_0
also contains Q4_1, Q3_K_M contains Q4_K and Q5_K, and Q4_K_M contains
Q6_K. All seven required block formats are supported without requantizing.
The GGUF output matrix exceeds WebGPU's baseline 128MiB binding limit;
the engine requests a larger supported limit and rejects incapable devices.

Independent `gguf-py` 0.19.0 dequantization of actual tensor rows was
compared against CPU row decoding and browser GPU matrix multiplication:
49 GPU cases across seven formats, GEMV widths 1/2/8 and GEMM widths 9/33
with both FP32 and FP16 staging. CPU values matched exactly. Maximum
GPU error scaled by `1 + abs(reference)` was below 0.000009.
FP16 staging uses an explicitly FP16-rounded reference; its separate
maximum drift from full-precision operands was 0.020618.
Evidence: `test-results/browser/gguf-numerics/numerics.json`;
harness: `test/engine-spike/check-gguf.mjs` with `GGUF_REFERENCE`
pointing to independently generated packed rows and dequantized values.

For all four actual GGUF files, the full 107520-token vocabulary matched
ONNX. Three Japanese prompt cases, including repeated spaces and emoji,
produced identical rendered prompts and token IDs. RoPE frequencies
differed by at most 1.14e-13. Norms differed by up to 0.000782 because
the GGUF/ONNX exports retain different precision; the quantized models
are not bit-identical mathematical models.

The [upstream model card](https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF)
reports FLORES Ja↔multilingual scores of 36.08 for BF16, 35.90 for
Q4_K_M, 34.97 for Q4_0, 35.32 for Q3_K_M and 33.56 for Q2_K.
These are publisher results, not our Japanese→Korean quality measurements.
Block layouts follow upstream
[ggml-quants.c](https://github.com/ggml-org/llama.cpp/blob/master/ggml/src/ggml-quants.c)
and [ggml-common.h](https://github.com/ggml-org/llama.cpp/blob/master/ggml/src/ggml-common.h);
PLaMo geometry follows
[plamo3.cpp](https://github.com/ggml-org/llama.cpp/blob/master/src/models/plamo3.cpp).

### Installed extension completion measurements

M5 / 24GiB, headed Chrome 143.0.7499.4, ordinary WebGPU (no unsafe
features), eight fixed Japanese comments to Korean, warm model, two
measured rounds after an eight-request warmup. A single case translates
the first comment; the eight-request case translates all comments as
independent sequences. Source counts were identical across all five
models: `[22,22,21,17,21,20,20,26]`.

| Model | Single completion mean ms | Eight-request completion mean ms | Single pure decode tok/s | Eight-request pure decode tok/s |
| --- | ---: | ---: | ---: | ---: |
| ONNX q4f16 | 1398 | 2458 | 66.8 | 298.5 |
| GGUF Q4_K_M | 5010 | 6698 | 17.3 | 95.6 |
| GGUF Q4_0 | 3221 | 5115 | 26.1 | 121.4 |
| GGUF Q3_K_M | 3776 | 5815 | 21.4 | 105.7 |
| GGUF Q2_K | 3903 | 5839 | 19.9 | 106.7 |

Completion includes counting, prompt construction, inference and output
validation; it excludes model loading and DOM presentation. Pure decode
counters exclude mixed prefill/decode steps and aggregate all active
sequences. Output length differs by quantization. Models ran in fixed
order and two rounds are insufficient for tail latency or thermal
normalization. ONNX single runs were 1143/1653ms and eight-request runs
2024/2893ms, so these means are not precision claims.

All 20 measured cohorts passed automatic output validation on the
`kernels` backend; all four files imported through the real options UI.
Manual inspection of the first eight-request round found the 14-day
loan term, no abolition of paper books, free Saturday sessions and
non-disclosure of reading history preserved in every variant.
Q2_K nevertheless changed “understood the meaning” to “it was meaningful”
in the first comment and rendered model loading as “모델 로플” in another.
Q4_0 produced the awkward “첫 번째 번”. Automatic validity is therefore
not semantic quality certification; eight short sources cannot establish
general quality rankings.

Evidence: `test-results/browser/gguf-installed/gguf-comparison.json`,
including full source/output text, timings, installed hashes and status.
`gguf-<variant>-options.png` records actual imported-model UI state.
The harness status request was corrected to use the options→background
route before this completed run; no application fallback was introduced.

### Equal-token kernel workload

Separate headed-browser runs used identical synthetic 128-token prompts,
32 generated tokens per sequence, widths 1/8, two repeats, a 64-position
prefill budget and four warmup tokens. EOS stopping was disabled.
Each model ran serially; no extension/tokenizer/translation formatting
was inside these timings. Rates sum phase tokens divided by phase wall
time across the two repeats, not the arithmetic mean of per-run rates.

| Model | Width 1 prefill tok/s | Width 8 prefill tok/s | Width 1 decode tok/s | Width 8 decode tok/s |
| --- | ---: | ---: | ---: | ---: |
| ONNX q4f16 | 980.1 | 790.3 | 135.5 | 443.2 |
| GGUF Q4_K_M | 435.9 | 543.7 | 20.2 | 139.7 |
| GGUF Q4_0 | 701.4 | 797.8 | 39.6 | 209.6 |
| GGUF Q3_K_M | 601.4 | 542.0 | 27.1 | 148.7 |
| GGUF Q2_K | 568.3 | 546.8 | 28.4 | 142.5 |

Width 8 is aggregate throughput, not per-sequence TPS. The first output
token belongs to prefill; pure decode has 31 steps per sequence. The
eight-request scheduler shares a total 64-position prefill budget, not
64 positions per request. Short synthetic runs can differ substantially
from real translation rates above and must not replace completion latency.
Artifacts: `test-results/browser/gguf-kernels-<variant>/kernels-*.json`.

The throughput gap survives identical token counts. For Q4_K_M single
decode, 3059.1 of 3065.8ms across the measured steps was host-observed
GPU submission/queue completion; command encoding took 5.6ms and readback
1.1ms. Thus this workload is not principally limited by tokenizer or UI
rendering. These counters are not GPU timestamp attribution and do not
separate dequantization from matrix multiplication or attention.

Q4_K_M has 1.24× the linear-weight inventory but takes about 6.7× the
ONNX single-decode time in this fixed workload. File size/ideal bandwidth
alone does not explain the gap. [INFERENCE] The new direct packed-block
shader's instruction/load layout and dequantization work are major
optimization candidates; this experiment does not measure their separate
costs. Q2_K being slower than Q4_0 despite fewer bytes is further evidence
that smallest storage is not the same as fastest kernel execution.

**Decision:** keep ONNX q4f16 as the speed-oriented default. GGUF support
is functional and reduces download/resident embedding size, but this
implementation does not yet justify a default switch. Among these GGUF
runs Q4_0 was fastest; Q4_K_M is the publisher's quality-oriented choice.
Do not select Q2_K solely for speed or infer that native llama.cpp has
these same performance characteristics.

The next performance comparison should isolate packed GEMV by format
and the Q6_K vocabulary head, then evaluate block-wise scale reuse and
vectorized unpacking against the same independent numerical references.
Repacking at load time is another tradeoff, but must report expanded
resident bytes and load time rather than disguising them as native GGUF
memory savings. No viewport-completion SLO is claimed by these format tests.

Validation completed: both TypeScript configurations, 152 focused
loader/storage/model-flow/host tests, 49 independent GPU numerical cases,
20 installed-extension cohorts and 20 fixed-token kernel runs.

## Q4_K_M packed-kernel optimization and engine boundary

This follow-up targets `plamo-3-translate-0.8b-Q4_K_M.gguf`, whose
linear matrices use Q4_K and Q6_K. The original source and installed
Chrome build were preserved in `/tmp/autotranslate-q4km-baseline/`
before editing; benchmark reports retain source/installed-file hashes.

### Measured bottleneck and changes

Baseline GPU timestamp profiling at width 8 attributed approximately
92% of pure decode GPU time to linear matrix dispatches. Gate/up took
119.7ms, down 54.6ms and the vocabulary head 58.6ms out of 296.9ms
over seven measured decode steps. In prefill, matrices took approximately
91% of the measured GPU time. These intrusive timestamp runs identify
work categories, not production latency; small dispatches are quantized
to coarse timestamp increments. Width-1 decode shares a compute pass,
so its profile cannot isolate individual matrices.

`src/lib/kernelgguf.ts` now decodes four adjacent Q4_K/Q6_K values
together. Each vector shares packed word loads and its scale/minimum;
GEMV reuses the resulting weight vector across active sequences.
Q6_K's 210-byte block stride is handled with explicit half-word-aligned
loads, rather than expanding or requantizing the weights. GEMM loads
adjacent columns and transposes into bounded scalar workgroup storage
before its existing 4×4 register microtiles consume them. FP16 staging
remains optional; accumulation remains FP32.

`src/lib/kernels.ts` no longer creates ONNX GEMV/GEMM/packing pipelines
or submits an empty ONNX repacking pass for a fully GGUF model.
Only the formats present in the model compile their matrix pipelines.
Packed resident-weight bytes are unchanged: this speedup does not hide
a larger FP16 weight copy or lower precision.

The diagnostic adapter wrapper in `test/engine-spike/run-kernels.mjs`
now forwards device limits when enabling timestamp queries. Without
that forwarding, the profiling-only wrapper incorrectly requested the
baseline 128MiB binding limit and rejected the Q6_K output matrix.

### Paired equal-token measurements

M5, Chrome 143.0.7499.4, ordinary WebGPU; identical 128-token prompts,
32 output tokens/sequence, widths 1/8, three repeats, 64-position prefill
budget. Baseline/candidate order reversed on alternate repeats. Rates
are total phase tokens divided by total phase wall time. No profiling
timestamps were enabled in these throughput measurements.

| Phase / concurrency | Before tok/s | After tok/s | Throughput multiplier |
| --- | ---: | ---: | ---: |
| Prefill / 1 | 381.4 | 548.2 | 1.44 |
| Prefill / 8 | 424.2 | 688.7 | 1.62 |
| Decode / 1 | 17.1 | 46.2 | 2.70 |
| Decode / 8 | 112.7 | 268.1 | 2.38 |

Eight-request TPS aggregates all sequences. This is a new paired run,
not a ratio against the preceding section's separate historical runs.
Artifact: `test-results/browser/q4km-vector-ab/kernels-*.json`.

All six paired comparisons produced identical 32-token sequences.
Final full-vocabulary logits were also compared for every active row:
maximum absolute difference 0.0000811, maximum relative L2 difference
0.00000101. The independent `gguf-py` numerical harness passed all 49
cases, including both staging modes and tail tiles. GPU/page validation
errors were empty. Floating-point association changed, so this is not
a promise of bitwise equality for every future prompt.

### Separation decision

Keep **format-specific loading, weight representation and matrix kernels**,
but **one PLaMo execution engine**:

```mermaid
flowchart TD
    O[ONNX graph and sidecars] --> OP[ONNX loader]
    G[GGUF tensors and embedded tokenizer] --> GP[GGUF loader]
    OP --> E[Shared PLaMo scheduler and KV cache]
    GP --> E
    E --> A[Shared Attention, RoPE, norms and sampling]
    E --> OM[ONNX Q4 packing and GEMV/GEMM]
    E --> GM[GGML format-specific GEMV/GEMM]
    O -. ONNX-only fallback .-> ORT[ONNX Runtime]
```

The existing per-matrix `ggmlType` dispatch is the correct boundary:
Q4_K_M itself mixes quantization formats, so a single model-wide “4-bit”
kernel is incorrect. GGUF does not need a second cancellation mechanism,
continuous-batching scheduler, attention implementation or translation
cache. Forking those would duplicate correctness and performance work
without removing the measured matrix bottleneck. The shared weight
contract still resides in `onnxweights.ts` for historical reasons; GGUF
is not converted to ONNX or executed through ONNX Runtime.

A separate executor would be warranted by a different model architecture
or runtime API, not by the container extension alone. Explicit matrix
specialization remains necessary even with a shared engine.

### Installed extension completion and remaining gap

Both preserved baseline and candidate were installed in headed Chrome
and exercised through the actual options GGUF file import. Each build
ran an ONNX control followed by Q4_K_M, an eight-request warmup, and
three measured single/eight-request rounds on the same Japanese→Korean
sources. This is warm request-to-final-translation completion, not
scroll-stop-to-final-DOM-paint. Eight-way engine capacity does not change
the application's two-generation production concurrency setting.

| Model / build | Single completion mean ms | Eight-request completion mean ms |
| --- | ---: | ---: |
| ONNX q4f16 / before | 748 | 1822 |
| ONNX q4f16 / after | 724 | 1718 |
| GGUF Q4_K_M / before | 5145 | 6993 |
| GGUF Q4_K_M / after | 1604 | 3064 |

Q4_K_M completion time fell by 68.8% for one comment and 56.2% for
eight comments. All 24 measured cohorts passed automatic validation.
All 54 before/after output pairs, including 27 Q4_K_M pairs, were
exactly unchanged. The model, tokenizer and prompt were unchanged.
Reports and UI screenshots:
`test-results/browser/q4km-installed-{before,after}/`.

The candidate's Q4_K_M single runs ranged from 1345 to 1900ms and its
eight-request runs from 2335 to 3473ms. The installed-build comparison
was blocked rather than interleaved; the paired kernel experiment above
is the stronger control for shader effects. Three rounds do not estimate
p95 or eliminate device clock/thermal effects.

ONNX remains faster: in the candidate build Q4_K_M took 2.22× its
single completion time and 1.78× its eight-request completion time.
The default model is therefore unchanged. Neither “instant completion”
nor the earlier single-decode/prefill targets are claimed achieved.

The post-change timestamp profile still attributes approximately 80%
of eight-way decode GPU time and 84% of prefill GPU time to matrices.
Gate/up, down and vocabulary-head operations remain the priorities;
there is no evidence here that forking the shared scheduler would
resolve that remaining gap. The post-change intrusive prefill timestamp
total was actually higher than in its separate baseline profiling run;
do not use those standalone profile totals as a speedup estimate.
Use the interleaved, unprofiled TPS and installed completion runs above.
Attribution artifacts: `test-results/browser/q4km-profile-{before,after}/`.

Both TypeScript configurations passed. Chrome and Firefox packages
were rebuilt and passed the packaging gate; live runtime verification
was Chrome only. No native runtime, experimental WebGPU feature,
new quantization policy or model-quality tradeoff was introduced.

### Lossless GGUF repacking: parity acceptance and layout evidence

The parity experiment preserves the current direct shaders and Chrome build
in `/tmp/autotranslate-gguf-parity-baseline/`; it does not reuse the older
Q4_K_M baseline. Model/kernel hashes, all 57 installed-file hashes, adapter
features and the 65-matrix inventory are recorded in
`test-results/browser/gguf-parity-baseline/`.
Chrome 143.0.7499.4 exposes ordinary WebGPU, shader-f16 and subgroups on
the Apple metal-3 adapter; no unsafe WebGPU flag is enabled.

Acceptance requires both one/eight-request installed completion medians
at or below contemporary ONNX q4f16, and prefill/decode TPS at or above
ONNX for every L128/512 × B1/8 shape. Same-GGUF numerical correctness
and resident/peak weight bytes at most 1.35× the original are independent
gates. Historical completion averages are not acceptance thresholds.

| Layout | Original matrix bytes | Resident matrix bytes | Serial-repack peak bytes |
| --- | ---: | ---: | ---: |
| f32 coefficients | 477204480 | 611057664 | 618799104 |
| compact coefficients | 477204480 | 486432768 | 494174208 |

These are calculated live-buffer sizes, not allocator measurements.
Quant codes remain unchanged; compact coefficients preserve original
FP16 roots and integer scale/minimum bits, while f32 coefficients store
their exact products. Neither layout expands whole weights to FP16 or
requantizes them.

Independent gguf-py 0.19.0 fixtures cover Q4_K/Q6_K with N9/17 and
K256/512. All 16 GPU repack/readback cases have zero decoded-weight
absolute error and zero padding; code words and coefficient words match
the independent reference exactly. The seven existing GGML formats also
pass all 49 direct CPU/GPU checks. Evidence:
`test-results/browser/gguf-parity-layout/numerics.json`.
This verifies the layout only, not end-to-end parity or throughput.

The matrix gate subsequently passed 1,264 repacked GEMV/GEMM cases,
including all eight GEMV widths, output groups of 8/16, both coefficient
representations, factorization on/off, and GEMM rows 9/32/33/64/65.
Maximum scaled error was 0.00000103711 (limit 0.0001); all four f32-wide
requests were rejected. FP16 staging drift is recorded separately.
Evidence: `test-results/browser/gguf-parity-numerics/numerics.json`.

Nine real-device lifecycle cases cover forced ineligible/ONNX rejection,
forced budget rejection, automatic direct selection for the smaller
budget fixture, insufficient binding limits, allocation failure after
head repack, and successful f32/compact/direct disposal. All end with
zero owned live buffers and zero open error scopes. Observed resident
and peak matrix bytes equal the table above; repacked creation retains
no source matrix buffers. This observation wraps device operations,
not GPUBuffer objects. Evidence:
`test-results/browser/gguf-parity-lifecycle/kernels-2026-11-14T09-08-53.860Z-c973ba60.json`.

Both TypeScript configurations passed. The first integrated L128 B1/8
32-step comparison passed exact generated-token and full-vocabulary
logit gates with no GPU/page errors:
`test-results/browser/gguf-parity-integration/`.
These checks do not yet establish the ONNX performance acceptance gate.

### Finite repack screening and installed control

All 16 configurations passed L128, B1/8, 32 steps, three alternating
direct/repacked repetitions (192 timed runs). Each passed generated-token
and full-vocabulary-logit checks and both memory gates; no phase was
more than 5% slower than direct. Scores are geometric means of four
paired prefill/decode TPS ratios, not ratios to ONNX:

| Coefficients / outputs / factor / wide | Geometric TPS ratio to direct |
| --- | ---: |
| f32 / 8 / true / true | 1.5965 |
| f32 / 8 / true / false | 1.6539 |
| f32 / 8 / false / true | 1.7089 |
| f32 / 8 / false / false | 1.6291 |
| f32 / 16 / true / true | 1.6687 |
| f32 / 16 / true / false | 1.4486 |
| f32 / 16 / false / true | 1.6445 |
| f32 / 16 / false / false | 1.5355 |
| compact / 8 / true / true | 1.7440 |
| compact / 8 / true / false | 1.6808 |
| compact / 8 / false / true | 1.8325 |
| compact / 8 / false / false | 1.9114 |
| compact / 16 / true / true | 1.7144 |
| compact / 16 / true / false | 1.7486 |
| compact / 16 / false / true | 1.6740 |
| compact / 16 / false / false | 1.8027 |

The final two candidates are compact coefficients, eight outputs,
factorization off, with wide rows off/on. The score gap exceeds the
1% tie threshold. The ranking and all raw reports are in
`test-results/browser/gguf-parity-screen/`. Device timing varied during
screening; comparisons use adjacent controls with alternating order,
not the earlier standalone direct baseline.

The updated installed harness was exercised against the preserved build:
five rounds, ten model transitions/warmups and twenty valid measured
cohorts, with no errors. Both models reported kernels backend and source
counts `[22,22,21,17,21,20,20,26]`. Actual GGUF import screenshot was opened.
The direct GGUF single/eight completion medians were 1928.7/3724.7ms;
its contemporary ONNX medians were 915.6/2066.4ms. This is the regression
control, not the final candidate comparison.
Evidence: `test-results/browser/gguf-parity-installed-baseline/`.

Both finalists completed the full L128/512 × B1/8, 64-step, five-repeat
same-model comparison: 40 runs and 20 direct/repacked comparisons each,
zero token mismatches and zero GPU/page errors. Minimum full-vocabulary
logit cosine was 0.9999999999995884 and maximum relative L2 was
0.000000726367 for each candidate.

The first heterogeneous runs exposed an overly broad new harness failure
predicate: it failed on batch/individual scheduling differences as well
as variant differences. Direct/repacked results matched under each
schedule. In both direct and repacked execution, request 7 differed
between batching and individual execution from token index 6, with 41
differing tokens. The scheduler and arithmetic policy were not changed
to hide this existing schedule sensitivity. The harness now fails the
approved same-schedule variant comparison and retains scheduling
comparisons separately. Initial nonzero-exit artifacts remain in each
candidate's `heterogeneous/` directory.

Final fixed-token ONNX/GGUF comparisons use five alternating process pairs,
with phase TPS computed from total phase tokens divided by total phase
wall time, not an average of individual rates. Both candidates miss the
all-eight-metrics ONNX throughput gate. Raw samples, means, medians,
ranges and failure counts are preserved in
`test-results/browser/gguf-parity-final/evaluation.json`.

### Final parity verdict: ONNX 동급 미달

The selected fixed default is
`{coefficients:'compact', outputsPerGroup:8, factorSmallBatch:false, wideRows:false}`.
Both finalists satisfy same-model accuracy and memory limits and improve
both installed completion medians over the preserved direct build, but
neither satisfies ONNX parity. Their installed ONNX-relative latency
geometric means are 1.111427 (wide off) and 1.116749 (wide on). They are
within the 1% tie band with equal memory/output/factor settings, so the
specified final tie-break chooses wide off. Overrides remain diagnostic;
there is no runtime tuner.

Five installed rounds per build, Japanese→Korean, request-to-final-output:

| Build / model | Single median ms | Eight-request median ms | Single range ms | Eight-request range ms |
| --- | ---: | ---: | --- | --- |
| Preserved direct / GGUF | 1928.7 | 3724.7 | 1673.9–2779.2 | 3359.5–3853.7 |
| Selected wide-off / ONNX control | 686.2 | 1448.1 | 529.8–787.9 | 1269.1–1495.6 |
| Selected wide-off / GGUF | 763.4 | 1607.9 | 636.8–872.4 | 1235.5–1733.6 |
| Wide-on / ONNX control | 641.0 | 1364.5 | 608.4–658.5 | 1345.8–1366.5 |
| Wide-on / GGUF | 765.9 | 1424.2 | 749.0–788.2 | 1416.4–1451.7 |

The selected candidate is still 11.25% slower for one request and 11.04%
slower for eight than its own contemporary ONNX control. Its medians
are 60.42%/56.83% below the preserved direct build, but those builds were
measured in separate sessions with different timing conditions; the
interleaved same-model kernel results are the stronger shader comparison.
Neither the faster absolute wide-on batch result nor averaging cases
is allowed to replace the prescribed ONNX-relative selection/gates.

Selected candidate fixed-token throughput, five alternating ONNX/GGUF
process pairs; eight-way TPS is aggregate:

| Prompt length | Batch | Phase | ONNX TPS | GGUF TPS | GGUF / ONNX | Gate |
| ---: | ---: | --- | ---: | ---: | ---: | --- |
| 128 | 1 | prefill | 1114.79 | 1108.42 | 0.99428 | fail |
| 128 | 1 | decode | 161.98 | 130.73 | 0.80706 | fail |
| 128 | 8 | prefill | 828.45 | 803.89 | 0.97036 | fail |
| 128 | 8 | decode | 449.44 | 463.86 | 1.03208 | pass |
| 512 | 1 | prefill | 771.20 | 719.79 | 0.93334 | fail |
| 512 | 1 | decode | 128.65 | 103.96 | 0.80811 | fail |
| 512 | 8 | prefill | 881.66 | 868.54 | 0.98512 | fail |
| 512 | 8 | decode | 494.54 | 545.61 | 1.10325 | pass |

Six of eight metrics miss the selected candidate's gate; wide on misses
five of eight. All 80 contemporary throughput runs completed without
GPU/page errors. The corrected heterogeneous runs also pass both finalists'
direct/repacked comparisons with every requested outcome present; the four
schedule comparisons per candidate described above remain visibly unequal.
Each installed build has 20 valid measured cohorts and ten valid warmups,
both models use kernels backend, and counts agree. All 85 GGUF output
pairs per candidate (measured plus warmup) exactly match the preserved
direct build. All three actual GGUF import screenshots were opened.

Observed selected matrix memory is 486432768 resident / 494174208 peak
bytes versus 477204480 original: +1.93% / +3.56%, both below 35%.
No GPU source matrix copy remains. These are sums of observed live buffer
sizes, not driver allocator measurements. Across twenty cold creates,
create wall time has mean/median/range 212.27/171.50/153.80–349.70ms;
repack wall time has 153.62/133.60/118.40–225.80ms. Cold creation and
repacking are excluded from warm phase TPS.

Separate timestamp attribution still assigns 87.02% of selected prefill
and 81.16% of selected eight-way decode GPU pass time to matrices.
Gate/up (12288×1536) and down (1536×6144) dominate prefill; decode also
pays heavily for the 107520×1536 vocabulary head. Quant/scales read by
one ONNX matrix pass total 385204224 bytes, versus 486432768 for compact
GGUF; the Q6_K head is 136765440 versus ONNX's 87736320 bytes.
[INFERENCE] This larger lossless representation is consistent with
remaining bandwidth pressure; it is not proof of a hardware lower bound.
Profile totals are not used as throughput speedup measurements.

The first attribution attempts exhausted Metal timestamp sample buffers:
the diagnostic wrapper retained one 1024-query set for each of 65 serial
repacks. Initialization correctly failed through its error scope rather
than returning success. The profiler now drains initialization timestamps
at each completed submission and recognizes repacked matrix shaders.
Both bounded attribution runs pass; original failed diagnostic artifacts
are retained in `profile/`, successful evidence in `profile-bounded/`.

Final artifact index: `test-results/browser/gguf-parity-verdict.json`.
It contains both candidates' complete phase statistics, completion
means/medians/ranges, cold times, memory, failure records and all output
pairs. Raw installed reports are in
`test-results/browser/gguf-parity-installed-{baseline,compact-o8-f0-w0,compact-o8-f0-w1}/`;
raw fixed-token/heterogeneous/profile reports are in
`test-results/browser/gguf-parity-final/`.
The selected Chrome build/package was rebuilt, and all recorded runtime
file hashes match the measured selected installation. Both TypeScript
configurations passed. No scheduler, KV, attention, page concurrency,
default download model, quantization policy or runtime dependency changed.

### Upstream llama.cpp WebGPU comparison: whole-runtime cutover rejected

An isolated browser experiment used `@wllama/wllama@3.13.0`
(`6647c1ea3837b2f0205a300c3bf5ff644aaa06bf`), whose bundled llama.cpp is
`b12211-7d7f028`, on the same Apple/metal-3 adapter and Chrome
`143.0.7499.4`, without unsafe WebGPU flags. No production runtime,
dependency, scheduler, model or numerical policy was changed.

The exact 573126848-byte Q4_K_M file is recognized as `plamo3`.
Native logs confirm 17/17 layers offloaded to WebGPU; the embedding
remains on CPU. However, the stock subgroup path does not compile in this
Chrome: `num_subgroups` is unsupported, and an attempted derivation also
encounters the unavailable `subgroup_id` language feature and subgroup
uniformity validation. No validation diagnostic was disabled.

The measured path explicitly selects upstream's existing **workgroup
reduction** by hiding `subgroups` from the worker adapter's feature set.
It still executes on WebGPU; shader text and quantized weights are unchanged.
This is not a measurement of newer Chrome's stock subgroup path or native
Metal. The pinned MMVQ eligibility code excludes Apple, so its Q8 activation
quantization fast path is not selected.

Wllama's current C++ CLI bridge assigns `prompt` to `std::string`.
An integer-token-array request fails, despite upstream llama-server having
a token-array endpoint. Therefore the comparison uses separate text-derived
fixtures, not the original arithmetic-token parity workload. Each fixture
has 128/512 tokens including BOS using the GGUF vocabulary/scores; upstream
reports the same prompt lengths and zero cached prompt tokens. This is raw
completion text, not the installed Japanese→Korean chat-template workload.

Two process pairs alternate current→upstream and upstream→current. Each
shape has an excluded four-output warmup, then 64 outputs per request.
The table is total cohort wall time, not pure prefill/decode TPS:

| Prompt tokens | Concurrent requests | Current GGUF median ms | Upstream portable median ms | Upstream / current |
| ---: | ---: | ---: | ---: | ---: |
| 128 | 1 | 766.90 | 1937.36 | 2.53 |
| 128 | 8 | 2340.05 | 13963.53 | 5.97 |
| 512 | 1 | 1396.65 | 3326.58 | 2.38 |
| 512 | 8 | 6004.80 | 29740.39 | 4.95 |

All timed workloads complete, but **none of 36 generated-token pairs
match**. This is not an isolated kernel-accuracy test: native input token
IDs are not exposed by this wrapper, EOG sampling policy differs, and
runtime arithmetic differs. At L128/B1 the current first output is 1637,
whereas upstream GPU and a separate CPU diagnostic both start with 8676;
neither is an EOG token. CPU/GPU then diverge at output index four.
The difference is not attributable solely to WebGPU, and its root cause
is not isolated. No full-vocabulary logits or translation-quality gate
is claimed.

The main comparison retains native diagnostic logging and upstream's
default unified KV context ceiling of 16384 per sequence. A separate
L128/B1 check sets `kv_unified=false` (2048 per slot), disables idle-slot
caching and suppresses native logging. It takes 1737.85ms for 64 outputs
and retains the divergent GPU prefix. This multi-setting check is not a
single-factor attribution or a replacement for the full timing matrix.
CPU-only execution is excluded from every WebGPU performance figure.

Diagnostic buffer reports are GPU model 455.49MiB, CPU model 88.59MiB,
GPU KV 256MiB, GPU compute 597.51MiB and CPU compute 77.02MiB. These are
rounded backend buffer sizes, not peak allocator measurements; the
original complete 35% peak-weight gate has not been established here.
The initial URL/cache loading path also returned a failed load context;
fetching the complete Blob and checking `context.success` avoids treating
that failure as a successful initialization.

Decision: retain the existing runtime. This build provides neither a
drop-in browser-compatible path nor an output-equivalent performance win
on the tested environment. Individual upstream kernels remain useful
references; these whole-runtime results do not rule out a profitable
kernel-level port. No installed-extension replacement was attempted.
The earlier **ONNX 동급 미달** verdict remains unchanged.

Evidence is under `test-results/browser/gguf-upstream-webgpu/`:
`verdict.json`, `comparison.json`, `cpu-gpu-prefix.json`, `prompts.json`,
the paired raw reports, failure diagnostics, browser screenshots and
`experiment-sources.tar.gz`. The successful browser screenshot was opened.
Pinned implementation references:
[wllama completion bridge](https://github.com/ngxson/wllama/blob/6647c1ea3837b2f0205a300c3bf5ff644aaa06bf/cpp/wllama-context.h),
[WebGPU dispatch](https://github.com/ggml-org/llama.cpp/blob/7d7f0287530bc8981690f361d8c1627dbae1c99a/ggml/src/ggml-webgpu/ggml-webgpu.cpp),
[shader selection](https://github.com/ggml-org/llama.cpp/blob/7d7f0287530bc8981690f361d8c1627dbae1c99a/ggml/src/ggml-webgpu/ggml-webgpu-shader-lib.hpp).

### Quantitative attribution of the upstream WebGPU deficit

This investigation measures the pinned wllama/llama.cpp portable
workgroup-reduction path above, not native llama.cpp or a newer browser's
subgroup path. Production runtime code is unchanged.

#### Uninstrumented phase gap: 64 generated tokens

The two existing alternating-order pairs give the following B=1 averages.
The gap is upstream minus the current custom GGUF engine.

| Input tokens | Total wall gap ms | Prefill gap ms | Decode gap ms | Decode share of wall gap |
| --- | ---: | ---: | ---: | ---: |
| 128 | 1,170.46 | 294.23 | 875.32 | 74.8% |
| 512 | 1,929.93 | 846.85 | 1,079.99 | 56.0% |

Upstream wall time outside its native prefill/decode timers is only
3.00/5.29 ms, respectively. This excludes substantial outer JS/message
overhead, **not** CPU/WASM scheduling and synchronization inside those
timers. Per-request native timings overlap at B=8 and cannot be summed into
cohort phase costs.

Upstream aggregate throughput scales only 1.110x from B=1 to B=8 at input
128, and 0.895x at input 512: the latter is a 10.5% throughput loss.
The current engine scales 2.622x and 1.861x, respectively.

#### Separate GPU attribution: input 128, 16 generated tokens

Each shape has one timestamp-instrumented cohort and one uninstrumented
control, after a four-token warmup. Native logging is suppressed in both;
unified KV and the previous load settings remain unchanged. Instrumentation
splits upstream's combined compute pass into one pass per dispatch and
requests the supported `timestamp-query` feature. Timestamp readback is
drained after the measured wall interval. This is intrusive attribution,
not another comparable 64-token throughput benchmark.

| Measurement | B=1 | B=8 |
| --- | ---: | ---: |
| Profiled wall ms | 620.88 | 3,664.54 |
| Control wall ms | 565.68 | 3,914.73 |
| GPU dispatch time ms | 495.65 | 3,411.41 |
| GPU dispatch / profiled wall | 79.8% | 93.1% |
| Dispatch count | 6,040 | 6,410 |
| Wall minus GPU dispatch ms | 125.23 | 253.13 |

Profile/control token sequences match for all nine requests; profiler errors
are empty. Profile/control wall differences (+9.8%/-6.4%) combine
instrumentation effects and run variation; they are not optimization gains.

| GPU operation group | B=1 ms | B=1 GPU share | B=8 ms | B=8 GPU share |
| --- | ---: | ---: | ---: | ---: |
| Quantized Q4_K/Q6_K weight matmul | 397.41 | 80.2% | 2,782.92 | 81.6% |
| Float matmul and softmax | 51.84 | 10.5% | 419.17 | 12.3% |
| RMS normalization | 24.51 | 4.9% | 125.11 | 3.7% |
| Other dispatches | 21.89 | 4.4% | 84.21 | 2.5% |

Within quantized weights, FFN gate/up plus down projections consume
56.3%/59.1% of **all** GPU dispatch time at B=1/B=8; the output head consumes
8.2%/7.2%. Roles are attributed from the model's matrix dimensions, with
full pipeline/shape aggregates retained.

Dispatch count grows only 1.061x at B=8, but GPU time grows 6.883x;
quantized matmul accounts for 81.8% of that GPU-time increase. The pinned
[dispatch selector](https://github.com/ggml-org/llama.cpp/blob/7d7f0287530bc8981690f361d8c1627dbae1c99a/ggml/src/ggml-webgpu/ggml-webgpu.cpp#L1684)
uses matrix-vector kernels only through four rows; wider inputs select
matrix-matrix kernels. Profiles confirm workgroup GEMV for width-one
decode and `mul_mat_reg_tile_*` for width-eight decode. The Q6_K output
head (`m=107520,k=1536`) averages 2.540 ms per width-one call and
15.200 ms per width-eight call (16 and 15 calls). Eight outputs require
5.99x the per-call time, providing only about 1.34x head throughput.
This demonstrates weak amortization, not proof that a threshold change
alone would help; an alternative kernel has not been benchmarked.

#### Host waits are not additive CPU costs

`queue.onSubmittedWorkDone` reports 532.98/3,488.13 ms of waiting across
367/1,077 calls at B=1/B=8. Those waits include GPU execution and must
**not** be added to timestamp durations. Likewise, readback mapping waits
(9.93/56.98 ms) include pending GPU work.

The residual 125.23/253.13 ms is a mixture of CPU work, buffer copies, GPU
gaps, synchronization and profiler overhead, not exclusive CPU/WASM time.
Gaps within the first-to-last GPU dispatch span alone are
102.04/194.05 ms. B=8 records 92,381 buffer-copy commands totaling
80.61 MiB versus 1,822 commands/8.26 MiB at B=1; the cost of those copies
is not separately timestamped. Their source and optimization value remain
unisolated. Measured JS `writeBuffer` call time is only 2.30/2.66 ms and
queue-submit call time 1.00/0.82 ms; neither includes all host work.

**Priority [INFERENCE]:** first investigate Q4_K FFN kernels and the
width-5–8 GEMV/GEMM boundary, including the Q6_K output head; then float
matmul/softmax. Wrapper micro-optimization cannot explain the dominant
measured GPU time. Copy/synchronization improvements may matter, but
their exclusive contribution is not established here. No speedup is
claimed and no dispatch threshold was changed.

Limitations: one profiled/control pair per shape, input 128 only for GPU
attribution, intrusive pass splitting, and a subgroup-disabled compatibility
path on Chrome 143/Apple GPU. The previously observed upstream/current
numerical mismatch remains unresolved; matching profile/control tokens
does not establish cross-engine correctness.

Evidence: `test-results/browser/gguf-upstream-bottleneck/` contains
`existing-phase-gaps.json`, raw `profile/upstream.json` and
`control/upstream.json`, `gpu-attribution.json`, grouped `analysis.json`,
browser captures, and archived instrumentation in
`experiment-sources.tar.gz`.

### Rebuilt upstream optimization baseline: numerical stop gate

The approved isolated optimization experiment is recorded in
`test-results/browser/gguf-upstream-fix-g1fpWe/decision.json`.
The unchanged wllama `6647c1ea3837b2f0205a300c3bf5ff644aaa06bf` /
llama.cpp `7d7f0287530bc8981690f361d8c1627dbae1c99a` baseline was rebuilt
with Emscripten 4.0.20, Dawn `v20260317.182325`, WebGPU/JSPI, and
`WLLAMA_TEST_BACKEND=ON`, including generated worker, ESM, and WASM.
Chrome 143.0.7499.4 used the Apple/Metal-3 portable workgroup path;
native logs confirmed 17/17 GPU-offloaded layers.

**Outcome: baseline numerical gate failed; candidate adoption stopped.**
No `v256`, `v128`, `r32x8`, `r64x8`, or `r64x32` source patch was made.
No combined candidate, screening, final performance gate, or winner
attribution was run. This is not evidence that the untested candidates
regress or improve performance. Production runtime and the ONNX parity
plan remain unchanged.

Captured original GPU pipelines executed eight independently decoded
GGUF fixtures over N=1..9,32,33,64,65, with exact-width GEMV pipelines
where applicable. GEMM replay also exercised small/tail dimensions;
it does not imply those dimensions select GEMM in the model host.
The required normalized per-output tolerance remained `1e-4`.

| Captured path | Cases | Failed | Maximum normalized error |
| --- | ---: | ---: | ---: |
| Q4_K GEMV | 16 | 0 | 5.36365e-7 |
| Q6_K GEMV | 16 | 0 | 1.11348e-7 |
| Q4_K GEMM, 32×32 / 64 threads | 52 | 52 | 1.77285e-3 |
| Q6_K GEMM, 32×32 / 64 threads | 52 | 52 | 5.75710e-4 |

All outputs were finite and all trailing guard words remained intact.
Capture omissions, shader/validation errors, page/worker errors, and
device-loss errors were zero. The 19 model cohorts captured 10,807
dispatches; repeated baseline quantized shape/stride keys had no
geometry/WGSL-hash conflicts. Candidate cache behavior is untested.

The approved GEMM oracle rounds independently decoded weights and inputs
through `Float16Array` once, then uses a JS double dot product.
The pinned `mul_mat_decls.tmpl:458-495,564-597` also performs
**intermediate f16 dequantization arithmetic** before shared staging.
**[INFERENCE]** That distinction plausibly explains the oracle mismatch;
it is not an isolated causal proof or a newly introduced kernel defect.
The oracle and tolerance were not changed to make the baseline pass.

The separate, unmodified CPU-reference backend test passed 185 actual
WebGPU MUL_MAT cases, with 36 unsupported cases retained, including
captured N5..9 boundaries and noncontiguous/broadcast uniform layouts.
Its `test_mul_mat` NMSE threshold `5e-4` is not the independent
per-output criterion above, so this pass does not override the stop gate.
A baseline-versus-itself L128/B1/output4, two-round AB/BA smoke verified
the paired runner and exact token matching; it is not performance evidence.

Evidence includes raw numerical/backend reports, original WGSL and
descriptor/hash captures, browser screenshots, full ESM/WASM hashes,
`baseline-esm.tar.gz`, independent `reference.json`, build logs, and
`experiment-sources.tar.gz`. Native INFO is captured without console
forwarding to retain offload evidence; this logging adjustment is explicit
in each report. WebGPU create/destroy byte accounting and native memory
logs are retained, but no resident/allocator peak, candidate memory
comparison, or 35% whole-peak gate is claimed.

### Current custom GGUF single-decode optimization experiment

Evidence: `test-results/browser/gguf-single-decode-vtpS5R/decision.json`.
This targets the production custom WebGPU kernels, not the upstream wllama
baseline above. **No candidate was adopted; the measured bottleneck remains.**
Production runtime, weight precision, and batch 2–8 behavior are unchanged.

Chrome 143.0.7499.4 on Apple/Metal-3 ran without unsafe WebGPU flags.
Combined-pass baseline timestamps put GPU execution at 88–89% of GGUF
single-decode wall time. Separate per-dispatch instrumentation attributed
78.1–78.3% of GPU time to quantized matrix kernels. JS encoding was only
1.4–2.1% of wall time in these split-pass GGUF runs; queue waits are not
exclusive CPU work.

The following GPU measurements sum 15 decode steps. Splitting compute passes
and timestamp quantization perturb execution: these identify expensive
operators, not production end-to-end latency or precise hardware limits.

| Input length | ONNX matrix GPU ms | GGUF matrix GPU ms | ONNX head GPU ms | GGUF Q6_K head GPU ms |
| --- | ---: | ---: | ---: | ---: |
| 128 | 69.34 | 83.30 | 12.85 | 25.03 |
| 512 | 58.65 | 87.03 | 11.40 | 21.50 |

The Q6_K vocabulary head is 1.89–1.95× slower in this attribution run.
Resident matrix buffers total 486,432,768 bytes for GGUF versus 385,204,224
for ONNX; the head alone is 136,765,440 versus 87,736,320 bytes.
The larger representation matters, but these observations do not isolate
memory bandwidth from dequantization, occupancy, or reduction costs.

Five isolated candidates changed only single-row GEMV or its dispatch.
Unprofiled screens used B1, input lengths 128/512, prefill tiles of 64,
64 output tokens (63 timed decode steps), and alternating variant order.
The first two candidates had three repeats; the others had five.
Each percentage compares that candidate's median decode wall time against
its own run's baseline. Negative is faster. Between-run variation is large;
these are descriptive screens, not statistical significance claims.

| Candidate | L128 latency change | L512 latency change |
| --- | ---: | ---: |
| One scalar output per reduction thread | +8.52% | −3.27% |
| 32 K lanes plus scalar reduction | +1.56% | −13.93% |
| Q6-only scale factorization | +6.57% | −2.17% |
| Q6-only 16 outputs/workgroup | +1.42% | +9.86% |
| Two-stage 4×4 reduction | +0.53% | +18.83% |

No candidate improved both lengths consistently. The 32-lane candidate's
separate split-pass attribution also failed to reproduce a consistent gain.
Adopting a context-dependent switch from these noisy screens would overfit
the experiment; no such switch was added.

All screened candidates matched every generated token. Final full-vocabulary
logit comparisons had maximum relative L2 error 1.325e-6; browser validation,
page, and cleanup errors were zero. The 32-lane candidate additionally passed
the independent gguf-py fixture suite: 49 direct cases, 16 repack cases, and
1,264 repacked matmul cases, with output guards intact and maximum normalized
error 1.038e-6 against the unchanged 1e-4 tolerance. This independent suite was
not repeated for every rejected candidate. No installed-extension translation
speedup, general batch performance improvement, or bottleneck removal is claimed.

Raw runs, source hashes, the numerical report, and archived experimental
sources are retained beside `decision.json`; no candidate code is installed.

### Fixed-model near-instant page translation plan

The current extension-only speed plan is
[PLaMo 0.8B near-instant page translation](near-instant-translation-plan.md).
It fixes the input models to GGUF Q4_K_M and the existing ONNX q4f16,
distinguishes existing optimizations from new candidates, and covers loading,
exact reuse, admission, finite-page completion, presentation, and GPU execution.
Its latency targets are proposed goals, not observed improvements. Production
runtime is unchanged by that planning work.

### Whole-page completion: fixed q4f16 / Q4_K_M

The user goal is now **complete eligible page translation within five
seconds**, not a viewport preview. Evidence directory:
`test-results/browser/page5-S35gTt/`. The unchanged pre-edit Chrome build is
compared with a frozen candidate; both use the same complete fixtures.

Environment: Apple M5, 24 GiB, headed Chrome for Testing 143.0.7499.4,
ordinary WebGPU (`UNSAFE_WEBGPU=0`), one resident model worker. The benchmark
uses real extension import/options/tab controls and actual model inference.
No native helper or inference service was added. Local HTTP servers serve
only test pages/model installation assets; translation remains in-extension.
GGUF is Q4_K_M only; ONNX is the existing q4f16 graph. Model, tokenizer and
template hashes are retained in `model-hashes.sha256`.

| Fixed page | Units | Source characters | Source tokens |
| --- | ---: | ---: | ---: |
| Japanese short comments | 8 | 492 | 169 |
| Japanese article | 4 | 1030 | 377 |
| English mixed prose | 4 | 2322 | 342 |

All pages contain below-fold source and remain at scrollY=0. Timing begins
at the enable control's click and ends after every target has a final
canonical translation plus two animation-frame opportunities. Screenshots
are taken after timing. Protected text must remain unchanged; OFF must
restore every original string and original Text-node identity. This is not
compositor telemetry or a semantic-quality oracle. Source/full output,
failures, host call intervals, active-generation admission and file hashes
are retained. No truncated input/output is counted as a speed improvement.

Warm comparisons use a distinct warmup sentence and fresh page-local
translation caches. The baseline selects its previous maximum of two slots;
the candidate selects eight. This measures the product configuration and
scheduling change together, not a faster single-decode kernel. Cold runs
explicitly unload before the measured click, from already installed files;
they do not include downloading or an OS-cache-cold first installation.

Implementation: exhaustive eligible-page drain, extension-wide bounded
generation admission with per-tab FIFO/round-robin fairness, independent-unit
commits, exact in-flight request sharing, bounded tokenization memoization,
overlapped tokenizer/worker initialization, and removal of identical
deterministic retries. Existing saved widths 1/2 remain unchanged; users with
those settings must select 8 to use the measured configuration.

An initial fast candidate is **rejected**, not adoption evidence:
`candidate-screen/` changed the English technical paragraph's “hide a slow
or unreliable reading experience” to “prevent” it. `paired/` was cancelled.
`candidate-preserved/` restored all baseline output strings but still
serialized 480-character continuation waves: English took 5.60/6.14 seconds
for ONNX/GGUF in that single screen. The final candidate removes duplicate
DOM character/sentence planning and keeps the existing exact 64-source-token
host plan. No weight, activation/KV precision, output cap, shader, or worker
compute implementation changed.

In `candidate-token-plan/`, only the long English comment differs from the
baseline. Manual comparison retains the minute/twelve-second figures,
restart/initial-load distinction and final question; the rejected technical
meaning inversion is absent. Baseline model errors remain, including
“previous video” mistranslation and GGUF's rendering of “obsolete”.
Nonempty Korean is insufficient evidence of accuracy, and this review does
not certify arbitrary-page translation quality.

#### Warm paired result

Five alternating A/B pairs, separate browser profiles, GPU jobs serialized.
All 30 candidate page runs and 30 baseline runs completed and restored
correctly, with no recorded host/page errors. The candidate was faster in
**5/5 pairs for every case**, reducing completion medians by 45.7–61.6%.
No p95 or statistical-significance claim is made from five observations.

| Model | Page | Baseline median ms | Candidate median ms | Candidate range ms | ≤5s runs |
| --- | --- | ---: | ---: | ---: | ---: |
| ONNX q4f16 | Short comments | 5639.5 | 2624.2 | 1935.7–3774.7 | 5/5 |
| ONNX q4f16 | Article | 9197.4 | 4996.5 | 4023.5–6613.8 | 3/5 |
| ONNX q4f16 | English prose | 10489.9 | 5221.0 | 3931.7–5387.9 | 2/5 |
| GGUF Q4_K_M | Short comments | 7247.6 | 2779.5 | 1982.1–2905.1 | 5/5 |
| GGUF Q4_K_M | Article | 11204.9 | 5739.9 | 4287.5–6438.8 | 2/5 |
| GGUF Q4_K_M | English prose | 12322.4 | 5136.4 | 3856.1–5539.6 | 2/5 |

**The five-second goal is not met consistently.** Nineteen of 30 warm
candidate runs met it; none of the paired baseline runs did. Later candidate
runs were slower, and those misses remain in the result. Thermal throttling,
system load or a particular GPU bottleneck was not isolated in this experiment;
none is asserted as the cause of the variation.

The tradeoff is later first streaming text despite earlier complete pages:

| Model | Page | Baseline first-preview median ms | Candidate first-preview median ms |
| --- | --- | ---: | ---: |
| ONNX q4f16 | Short comments | 288.1 | 540.6 |
| ONNX q4f16 | Article | 364.4 | 822.3 |
| ONNX q4f16 | English prose | 280.5 | 554.5 |
| GGUF Q4_K_M | Short comments | 255.3 | 505.5 |
| GGUF Q4_K_M | Article | 322.5 | 722.2 |
| GGUF Q4_K_M | English prose | 281.5 | 503.7 |

The new default prioritizes the user's full-page goal, not the earlier
first-preview target. Serial/two-slot settings remain available. Actual host
generation admission reached eight in every candidate run; source coverage
is unchanged. English generation calls fell from nine to eight because
duplicate segmentation was removed; Japanese calls remained eight.
Across all five pairs, final text differs only in the same long English
comment reviewed above. `lib/kernels.js` and `hostworker.js` have identical
baseline/candidate hashes. Remaining uncached generation still costs several
seconds even with all eight requests admitted; the old 78% matrix observation
has not been remeasured or eliminated by this work.

`paired-final/comparison.json` retains every run; `analysis.json` contains
the paired calculations and full differing translations. The first cold
attempt in `candidate-cold/` is invalid as cold evidence: the diagnostic
sent the host-only unload message through the UI route and the observed
state remained `ready`. The corrected runner uses `LOCAL_RELEASE` and
requires `state=unloaded` and zero resident bytes before timing.

#### Verified nonresident-model result

`candidate-cold-fixed/` contains three rounds per case. Before every timed
click, the model reports `unloaded` and zero resident bytes. Loading occurs
after the click: host load time is 501–677ms, first generation admission is
529–705ms, and each page records eight fresh generations. All 18 pages
completed within five seconds and restored correctly, without recorded
host/page errors.

| Model | Page | Median ms | Range ms | ≤5s runs |
| --- | --- | ---: | ---: | ---: |
| ONNX q4f16 | Short comments | 2473.4 | 1964.3–2498.0 | 3/3 |
| ONNX q4f16 | Article | 4332.2 | 3664.9–4564.9 | 3/3 |
| ONNX q4f16 | English prose | 3922.4 | 3598.4–4032.2 | 3/3 |
| GGUF Q4_K_M | Short comments | 2414.5 | 2181.5–2515.2 | 3/3 |
| GGUF Q4_K_M | Article | 4273.5 | 4113.5–4915.1 | 3/3 |
| GGUF Q4_K_M | English prose | 4007.0 | 3898.9–4580.8 | 3/3 |

These later observations were faster than several warm paired runs despite
including initialization. They are **not paired with those warm runs**, so
they do not establish that cold loading is faster. Browser/OS caches remain
warm, and the recorded run-to-run variation prevents a universal five-second
claim. The earlier warm misses must not be discarded in favor of this batch.

The corrected cold runs produced 557/1046/1013 decode tokens for ONNX and
558/1043/1003 for GGUF across short/article/English pages respectively,
unchanged across their three repetitions. The original input and output
limits remain intact. Whole-page latency still scales with uncached source
and generated output; these three bounded fixtures do not certify arbitrary
websites, infinite feeds, all hardware, or downloading a missing model.

Decision: retain the verified scheduling/host/token-plan changes and report
**partial goal attainment**, not a guaranteed five-second product. Focused
verification passed 305 distinct Node and 59 distinct Chromium scenarios
across initial/corrected runs, plus extension/tooling type checking and Chrome
packaging. Raw timing/translation artifacts, including rejected/invalid runs,
remain available; `frozen-builds-and-sources.tar.gz` preserves the compared
builds, source snapshots and disposable experiment drivers.

### Current GGUF page path: detailed repeated-computation measurement

Evidence: `test-results/browser/gguf-profile-YuoErb/{rounds,analysis.json,report.json}`.
Apple M5, Chrome for Testing 143.0.7499.4, visible installed extension,
unsafe WebGPU disabled, PLaMo-3 Translate 0.8B Q4_K_M only. The existing
eight-slot scheduler and fixed three complete-page fixtures are unchanged.
The model is resident before timing; importing/downloading is not included.
No production kernel, precision, prompt, output limit or EOS change was made.

Three serialized rounds alternate four diagnostic modes: minimal job capture
without step/GPU profiling (`control`), step/embedding/upload counters (`step`),
pass-preserving timestamps (`pass`), and per-dispatch timestamps (`dispatch`).
All 36 measured pages completed and restored their original Text nodes.
Every mode/round produced exactly the same prompt/output token arrays and
final page strings for its fixture; no recorded GPU, host or page errors.
The control article screenshot was inspected. Setup failures and a successful
dispatch smoke run remain separate from these 36 observations.

#### Page timing and instrumentation limits

| Page | Control median ms (range) | Step median ms | Pass median ms | Dispatch median ms |
| --- | ---: | ---: | ---: | ---: |
| Short comments | 1772.7 (1597.3–1929.5) | 1905.7 | 2438.8 | 2198.8 |
| Article | 3455.7 (3455.3–4665.5) | 3922.0 | 4131.8 | 4382.6 |
| English prose | 3465.3 (3331.4–3880.8) | 3748.5 | 3948.9 | 4415.0 |

All nine controls met five seconds in this batch, but this is a diagnostic
experiment, **not a new optimization or a reversal of the earlier warm
five-second misses**. Pass-mode article/English runs reached 6888.7/6038.5ms;
those misses are retained. Article medians with step/pass/dispatch profiling
are 13.5%/19.6%/26.8% above control. These are observed differences including
run-to-run variation, not isolated causal profiler overhead or significance.

GPU timestamps are quantized to 65.536 microseconds. Small operations can
report zero. Timestamped pass durations are not an exclusive partition of
wall time: in the representative dispatch article decode, their sum is
2745.7ms while first-to-last GPU timestamp spans sum to 2698.4ms. The raw
`betweenPassMs` difference is negative (-47.3ms), so it must **not** be
interpreted as GPU idle time or clamped into a claimed scheduling metric.
Percentages below use the sum of measured dispatch durations as denominator;
they are approximate attribution, not precise hardware utilization.

#### Article phase and host breakdown

Each mode's representative is its median-completion run, not a synthetic
sum of unrelated medians. In the control representative, admission starts
25.8ms after click, first host request through final response spans 3421.0ms,
and final paint follows 8.9ms later. Thus the host inference interval still
accounts for about 99% of the 3455.7ms page completion.

The step-only representative is round 1, with 3922.0ms complete-page time:

| Phase | Model steps | Input tokens fed | Output picks | Cumulative step wall ms |
| --- | ---: | ---: | ---: | ---: |
| Pure prefill | 4 | 256 | 1 | 341.4 |
| Mixed prefill/decode | 9 | 249 | 28 | 454.4 |
| Pure decode | 183 | 0 | 1043 | 3026.7 |

Step wall totals 3822.5ms; pure decode is 79.2% of that total. CPU command
encoding totals 30.5ms, including 6.6ms observed embedding-row decoding.
The latter is about 0.17% of total step wall, not the primary bottleneck.
The completion/readback counters total 3789.0/3.0ms. Completion includes
GPU execution, queue and browser notification delay: the 3.0ms is only the
readback tail after completion observation, **not total GPU-to-CPU transfer
latency**. These wall counters must not be added to GPU durations.

#### Decode GPU operator attribution

Representative dispatch article run: round 1, 183 pure-decode steps.
Pass-preserving round 3 separately reports 2687.6ms summed decode pass
durations and 2638.9ms GPU spans; its combined B1 passes cannot be assigned
to individual operators. The broad FFN/head ranking is consistent.

| Operator | Cumulative measured GPU ms | Share of decode dispatch-duration sum |
| --- | ---: | ---: |
| FFN gate/up, Q4_K | 756.9 | 27.6% |
| FFN down, mixed Q4_K/Q6_K | 422.2 | 15.4% |
| Vocabulary output head, Q6_K | 451.6 | 16.4% |
| QKV projection | 216.9 | 7.9% |
| Attention output projection | 179.0 | 6.5% |
| Attention | 176.4 | 6.4% |
| Normalization / RoPE / SiLU | 529.9 | 19.3% |
| Argmax | 12.7 | 0.5% |

All matrix kernels combined account for 73.8%, with 71.7–75.5% across the
three article dispatch runs. FFN gate/up plus down accounts for 40.7–43.2%;
the output head for 16.4–17.9%. Across all three fixtures, matrix attribution
ranges 71.0–77.9%. This replaces applying the old B1 “78%” directly to the
current page workload. It does **not** identify unpacking alone as that cost:
weight reads, bit reconstruction and multiply-accumulate are fused inside
these kernels. No independent DRAM-bandwidth-versus-ALU attribution was made.

#### What is actually repeated

- Article: eight distinct model jobs, 505 total prompt tokens fed exactly
  once by the step accounting, 1072 total output picks including the 29
  produced during prefill/mixed steps. Pure-decode-only count is 1043;
  it is not the whole generated-output count.
- Each pure-decode step executes 16 layers × four matrix kernels plus one
  vocabulary head: 65 dispatches per step, **11,895 matrix dispatches** over
  183 steps. The head runs 183 times in pure decode and 193 times over the
  entire page. All phases together execute 196 model steps and 32,279
  dispatches. This is repeated forward computation for changing token
  activations, not repeated generation of an identical whole prompt.
- Step-only page counters record 2757 buffer writes totaling 9,809,696 bytes,
  zero writes of at least 1MiB and zero new GPU-buffer bytes. There is no
  observed per-token model-weight upload or buffer-allocation loop.
  Weight repacking occurs at initialization, outside this resident-page
  interval; no repack shader appears in the page dispatch trace.
- The current `repackedGemv` reconstructs a weight into registers and reuses
  it across the active batch rows (`src/lib/kernelgguf.ts:233-246`). It does
  not separately reconstruct that weight for each of eight sequences within
  that dispatch. The next autoregressive step still reads/reconstructs
  weights again; the newly changed hidden activations require new products.
- The eight prompts share nine leading token IDs. Identical-prompt jobs
  are absent. Shared-prefix prefill is a possible separate optimization,
  but its isolated saved milliseconds were not measured and it cannot be
  credited with eliminating the dominant pure-decode interval.

#### Batch occupancy and priorities

Article pure decode has a mean of 5.70 active rows, not eight. Width eight
lasts only 13/183 steps; width seven lasts 87; widths five/four/three last
29/25/25. Only three steps have one or two rows. The 53 steps with fewer
than five rows consume 770.6ms of wall time in the representative dispatch
run (731.8–1057.6ms across repetitions). This is measured low-occupancy cost,
**not fully removable overhead**: no unstarted ninth request exists in this
fixture, and equalizing output lengths or ideal packing was not tested.

Priorities supported by these measurements:

1. Optimize the repeated FFN gate/up and down matrix paths, then the Q6_K
   vocabulary head. Preserve the existing Q4_K_M tensor formats and outputs.
2. Measure fusion/pass-launch reductions for normalization/RoPE/SiLU without
   mistaking short quantized timestamp values for precise per-kernel costs.
3. Treat length-aware admission/packing as a separate controlled experiment;
   a configured width of eight alone does not eliminate tail underfill.
4. CPU embedding decode, repeated uploads, repeated full-prompt prefill and
   argmax are not supported as the dominant bottleneck by this trace.

Only diagnostics and existing documentation were changed for this
investigation; no new production optimization is claimed. The evidence
archive preserves the isolated extension, drivers and aggregation scripts.

### Q4_K_M optimization candidates and immediate rendering

Evidence: `test-results/browser/gguf-opt-uQVBRj/`, on the same Apple M5
24GiB / Chrome for Testing 143.0.7499.4 setup. All GPU/browser experiments
ran serially, using the existing Q4_K_M model, prompts, output limits and
EOS rules. Candidate kernels were compiled into isolated extension copies.
**No candidate kernel change was adopted into production.** A lower time
in one synthetic case is insufficient when page results do not improve or
generated tokens change.

#### Kernel candidates, in the measured priority order

1. **FFN gate/up and down:** change repacked GEMV from 16 to 32 lanes.
   Independent GGUF reference coverage passed 1264 repacked matrix cases
   (maximum scaled error `1.037106575e-6`, threshold `1e-4`). Across prompt
   lengths 128/512, widths 1/8 and three paired repeats, all generated tokens
   matched. Candidate/baseline median decode ratios were 1.009, 0.979,
   0.984 and 0.988 respectively: inconsistent and too small to establish a
   page-level benefit. A separate 16-output-per-workgroup FFN candidate
   gave ratios 0.992/0.988/0.983/0.978 at widths 1/3/5/8; not adopted.
2. **Q6_K vocabulary head:** 32 lanes did not consistently help.
   Sixteen outputs per workgroup gave ratios 1.028/0.991/1.043/0.936 at
   widths 1/3/5/8, hurting several widths. A refined candidate restricted
   that change to width eight and retained exact tokens in the aligned
   logits check and exact final page strings. Its three page screening
   times did not improve on baseline, so it was not adopted.
3. **Normalization/RoPE fusion:** combine independent Q and K
   normalization/RoPE workgroups into one dispatch per layer, preserving
   arithmetic and reduction trees. This removes 16 dispatches per model
   step (and 16 passes when active width exceeds one), not the model
   computations themselves. All 48 aligned comparisons across prompt
   lengths 128/512, widths 1/2/4/8 and three paired repeats produced
   bit-identical checked logits and tokens. Decode ratios ranged
   0.943–1.053, with no consistent improvement at width eight or in the
   actual-page screen. Not adopted. No separate SiLU-fusion speedup is
   claimed.
4. **Length-aware prefill:** distribute the existing prefill budget
   proportionally to remaining prompt lengths, without changing token
   limits. One mixed-workload observation fell from 7088.1 to 6211.8ms,
   but one job differed by 17 tokens, starting at output index six.
   Rejected for output mismatch. Existing baseline batched versus
   individual scheduling also changes that job's tokens; preserving
   baseline batched results remains the acceptance criterion.

The initial independent fixture lacked `repackSamples`; the complete
existing reference fixture was then used. The existing logits checker
cannot check a final full uniform batch when unequal prefill completion
occurs at width three: the baseline itself failed that assertion. Those
failed reports are retained. Non-power-of-two geometry runs check exact
generated tokens, not unobserved logits equality.

Actual installed-extension screening used Aurora and measured completion
only after all final text was fully opaque, finite animations had ended,
and two animation frames had elapsed. All nine pages completed, matched
final strings, and restored original Text identities. These are single
screening observations, not statistical evidence of a regression:

| Page | Baseline ms | Width-eight head candidate ms | Q/K fusion candidate ms |
| --- | ---: | ---: | ---: |
| Short | 1996.6 | 2113.7 | 2047.8 |
| Article | 4113.9 | 4288.6 | 4206.2 |
| English | 3973.1 | 4039.9 | 4036.9 |

#### Aurora versus immediate rendering

Production now supports `translationRendering: 'aurora' | 'immediate'`,
defaulting to Aurora, through the localized settings UI. Saving immediate
mode updates active translations without restarting inference. Preview
updates are synchronous and final canonical text is shown without the
preview timer, animation-frame handoff, gradient or fade. Original Text
identity, restoration, cancellation, accessibility and fragment reading
order remain unchanged.

Aurora schedules preview updates after 40ms plus an animation frame, fades
new text over 160ms and hands final previews to canonical text after 160ms.
Its 3.4-second decorative cycle does not block completion. Partial-result
decoration has a separate 180ms grace period.

Five alternating renderer-only browser rounds supplied deterministic text
to eight real paragraph renderers; **these are not model inference times**:

| Median rendering delay | Aurora ms | Immediate ms |
| --- | ---: | ---: |
| Preview submission to preview DOM update | 55.4 | 0.1 |
| Final submission to fully opaque text plus two frames | 183.7 | 16.7 |

Thus animation adds a measurable roughly 167ms final display tail in this
controlled experiment, not seconds of model computation. A later fragment
can produce model progress before an earlier fragment becomes displayable;
immediate mode deliberately does not bypass that reading-order wait.
`render-latency/report.json` and streaming screenshots retain the evidence.

#### Installed-extension paired page results

Five serial paired rounds alternated Aurora/immediate order, using the
same compiled extension and unchanged kernels, eight generation slots,
resident Q4_K_M weights and a fresh page-result cache. All 30 pages
completed, restored source Text identities, and matched exact final
strings. No runtime errors occurred. These page reports do not capture
token arrays; the isolated kernel comparisons above do.

| Page | Aurora visible median ms | Immediate visible median ms | Aurora under 5s | Immediate under 5s | Median paired saving ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Short | 2411.3 | 2139.0 | 5/5 | 5/5 | 172.2 |
| Article | 5004.4 | 4029.7 | 2/5 | 5/5 | 633.3 |
| English | 4546.5 | 3979.4 | 4/5 | 5/5 | 802.0 |

Immediate was faster in all 15 pairs; all its visible completions were
below five seconds, with a maximum of 4598.1ms. Aurora had four visible
five-second misses, retained in the denominator. Its canonical-DOM-only
metric would have counted only two misses: measuring the final fade
changes the answer.

The directly observed canonical-to-visible tail was 158.2/163.7/158.7ms
for Aurora versus a median of zero for immediate. Last host completion
to visible completion fell from 172.4–179.1ms to 10.2–14.8ms. First
progress-to-preview medians fell from 47.5 to 3.4ms on the short page and
52.8 to 2.1ms on the English page. The article retained a 240.1ms median
wait, versus 349.7ms with Aurora, because ordered fragments cannot all
display as soon as any fragment produces progress.

Total paired savings exceed the isolated final display-tail reduction.
Host execution intervals also varied substantially between these runs;
this experiment does not separate animation/resource contention from
browser/GPU timing variability. Do not attribute the entire page-time
difference to shader acceleration or claim an established inference
speedup. The product change removes proven UI delay, not autoregressive
matrix work.

`animation-paired/comparison.json` retains medians/ranges and all final
string comparisons; `experiment.json` retains paired differences,
hardware/model/fixture provenance and limits. Settings and translated
page screenshots were visually inspected. The settings screenshot is
taken before GGUF import; the timed reports identify and hash the GGUF
model actually used.

This finite, warm, three-page experiment does **not** establish a universal
five-second guarantee, cold-start performance, or a p95. Earlier warm
five-second misses remain valid evidence. The production recommendation
for lowest display latency is Settings → immediate rendering → Save;
Aurora remains the default. Candidate sources, drivers and copied builds
are archived; disposable working files were removed.

### Japanese-only three-second bottleneck measurement

The acceptance target is now **3000ms**, with English excluded. Reused
the unchanged Japanese short/article fixtures, translated to Korean with
resident PLaMo 3 Translate 0.8B GGUF Q4_K_M, eight slots and immediate
rendering. Evidence: `test-results/browser/gguf-ja-profile-QlzzmQ/`.
The model hash remains
`70891ec70dc7ab4205745a38307867c2881b99239f20327927633abfe4bc9ec6`;
the original fixture hash is unchanged and the selected Japanese subset
has its own hash in `report.json`.

On Apple M5 / Chrome for Testing 143.0.7499.4, three rounds alternated
plain/step/pass/dispatch order, with GPU browser processes serialized.
Plain mode has no worker profiling hooks; it retains page DOM and host
boundary observation. Pass mode preserves compute-pass grouping.
Dispatch mode splits passes for attribution and is not acceptance latency.
All 24 pages completed and restored original Text identities. All final
strings matched; all 18 instrumented prompt/output token comparisons
matched. Plain mode deliberately does not capture worker token arrays.
The completed Japanese article screenshot was visually inspected.

#### Acceptance and variability

Enable click to complete, fully visible text including below-fold source,
with two animation-frame opportunities; no scrolling:

| Japanese page | Plain median ms | Plain range ms | Within 3000ms |
| --- | ---: | ---: | ---: |
| Short | 2430.3 | 1522.8–2502.2 | 3/3 |
| Article | 4700.4 | 3148.0–4795.9 | 0/3 |

The article needs 1700.4ms (36.2%) less time relative to this median.
The fastest observed run also misses. Three samples do not establish
p95 or a universal bound. The same output and model-step counts have
substantial timing variation: first-to-third dispatch-profiled article
GPU spans rise from 3384.7 to 4164.5ms. Therefore variability is not solely
a final DOM paint issue. Thermal state, frequency, power and external GPU
contention were not independently measured; no specific cause is proven.
Profiling modes sometimes have lower medians than plain despite extra
instrumentation. These differences are not negative profiling overhead or
an optimization: browser runs occurred at different times.

#### Model phases and non-model overhead

The median-completion step-only article run (round three, 4116.6ms) has:

| Component | Wall ms | Model steps |
| --- | ---: | ---: |
| Prefill only | 253.3 | 4 |
| Mixed prompt ingestion and decoding | 347.9 | 9 |
| Pure autoregressive decode | 3380.5 | 183 |
| Outside measured model steps | 134.9 | — |

Pure decode is 84.9% of measured model-step wall time in that run;
the three-run range is 79.9–84.9%. It accounts for 82.1% of the whole
representative page interval. Total step wall is 3981.7ms, including
58.4ms encoding, 3917.8ms queue/GPU completion wait and 5.5ms residual
readback. The completion wait overlaps GPU work and browser scheduling;
it must not be labeled CPU overhead or added to GPU timestamps.

CPU embedding-row reconstruction totals 12.6ms, already inside model-step
encoding, not an additional phase. Host work outside measured steps is
77.8ms; request collection/admission before the first host generation is
47.3ms, and final display after the host is 9.8ms in this same run.
In plain runs, last-host-to-visible median is 11.9ms (9.9–15.5ms).
Removing remaining display latency cannot recover the missing seconds.
The article's first-progress-to-preview median remains 260.7ms because
fragment reading order can withhold a later fragment; this is not an
Aurora fade in immediate mode.

#### Repeated GPU work and batch utilization

Representative dispatch-profiled article decode (round two):

| Operator | GPU dispatch-duration sum ms | Share |
| --- | ---: | ---: |
| FFN gate/up | 853.2 | 27.9% |
| FFN down | 452.0 | 14.8% |
| Q6_K vocabulary head | 516.3 | 16.9% |
| QKV projection | 238.4 | 7.8% |
| Attention output projection | 188.0 | 6.2% |
| Normalization / RoPE / SiLU | 588.2 | 19.2% |
| Attention | 192.2 | 6.3% |
| Argmax | 28.0 | 0.9% |

Matrix kernels total 73.9% (73.6–74.0% across repetitions); FFN alone
is 42.7% in the representative run. These kernels fuse packed-weight
reads/reconstruction and multiply-accumulate; the trace does not isolate
dequantization from memory traffic or arithmetic.

The article still has eight unique jobs, 505 prompt tokens ingested once,
1072 output picks in total, and 1043 output picks in pure decode.
Each of 183 decode steps executes 16 layers × four matrices plus one
vocabulary head: **11,895 matrix dispatches**, not duplicated whole-prompt
prefill. All phases together contain 196 model steps and 32,279 dispatches.
Step-only buffer counters show 2757 writes / 9,809,696 bytes, no writes
of at least 1MiB and zero newly allocated GPU-buffer bytes during the
page interval. There is no observed per-token model upload or repacking.

Average pure-decode width is 5.70, not eight. Width seven occupies
87/183 steps, eight only 13/183. In the representative step-only run,
width seven costs 1873.5ms; the 53 steps below width five cost 753.8ms.
This is required work at low occupancy, not 753.8ms of freely removable
idle time: all eight jobs have already been admitted and no ninth
independent request exists to fill the tail. Output lengths range
23–184 tokens, with unchanged EOS behavior.

The short page needs 83 decode steps and 5395 matrix dispatches, with
average width 6.72. Its lower repeated work and better occupancy distinguish
it from the failing article; language filtering alone does not remove
the article's decode bottleneck.

Priorities remain FFN and Q6_K head throughput, particularly widths seven
and three-to-five rather than an eight-only specialization, then
normalization/RoPE/SiLU launch cost. Previously rejected candidates remain
rejected; this measurement introduces no new kernel optimization.
Prefill-only, CPU embedding, argmax and rendering changes alone are not
supported as sufficient solutions to the three-second article target.

Positive GPU pass durations are quantized in 65.536-microsecond increments.
117851 zero-duration pass readings do not imply free kernels; 1065
negative span-minus-pass-sum readings are retained, not interpreted as idle
time. Use aggregate attribution and the pass-preserving control, not
individual tiny timestamp readings, to choose optimization targets.
Raw reports, phase/width aggregates, paired output comparisons and the
isolated builds/drivers are archived. Disposable working files were
removed; production sources and extension builds were not changed.

### Japanese Q4_K_M optimization candidate gates

Evidence root: `test-results/browser/gguf-ja-opt-zfaux8/`. Candidates use
isolated source snapshots and the original model bytes. The acceptance
contract remains Japanese→Korean, eight slots, immediate rendering,
resident model, fresh page-result cache and complete below-fold coverage.
Model precision, prompts, tokenization, output limits and EOS are unchanged.
GPU/browser experiments run serially.

#### FFN batch sharing: rejected

F2/F4 retain eight outputs and sixteen reduction lanes per workgroup.
Only the first batch sub-tile reconstructs a K256 weight block into 8KiB
of workgroup storage; other sub-tiles consume it. Maximum total workgroup
storage is 12KiB. Accumulation and reduction order are unchanged.

Independent fixtures passed 900 cases and 16 repack checks, including
FFN-sized shapes made by repeating independent fixture rows. These are
not actual-model weights. Real-model L128/512, B1–8 and 64 output tokens
passed 48 gate/up runs with identical tokens and zero measured final-logit
difference. F4 down-only separately passed 32 real-model accuracy runs.

The subsequent screen used L128/512, B1/3/4/5/7/8, 32 output tokens and
three alternating-order repetitions. Ratios below compare per-condition
median **decode wall time**, not GPU timestamps or page completion:

| Candidate | B7 L128 ratio | B7 L512 ratio | B3–8 decode condition ratios |
| --- | ---: | ---: | ---: |
| F2 gate/up | 1.967 | 1.826 | 1.403–2.007 |
| F4 gate/up | 1.725 | 1.632 | 1.160–1.955 |
| F4 down only | 1.419 | 1.334 | 1.212–1.442 |

All ten changed-width conditions regress for each candidate. F4 was the
less costly gate/up sharing scheme and was therefore tested independently
on down; its down screen lost all 30 changed-width decode pairs.
Neither FFN role is adopted. H-share is not run because its prerequisite,
an accepted FFN sharing scheme, is absent. No page-speedup claim follows
from these synthetic-input screens. Shared-memory/barrier overhead is a
possible explanation, not an independently measured cause.

#### Q6 vocabulary head byte codes: not adopted

H-byte stores the original 0–63 codes in bytes, without requantization.
Independent checks passed 90 GEMV cases and ten exact code/coefficient
layout comparisons, including a repeated-fixture N107520/K1536 head.
Real-model accuracy passed 32 runs with unchanged generated tokens.

Nine lifecycle cases covered normal compact/f32/direct layouts, forced
and automatic budget handling, unsupported formats, binding rejection and
an injected allocation failure. All disposed with zero live owned buffers
and balanced error scopes. The compact candidate observed 527,720,448
resident matrix bytes and 535,461,888 peak matrix bytes; all 65 temporary
source uploads were released. Head codes and coefficients occupy
165,150,720 and 12,902,400 bytes respectively. This increases resident
matrix storage by 41,287,680 bytes (39.375MiB). These are owned-buffer
measurements, not whole-browser memory.

The 72-run paired screen had mixed results rather than a reliable gain.
B7 decode median ratios were 1.069 at L128 and 1.035 at L512;
B1 was also slower at both lengths. B4/B5 improvements did not establish
an overall decode advantage. Keep the original packed head rather than
paying the memory increase for inconsistent throughput. H-byte was not
promoted to the page gate, and no whole-page benefit is claimed.

#### NORM_CHAIN lane-local reuse: rejected for output divergence

The candidate retained each lane's twelve residual sums instead of
reloading `combined`. The first diagnostic mistakenly required exact
floating-point equality, stricter than the approved 1e-4 scaled-error
contract, and stopped at a 1.42e-14 difference. That failed report is
retained as `norm-numerics-bitexact-failed/`. With the planned tolerance,
all 40 isolated normalization cases passed, including near-zero inputs.

This was insufficient for autoregressive correctness. Real-model L128/B1
diverged at output token nine (baseline 106327, candidate 35254).
Final-step logits had cosine 0.312555 and relative L2 1.376125, failing the
unchanged model gate. Screening stopped immediately; no timing benefit
is accepted and no product change is made. The isolated tolerance does
not permit changing generated tokens.

#### Shared RoPE rotation table

R-table computes local/global sin/cos once per pure decode step into an
8192-byte GPU buffer. Q/K retain their original RMS and rotation arithmetic;
prefill and mixed steps retain the original path. Frequency uploads are
shared at initialization, giving a net owned-buffer increase of 4608 bytes.

All 80 isolated cases were bit-identical, including both frequency groups,
widths 1–8, maximum/heterogeneous/invalid positions, reused KV slots and
near-zero inputs. All 32 real-model accuracy runs matched tokens and final
logits exactly. The 72-run screen was mixed: L128 B3/4/5/7/8 decode median
ratios were 0.997/0.981/0.978/0.893/0.968, while L512 B7 regressed to 1.319.
This short-input signal promoted R-table to the actual Japanese page gate;
screen results alone are not an accepted speedup.

The first actual-page gate completed 32/32 pages with matching final
strings and successful source restoration. Article paired medians were
3448.0ms baseline versus 3188.8ms candidate (five/five pair wins), and
short-page medians were 1721.7ms versus 1688.1ms. Nevertheless, this is
**inconclusive**, not a validated 7.5% improvement: baseline bracket
medians drifted by +65.8% for article and +71.1% for short-page, exceeding
the 10% limit. Candidate article met three seconds in only one/five runs.
AC power stayed attached at 80%; `pmset` recorded no warning levels but
provided no GPU clocks/temperature evidence explaining the drift.

The one allowed fresh-session retry completed seven pages, then stopped
on a baseline article's nonzero scroll position (552.5 instead of zero).
Translation reported completion, but the no-scroll whole-page contract
failed; the attempt is not counted as a valid page result. The failure and
raw report are preserved in `rope-pages-2/`. No third attempt is made.
R-table remains unadopted. The candidate article screenshot from the first
gate was inspected: all four Korean text blocks were visible, including
below-fold blocks, and the excluded marker remained untranslated.
The 4608-byte net table/frequency buffer change above is calculated from
allocation sizes, not a measured whole-model peak.

#### Gate/up SiLU epilogue

S-epilogue maps four gate and four corresponding up outputs to one
workgroup, preserves their sixteen-lane accumulation/reduction, then
writes SiLU×up directly to `act.s`. Pure decode removes the separate SiLU
dispatch and `act.gu` round trip; prefill/mixed steps keep the original
path and buffer. No FFN sharing candidate was adopted, so this uses the
original GEMV geometry rather than a combined sharing experiment.

All 256 isolated cases passed the 1e-4 contract against unfused output and
the independent oracle, including zero/near-zero and larger signed inputs.
All 32 real-model L128/512, B1–8, output64 runs preserved generated tokens.
The 72-run screen's B7 decode ratios were 0.914 at L128 and 0.816 at L512.
B1 regressed, and other widths had mixed results; only the actual page gate
can establish whether the dispatch reduction is worth adopting.

The first page gate completed 32/32 pages with identical final strings and
successful restoration. Article medians were 3597.0ms baseline versus
3523.9ms candidate: only 2.0% lower and three/five pair wins, below the
required 5% and four/five. No candidate article run met three seconds
(range 3222.3–4147.7ms). Short-page medians were 1873.7ms versus 1847.6ms,
but its baseline brackets drifted by −13.7%, also invalidating acceptance.
The one allowed retry completed three pages, then failed the same baseline
article no-scroll assertion at scrollY 552.5. Its raw failure is retained
in `silu-pages-2/`; no third attempt is made. S-epilogue is not adopted.
The completed candidate article screenshot was inspected.

#### Outcome

No kernel candidate passed the adoption gates; production kernels and
extension builds remain unchanged. Consequently, no cumulative candidate
exists for the final ten-pair gate, and **the three-second goal is not
achieved**. Do not present either drifting page comparison as a validated
optimization or compare it with an older session to claim a speedup.

Retained changes are the per-job logits diagnostic repair and these
performance/testing records. Evidence contains 1366 passing independent
numerical cases, 26 repack checks, 585 completed full-model runs plus the
failed normalization run, and 74 completed page runs plus two invalid
no-scroll runs. All failures remain in the archive. `outcome.json` records
candidate decisions; `kernel-summary.json` aggregates raw model reports.
No operator-attribution or final integration run is claimed for a rejected
candidate. Remaining work is still repeated model computation; this
experiment did not establish a safe throughput improvement.

### Quantized GEMV register lifetime and narrow pass grouping screen

Evidence: `test-results/browser/gguf-gpu-focus-aw4MHw/`. This targets the
current custom WebGPU engine, not upstream wllama. Both candidates are
rejected; production kernel sources and extension builds are unchanged.

`register` changes only repacked GEMV widths 3–8: reconstruct four adjacent
K weights, then load and consume one activation row at a time. It preserves
each accumulator's FMA order, final reduction, packed representation and
workgroup geometry. Lower source-level activation lifetime is a hypothesis
about register pressure, not measured physical register allocation.

`qk-pass` groups only the independent Q normalization/RoPE and K/V
preparation dispatches for GGUF pure-decode widths 2–8. It leaves all shader
math, prefill/mixed execution and admission unchanged. This is not the
previously rejected blanket pass coalescing scheme.

The first register implementation shadowed the packed `low0`/`low1`
variables with decoded locals. An independent Q6 fixture caught the error;
`numerics.log` retains the failure. After renaming those locals, the unchanged
oracle passed 49 direct cases, 16 repack checks and 1264 repacked matrix
cases. Maximum scaled matrix error was 1.03711e-6 against the 1e-4 limit.
Output guard checks passed and GPU errors were empty.

The headed, ordinary-WebGPU screen used the original Q4_K_M file,
L128/512, B1/3/5/7/8, 32 generated tokens, prefill64 and three alternating
variant-order repetitions. All 90 real-model runs completed; all 90
pairwise token comparisons matched. Diagnostic final-logit replays had
zero measured difference; validation, page and cleanup errors were empty.

Ratios below are candidate/baseline per-condition median **decode wall
time**, not GPU timestamps or complete-page latency:

| Candidate | L128 B7 | L512 B7 | L128 B8 | L512 B8 | B3/5/7/8 geometric mean |
| --- | ---: | ---: | ---: | ---: | ---: |
| Register lifetime | 1.061 | 1.060 | 1.072 | 1.051 | 1.033 |
| Q/K preparation pass | 0.980 | 0.925 | 1.033 | 1.096 | 1.002 |

Neither passes the predeclared promotion requirement of at least 5% lower
B7 decode medians at both lengths, changed-width geometric mean below one
and no B1 median regression above 3%. Both candidates leave B1 execution
unchanged; its observed variation, including +3.7% for qk-pass/L512, is not
evidence of altered single-row kernel cost. No context-dependent switch
was selected from favorable cells.

No candidate reached all-width output64 validation, installed-page
acceptance or winner attribution. This experiment establishes neither a
matrix-cost reduction nor improved hardware occupancy, page speedup or the
three-second goal. Browser measurements do not expose physical register
counts or occupancy; queue wait is not additional exclusive CPU cost.
`experiment.json`, `screen-analysis.json`, `outcome.json` and
`experiment-sources.tar.gz` preserve gates, raw-result links and reproduction
inputs. No unrelated test suite was run.

## ONNX q4f16 K-block scheduling screen

Evidence: `test-results/browser/onnx-opt-D79eDb/`. Both isolated candidates
target the current custom ONNX GEMV's low-nibble-first Q4, K128 blocks and
per-output/block scales. Model bytes, packed storage, allocation, FMA order,
scale factoring at widths one/two and final lane reduction are unchanged.
Neither candidate is adopted.

- `prefetch` stages the next block's packed words/scales before computing
  the current block. This is source-level load scheduling, not measured
  hardware prefetch or occupancy.
- `k2` emits two consecutive K128 block bodies per outer loop, with an
  odd-block guard. It retains the dynamic component loop, rather than
  repeating the previously rejected eight-nibble unroll.

Each passed the existing independent packed-GEMV oracle: 12 cases and
991,778 output values, zero absolute error and intact canaries. Coverage
includes widths 1–8, one/odd/even blocks, dense K1536/K6144, incomplete
output tiles and two-dimensional dispatch tails.

Headed Chrome 143 without unsafe flags ran the original q4f16 model at
L128/512 × B1/3/5/7/8 × output32 × three alternating-order repetitions.
All 90 model runs and 90 pairwise token comparisons passed; final-logit
diagnostic replay measured zero difference. GPU, page and cleanup errors
were empty. The following are ratios of candidate/baseline per-condition
median decode wall times, not page latency or GPU timestamps:

| Candidate | All-condition geometric mean | L128 B7 | L512 B7 |
| --- | ---: | ---: | ---: |
| Next-block load scheduling | 1.010 | 1.037 | 1.076 |
| Two-block outer loop | 0.996 | 1.208 | 1.024 |

Promotion required geometric mean ≤0.95 and no condition above 1.03,
in addition to correctness. Both fail. K2's L128/B7 loses all three pairs;
its favorable long-context results do not justify a post-hoc context
switch. Baseline variability remains material: L512/B8 decode samples
were 366.8/505.1/454.5ms. Small aggregate differences are not established
speedups, and no physical register/occupancy explanation was measured.

No candidate reached all-width output64 or Japanese installed-page gates.
Production kernels and builds remain unchanged; no new page-speedup or
GGUF-relative gain is claimed. `experiment.json` records the predeclared
gate; `screen-analysis.json`, `outcome.json`, raw reports and
`experiment-sources.tar.gz` preserve decisions and reproduction inputs.

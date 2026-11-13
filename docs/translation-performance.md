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

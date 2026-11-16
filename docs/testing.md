# Validation contract

The current extension ships ONNX only: q4f16 custom WebGPU kernels with the
existing ONNX Runtime fallback. Historical GGUF comparisons below are retained
as evidence; their removed scripts/options are not current test commands.
Model originals and recorded experiment artifacts are not removed by builds.
Settings are global and do not expose a tab translation switch or source-tab
binding. Browser/native harnesses operate the shipped toolbar popup for ON/OFF;
opening settings must not select or restore a web tab. Automatic URL/language
preferences remain global settings.

## Notion local glossary synchronization

`lib/notion.ts` owns read-only dictionary synchronization from two sources. The
official API path pins `Notion-Version: 2025-09-03`, resolves database data
sources and configured column names/property IDs, and fully paginates both
concept and expression tables. The shared-page path reads a database published
with "Share to web" through the viewer endpoints its own page calls, with no
credential. The expression relation identifies a Notion concept page, whose UUID
title becomes the canonical `conceptId`; these IDs are not interchangeable.
Only a complete, schema-valid result from either source replaces the local v1
snapshot. Incomplete queries, truncated properties, inaccessible relations,
malformed rows and stale configuration fail without replacing it. HTTP 429 uses
bounded Retry-After handling. Unchanged canonical entries keep the same SHA-256
revision.

The background reconstructs an extension alarm from saved preferences, handles
manual synchronization and keeps credentials/dictionary data out of content
snapshots. Local dictionary changes cancel old generations and retarget only
already-authorized tabs; explicit OFF is preserved. Token removal stops
scheduled requests but does not delete the local dictionary. Tokens are stored
unencrypted in trusted extension-local storage, never `storage.sync` or prompts.

A database edit reaches open tabs without any manual step: the alarm
(5, 15, 60, 360 or 1440 minutes, or manual only) syncs the configured source, the
new snapshot bumps the revision, in-flight batches for authorized tabs are
cancelled, and those tabs are retranslated. A browser start also syncs once when
the saved snapshot is older than the configured interval, so a restart does not
wait for the first tick.

Two sources fill the same snapshot. `api` reads the official token API. `public`
reads a database published with **Share to web** and needs no credential and no
server: the page's own viewer endpoints (`getPublicPageData`, `queryCollection`,
`syncRecordValues`) answer unauthenticated requests, which is why the shared page
works in a browser at all. The page URL carries the workspace, the page block and
the view; the reader grows `loader.reducers.collection_group_results.limit` until
the view reports no more rows, then fetches the row bodies the viewer omitted in
batches of 100. The viewer's internal shapes are translated into the same
property objects the API path validates, so both sources share one validation,
one assembly and one SHA-256 revision. `share`-only pages, missing rows,
unmapped column types and non-page rows fail without replacing the last complete
dictionary.

The shared page's HTML alone is not a source: it is a client-rendered shell
(22,765 bytes, no rows, no embedded state). The viewer endpoints are the reason
a public database can be read at all.

The build emits one legal background block per target: Chrome MV3 ships only
`background.service_worker` (Chrome rejects `background.scripts` with "requires
manifest version of 2 or lower"), and the Firefox bundle ships only
`background.scripts` for its event page. The validator checks each emitted
manifest for its own store, not the source manifest's union of both.
The options page names an empty shared-page URL before requesting a sync, so the
service never has to answer with a generic "configure both URLs" sentence. A
fresh install already carries both published view URLs and defaults to the
public source, so opening the settings and pressing sync needs no typing.

Verification: a headed Chrome run with a fresh profile and the built extension,
**no token and no typing**, showed both view URLs filled in with the public
source selected, then synced in **11.6 s** producing **647 concepts /
1,886 entries**. A second headed run read the same pages in 12.0 s, and
all **1,886** rows matched the independently collected reference snapshot field
for field (term, language, conceptId, group, traits, description). The viewer
joins multiple multi-select options into one comma-separated value; splitting
them changed 211 rows to match. Unit tests cover the two-url configuration,
row batching, the login-only page, a row that never arrives, and the
missing-view-identifier URL. Evidence:
`test-results/browser/public-sync-check.json` and `public-sync-check.png`.

`lib/glossary.ts` selects exact longest nonoverlapping matches with Latin word
boundaries, matching concept/group/languages and omitting ambiguous or missing
counterparts. One counterpart per concept is resolved in a fixed order: a
`기본형` mark **in the target language**, then the candidate the source-language
usage note names, then the candidate with the same register (traits) as the
source term. A mark in one language never marks another language's spelling, so
`ChroNoiR` (Japanese `기본형`) pairs with `쿠로노와르`, not with the identical
Korean spelling variant. Candidates that stay tied remain ambiguous and are
omitted. The compiled index is cached per dictionary snapshot, because the
snapshot array is replaced wholesale on every sync.

`onnxhost.ts` supplies matched pairs through the model template's
native `glossary` parameter, including byte fallback and reserved-token escaping.
The source fragment planner counts this exact prompt and protects matched spans
from splitting. Unsupported templates and indivisible over-budget terms fail
explicitly; no output replacement, synthetic site hint, shortened reserve or
silent dictionary clipping is used. The template accepts exactly `source` and
`target` per glossary entry, so usage notes cannot travel with a pair.

Verification: typecheck and Chrome/Firefox builds passed. Targeted background,
options, Notion, matching, engine, local and host tests passed **265/265**.
Installed Chrome integration passed **18/18**, including custom column mapping,
two-page expression queries, manual synchronization, a real native alarm event,
active-page cache invalidation, offline local reuse after sync failure, exact
OFF restoration and the 390px settings layout. Notion REST responses and model
inference are deterministic doubles in this integration test; it is not a live
workspace authorization or real-model quality claim.

Evidence: `test-results/browser/notion-glossary/extension-trace.zip`,
`notion-glossary-settings.png` and `notion-glossary-translated.png`.
No live Notion connection token was supplied; the user's database has not been
modified. Firefox native alarm/sidebar execution remains unverified.

A separate headed Chrome run used the actual 705,701,446-byte q4f16 graph on
Apple Metal (`backend: kernels`, no unsafe-GPU flag). Two fixed Japanese
paragraphs used `猫汰つな → 네코타 츠나`, then a manual sync changed the preferred
spelling to `네코타 쓰나`. Both paragraphs followed each version (**4/4** name
checks), with no Notion request during translation and exact source restoration
on OFF. Settings synchronization used the real UI and intercepted official REST
responses, not a live workspace token. macOS rejected native toolbar opening in
this headed run, so it activated the same production `SET_TAB_ENABLED` handler
from privileged options; toolbar UI remains covered separately above.

This is terminology obedience on four outputs, not general semantic accuracy
or a full-page three-second benchmark. The model still rendered `配信` as
`출시` in the sample sentence. Evidence and the preserved smoke driver:
`test-results/browser/notion-glossary-real/report.json`,
`updated-native-glossary.png`, `smoke-source.mjs`. Initial setup/focus harness
failures are retained alongside the successful run.


### Glossary counterpart resolution correction

The resolver collected `기본형` marks and usage notes per concept across **all**
languages, so a Japanese name's mark made the identical Korean spelling variant
look canonical, and a Korean note overwrote the Japanese note for the same
spelling. `ChroNoiR`, `VΔLZ`, `桜魔皇国`, `Krisis` and twelve other concepts
therefore produced the wrong Korean counterpart or none at all. Marks and notes
are now scoped per language, and a third rule picks the candidate whose traits
match the source term's own register (`専門어` → `전문어`, not `설명형`).

Verification: typecheck and Chrome/Firefox builds passed. The matching test
file passed **17/17** and the full suite **670/670**; three regression tests
cover the cross-language mark, the source-language note and the register
tie-break. Against the shipped 1,886-entry dictionary, **48** term resolutions
changed (36 gained a counterpart, 12 changed it, none lost one); `ja→ko`
multi-candidate concepts went from 5 unresolved to 1.

Paired prompts were hashed with the model's own chat template: **61/61** captured
public sources render byte-identical prompts before and after the fix, so the
existing corpus is unaffected. An authored probe of the 15 affected terms was
run against two builds of the extension - one with the previous resolver, one
with the fixed resolver - on the real installed q4f16 GPU. **13/15** outputs
changed; the corrections move `ChroNoiR → 쿠로노와르`, `VΔLZ → 발츠`,
`企業勢 → 기업세`, `オフコラボ → 오프 합방`, `鳩 → 중계질`, `トワ様 → 토와사마`
and `てぇてぇ → 테에테에` into the Korean output instead of leaving the Japanese
spelling, a generic paraphrase (`企業 세력`) or the wrong sense
(`てぇてぇ → 정말 싫다고`).

Evidence: `test-results/browser/glossary-quality/ab-old.json`, `ab-new.json`,
`probe-affected.json`, `paired-results-fixed.json`. The probe sentences are
authored, not captured pages; it is a terminology slot comparison, not a
page-level quality or latency claim.

### Rejected: dictionary notes in the prompt's reference channel

The template's `glossary` parameter accepts exactly `source` and `target`
(`Each glossary entry must contain exactly source and target.`), so a term's
usage note cannot travel with its pair. Two one-call alternatives were built and
measured on the same 61-source corpus with the real q4f16 GPU, both sending the
notes through the template's `context` channel:

| form | outputs changed | worse | better | prompt growth |
|---|---|---|---|---|
| `source → target: note` lines | 12/15 (15-source probe) | 6 | 1 | 41 → 106 tokens |
| `[{"term","target","meaning"}]` JSON | 17/61 | 7 | 3 | +101 tokens median, ×3.06 prompt |

Structured JSON did not remove the failure mode: the Korean note text competes
with the pair itself. On `general-13` the model emitted `아카이브` although the
glossary pair said `다시보기`, and `official-01` produced `하나가 자매` for
`花芽姉妹` where the pair-only prompt produced `꽃눈 자매`. The reference channel
is documented as reference text, not per-term metadata, and a 0.8B translation
model does not separate the two.

Both experiments are reverted: no `context` parameter, no request field and no
`contextJson` export remain in the shipped code. A final headed run of the
shipped build on all 61 sources recorded **244** host calls, none carrying a
context field, **26** distinct glossary pairs sent, and **61/61** outputs
identical to the pair-only baseline.

Evidence: `test-results/browser/glossary-quality/paired-context.json`. The
notes are still used, but only host-side, to pick which pair to send.

## Declared page language and native settings sidebar

Automatic language enrollment reads the top document's `html[lang]`, then
`xml:lang`, then a Content-Language meta declaration when the preceding
attribute is absent. Empty/invalid/undetermined declarations do not enroll;
body-language guessing is not a fallback. Regional tags match their base
language. Cached declarations survive worker suspension and are cleared on
navigation; v2 language storage does not reuse the previous detector cache.
Manual OFF and target-language exclusions still win.

Settings open in Chrome's global Side Panel or Firefox's Sidebar directly from
the settings click, without a tab-bound path or translation switch. Unsupported
browsers retain the detached-window fallback; sidebar errors remain visible
rather than silently opening a different surface. Setup stays detached.

Verification: typecheck and both browser builds passed; background/UI unit
tests passed 60/60. Installed Chrome integration tests passed 17/17 with only
model inference/GPU capability substituted. The native SIDE_PANEL context,
unchanged browser-window count, settings saves after source-tab closure, and
360px panel layout were checked. Declaration tests cover `ja-JP` with an
English body, meta fallback, HTML precedence, missing/empty declarations and
manual OFF across reload. Evidence:
`test-results/browser/language-sidebar/options-native-sidebar.png` and
`extension-trace.zip` in the same directory. Firefox manifest and API dispatch
were checked, but its native sidebar was not exercised.


## Report-driven ONNX policy and reading-unit correction (0.1.13)

Release lifecycle fixtures supply model context/EOS metadata and emit the
prompt/generated-token streamer protocol. Clipping regressions require the
whole hidden source to be translated under the unchanged CSS clip; they do not
require an internal preview node to survive final handoff.

- No fabricated site/role hints, 40-character prompt switch, contextual retry,
  fixed source64 split, hint truncation, or blanket Han/kana rejection.
  The model tokenizer template receives only source text and requested languages.
- Rendered templates are encoded with `add_special_tokens: false`, including
  the document fallback. The previous worker prompt duplicated BOS (`1,1,16`);
  the model-native prompt starts `1,16`. See the upstream
  [chat-template warning](https://huggingface.co/docs/transformers/chat_templating).
- Exact tokenizer costs cover the complete prompt and output reserve, including
  emoji byte fallback. Model metadata and backend capacity bound admission;
  cap-ended output is not a completed translation. Empty/protocol/repetition
  guards remain, as do hardware limits.
- Inline prose is one source within its interactive owner, even at `maxTexts=1`.
  Ruby readings are excluded; clipping no longer truncates source. Identical
  model-approved names settle. Links and external edits retain ownership, and
  OFF restores original Text objects and strings.
- Inline emphasis has no guessed word alignment: original spans remain, but
  may become empty; translated prose uses a parent-owned Text where available.
- Kernels now round at FP16 projection, normalization, residual, activation,
  rotation and attention-output boundaries. Fused attention/reduction order
  still differs from ORT; bit-identical logits are not claimed.
- Verification: 359 focused Node cases passed across the initial run and two
  corrected assertions; all 53 onnxhost cases passed again after the BOS fix.
  Types, Chrome packaging, and all 53 real-browser DOM/clipping cases passed.
  Browser tests use deterministic providers and are not model-quality evidence.
- Real q4f16 replay: `onnx-policy-fix-FPIShT-policy02/report.json` under
  `test-results/browser/`. The emoji heading completed at EOS; `52` remained
  `52`; the opening instruction was no longer omitted; QuQu remained unchanged;
  the minne paragraph completed at EOS rather than exhausting the token cap.
  This small replay does not certify terminology or general translation quality.

### Installed-extension verification

`test-results/browser/onnx-policy-fix-FPIShT-live02/report.json`: original
q4f16, headed Chrome 143 / Apple WebGPU, eight slots, Japanese → Korean,
immediate rendering. Model installation and one warmup are excluded. This is
one sequential baseline/candidate pair, not a repeated latency distribution.

| Page | First observed settled state | Host translation requests | Result |
| --- | ---: | ---: | --- |
| Fixed 8-unit page, baseline | 0.639 s | 20 | Echo error; ruby and clipped suffix incomplete |
| Same page, candidate | 0.533 s | 8 | All units settled, full clipped source translated |
| BOOTH 4252664, candidate | 10.058 s | 170 | Translated; no host translation error |
| Nenkin pension-system page, candidate | 4.019 s | 70 | Translated; no host translation error |

Completion is sampled at 100 ms on the fixture and 1 s on live pages. The
baseline's failed completion is not a valid speed denominator. The fixture
uses 60% fewer model requests; large live pages still exceed three seconds.
Neither this fixture nor these two pages replace the earlier 60-page audit.

No committed-to-source reversion or host preview clear was observed during the
live pages' 30-second windows. Explicit OFF restored every connected tracked
Text: 22 fixture, 307 BOOTH, 612 Nenkin; zero mismatches. BOOTH's actual
BlendShapeClip paragraph retained `52`, and its FAQ heading completed.
Terminology remains imperfect (`unitypackage` can become `Unity`); no glossary
or site-specific correction was added. One BOOTH page error, `Uncaught (in
promise) #<Event>`, was recorded; its origin was not established. No host error
was recorded. Screenshots of the fixture and BOOTH were inspected.

The driver uses the real `SET_TAB_ENABLED` command, not native popup automation.
The first live attempt sampled before content-script injection and stopped;
`live02` adds an explicit injection-pending status. The first kernel diagnostic
also recorded a favicon 404; subsequent diagnostics serve it normally.
Diagnostic sources and the pre-change compiled modules are archived in
`test-results/browser/onnx-policy-fix-FPIShT-evidence/`.

## Earlier BOOTH description rollback correction (historical, unreleased)

- Target: `https://booth.pm/ko/items/4252664`, real headed Chrome 143,
  original PLaMo ONNX q4f16, Apple WebGPU, eight slots, default Aurora.
- Four of eleven Japanese description paragraphs displayed generated Korean,
  then discarded it. The host's script guard incorrectly classified the shared
  list bullet `・` (U+30FB) as kana because it matched an entire Unicode block.
  Both original/context-retry outputs were rejected; fragment cancellation
  cleared the uncommitted preview. No source DOM replacement or OFF command
  caused the rollback.
- At that stage, `plamo3.checkScript` identified Hiragana/Katakana by Unicode
  Script properties. The broader script guard is now removed as described above.
  That stage's Chrome build and 70 plamo3/onnxhost tests passed.
- Fixed build: all eleven tracked paragraphs retained Korean during a
  60-second observation, no remaining kana or committed-to-source reversions;
  explicit OFF restored all eleven exact source strings. Screenshot inspected.
  The diagnostic used the real `SET_TAB_ENABLED` command after native popup
  automation hit a window-focus error; it did not replace inference.
- This is a rollback fix, not a translation-quality pass: the model still
  omitted the opening unitypackage instruction, rendered `52` as `5`, and
  mistranslated some terms. The page-level echo error also remained.
- Evidence: `test-results/browser/booth-reversion-preview-trace/` (rejected
  Korean outputs) and `test-results/browser/booth-reversion-fixed/`
  (`verification.json`, `events.json`, `calls.json`, `body.png`).
  The published v0.1.12 package has not been replaced.

## ONNX-only cutover verification

- `npm run build` and `npm run verify`: Chrome/Firefox 0.1.11 packages passed,
  54 files each. Build compilation clears stale emitted modules before packaging.
- Targeted Node contracts: 245 passed, zero failures/skips across local,
  modelstore, modelflow, options, welcome, onnxhost, onnxweights, background and
  review-regressions tests. Unsupported stored models remain removable without
  automatic deletion of their bytes.
- Real q4f16 kernel smoke: context 128, widths 1/3/8, four output steps,
  logits captured, no WebGPU validation/page errors. Evidence:
  `test-results/browser/onnx-only-kernel/`.
- Actual built Chrome extension, ordinary Apple WebGPU, Japanese → Korean,
  eight slots, default Aurora display, warm model and fresh page cache:
  short-page 980.3 ms (8/8 units), article-page 2005.4 ms (4/4 units).
  Both completed below-fold content without scrolling and restored exact source.
  One run each is a smoke check, not a speedup claim or general three-second
  guarantee. Firefox inference was not exercised.
  Evidence and screenshots:
  `test-results/browser/onnx-only-extension/full-page-onnx-only.json`.

## Deterministic type, module and package checks

Use Node 24 or newer:

```sh
npm ci
npm run ci
```

This type-checks extension/tooling, validates assets and API boundaries, runs compiled production-module and host-monitor regressions, builds both packages and checks ZIP contents. The shared CI action also rebuilds and compares archive checksums.

Storage tests use native `Response` and `ReadableStream`. Host tests deliberately use a deterministic tokenizer and pipeline double. They establish platform contracts and lifecycle behavior, not original-model inference or performance.

Regression invariants cover Fetch/OPFS/IndexedDB failure cleanup; activation before retirement; epoch and source ownership; current-source restoration; strict inline alignment; partial completion; context-budget changes; invalid generated output; bounded caches and detached-node cleanup; tab discovery after background restart; standard Promise/raw Chrome callback messaging; and bounded Firefox preparation channels. A passing message-contract test does not establish Firefox native compatibility.

Explicit model preparation must validate an executable engine before selecting
a replacement. If native workers cannot start, it opens and warms the document
fallback; tokenizer-only readiness is insufficient. Failed preparation keeps
the previous selection and both stored model files recoverable. Ordinary page
translation still opens that fallback lazily.

## Actual browser / deterministic inference layer

```sh
npm ci
npm run build
npm install --no-save --package-lock=false --ignore-scripts playwright@1.64.1
npx playwright install --with-deps chromium
npm run test:browser
```

`dom.test.mjs` exercises actual DOM and MutationObserver with a scripted translator. `extension.test.mjs` installs an ephemeral copy of the package and tests actual extension APIs, service-worker restart, offscreen placement, settings, file selection and browser storage. Only that copy gets a deterministic inference implementation and capability fixture. Production files and release packages remain untouched.

For an existing Chromium executable, use `CHROMIUM_EXECUTABLE=/path/to/chromium npm run test:browser:dom`. `PLAYWRIGHT_MODULE` selects a driver module and `QA_DIR` selects the evidence directory. Do not bypass managed extension-installation policies; isolated Actions runners provide the separate extension test environment.

## Planner-only layer

`PLANNER_ENFORCE=1 node test/optimization/planner-audit.mjs` followed by `node test/optimization/check-budget.mjs` measures actual DOM eligibility/order and CPU overhead using identity responses. Every compiled module's SHA-256 and environment are recorded. These are not translations. See [the planner audit](optimization-audit.md).

## Original-model installed-extension layer

`npm run test:onnx` (`test/onnx-live/run-onnx.mjs`) installs the built extension, loads the
published q4f16 graph through the shipped download route and translates a real page in a real
Chromium with WebGPU. It replaces nothing: the service worker, the offscreen document, the host,
the messaging and the DOM layer are the production ones, and only the graph's origin is redirected
when `MODEL_DIR` supplies it from disk. See [actual installed-extension
verification](native-extension-testing.md) for the boundaries and the flags.

The decode engine's numbers are reproducible without the extension:
`npm run build && node test/engine-spike/run-spike.mjs` drives the shipped graph and tokenizer in a
real Chromium and writes `test-results/browser/engine-spike.json` (batched step cost against context
length, KV size, token parity against the library's own `generate`, and prefix alignment).
`node test/engine-spike/run-sustain.mjs` runs a pure decode loop and reports each browser process's
CPU time per step, which is how the CPU/GPU split above was taken (`STEPS=200` by default).
`MODE=parity TEXT='<sentence>'` on the same harness compares our kernels' greedy tokens with the
runtime's for a real prompt (and `MODE=gen` prints the translated text); `MODE=block`/`MODE=dump`
compare one layer against the debug graph. `PARAGRAPHS=32` widens the live fixture page (distinct paragraphs, so nothing is answered from the
page's cache); with `PAGE_PACKS` and `ENGINE_BATCH` it measures one page's cost at each decode-step
width. The batch curve lives in `docs/native-extension-testing.md`, "Batching".

`node test/engine-spike/run-gpuresident.mjs` is the
GPU-resident experiment: KV kept in GPU buffers
through IO binding, an ORT-proxy A/B, and the graph-capture attempt that documents why capture needs
a static-KV export. All three are measurement harnesses, not part of `npm test`.

Public YouTube QA is separate from the deterministic YouTube-like fixture. It must preserve
external sign-in/bot restrictions instead of logging in, bypassing controls or substituting pages.
Public-site observations and third-party warnings are not generalized to all YouTube sessions.

For comment scrolling and reply expansion on the actual site, run the installed
extension harness with an unpacked, unchanged release and a fresh profile:

```sh
UNSAFE_WEBGPU=0 HEADED=1 YOUTUBE_COMMENTS=1 \
  YOUTUBE_URL='https://www.youtube.com/watch?v=DBjiUz0H9HY' \
  EXTENSION_DIR=/absolute/path/to/unpacked/chrome-release \
  MODEL_DIR=weight/plamo-3-translate-0.8b-onnx \
  QA_DIR=test-results/browser/youtube-comments-DBjiUz0H9HY npm run test:onnx
```

`YOUTUBE_COMMENTS_REPLIES_ONLY=1` skips the initial down/up sequence and focuses
on reply expansion, loading more replies, scrolling back, and a second thread.
`YOUTUBE_COMMENTS_BURST=1` additionally moves down six times and up six times
at one-second intervals, followed by five seconds idle. Omit `EXTENSION_DIR`
to exercise the current local Chrome build rather than an unpacked release.
`youtube-comments.json` includes `slo` totals and source-length buckets:
whole-comment completion p50/p95, 1s deadline misses, unfinished/censored
viewport episodes, and visible backlog samples. The clock starts at observed
viewport entry after enable confirmation, not at first dispatch. Already-Korean
comments and cached-complete returns are separate populations, not fast passes.
Completion percentiles include completed episodes only; always report their
unfinished denominator too. `evidence.overhead` records mutation, sampling,
setup and API processing time. Busy presentation hosts are not GPU concurrency.

The scenario uses visible controls; modern nested replies may have no visible
collapse button. It records viewport cohorts, original-text changes, presentation
dispatch/commit events, content/host status and screenshots, then disables
translation and checks remaining component hosts. Dispatch is not GPU start.
First-result latency starts at the user action, excludes model installation,
and uses actual original-text changes, not component insertion. The current
observer excludes already-Korean units from waiting without counting them as
translations, and does not mark a settled partial component wholly complete.
Older v0.1.10 reports retained unchanged Korean units in their wait cohorts.
Unchanged names or links can still leave coverage conservatively incomplete.
An `observed` scenario status does not mean translation errors were absent.
See [the measured comment sessions](translation-performance.md#youtube-comment-sessions-v0110).

**Firefox on-device execution is unverified, not a known failure of this engine.** The older "preparation channel closed" report was measured on the MediaPipe host and its inference worker, both removed in 0.1.7, so it says nothing about the ONNX host that ships now. `test/firefox-native/released.mjs` installs the built add-on through Mozilla's GeckoDriver and records the adapter features, the host status and the browser error console; that is the run that would settle it. See [the T01–T16 ledger](review-qa-status.md) for the current distinctions.

## Release, evidence and limits

The current Chrome release workflow requires browser regressions, planner
acceptance, and the build action's type/unit/package and reproducibility checks.
The release records the archive SHA-256. Native-model smoke results remain
separate evidence; these gates do not certify original-model inference.
No Firefox archive is published; its on-device execution remains unverified.

No token or model file is committed. Authenticated browser traces/profiles are excluded from artifacts; text evidence is scanned before upload. Screenshots, sanitized logs, before/after HTML, installed-file inventories, environment and tested package hashes are retained.

Semantic translation quality, arbitrary websites, all GPU/backends and hours-long memory stability are not certified by these suites. Missing inline alignment falls back to independent fragments to preserve element ownership, not to prove fluency. Oversized inputs fail explicitly. Cancellation immediately stops DOM writes, while actual computation is separately supervised and bounded.

## Streaming translation presentation

Run the changed-region fade, exact-source ownership, cancellation, Unicode,
and port-routing regressions with the focused streaming suites:
`test/browser/streaming.test.mjs`, `test/dom.test.ts`,
`test/messages.test.ts`, `test/engine.test.ts`, `test/onnxhost.test.ts`,
and `test/engines.test.ts`.
Browser tests inspect animation progression rather than only CSS declarations.

For actual installed-extension token previews, use the current Chrome build:

```sh
UNSAFE_WEBGPU=0 HEADED=1 STREAMING=1 \
  MODEL_DIR=weight/plamo-3-translate-0.8b-onnx \
  QA_DIR=test-results/browser/streaming-fade-live npm run test:onnx
```

`STREAMING=1` also enables the aurora observation. The report's `streaming`
section records shadow preview events, source/canonical text, first-preview
and completion times, bounded fade-span counts, animation-frame intervals and
observer processing time. It requires actual previews before completion while
the original Text remains unchanged. The preview screenshot and the existing
pending/translated/restored screenshots are retained. These frame intervals
include screenshot/automation effects; they are not an isolated render-cost
benchmark or a controlled speedup comparison.

Optional `YOUTUBE_COMMENTS=1 YOUTUBE_COMMENTS_REPLIES_ONLY=1` additionally runs
the existing real-site reply scenario. Its whole-comment metric still observes
canonical committed text, not temporary shadow previews.

The deterministic installed-extension tokenizer double implements
`decode(ids, { skip_special_tokens: true })` with the same special-marker
removal as its generated full sequence. This keeps strict prompt extraction
under test rather than making the production host guess where an answer starts.

## Viewport / presentation stability regressions

The focused DOM, pipeline, targets and content suites cover offscreen active
commits, retained partial prefixes, parked-source resumption, failure parking
and exact restoration. Browser suites additionally cover semantic news/forum
layouts, unmarked cards, CSS order, nested overflow, clipped-source measurement
during final handoff, persistent aurora timelines across parked work, progressive
source-tail replacement, reduced motion and forced colors.

`test/browser/extension.test.mjs` exercises nested scrolling with the installed
Chrome extension: move away while a model response is held, complete that
offscreen source, translate newly visible prose, keep distant text parked,
return to the translated source, and restore all original Text identities.
Only inference is deterministic in this layer; it is not a model-speed test.

## Real public-site viewport matrix

```sh
SITE_MATRIX=1 UNSAFE_WEBGPU=0 \
  MODEL_DIR=weight/plamo-3-translate-0.8b-onnx \
  QA_DIR=test-results/browser/site-matrix-live \
  YOUTUBE_COMMENTS_BURST=1 node test/sites-live/run-sites.mjs
```

Uses the existing real model installation and unchanged Chrome package, then
observes Pixiv artwork, Reddit, a news article, a technical PDF, the same
paper's HTML version, and YouTube comments/replies. `SITES` selects matrix IDs
(`pixiv,reddit,news,technical-pdf,technical-html,youtube`); `PIXIV`, `REDDIT`,
`NEWS`, `PDF`, `TECHNICAL_HTML` and `WATCH` select public URLs.
Pixiv ranking links are followed by their observed href, including links that
normally open a separate tab. Access challenges are recorded, never bypassed.

`viewport-sites.json` records preview/commit timing, scroll phases, source
identity/restoration, errors and screenshots. It also counts observed aurora
animation object replacements and missing animation samples while translating
or partial; reduced-motion intentionally disables that animation. These samples
are not a measurement of compositor cost or proof of absence between samples.
HTML completion counts are dispatched Text nodes, not all page text or whole
comments; unchanged names
and tokens remain in the unfinished denominator. YouTube retains its separate
whole-comment viewport-episode SLO report. A PDF displayed by the browser is
not a translated document: zero requests/hosts is recorded explicitly.
The matrix is an observation runner, not a pass/fail gate; process exit zero
does not turn blocked, incomplete, or untranslated cases into successes.

## Reading policy and compact settings

Focused verification covers `rules`, `settings`, `options`, `background`,
`targets`, `pipeline`, `content`, `i18n` and `messages`: 209 distinct Node
cases passed across the initial run and corrected-case runs. Type checking
passed. Real Chromium DOM/extension scenarios passed 50/50 with deterministic
inference; these are not real-model latency measurements.

The scenarios cover semantic and generic columns in LTR/RTL, CSS multicolumn
flow, visible support ahead of prefetch, bounded explicit expansion, and
preservation of active aurora/source through scrolling. Background regressions
cover inactive-tab admission, manual OFF through navigation and worker restart,
stale language decisions, original-language caching, and automatic revocation.
URL matching includes single/deep wildcards, exact paths, query patterns,
scheme/port constraints and legacy migration.

The installed extension exercises URL-rule entry, source-language checkboxes
with native browser language detection, automatic translation, OFF override,
rule removal/restoration, and model import/replacement. Desktop and 390px-wide
settings screenshots and browser traces are in
`test-results/browser/reading-policy-settings/`. Browser startup required the
locally installed Playwright module and explicit Chromium executable.

No new public-site model benchmark was run for this policy/settings change.
Chrome and Firefox packages passed the packaging gate after the final locale
label correction; the 15 extension scenarios passed again on that build.

## Cancelled and parked aurora

`test/browser/dom.test.mjs` checks that a settled partial flow loses its gradient
and shadow after the bounded 180ms handoff grace, while preserving committed
text, original suffix and animation identity. Resume reuses the same animation.
Observed abort, explicit restore and failure clear busy presentation immediately;
stale callbacks and results cannot settle or remove a restarted presentation.
Scoped restore also settles cancelled active units outside the restored subtree.

`test/browser/streaming.test.mjs` checks paused surfaces are undecorated and
resumed surfaces are decorated, alongside existing phase/identity continuity.
The installed-extension OFF scenario covers immediate original-source restoration
while inference remains pending. A bare `shouldAbort` change is observed only at
existing callbacks/checkpoints; it does not provide a new cancellation event.

Visual evidence is saved under `test-results/browser/aurora-cancellation/`,
including `aurora-partial-stopped.png` and `aurora-partial-cancelled.png`.

Verification: type checking, 111 focused Node cases, and 71 distinct Chromium
browser cases passed across the initial run and corrected-case run. Four new
browser fixtures initially read requests before asynchronous sentence admission;
they now await actual admission before exercising cancellation. Both stopped
and cancelled screenshots were inspected: committed Korean prefix and original
English suffix remain without aurora tint. Chrome/Firefox packaging passed.
Inference was deterministic; this was not a live YouTube or throughput benchmark.

## Generic selection, idle prefetch and opt-in concurrency

Focused verification passed 384 distinct Node cases across the initial and
corrected runs (`settings`, `options`, `messages`, `local`, `engines`, `onnxhost`,
`engine`, `dom`, `pipeline`, `targets`, `i18n`, `content`, `background`).
Type checking and Chrome/Firefox builds and packaging verification passed.
The last corrected scheduling run passed all 143 cases in its four suites.

Chromium DOM, streaming and installed-extension scenarios passed 74 distinct
cases across the initial run and corrected-case run. They cover semantic
author/identifier exclusions without dropping short prose, dynamic source
cache reuse, bounded reading-unit continuity, explicit expansion precedence,
stable-idle offscreen admission, two independent visible units, settings
persistence and OFF cancellation of both outstanding requests. Inference in
these deterministic browser tests is a stand-in, not a throughput measurement.

The expansion regression exposed an unrelated active request consuming a
newly granted reader-intent turn; only work admitted under that same grant now
consumes it. Identifier filtering no longer treats arbitrary unprefixed
hexadecimal-looking prose or fragments as IDs. The content test clock now
advances to the earliest deadline rather than expiring five-minute transport
timeouts together with immediate scheduling callbacks.

Inspected UI evidence: `test-results/browser/reading-units-parallel/`,
including `options-parallel-enabled.png` and `parallel-visible-units.png`.
At the time of that run the setting was off by default. The source-token
rollout below changes new settings to two slots; explicit serial choices remain serial.

For real-model public-page observation with this option:

```sh
SITE_MATRIX=1 UNSAFE_WEBGPU=0 TRANSLATION_CONCURRENCY=2 \
  MODEL_DIR=weight/plamo-3-translate-0.8b-onnx \
  SITES=news,technical-html \
  QA_DIR=test-results/browser/reading-units-native \
  node test/sites-live/run-sites.mjs
```

The harness sets and saves the shipped checkbox and records its stored value.
This observes shared-session page behavior, not an isolated width-one versus
width-two throughput comparison.

### Real-model observation results

Chromium 143, real q4f16 weights, native `kernels` backend, shared session,
`translationConcurrency=2`; NASA news and arXiv HTML were opened sequentially
and scrolled down/up. Evidence: `reading-units-native/viewport-sites.json`.
These measurements precede the final prefixed-person-name exclusion correction.

| Page | Completed / dispatched Text nodes | Preview p50 | Completion p50 | Completion p95 |
| --- | ---: | ---: | ---: | ---: |
| NASA news | 35 / 40 | 216ms | 427ms | 5193ms |
| arXiv HTML | 49 / 55 | 191ms | 302ms | 7360ms |

Completion quantiles include only completed nodes and can include time parked
offscreen. These are neither whole-comment latencies nor a one-second SLO pass.
Both runs observed zero source reversions before explicit restore, zero aurora
animation replacements and zero missing-animation samples. All 40/40 and 55/55
observed sources restored exactly, with no remaining presentation hosts.
Translated screenshots were inspected; model quality is not established.

The content status reported unchanged-source output on both pages. The technical
page host additionally retained an `empty-output` error. NASA reported two page
JavaScript errors (`setLocaleData` and `jQuery is not defined`). These runs are
partial observations, not clean end-to-end passes.

Host snapshots reported prefill/decode 747.3/113.6 tok/s after NASA and
725.3/114.9 tok/s after arXiv. They are shared-session counters, not isolated
comparative benchmarks; prefill remains below the previously requested
1000 tok/s minimum. No twofold-speedup claim follows from admitting two units.

The live run also exposed author names in generated prefixed classes. Explicit
person/author/user/profile/display-name field tokens now match generic prefixes,
without adding host-specific selectors or skipping whole prefixed author
containers that also hold contribution prose. Names without reliable semantic
markers remain ambiguous and may still translate.

After the correction, the expanded generic browser regression passed. A fresh
public arXiv DOM check excluded all eight person-name fields while keeping all
eight author-note containers eligible. This was a selection check, not a second
model benchmark. Final type checking, both package builds and packaging
verification passed.

## Source chunk-budget experiment

```sh
CHUNK_BENCH=1 CHUNK_ROUNDS=4 UNSAFE_WEBGPU=0 TRANSLATION_CONCURRENCY=1 \
  MODEL_DIR=weight/plamo-3-translate-0.8b-onnx \
  QA_DIR=test-results/browser/chunk-budget-native \
  node test/sites-live/run-sites.mjs
```

`test/sites-live/chunk-benchmark.mjs` reuses the installed-extension model
setup, then calls the shipped `AT.engines.translate` in its service worker.
By default it compares the historical 64-character partition boundary with sentence-aware
64/128/256-source-token budgets, using actual host tokenizer counts rather than
a character/token ratio. It does not modify production scheduling defaults.
Each request contains one contiguous fragment of one source; this is not the
numbered multi-comment prompt experiment or a concurrency comparison.

Eight fixed English/Japanese comments and paragraphs are translated into Korean,
one source/request at a time. Every policy is warmed first. Four rounds rotate
policy order so each occupies each order position once. Full source partitions,
outputs, validation failures, progress resets, request timings and host counters
are saved to `chunk-benchmark.json`, including partial evidence if a run fails.
`CHUNK_CASES` selects comma-separated corpus IDs. The six original cases are
`short-comment,context-comment,long-comment,technical-paragraph,japanese-comment,japanese-article`;
`extended-technical,extended-japanese` each require more than 256 source tokens.

Source partition planning is offline and excluded from timed work. Normal
per-request engine counting, prompt creation, output validation and built-in
retries remain included. The configured input/output window stays unchanged;
the existing source-length-based answer cap still varies with fragment size.
No result cache is added, and no engine backend fallback counts as a valid run.

First preview means the engine's validated streaming callback, not a browser
paint. Completion covers every fragment, including failed fragments; completed
and valid are separate fields. Summaries include source tokens/elapsed second,
whole-source-valid tokens/elapsed second, and prefill/decode phase rates derived
from cumulative counter differences. This does not measure document discovery,
scroll scheduling, DOM presentation, cold startup or a whole-site SLO.
Automatic output checks are not semantic-quality scores; inspect the saved
translations for missing clauses, altered facts and cross-fragment grammar.

Recorded runs: the original six-source cohort is in
`test-results/browser/chunk-budget-native/`; the separate
`CHUNK_CASES=extended-technical,extended-japanese` run is in
`test-results/browser/chunk-budget-long-native/`. Each used four rounds, for
128 measured whole-source samples and 656 fragment requests in total, excluding
warmups. Both runs completed on native kernels. Automatic checks accepted every
fragment, but manual review found reproducible mid-sentence truncation in all
eight long-source samples at the 256-token budget. Treating those as translation
successes would be incorrect. See the source-budget experiment in
`docs/translation-performance.md` for timing, output examples and budget analysis.

### Same source: long requests versus short serial/parallel requests

```sh
CHUNK_BENCH=1 CHUNK_COMPARE=1 CHUNK_ROUNDS=4 UNSAFE_WEBGPU=0 \
  CHUNK_CASES=extended-technical,extended-japanese \
  MODEL_DIR=weight/plamo-3-translate-0.8b-onnx \
  QA_DIR=test-results/browser/length6-comparison \
  node test/sites-live/run-sites.mjs
```

This opt-in mode compares whole-source, 128-token and 64-token requests
serially, then reuses the exact same 64-token partitions at widths 2/4/8.
Each full source finishes before the next one starts. The total source is
identical in every condition, partitions preserve every character, and
parallel results retain source order. Width is an upper bound when fewer
fragments exist; `peakActive` records actual overlapping engine calls.

The shared model session uses a 2048-token context/output window in all
conditions. This differs from the historical 1024-window experiment above.
Normal source-length-based answer budgeting and validation remain enabled.
No glossary, preceding-chunk context, production scheduling or UI setting is
changed; widths 4/8 are capacity experiments. Warmups are excluded, adjacent
rounds reverse policy order, and each pair rotates its starting policy.

Use fixed-source `sourceTokPerSec` and full-source completion to compare
useful work. Splitting changes tokenization and repeats per-request prompts;
`chunkSourceTokens` records the former. Pure phase counters exclude mixed
steps and must not be mistaken for end-to-end throughput. Ordered first
preview and ordered first complete fragment refer to source fragment zero,
not a faster fragment farther down the document. These are worker callbacks,
not DOM paint. Saved source/output pairs still require semantic inspection.
The report also fingerprints the six installed engine modules.

## Whole-source pool and alternate-model comparison

```sh
POOL_BENCH=1 POOL_ROUNDS=2 UNSAFE_WEBGPU=0 TRANSLATION_CONCURRENCY=1 \
  MODEL_DIR=weight/plamo-3-translate-0.8b-onnx \
  QA_DIR=test-results/browser/pool-independent-native \
  node test/sites-live/run-sites.mjs
```

`pool-benchmark.mjs` shares the eight-source `CORPUS` with the chunk experiment.
It does not split sources: English and Japanese form separate fixed ordered pools
(five and three items). No glossary, page context or role hint is supplied.
Single-item requests are compared with whole-item packs capped at 256 or 512
source tokens and with the full language pool. A source larger than a pack cap
stays whole as its own request, and that exception is visible in saved plans.

The native context is physically fixed at 2048 tokens. Primary runs set the
host budget to 2048. A separate nominal-8192 diagnostic demonstrates the
difference between a host-request budget and the actual kernel capacity.
No context-size or production kernel change is made by this harness.

Actual host sub-batches, generation counts, first streamed text, full mapped
outputs, automatic output issues and cumulative token/rate snapshots are saved
to `pool-benchmark.json`. Current native WebGPU hosts use independent rows;
serial runtime fallback can use numbered output and per-source retries. One
outer call is not one generation. Review complete outputs for omissions even
when the returned item count matches. Published pure-phase counters exclude
mixed prefill/decode steps; compare whole-workload wall time as well.

Model comparison uses the same source text and target, not equal token counts:
tokenizers differ. Browser WebGPU PLaMo and native CPU STQ Hy-MT2 are different
execution stacks; their throughput difference cannot isolate model quality or
predict the speed of a future Hy-MT2 WebGPU port. Do not run the two performance
experiments concurrently on the same device.

The Hy comparison harness pins a producer-compatible STQ runtime and verifies
the official GGUF checksum. CMake, Ninja, a C++ compiler and network access
are required for preparation. Run separately from the browser benchmark:

```bash
bash test/model-comparison/prepare-hymt2.sh
HYMT_CONTEXT=2048 HYMT_ROUNDS=2 \
  HYMT_OUTPUT=test-results/model-comparison/hymt2/context-2048 \
  node test/model-comparison/hymt2-benchmark.mjs
HYMT_CONTEXT=8192 HYMT_KINDS=pool HYMT_ROUNDS=2 \
  HYMT_OUTPUT=test-results/model-comparison/hymt2/context-8192-pools \
  node test/model-comparison/hymt2-benchmark.mjs
```

The second run tests genuine larger native context and is not capacity-matched
to the extension's physical 2048-token kernel. Each run starts a loopback-only,
test-only native completion service and stops it in `finally`. Reports retain
full translations and stream events, EOS/limit reason, numbered-item coverage,
actual token counts, build/runtime flags and artifact hashes. Missing numbered
items and length-limited results must not count as successful throughput.
See the measured results and port requirements in
[`translation-performance.md`](translation-performance.md#whole-source-pool-experiment-without-glossary-context).

## Independent browser throughput and model roofline

```sh
CONCURRENCY_BENCH=1 UNSAFE_WEBGPU=0 TRANSLATION_CONCURRENCY=1 \
  MODEL_DIR=weight/plamo-3-translate-0.8b-onnx \
  QA_DIR=test-results/browser/concurrency-throughput-baseline \
  node test/sites-live/run-sites.mjs
node test/model-comparison/hymt2-roofline.mjs
```

The browser experiment runs the same eight whole sources as independent
requests with widths 1/2/4/8, two reversed-order warm rounds, unchanged output
budgets and no glossary/cache. It records installed script hashes, per-source
previews/completion/output, exact comparisons and mixed-counter limitations.
Widths 4/8 test engine capacity, not additional UI concurrency choices.

The roofline calculator performs no inference or GPU work. It requires the
checksum-pinned GGUF and saved Hy 2048 benchmark, computes mixed-quantization
traffic and unequal-output-length schedules, and saves all assumptions.
Its peak-bandwidth and utilization scenarios are not measured WebGPU rates.

## Kernel attribution and current-model TPS targets

```sh
PROFILE_DISPATCH=1 CURRENT_ONLY=1 LENGTHS=128,1024 BATCHES=1,8 \
  STEPS=16 REPEATS=1 UNSAFE_WEBGPU=0 \
  QA_DIR=test-results/browser/tps-profile-baseline \
  node test/engine-spike/run-kernels.mjs
node test/engine-spike/performance-roofline.mjs \
  test-results/browser/tps-profile-baseline/<printed-artifact>.json \
  test-results/browser/tps-roofline.json
```

Profiling explicitly negotiates `timestamp-query`, records each real compute
pass and calibrates a checked 256 MiB streaming read. It also saves exact
parsed matrix/scale/normalization/embedding bytes. This mode is intrusive:
do not use its throughput to accept an optimization. GPU timer quantization
requires aggregating passes; host `computeMs` remains queue-wait wall time.
Normal benchmark runs do not enable timestamps.

Use immutable source snapshots with `BASELINE_KERNEL` and `VARIANT_SHADERS`
for interleaved, equal-output-token A/B runs, without `PROFILE_DISPATCH`.
Inspect token comparisons as well as rates; a faster mismatching variant is
not automatically a winner. `CHECK_LOGITS=1 BATCHES=1,2 MODE=uniform`
additionally compares every active row's complete vocabulary logits. The
diagnostic rejects a final step that did not produce the full batch, rather
than comparing stale rows. Heterogeneous mode covers slot retirement/refill and
mixed prefill/decode; installed-extension corpus runs cover actual tokenization,
prompts and streamed translation. Never overlap GPU performance experiments.

The roofline report separates ideal peak-bandwidth bounds, measured-bandwidth
sensitivity scenarios, dense-equivalent compute requirements and engineering
targets. Batch aggregate TPS is not one request's TPS; no result claims whole
pages can complete within milliseconds.

### Packed decode and partitioned attention regression

```sh
QA_DIR=test-results/browser/tps2-attention-final \
  node test/engine-spike/run-attention.mjs
```

This model-free real-WebGPU check compares partitioned attention with an
independent CPU softmax reference. Cases cover partition tails, mixed cache
slots, scratch reuse after long/invalid rows, sliding windows, no-QK/no-V
ablations and large scores. It checks numerical values, not shader source
strings or the mere absence of errors. `ATTENTION_SOURCE` selects an isolated
candidate when experimenting; default is the production attention module.

Profiling now records initialization submissions separately in
`runs[].gpuInitialization`. GPU weight packing must not consume the first
inference step's timestamp record or enter decode throughput. Normal warm
step timings still exclude model load, pipeline creation and weight packing.

```sh
QA_DIR=test-results/browser/packed-gemv \
  node test/engine-spike/run-packed-gemv.mjs
```

The packed-GEMV regression executes the production packer, GEMV shader and
dispatch geometry on real WebGPU, without loading a model. Independent CPU
Q4 products check every output for widths 1–8, K up to 6144, partial
output tiles and the 4096-workgroup boundary. Sparse probes exercise signed
nibbles, different block scales and both ends of each quantization block.
Dense dyadic fixtures exercise every nibble/component and long accumulation
loops with exactly representable sums. Output canaries catch padded-tile
writes. The TypeScript parser exposes private
generators only in the test page; production has no test-only API.
`KERNEL_SOURCE` selects an experimental full kernel module.

Partitioned-attention tests exercise both production launch geometries:
`DECODE_HEADS_PER_GROUP` (2) and `DECODE_WIDE_HEADS_PER_GROUP` (4).
Seven query heads cover a full four-head group and a partially filled tail.
The 22 cases compare 59,136 output values, including partition/window tails.
The runner selects four-head sharing only for eight active attention rows
in the existing long-context partitioned path; smaller batches retain two.

### Frozen-build installed-extension comparisons

`test/sites-live/run-sites.mjs` accepts `EXTENSION_DIR` to install a frozen
built extension into its disposable profile without overwriting
`build/chrome`. The default remains `build/chrome`.

```sh
UNSAFE_WEBGPU=0 CONCURRENCY_BENCH=1 \
  EXTENSION_DIR=test-results/browser/matrix5-baseline/extension \
  MODEL_DIR=weight/plamo-3-translate-0.8b-onnx \
  QA_DIR=test-results/browser/matrix5-installed-baseline \
  node test/sites-live/run-sites.mjs
```

Run GPU benchmarks serially. Compare full outputs and installed-file hashes
before interpreting timings. The concurrency report additionally records
`items[].previewGapMs` and `summaries[].previewGapP90Ms`: intervals between
consecutive nonempty streaming callbacks after the first preview. These
measure callback delivery, not individual decoded-token intervals or DOM
paint. First-preview latency, pure phase TPS and full corpus completion
remain separate metrics; mixed-step time is excluded from the host's
published pure-prefill/decode counters.

### Japanese source-token rollout in the installed extension

```sh
PAGE_CHUNK_BENCH=1 UNSAFE_WEBGPU=0 \
  MODEL_DIR=weight/plamo-3-translate-0.8b-onnx \
  QA_DIR=test-results/browser/page-fragments \
  node test/sites-live/run-sites.mjs
```

This uses Japanese fixtures only, through the installed content script,
background and real model. English remains a supported application language;
it is excluded from this evaluation, not from language settings.
The harness compares one long paragraph and two visible reading units with
serial/two-slot settings. It verifies actual source-token counts at every
generation, page-wide concurrency, streaming presentation, exact restoration
after completion and cancellation, and saves screenshots/full outputs.
Token planning is included in page latency. One sample per condition is smoke
evidence, not a statistical speedup or translation-quality benchmark.

The application separates a bounded 480-character DOM work quantum from a
64-source-token model fragment. It prefers sentence boundaries, then words
and graphemes for oversized sentences. Visible reading units now share a
per-tab FIFO queue with at most two active generations, rather than reserving
one slot each until a whole DOM quantum finishes. Idle prefetch
remains serial. Out-of-order fragments stay hidden until a contiguous
source-order preview exists. Planning failure never falls back to estimated
character/token arithmetic on this interactive path.

### Scroll-stop to completed viewport translation

The primary latency is **completion of every eligible target visible at rest,
minus the timestamp of the last actual scroll event**. First token/preview
latency is not the acceptance metric. A quiet-period or `scrollend`
confirmation identifies the final viewport but must not move the start
timestamp forward or subtract its waiting time.

Freeze the measured cohort by source identity and visible geometry at rest.
Completion requires final committed translated text for every member, not
an aurora, partial prefix, dispatched request, or average of completed items.
Failed or unfinished targets stay in the denominator and fail the scenario.
New page mutations require a separately identified cohort; they must not
silently shrink or expand the original measurement.

Use Japanese-to-Korean fixtures, identical source and viewport geometry,
the same two-slot setting and a warmed real model for baseline/candidate.
Fresh-page runs must record work that started during scrolling and reject
precompleted targets. Scroll-away/back cache observations are reported
separately: a viewport already complete on return legitimately has zero
remaining translation latency. Cross-context request evidence uses aligned
epoch timestamps, not unrelated worker/page `performance.now()` origins.

Report per-run and per-target completion, incomplete counts, actual active
generation requests and full outputs. Three rounds support a median and
range, not a reliable tail percentile. Do not capture screenshots inside the
timed interval or mix cold model loading into warm scroll latency.

```sh
SCROLL_COMPLETION_BENCH=1 SCROLL_LABEL=baseline SCROLL_ROUNDS=3 \
  TRANSLATION_CONCURRENCY=2 UNSAFE_WEBGPU=0 \
  EXTENSION_DIR=/tmp/autotranslate-scroll-baseline/extension \
  MODEL_DIR=weight/plamo-3-translate-0.8b-onnx \
  QA_DIR=test-results/browser/scroll-completion-baseline \
  node test/sites-live/run-sites.mjs

SCROLL_COMPLETION_BENCH=1 SCROLL_LABEL=candidate SCROLL_ROUNDS=3 \
  TRANSLATION_CONCURRENCY=2 UNSAFE_WEBGPU=0 \
  EXTENSION_DIR=build/chrome \
  MODEL_DIR=weight/plamo-3-translate-0.8b-onnx \
  QA_DIR=test-results/browser/scroll-completion-shared \
  node test/sites-live/run-sites.mjs
```

Preserve the baseline build before rebuilding the candidate. The harness
saves installed-file hashes, the fixture hash, source/output text, complete
cohort geometry, actual scroll event timestamps and request intervals in
`scroll-completion-{label}.json`. It runs a short-comment/long-paragraph
cohort and a four-unit cohort in a fixed 1440×1600 viewport. Completed
scroll-away/back revisits and an in-flight cancellation/restore replay are
separate checks, not fresh completion samples.

### ONNX / GGUF comparison

Build the Chrome extension first. The installed comparison downloads the
local ONNX baseline, imports each GGUF through the real options file input,
warms eight Japanese→Korean requests, then measures single and eight-request
completion twice per format. It retains full outputs, source token-count
parity, backend identity, file hashes and options screenshots:

```sh
GGUF_COMPARE=1 GGUF_ROUNDS=2 UNSAFE_WEBGPU=0 \
  MODEL_DIR=weight/plamo-3-translate-0.8b-onnx \
  GGUF_DIR=weight/plamo-3-translate-0.8b-GGUF \
  QA_DIR=test-results/browser/gguf-installed \
  node test/sites-live/run-sites.mjs
```

`GGUF_QUANTS=Q4_K_M,Q4_0,Q3_K_M,Q2_K` selects the comparison files.
Models run in that fixed order after ONNX; case order alternates by round.
This is warm inference request completion, **not scroll-stop to final paint**.
Eight requests exercise engine capacity, not production page concurrency.

For equal-token workloads independent of generated translation length:

```sh
MODEL_FILE=weight/plamo-3-translate-0.8b-GGUF/plamo-3-translate-0.8b-Q4_K_M.gguf \
  CURRENT_ONLY=1 LENGTHS=128 BATCHES=1,8 STEPS=32 REPEATS=2 \
  PREFILL_POSITIONS=64 HEADLESS=0 UNSAFE_WEBGPU=0 \
  QA_DIR=test-results/browser/gguf-kernels-Q4_K_M \
  node test/engine-spike/run-kernels.mjs
```

Run each model serially with identical settings; concurrent GPU benchmarks
invalidate this comparison. Fixed-token prompts are synthetic, so this
test measures kernel throughput, not translation quality. It disables
EOS stopping and records host-observed queue completion, not GPU timestamps.

Independent packed-weight reference generation (separate Python environment
with `gguf==0.19.0` and NumPy installed):

```sh
python test/engine-spike/gguf-reference.py \
  weight/plamo-3-translate-0.8b-GGUF > /tmp/gguf-gold.json
GGUF_REFERENCE=/tmp/gguf-gold.json \
  QA_DIR=test-results/browser/gguf-numerics \
  node test/engine-spike/check-gguf.mjs
```

This samples real packed blocks from all seven formats in the provided
files and checks CPU decoding plus GPU GEMV/GEMM against `gguf-py`, not
against a second copy of the project's decoder. FP16 operand staging has
an explicitly rounded reference and separately reported full-precision
drift. Numerical equivalence of matrix operations does not establish
translation quality equivalence after quantization.

The Q4_K/Q6_K repack checks additionally cover N9/17 × K256/512,
exact quant codes and coefficients, poisoned padding, GEMV rows 1..8,
and GEMM rows 9/32/33/64/65. Both coefficient layouts, output-group
sizes and small-batch factorization settings are exercised; wide GEMM
requires shader-f16. Scaled error remains limited to 1e-4 and decoded
repacked-weight absolute error to 1e-6.

```sh
MODEL_FILE=weight/plamo-3-translate-0.8b-GGUF/plamo-3-translate-0.8b-Q4_K_M.gguf \
  CHECK_REPACK_LIFECYCLE=1 CURRENT_ONLY=1 HEADLESS=0 UNSAFE_WEBGPU=0 \
  QA_DIR=test-results/browser/gguf-parity-lifecycle \
  node test/engine-spike/run-kernels.mjs
```

Lifecycle mode skips timed inference. Every case uses a fresh real GPU
device and observes allocation/destruction without replacing buffer objects.
It checks preflight rejection, automatic direct selection, a failure after
head repack, exact matrix-byte accounting, disposal and error-scope closure.

Diagnostic variant options accept `ggufPacking: "auto"|"direct"|"repacked"`
and `ggufRepack` with exactly `coefficients: "f32"|"compact"`,
`outputsPerGroup: 8|16`, `factorSmallBatch: boolean`, `wideRows: boolean`.
Same-model variant token comparison failures make the benchmark process fail.
Batch/individual scheduling comparisons remain separately reported; the GGUF
parity gate compares direct/repacked results under the same schedule.
Different quantization models must run in separate processes.

Installed comparisons retain both imported models and alternate model order
per round. Every transition records prepare time and an excluded eight-request
warmup. Source counts, kernels backend, all requested completions, per-request
outputs and completion mean/median/min/max are retained; failures are not
dropped from the report.

For Q4_K_M kernel changes, preserve **both** `kernels.ts` and
`kernelgguf.ts` before editing. A baseline engine alone would otherwise
silently use the candidate's shaders:

```sh
MODEL_FILE=weight/plamo-3-translate-0.8b-GGUF/plamo-3-translate-0.8b-Q4_K_M.gguf \
  BASELINE_KERNEL=/tmp/autotranslate-q4km-baseline/kernels.ts \
  VARIANT_SHADERS='{"baseline":{"kernelgguf":"/tmp/autotranslate-q4km-baseline/kernelgguf.ts"}}' \
  LENGTHS=128 BATCHES=1,8 STEPS=32 REPEATS=3 PREFILL_POSITIONS=64 \
  CHECK_LOGITS=1 HEADLESS=0 UNSAFE_WEBGPU=0 \
  QA_DIR=test-results/browser/q4km-vector-ab \
  node test/engine-spike/run-kernels.mjs
```

This reverses variant order on alternate repeats and checks final
full-vocabulary logits outside the timed interval. Run the installed
comparison separately with `GGUF_QUANTS=Q4_K_M GGUF_ROUNDS=3` and
`EXTENSION_DIR` pointing to the preserved baseline build, then the
candidate build, with distinct `QA_DIR` directories. Keep the ONNX
control in both runs. Compare final translations as well as latency.
`PROFILE_DISPATCH=1` is a separate attribution run, never a throughput
result; its adapter wrapper must preserve limits as well as features.

### Isolated upstream WebGPU experiment

The wllama/llama.cpp comparison is a diagnostic artifact, not an added
production backend or a substitute for the ONNX parity gate. Its evidence
and source archive live in `test-results/browser/gguf-upstream-webgpu/`.
See `translation-performance.md` for the rejected-cutover verdict and
browser, sampling, context and timing limitations.

Reproduce on the recorded workstation (`/Users/hana/sources/Autotranslate`;
the archived harness contains these absolute paths). No runtime dependency
is installed into the project:

```sh
ROOT=/Users/hana/sources/Autotranslate
EXPERIMENT=/tmp/autotranslate-upstream-webgpu
mkdir -p "$EXPERIMENT"
(cd "$EXPERIMENT" && npm pack @wllama/wllama@3.13.0 --silent &&
  tar -xzf wllama-wllama-3.13.0.tgz)
tar -xzf "$ROOT/test-results/browser/gguf-upstream-webgpu/experiment-sources.tar.gz" \
  -C "$EXPERIMENT"
export UPSTREAM_QA_ROOT="$(mktemp -d /tmp/autotranslate-upstream-results.XXXXXX)"
cd "$ROOT"
node "$EXPERIMENT/compare.mjs"
node "$EXPERIMENT/analyze.mjs"
```

Use a fresh result directory so previous evidence is not overwritten or
mixed with new current-engine artifacts. The archive uses the preserved
`prompts.json`, current project kernels, and pinned wllama assets; hashes
of the measured assets/fixtures are in `verdict.json`. The optional prompt
generator requires isolated `gguf==0.19.0` and `tokenizers==0.22.1`.

The driver serializes all GPU work, alternates engine order over two
rounds, uses L128/512 × B1/8 and 64 outputs, and checks upstream prompt,
output and cache counts. `SUBGROUP_COMPAT=1` explicitly selects upstream's
existing workgroup-reduction GPU path; it does not patch shaders or use CPU
inference. Without it, the pinned build's subgroup shaders fail on Chrome
143. The archived current harness differs only in imports and text-derived
prompt fixtures; the production benchmark and runtime are unchanged.

For separate diagnostics, `run.mjs` accepts `LOAD_OPTIONS` (JSON),
`QUIET_NATIVE=1`, `LENGTHS`, `BATCHES`, `STEPS`, `BENCH=1` and `QA_DIR`.
`n_gpu_layers:0` was used only for a numerical CPU reference, never for a
WebGPU speed result. A resolved load promise is insufficient: require
`getLoadedContextInfo().success`. Generated-token differences are retained
as failures of runtime equivalence, not silently accepted or interpreted
as proof of which implementation is correct.

### Upstream per-dispatch bottleneck attribution

The separate `test-results/browser/gguf-upstream-bottleneck/` artifact set
uses the same pinned package, browser, GGUF and prompt fixtures as above.
Its `experiment-sources.tar.gz` contains `run.mjs`, `gpu-profiler.mjs` and
`summarize.mjs`. Extract into `/tmp/autotranslate-upstream-profile/` and
extract the wllama 3.13.0 npm archive there as `package/`. Retain the
original `gguf-upstream-webgpu/prompts.json`. From the repository root,
with the same `PLAYWRIGHT_MODULE` and `CHROMIUM_EXECUTABLE` environment:

```sh
SUBGROUP_COMPAT=1 BENCH=1 LENGTHS=128 BATCHES=1,8 STEPS=16 \
  QUIET_NATIVE=1 PROFILE_GPU=1 \
  QA_DIR=test-results/browser/gguf-upstream-bottleneck/profile \
  node /tmp/autotranslate-upstream-profile/run.mjs
SUBGROUP_COMPAT=1 BENCH=1 LENGTHS=128 BATCHES=1,8 STEPS=16 \
  QUIET_NATIVE=1 PROFILE_GPU=0 \
  QA_DIR=test-results/browser/gguf-upstream-bottleneck/control \
  node /tmp/autotranslate-upstream-profile/run.mjs
node /tmp/autotranslate-upstream-profile/summarize.mjs
```

The last command summarizes the retained `gpu-attribution.json`; it does
not regenerate that aggregate from a newly captured raw profile.
Raw reports retain per-dispatch timestamps, pipeline labels, matrix
dimensions, workgroups and host counters for independent aggregation.
Require empty profiler errors and exact profile/control token equality.
The observed runs satisfy both.

Per-dispatch timestamps split combined compute passes and therefore perturb
execution. Use this experiment for attribution, not as an interchangeable
replacement for the previous uninstrumented 64-output benchmark. Queue and
mapping wait durations overlap GPU execution; do not count them as exclusive
CPU time or add them to GPU time. Wall-minus-dispatch time also includes
copies, GPU gaps and instrumentation. No production files or permanent
benchmark dependencies are changed by the experiment.

### Rebuilt upstream baseline numerical gate

`test-results/browser/gguf-upstream-fix-g1fpWe/decision.json` records the
approved experiment's baseline-failure stop condition. The pinned
Emscripten 4.0.20 / Dawn build with `WLLAMA_TEST_BACKEND=ON` succeeded.
On actual Chrome 143 / Apple GPU, independent fixture replay failed
104/136 cases (all register-tile cases); all 32 GEMV cases passed.
Tolerance stayed `abs(actual-expected)/(1+abs(expected)) <= 1e-4`.
All values were finite, output guards intact, and GPU/capture errors zero.
No candidate patches or performance screening followed that failure.

The diagnostic archive contains `driver/run.mjs`, `compare.mjs`,
`gpu-profiler.mjs`, `check-matmul.mjs`, `summarize.mjs`, the build script,
and isolated environment settings. `baseline-esm.tar.gz` preserves the
matching worker/ESM/WASM build; `baseline-esm.sha256` lists its files.
`reference.json` preserves the eight gguf-py 0.19.0 fixtures.
Original failed runs remain intact, including the initial harness favicon
404; an explicit data favicon fixed that resource request without hiding
console errors. Canonical `/private/tmp` SDK/cache paths fixed the macOS
`/tmp` symlink-related system-library build failure without changing pins.

With the retained experiment checkout, rerun diagnostics into a **new**
directory; existing QA directories are rejected:

```sh
. /tmp/autotranslate-upstream-fix.g1fpWe/environment.sh
WLLAMA_ROOT="$EXPERIMENT/baseline" VARIANT=baseline \
  CHECK_MATMUL=1 QA_DIR="$RESULTS/numerics-$(date +%s)" \
  node "$EXPERIMENT/driver/run.mjs"
WLLAMA_ROOT="$EXPERIMENT/baseline" VARIANT=baseline \
  CHECK_BACKEND=1 QA_DIR="$RESULTS/backend-$(date +%s)" \
  node "$EXPERIMENT/driver/run.mjs"
```

CHECK modes are mutually exclusive with each other and GPU profiling,
and do not run performance loops. Package serving is confined to
`WLLAMA_ROOT`; missing ESM/WASM fails before measurement. Native INFO
is captured quietly with `suppressNativeLog:false, log_level:2` so
17/17 offload evidence is retained; the adjustment is recorded.

The backend check passed 185 WebGPU cases with unchanged upstream
tolerance (36 unsupported), capturing N5..9 and stride/broadcast cases.
This uses NMSE, not the independent fixture's per-output error gate.
The two-round same-baseline AB/BA L128/B1/output4 smoke passed exact
token matching in four independent browser processes. Invalid ROUNDS,
incompatible CHECK modes, and raw-report overwrite attempts were rejected.
Both diagnostic result screens were captured and opened for inspection.
These checks do not establish candidate correctness, speedup, ONNX
parity, or resolution of the upstream/current-engine token mismatch.

### Current GGUF single-row kernel screening

`test-results/browser/gguf-single-decode-vtpS5R/decision.json` records five
implemented but rejected single-row candidates. Production code is unchanged.
The actual headed Chrome runner compared baseline and candidate with
`LENGTHS=128,512 BATCHES=1 STEPS=64 PREFILL_POSITIONS=64 CHECK_LOGITS=1`,
using three repeats for scalar/32-lane reduction and five for Q6 factorization,
Q6 output-group sizing, and two-stage reduction. Variant order alternated.
All output tokens matched; final 107,520-value logits stayed within the
existing cosine/relative-L2 gates. GPU validation, page, and cleanup errors
were zero. Timing variation prevented an across-length improvement decision.

`lanes32-numerics/numerics.json` is the independent gguf-py 0.19.0 check for
the changed K-lane indexing: 49 direct, 16 repack, and 1,264 repacked matmul
cases passed. It includes padded outputs, Q4_K/Q6_K, widths 1–8, GEMM row
boundaries, both coefficient layouts, and existing configuration combinations.
Maximum normalized error was 1.038e-6, below 1e-4; guard words were intact.
Other rejected candidates received model token/logit checks, not separate
independent fixture suites.

`onnx-profile`/`gguf-profile` retain combined-pass timing; `onnx-dispatch`/
`gguf-dispatch` and `lanes32-attribution` use an isolated profiler that splits
passes around dispatches. Never use split-pass wall times as adoption gates.
The timestamp granularity also limits individual short-dispatch attribution.
`experiment-sources.tar.gz` retains baseline modules, candidate modules,
isolated runners/profiler, and the decision summarizer. The temporary working
scripts were removed after archiving. Existing repository runners were not
modified. These are synthetic fixed-token engine checks, not installed
extension translation latency measurements.


## Whole-page five-second benchmark

`test/sites-live/full-page-benchmark.mjs` uses the installed extension, shipped
options/import controls, and actual WebGPU inference. Run GPU benchmarks
serially in headed Chrome without unsafe WebGPU flags:

```sh
HEADLESS=0 UNSAFE_WEBGPU=0 FULL_PAGE_BENCH=1 \
  FULL_PAGE_LABEL=candidate FULL_PAGE_ROUNDS=1 \
  TRANSLATION_CONCURRENCY=8 \
  MODEL_DIR=weight/plamo-3-translate-0.8b-onnx \
  QA_DIR=test-results/browser/full-page-candidate \
  node test/sites-live/run-sites.mjs
```

Set `PLAYWRIGHT_MODULE` and `CHROMIUM_EXECUTABLE` when using an existing local
driver/browser. `EXTENSION_DIR` selects a frozen build; the default is
`build/chrome`. The runner imports only GGUF Q4_K_M and the existing ONNX
q4f16. `FULL_PAGE_MODELS=onnx,gguf` selects both. Model files are local test
inputs; the product does not depend on the fixture/model HTTP servers.

The frozen three-page corpus includes below-fold text and never scrolls to
trigger completion. Timing starts at the enable control's click event and
ends after all target paragraphs have final canonical translations and two
animation-frame opportunities. Screenshots are taken afterward. The report
retains original/final text, exact Text-node restoration, protected-source
checks, request times, peak generation admission, build/model identifiers,
fixture hash, errors, and every five-second miss. Korean/nonempty checks do
not prove semantic fidelity; compare complete outputs separately.

`FULL_PAGE_STATE=cold` unloads the resident model before each timed click.
This includes model/GPU initialization from installed files, not downloading
or an OS-cache-cold first installation. Default `warm` uses a distinct
warmup sentence and fresh page-local translation caches.
`FULL_PAGE_TIMEOUT_MS` bounds observation, not generation length.
`FULL_PAGE_ALLOW_INCOMPLETE=1` preserves failed baseline observations without
failing the runner; never interpret its process exit as correctness.

The options select supports 1/2/4/8 simultaneous generations. New settings
default to eight; saved serial/two-slot choices are preserved. Production
now drains all eligible finite-page sources, including offscreen support,
while hidden/editable/protected/clipped sources remain excluded or deferred.
The explicit viewport-only pipeline API remains covered separately.

Verification for `page5-S35gTt`: extension/tooling type checking passed;
305 distinct focused Node cases passed across the initial and corrected runs
(`settings`, `options`, `background`, `engines`, `content`, `pipeline`, `dom`,
`onnxhost`). Chrome packaging passed. Chromium DOM/installed-extension
regressions passed 59 distinct scenarios across initial and corrected runs.
The three browser corrections select serial execution explicitly for serial
ordering scenarios and use explicit translation restart to retry parked
failures; unrelated mutation refresh must not silently clear those failures.
The options unit correction avoids retaining a previous synthetic global
context after reopening the page.

Actual-model adoption evidence is `paired-final/`, not those deterministic
browser fixtures. Five alternating build pairs cover both fixed models and
all three complete pages. An initially fast candidate was rejected for a
changed technical meaning; the retained token-plan candidate was compared
using complete output strings. Settings and final-page screenshots were
inspected. See the [full measurements](translation-performance.md#whole-page-completion-fixed-q4f16--q4_k_m)
for every five-second miss and first-preview tradeoffs.

### GGUF page bottleneck diagnostics

`test-results/browser/gguf-profile-YuoErb/` retains a separate Q4_K_M
investigation of the current eight-slot page path. Diagnostics run only in
copied extension builds; production kernels, prompt planning, token limits,
EOS handling and shader arithmetic are unchanged.

Four modes distinguish measurement effects:

- `control`: capture job prompt/output IDs, without `onStep` or GPU queries.
- `step`: existing step wall/encode/completion/readback timing, plus CPU
  embedding-row decode and buffer-write counters.
- `pass`: step diagnostics and GPU timestamps preserving compute-pass grouping.
- `dispatch`: split each dispatch into a timestamped pass for operator
  attribution. This changes GPU command grouping and is not production latency.

Three serial browser rounds alternate mode order across the same complete
short/article/English pages. GPU jobs never overlap. Compare exact prompt and
output token arrays as well as final page strings; retain differences rather
than assuming instrumentation is semantically invisible. Warmup/reset and
trace collection occur outside the click-to-final-paint interval.

`computeMs` includes queue/browser completion delay; it is not GPU execution
time. Do not add it to GPU timestamps. GPU timestamps observed on this browser
are quantized in 65.536 microsecond increments: a zero-duration small dispatch
does not mean free work. Aggregate operators across a page, and compare the
pass-preserving mode before attributing split-pass overhead to the model.
Prefill active rows count input positions, whereas pure-decode active rows
count simultaneous sequences. Eight admitted requests do not imply eight
active decode rows throughout a page.

The diagnostic worker initially failed because a nested GPUDevice proxy
forwarded a native setter with the wrong receiver. Failed setup reports are
retained; the isolated proxy fix forwards setters to the native device.
Only successful complete-page measurements qualify as timing evidence.

Completed evidence: all 36 controlled page runs finished, restored, and
matched exact prompt/output token arrays and final strings across modes.
The nine controls met five seconds in this batch; two pass-profiled pages
did not. This does not supersede the earlier warm misses. GPU pass-duration
sums sometimes exceed timestamp spans; the retained negative
`betweenPassMs` values must not be interpreted as idle time.
`analysis.json` and `report.json` contain phase, operator, decode-width and
repeat-count aggregates. `experiment.json` records provenance and limits;
`diagnostics-and-drivers.tar.gz` preserves the isolated build and scripts.
Disposable working copies were removed. Production sources/builds were
not modified for this investigation, and no unrelated suite was rerun.

### Immediate rendering and isolated Q4_K_M candidates

Evidence: `test-results/browser/gguf-opt-uQVBRj/`. The retained product
change is the localized `translationRendering` setting and its live
content-renderer propagation; production model kernels remain unchanged.

Validation covers Aurora as the default, persistence and invalid-value
normalization, the options control, background propagation, and applying
immediate mode while inference is gated without starting another session.
Immediate previews must update synchronously; final canonical text must
not wait for a fade or preview handoff. Switching modes, partial and
nonstreaming output, restoration, original Text identity, links,
accessibility, cancellation and mutation handling remain covered.

- `npm run typecheck` and `npx tsc -p tsconfig.json` passed.
- Focused settings/options/background/content tests: 131 distinct tests
  passed across the initial run and the corrected targeted rerun. One new
  live-update assertion initially ran before the runtime message handler's
  documented microtask; the test now drains that microtask while keeping
  inference unresolved. No production behavior was changed for that fix.
- The real-browser streaming/DOM suite passed 63/63 tests.
- `npm run build:chrome` passed and produced the Chrome extension package.
- Five alternating renderer-only rounds used supplied text, not inference,
  and verified immediate synchronous rendering and exact restoration.
  Streaming screenshots were captured and the immediate surface inspected.

Isolated GPU checks preserve failed runs as well as successful ones:
1264 independent-reference repacked matrix cases; paired FFN, output-head
and Q/K-fusion checks; heterogeneous scheduling comparisons. A missing
reference-fixture field and an existing logits check that requires a full
uniform final batch are documented rather than counted as numerical passes.
The length-aware candidate's token mismatch is a failed acceptance check,
not a performance improvement eligible for release.

The installed-extension page driver uses the actual rendering settings
control and Save action. It records both canonical DOM completion and
fully opaque final text after finite animations and two animation frames.
The latter is the visible five-second metric. All eligible below-fold
source is included without scrolling; protected content, exact final
strings and original Text restoration are checked. First model progress
and first visible preview are separate timestamps because fragment
reading order can delay display independently of animation.

The final paired experiment completed 30/30 pages across five alternating
rounds, with exact final-string parity and restoration throughout. Visible
five-second acceptance was 15/15 for immediate and 11/15 for Aurora; all
four Aurora misses remain recorded. The immediate settings control and
full translated article screenshots were inspected. These results apply
to the fixed warm fixtures only, not arbitrary page lengths or cold load.
`experiment.json`, `animation-paired/comparison.json`, validation logs,
candidate sources/drivers and copied extension builds retain provenance.

### Japanese-only three-second bottleneck measurement

The current target is **three seconds to complete and visibly display the
entire fixed Japanese page**, including eligible below-fold content.
English is excluded from this measurement. The existing Japanese short
and article fixtures are unchanged; the target language remains Korean.
Use resident GGUF Q4_K_M, eight generation slots and immediate rendering.
Do not reduce source coverage, generation limits or precision to meet the
target. Cold-start time is outside this warm acceptance metric.

`test-results/browser/gguf-ja-profile-QlzzmQ/` records three independently
launched browser repetitions of each mode, running GPU work serially:

- `plain`: current extension copy without worker profiling hooks; page
  DOM/host timestamps still observe the enable-to-visible interval.
- `step`: model-step encode/completion/readback timing, prompt/output
  tokens, CPU embedding decode and buffer-write/allocation counters.
- `pass`: GPU timestamps preserving existing compute-pass grouping.
- `dispatch`: one timestamped pass per dispatch for operator attribution;
  its wall time is diagnostic, not production acceptance.

Each mode runs only `short-page,article-page`; the driver asserts Japanese
fixtures, immediate rendering, the kernel backend and a 3000ms goal.
Record every attempt and every three-second miss. Compare final strings
across all modes and prompt/output token arrays across instrumented modes;
plain runs deliberately have no worker token-capture hooks. GPU timestamp
quantization and profiling overhead must accompany operator percentages.
No production kernel or translation behavior changes are part of this
measurement.

Completed: 24/24 pages restored and matched final strings; all 18
instrumented prompt/output comparisons matched. Plain short-page
acceptance was 3/3 under three seconds, article 0/3. The Japanese article
screenshot was inspected. `analysis.json` and `report.json` preserve
phase/operation/occupancy details, timer-resolution limits and run-to-run
variability; `diagnostics-and-drivers.tar.gz` preserves exact measurement
inputs. No build or unrelated test suite was needed for this isolated
investigation.

### Per-job final-logit diagnostics

`test/engine-spike/run-kernels.mjs` with `CHECK_LOGITS=1` now compares the
final logical output step of each job, identified by job ID and step.
It no longer assumes that the last model step contains every batch row:
prefill can finish on different steps at widths three, five and seven.
Missing or duplicate captures fail the diagnostic.

Captures run in a separate untimed replay, whose generated tokens must
equal the timed run. Reported throughput and step samples exclude that
replay. Cosine ≥0.99999 and relative L2 ≤0.005 remain unchanged.
`gguf-ja-opt-zfaux8/logits-collector/` verified identical source snapshots
at L128/512, B3/5/7 and 64 output tokens: 12 runs, six comparisons,
identical tokens and zero measured logit difference. Timing differences
between these identical implementations are not optimization gains.

### Japanese Q4_K_M candidate acceptance results

`gguf-ja-opt-zfaux8/` implements the ordered FFN→head→normalization→RoPE→
SiLU experiment without changing production kernels. Accuracy precedes
performance: independent scaled error ≤1e-4, exact generated-token parity,
then the unchanged final-logit thresholds. The normalization candidate
demonstrates why isolated numerical agreement alone is insufficient:
its real-model output diverged and its screen was stopped.

Promoted candidates use five AB/BA page pairs plus three baseline runs at
each end. Acceptance requires article median ≥5% faster, at least four
pair wins, short-page regression ≤3%, baseline bracket drift ≤10%, and
identical complete translations/restoration. Each inconclusive candidate
gets at most one fresh-session retry. No-scroll assertions remain strict;
the two failed baseline retries at scrollY 552.5 are preserved, not repaired
by scrolling back or omitted from the record.

Neither RoPE nor SiLU passed this gate. No production optimization or
final ten-pair acceptance is claimed. See `outcome.json`,
`kernel-summary.json`, the per-candidate raw reports and
`diagnostics-and-candidates.tar.gz` for decisions and reproducible inputs.
Only the diagnostic collector repair is retained; its B3/5/7 same-source
proof above exercises the changed path. No unrelated test suite was run.

### Quantized GEMV lifetime / narrow pass screen

`test-results/browser/gguf-gpu-focus-aw4MHw/` records two isolated candidates
against the frozen custom-engine baseline (`current` in raw reports).
Independent gguf-py fixtures caught an initial shader-local shadowing error;
the failure is retained. The corrected shader passed 49 direct cases,
16 repack checks and 1264 repacked matmul cases with unchanged 1e-4 tolerance
and output guards.

The actual headed browser ran L128/512 × B1/3/5/7/8 × output32 × three
alternating repetitions for all three variants: 90 timed runs, with
final-logit diagnostic replay outside timing. All generated-token
comparisons and final logits matched; GPU/page/cleanup errors were empty.
Neither candidate met its predeclared performance promotion gate.
Consequently, no all-width64 or installed-page acceptance was run and no
production kernel/build changed. `experiment-sources.tar.gz` contains the
candidate sources, independent fixture, isolated checker, analysis and
reproduction commands; `outcome.json` records limitations and rejection.

### ONNX q4f16 K-block scheduling candidates

`test-results/browser/onnx-opt-D79eDb/` contains isolated next-block
word/scale lookahead and two-block outer-loop candidates. Each ran the
existing packed-GEMV numerical fixture set in headed Chrome: 12 cases,
991,778 compared outputs, zero absolute error and unchanged canaries.
No tolerance or fixture was weakened.

The fixed-work model screen covered L128/512, B1/3/5/7/8, output32 and
three alternating repetitions: 90 model runs, 90 pairwise token comparisons,
identical final logits and no GPU/page/cleanup errors. Neither candidate
passed its predeclared 5% geometric-mean gain / 3% maximum-regression gate.
Therefore no all-width64 or installed-page promotion test was run.
Production sources/builds are unchanged. The archive retains both source
candidates, frozen baseline, isolated numerical runner, analysis and
reproduction commands; model/source hashes are in `inputs.sha256`.

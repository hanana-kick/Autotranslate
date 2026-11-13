# Validation contract

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

The actual-server gate runs `test/server-extension/e2e.mjs` against a real
OpenAI-compatible model server with the untouched installed Chrome package.
Dynamic-text checks retain the page-owned `Text` handle before translation:
the paragraph's first child may become an inline presentation component.
They mutate that same text node, verify its new translation, then require
current-source restoration and original-node identity.

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
acceptance, actual installed-extension server-mode QA, and the build action's
type/unit/package and reproducibility checks. The published archive must match
the server-tested package byte for byte. Native-model smoke results are separate
evidence, not certification supplied by that server run. No Firefox archive is
published; its on-device execution remains unverified.

No token or model file is committed. Authenticated browser traces/profiles are excluded from artifacts; text evidence is scanned before upload. Screenshots, sanitized logs, before/after HTML, installed-file inventories, environment and tested package hashes are retained.

Semantic translation quality, arbitrary websites, all GPU/backends and hours-long memory stability are not certified by these suites. Missing inline alignment falls back to independent fragments to preserve element ownership, not to prove fluency. Oversized inputs fail explicitly. Cancellation immediately stops DOM writes, while actual computation is separately supervised and bounded.

## Streaming translation presentation

Run the changed-region fade, exact-source ownership, cancellation, Unicode,
SSE framing and port-routing regressions with the focused streaming suites:
`test/browser/streaming.test.mjs`, `test/dom.test.ts`,
`test/messages.test.ts`, `test/engine.test.ts`, `test/onnxhost.test.ts`,
`test/engines.test.ts` and `test/server.test.ts`.
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

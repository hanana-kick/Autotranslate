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

**Firefox on-device execution is unverified, not a known failure of this engine.** The older "preparation channel closed" report was measured on the MediaPipe host and its inference worker, both removed in 0.1.7, so it says nothing about the ONNX host that ships now. `test/firefox-native/released.mjs` installs the built add-on through Mozilla's GeckoDriver and records the adapter features, the host status and the browser error console; that is the run that would settle it. See [the T01–T16 ledger](review-qa-status.md) for the current distinctions.

## Release, evidence and limits

Publication requires browser regression, planner acceptance, native Chrome and native Firefox success, followed by the build action's type/unit/package checks. Main integration is not permission to publish a package with a failed native gate.

No token or model file is committed. Authenticated browser traces/profiles are excluded from artifacts; text evidence is scanned before upload. Screenshots, sanitized logs, before/after HTML, installed-file inventories, environment and tested package hashes are retained.

Semantic translation quality, arbitrary websites, all GPU/backends and hours-long memory stability are not certified by these suites. Missing inline alignment falls back to independent fragments to preserve element ownership, not to prove fluency. Oversized inputs fail explicitly. Cancellation immediately stops DOM writes, while actual computation is separately supervised and bounded.

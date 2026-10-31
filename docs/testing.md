# Validation contract

## Fast deterministic checks

Use Node 24 or newer. `npm ci && npm run ci` type-checks extension and tooling,
validates assets/catalogues/API boundaries, runs production-module regression
suites, builds both browser packages and verifies ZIP contents. The existing
shared CI action additionally rebuilds archives and compares their checksums.

The new regression suites load **compiled production modules**, not copied
implementations. The storage tests use real `Response` and `ReadableStream`;
model-host tests inject a deterministic runtime implementing the MediaPipe API.
They are protocol/lifecycle tests, not real-model benchmarks.

Covered invariants:

* native Fetch stream contract, partial file cleanup and selection-before-retirement;
* successful warmup before model activation; failed replacement preserves the old file;
* immediate cancellation acknowledgement and per-session invalidation of late results;
* compare-before-write protects a page's own edits;
* strict inline markers or per-node fallback, never length-based redistribution;
* partial paragraphs remain incomplete and retry from their original source;
* completed nodes and requested strings are different counters;
* changing the model/token budget recreates the runtime as necessary;
* over-budget single inputs fail explicitly instead of silently truncating;
* timed-out native instances are disposed before reuse;
* detached-node cleanup and bounded, context-scoped translation caching;
* policy propagation finds tabs after worker restart and does not wait serially per tab.

## Real Chromium automation

```sh
npm ci
npm run build
npm install --no-save --package-lock=false --ignore-scripts playwright@1.57.0
npx playwright install --with-deps chromium
npm run test:browser
```

`Browser regression` runs on pull requests and main. The Release workflow also
calls it and **cannot publish until it passes**. Screenshots, Playwright trace
and TAP results are Actions artifacts. The extension lifecycle suite does not
skip itself when Chromium fails to load an extension: that is a failed check.

`dom.test.mjs` exercises actual DOM nodes and MutationObserver with a scripted
translator. `extension.test.mjs` exercises actual Chrome service-worker lifetime,
offscreen-document placement, extension messages, injection, settings, native
Fetch responses, OPFS and IndexedDB, plus installation through the file picker.
It explicitly terminates and restarts the service worker via CDP.

The extension suite **copies** `build/chrome` to an ephemeral directory. Only in
that copy, it installs a deterministic MediaPipe API double and a GPU-capability
fixture. This enables reproducible CI without gated multi-gigabyte weights or a
GPU. `src/`, release archives and the production capability check are unchanged.
A one-megabyte fixture file is not represented as a genuine working AI model.

For an existing Chromium executable:

```sh
CHROMIUM_EXECUTABLE=/path/to/chromium npm run test:browser:dom
```

`PLAYWRIGHT_MODULE` can name an already installed Node Playwright module;
`QA_DIR` sets the evidence directory. Managed browser policies may prohibit
extension loading. Do not disable those policies: run DOM-only tests there and
run the extension suite on the isolated CI runner instead.

## What these checks do not certify

Passing CI does **not** establish TranslateGemma translation quality, real GPU
backend selection, speed, peak memory, multi-gigabyte download reliability or
Firefox runtime execution. Firefox is type-checked, built and package-verified,
not exercised by the Chromium suite. Historical README timings are not rerun by
these tests.

Before a hardware/model performance claim, install the real gated `.task` model
in an unmodified package, record browser/OS/GPU/runtime versions and model hash,
then verify real EN/JA to KO samples, long and inline-rich pages, cancellation,
model replacement, worker restart, memory release and forbidden external
translation traffic. Record actual measurements separately from deterministic
CI results. No Hugging Face credential is embedded in the repository or CI.

## Deliberate safety tradeoffs

Missing/malformed inline markers fall back to independent node translations.
This preserves link ownership at the cost of some fluency; valid markers are
not proof of linguistic correctness. A single input that still cannot fit its
token budget is reported as `context-overflow`; the original remains intact.
Cancellation immediately prevents writes and returns control to the user; it
does not promise that a native runtime can physically abort computation.

# Validation contract

## Deterministic type, module and package checks

Use Node 24 or newer:

```sh
npm ci
npm run ci
```

This type-checks extension/tooling, validates assets and API boundaries, runs compiled production-module and host-monitor regressions, builds both packages and checks ZIP contents. The shared CI action also rebuilds and compares archive checksums.

Storage tests use native `Response` and `ReadableStream`. Host tests deliberately use a deterministic MediaPipe API double. They establish platform contracts and lifecycle behavior, not original-model inference or performance.

Regression invariants cover Fetch/OPFS/IndexedDB failure cleanup; activation before retirement; epoch and source ownership; current-source restoration; strict inline alignment; partial completion; context-budget changes; invalid generated output; worker termination and bounded recovery; bounded caches and detached-node cleanup; tab discovery after background restart; standard Promise/raw Chrome callback messaging; and bounded Firefox preparation channels. A passing message-contract test does not establish Firefox native compatibility.

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

`test/dynamic-extension/run-dynamic.mjs` extends the native installation/onboarding driver with dynamic DOM and multitab scenarios. It does not replace the application's inference engine, model, capability detection or extension messaging. The real SDK/model and installed-file/package hashes are checked. On macOS the released Chrome for Testing distribution is pinned and verified by the repository action; Firefox uses its official distribution and Mozilla WebDriver separately.

The reusable `native-extension.yml` requires five fresh hardware profiles. Static cases, dynamic changes, in-flight edits, restoration and bounded multitab endurance must all pass. One profile performs 25 repeated update rounds; the others perform five. A canceled/blocked/failed run cannot be counted as a pass.

Public YouTube QA is separate from the deterministic YouTube-like fixture. It must preserve external sign-in/bot restrictions instead of logging in, bypassing controls or substituting pages. Public-site observations and third-party warnings are not generalized to all YouTube sessions.

**Firefox native preparation remains a known failure, not merely an untested package.** Its official-runtime evidence and acceptance criteria are in [issue #2](https://github.com/hanana-kick/Autotranslate/issues/2). The separate native Firefox workflow is a release prerequisite. See [the T01–T16 ledger](review-qa-status.md) for the current distinctions.

## Release, evidence and limits

Publication requires browser regression, planner acceptance, native Chrome and native Firefox success, followed by the build action's type/unit/package checks. Main integration is not permission to publish a package with a failed native gate.

No token or model file is committed. Authenticated browser traces/profiles are excluded from artifacts; text evidence is scanned before upload. Screenshots, sanitized logs, before/after HTML, installed-file inventories, environment and tested package hashes are retained.

Semantic translation quality, arbitrary websites, all GPU/backends and hours-long memory stability are not certified by these suites. Missing inline alignment falls back to independent fragments to preserve element ownership, not to prove fluency. Oversized inputs fail explicitly. Cancellation immediately stops DOM writes, while actual computation is separately supervised and bounded.

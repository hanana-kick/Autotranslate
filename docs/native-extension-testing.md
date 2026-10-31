# Actual installed-extension verification

## Acceptance boundary

The authoritative test is `test/native-extension/real-extension.mjs`. It installs the built Manifest V3 extension in a fresh persistent Chromium profile and operates its shipped onboarding and Options UI. The service worker, offscreen document, inference Worker, locked `@mediapipe/tasks-genai@0.10.30` JavaScript/WASM assets, and default `translategemma-4b-it-int8-web.task` are real. There are no synthetic translation responses, capability replacements, production-module injection, external inference services or native bridges.

The test asserts:

1. The actual extension service worker and onboarding load.
2. The authenticated original model downloads, is stored and completes real warmup (3,896,377,344 bytes).
3. The basic HTML page is translated through the extension; the real host generation counter increases.
4. Disabling the extension through Options restores exact original HTML, text, attributes and element identities, and preserves the click handler.
5. The inline article's title, prose and link text are translated; code, input value and link destination are retained.
6. The inline article also restores exactly through the real UI.

Both page cases must pass. A readiness probe or a successful unit test is not an end-to-end pass. Failure produces a nonzero exit and retains its evidence. The same fresh-profile test runs twice independently in the maintained workflow.

## Verified execution environment

The initial successful complete execution was the macOS job in Actions run `41202819104` (artifact `13042989173`). It used an Apple M2 Pro (Virtual) runner, Chromium 143.0.7499.4, an actual Apple WebGPU adapter through Metal, the original SDK/model, and the default 1024-token context. Both pages translated and restored exactly; there were no uncaught page JavaScript errors. The other platform jobs in that exploratory matrix did not pass; the entire matrix must not be described as successful.

The maintained `Real installed extension` workflow now uses this verified Metal environment. It asserts the actual adapter vendor rather than claiming GPU support from an injected test capability. `playwright@1.57.0` is test-only and pinned separately from the extension dependency lock. The original browser/runtime dependency files and installed file hashes are checked. A copy and SHA-256 of the tested Chrome package are retained in the artifact.

Linux SwiftShader is a different result: the original native graph reported `LlmGpuCalculator` / `Timed out waiting for future: 5m`; its subsequent extension-side generation deadline also failed. This has not been fixed by increasing time limits, changing precision, changing context size, or the CPU bridge used earlier. A Metal pass is not a claim that software WebGPU passes. Native SDK/CPU profiles and prior failed runs remain diagnostic evidence, not pass evidence.

## Automation

- `.github/workflows/native-extension.yml`: trusted-branch push, manual dispatch, and reusable workflow; two fresh-profile original-model tests.
- `.github/workflows/release.yml`: publishing depends on both `browser` (deterministic inference double) and `native` (actual original inference). Missing credentials or failed native inference blocks release.
- `HF_TOKEN` is an Actions secret with access to the gated default model. Do not put its value in source, issues, artifacts or commands committed to the repository.
- Authenticated profiles and Playwright traces are never uploaded. Logs/HTML are redacted; an evidence scan rejects credentials before upload. Model weights are not artifacts.
- Temporary workspace exporters, alternate-engine workflows and one-off candidate workflows have been removed. Their historical runs are retained by GitHub according to artifact retention.

## Local reproduction

Use Node 24 and a browser environment that actually permits extension installation. Do not bypass managed browser policies.

```sh
npm ci
npm run build:chrome
npm install --no-save --package-lock=false --ignore-scripts playwright@1.57.0
npx playwright install chromium
# HF_TOKEN must already be set securely in the environment.
HEADED=1 node test/native-extension/real-extension.mjs
```

On macOS the driver selects Metal; on Linux it selects SwiftShader for explicit software diagnosis. These backends are never reported as interchangeable. The application model and SDK are not changed by either choice.

## Evidence and limits

`summary.json` records the commit, environment, actual adapter, UI configuration, native host state, generation count and per-case result. Per-file SHA-256 inventories establish unchanged installed bytes. Before/translated/restored HTML and screenshots show the actual rendered pages. Timing begins at test UI orchestration, not at the GPU kernel boundary; `renderTiming` uses a read-only DOM observer, while completion polling also includes test-driver overhead. These are observations, not performance guarantees or translation-quality scores.

Firefox is build/package-tested only. The separate DOM planner audit still has 13 unmet conditions out of 15 deliberately adversarial fixtures. Passing the installed-extension translation/restore test does not resolve those scheduling findings or establish arbitrary-site compatibility. No main merge or release has been authorized by these test runs.

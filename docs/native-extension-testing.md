# Actual installed-extension verification

## Acceptance boundary

`test/native-extension/real-extension.mjs` installs the built Manifest V3 extension in a fresh persistent Chromium profile and operates its shipped onboarding and Options UI. The service worker, offscreen document, inference Worker, locked `@mediapipe/tasks-genai@0.10.30` JavaScript/WASM assets, and default `translategemma-4b-it-int8-web.task` are real. There are no synthetic translation responses, capability replacements, production-module injection, external inference services or native bridges.

The six checks are actual installation/onboarding, original-model download/load/warmup, basic-page translation, basic-page exact restoration/events, inline-article translation, and inline-article exact restoration/events. Both HTML fixtures must pass. The real host generation counter must increase. Code, user input and link destinations remain unchanged; restoration checks original HTML, text, attributes and element identities. Readiness alone is not an end-to-end pass.

## Verified software execution and the production change

Actions run `41202445967`, artifact `13044045302`, completed **all six checks** using Ubuntu, Chromium 143, a real SwiftShader software WebGPU adapter, the original SDK and original 3,896,377,344-byte task model. It performed seven page-translation generations, excluding warmup. Basic translation took 72.85 seconds; the inline article took 462.54 seconds. UI round-trip restoration was 0.379 and 4.098 seconds respectively. These are single-run observations including driver overhead, not native LiteRT CPU-backend benchmarks or linguistic-quality scores.

That run built an explicitly recorded source candidate: software adapters use a shorter instruction for **single-text** requests, retaining the source language, target language, complete input, normal Gemma turn markers and real token-budget check. Hardware adapters and numbered multi-text prompts retain the original prompt. No model weights, SDK files, context limit or GPU capability functions were replaced.

The exact tested production source blob is `b5adae752d050bcaac5aaa98451026278c2703dc`. Run `41204257647` reproduced this blob, passed **406/406** tests and built both browser packages. All **40 application-file SHA-256 values** in the resulting Chrome package match those installed during the successful CPU test, byte for byte. Its Chrome ZIP SHA-256 is `31e8ab9fe075542aaa3325f4e209cfc25f1ae570f589105b8d000d46399a2f72`. The verified source is promoted into the branch rather than left as a test-only runtime alteration.

Earlier unchanged long-instruction software runs failed inside the original native `LlmGpuCalculator` with `Timed out waiting for future: 5m`, followed by the extension deadline. They remain failed results. Changing precision, disabling cache rewind, or reducing the context to 256 did not resolve those recorded runs. The short-instruction result does not prove support for arbitrary long input or numbered batches on software WebGPU; those can still be expensive. CPU software rendering is functionally testable here, but is not claimed to be interactive-performance-ready.

## Hardware execution

The initial complete hardware execution was the macOS job in Actions run `41202819104` (artifact `13042989173`), followed by two independent fresh profiles in `41203793648`. They used an Apple M2 Pro (Virtual) runner, Chromium 143.0.7499.4, a real Apple WebGPU adapter through Metal, the original SDK/model and default 1024-token context. Both pages translated and restored exactly. The exploratory matrix's other platform jobs did not pass; the entire exploratory matrix must not be described as successful.

The maintained workflow repeats the hardware test twice. After any production-source promotion, its final run checks the committed application again. Current commit-specific results belong in the PR checks/evidence, not inferred from these historical run IDs.

## Automation and reproducibility

- `.github/workflows/native-extension.yml`: trusted-branch push, manual dispatch, and reusable workflow. Hardware uses macOS/Metal and two fresh profiles; manual `backend=software` uses Ubuntu/SwiftShader and one fresh profile with the same assertions.
- `.github/workflows/release.yml`: publishing depends on both deterministic browser regression and actual original-model hardware E2E. Missing credentials or a failed native test blocks release.
- `playwright@1.57.0` is pinned test-only tooling. Original SDK JavaScript/WASM assets are hash-checked against the installed locked dependency; installed file hashes are compared before and after testing.
- `HF_TOKEN` must be an Actions secret authorized for the gated default model. Authenticated browser profiles, model weights and traces are never uploaded. Logs and HTML are redacted; an evidence scan rejects credentials before upload.
- Temporary exporters, candidate workflows and the prior alternate-engine CPU workflow/script have been removed. Historical failed results are not relabelled as passes.

```sh
npm ci
npm run build:chrome
npm install --no-save --package-lock=false --ignore-scripts playwright@1.57.0
npx playwright install chromium
# HF_TOKEN is already supplied securely through the environment.
HEADED=1 node test/native-extension/real-extension.mjs
# Linux with a virtual display: xvfb-run -a node test/native-extension/real-extension.mjs
```

Use Node 24 and an environment that permits extension installation; do not bypass managed-browser policies. The driver chooses Metal on macOS and SwiftShader elsewhere. Adapter identity is measured, not spoofed.

## Evidence and remaining limits

`summary.json` records the exact commit, environment, adapter, UI configuration, host state, generation counts and each result. Before/translated/restored HTML and screenshots are actual browser output. The artifact includes the tested Chrome ZIP and SHA-256. `renderTiming` observes real DOM changes without altering extension functions; timing includes UI orchestration and is not a kernel-only benchmark.

Firefox is build/package-tested only. The separate DOM planner audit still has **13 unmet conditions out of 15 deliberately adversarial fixtures**. Native inference/restoration success does not resolve those scheduling issues, certify translation quality, cover arbitrary websites, or prove long-input CPU performance. main merge and release are not authorized by these test runs.

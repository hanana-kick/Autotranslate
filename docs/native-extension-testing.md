# Actual installed-extension verification

## Acceptance boundary

`test/dynamic-extension/run-dynamic.mjs` installs the built extension in a fresh persistent profile and operates the shipped onboarding and Options UI. The service worker, offscreen document, inference Worker, locked `@mediapipe/tasks-genai@0.10.30` JavaScript/WASM assets and original `translategemma-4b-it-int8-web.task` are real. No inference double, production-module injection, external inference service, or alternative engine is used in native QA. The runner verifies vendor and installed-file hashes.

The original six static checks remain mandatory. Dynamic scenarios cover delayed insertion, same-Text-node edits, subtree replacement, continuous mutations, three infinite-scroll batches, SPA navigation, source changes during native inference, exact latest-source restoration, disabled insertion and re-enable. Two tabs then share the actual model across repeated node updates. One profile performs 25 rounds; the other profiles perform five rounds. This is bounded endurance coverage, not an hours-long soak.

## Product safety and scheduling changes

Newly introduced model controls such as `<pad>`, excessive output and long repetition loops are rejected before successful caching or DOM writes. Literal controls present in the source are not automatically banned. Empty native final replies are errors. The supervisor terminates a corrupt worker and permits exactly one fresh-worker retry using the same SDK, model, prompt and device policy. A second failure is reported; it is never retried until a test turns green. `recoveries` records this recovery. This contains native corruption; it is not proof that the underlying intermittent SDK/driver cause has been identified.

Partial results remain incomplete and produce an error state rather than an unconditional page-wide success. Inline boundaries are validated before any piece is written, and verified fallback pieces are cached as an aligned unit. Statistics use an incremental completion count; detached records are pruned at batch boundaries. Hidden and closed-details content does not consume translation requests. Attribute/resize changes cause newly revealed text to be reconsidered.

The planner uses actual text geometry and viewport priority before semantic tie-breakers. It reads the complete eligible discovery set before applying a bounded translation budget, avoiding the previous 4001-node discovery loss. A reusable Range avoids retaining thousands of live ranges. ARIA ancestor roles, native buttons and deep main/article structure are recognized without treating every generic thread container as a comment.

## Automation

- `native-extension.yml`: five fresh macOS/Metal profiles with static, dynamic and multitab original-model checks. Manual `backend=software` uses the real SwiftShader adapter and the same assertions; slower execution is not a native LiteRT CPU-backend benchmark.
- `extended-qa.yml`: actual Firefox add-on installation and a separate public YouTube check. Firefox uses its temporary-add-on debugging protocol, not a replacement app. Live-site failures or access blocks remain failures and are documented separately from deterministic fixture success.
- `planner-audit.yml`: 15 real-DOM acceptance cases, identity responses solely to isolate planner cost, plus coarse CPU budgets and exact request/progress counts. These results do not prove native inference performance.
- `browser.yml`: deterministic provider doubles for control-flow, storage and browser API regressions. It cannot replace original-model E2E.
- `release.yml`: requires native, browser and planner workflows before packaging/publishing. Version 0.1.3 avoids overwriting the existing 0.1.2 release.

Use Node 24. `HF_TOKEN` must be an Actions secret authorized for the gated model. Credentials, model weights, browser profiles and authenticated traces are never uploaded. Text evidence is redacted and scanned; screenshots come from the actual rendered pages. Chromium screenshots use bounded CDP capture without waiting for unrelated font/animation hooks. Capture failure remains a failure.

```sh
npm ci
npm run build
npm install --no-save --package-lock=false --ignore-scripts playwright@1.57.0
npx playwright install chromium firefox
HEADED=1 node test/dynamic-extension/run-dynamic.mjs
# Optional live-site coverage, not a replay:
HEADED=1 YOUTUBE_QA=1 node test/dynamic-extension/run-dynamic.mjs
# Firefox package, same shipped SDK/model:
HEADED=1 QA_BROWSER=firefox node test/dynamic-extension/run-dynamic.mjs
```

## Evidence and limits

Current commit-specific outcomes belong in PR checks and artifacts; the existence of these workflows does not mean they passed. `summary.json` distinguishes static, dynamic, endurance and live-site outcomes, records environment/adapter/host state and generation counts, and preserves exact source restoration checks. The dynamic fixture is YouTube-like, not youtube.com. Live coverage is public search insertion and watch-page SPA navigation; logged-in variations and every site layout are not certified. Protocol validity is not a linguistic-quality score.

Historical alternate-engine tests are not evidence of this extension's operation. Earlier native runs with long software prompts, invalid output and screenshot deadlines remain failed; they are not relabelled by later fixes. Model startup readiness alone is never an end-to-end pass. Do not bypass managed-browser extension policies.

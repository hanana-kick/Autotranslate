# Actual installed-extension verification

## Acceptance boundary

`test/dynamic-extension/run-dynamic.mjs` installs the built extension in a fresh persistent profile and operates the shipped onboarding and Options UI. The service worker, offscreen document, inference Worker, locked `@mediapipe/tasks-genai@0.10.30` JavaScript/WASM assets and original `translategemma-4b-it-int8-web.task` are real. No inference double, production-module injection, external inference service, or alternative engine is used in native QA. The runner verifies vendor and installed-file hashes.

The six static checks remain mandatory. Dynamic scenarios cover delayed insertion, same-Text-node edits, subtree replacement, continuous mutations, three infinite-scroll batches, SPA navigation, source changes during native inference, exact latest-source restoration, disabled insertion and re-enable. Two tabs then share the actual model across repeated node updates. One profile performs 25 rounds; the other profiles perform five rounds. This is bounded endurance coverage, not an hours-long soak or a proof that memory can never grow.

## Product safety and scheduling changes

Newly introduced model controls such as `<pad>`, excessive output and long repetition loops are rejected before successful caching or DOM writes. Literal controls present in the source are not automatically banned. Empty native final replies are errors. The supervisor terminates a corrupt or stalled worker and permits exactly one fresh-worker retry using the same SDK, model, prompt and device policy. A second failure is reported; it is never retried until a test turns green. `recoveries` records this recovery. This contains native corruption; it is not proof that the underlying intermittent SDK/driver cause has been identified.

Status, unload and absolute deadlines run outside the compute Worker. Capability checks have a separate five-second bound, including when a GPU process has disappeared. This bound keeps the UI responsive; it does not turn an unavailable adapter into a working GPU. Hardware generation, cold warmup and software generation have separate finite budgets.

The multi-gigabyte model uses the declared `unlimitedStorage` permission. The optional persistence request is not awaited before downloading or importing a model: a browser-owned permission dialog must not indefinitely block installation. Quota checks and write errors remain enforced. No permission response is synthesized or automatically accepted.

Partial results remain incomplete and produce an error state rather than an unconditional page-wide success. Inline boundaries are validated before any piece is written, and verified fallback pieces are cached as an aligned unit. Statistics use an incremental completion count; detached records are pruned at batch boundaries. Hidden and closed-details content does not consume translation requests. Attribute/resize changes cause newly revealed text to be reconsidered.

The planner uses actual text geometry and viewport priority before semantic tie-breakers. It reads the complete eligible discovery set before applying a bounded translation budget, avoiding the previous 4001-node discovery loss. A reusable Range avoids retaining thousands of live ranges. ARIA ancestor roles, native buttons and deep main/article structure are recognized without treating every generic thread container as a comment.

## Automation

- `native-extension.yml`: five fresh macOS/Metal profiles with static, dynamic and multitab original-model checks. Each repeat has its own runner and profile. Manual `backend=software` uses the real SwiftShader adapter and the same assertions; this is not a native LiteRT CPU-backend benchmark.
- `extended-qa.yml`: actual Firefox add-on installation through Mozilla's GeckoDriver WebDriver endpoint, plus a separate public YouTube check. The browser is not replaced with a test application.
- `planner-audit.yml`: 15 real-DOM acceptance cases, identity responses solely to isolate planner cost, plus coarse CPU budgets and exact request/progress counts. These results do not prove native inference performance.
- `browser.yml`: deterministic provider doubles for control-flow, storage and browser API regressions. It cannot replace original-model E2E.
- `release.yml`: requires native, browser and planner workflows before packaging/publishing. Version 0.1.3 avoids overwriting the existing 0.1.2 release.

Use Node 24 and the pinned Playwright 1.64.1 test driver. `HF_TOKEN` must be an Actions secret authorized for the gated model, or a securely supplied local environment variable. Never put it into committed commands or a report. Credentials, model weights, browser profiles and authenticated traces are never uploaded. Text evidence is redacted and scanned; screenshots come from actual rendered pages. Chromium screenshots use bounded CDP capture without waiting for unrelated font/animation hooks. Capture failure remains a failure.

```sh
npm ci
npm run build
npm install --no-save --package-lock=false --ignore-scripts playwright@1.64.1
npx playwright install --with-deps chromium firefox
HEADED=1 node test/dynamic-extension/run-dynamic.mjs
# Public live-site coverage, not a replay:
HEADED=1 YOUTUBE_QA=1 node test/dynamic-extension/run-dynamic.mjs
# Firefox: install the official pinned GeckoDriver described in extended-qa.yml.
# GECKODRIVER points to that verified executable; no replacement inference host.
HEADED=1 node test/firefox-native/webdriver.mjs
```

## ONNX (q4f16) live check

`test/onnx-live/run-onnx.mjs` covers the path the shipped default card takes: the
published `TeamFlaxia/plamo-3-translate-0.8b-onnx` q4f16 graph, the options download
route, the background/offscreen split, real WebGPU and a four-sequence page. It is not
part of `npm test` or CI - it downloads 706 MB and needs an adapter with `shader-f16`,
which SwiftShader does not provide.

```sh
npm run build
npm run test:onnx            # writes test-results/browser/onnx-q4f16-live.json
YOUTUBE=1 npm run test:onnx  # adds a paused public watch page
```

It asserts four things a passing unit suite cannot see: the graph installs through the
shipped UI, the first load reaches `AT.onnxhost` (a misroute dies in the GGUF host's
file sniff as `No model format matched`), the host answers `at/local-count` (otherwise
every batch logs `the host did not count tokens`), and turning the tab off restores the
exact original text. The YouTube leg pauses playback before translating and requires it
to stay paused; it certifies one public watch page, not YouTube compatibility.

On Linux, use the workflow's Xvfb command for headed browser tests. Do not bypass managed-browser extension policies.

## A model on disk, not from the network

Every live measurement used to download the 673 MB card again, and the CDN throttles repeats
until a run stalls. Put the files under `weight/` once and point the runs at them:

```sh
npm run model:fetch                       # weight/plamo-3-translate-0.8b-onnx (graph + 5 parts)
MODEL_DIR=weight/plamo-3-translate-0.8b-onnx npm run test:onnx
MODEL_DIR=weight/plamo-3-translate-0.8b-onnx npm run test:sites
```

The harness serves that directory over a local https origin (a throwaway certificate the context
accepts) and rewrites the card's own requests to it, so the shipped route still runs end to end -
the same card url, the same part discovery, the same byte-count check, the same OPFS write - with
the network out of the picture. `PROFILE_DIR=<dir>` reuses an installed model instead, for repeats.
Without `MODEL_DIR` the harness downloads the real card, which is what verifies the shipped URL.

## Real sites, visible browser

`test/sites-live/run-sites.mjs` opens a visible Chrome for Testing window with the built
extension, installs the default card through the shipped options page, then translates a
Japanese YouTube stream with playback forced to stay paused and `reddit.com/r/LearnJapanese`.
It writes `test-results/browser/sites-live.json` and screenshots beside it.

```sh
npm run build
npm run test:sites            # window closes when the run ends
KEEP_OPEN=1 npm run test:sites
WATCH=<url> REDDIT=<url> npm run test:sites
```

Why headed: Reddit answers a visible browser where it refuses this machine's headless one.
Branded Chrome refuses `--load-extension` since 137, so the window is Chrome for Testing -
still a real browser, still the real extension. A site that blocks the machine is recorded as
blocked and the run continues; no user-agent or cookie trickery, no account, no CAPTCHA bypass.
The YouTube leg fails the run if fewer than two comments come back translated.

## Live YouTube boundary

The fixture tests and youtube.com tests are distinct. The live test requires real search results, actual scroll-triggered inserted results, their automatic translation and exact restoration, and same-document navigation into a real watch URL.

When the watch title is visible, its translation and exact restoration are mandatory. When the site explicitly requires sign-in and hides the title, the report records `blockedCapabilities` and `accessRestriction`; playback and that hidden title remain unverified. The test then requires a real, visible, public English comment on the watch page to translate and restore exactly. Missing comments, unexpected missing metadata, or translation failures still fail. No account, consent, CAPTCHA or bot restriction is bypassed. A successful public-content check must never be reported as unrestricted YouTube compatibility.

## Evidence and limits

Commit-specific outcomes belong in PR checks and artifacts; the existence of these workflows does not mean they passed. `summary.json` distinguishes static, dynamic, endurance and live-site outcomes, records environment/adapter/host state and generation counts, and preserves exact source restoration checks. Firefox has a separate summary. Each failure is retained, including failed repeats before a code fix.

Protocol validity is not a linguistic-quality score. Logged-in variations, every site layout, all GPU vendors, and arbitrarily long sessions are not certified. A successful macOS/Metal run does not prove Linux software rendering or Firefox success. Historical alternate-engine tests are not evidence of this extension's operation. Model startup readiness alone is never an end-to-end pass.

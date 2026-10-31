# Testing the installed extension with its real model

This acceptance test installs the normal `build/chrome` package. It does not
inject production modules, replace the inference API or GPU capability checks,
mock network responses, or forward inference to a native/server engine.

The tested path is:

```text
Onboarding / Options UI
  -> extension service worker
  -> offscreen document (supervisor)
  -> packaged inference-worker.js
  -> locked @mediapipe/tasks-genai runtime + original .task model
  -> content script -> page text nodes
  -> Options OFF -> exact original HTML and node identities
```

The dedicated worker is production code. It reads OPFS/IndexedDB in the same
extension origin; no credentials or model-byte copies are sent in worker
messages. The offscreen document supervises requests outside synchronous WASM,
so status and unload do not queue behind computation. On Firefox the background
page provides the document supervisor; the Chromium test does not certify
Firefox runtime execution.

## Test inputs and execution

The workflow `.github/workflows/native-extension.yml` uses a fresh Chromium
profile, the original default TranslateGemma web `.task` file and the default
1024-token setting. The Hugging Face account used by the repository secret
`HF_TOKEN` must have accepted the model's access conditions. Credentials are
entered into the extension's normal onboarding field; never put them in source
files, command-line arguments, or copied logs.

The workflow uses SwiftShader software WebGPU on an isolated Ubuntu runner.
This runs the original web inference runtime; it is **not** a native LiteRT CPU
delegate, a hardware-GPU benchmark, or a llama.cpp bridge. Real adapter
classification selects the bounded slow-backend deadline. Hardware generation
retains a 180-second cap; detected software WebGPU allows 900 seconds. Runtime
initialization stages have a 300-second cap. Repeated progress reports cannot
renew the same phase indefinitely, and active generation suspends idle eviction.

After `npm ci`, `npm run build:chrome`, installing `playwright@1.57.0` as a test
driver and `npx playwright install --with-deps chromium`, execute:

```sh
HEADED=1 xvfb-run -a node test/native-extension/real-extension.mjs
```

Supply `HF_TOKEN` through a secret environment mechanism, not as a literal in the
command. `NATIVE_QA_DIR` can set the evidence directory. The driver changes source
and target languages through Options; it does not patch production settings or
change the default model context to make the assertions pass.

## Assertions and evidence

The small one-paragraph case is diagnostic, not a replacement for the article
case. Overall success requires **both** real translation/restoration cycles:

- original model download, preparation and native warmup;
- basic English text translated to Korean by the installed extension;
- original article heading, paragraph and inline link translated;
- protected code, input value and link destination retained;
- turning the extension off restores exact HTML, text, attributes and element
  identities, and the click handler still works;
- model generation counters increase, there are no uncaught page errors, and
  all installed file hashes are unchanged during validation.

`summary.json` separates the two cases and records real operation phases,
progress counters and timings. Before/translated/restored HTML and screenshots
are written by the driver. Generation progress exposes counts and timestamps,
not page text. Authenticated Playwright traces are disabled and excluded from
uploads because snapshots can contain credential input values. Model weights
and browser profiles are not published as artifacts.

The `Browser regression` workflow is a different suite: it installs a disposable
extension copy with a deterministic inference double. It checks browser
integration quickly, but is not evidence of real-model acceptance. Likewise,
the historical `cpu-optimization.yml` native-engine bridge is not an installed
extension test. Their pass counts must not be combined into an acceptance claim.

## Scope

Passing the real-model smoke test covers these controlled fixtures and this
browser/backend only. It does not certify arbitrary websites, linguistic
quality, hardware-GPU performance, Firefox execution, or the separate pending
DOM-priority acceptance matrix. The real-model workflow is currently separate
from the existing release gate; no release or merge is performed by this test.

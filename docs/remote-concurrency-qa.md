# Remote-provider concurrency validation

Candidate source: `3192fe015fefdab04265c36ce60c1046b9c86cc9` (exact source tree exported by the successful run below).

## Implemented contract

OpenAI-compatible execution is optional. On-device mode remains the default; its MediaPipe host, model, inference worker and side-panel/window helper are unchanged. Remote mode needs neither downloaded local weights nor WebGPU and never silently falls back to on-device execution.

The simultaneous-translations control is visible and editable **only in remote mode**. It accepts integers **1–32**, default **2**. This limits active translation HTTP requests across **all enabled tabs combined** in one extension background context. It is not the completion `n`, not a per-tab multiplier and not a change to the server's max_num_seqs.

The configured API base supplies `/models`. Optional vLLM `/server_info?config_format=json` metadata can report max_num_seqs and max_num_active_seqs. Unsupported, denied or timed-out metadata stays unknown, never disables the provider and never overwrites manual concurrency. Model context length and current running-request counts are not inferred capacity.

Tab OFF cancels its queued requests and aborts active HTTP while other selected tabs can continue. Navigation/closure and obsolete settings invalidate pending work. The existing compare-before-write and restoration checks reject late results. A disconnected server can still finish computation: this is client-side cancellation, not a promise of server-side cancellation.

## Executed evidence

- Actions: https://github.com/hanana-kick/Autotranslate/actions/runs/41486270801
- Artifact: https://github.com/hanana-kick/Autotranslate/actions/runs/41486270801/artifacts/13162780722
- Node 24: **477/477** tests passed, zero skipped. Type checks and both Chrome/Firefox package checks passed.
- Focused background/scheduler/HTTP: **63/63** passed, already included in the total.
- Chromium 143.0.7499.4 / Ubuntu 24.04: **27/27** browser tests passed, zero skipped.
- The remote scenario installed the real built extension and used its actual settings UI, background, content script, observer and fetch calls to a loopback OpenAI-shaped HTTP fixture.
- Two selected tabs reached a total peak of **3**, never 6; saving **1** produced serial HTTP. A different advertised server capacity did not overwrite the manual choice.
- Local mode hid/disabled the concurrency control; returning to remote preserved it. Reloading the settings retained the saved value.
- Turning OFF during delayed HTTP prevented later node requests and late DOM writes. Unselected tabs stayed untranslated. Dynamic insertion/edit, reload and restoration passed.
- Scheduler units covered 1/2/4/8/32, simultaneous callers, increasing/decreasing limits, output ordering, per-tab cancellation, mode-switch cancellation, failures and permit recovery.
- Source/package regressions checked the original on-device runtime bytes and existing local control behavior.

## Limits

The HTTP fixture returned deterministic text. This validates extension networking, scheduling, UI and DOM behavior, **not actual vLLM/TranslateGemma inference or throughput**. No production server endpoint or credentials were supplied. Live-server validation remains outstanding. Existing local browser regressions use their explicitly declared model double; this run did not repeat the multi-gigabyte genuine local-model test. Firefox was built/package-checked, not runtime-qualified.

Temporary workspace/assembly workflows were removed. The permanent remote unit and browser tests are automatically discovered by existing npm test and npm run test:browser CI. No release gate has been removed or weakened. This candidate is not a new published release.

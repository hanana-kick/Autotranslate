# Review / QA work ledger — v0.1.3

The scope is the actual installed extension, its locked `@mediapipe/tasks-genai@0.10.30` runtime and original `translategemma-4b-it-int8-web.task`. Unit doubles, planner identity responses, synthetic pages, live sites and actual model execution are separate evidence layers. This is not a certification of linguistic quality or every browser/GPU combination.

**Integration is not release approval. Firefox original-model initialization remains a release blocker, tracked in [issue #2](https://github.com/hanana-kick/Autotranslate/issues/2).** The release workflow requires its native check in addition to Chrome, planner and deterministic regression checks. A failed or canceled job is not success.

| ID | Implementation / current disposition | Verification and boundary |
| --- | --- | --- |
| T01 | Implemented: reject newly introduced control tokens, runaway repetition, excessive or empty output before cache/DOM commit | Production output-validity, DOM and native-host regressions. Literal controls present in source are not universally forbidden. |
| T02 | Mitigated: isolated inference Worker, first-output/absolute deadlines and one bounded fresh-Worker recovery | Stalled generation, invalid output, repeated failure and cancellation regressions. Recovery is recorded; upstream intermittent native corruption is not claimed eliminated. |
| T03 | Implemented: partial/incomplete status and error propagation | Failed work cannot become page-wide success; retries use current original text. |
| T04 | Implemented: released-browser provenance, bounded CDP captures and an independent hydrated host-monitor page | Options reloads no longer invalidate an unrelated monitoring evaluation. Capture failure still fails QA; monitor regressions are included in npm test. |
| T05 | Implemented: five independent fresh profiles with original-model static, dynamic and restoration scenarios | The native workflow requires every profile. Artifacts record exact source, installed-file hashes, package and recovery counts. Gate verdicts are recorded on PR #1; canceled runs are excluded. |
| T06 | Implemented: CSS/details/editable/protected eligibility and attribute/resize reveal handling | Real-DOM hidden/reveal acceptance and content-script regression cases. |
| T07 | Implemented: viewport intersection/distance before semantic tie-breaking | Visible, partially visible, horizontal offscreen and display:contents cases. |
| T08 | Implemented: native controls, ancestor ARIA landmarks, deep main and explicit comment boundaries | Generic thread containers no longer classify the entire post as comments. |
| T09 | Implemented: full eligible discovery separated from bounded translation work | Initially scrolled 4,500-node discovery and 5,002-node continuation cases. |
| T10 | Implemented: incremental completion counters, bounded caches and batch-boundary cleanup | 100/1,000/4,000-node budgets. Per-node progress no longer rescans the growing restoration map. |
| T11 | Implemented: coalesced region queue, observer before first inference, current-source ownership and self-write filtering | Delayed insertion, Text reuse, subtree changes, continuous mutation, scroll, SPA, inference races and OFF/ON native scenarios. |
| T12 | Implemented: validated inline boundaries and scoped aligned-fragment fallback cache | No proportional word redistribution. Invalid alignment preserves element ownership; arbitrary prompt semantics are not certified. |
| T13 | Tested public YouTube paths, with explicit external-access limits | Search title, actual scroll insertion, same-document watch navigation and public comment translation/restoration passed in a recorded run. A later run reached a sign-in/bot check and no visible comments; that run remains blocked/failed, not success. |
| T14 | Implemented bounded multitab endurance | Two tabs; one profile has 25 mutation rounds, others five, each plus an initial round. Exact restoration is required after each round. This is not hours-long memory-soak certification. |
| T15 | **Open: Firefox native compatibility** | Official Firefox 158.0.1 on Apple Silicon and 154.0 on Intel/14 GiB both receive the complete original model but lose the preparation channel. Native translation/restoration was not reached. See issue #2. |
| T16 | Implemented source-provenanced performance baseline and workflow gates | Planner 15/15 and CPU budgets; native generation timings are kept separate from identity-response planner measurements. |

## Reproducible evidence

- Production source: `1c88c02961dee99d7fdade607718001dbbad6726`; subsequent integration changes are documentation and workflow gates.
- [Exact source validation, run 41275050774](https://github.com/hanana-kick/Autotranslate/actions/runs/41275050774): 441/441 tests, type/lint/build and both package checks passed on the promoted source blobs.
- [Planner audit 41273951631](https://github.com/hanana-kick/Autotranslate/actions/runs/41273951631): 15/15 real-DOM cases and all CPU budgets passed. The planner modules are unchanged by the subsequent messaging changes. Details: [optimization audit](optimization-audit.md).
- [Native Chrome 41273810615](https://github.com/hanana-kick/Autotranslate/actions/runs/41273810615): five fresh profiles passed on the preceding Promise-contract source `d9cc0ee7`. This is a baseline, not a substitute for testing later packages.
- [Native Chrome 41275351604](https://github.com/hanana-kick/Autotranslate/actions/runs/41275351604): four successful original-model profiles on current production source; profile 2 was canceled when the workflow-gate change triggered a new run. Do not count it as a five-profile success.
- [Frozen product repeat 41276113956](https://github.com/hanana-kick/Autotranslate/actions/runs/41276113956): the five-profile gate for current production source and strengthened release workflow. Consult its terminal job verdicts and PR #1 for the final acceptance result.
- [Public YouTube baseline 41273810618](https://github.com/hanana-kick/Autotranslate/actions/runs/41273810618): YouTube job passed; Firefox job failed. The original search/inserted titles and a visible English comment were actually translated and restored. Playback/hidden watch title required sign-in and were excluded.
- [Current compatibility run 41275351589](https://github.com/hanana-kick/Autotranslate/actions/runs/41275351589): search/infinite-scroll/restoration worked; YouTube then withheld visible comments behind its bot/sign-in check. Firefox failed preparation. Neither full job is represented as successful.
- [Official Firefox Intel run 41275717220](https://github.com/hanana-kick/Autotranslate/actions/runs/41275717220): actual addon and original model, four logical CPUs, 15,032,385,536 bytes RAM; preparation channel closed and no generation occurred. Exact cause remains unconfirmed, not asserted to be OOM.

## Release and privacy requirements

`main` integrates reviewed changes; publication remains gated. The Release job needs deterministic browser checks, planner acceptance, all native Chrome profiles and the official Firefox native job. Its build action then reruns type/unit/package checks. Known failed compatibility is not hidden by `continue-on-error` or a synthetic inference substitute.

Model readiness alone is not success. Valid native cases require real generation and exact current-source restoration. A bounded fresh-Worker recovery must not be reported as zero faults. The structural validity gate is not a language-quality judge.

Artifacts exclude model weights, Hugging Face tokens, authenticated profiles and traces. Browser/site warnings and access restrictions are retained separately from extension errors. Version 0.1.3 does not silently overwrite the original 0.1.2 release.

# Actual installed-extension verification

## Acceptance boundary

The native harnesses install the built extension in a fresh persistent profile and operate the
shipped onboarding and Options UI. The service worker, offscreen document, message path,
storage, OPFS and DOM layer are the production ones, and the on-device engine is the shipped
ONNX host with the published q4f16 graph; only a driver that says so in its own output
substitutes a pipeline (see `docs/testing.md`). The runners verify vendor and installed-file
hashes where they compare bytes.

What is certified by a green native run is the path that run took: install, load, translate,
restore — on that browser, that GPU adapter and that page. It is not a claim about every site
layout, every GPU vendor, or linguistic quality.

## Product safety and scheduling rules the harnesses exercise

Newly introduced model controls such as `<pad>`, excessive output and long repetition loops are
rejected before successful caching or DOM writes. Literal controls present in the source are not
automatically banned. Empty native final replies are errors.

The host probes the adapter for WebGPU and `shader-f16` under a five-second bound, so an
unavailable adapter is reported (`no-webgpu`) without freezing the UI. Generation, warmup and the
probe have separate finite budgets.

The multi-gigabyte model uses the declared `unlimitedStorage` permission. The optional persistence
request is not awaited before downloading or importing a model: a browser-owned permission dialog
must not indefinitely block installation. Quota checks and write errors remain enforced. No
permission response is synthesized or automatically accepted.

Partial results remain incomplete and produce an error state rather than an unconditional
page-wide success. Inline boundaries are validated before any piece is written, and verified
fallback pieces are cached as an aligned unit. Statistics use an incremental completion count;
detached records are pruned at batch boundaries. Hidden and closed-details content does not
consume translation requests. Attribute/resize changes cause newly revealed text to be considered
again.

The planner uses actual text geometry and viewport priority before semantic tie-breakers. It reads
the complete eligible discovery set before applying a bounded translation budget, avoiding the
previous 4001-node discovery loss. A reusable Range avoids retaining thousands of live ranges.
ARIA ancestor roles, native buttons and deep main/article structure are recognized without treating
every generic thread container as a comment.

## Automation

- `npm run test:onnx` (`test/onnx-live/run-onnx.mjs`): the shipped card, the shipped download
  route, the background/offscreen split, real WebGPU and a four-paragraph page. Needs an adapter
  with `shader-f16`, which SwiftShader does not provide.
- `npm run test:sites` (`test/sites-live/run-sites.mjs`): visible browser, Japanese sites
  (YouTube, Reddit, NHK News Web Easy, Yahoo News) translated to Korean with every media element
  muted, playback paused and the original text restored afterwards.
- `extended-qa.yml`: actual Firefox add-on installation through Mozilla's GeckoDriver WebDriver
  endpoint (`test/firefox-native/released.mjs`). The browser is not replaced with a test
  application.
- `planner-audit.yml`: 15 real-DOM acceptance cases, identity responses solely to isolate planner
  cost, plus coarse CPU budgets and exact request/progress counts. These results do not prove
  native inference performance.
- `browser.yml`: deterministic provider doubles for control-flow, storage and browser API
  regressions. It cannot replace original-model E2E.

Use Node 24 and the pinned Playwright 1.64.1 test driver. No credential is needed: the model is
published without a login. Credentials, model weights, browser profiles and authenticated traces
are never uploaded. Text evidence is redacted and scanned; screenshots come from actual rendered
pages. Chromium screenshots use bounded CDP capture without waiting for unrelated font/animation
hooks. Capture failure remains a failure.

```sh
npm ci
npm run build
npm install --no-save --package-lock=false --ignore-scripts playwright@1.64.1
npx playwright install --with-deps chromium firefox
HEADED=1 npm run test:onnx
npm run test:sites            # headed by default; HEADLESS=1 for a smoke run
# Firefox: install the official pinned GeckoDriver described in extended-qa.yml.
# GECKODRIVER points to that verified executable; no replacement inference host.
HEADED=1 node test/firefox-native/webdriver.mjs
```

## ONNX (q4f16) live check

`test/onnx-live/run-onnx.mjs` covers the path the shipped default card takes: the published
`TeamFlaxia/plamo-3-translate-0.8b-onnx` q4f16 graph, the options download route, the
background/offscreen split, real WebGPU and a four-sequence page. It is not part of `npm test` or
CI - it downloads 706 MB and needs an adapter with `shader-f16`.

```sh
npm run build
npm run test:onnx            # writes test-results/browser/onnx-q4f16-live.json
YOUTUBE=1 npm run test:onnx  # adds a paused public watch page
PROBE_ENGINE_FAILURE=1 npm run test:onnx  # ships an engine that cannot start
TWO_TABS=1 npm run test:onnx  # two pages at once: their requests must share steps
```

It asserts what a passing unit suite cannot see: the graph installs through the shipped UI,
the host answers `at/local-count` (otherwise every batch logs `the host did not count tokens`),
every paragraph of the page comes back translated (`[page] finished 4/4`), and turning the tab off
restores the exact original text. `PROBE_ENGINE_FAILURE=1` swaps in a `hostworker.js` that refuses to
open its session and asserts a fifth thing: the page still comes back translated in 4/4 and
`at/local-status` reports `reason: worker-init` instead of hanging or failing. The YouTube leg pauses
playback before translating and requires it to stay paused; it certifies one public watch page, not
YouTube compatibility.

On Linux, use the workflow's Xvfb command for headed browser tests. Do not bypass managed-browser
extension policies.

## A model on disk, not from the network

Every live measurement used to download the 673 MB card again, and the CDN throttles repeats until
a run stalls. Put the files under `weight/` once and point the runs at them:

```sh
npm run model:fetch                       # weight/plamo-3-translate-0.8b-onnx (graph + 5 parts)
MODEL_DIR=weight/plamo-3-translate-0.8b-onnx npm run test:onnx
MODEL_DIR=weight/plamo-3-translate-0.8b-onnx npm run test:sites
```

The harness serves that directory over a local https origin (a throwaway certificate the context
accepts) and rewrites the card's own requests to it, so the shipped route still runs end to end -
the same card url, the same part discovery, the same byte-count check, the same OPFS write - with
the network out of the picture. `PROFILE_DIR=<dir>` reuses an installed model instead, for repeats:
the extension is copied to `<dir>/extension` so its id — and therefore the origin the graph is
stored under — stays the same between runs. Without `MODEL_DIR` the harness downloads the real card,
which is what verifies the shipped URL.

## Real sites, visible browser

`test/sites-live/run-sites.mjs` opens a visible Chrome for Testing window with the built
extension, installs the default card through the shipped options page, then translates every site in
its table: the Japanese YouTube watch page, `reddit.com/r/LearnJapanese`, NHK News Web Easy and
Yahoo News Japan. It writes one record per site to `test-results/browser/sites-live.json` and a
screenshot beside it.

```sh
npm run build
npm run test:sites                        # every listed site, four minutes each
SITES=youtube,nhk-easy npm run test:sites # a subset, by id
SITE_SECONDS=120 MIN_TRANSLATED=3 npm run test:sites
KEEP_OPEN=1 npm run test:sites            # window stays open when the run ends
WATCH=<url> REDDIT=<url> NHK=<url> YAHOO=<url> npm run test:sites
```

Why headed: Reddit answers a visible browser where it refuses this machine's headless one.
Branded Chrome refuses `--load-extension` since 137, so the window is Chrome for Testing - still a
real browser, still the real extension. `HEADLESS=1` is there for a quick smoke run.

The run is silent in three layers, because sound is a failure mode no JSON field would otherwise
show: `--mute-audio` with `--autoplay-policy=user-gesture-required` for the browser itself, an init
script that mutes every `video`/`audio` element a page creates or plays, and a sweep on each poll
that reads the element state before forcing it silent - so a site where anything was unmuted and
playing is recorded as audible, and fails the run. YouTube playback is also paused and kept paused
so an ad never starts; the mute is the guarantee, the pause is only about not playing broadcasts.

What a site record says: whether it was blocked, whether it served Japanese at all, how many Korean
strings arrived against how many the source had, whether it stayed silent, whether disabling the tab
put the original text back on the same nodes, and the tab's own error when it produced nothing. A
site that blocks the machine, serves another language, or reports its own error is recorded and
never fails the run; no user-agent or cookie trickery, no account, no CAPTCHA bypass. The run fails
when no site translated at all, when a site that had Japanese source translated less than its floor
(`min`, raised by `MIN_TRANSLATED`), when any site was audible, or when a translated site did not
restore its original text.

## Debug: where the translator is working

Options → "Outline translated regions on the page" (`debug`) draws the pass on the page: every text
node the planner took gets an outline, coloured by region (`comment` amber, `article` cyan, `heading`
green, `list` violet, navigation forms and chrome cool grey, refused regions red and dashed), and a
fixed panel reports the page context, the target language, `nodes this pass · translated · failed ·
planned`, the role counts, and the tab's own error. Scroll keeps the boxes on their text; the panel's
× closes it for that page without touching the setting.

It exists because "the page did nothing" has three causes that look identical from outside: the plan
is somewhere else, the region was classified as the site's chrome, or the model refused the batch.
The overlay separates them, and it settled the watch-page report it was built for: the plan held
`comment 252 (58 on screen) · article 157 (39 on screen)` while the pass took `article 38 ·
heading 16 · comment 2`, all of it on screen - so the work was correct and the *order* was what kept
the comments waiting. With comment regions classified as content and scheduled first, the same watch
page reached its first Korean comments in 15 s instead of 65-135 s.

The queue behind it: one plan per page state, ordered so the text on screen is finished first, then
the next screens down. A scroll re-ranks the queue on its trailing edge - text that comes back into
view jumps to the front - and a slice already in flight stops at its next batch instead of finishing
an order that no longer matches the screen. Each tick pulls a slice (`OBSERVER_BATCH_NODES`, 48) and
packs it into batches, so requests stay few and the page fills in reading order.

The setting reaches open tabs the way every other settings change does (the background retargets
selected tabs), and it is in `ContentSnapshot` because the content script is what draws it. Turning
the tab off removes the boxes and the panel; `npm run test:sites` turns the overlay on, records the
panel text and the box count per site in `sites-live.json`, screenshots them as
`sites-<id>-regions.png`, and fails the run if the overlay is left on the page afterwards.

## Translation speed, per page

`BENCH=1` turns the sites run into a measurement: each page is translated for the whole
`SITE_SECONDS` budget instead of stopping at its floor, and every model request the page made is
reported in order - the first (cold) one, the second, the third, then median, p90 and max - with
`ms per request`, `ms per text`, the warm median and the time to the first five requests. The whole
series goes into `sites-live.json` per site, so pages stay comparable even though their request
sizes differ.

```sh
npm run build
SITE_SECONDS=90 BENCH=1 MODEL_DIR=weight/plamo-3-translate-0.8b-onnx npm run test:sites
```

Measured on this machine (Apple GPU, q4f16, warm page after install):

| page | requests | texts | first | 2nd | 3rd | median | p90 | max | per request | per text | warm |
|---|---|---|---|---|---|---|---|---|---|---|---|
| youtube | 20 | 69 | 1057 ms | 5426 ms | 3993 ms | 3972 ms | 5915 ms | 33509 ms | 4739 ms | 1374 ms | 4933 ms |
| nhk-easy | 12 | 28 | 316 ms | 3377 ms | 3064 ms | 3064 ms | 4397 ms | 6472 ms | 2418 ms | 1036 ms | 2609 ms |
| yahoo-news | 52 | 131 | 787 ms | 1234 ms | 891 ms | 1015 ms | 3756 ms | 12777 ms | 1736 ms | 689 ms | 1754 ms |

The timing point is the page's own request: message sent, translations back, measured in the content
script, so it contains the model and the transport but not the DOM write (that is milliseconds). A
measurement run prints `[bench] measurement run; the exit policy is skipped` and always exits 0: it
reports, it does not judge. Without `BENCH`, the same timings are still recorded for whatever the
page translated, so a normal run carries its own speed evidence. Each entry also carries
`countMs`/`hostMs`/`chunks`, the background's own split of the request.

### Where the time goes

A deterministic fixture (40 short Japanese comments, `NHK=<url>` pointed at a local file) isolates the
policy from the site:

| configuration | requests | texts/request | ms per text |
|---|---|---|---|
| pack 8, short nodes packed (`always: false`) | 7 | 6.0 | 1368 |
| pack 32, short nodes packed | 3 | 14.0 | 1452 |
| pack 8, every node split (`always: true`) | 42 | 1.0 | ~1400 |

Packing changes how many requests a page costs; it does not change the cost of a text. Token
counting before each request is `countMs ≈ 2 ms`, i.e. free. `hostMs` is the whole request, so the
model's decode is the cost: the page translates at roughly **15 output tokens/s** on this machine
(`npm run test:onnx` reports the same ceiling: four paragraphs, one generation, ~8 s).

Batching several sequences into one generation - the way a serving engine amortises a decode step
across requests - was implemented and measured on the same fixture: one prompt per text passed to
the pipeline as a batch (`batch_size = texts.length`, left padding with the tokenizer's own pad
token) cost **1321 ms per text**, against **1257 ms per text** for the numbered-prompt path it
replaced. It is *slower*, and the session explains why. One forward pass of the same 23-token
prompt, measured on the loaded graph at several batch sizes (warm):

| batch | 1 | 2 | 4 | 8 | 16 |
|---|---|---|---|---|---|
| forward | 148 ms | 258 ms | 475 ms | 940 ms | 1852 ms |
| per row | 148 ms | 129 ms | 119 ms | 118 ms | 116 ms |

Per-row cost is flat: this runtime pays for a row, not for a step shared across rows, so no
scheduler - paged KV, continuous batching, preemption - can turn N sequences into less work than N.
The batch path was removed. What is left is the per-step overhead of the runtime (~150 ms even for a
23-token pass), which is why the remaining lever in this design is the *shared prefix*: every
request re-prefills the same instruction and page context, and caching that prefix's KV would remove
it from every request after the first. That is a custom decode loop over `model.forward`, not a
pipeline call.

### The decode engine

Two ways to overlap decoding exist: several sessions, or several sequences per step. Several
sessions lose (measured: a second session cost 1.68x per request and moved no more text), because
each session holds its own copy of the graph and its own KV. The engine is the other shape: one
worker (`src/hostworker.ts`, opened by `lib/pipelinehost.ts`) owns one session and runs a batched
forward per step, scheduled by `lib/engine.ts`. The host keeps the tokenizer, renders and tokenizes
the prompt, sends token ids, and decodes the answer; nothing but ids crosses the boundary.

The graph already supports it: `past_key_values.{0..15}.{key,value}` in, `present.*` out, dynamic
`batch_size`, no `position_ids` and no `use_cache_branch`. KV costs 6.3 KiB per token per sequence
(16 layers, one KV head, head_dim 128; `[1,1,L,128]` f16), so eight sequences at 2k tokens are about
100 MB. Sentinels: eos `[1, 16]`, pad `3`, vocab 107520.

What decided the design, measured in one page on the real graph (`test-results/browser/engine-spike.json`):

| KV tokens | 1 row | 2 rows | 4 rows | 8 rows |
|---|---|---|---|---|
| 128 | 51.6 ms | 54.4 ms | 60.3 ms | 81 ms |
| 512 | 54.2 ms | 61 ms | 121 ms | 243.3 ms |
| 1024 | 65 ms | 87.4 ms | 205.5 ms | 426.4 ms |

A step is 52-59 ms whether the context is 128 or 1024 tokens; what grows with context is the cost
of *each extra row* (its own KV read). So extra rows are nearly free at short context and cost real
per-request latency at the 600-1000 tokens a page actually reaches. Two rows halve the per-row cost
at 512 tokens and raise the per-request step by 13-16% (repeat runs measured +8% and +32%, which is
the drift to expect on a loaded machine); four rows buy a few percent more throughput over two for
+123-128% per-request step. The direction is the same in every run; the exact percentages are not.

Two more gates, both in the same report: our loop's 24 greedy tokens are identical, id for id, to
the library's own `generate` (parity), and a heterogeneous left-padded batch (17- and 29-token
prompts) decodes each row exactly as it does alone. Wall-clock parity of the two loops is within
run-to-run noise (1498 against 1830 ms cold, 1828 against 1818 ms warm, 24 tokens).

The shipped constants:

| constant | value | why |
|---|---|---|
| `C.ENGINE_BATCH` | 2 | rows one step carries: two rows cost +16% per step and halve the per-row cost at 512 tokens of KV; four cost +128% for almost nothing more; `0` disables the engine |
| `C.PAGE_PACKS` | 1 | packs one page keeps in flight. One page never batches with itself, so its requests cost what they cost alone; requests that genuinely overlap (another tab, a selection translation beside a running pass) still share a step |
| `C.ENGINE_COALESCE_MS` | 40 ms | requests reach the host a few ms apart (each counts tokens first); without the wait they form one-row cohorts and the engine serves them one after another |
| `C.ENGINE_PROMPT_TOKENS` | 2048 | a batched prefill returns `[rows, width, 107520]` float32, so it is bounded in tokens: 2048 tokens is ~880 MB in one tensor |

Page-level measurement on the fixture (40 short Japanese comments, `SITE_SECONDS=60 BENCH=1`), with a
`PAGE_PACKS` of two: one row and one pack at a time gave `median 19424 ms` and `2439 ms per text`;
two rows and two packs gave `median 28479 ms` and `1744 ms per text`. That is the trade in one line —
1.4x the text for 1.47x the per-request time — and it is why a page keeps one pack in flight: the
page-level win does not pay for 47% more latency on every request. Cross-tab sharing is where the
batch is spent instead, because those requests were waiting on each other anyway:
`TWO_TABS=1 npm run test:onnx` opens a second fixture page, switches both on, and asserts their
request intervals intersect (three overlapping request pairs in the run that ships this). Be careful
comparing numbers across runs on a loaded machine: the same 8-text pack measured 19.4 s, 28.5 s and
30.5 s in three runs of this suite an hour apart, so only comparisons inside one run mean anything.

Two ideas were measured and dropped rather than assumed: prefix-KV reuse (the shared chat-template
header is 8 tokens and token-aligned, so it saves ~8 prefill tokens of a 30+ token prompt) and more
than two rows (the table above). A pool of independent sessions stays gone for the same reason.

#### Where a decode step's 52 ms goes

Measured on the shipped graph, one decode step at ~128 tokens of KV
(`test-results/browser/engine-spike.json`, `stages`/`micro`/`weightRead`/`nodeSlope`):

| part | time | how it was measured |
|---|---|---|
| feeds (ids + mask tensors) | 0.0 ms | instrumented in the loop |
| `session.run` | 50.5-52.2 ms | instrumented in the loop |
| argmax over the logits | 0.1 ms | instrumented in the loop |
| cache adopt + dispose | 0.1 ms | instrumented in the loop |
| — inside `session.run`: — | | |
| reading all 673 MB of weights | **7.4-8.5 ms** | one matmul over a 660 MB matrix: 76-94 GB/s |
| arithmetic for one token | **2.7 ms** | width marginal (below): 1.68 GFLOP at ~600 GFLOPS |
| KV read at 800 tokens | <0.1 ms | 6.55 MB at the same bandwidth |
| **node execution** | **~41 ms** | residual, and the direct measurement below |

The arithmetic is 1.68 GFLOP per token (2 FLOP per weight plus ~5% attention), so the step runs at
about 600 GFLOPS and 13 GB/s - roughly 6-10% of what this GPU can compute and 15-17% of the 76-94 GB/s
it measured on a weight-heavy matmul (76-94 GB/s across runs). Neither compute nor bandwidth is the limit; the node budget is.
The same forward carrying more work shows the same thing from the other side:

| tokens in one forward | 1 | 2 | 4 | 8 |
|---|---|---|---|---|
| forward | 50.7 ms | 52.7 ms | 55.5 ms | 69.8 ms |
| per token | 50.7 ms | 26.4 ms | 13.9 ms | **8.7 ms** |

Eight tokens verified in one forward cost 5.8x less per token than eight single-token steps, because
the ~41 ms of node execution is paid once for all eight.

The graph declares **6841 nodes** for 16 layers (2677 `Constant`, 578 `Cast`, 496 `Unsqueeze`, 309
`Slice`, 271 `Concat`, 260 `Shape`, 243 `Gather`, 65 `MatMulNBits`, ...). Two independent
measurements put a node at 3.7-8.8 microseconds here: a synthetic 1000-node chain costs 4.6-6.1
µs/node, and injecting 2000 live (non-foldable) nodes into the real graph raised a 64-token prefill
from 317.0 ms to 324.4 ms in one run (3.7 µs/node) and from 292.4 to 309.9 ms in another
(8.75 µs/node). At those rates the 41 ms residual is 4.7k-11k node executions - the same order as
the declared count, and the only part large enough to account for it.

So the step is **dispatch-bound: thousands of node executions of small work**, not FLOPs and not
bytes. That is what the levers act on, in order of measured effect:

| lever | effect | cost |
|---|---|---|
| more rows per step | 2 rows: 1.73x per-row throughput, +16% step (`contexts`) | per-request latency |
| more tokens per step | 8 tokens: 8.7 ms/token instead of 50.7, 5.8x (`widths`) | needs a drafter |
| fewer nodes per step | proportional to the 42 ms - a fused re-export is the direct fix | a new graph export |
| graph capture | replays the whole step as one submission; `enableGraphCapture` is in the vendored build, but it refuses anything but `gpu-buffer` outputs and needs static shapes | static KV export (`past_present_share_buffer`) |

#### Our own decode kernels

`C.ENGINE_KERNELS` runs the decode loop on our WGSL kernels instead of ONNX Runtime
(`src/lib/kernels.ts`), reading the weights straight out of the shipped graph (`src/lib/onnxweights.ts`,
a focused protobuf reader; q4 payloads stay views). A normal decode step is one
submission of 259 dispatches plus its token copy, with pre-built pipelines and bind
groups. `at/local-status` reports the backend (`kernels` or `runtime`).

Historical measurements (`node test/engine-spike/run-gemv.mjs` with `MODE=parity|gen`):

| check | result |
|---|---|
| layer 0 against ORT at four positions | max 0.04-0.2, mean 0.002-0.005 (reference mean 1.2) |
| 16 layers + norm + head, one token | logits cosine **0.99999**, mean abs 0.018 |
| greedy token stream, real prompt | **identical for the first 8 tokens**; a near-tie at step 8 flips one token and the streams resync later |
| translated text | same sentence, one word differs where that tie happened |
| speed | **13.6 ms/token (73.5 tok/s)** against the runtime's ~50 ms/token (~20 tok/s) |

What the graph had to teach, because no config file says it: the residual is **post-sublayer norm**
(`x = x + Norm(Attn(Norm_x(x)))`), q and k each receive the graph's scale **0.297358**
(approximately `(1/128)^(1/4)`), so the dot product carries approximately `1/sqrt(128)`.
`gate_up`'s first half is the gate, and **layers 7 and 15 carry their own RoPE
frequencies** (0.805842 against 0.865964 for the rest; the effective angles were read back from ORT
to confirm).

##### Rates: tokens per second, prefill and decode

`at/local-status` carries `prefillTokPerSec` and `decodeTokPerSec` (plus the raw
`prefillTokens`/`decodeTokens` counters). The historical measurements below timed GPU
completion without readback and mixed phases together; the fixed-token evaluation
section describes the current, stricter accounting. Do not compare the two as identical metrics.

Measurements (fresh profile, `test:onnx`):

| workload | page time | prefill | decode | tokens prefill/decode |
|---|---|---|---|---|
| 4 paragraphs, one request | **4 s** | **253.7 tok/s** | **66.4 tok/s** | 122 / 183 |
| 32 paragraphs, cohorts of 4 | **30 s** | 207.6 tok/s | 55.5 tok/s | 382 / 1530 |

Both phases improved when the kernels stopped being one-row-per-workgroup:

| change | prefill | decode |
|---|---|---|
| before: one workgroup per output row, 7 barriers per row | 27.8 tok/s | 20.9 tok/s |
| one workgroup per EIGHT output rows (16 lanes each, 1 barrier) | 86.5 tok/s | 45.1 tok/s |
| plus reading a prompt several positions at a time | 221.6 tok/s | 62.0 tok/s |
| plus fused inputs (q/k normed out of qkv, silu out of gate_up, attention on the rotated q) | **253.7 tok/s** | **66.4 tok/s** |

The page-level table below still comes from `perText` (a round trip per translation unit); tok/s is
the engine's rate. They are related through the token counts a request needed, which the status now
reports (`prefillTokens`/`decodeTokens`).

##### Batching

A row is either a generating sequence or one position of a prompt. Up to eight requests
own independent KV slots. Pure prefill steps now carry up to 64 positions; a 32-by-32
output tile stages K in chunks of 32 and reuses each dequantized weight across tokens.
Each invocation holds two vec4 accumulators rather than one accumulator per prompt
position. The small-row GEMV specializes widths 1–8 and decodes packed nibbles into
vec4 dot products. Only rows that need a next token run the vocabulary head.

Mixed steps stay at eight positions, prioritizing decoding requests before using spare
rows for prompts. Continuous admission recycles a finished request's KV slot immediately.
The initial 40 ms coalescing interval lets page packs arrive together. The rotating
prefill cursor is held fixed during each scheduling pass, so a request cannot be visited
twice and have the same prompt positions inserted twice.

`rows` in status is the request-slot limit, not prefill tile size or actual live occupancy.

Measured on one 32-paragraph page (5 requests of 8 texts, `test/onnx-live` with `PARAGRAPHS=32`):

| step width | page time | per-step cost | per-sequence throughput |
|---|---|---|---|
| 1 row | **76 s** | 1.0x | 1.0x |
| 2 rows | 63 s | 1.5x | 1.33x |
| 4 rows | **53 s** | 2.5x | 1.6x |

Real pages at 4 rows, `ENGINE_BATCH=4`, `PAGE_PACKS=4` (`node test/sites-live/run-sites.mjs`):

| site | texts | requests | per text | verdict |
|---|---|---|---|---|
| youtube | 38 | 4 | **934 ms** | Korean, paused, restored |
| nhk-easy | 3 | 3 | 3049 ms | Korean, restored |
| yahoo-news | 10 | 2 | **732 ms** | Korean, restored |

The same sites in the serial configuration (one pack in flight, one row) measured 2828 ms and 1591 ms
per text on youtube and yahoo-news in an earlier pass, with fewer texts rendered; each site renders
a different amount per run, so treat that as directional. The controlled comparison is the paragraph
table above, where the page is identical across the three widths.

##### Sessions in parallel: measured, and not shipped

`C.HOST_POOL_SIZE` keeps that many decode workers, each with its own WebGPU session; the host hands
every request to the least-loaded session, and each session batches whatever it is given. The pool is
what a machine that really runs sessions in parallel would use: page time would fall to about
`ceil(requests / pool)` request-times.

This GPU does not do that. The same 32-paragraph page, same build (`PROFILE_DIR` reused, so no
install cost in either run):

| sessions | page time | request times |
|---|---|---|
| 1 (batched by rows) | **71-79 s** | 32.6, 40.9, 42.7 s for the three that overlapped, 8.8 s for the lone fifth |
| 2 (least-loaded dispatch) | 86 s | 38.7, 46.3, 48.0 s for the same three, 11.2 s for the lone fifth |

Metal time-slices the two sessions: every request comes back slower than it would alone, so the pool
loses to one session whose step carries rows. The knob stays (one worker is the shipped default, and
the offscreen host still runs generation off its own thread), but concurrency here comes from rows in
a step, not from sessions.

##### Subgroup matrices: available, and the first probe was wrong

An earlier review concluded the MMA path was closed after one shader failed with
`unresolved type 'subgroup_matrix'`. That was a made-up type name; the real types are
`subgroup_matrix_left/right<f16, K, R>` and `subgroup_matrix_result<f16, M, N>`, they live in
**function** address space (not workgroup), and they load from workgroup or storage arrays:

```wgsl
enable f16;
enable chromium_experimental_subgroup_matrix;
var<workgroup> tileA: array<f16, 64>;
var left: subgroup_matrix_left<f16, 8, 8>;
left = subgroupMatrixLoad<subgroup_matrix_left<f16, 8, 8>>(&tileA, 0u, true, 8u);
acc = subgroupMatrixMultiply<f16>(left, right);
acc = subgroupMatrixMultiplyAccumulate(left, right, acc);
subgroupMatrixStore(&tileC, 0u, acc, true, 8u);
```

Chrome 143 on this M5 compiles and runs it. A crude probe (4096 workgroups of 64 threads, each
doing 20,001 8x8x8 multiply-accumulates) measured **1.9 TFLOP/s** against the 0.55 TFLOP/s the
scalar q4 path reaches, and the probe duplicated each multiply across the workgroup's two subgroups,
so the per-subgroup figure is higher. The layout is **settled**, by trying all eight flag combinations against a CPU reference: the one
that matches exactly (max diff 0) is

```wgsl
left  = subgroupMatrixLoad<subgroup_matrix_left<f16, 8, 8>>(&tileA, 0u, true,  8u); // A rows of K
right = subgroupMatrixLoad<subgroup_matrix_right<f16, 8, 8>>(&tileB, 0u, false, 8u); // B rows of N
acc   = subgroupMatrixMultiply<f16>(left, right);
subgroupMatrixStore(&tileC, 0u, acc, false, 8u);                                    // C rows of N
```



**But the matrix multiply is not the hard part.** Two end-to-end q4 GEMM prototypes were built on that
recipe (25M synthetic parameters x eight positions, one workgroup per eight output rows):

| prototype | ms per pass | effective | model-equivalent |
|---|---|---|---|
| stage a q4 word per row per K=8 block, 384 barriers per workgroup | 0.81 | 0.5 TFLOP/s | ~340 tok/s |
| stage 128-K chunks, 24 barriers, 16 offset-addressed subtiles | 1.76 | 0.2 TFLOP/s | ~140 tok/s |

Both are **below the scalar kernel's ~0.55 TFLOP/s** (250 tok/s), because the staging is now the work:
per K-block the tile pipeline writes 128 f16 values (weight transpose + x tile) for 512 MACs, with
integer div/mod addressing, and the shared writes conflict. The 1.9 TFLOP/s figure above was pure
multiply-accumulate with no data movement; no real GEMM gets that for free.

So an MMA path is a **kernel-engineering project**, not a switch: vectorised `vec4<u32>` q4 loads,
a staging layout that needs no transposition (stage the weights column-major once), bank-conflict-free
shared addresses, double-buffered chunks. The measured staging cost is what such a kernel has to beat,
and the right next step is a staging-only microbenchmark before another full prototype.

What that changes: `packed_4x8_integer_dot_product` really is absent, so an int8 path is out, but
the matrix path llama.cpp uses on Metal has a WGSL equivalent here. A GEMM that dequantises an
8 x 128 q4 weight block into an 8 x 8 f16 workgroup tile, loads the matching x tile and
multiply-accumulates over K would put the weight-reuse work on the matrix unit: the expected range is
2-4x on prefill, not the "unavailable" recorded earlier. It ships behind a feature check with the
scalar path as the fallback, because the feature is experimental and not in every Chrome.

##### Window and staging experiments, and why eight wins

The tile is eight output rows x eight live x rows with one barrier, three
position/staging variants were built and measured on the same fixture, and each lost:

| kernel variant | prefill | decode |
|---|---|---|
| eight positions, direct x reads (shipped) | **252.7-254.0 tok/s** | **64.4-65.2 tok/s** |
| sixteen positions, x block staged in 8 KB of shared memory | 184.3 | 12.7 |
| sixteen positions, direct reads (sixteen accumulators) | 196.6 | 16.2 |
| one eight-accumulator pipeline for every width (no per-width templates) | 178.7 | 20.7 |

The limiter is **register pressure, not memory**: sixteen accumulators drop occupancy far enough to
cost 3-4x on a lone row, and staging the x block adds two barriers per K block (24 per workgroup
against one) that the extra positions never pay back. Run-to-run variance on this machine is large:
the same build measured 154.5 tok/s once and 252.7 the next, so single figures are only meaningful
in pairs.

##### Where the page time actually goes, and what that rules out

On the 32-paragraph page: prefill 382 tokens / 207.6 tok/s = 1.8 s, decode 1530 tokens /
55.5 tok/s = 27.6 s. **Decode is 92% of the page.** Two probes measured the obvious candidates for
the rest of the time:

| probe | result | consequence |
|---|---|---|
| can a command buffer be submitted twice? | no: `[CommandBuffer] cannot be submitted more than once` | the CUDA-graph analogue (record once, replay) does not exist in WebGPU; a step must be re-encoded |
| 290 dispatches as 290 passes vs one pass | 0.88 ms vs 0.59 ms per step | pass merging saves 0.3 ms, about 2% of a decode step |
| CPU encoding of those 290 dispatches | 0.06 ms per step | the encoder is not the cost |

Decode itself runs at ~23 GB/s against 52 GB/s measured by the spike's read probe, and 1.45 GFLOP
against 550 GFLOP/s: neither bound explains it, so the limiter is the per-dispatch work of ~290 small
kernels, not one big one.

Two kernel ideas were tried and came back neutral:

- **one output row per warp** (32 lanes reading 128 contiguous bytes, `subgroupAdd` reduction, behind
  the `subgroups` feature): prefill 203-235 tok/s, decode 57-65 tok/s, i.e. inside the variance band
  of the eight-row tile (252/65 best case). Reverted: complexity and a feature dependency with no
  measured gain.
- **continuous batching** (slot array, a finished row's slot admitted to the next queued request in
  the same iteration): correct (32/32, six generations as before) and neutral on this page (36 s and
  28 s against a 30 s baseline), because a page rarely queues more than the four packs it has in
  flight and its requests are of similar length. Kept for the structure - no cohort waits for its
  slowest row and there is no one-row tail cohort - with the neutral result stated.

##### The reporting standard: tokens per second first

Page checks report consecutive runs. Kernel changes use interleaved baseline/candidate
runs, at least three measurements per variant, with model loading and warmup excluded.
The status fields now measure **pure phases**, including token readback:

| field | meaning |
|---|---|
| `prefillTokPerSec` | prompt tokens per second in pure-prefill steps |
| `decodeTokPerSec` | generated tokens per second in pure-decode steps |
| `prefillTokens` / `decodeTokens` | the corresponding pure-phase counters, cumulative for the session |
| `rows` | maximum independent request/KV slots (eight), not the prefill tile width or actual occupancy |

Aggregate versus per-sequence: with four live rows in a step, `decodeTokPerSec` is the total across
all four; divide by the live row count for one sequence's rate. A lone request always runs at the
one-row rate.

Historical baseline before split-phase accounting and tiled prefill:

| workload | prefill | decode | page |
|---|---|---|---|
| 4 paragraphs, one request | **246.4 / 181.5 tok/s** | **66.4 / 54.3 tok/s** | 4-5 s |
| 32 paragraphs, continuous slots | **197.0 / 170.8 tok/s** | **51.0 / 46.6 tok/s** | 31-34 s |

Across the four runs of each workload today the prefill rate ranged 170.8-246.4 and the decode rate
46.6-66.4 tok/s; the page time moved with them (4-5 s and 28-36 s).

The spread inside a pair is the machine, not the code: the same build has measured 154.5 and 254.0
tok/s prefill an hour apart. A single figure is not a measurement here.

##### The loop that found attention

The step was ablated component by component (`C.PROFILE_ABLATION`: '' / 'nohead' / 'noattn' /
'onelay'), one fixture run each, same profile:

| build | prefill | decode |
|---|---|---|
| normal | 236.2 tok/s | **61.1 tok/s** |
| lm_head skipped | 166.7 tok/s | 65.1 tok/s |
| attention skipped | 246.3 tok/s | **114.5 tok/s** |
| one layer (sanity: breaks the model) | garbage | garbage |

**Attention was 47% of one decode step; the head is not the cost.** Cause: the model has one KV head
serving sixteen query heads, and the kernel dispatched one workgroup per *query* head, so every workgroup
re-read the same K and V for the row - at a 300-token context that is ~300 MB of attention traffic per
step, as much as the weights themselves. The score loop was also serial inside lane 0 (one lane walked
every position), which is the fix that shipped first: lane j now scores position j, with shared-memory
tree reductions for the softmax. Measured after the fix, three consecutive runs of the same build: prefill **196.2 / 296.3 / 298.3**,
decode **113.0 / 119.6 / 121.8 tok/s**. The same code measured 69.5-72.9 an hour earlier, which is the
machine's low band rather than the fix's effect: the honest reading is a **~1.9x decode improvement**,
landing on the ablation's own bound (114.5 with attention removed).

Attention's parts, ablated again in the same session (mode 1 skips the value pass, mode 2 skips the
scores): value pass 114.1 -> 127.9 tok/s, scores 114.1 -> 123.7. Attention is now ~20% of a step, not
47%.

At 119 tok/s a decode step takes 8.4 ms for 363 MB, i.e. **43 GB/s, 83% of the 52 GB/s this GPU
measures** - decode is close to its roofline. Prefill at 296 tok/s is 0.43 TFLOP/s, about 8% of the
class peak, and is where the remaining 3-5x lives.

What is left is the sixteen-fold re-read: one workgroup per row that stages K and V chunk by chunk
into shared memory and computes all sixteen heads from that staging. Traffic drops ~16x, so the
expected decode step is the ablation's lower bound (114 tok/s) or better once implemented.

##### A negative result: fusing the residual add into the norm

Folding the residual add into the following RMSNorm removes two dispatches per layer (32 per step,
~1 ms at the measured 29 us per dispatch). It was implemented, made correct after two bugs (a buffer
bound both read-write and read-only in one group, and the first layer adding the previous step's
stale post), and measured:

| build | prefill | decode |
|---|---|---|
| before (adds separate) | 196-298 tok/s | 113-122 tok/s |
| fused residual | 144-224 tok/s | 45-91 tok/s |

The fused build answered 4/4 correctly, so the numbers are the machine, and they do not support the
change. It was reverted. The lesson is about measuring, not about fusion: this GPU drifts by more
than 30% within an hour, so a change can only be judged by **interleaving the builds** (A/B/A/B, three
runs each), never by comparing one window against another.

##### What the benchmark numbers mean

The content script records one entry per request it sends (`src/content.ts`, the `bench` array the
overlay and the harness read):

| field | meaning |
|---|---|
| `texts` | **translation units in that request**: DOM text nodes the planner selected, or the sentence pieces a long node was split into (`SENTENCE_MAX_CHARS`). Up to `PACKED_TEXT_NODES` (8) share one request. Not a linguistics unit and not a page total. |
| `ms` | wall time from the request leaving the content script to its translations arriving back and being applied. It covers token counting, prompt building, decode and transport; the first request of a session also covers the model load. |
| `countMs` | the part of `ms` spent in the host counting tokens for the pack (the tokenizer, no generation). |
| `hostMs` | the part of `ms` spent generating: the chunks summed. |
| `chunks` | how many prompts the request was split into by the token budget (1 is the usual). |

`run-sites.mjs` and the fixture summarise those entries: `perText` is `Σms / Σtexts` (an amortised
average, so a text inside a pack of 8 is charged one eighth of that pack), `perRequest` is the mean
`ms`, `median`/`p90`/`max` are quantiles of `ms`, `warm` is the mean of every request but the first,
and `first five` is the sum of the first five requests (how long until the first screenful).

**Discovery is not in these numbers.** The planner (`src/lib/pipeline.ts`: MutationObserver, region
pass, pack plan) decides which nodes are translated and in what order; a request's `ms` starts only
after a pack has been chosen. The overlay reports the plan size and the pass counts (`planned`,
`comment`, `article`, ...), and the pass wall time minus the sum of request `ms` is what planning
cost. So "per text" is the decode round trip per translation unit, never the per-sentence time of
the target-discovery engine.

Limits: each request is bounded by its 2048-token KV slice. Eight request slots allocate
256 MiB of f32 K/V across 16 layers; prefill activation tile capacity is separate from
those slots. Mixed steps stay narrow to bound the delay imposed on decoding requests.
The worker retains the 673 MiB model buffer and uploads Q4 weights plus f32 scales
(about 367 MiB, excluding norms and scratch). Completed requests release their slots
immediately. The host loads the tokenizer without an ORT generation session on the
kernel path; inline ORT is initialized once, on demand, if fallback is needed.
Worker kernel initialization still falls back to the runtime backend.

##### Fixed-token kernel evaluation

`test/engine-spike/run-kernels.mjs` runs the real model directly on WebGPU. It transpiles
the selected kernel sources in memory, warms each runner, then measures fixed prompts
and output lengths with EOS stopping disabled. It saves every generated ID and step
sample, checks token accounting, compares variants, and records GPU validation errors.
No extension, tokenizer or ORT is substituted for the kernel arithmetic.

```sh
BASELINE_KERNEL=/path/to/instrumented-baseline.ts \
  LENGTHS=128,512,1024 BATCHES=1,4,8 STEPS=128 REPEATS=3 \
  node test/engine-spike/run-kernels.mjs

BASELINE_KERNEL=/path/to/instrumented-baseline.ts MODE=heterogeneous \
  LENGTHS=16,33,65 BATCHES=3 HETERO_REQUESTS=9 STEPS=8 REPEATS=1 \
  node test/engine-spike/run-kernels.mjs

BASELINE_KERNEL=/path/to/instrumented-baseline.ts CHECK_LOGITS=1 \
  LENGTHS=128,512,1024 BATCHES=1 STEPS=1 REPEATS=1 \
  node test/engine-spike/run-kernels.mjs
```

Pure prefill, pure decode and mixed steps have separate samples. A prompt-ending step
counts its input tokens and its first output token, without pretending it is a pure
decode step. `computeMs` is host-observed queue completion, **not a GPU timestamp**;
`wallMs` includes encoding, completion and token readback. Throughput is aggregate across
active requests, not per-sequence speed. The heterogeneous mode compares rolling
admission with running the same requests individually, including slot reuse.
The optional logits check copies all vocabulary logits after the timed prefill,
rejects nonfinite values, and compares cosine similarity and relative L2 error.
It does not add readback to the measured step or change the production kernels.

Candidate selection used 48 interleaved runs (128/512-token prompts, batches 1/4,
64 outputs per request, three repetitions). Vectorized GEMV and a 64-position
prefill capacity were retained. The grouped four-head, KV-sharing attention
candidate was removed: it regressed short-input decode and did not consistently
improve longer contexts. All candidate token sequences matched. The candidate
sources and report are retained under `test-results/browser/kernel-opt-selection/`.

The heterogeneous correctness run uses 16/33/65-token prompts and nine rolling
requests through three active slots, exercising partial tiles and slot recycling.
All four variant/scheduling comparisons matched. This comparison includes the same
read-cursor correctness fix in both baseline and optimized sources, so a duplicated
prompt visit in the old scheduler cannot masquerade as a performance gain.

Final A/B evaluation on the Apple M5 / Chrome for Testing 143 used three
interleaved repetitions per condition, 128 fixed output tokens per request
(54 runs total). These are median **wall-time tok/s**, including readback.
Decode excludes the first output produced during prefill. Batch rates are aggregate.
Both variants have identical phase instrumentation and the cursor correctness fix;
the baseline otherwise retains the original eight-position/scalar-GEMV path.

Separate full-vocabulary checks compared 107,520 logits after each of
128/512/1024-token prefills. Maximum relative L2 error was 5.76e-6, maximum
absolute error 1.14e-4, and minimum cosine similarity 0.999999999987.
All six runs completed without GPU/page errors; their output IDs matched.
The report is in `test-results/browser/kernel-opt-logits/`.

The Chrome build, `tsc -p tsconfig.tools.json`, and the focused
`onnxhost`, `onnxweights`, and `engine` suites passed (29 tests).
Host regressions cover tokenizer-only startup, single-flight fallback creation,
unload during initialization, reload, failed initialization retry, and the
eager non-kernel path.

The shipped Chrome extension also passed real UI-triggered English→Korean
translation and exact source restoration: four paragraphs in 3 seconds
(613.4 prefill / 93.3 decode tok/s), and 32 paragraphs in 16 seconds
(606.0 / 114.7 tok/s), both reporting `backend: kernels`.
Forcing worker initialization to fail exercised lazy inline ORT fallback:
all four paragraphs translated and restored in the probe, with translation
finishing in 24 seconds and status reason `worker-init`.
All three browser runs had zero page errors, missing token-count warnings,
or empty translation segments. Reports are under
`test-results/browser/kernel-opt-page4/`, `kernel-opt-page32/`, and
`kernel-opt-fallback/`. These are single-run end-to-end checks, not matched
page-speed A/B measurements; prompt packing and generated lengths can differ.

| Prompt | Batch | Prefill before → after | Decode before → after | End-to-end speedup |
|---:|---:|---:|---:|---:|
| 128 | 1 | 207.5 → 705.2 | 73.4 → 92.8 | 1.51× |
| 128 | 4 | 211.3 → 536.9 | 148.6 → 175.5 | 1.49× |
| 128 | 8 | 194.5 → 526.9 | 141.0 → 164.2 | 1.54× |
| 512 | 1 | 193.0 → 516.5 | 65.3 → 79.2 | 1.81× |
| 512 | 4 | 187.4 → 518.2 | 127.6 → 149.2 | 2.02× |
| 512 | 8 | 192.6 → 499.2 | 141.6 → 152.2 | 1.92× |
| 1024 | 1 | 176.3 → 435.7 | 52.3 → 63.2 | 1.91× |
| 1024 | 4 | 181.2 → 506.5 | 118.5 → 148.5 | 2.41× |
| 1024 | 8 | 183.8 → 451.5 | 134.3 → 154.9 | 2.11× |

All 27 paired comparisons produced identical token sequences; no GPU validation
or page errors were recorded. Prefill improved 2.46–3.40×, decode 1.07–1.26×.
Three repetitions are not a confidence interval: for example, optimized
1024-token/batch-eight total time ranged from 22.30 to 27.73 seconds.
Source hashes, individual samples, outputs and timing ranges are retained in
`test-results/browser/kernel-opt-final/kernels-2026-11-13T07-16-00.600Z-5a8609b1.json`
and `test-results/browser/kernel-opt-final/summary.json`.

##### Native-style prefill kernels

The next kernel revision replaces the scalar prefill inner loop with explicitly
tiled matrix work. It does not add a native binary or bypass WebGPU:

- `src/lib/kernelmatmul.ts`: 32-token × 32-output register-blocked GEMM,
  shared K tiles, Q4 dequantization inside the kernel, and FP32 accumulation.
  Devices advertising `shader-f16` use FP16 shared operands; otherwise operands
  remain FP32. Decode with at most eight active rows retains the vector GEMV.
- The optional subgroup-matrix path uses 32-token × 64-output tiles and
  FP32 8×8×8 matrix multiply-accumulate operations. It requires the advertised
  experimental matrix feature, subgroups, a supported matrix configuration,
  and a fixed subgroup size of 32 or 64. Unsupported devices use the portable
  path; the extension never enables browser flags.
- `src/lib/kernelattention.ts`: four query rows share 16-key KV tiles, with
  online stable softmax and no quadratic score buffer. Partial tiles, mixed
  request slots, causal bounds and sliding windows are handled in the kernel.
- K RoPE writes rotated K and V directly into their persistent cache slots.
  This removes per-token buffer-copy commands without adding a dispatch.
  A separate scatter dispatch was rejected after a short-request decode
  regression; the fused implementation replaces it.

Chrome for Testing 143 on the Apple M5 exposes `shader-f16` in its ordinary
configuration, but exposes subgroup matrices only with `--enable-unsafe-webgpu`.
Both benchmark runners now leave that flag off by default; `UNSAFE_WEBGPU=1`
explicitly enables experimental-path testing. Production selects only features
actually advertised by the adapter.

An FP16-accumulator matrix candidate was rejected, not silently accepted:
at 512 input tokens its full-vocabulary relative L2 error was 0.00627 and cosine
similarity 0.9999859, outside the unchanged 0.005 / 0.99999 limits.
Its source and failed report are retained under
`test-results/browser/native-kernel-matrix64/`. The selected matrix path
accumulates entirely in FP32; the ordinary FP16 path also accumulates in FP32.

These changes address prefill matrix throughput, attention reuse, and command
count. They do not establish performance parity with llama.cpp or vLLM:
no same-model native-runtime comparison has been measured here, and WebGPU
feature availability and browser submission overhead remain constraints.

Reproduce the three-path comparison using the saved pre-change kernel:

```sh
UNSAFE_WEBGPU=1 \
BASELINE_KERNEL=test-results/browser/native-kernel-final/sources/baseline.ts \
VARIANT_KERNELS='{"matrix":"src/lib/kernels.ts"}' \
VARIANT_OPTIONS='{"current":{"matmul":"f16"},"matrix":{"matmul":"matrix"}}' \
LENGTHS=128,512,1024 BATCHES=1,4 STEPS=64 WARM_STEPS=4 REPEATS=3 \
QA_DIR=test-results/browser/native-kernel-final \
node test/engine-spike/run-kernels.mjs
```

For full-vocabulary accuracy checks, use the same variants with
`CHECK_LOGITS=1 STEPS=1 BATCHES=1 REPEATS=1`. For normal-browser production
selection, omit `UNSAFE_WEBGPU`, `VARIANT_KERNELS` and `VARIANT_OPTIONS`.

Final kernel A/B/C evaluation used Apple M5, Chrome for Testing 143, the same
Q4F16 PLaMo 0.8B graph, 64 fixed outputs per request, and three interleaved
repetitions (54 runs). All paths ran in the same experimental-enabled browser
configuration to control browser differences. The FP16 variant explicitly
selected the ordinary-WebGPU kernel, not subgroup matrices. Values below are
median wall-time tok/s including encoding and readback; batch rates are aggregate.
The baseline is the preceding optimized 64-position/vector-GEMV implementation,
not the older eight-position baseline in the preceding table.

| Prompt | Batch | Prefill baseline | Prefill FP16 | Prefill matrix | Decode baseline | Decode FP16 | Decode matrix |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 128 | 1 | 903.3 | 1377.8 | 1452.9 | 137.2 | 136.7 | 139.4 |
| 128 | 4 | 772.7 | 1145.7 | 1132.5 | 217.6 | 210.4 | 203.0 |
| 512 | 1 | 709.3 | 1003.9 | 1035.8 | 104.2 | 107.8 | 103.0 |
| 512 | 4 | 697.5 | 1014.3 | 1008.5 | 190.4 | 191.4 | 189.9 |
| 1024 | 1 | 552.1 | 762.1 | 730.1 | 80.4 | 77.3 | 75.5 |
| 1024 | 4 | 574.2 | 757.9 | 780.4 | 159.0 | 149.3 | 155.2 |

All 54 pairwise output comparisons matched; no GPU validation or page errors
were recorded. Ordinary FP16 prefill improved 1.32–1.53×; matrix prefill improved
1.32–1.61×. Matrix intrinsics were not consistently faster than the portable
FP16 kernel. This is a prefill improvement, not a demonstrated decode gain:
FP16-path decode medians ranged from 6.1% slower to 3.5% faster, and matrix-path
decode from 6.7% slower to 1.6% faster. Three repetitions do not establish the
cause or statistical significance of those differences.
All six total-time medians improved for both new paths. Per-run ranges,
source snapshots and hashes are preserved under
`test-results/browser/native-kernel-final/`.

Separate accuracy runs compared all 107,520 vocabulary logits after
128/512/1024-token prefills. The FP16 shared-operand path had minimum cosine
similarity 0.9999996334, maximum relative L2 error 0.001057, and maximum absolute
error 0.01588. Both FP32 paths (portable and subgroup matrix) had maximum
relative L2 error 3.46e-6 and maximum absolute error 7.16e-5. All output IDs
matched, and no GPU/page errors occurred in the 12 runs.
Reports are under `test-results/browser/native-kernel-final-logits/`.
Heterogeneous 9/33/65-token prompts, nine requests, three active slots and up to
16 generated tokens also matched between batched and individual scheduling:
four comparisons each for normal-browser FP16 and experimental matrix paths.
Their reports are under `native-kernel-fused-kv/` and
`native-kernel-final-heterogeneous/`. The Chrome build, tools type check and
29 focused engine/host/weight-parser tests passed for this revision.

The built extension passed actual UI-triggered English→Korean translation and
exact source restoration in ordinary Chrome: four paragraphs in 2 seconds
(980.7 prefill / 143.6 decode tok/s), and 32 paragraphs in 11 seconds
(1113.7 / 164.4 tok/s). An experimental-enabled four-paragraph run also passed,
in 3 seconds (802.6 / 116.4 tok/s). All three reported `backend: kernels`,
zero page errors, zero missing-count warnings and zero empty segments.
Reports are in `native-kernel-page4/`, `native-kernel-page32/` and
`native-kernel-matrix-page4/` under `test-results/browser/`.
These are single-run surface checks, not matched page-speed A/B results or
linguistic-quality certification.

##### Independent mixed-step token budget

The kernel scheduler now separates independent request/KV slots (eight) from
the number of activation rows processed in a mixed prefill/decode step.
`mixedPositions` defaults to 32, bounded by the prefill capacity (64) and never
below the request-slot count. Pure prefill keeps its existing capacity; pure
decode still processes one token per live decoding request.

Every live decoder is scheduled first. Remaining mixed-step capacity is shared
between prefilling requests using the existing rotating scheduler. Mixed steps
above eight rows therefore use the tiled GEMM and tiled attention instead of
forcing all prompt work through the small-row GEMV. A prompt contributes at most
one output row, so the output/readback buffers remain sized by request slots,
not by activation capacity. KV allocations and application request timing,
`PAGE_PACKS`, text packing and worker count are unchanged.

This is a throughput/latency tradeoff, not a wall-clock deadline guarantee.
The 16/32/64-token selection run used ordinary Chrome, nine heterogeneous
9/128/512-token requests, concurrency 3/8, and up to 32 outputs per request.
All output comparisons matched. The 32-token candidate reduced batched total
time by 35–37% in this single sweep. The 64-token candidate increased mixed-step
p95 to 78–81 ms versus 39–48 ms at 32; 16 tokens did not consistently improve
total time. Selection evidence is under `test-results/browser/mixed-engine-selection/`;
the pre-change sources are preserved under `mixed-engine-baseline/`.

Reproduce the final longer-input evaluation:

```sh
BASELINE_KERNEL=test-results/browser/mixed-engine-baseline/kernels.ts \
MODE=heterogeneous LENGTHS=9,33,512,1024 HETERO_REQUESTS=12 BATCHES=3,8 \
STEPS=64 WARM_STEPS=1 REPEATS=3 QA_DIR=test-results/browser/mixed-engine-final \
node test/engine-spike/run-kernels.mjs
```

`VARIANT_OPTIONS='{"current":{"mixedPositions":16}}'` selects a diagnostic
mixed budget without modifying production or the application.
Mixed-step input tok/s must be reported separately from pure-prefill tok/s:
the former includes simultaneous decode work. Mixed-step wall-time percentiles
measure GPU-step cadence, not complete per-request inter-token or queue latency.

The final ordinary-Chrome comparison used 12 requests spanning 9/33/512/1024
input tokens, up to 64 outputs each (4,734 inputs and 576 outputs per run),
concurrency 3/8, and three interleaved repetitions. Each variant also ran the
identical requests individually as a correctness control. All 24 comparisons
matched, with no GPU validation or page errors.

| Concurrent requests | Total seconds before → after | Mixed input tok/s before → after | Mixed-step p95 ms before → after |
|---:|---:|---:|---:|
| 3 | 17.34 → 9.93 | 189.5 → 610.9 | 39.7 → 64.4 |
| 8 | 15.50 → 9.79 | 172.4 → 526.1 | 42.2 → 72.7 |

Entries are medians of three per-run measurements (including the p95 column).
Total time improved 36.8–42.7%; mixed input throughput improved 3.05–3.22×.
The tradeoff persists at longer contexts: mixed-step p95 increased 1.62–1.72×.
This change does not claim a decode-latency improvement or a fixed millisecond
cap. The individual controls execute an unchanged scheduling path yet their
total-time medians differed by 6–9%, demonstrating measurement variability;
three repetitions are not confidence intervals. Different scheduling also
changes how many input tokens fall in pure versus mixed phases, so total
completion time is the primary matched-work metric.

The experimental subgroup-matrix path separately passed four heterogeneous
output comparisons with no GPU/page errors. Reports are under
`test-results/browser/mixed-engine-final/` and `mixed-engine-matrix/`.
The Chrome build, tools type check and 29 focused engine/host/parser tests
passed; those unit suites are integration checks, while the real-model GPU
runs exercise the changed mixed scheduler.

The actual Chrome extension passed all translations and exact source restoration
with no page errors, missing token-count warnings or empty segments: four
paragraphs in 2 seconds, and three 32-paragraph runs all in 12 seconds.
The 32-paragraph medians were 975.3 pure-prefill / 141.7 pure-decode tok/s.
Page completion therefore did not improve over the preceding 12-second median;
these were separate runs, not matched page-level A/B tests.
The 32 displayed paragraph translations matched the preceding run3 fixture
output. Its pure-decode counter changed from 1,416 to 1,440, but that counter
excludes mixed-phase outputs and must not be interpreted as total generation
length. Evidence is under `test-results/browser/mixed-engine-extension/`.
The engine improvement is demonstrated on heterogeneous concurrent workloads,
not as a general page-speed or linguistic-quality claim.


##### Cooperative attention and wider prefill GEMM

The portable decode-attention kernel now shares Q across a 256-thread group,
computes QK cooperatively, and splits the value reduction into eight context
partitions before a tree reduction. Accumulation stays FP32, with the same
causal/window masks and independent request KV slots. No optional subgroup
feature is required.

Prefill attention now shares each 16-key KV tile across eight queries rather
than four. The 256-thread group uses two QK lanes per key and vectorized
value/output operations, staying below the portable 16-KiB shared-memory
limit. Independent slots within a tile are still processed separately.

The FP16 prefill GEMM adds a 64-row × 32-output tile for more than 32 active
rows. Its 128 threads retain the original 4 × 4 FP32 accumulator microtile,
while reusing each dequantized weight across twice as many input rows.
The original 32-row tile remains in use for smaller and mixed steps; the
FP32 and experimental matrix paths retain their existing GEMM shapes.
Application packing, request timing and worker count are unchanged.

Kernel A/B runs must isolate helper shaders as well as `kernels.ts`. The
benchmark accepts per-variant module paths, for example:

```sh
BASELINE_KERNEL=test-results/browser/kernel-v2-baseline/kernels.ts \
VARIANT_SHADERS='{"baseline":{"kernelmatmul":"test-results/browser/kernel-v2-baseline/kernelmatmul.ts","kernelattention":"test-results/browser/kernel-v2-baseline/kernelattention.ts"}}' \
LENGTHS=128,512,1024 BATCHES=1,4 STEPS=64 REPEATS=3 \
QA_DIR=test-results/browser/kernel-v2-final \
node test/engine-spike/run-kernels.mjs
```

Each variant has its own shader namespace; source paths and SHA-256 hashes
are recorded in the report. `CHECK_LOGITS=1 BATCHES=1 MODE=uniform` also
compares the full vocabulary after the last requested decode step, outside
the timed workload.

Selection rejected a 32 × 64 output tile (inconsistent gains and a batched
regression) and a K=128 staging tile (3–7% slower). The selected 64 × 32
row tile uses 12 KiB of shared memory, versus 8 KiB for the original FP16
tile, without doubling each thread's accumulator count. In the isolated
1,024-input-token, one-output benchmark, aggregate prefill throughput
improved from 987.4 to 1,013.9 tok/s for one request and from 826.2 to
856.1 tok/s for four requests over three interleaved repetitions.
This is a modest improvement, not removal of the MLP bottleneck.
Candidate sources and measurements are preserved under
`kernel-v2-isolation/`, `kernel-v2-selection/`, `kernel-v2-k128/` and
`kernel-v2-wide-rows/` in `test-results/browser/`.

The eight-query attention tile was then compared against four queries with
the selected GEMM and decode kernel held constant: 40 runs covering
9/33/1,024-token inputs, concurrency 1/4, and nine heterogeneous queued
requests, with two interleaved repetitions. Every token comparison matched,
with no GPU or page errors. At 1,024 tokens, median prefill throughput rose
852.2 → 898.8 tok/s (one request) and 828.2 → 885.2 tok/s (four requests);
short-input results were effectively flat. Evidence is under
`kernel-v2-prefill-selection/`.

The Chrome build, tools TypeScript check and 29 focused engine/host/parser
tests passed. These are integration checks; the real-model GPU comparisons
exercise the changed kernels and their numerical behavior.

Final ordinary-Chrome A/B measurements used the frozen pre-change engine,
PLaMo 0.8B Q4F16 on Apple M5, 64 generated tokens per request and three
interleaved repetitions. Rates below are medians of per-run phase wall-time
throughput, excluding model load/warmup; batch rates sum all request tokens.

| Input tokens | Requests | Prefill tok/s before → after | Decode tok/s before → after |
|---:|---:|---:|---:|
| 128 | 1 | 769.2 → 817.9 | 84.5 → 92.4 |
| 128 | 4 | 766.9 → 829.1 | 140.8 → 143.6 |
| 512 | 1 | 722.4 → 775.1 | 74.8 → 87.1 |
| 512 | 4 | 750.6 → 835.7 | 142.4 → 155.3 |
| 1,024 | 1 | 589.4 → 641.8 | 64.7 → 83.0 |
| 1,024 | 4 | 587.8 → 646.0 | 128.3 → 145.6 |

All 36 runs matched output tokens, with no GPU/page errors. Absolute rates
were lower than earlier selection runs, so comparisons must stay within the
same interleaved experiment rather than mix rows from separate runs.
Prefill improved 6.3–11.3%; decode improved 2.0–28.2% in this run.

A separate one-repetition mixed-workload check used nine queued requests
with 9/33/512/1,024 input tokens and up to 32 outputs, plus individual
controls. All eight runs matched. Batched total time changed 6.709 → 6.215 s
at concurrency three and 6.138 → 6.066 s at concurrency eight. Mixed-phase
input throughput at concurrency eight regressed 542.1 → 499.2 tok/s despite
the small total-time improvement; this is not a universal mixed-step speedup.

Full-vocabulary comparisons after 16 generated tokens passed at prompt
lengths 1/33/65/1,024/2,032, including row-tile tails and the KV-capacity
boundary. Across 107,520 logits per comparison, maximum relative L2 error
was 3.87e-4 and maximum absolute error 0.00787. Generated tokens matched
exactly; logits are not bit-identical after changing the attention reduction
order. Reports are under `kernel-v2-final/`, `kernel-v2-final-logits/`
and `kernel-v2-final-mixed/`; selected sources are under `kernel-v2-selected/`.
No matched llama.cpp or vLLM comparison was run, and these improvements
do not establish native-engine parity.

The portable FP32 and experimental subgroup-matrix modes each passed four
additional real-model runs at 33/1,024 input tokens and eight generated
tokens, including full-vocabulary checks, with no token mismatches or
GPU/page errors (`kernel-v2-f32/`, `kernel-v2-matrix/`).

The built extension was exercised through the real translation toggle in
ordinary headed Chrome. Four paragraphs translated in 3 seconds; the three
32-paragraph runs completed in 13/14/13 seconds, with median pure-prefill
842.4 tok/s and pure-decode 130.4 tok/s. Every paragraph translated and
restored exactly, the backend remained `kernels`, and all runs had zero
page errors, missing-count warnings or empty segments. All 32-paragraph
translations matched the preceding mixed-engine run3 fixture.

These extension results do **not** demonstrate a page-speed improvement:
the preceding separate runs had a 12-second median and higher absolute
rates. They were not a contemporaneous page-level A/B comparison, so the
difference cannot be attributed to this patch. The measured engine
improvement is the interleaved kernel A/B result above, not a claim about
end-to-end page latency. Extension evidence is under `kernel-v2-extension/`;
the temporary Chrome profile was removed after verification.

##### Minimum-throughput target and remaining bottlenecks

The acceptance floor is 1,000 prefill input tok/s and 100 decode output
tok/s, measured separately for a single request rather than hidden by
aggregate batch throughput. Model loading and warmup are excluded. Report
the minimum as well as the median across repetitions; a brief peak above
the floor is not sufficient.

The current engine was investigated without production changes, using
ordinary Chrome and the same Q4F16 model. An initial five-repetition
1,024-input/128-output run passed both floors, but prefill fell from
1,060.9 to 1,012.2 tok/s. A longer run after the long-context measurements
did not pass:

| Input / generated tokens | Repetitions | Prefill median / minimum tok/s | Decode median / minimum tok/s | Runs meeting both floors |
|---|---:|---:|---:|---:|
| 1,024 / 128 | 20 | 968.1 / 936.1 | 122.5 / 104.5 | 0/20 |
| 2,032 / 16 | 3 | 871.4 / 851.7 | 116.3 / 116.2 | 0/3 |

Every prefill measurement in these two runs missed the floor; every decode
measurement passed. This does not invalidate the earlier 641.8/83.0 tok/s
result or establish a reliable decode floor across machine states. The
machine reported AC power and no recorded thermal/performance warning;
no thermal or power cause for the rate variation was established.

Per-pass GPU timestamps identify the remaining work:

| Category | 1,024-token prefill GPU share | 1,024-token decode GPU share | 2,032-token prefill GPU share |
|---|---:|---:|---:|
| MLP gate/up + down | 54.6% | 41.5% | 43.1% |
| Attention | 26.1% | 18.4% | 40.3% |
| QKV + output projection | 15.1% | 11.2% | 12.3% |
| LM head | 0.1% | 14.1% | <0.1% |

Shares use summed GPU pass timestamps, not wall time. Timestamp precision
is coarsened; tiny-pass values and differences between summed durations
and the GPU span must not be treated as exact. At 1,024 tokens, CPU encode
was 29.6/840.8 ms of prefill wall time and 4.7/256.0 ms of decode wall
time. GPU-span-to-host-wall gaps remain unattributed, not automatically
classified as JavaScript overhead. Profiled and unprofiled output arrays
matched in all five paired conditions; all measured reports had no
GPU/page errors.

Priority follows measured cost rather than another arbitrary tile sweep:

1. **MLP GEMM:** `kernelmatmul.ts` still performs FP32 vector FMAs after
   staging FP16 operands; it is not a hardware-matrix path in ordinary
   Chrome. Q4 unpacking/scaling and shared-memory staging repeat per tile.
   Investigate layout and subgroup-aware reuse, separating staging cost
   from multiplication cost before selecting another tile.
2. **Prefill attention:** the 16-key loop has five workgroup barriers.
   One lane per query serially computes maximum, exponentials and sum.
   Cooperative softmax and larger/pipelined KV tiles address a cost that
   grows to 40.3% of prefill GPU time near the context limit.
3. **Decode GEMV and vocabulary projection:** all GEMVs together consume
   66.7% of 1,024-token decode GPU time. The final 16 partial sums are
   reduced serially. The 107,520 × 1,536 LM head alone stores 87,736,320
   bytes of Q4 weights/scales and consumes 14.1%. Subgroup reductions and
   an LM-head partial-argmax path are candidates, with exact tie semantics
   and full-vocabulary diagnostic coverage retained.
4. **Attention occupancy:** decode's eight context partitions remain
   inside one workgroup, not independent split-KV workgroups. Prefill
   tiles also loop serially over distinct KV slots. Mixed steps put
   independent decode queries first, which can reduce eight-query tile
   reuse. Split-KV with stable merging and separate mixed-step attention
   dispatches are candidates, not measured speedups.

The ordinary adapter advertises `subgroups`, but `openDevice()` requests
them only with the experimental matrix feature; the ordinary device has
`shader-f16` but no enabled subgroups. Exploiting this available capability
does not require enabling unsafe WebGPU, whereas the current matrix path
does. Any new path still needs a portable fallback and numerical checks.

Relative to the preceding 641.8/83.0 single-request result, the target
requires 55.8%/20.5% more throughput, equivalent to removing 35.8%/17.0%
of phase wall time. CPU encoding alone cannot close that gap. Candidate
gains remain unproven; twenty repetitions also do not certify indefinite
sustained performance. Artifacts, frozen sources, profiling harness and
machine-readable results are under `test-results/browser/engine-target-profile/`.

##### Structural attention execution

Ordinary WebGPU devices now request `subgroups` when advertised, independently
of the experimental matrix feature. Prefill attention checks the actual lane
mapping, subgroup membership and full participation before using segmented
shuffle reductions. It does not assume that local invocation order matches
subgroup order. Unsupported mappings and devices retain a portable path.

The selected 16-key subgroup path keeps online-softmax maximum and denominator
in registers, performs the QK-pair/max/sum reductions cooperatively, and uses
four workgroup barriers per KV tile rather than five. The portable path
parallelizes exponentials and uses a balanced sum without adding a barrier.
Arithmetic and KV storage remain FP32; no precision reduction or expanded
weight cache is introduced.

Mixed steps now send leading decode queries to decode attention and the
remaining prompt queries to prefill attention. Prefill's 32-byte metadata
includes `rowStart`, while decode keeps its original 16-byte metadata.
Projection GEMMs still process the combined activation rows. This avoids
serializing unrelated decode KV slots inside a shared prefill tile without
changing admission order, the mixed token budget, application packing or
worker count.

GEMM register expansion, full FP16 weight expansion, subgroup operand
shuffles, a larger cooperative GEMM tile, and a 32-key attention tile were
implemented and rejected after real-model comparisons. The 32-key tile
also required a larger negotiated shared-memory limit; that negotiation
was removed with the rejected path. Two subgroup GEMV designs likewise
failed to show a dependable advantage, so production GEMV and GEMM remain
unchanged. Candidate sources and negative measurements are retained under
`test-results/browser/structural-candidates/` and the corresponding
`structural-*` report directories.

The subgroup guard follows the
[GPUWeb portability constraints](https://github.com/gpuweb/gpuweb/blob/main/proposals/subgroups.md#portability-and-uniformity):
feature support alone does not establish a useful lane mapping. Rejected
implementations remain diagnostic artifacts, not production switches.
The Chrome build, tools TypeScript check and 29 focused engine/host/parser
tests passed after selecting the production paths.

Final numerical checks covered prompt lengths 1/9/33/65/1,024/2,032 with
16 generated tokens. All token sequences matched; full-vocabulary relative
L2 error was at most 2.83e-4 and absolute error at most 0.00766. Additional
real-model runs passed with the subgroup feature disabled, the mapping guard
forced to its portable branch, FP32 GEMM, and experimental matrix GEMM.
Fallback mixed workloads also matched individual and baseline token sequences.
All reports had no GPU/page errors. These diagnostic overrides exercise real
GPU math, not mocked results, but do not certify other physical GPU vendors.

The two-repetition mixed selection used nine queued 9/33/512/1,024-token
requests and up to 32 outputs each. Median total time changed 4.409 → 4.166 s
at concurrency three and 4.770 → 4.583 s at concurrency eight. Mixed input
throughput changed 755.0 → 787.9 and 632.4 → 672.5 tok/s respectively.
Run-to-run variability was substantial. One separate no-subgroup mixed
smoke run was slower (1.678 → 2.119 s); fallback performance is not claimed
to improve universally. Numerical and mixed evidence is under
`structural-final-logits/`, `structural-no-subgroups/`,
`structural-mapping-fallback/`, `structural-f32/`, `structural-matrix/`,
`structural-fallback-mixed/` and `structural-mixed-selection/`.

Final interleaved A/B measurements (Apple M5, ordinary Chrome WebGPU, PLaMo
0.8B Q4F16, batch 1) use wall-clock phase throughput, including command encoding
and readback. Each row reports median / minimum tok/s, not a peak:

| Input / generated tokens | Repeats per variant | Variant | Prefill tok/s | Decode tok/s | Runs meeting both 1,000 / 100 |
| --- | ---: | --- | ---: | ---: | ---: |
| 1,024 / 128 | 20 | Frozen baseline | 848.5 / 736.8 | 109.8 / 87.5 | 1/20 |
| 1,024 / 128 | 20 | Structural attention | 921.0 / 718.1 | 106.6 / 102.3 | 2/20 |
| 2,032 / 16 | 3 | Frozen baseline | 627.1 / 626.1 | 100.6 / 93.7 | 0/3 |
| 2,032 / 16 | 3 | Structural attention | 806.2 / 782.2 | 98.5 / 93.5 | 0/3 |

Median paired prefill speedups are 7.9% and 24.7%, respectively. Decode is
essentially unchanged by this attention-prefill change: paired ratios are
0.993 and 1.017. The prefill minimum target is **not met**; long-context decode
also misses its minimum target. The 1,024-token prefill minimum did not improve.
Run-to-run variability is substantial; these measurements do not establish its
cause or a universal performance floor. All 46 runs have matching generated
tokens against the frozen baseline, without GPU validation or page errors.

The rebuilt extension was also exercised through the actual offscreen kernels
backend, without unsafe WebGPU features or application scheduling changes:

| Page | Runs | Completion seconds | Prefill tok/s | Decode tok/s |
| --- | ---: | --- | --- | --- |
| 4 paragraphs | 1 | 2 | 953.9 | 140.6 |
| 32 paragraphs | 3 | 12, 11, 11 | 1000.0, 1004.2, 994.4 | 144.1, 160.8, 154.2 |

All pages translated every paragraph and restored the original page; no errors,
count warnings, or empty segments were reported. The previous kernel-v2
32-paragraph fixture took 13, 14, 13 seconds (historical comparison, not an
interleaved A/B). Current translations were identical across three runs but
differed from that fixture in paragraph 32: `표면이 눈으로 덮이면` became
`표면에 눈이 덮이면`. Therefore this real-page check is not byte-identical output
parity, despite the synthetic token/logit checks passing.

Artifacts: `test-results/browser/structural-final-sustained/`,
`structural-final-long/`, and `structural-extension/`; consolidated results are
in `structural-final-sustained/summary.json`. Exact selected source snapshots
are in `structural-final-sources/`. GEMM and decode GEMV remain the baseline
implementations because the tested replacements did not show repeatable gains.
These results establish a limited attention improvement, not native-engine
parity or completion of the throughput targets.

#### What was tried to take the CPU out of the step

Three ways to stop the CPU from touching the step were implemented and measured
(`node test/engine-spike/run-gpursident.mjs`, report key `gpuResident`):

| attempt | implementation | result |
|---|---|---|
| keep the KV cache in GPU buffers | `preferredOutputLocation: {present.*: 'gpu-buffer'}`, fed back with `Tensor.fromGpuBuffer`, `env.wasm.proxy = false` | works (`kvOnGpu: true`, only logits return) and costs the same: **47.4 ms/step against 47.5** for the CPU-cache path in the same run |
| drop ORT's proxy worker | `env.wasm.proxy = false` vs default, fresh page each | no effect: 48.4 / 47.7 / 47.4 / 48.9 ms alternating |
| capture the step as one submission | `enableGraphCapture: true`, all outputs `gpu-buffer` | refused: *"External buffer must be provided for input/output index 0 when enableGraphCapture is true"* - capture needs pre-allocated, static-shape buffers for every input and output |

So the per-step KV transfer was never the cost (the tensors are ~6.5 MB at 800 tokens and the copy
path is fast), and neither is the proxy hop. What remains is the per-node dispatch inside
`session.run`, and this runtime offers no API that removes it: IO binding changes *where* tensors
live, not how many passes run, and graph capture - the one mechanism that would collapse thousands
of passes into a single submission - needs an export with a **static KV capacity and pre-allocated
buffers**. This graph has symbolic `batch_size`/`sequence_len` and a cache that grows every step, so
capture is blocked at the export, not at the code that calls it.

ORT's web build has no profiler (`startProfiling` is a no-op there), so the split was taken from
the OS instead: a 200-step decode loop timed with `ps`'s accumulated CPU time per browser process
(`node test/engine-spike/run-sustain.mjs`, `STEPS` to change the count).

| process | role | CPU per step |
|---|---|---|
| renderer | ORT's proxy worker: JS + wasm, building bind groups and encoders | **28.3 ms** |
| GPU process | Metal driver: validating and encoding the submissions | **35.3 ms** |

Wall clock was 57.1 ms/step for that loop. Both processes are busy in parallel, so roughly 28-35 ms
of every step is CPU work in each - the same order as the injected-node slope, and enough on its own
to explain the step: of the 57 ms, at most ~10 ms is GPU work (7-8 ms of weight traffic plus 2.7 ms
of arithmetic). The device is idle for the large majority of a decode step, and it is idle *because*
the CPU path prepares thousands of small submissions, not because there is too little math to give
it. Filling it with rows or tokens amortises that CPU work (the tables above); removing it requires
fewer API-level operations per step - a fused export, a captured graph, or a runtime that does
those fusions itself.

## Live YouTube boundary

The fixture tests and youtube.com tests are distinct. The live test requires real search results,
actual scroll-triggered inserted results, their automatic translation and exact restoration, and
same-document navigation into a real watch URL.

When the watch title is visible, its translation and exact restoration are mandatory. When the
site explicitly requires sign-in and hides the title, the report records `blockedCapabilities` and
`accessRestriction`; playback and that hidden title remain unverified. The test then requires a
real, visible, public English comment on the watch page to translate and restore exactly. Missing
comments, unexpected missing metadata, or translation failures still fail. No account, consent,
CAPTCHA or bot restriction is bypassed. A successful public-content check must never be reported
as unrestricted YouTube compatibility.

## Evidence and limits

Commit-specific outcomes belong in PR checks and artifacts; the existence of these workflows does
not mean they passed. Reports record environment, adapter and host state plus generation counts,
and preserve exact source restoration checks. Each failure is retained, including failed repeats
before a code fix.

Protocol validity is not a linguistic-quality score. Logged-in variations, every site layout, all
GPU vendors, and arbitrarily long sessions are not certified. A successful macOS/Metal run does not
prove Linux software rendering or Firefox success — the ONNX cards need `shader-f16`, which a
software adapter does not expose. Historical alternate-engine tests are not evidence of this
extension's operation. Model startup readiness alone is never an end-to-end pass.

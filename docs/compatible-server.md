# OpenAI-compatible server (0.1.6)

The extension can use either its existing on-device PLaMo 3 Translate model or an
explicitly configured **OpenAI-compatible Chat Completions server**. These are
independent paths. Selecting a server does not download or initialize a local
model, use the on-device tokenizer, or require WebGPU.

## Configure

Open Options from the extension popup. Supported browsers use the source tab's
side panel; otherwise Options opens in a separate window. On a fresh install,
choose **Configure compatible server** instead of downloading a model.

Select **OpenAI-compatible server**, enter Base URL and model, optionally enter
an API key, choose the target language and Save. **Load models** uses `GET
/models` to fill suggestions; manual model entry remains supported when that
endpoint is unavailable. **Test provider** uses the currently displayed
settings, without saving them or opting any tab in.

Examples of API bases: `http://localhost:8000/v1` (local compatible server),
`http://localhost:11434/v1` (Ollama), `https://api.openai.com/v1`, or an explicit
reverse-proxy prefix such as `https://example.com/inference/v1`. A bare origin
has `/v1` appended; a full `/chat/completions` URL is accepted and normalized.
Paths are otherwise preserved. Do not put credentials, query strings or a
fragment in Base URL. Choose the server's actual model ID (for example `big`);
the extension does not assume a particular model family.

All tabs still default **OFF**. Turn translation ON for the intended tab. OFF
aborts that tab's outstanding HTTP requests and restores its latest original
text. DOM insertion, text-node reuse, SPA navigation, inline ownership and
restoration continue to use the existing pipeline. Other tabs remain unchanged.

## Protocol and errors

`POST <base>/chat/completions` sends `model`, `messages` and `stream:false`.
No provider-specific sampling settings or JSON-schema parameters are imposed.
For multiple text segments the model is instructed to return an ordered JSON
string array; the count and output validity are checked before writing the DOM.
Only final `message.content` is used, not `reasoning_content` or tool calls.
The server must support Chat Completions; a Responses-only endpoint is not
supported by this adapter. Response streaming is not yet implemented.

The timeout covers the complete response (5–300 seconds, default 60). Responses
are capped at 2 MiB. HTTP auth, rate-limit, timeout, invalid JSON, result-count
mismatch, truncated output and malformed generated text fail explicitly. There
is no silent switch to another provider and no automatic paid-request retry.
The browser can suspend a service worker during unusually long idle requests;
a closed message channel is a failure, not a successful translation.

## Privacy

Only choosing the server is not consent to translate all open tabs. Translation
sends selected tabs' text and bounded page/region context to the configured
server. The translation test explicitly sends a fixed test sentence. Model-list
loading explicitly contacts the configured server. Plain HTTP is unencrypted;
use a trusted local network or HTTPS.

The optional API key is stored in browser-local extension storage, not sync;
this is **not encrypted secret storage**. Storage access is restricted to trusted
extension contexts where the browser supports it. The key is omitted from all
content snapshots, page messages and cache identifiers. HTTP requests originate
in the background, omit cookies/referrers and refuse redirects. Error messages
do not echo response bodies or credentials. Reset clears the saved key.

## Verification boundaries

`test/server.test.ts` uses actual HTTP streams with labelled deterministic
protocol responses: it tests the client contract, not AI translation quality.
`test/server-extension/e2e.mjs` installs the unchanged extension and calls an
actual configured model server. The CI workflow starts a pinned Ollama CPU
server and model; the original on-device SDK/model files are not replaced.
An auth-checking local gateway forwards successful requests unchanged to the
real server, and only synthesizes the explicitly tested HTTP error statuses.

A passing Ollama run does not certify every vLLM/SGLang/LM Studio/OpenAI deployment
or model. Server authentication, model IDs, network exposure, TLS certificates
and provider policies remain the operator's responsibility. Firefox's existing
on-device-model issue remains separate and is not fixed by adding this adapter.

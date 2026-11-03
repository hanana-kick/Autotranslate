# Autotranslate

A Manifest V3 TypeScript extension that translates explicitly selected browser
 tabs in place and restores their latest original text. The translation engine
can be either **on-device TranslateGemma** or an **OpenAI-compatible server**.

Chrome is the supported packaged target. Firefox builds are available for
experimentation; its existing native model preparation failure is tracked in
[issue #2](https://github.com/hanana-kick/Autotranslate/issues/2). Adding the server
adapter is not a claim that all Firefox paths have been validated.

## Use an existing compatible server

Open the extension popup on the page to translate, then **Options**. Options opens
in that tab's side panel when supported, otherwise in a separate popup window.
Select **OpenAI-compatible server**, set **Base URL**, optional **API key**, and
**model ID**, then **Save**. Use **Load models** for suggestions or enter the ID
manually. **Test provider** tests the currently displayed fields before saving.

Example settings for a server exposing model `big`:

```text
Engine:    OpenAI-compatible server
Base URL:  http://localhost:8000/v1
API key:   optional; leave empty for an unauthenticated local server
Model ID:  big
```

Replace localhost with the actual server hostname when it runs on another
machine. Root URLs get `/v1` appended; explicit reverse-proxy paths are preserved.
The server must support `POST /chat/completions`. `GET /models` is optional.

**Server mode requires no local model download, local tokenizer or WebGPU.** On a
fresh install, choose **Configure compatible server** in onboarding instead of
installing the on-device model. The original local engine remains available.
See [the server guide](docs/compatible-server.md) for protocol, errors and privacy.

## Explicit per-tab control

Every tab starts **OFF**. Turn **Translate this tab** ON only for the intended
tab. Other tabs, including other pages of the same site, stay unchanged. OFF
cancels that tab's outstanding server requests and restores its latest original
text. New DOM content, text-node reuse and same-tab navigation are processed
while that tab remains selected. Closing a tab discards its selection; browser
session storage preserves selection across service-worker suspension only.

Options retains the originating tab even when another tab gains focus. Closed
or unbound target tabs cannot silently be replaced with another translation
target. Setup and provider tests never opt a web tab in.

## Privacy and network behavior

On-device mode uses the existing bundled MediaPipe/LiteRT runtime and the original
TranslateGemma `.task` file, downloaded once or imported from disk. In that mode,
page translation text does not leave the browser.

Server mode sends the selected tab's text and bounded page/region context to the
configured server. An explicit provider test sends a fixed sample sentence.
API keys remain in browser-local extension storage, not sync or page messages;
this is **not encrypted secret storage**. Supported browsers restrict that
storage to trusted extension contexts. Plain HTTP is unencrypted; use HTTPS
outside trusted local networks. Requests omit cookies/referrers and refuse
redirects. There is no silent provider fallback or automatic paid-request retry.

## Build and install

Node **24+** is required for the existing TypeScript test tooling.

```sh
npm ci
npm run ci
# build/chrome/ and build/firefox/; packaged archives in dist/
```

For Chrome, enable Developer mode at `chrome://extensions` and load `build/chrome`.
For an existing installation, reload the extension and the web pages whose
content scripts should be updated. Firefox temporary source installs use
`about:debugging`; they are not equivalent to native-model validation.

The local model uses WebGPU and browser storage; the server engine instead needs
a reachable HTTP(S) Chat Completions endpoint. Default language is derived from
the browser UI, and the target/source languages can be changed in Options.

## Tests and their boundaries

- `npm run ci`: types, production-module tests, both target builds and ZIP checks.
- `npm run test:browser`: real DOM and extension APIs with an explicitly labelled
  deterministic inference double; this is not genuine-model evidence.
- `test/server.test.ts`: actual HTTP streams with synthetic protocol cases,
  including optional auth, count/schema validation, cancellation and body limits.
- `compatible-server.yml`: installs the unmodified extension and uses an actual
  CPU model server. Successful generations come from that server. Only deliberate
  HTTP error cases and authentication checks are supplied by a forwarding gateway.
- Existing on-device native QA remains separate; neither an HTTP fixture nor a
  different server model proves the native TranslateGemma runtime works.

The tested server model is identified in the run artifacts. A compatible API does
not guarantee every model will obey translation/JSON formatting instructions.
Failures remain failures; an unchanged or malformed output is not proof of
translation quality. Actual success claims belong to completed run evidence.

See [validation contract](docs/testing.md), [DOM audit](docs/optimization-audit.md),
[review status](docs/review-qa-status.md), and [server guide](docs/compatible-server.md).
The earlier [local-only guide](docs/legacy-local-guide.md) is preserved for
historical architecture notes; its old no-server assertions and timing claims
are not the current feature contract.

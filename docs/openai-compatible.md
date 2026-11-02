# OpenAI-compatible translation server (opt-in)

The existing **on-device TranslateGemma model is unchanged and remains the default**. You may instead select **OpenAI-compatible API** in Options (the same tab-bound side panel or separate window as before). Enter a server URL (for example, `https://llm.example.com/v1` or `http://192.168.1.50:8000/v1`), the served model ID, an optional Bearer API key, and a request format. Save, use **Test**, then explicitly turn translation **ON for the tab**. OFF restores that tab's latest original DOM. Other tabs remain OFF unless manually selected.

In remote mode, the page's text **leaves the browser and is sent to the configured endpoint**. No model download, local `.task` file, or browser WebGPU is required. API keys are stored separately in extension-local storage and never included in content-script settings, page DOM, or diagnostics. Chrome's content-script access to `storage.local` is restricted where supported. Prefer HTTPS (or a trusted private network for HTTP): an HTTP connection does **not** encrypt text or credentials. Chrome may restrict HTTP requests to addresses in private networks under browser/network policies.

## Chat completion modes

- **TranslateGemma vLLM delimiters** (default): user `content` is `<<<source>>>en<<<target>>>ko<<<text>>>Hello` (select appropriate codes).
- **Official TranslateGemma**: one user message, `content: [{type:'text',source_lang_code:'en',target_lang_code:'ko',text:'Hello'}]`. Use with an official tokenizer/chat template that accepts structured language metadata.
- **Instruction**: plain user message requesting translation and no explanatory text. For a generic OpenAI-compatible model, not guaranteed optimal for TranslateGemma.

Requests use **POST `/v1/chat/completions`**, `stream:false`, `temperature:0`, one prompt per text, a configurable **maximum of 1–32 parallel requests**, a maximum output-token budget (default 512), and a finite timeout. Messages from the server are never injected as HTML; translations are installed as text nodes through the unchanged existing DOM engine. Incomplete/invalid translations remain errors; there is **no automatic fallback** to the local model or another server.

## Server model list and `max_num_seqs`

**Get server models** reads `GET /v1/models`. The OpenAI API does **not** specify `max_num_seqs` in this response: do not mistake `max_model_len`, `n`, running request count, or this client's configured concurrency for scheduler capacity.

For compatible vLLM servers, the extension additionally tries **GET `/server_info?config_format=json`** at the server prefix and extracts only `vllm_config.scheduler_config.max_num_seqs` and optional `max_num_active_seqs`. This **non-standard administration endpoint** may be unavailable behind an API gateway or denied by access controls; when absent, the UI shows **unknown**, and server translation remains usable. The response also contains sensitive system environment information, so the extension discards it immediately and displays or saves only these two validated numeric values.

`max_num_seqs` is maximum model-runner sequences per scheduler iteration, whereas `max_num_active_seqs` (when supplied) limits admitted RUNNING requests. These are not reliable client concurrency targets in a shared server. The extension exposes a **separate manual client request concurrency** setting; choose according to latency, other users, queueing, and throughput.

**Test coverage**: Node loopback HTTP requests verify model discovery, vLLM-specific metadata and missing endpoint fallback, Bearer header, correct prompt formats, error handling, stable ordering, and a bounded parallel request pool. Browser regression tests install the real Chrome extension and drive translation through a deterministic HTTP protocol fixture with no local model or GPU; this is **not** a test of the user's live vLLM server or model linguistic quality.

## Manual simultaneous translations

The setting is visible and editable **only in OpenAI-compatible mode**. It defaults to 2 and accepts whole numbers 1–32. It counts active translation HTTP requests from **all enabled tabs combined**, not requests per tab and not candidates per response. The shared background scheduler enforces the total, and the DOM engine supplies independent jobs so a single page can actually use it. Local inference stays on its original serial path.

Queued requests are cancelled on tab OFF, navigation/closure or translation-setting changes. In-flight HTTP requests are aborted; the server may still finish computation after a disconnected client. Late results are rejected before DOM writes. Changing the setting cancels obsolete work and retargets only already-enabled tabs. Server-info values are informational: they never override manual concurrency, and lookup failure does not disable server mode.

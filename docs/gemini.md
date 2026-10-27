# Gemini Integration

Oracle supports Gemini in three distinct ways:

1. **Gemini API mode** (`--engine api`) via `GEMINI_API_KEY`
2. **Gemini web (cookie) mode** (`--engine browser`) via your signed-in Chrome cookies at `gemini.google.com` (no API key required)
3. **Gemini App MCP tool** (`gemini_app`) via an existing signed-in BrowserSkill browser connection at `https://gemini.google.com/app` (no cookie extraction or API key)

## Usage (API)

1. **Get an API Key:** Obtain a key from [Google AI Studio](https://aistudio.google.com/).
2. **Set Environment Variable:** Export the key as `GEMINI_API_KEY`.
   ```bash
   export GEMINI_API_KEY="your-google-api-key"
   ```
3. **Run Oracle:** Use the `--model` (or `-m`) flag to select Gemini.
   ```bash
   oracle --engine api --model gemini --prompt "Explain quantum entanglement"
   ```
   Use an explicit current model ID:
   ```bash
   oracle --engine api --model gemini-3.5-flash --prompt "..."
   ```
   Gemini 3.1 Pro is also available; Oracle dispatches it to Google's preview model id:
   ```bash
   oracle --engine api --model gemini-3.1-pro --prompt "..."
   ```
   For the lowest-cost current model:
   ```bash
   oracle --engine api --model gemini-3.1-flash-lite --prompt "..."
   ```

## Usage (Gemini web / cookies)

Gemini web mode is a cookie-based client for `gemini.google.com`. It does **not** use `GEMINI_API_KEY` and does **not** drive ChatGPT.

Prereqs:

- Chrome installed.
- Signed into `gemini.google.com` in the Chrome profile Oracle uses (default: `Default` profile).

Examples:

```bash
# Text run
oracle --engine browser --model gemini-3.5-flash --prompt "Say OK."

# Deep Think browser run (manual-login profile recommended on macOS)
oracle --engine browser --browser-manual-login \
  --model gemini-3-deep-think \
  --prompt "Think carefully, then answer in one paragraph."

# Generate an image (writes an output file)
oracle --engine browser --model gemini-3.1-pro \
  --prompt "a cute robot holding a banana" \
  --generate-image out.jpg --aspect 1:1

# Edit an image (input via --edit-image, output via --output)
oracle --engine browser --model gemini-3.1-pro \
  --prompt "add sunglasses" \
  --edit-image in.png --output out.jpg
```

Notes:

- Current explicit IDs are `gemini-3.1-flash-lite`, `gemini-3.5-flash`, and `gemini-3.1-pro`.
- Legacy `gemini-3-pro`, `gemini-2.5-pro`, and `gemini-2.5-flash` browser names remain accepted and map to current Gemini web models.
- If your logged-in Gemini account can’t access the requested model, Oracle auto-falls back to Gemini 3.1 Flash-Lite and logs the fallback in verbose mode.
- Pass `--no-gemini-fallback` to fail instead when the requested web model is unavailable.
- Gemini web requests accept response headers up to 64 KiB automatically, including Google's large security and reporting policies; no Node options are required. These requests honor `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` (including lowercase equivalents) and Node's TLS trust configuration.
- This path runs fully in Node/TypeScript (no Python/venv dependency).
- Local MCP consultations and detached workers use the same Gemini executor as the CLI and preserve the session's saved Gemini options. The explicit model key takes precedence over ChatGPT picker labels.
- Gemini browser runs also support `--remote-host`. Upgrade both endpoints, sign into Gemini on the service host, then run `oracle --engine browser --model gemini-3.5-flash --remote-host <host:port> --remote-token <token> --prompt "Say OK."`. New runs and restarts dispatch the Gemini web executor on that host; Google cookies and browser state stay there. Host manual-login profiles and `oracle serve --browser-attach-running` are supported. Text, file attachments, YouTube prompts, thoughts, and `--no-gemini-fallback` are forwarded; image generation/editing still require a local Gemini run.
- `--browser-model-strategy` only affects ChatGPT automation; Gemini web always uses the explicit Gemini model ID.
- `gemini-3-deep-think` is browser-only for now. `--engine api` rejects it instead of silently falling back to regular Gemini Pro.
- Oracle intentionally does not expose generic `low` / `medium` / `high` Gemini aliases. Explicit IDs keep model choice, billing, and thinking-effort configuration distinct.
- If Chrome cookie extraction fails, the missing-cookie error now includes any cookie-reader warnings plus `--browser-manual-login` / `--browser-inline-cookies-file` guidance.

## Usage (Gemini App MCP tool: `gemini_app`)

The `gemini_app` MCP tool automates the signed-in Gemini App or AI Studio Playground through an existing BrowserSkill browser connection. It is separate from `consult`, the Gemini API adapter, and the cookie-based `gemini-web` client. It does not launch a browser, extract cookies, or perform sign-in.

### Prerequisites

1. **BrowserSkill CLI (`bsk` / `bsk.exe`):** Must be installed (`BSK_BIN` overrides the binary path; otherwise Oracle looks up `~/.local/bin/bsk` or `~/.local/bin/bsk.exe` on Windows). Detached session workers resolve relative `BSK_BIN` paths to absolute paths before running.
2. **Running BrowserSkill daemon:** `BSK_AUTO_START=0` is forced on every CLI invocation so `gemini_app` never auto-starts a daemon. Start the daemon beforehand (on Windows, run `bsk daemon start --foreground` in a managed background session because plain `bsk daemon start` can fail with a Windows Job Object breakaway error).
3. **Connected, signed-in browser:** Keep your existing signed-in browser (such as Microsoft Edge with the BrowserSkill extension enabled and signed into `https://gemini.google.com/app`) connected to the daemon. Each `gemini_app` call starts its own background BrowserSkill automation session (`session start --no-focus`) and stops only that automation session in `finally`. Your browser profile, cookies, and sign-in state are preserved and never cleared.

### MCP Input Schema

`gemini_app` uses a strict input schema (unknown fields are rejected):

- `action` (`"discovery" | "run"`, required): `"discovery"` inspects visible model, thinking, and tool controls without filling or submitting a prompt. `"run"` verifies controls, submits `prompt`, and captures the resulting turn and confirmed local artifacts.
- `site` (`"gemini-app" | "ai-studio"`, default `"gemini-app"`): Selects the browser application. AI Studio supports Playground `chat`; other modes are rejected before submission.
- `prompt` (`string`, optional for `"discovery"`, required non-empty after trim for `"run"`): Prompt text to submit.
- `model` (`string`, default `"current"`): Exact full UI label in Gemini App, or exact observed model code/full title in AI Studio. `"current"` keeps the starting selection. Gemini App picker abbreviations and legacy aliases are not normalized into model choices.
- `thinking` (`"current" | "minimal" | "low" | "medium" | "high"`, default `"current"`): Exact supported thinking level. `"current"` preserves the initial Gemini App level; in AI Studio it keeps the selected model's currently displayed level. AI Studio exposes Minimal/Low/Medium/High; unsupported levels fail before submission.
- `mode` (`"chat" | "image" | "video" | "music" | "deep-research"`, default `"chat"`): Composer tool mode. In `"run"`, every currently checked tool (including `Canvas` or guided learning) is cleared first, then the requested mode (`建立圖像` / `Create image(s)`, `建立影片` / `Create video(s)`, `創作音樂` / `Create music`, or `Deep Research`) is selected and verified against both the reopened tools menu and the active composer chip. `"chat"` requires zero active tool chips.
- `outputDir` (`string`, optional): Directory for screenshots, failure evidence, and confirmed artifacts. Defaults to `<ORACLE_HOME_DIR>/generated/gemini-app-<uuid>`. Paths outside `<ORACLE_HOME_DIR>/generated` require `ORACLE_MCP_ALLOW_EXTERNAL_OUTPUT=1`.
- `timeoutMs` (`number`, positive integer, default `600000`): Overall execution budget in milliseconds.
- `browser` (`string`, optional): Optional BrowserSkill `--browser` selector passed to `session start`.
- `waitForCompletion` (`boolean`, default `true`): When `false`, launches a detached Oracle session worker and immediately returns `sessionId` (`status: "running"`, `detached: true`) for follow-up via the `wait` and `sessions` MCP tools.
- `slug` (`string`, optional): Optional human-friendly Oracle session ID.

### Gemini App Discovery and Selection Verification

- **Discovery (`action: "discovery"`):** Opens the model picker, thinking submenu, and tools drawer, records `selection`, `availableModels`, `availableThinking`, and `availableModes`, writes `<uuid>-selection.png` under `outputDir`, and returns `"Observed controls only; generation and export capability have not been verified."`
- **Run (`action: "run"`):** After selecting the requested model, thinking level, and tool mode and filling the prompt into `rich-textarea .ql-editor[contenteditable="true"]`, the executor reopens the model picker and thinking submenu immediately before dispatch to confirm the `.selected` item matches the requested selection. It then activates the visible enabled send button (`傳送訊息` / `Send message`) with native `press Enter` and waits for a fresh matching `user-query` before awaiting `model-response`. Ambiguous prompt acceptance, post-submit model fallback, or a quota-reset notice fails closed without automatic retry or resend.

### Session Recovery and Artifact Paths

- **Session lifecycle:** Every `gemini_app` call creates a standard Oracle session under `<ORACLE_HOME_DIR>/sessions/<sessionId>` (`meta.json`, `request.json`, `output.log`) with `mode: "browser"`, internal model run key `"gemini-app"`, `options.geminiApp` storing the normalized request, and `geminiApp` storing the result (`text`, `conversationUrl`, `selection`, `availableModels`, `availableThinking`, `availableModes`, `artifacts`, `screenshots`).
- **Detached recovery:** When `waitForCompletion: false` is used (or if a caller disconnects), pass `sessionId` to the `wait` tool (`{ "id": "<sessionId>", "timeoutMs": 600000 }`) or inspect full metadata and logs with `sessions` (`{ "id": "<sessionId>", "detail": true }`). A `wait` timeout never cancels the detached worker. If a session is cancelled, the worker waits for `BrowserSkill.stop()` to release its automation session before recording `status: "cancelled"`.
- **Artifact paths under `outputDir`:**
  - Screenshots: `<uuid>-selection.png`, `<uuid>-research-plan.png` (Deep Research), `<uuid>-complete.png`, and `<uuid>-failure.png` (when a post-dispatch failure occurs). Screenshots are listed in `geminiApp.screenshots` and are not promoted to session `artifacts`.
  - Image (`mode: "image"`): Decoded pixels from the generated `img.image.loaded` element drawn to a canvas and saved as `<uuid>-image.download.png` (`kind: "image"`, `mimeType: "image/png"`, SHA-256 and byte size verified). The artifact label explicitly marks it as `Gemini rendered-image (displayed-resolution <width>x<height>; decoded pixels, not original-resolution download)`. Only `kind: "image"` artifacts appear in the top-level MCP `images` summary.
  - Video (`mode: "video"`): Fetched inside the signed-in page from `video.currentSrc` with `credentials: "include"`, container-verified (`video/mp4` or `video/webm`), and saved as `<uuid>-video.download.mp4` or `.webm` (`kind: "file"`).
  - Music (`mode: "music"`): Fetched inside the signed-in page from `audio.currentSrc` with `credentials: "include"`, container-verified (`audio/wav`, `audio/mp4` `.m4a`, `audio/ogg`, or `audio/mpeg` `.mp3`), and saved as `<uuid>-music.download.<ext>` (`kind: "file"`).
  - Deep Research (`mode: "deep-research"`): Requires a fresh research plan approval button (`Start research`, `Start deep research`, `開始研究`, or `開始深入研究`), clicks it once, then waits for a completed report element with HTTP(S) citations and writes `<uuid>-research.md` (`kind: "deep-research-report"`, `mimeType: "text/markdown"`). An ordinary response without a research plan and cited report fails closed.
  - Failure evidence: If a failure happens after prompt dispatch, `<uuid>-failure.json` is written in `outputDir` with the error, observed reply text, conversation URL, requested selection, screenshots, and `automaticRetryPerformed: false`.

### Verification Status

- Unit and integration coverage (`tests/gemini-app/*`, `tests/mcp/geminiApp.test.ts`, `tests/cli/geminiAppSession.test.ts`, `tests/sessionManager.test.ts`) verifies CLI argument construction, session cleanup, DOM state transitions, media container checks, and detached worker handoff against fixtures.
- Further Gemini App generation/research acceptance was stopped at the user's request. Unverified modes remain unverified, not counted as passed.

### AI Studio Playground

Use the same tool and existing `wait`/`sessions` lifecycle:

```json
{
  "site": "ai-studio",
  "action": "run",
  "model": "gemini-3.5-flash-lite",
  "thinking": "minimal",
  "mode": "chat",
  "prompt": "Reply exactly ORACLE_AI_STUDIO_OK",
  "waitForCompletion": false
}
```

`model: "current"` preserves the starting UI selection. An explicit model uses its exact observed AI Studio code or full display title; production use is not restricted to Flash-Lite. For example, the observed Argon code is `gemini-4-argon`. Actual test generations use only `gemini-3.5-flash-lite`.

The adapter uses the existing signed-in browser, waits for model/thinking panels to close, rechecks selection before sending, and reads only the fresh model turn after the Run control returns. It does not choose API keys or change billing. Any required account/key choice remains in AI Studio's own UI.

A single manual Flash-Lite/Minimal probe returned `ORACLE_AI_STUDIO_OK`; this is not an end-to-end proof of the installed MCP adapter or of Argon. No further broad live acceptance was requested.

## Implementation details

### Gemini API adapter

- `src/oracle/gemini.ts` — adapter using `@google/genai` that returns a `ClientLike`.
  - Model IDs: `gemini-3.1-flash-lite` and `gemini-3.5-flash` use their stable API IDs; `gemini-3.1-pro` maps to `gemini-3.1-pro-preview`; legacy `gemini-3-pro` maps to `gemini-3-pro-preview`.
  - Request mapping: `OracleRequestBody` → Gemini request; `web_search_preview` maps to Gemini search tooling.
  - Response mapping: Gemini responses → `OracleResponse`.
  - Streaming: wraps Gemini’s async iterator as `ResponseStreamLike`.
- `src/oracle/run.ts` — selects `GEMINI_API_KEY` vs `OPENAI_API_KEY` based on model prefix.
- `src/oracle/config.ts` / `src/oracle/types.ts` — model config + `ModelName`.

### Gemini web client (cookie-based)

- `src/gemini-web/models.ts` — centralizes current private web model headers, legacy aliases, and fallback selection.
- `src/gemini-web/client.ts` — talks to `gemini.google.com` and downloads generated images via authenticated `gg-dl` redirects.
- `src/gemini-web/http.ts` — uses a reusable, Gemini-only Undici dispatcher with a 64 KiB response-header limit. It does not change the global dispatcher or replay failed requests. Embedders with custom dispatcher/proxy/TLS settings can use `createGeminiWebDispatcher(options)` and pass `dispatcher` to `fetchGeminiWebResource`; an explicitly supplied dispatcher owns its header limit. Global dispatcher customizations do not configure this dedicated transport.
- `src/gemini-web/executor.ts` — browser-engine executor for Gemini (loads Chrome cookies and runs the web client).

### Gemini App BrowserSkill executor and MCP tool

- `src/gemini-app/types.ts`: `GeminiAppRequest`, `GeminiAppSelection`, and `GeminiAppResult` contracts.
- `src/gemini-app/browserSkill.ts`: `BrowserSkill` CLI wrapper around `bsk` (`execFile` argument arrays, `BSK_AUTO_START=0`, scoped `--session`, and `GeminiAppError`).
- `src/gemini-app/dom.ts`: serialized `MutationObserver` DOM operations (`ready`, `models`, `thinking`, `tools`, `mark`, `send`, `accepted`, `turn`) and in-page media capture (`captureGeminiMedia`).
- `src/gemini-app/executor.ts`: `runGeminiApp` orchestration, reopened selection verification, container byte verification (`verifyMediaArtifact`), Deep Research plan approval/report export, and post-dispatch `*-failure.json` evidence.
- `src/gemini-app/session.ts` and `src/mcp/tools/geminiApp.ts`: `performGeminiAppSession` and `gemini_app` MCP tool registration, `outputDir` boundary check, and detached worker integration.

## Testing

- Unit/regression: `pnpm vitest run tests/gemini.test.ts tests/gemini-web tests/gemini-app tests/mcp/geminiApp.test.ts tests/cli/geminiAppSession.test.ts`
- Live (API): `ORACLE_LIVE_TEST=1 pnpm vitest run tests/live/gemini-live.test.ts`
- Live (Gemini web/cookies): `ORACLE_LIVE_TEST=1 pnpm vitest run tests/live/gemini-web-live.test.ts`

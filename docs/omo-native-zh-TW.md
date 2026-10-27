# OmO Native：Oracle fork、GPT-6 Pro 與 Gemini App (`gemini_app`)

此 fork 以 steipete/oracle 0.22.1 為基線，修正 MCP 明確要求
`gpt-6-pro` 時，儲存的 Standard／Extended 設定覆蓋 Pro 預設值的問題，並新增專用的
`gemini_app` MCP 工具以操作已登入的 Gemini App。
沿用上游的附件、自動送出、重複送出防護與 detached session 流程。

## 建置與安裝

需要 Node.js 24 以上及專案指定的 pnpm。從此 fork 的工作目錄執行：

```powershell
pnpm install --frozen-lockfile
pnpm run build
node scripts/install-omo-mcp.mjs --dry-run
node scripts/install-omo-mcp.mjs
```

安裝器只更新 `~/.omo/agent/mcp.json` 的 `oracle` 啟動命令，指向此工作目錄的
`dist/bin/oracle-mcp.js`。它保留其他 MCP、Oracle 額外選項及環境變數，
設定 `ORACLE_ENGINE=browser`，並在內容改變時備份原檔。再次執行不會重複改寫。
`--home <路徑>` 可指定另一個使用者目錄；`--dry-run` 不寫入任何設定。
缺少建置產物或設定 JSON 無效時，安裝器會在寫入前失敗。

安裝後重啟 OmO Native，讓已經啟動的 MCP 連線載入新執行檔。不要刪除此 fork
工作目錄；之後修改原始碼須重新建置。安裝器不修改 Oracle 預設模型或登入資料。
還原時，關閉使用中的 Oracle 呼叫，以安裝輸出的 `backup` 檔案還原
`~/.omo/agent/mcp.json`，再重啟 OmO。

若要讓未指定模型的呼叫也使用 GPT-6 Pro，先備份 `~/.oracle/config.json`，
再將以下欄位合併到原設定，保留瀏覽器路徑及其他既有欄位：

```json
{
  "engine": "browser",
  "model": "gpt-6-pro",
  "browser": {
    "manualLogin": true,
    "modelStrategy": "select",
    "thinkingTime": "pro"
  }
}
```

Oracle 使用獨立的 manual-login profile。需要登入時，在 Oracle 開啟的視窗完成；
不要複製 cookie、清除瀏覽器資料或刪除 profile。

## MCP 呼叫與 ID 回收

先以 `dryRun: true` 預檢相同請求，確認模型、附件與瀏覽器設定；實際送出時移除
`dryRun`：

```json
{
  "engine": "browser",
  "model": "gpt-6-pro",
  "browserModelStrategy": "select",
  "browserAttachments": "always",
  "browserArchive": "never",
  "prompt": "請閱讀附件並回答我的問題。",
  "files": ["C:/work/question.txt"],
  "waitForCompletion": false
}
```

`consult` 會回傳本地 `sessionId`，然後背景工作者選模型、上傳附件、自動送出及回收
回答。這個 ID 不同於 ChatGPT 網址中的 conversation ID；後者要等送出後才存在。
省略 `waitForCompletion: false` 會沿用相容性的同步預設，呼叫可能等到回答完成才回傳。

以回傳的 ID 呼叫 `wait`，不要反覆重新 `consult`：

```json
{ "id": "consult 回傳的 sessionId", "timeoutMs": 900000 }
```

`wait` 逾時只結束這一次等待，不會取消背景工作。繼續使用同一個 ID。
完整回答、記錄與原始請求可用 `sessions` 取得：

```json
{ "id": "consult 回傳的 sessionId", "detail": true }
```

如果遺失呼叫結果，先用 `sessions` 列出近期工作；較舊的工作可加 `includeAll: true`。
不要把「呼叫尚未返回」視為「沒有 session」，也不要在可能已送出時重送 prompt。

## 如何確認真的用了 Pro

目前介面中的 **GPT-6** 是模型，**Pro** 是 Power／推理檔位；兩者需分別確認。
`gpt-6-pro` 配合 `select` 會要求 Pro，且優先於儲存的 Standard／Extended。
明確傳入 `browserThinkingTime` 仍視為呼叫者有意覆寫；`current`／`ignore`
保留原本語意，不保證切到指定模型或 Pro。

檢查 session 的 `browser.modelSelection` 與 `browser.thinkingSelection`：
前者應確認 GPT-6，後者應為 `requestedLevel: "pro"`、`resolvedLabel: "Pro"`、
`verified: true`、`strictFailClosed: true`。單有正確答案或 `status: completed`
不代表 Pro 已被選中。這些是 UI 證據，不是供應商後端模型身分的證明。

2026-10-26 Windows／Edge 實測：保留儲存的 Standard，從 Medium 起始，
自動切換 Pro、送出文字附件，約 1.9 秒回傳本地 ID，並透過新 MCP 連線取得
驗證字串。未手動按送出，其他 MCP 與登入資料保留。

## Gemini App (`gemini_app`) MCP 工具

`gemini_app` 是獨立於 `consult`、Gemini API 與舊版 cookie 模式（`gemini-web`）的專用 MCP 工具，
直接透過 BrowserSkill 操作使用者已登入 `https://gemini.google.com/app` 的瀏覽器連線。
此工具不會自行啟動瀏覽器、不會擷取 cookie，也不會執行登入。

### 前置條件（BSK、Windows pwsh 安裝與前景 daemon、保留既有 Edge）

1. **BrowserSkill CLI (`bsk.exe`)：** 預設讀取 `~/.local/bin/bsk.exe`（或由環境變數 `BSK_BIN` 指定；detached worker 會將相對路徑轉為絕對路徑）。在 Windows 上，預設的 `powershell` 安裝腳本可能靜默失敗（`cli: install failed`），請改用 `pwsh`（PowerShell 7）執行官方安裝流程（例如透過 `omowright.installBskCli` 指定 `pwsh`），確認 `C:/Users/<user>/.local/bin/bsk.exe` 通過雜湊驗證。
2. **前景啟動 daemon：** `gemini_app` 每次呼叫都會設定 `BSK_AUTO_START=0`，絕不自動啟動 daemon。Windows 上直接執行 `bsk daemon start` 會因 Job Object breakaway 限制失敗，請先在受控背景 session 或 monitor 中執行 `bsk daemon start --foreground`。
3. **保留既有已登入 Edge：** 使用目前已登入 `https://gemini.google.com/app` 且啟用 BrowserSkill 擴充功能的 Microsoft Edge。每次 `gemini_app` 呼叫只會建立獨立的 `session start --no-focus` 自動化 session，並在 `finally`（包含取消時）只關閉該自動化 session。工具絕不清除 cookie、不刪除瀏覽器 profile，也不關閉使用者的 Edge 視窗。

### 輸入參數、完整模型名稱、思考檔位與模式

`gemini_app` 採用嚴格結構描述（未知欄位直接拒絕）：

- `action`（必填）：`"discovery"` 或 `"run"`。`"discovery"` 只讀取目前可見的模型、思考檔位與工具選單並截圖，不填入也不送出 prompt；`"run"` 則驗證選單狀態並送出 `prompt`。
- `site`（預設 `"gemini-app"`）：`"gemini-app"` 或 `"ai-studio"`。AI Studio 使用 Playground 對話；其他模式會在送出前拒絕。
- `prompt`：`action: "run"` 時必填（去除空白後不可為空）；`"discovery"` 不需要。
- `model`（預設 `"current"`）：Gemini App 使用完整選單名稱；AI Studio 使用實際模型代碼或完整名稱。`"current"` 保留目前選取。Gemini App 的按鈕簡稱與舊版別名不會自動轉換為其他模型。
- `thinking`（預設 `"current"`）：`"current"`、`"minimal"`、`"low"`、`"medium"` 或 `"high"`。以目前網站與模型真正支援的選項為準；AI Studio 的 Minimal 對應 `"minimal"`。`"current"` 在 Gemini App 保留起始檔位，在 AI Studio 保留選定模型目前顯示的檔位，送出前仍會讀回實際選取狀態。
- `mode`（預設 `"chat"`）：`"chat"`、`"image"`、`"video"`、`"music"` 或 `"deep-research"`。執行 `"run"` 時會先清除所有已勾選的工具（包含 `Canvas` 與引導式學習），再選取指定工具（`建立圖像`、`建立影片`、`創作音樂` 或 `Deep Research`），並同時驗證工具選單勾選狀態與輸入框下方的工具標籤（`"chat"` 要求不能殘留任何工具標籤）。
- `outputDir`（選填）：產物與截圖輸出目錄，預設為 `<ORACLE_HOME_DIR>/generated/gemini-app-<uuid>`。若要指定 `<ORACLE_HOME_DIR>/generated` 以外的路徑，須設定 `ORACLE_MCP_ALLOW_EXTERNAL_OUTPUT=1`。
- `timeoutMs`（預設 `600000`）：正整數逾時毫秒數。
- `browser`（選填）：傳給 BrowserSkill `session start --browser` 的瀏覽器選擇器。
- `waitForCompletion`（預設 `true`）：設為 `false` 時會透過共用的 detached session 機制在背景執行，立即回傳 Oracle `sessionId`。
- `slug`（選填）：自訂的易讀 Oracle session ID。

### Discovery / Run 範例、Session 回收與產物路徑

先以 `discovery` 檢查目前連線的可用控制項：

```json
{
  "action": "discovery"
}
```

背景執行 `run`：

```json
{
  "action": "run",
  "model": "3.1 Pro",
  "thinking": "low",
  "mode": "chat",
  "prompt": "Reply exactly ORACLE_GEMINI_OK",
  "waitForCompletion": false
}
```

與 `consult` 相同，`waitForCompletion: false` 回傳本地 `sessionId` 後，請用 `wait` 等待完成、或用 `sessions`（搭配 `detail: true`）讀取 `metadata.geminiApp` 與 `output.log`。`wait` 逾時不會取消背景 worker；若送出取消訊號，worker 會等待 `BrowserSkill.stop()` 完成清理後才寫入 `status: "cancelled"`。送出後若未觀察到新的相符 `user-query`、發生模型自動降級（例如額度耗盡切換至 Flash-Lite）或出現額度重設橫幅，工具會直接失敗且絕不自動重送。

`outputDir` 下的檔案與產物規則：

- **截圖（記錄於 `geminiApp.screenshots`，不列入 `artifacts`）：** `<uuid>-selection.png`、`<uuid>-research-plan.png`（Deep Research 計畫階段）、`<uuid>-complete.png`，以及送出後失敗時的 `<uuid>-failure.png`。
- **圖片（`mode: "image"`）：** 從已載入的 `img.image.loaded` 擷取畫面解析度像素（canvas PNG），存為 `<uuid>-image.download.png`（`kind: "image"`，標籤註明 `displayed-resolution <寬>x<高>; decoded pixels, not original-resolution download`，即顯示解析度像素而非原尺寸下載）。只有 `kind: "image"` 會出現在 MCP 回傳頂層的 `images` 陣列。
- **影片與音樂（`mode: "video"` / `"music"`）：** 在已登入頁面內對 `video.currentSrc` 或 `audio.currentSrc` 執行含憑證 `fetch` 並透過 `FileReader` 傳回，經驗證容器檔頭與 SHA-256 後存為 `<uuid>-video.download.mp4`（或 `.webm`）與 `<uuid>-music.download.<ext>`（支援 `.wav`、`.m4a`、`.ogg`、`.mp3`），皆歸類為 `kind: "file"`。
- **Deep Research（`mode: "deep-research"`）：** 必須先出現研究計畫按鈕（`開始研究`／`開始深入研究`／`Start research`／`Start deep research`），點擊一次核准後等待含 HTTP(S) 引用連結的完成報告，存為 `<uuid>-research.md`（`kind: "deep-research-report"`）。若僅回傳一般回答而無研究計畫或報告，直接視為失敗。
- **失敗證據：** 一旦送出 prompt 後發生錯誤，會在 `outputDir` 寫入 `<uuid>-failure.json`（含實際回覆文字、對話網址、請求設定、截圖路徑與 `automaticRetryPerformed: false`）。

### 驗證狀態說明

單元與整合測試涵蓋 CLI 邊界、選單狀態、容器格式及 detached session 生命週期。依使用者指示，已停止後續 Gemini App 生成與研究驗收；未完成的實機項目保留為未驗證，不改列通過。

### AI Studio Playground

沿用 `gemini_app` 工具，加入 `site: "ai-studio"`：

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

正式使用仍可指定模型代碼、完整介面名稱，或以 `"current"` 保留目前選取；不會鎖定 Flash-Lite。介面實際列出的 Argon 代碼為 `gemini-4-argon`。只有實際測試生成固定使用 `gemini-3.5-flash-lite`。

`thinking` 支援 `"current"`、`"minimal"`、`"low"`、`"medium"`、`"high"`，以目前模型介面真正提供的選項為準。AI Studio 目前接入 Playground 對話，不宣稱支援其 Build 或媒體生成工作流。工具不代選 API key、不更動計費與登入；需要的帳號選擇由使用者在原介面處理。

一次手動 Flash-Lite／Minimal 短文字探查已回傳 `ORACLE_AI_STUDIO_OK`；不代表已測試 Argon 或已完成安裝後 MCP 端到端生成驗收。

# OmO Native：Oracle fork 與 GPT-6 Pro

此 fork 以 steipete/oracle 0.22.1 為基線，修正 MCP 明確要求
`gpt-6-pro` 時，儲存的 Standard／Extended 設定覆蓋 Pro 預設值的問題。
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

---
name: usage-query
description: 開啟 AI Token 用量儀表板、查詢本機 Claude Code 與 OpenAI Codex 的 token 用量與花費，或診斷為什麼某些用量沒出現。當使用者說「開啟用量儀表板」「我今天用了多少 token」「今天花多少錢」「哪個 session 最耗 token」「Codex 額度還剩多少」「設定用量通知」「Codex 桌面版的用量看不到」「診斷用量儀表板」時使用。
---

# AI Token 用量儀表板

這個 plugin 附帶一個本機網頁儀表板，讀取 Claude Code（`~/.claude/projects`）與 OpenAI Codex（`~/.codex/sessions`）的對話紀錄來統計用量。所有資料只在本機處理。

## 準備

腳本在這個 plugin 的 `scripts/` 資料夾，也就是**本 SKILL.md 所在資料夾往上兩層**的 `scripts/`：

- Claude Code：`${CLAUDE_PLUGIN_ROOT}/scripts/`
- Codex 或其他工具：`<本檔案所在資料夾>/../../scripts/`

下面用 `SCRIPTS` 代表這個路徑。

- 需要 Node.js 18 以上；找不到 `node` 時，告訴使用者到 https://nodejs.org 安裝。
- 在 Windows PowerShell 讀本檔或其他文字檔時加 `-Encoding UTF8`，否則中文會變亂碼。
- 儀表板伺服器要在背景持續執行（預設監聽 `127.0.0.1:8787`）。執行環境有沙箱限制（例如 Codex 的預設沙箱）導致啟動失敗時，請使用者核准指令在沙箱外執行，或請他自己在終端機執行 `node "SCRIPTS/start.js"`。

## 開啟儀表板

```bash
node "SCRIPTS/start.js"
```

在背景啟動伺服器（若尚未執行）並開啟瀏覽器。其他參數：

| 參數 | 作用 |
|---|---|
| `--no-open` | 只啟動、不開瀏覽器 |
| `--status` | 查看是否在執行 |
| `--stop` | 停止伺服器 |
| `--url` | 只印出儀表板網址（使用者可能改過 port） |

## 直接回答用量問題

使用者只想知道數字時（例如「今天用了多少」），不必開網頁：

```bash
node "SCRIPTS/start.js" --no-open
node "SCRIPTS/start.js" --url        # 下面以 URL 代表印出的網址
curl -s "URL/api/data"
```

回傳內容：

- `rows`：每一列是一次 API 呼叫，欄位順序見 `fields`（ts, session, project, model, input, output, cacheWrite, cacheRead, cost, scenario, sub, prompt, thinking, tools, device, app）
- `app` 是 `apps` 的索引（0 = Claude Code、1 = Codex）；`sessions`、`projects`、`models`、`prompts`、`scenarios`、`devices` 是對應的索引表
- `limits.codex`：Codex 方案額度使用率（整個帳號共用，包含桌面版與雲端任務）
- `models_seen`：用過的模型與對到的價格（`priceKey` 為 null 代表未定價）

資料量可能很大，用 node 單行程式彙總後再回答，不要把原始 JSON 印出來。回答時說明是哪個工具的用量，花費是依 API 價格換算的估計，不是訂閱方案的實際帳單。

## 診斷：某些用量沒出現

使用者說某些用量沒出現（例如 Codex 桌面版、WSL、另一個 Codex 資料夾）時：

```bash
node "SCRIPTS/diagnose.js"
```

只讀取、不修改。它會列出所有找得到的 Claude Code / Codex 紀錄資料夾、每個資料夾的紀錄來源（CLI、exec、桌面版、IDE 等）、儀表板讀不讀得到、已安裝的 plugin 版本、儀表板是否在執行。

- 有「儀表板目前不會讀」的資料夾時，輸出最後會印出一行 `"extraCodexDirs": [...]`。把它加進設定檔，再 `--stop` 後重新啟動儀表板。
- Codex 桌面版在 Windows 的 WSL 模式下，紀錄通常在 WSL 裡的 `~/.codex`，就是這種情況。
- ChatGPT 的聊天與 chatgpt.com 上的 Codex 雲端任務不會在電腦上留下紀錄，統計不到。

## 設定

設定檔在 `~/.claude-token-usage/config.json`，大部分也能在儀表板的「通知與設定」分頁修改：

| 設定 | 說明 |
|---|---|
| `port` | 儀表板連接埠 |
| `thresholds` | 通知門檻（今日花費、今日 token、5 小時視窗、單一 session 花費、上下文大小） |
| `windowsToast` | 是否顯示系統通知（名稱沿用舊版，各作業系統都適用） |
| `codexDir`、`extraCodexDirs` | Codex 資料夾、其他要一起讀的 Codex 資料夾 |
| `syncDir`、`deviceName` | 多裝置同步 |
| `remotePrices` | 是否每天從 GitHub 下載最新價格表 |
| `priceOverrides` | AI 更新與自訂的模型價格；要更新價格請用 `update-prices` skill |

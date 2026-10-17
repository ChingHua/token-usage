---
name: usage-query
description: 開啟 AI Token 用量儀表板，或查詢本機 Claude Code 與 OpenAI Codex 的 token 用量、花費、session 用量、各情境消耗、設定用量通知門檻。當使用者說「開啟用量儀表板」「我今天用了多少 token」「今天花多少錢」「哪個 session 最耗 token」「Codex 額度還剩多少」「設定用量通知」時使用。
---

# AI Token 用量儀表板

這個 plugin 附帶一個本機網頁儀表板，讀取 Claude Code（`~/.claude/projects`）與 OpenAI Codex（`~/.codex/sessions`）的對話紀錄來統計用量。所有資料只在本機處理。

## 找到啟動腳本

啟動腳本是這個 plugin 的 `scripts/start.js`，也就是**本 SKILL.md 所在資料夾往上兩層**的 `scripts/start.js`：

- Claude Code：`${CLAUDE_PLUGIN_ROOT}/scripts/start.js`
- Codex 或其他工具：用本檔案的路徑推算 `<本檔案所在資料夾>/../../scripts/start.js`

下面用 `START` 代表這個路徑。需要 Node.js 18 以上；找不到 `node` 時，告訴使用者到 https://nodejs.org 安裝。

## 開啟儀表板

```bash
node "START"
```

會在背景啟動伺服器（若尚未執行）並開啟瀏覽器到 http://localhost:8787 。停止用 `--stop`，查看狀態用 `--status`，只啟動不開瀏覽器用 `--no-open`。

伺服器需要在背景持續執行並監聽 `127.0.0.1:8787`。如果執行環境有沙箱限制（例如 Codex 的預設沙箱）導致啟動失敗，請使用者核准這個指令在沙箱外執行，或請他自己在終端機執行上面的指令。

## 直接回答用量問題

使用者只想知道一個數字時（例如「今天用了多少」），先確保伺服器在執行，再讀 API，不必開網頁：

```bash
node "START" --no-open
node "START" --url        # 印出儀表板網址（使用者可能改過 port），下面以 URL 表示
curl -s "URL/api/data"
```

回傳的 `rows` 每一列欄位順序見 `fields`（ts, session, project, model, input, output, cacheWrite, cacheRead, cost, scenario, sub, prompt, thinking, tools, device, app）。`app` 是 `apps` 的索引（0 = Claude Code、1 = Codex）；`sessions`、`projects`、`models`、`prompts`、`scenarios` 是對應的索引表；`limits.codex` 是 Codex 方案額度使用率。資料量可能很大，用 node 單行程式彙總後再回答，不要把原始 JSON 印出來。回答時說明是哪個工具的用量，花費是依 API 價格換算的估計。

## 讀不到某些用量時（診斷）

使用者說某些用量沒出現（例如 Codex 桌面版、WSL、另一個 Codex 資料夾）時，執行：

```bash
node "<本 SKILL.md 所在資料夾>/../../scripts/diagnose.js"
```

它會列出所有找得到的 Claude Code / Codex 紀錄資料夾、每個資料夾的紀錄來源（CLI、exec、桌面版等）、儀表板讀不讀得到。有「儀表板目前不會讀」的資料夾時，照輸出的提示把它加進 `config.json` 的 `extraCodexDirs`，再重新啟動儀表板。

## 設定

設定檔在 `~/.claude-token-usage/config.json`：連接埠、通知門檻、自訂模型價格、多裝置同步資料夾。也可以在儀表板的「通知與設定」分頁修改。

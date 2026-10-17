---
name: usage-query
description: 查看本機 Claude Code 與 OpenAI Codex 的 token 用量、花費、session 用量、各情境消耗，或設定用量通知門檻。當使用者問「我用了多少 token」「今天花多少錢」「哪個 session 最耗 token」「打開用量儀表板」「設定用量通知」時使用。
---

# Claude Token 用量儀表板

這個 plugin 附帶一個本機網頁儀表板，讀取 `~/.claude/projects/**/*.jsonl` 對話紀錄來統計用量。

## 開啟儀表板

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/start.js"
```

會在背景啟動伺服器（若尚未執行）並開啟瀏覽器到 http://localhost:8787 。停止用 `--stop`，查看狀態用 `--status`。

## 直接回答用量問題

使用者只想知道一個數字時（例如「今天用了多少」），伺服器在執行時可以直接查 API，不必開網頁：

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/start.js" --background
curl -s http://localhost:8787/api/data
```

回傳的 `rows` 每一列欄位順序見 `fields`（ts, session, project, model, input, output, cacheWrite, cacheRead, cost, scenario, sub, prompt, thinking, tools）。`sessions`、`projects`、`models`、`prompts`、`scenarios` 是對應的索引表。資料量可能很大，用 node 單行程式彙總後再回答，不要把原始 JSON 印出來。

## 設定

設定檔在 `~/.claude-token-usage/config.json`：連接埠、通知門檻、價格（美元 / 百萬 token）。也可以在儀表板的「通知與設定」分頁修改。花費是依價格表估算，不是官方帳單。

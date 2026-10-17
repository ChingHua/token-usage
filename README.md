# Claude Token 用量儀表板（Claude Code plugin）

讀取本機 Claude Code 對話紀錄（`~/.claude/projects/**/*.jsonl`），統計每次 API 呼叫的 token 用量，用網頁儀表板呈現，並在超過門檻時通知。

只看得到**安裝這台電腦**上的 Claude Code 用量；claude.ai 網頁版、手機 App 與其他電腦的用量不在內。

## 需求

- Claude Code
- Node.js 18 以上（`node -v` 確認）

## 安裝

這個倉庫本身就是一個 plugin marketplace。在 Claude Code 裡執行：

```
/plugin marketplace add <這個倉庫的路徑或 Git 網址>
/plugin install token-usage@cmuh-claude-tools
```

安裝後重新啟動 Claude Code。

## 使用

| 指令 | 作用 |
|---|---|
| `/token-usage` | 啟動儀表板並開啟瀏覽器（http://localhost:8787） |
| `/token-usage status` | 查看伺服器是否在執行 |
| `/token-usage stop` | 停止伺服器 |

也可以直接問 Claude「我今天用了多少 token？」，它會用內附的 skill 回答。

每次啟動 Claude Code 時，plugin 會在背景自動啟動伺服器，讓門檻通知持續運作。

## 功能

- **總覽**：今日 / 5 小時視窗 / 快取命中率、用量時間軸、token 類型組成、模型分佈、5 小時滾動視窗、使用時段熱度圖、專案排行
- **情境分析**：依每次呼叫使用的工具分成 8 種情境（讀取/搜尋、編輯檔案、執行指令、網頁/瀏覽器、子代理派工、規劃/流程、MCP 工具、文字回覆），附工具排行與最耗用的提問
- **Sessions**：每個 session 的 token、花費、最大上下文；點選可看上下文成長、累積花費、每次提問的消耗
- **通知與設定**：門檻超過時跳出 Windows 系統通知、瀏覽器通知與頁面橫幅

## 設定

`~/.claude-token-usage/config.json`（第一次啟動時建立）：連接埠、門檻、價格。記錄檔在同一個資料夾的 `server.log`。

花費依 `pricing` 的單價估算（美元 / 百萬 token；快取寫入 5 分鐘 ×1.25、1 小時 ×2、快取讀取 ×0.1），**不是官方帳單**。

## 開發

```
node plugins/token-usage/server.js          # 前景執行伺服器
claude plugin validate .                    # 驗證 marketplace 與 plugin
```

發佈新版時，同步更新 `plugins/token-usage/.claude-plugin/plugin.json` 和 `.claude-plugin/marketplace.json` 的 `version`。

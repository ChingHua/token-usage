# Claude Token 用量儀表板（Claude Code plugin）

讀取本機 Claude Code 對話紀錄（`~/.claude/projects/**/*.jsonl`）與 OpenAI Codex 對話紀錄（`~/.codex/sessions`），統計每次 API 呼叫的 token 用量，用網頁儀表板呈現，並在超過門檻時通知。

預設只統計**這台電腦**的 Claude Code 用量；啟用「多裝置同步」後可以合計自己多台電腦的用量。claude.ai 網頁版與手機 App 的用量不在內。

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

## 支援的 AI 工具

| 工具 | 讀取位置 | 備註 |
|---|---|---|
| Claude Code | `~/.claude/projects`（或 `CLAUDE_CONFIG_DIR`） | 含桌面 App 的 Code 分頁與子代理 |
| OpenAI Codex | `~/.codex/sessions`、`archived_sessions`（或 `CODEX_HOME`） | 另外顯示 Codex 方案的 5 小時 / 每週額度使用率 |

右上角可以切換「Claude Code」「Codex」「全部比較」：前兩者各自只看自己的資料與模型（模型篩選、價格、圖表都分開），「全部比較」把兩個工具放在一起比。Codex 的 `input_tokens` 已包含快取 token，這裡會拆開成「輸入」與「快取讀取」，和 Claude 的欄位一致。Codex 在 Windows 上多數動作都透過 `shell_command`，「情境分析」會依指令內容（例如 `rg`、`Get-Content`）歸到讀取/搜尋或編輯檔案。

## 模型價格

每個工具有自己的價格表（[pricing.js](plugins/token-usage/pricing.js)），每個模型分別設定輸入、輸出、快取讀取、快取寫入（Claude）、長上下文價格；Claude Opus 的快速模式會套用 2 倍價格。

- 預設價格取自官方價目表（更新日期寫在 `PRICES_UPDATED`）。官方已不列出的舊 Codex 模型標為「估計」，沿用同代模型的價格。
- 比對順序：模型名稱完全相同 → 去掉日期後綴 → 同系列最長前綴。都找不到的模型標為「未定價」，花費不計入，畫面上方會提示。
- 在「通知與設定」→「模型價格」可以直接修改或新增模型，改過的標為「自訂」，可以按「還原」回到官方價格。自訂價格存在 `config.json` 的 `priceOverrides`，plugin 更新時不會被覆蓋。
- 花費一律依 API 價格換算；如果使用的是訂閱方案（Claude Max、ChatGPT Plus/Pro 等），這是「等值 API 費用」，不是實際帳單。

## 多裝置同步（OneDrive）

想看自己多台電腦的合計時：

1. 每台電腦都安裝這個 plugin。
2. 在儀表板「通知與設定」→「多裝置同步」，填入同一個 OneDrive 內的資料夾（有偵測到 OneDrive 時可以按「使用偵測到的 OneDrive」），並為每台電腦取個名字。
3. 儲存後，總覽會出現「裝置分佈」，上方也可以用「裝置」篩選。

運作方式：

- 每台電腦只寫入自己的檔案 `<同步資料夾>/devices/<裝置 ID>.json`，約每分鐘更新一次，所以不會有 OneDrive 衝突。其他電腦的資料延遲 = 約 1 分鐘 + OneDrive 同步時間。
- 檔案會保留歷史紀錄：Claude Code 自動清掉舊對話紀錄後，用量仍然留著。沒啟用同步時，歷史存在 `~/.claude-token-usage/history.json`。
- 檔案內容包含 session 標題、專案資料夾名稱與提問前 160 字。資料夾只放在你自己的 OneDrive，不要分享給別人。
- 門檻通知用的是所有裝置的合計；每台開著的電腦都會各自跳通知。

## 設定

`~/.claude-token-usage/config.json`（第一次啟動時建立）：連接埠、門檻、價格。記錄檔在同一個資料夾的 `server.log`。

花費依「模型價格」估算，**不是官方帳單**。

## 開發

```
node plugins/token-usage/server.js          # 前景執行伺服器
claude plugin validate .                    # 驗證 marketplace 與 plugin
```

發佈新版時，同步更新 `plugins/token-usage/.claude-plugin/plugin.json` 和 `.claude-plugin/marketplace.json` 的 `version`。

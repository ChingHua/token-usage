# AI Token 用量儀表板

> **English summary** — A local web dashboard for **Claude Code** and **OpenAI Codex** token usage. It reads the session logs both tools keep on your machine and shows per-call breakdowns, per-session and per-scenario consumption, per-model cost estimates, Codex quota usage, multi-device totals via a synced folder, and threshold notifications. Everything runs locally; no data is sent anywhere. Install it as a Claude Code plugin, as a Codex plugin, or run it directly with Node.js — see [安裝](#安裝). The UI is in Traditional Chinese.

讀取這台電腦上 **Claude Code** 與 **OpenAI Codex** 的對話紀錄，在瀏覽器裡顯示 token 用量細項、花費估算與用量通知。只用其中一種工具也可以，兩種都用時可以分開看，也可以合在一起比較。

## 支援的 AI 工具

| 工具 | 讀取的紀錄 | 可以看到 |
|---|---|---|
| **Claude Code**（終端機、桌面 App 的 Code 分頁、IDE 外掛） | `~/.claude/projects`（或 `CLAUDE_CONFIG_DIR`） | 每次呼叫的輸入 / 輸出 / 快取寫入 / 快取讀取、子代理、session 標題 |
| **OpenAI Codex**（CLI、桌面 App、IDE 外掛） | `~/.codex/sessions`、`~/.codex/archived_sessions`（或 `CODEX_HOME`） | 每次呼叫的輸入 / 輸出 / 快取輸入 / 推理 token、方案的 5 小時與每週額度使用率 |

**不支援**：claude.ai、ChatGPT、Gemini 等網頁版或手機 App 的聊天（它們不會在電腦上留下用量紀錄），以及其他電腦上的用量（可以用[多裝置同步](#多裝置同步onedrive)合計）。

## 需求

- **Node.js 18 以上**（在終端機輸入 `node -v` 確認；沒有的話到 https://nodejs.org 安裝）
- 這台電腦有用過 Claude Code 或 Codex（至少一種）
- 瀏覽器（儀表板開在 http://localhost:8787 ）
- Codex 會把較舊的紀錄壓縮成 `.jsonl.zst`。要統計這些紀錄，需要 **Node.js 22.15 以上**（內建 zstd 解壓），或系統裝有 `zstd` 指令（macOS：`brew install zstd`；Linux：用套件管理員安裝 `zstd`；Windows 建議直接把 Node.js 升級到 22.15 以上）。兩者都沒有時只會略過壓縮檔，其他用量照常統計；診斷會顯示有幾個壓縮檔讀不到。
- 作業系統：Windows、macOS、Linux 都可以。系統通知：Windows 用通知中心的 Toast、macOS 用通知中心、Linux 需要有 `notify-send`；也都可以改用瀏覽器通知。

## 安裝

依照你使用的工具，選**一種**方式就好。三種方式看到的儀表板完全一樣，都會同時統計 Claude Code 和 Codex 的用量。

| 方式 | 適合 | 開啟儀表板 | 開機後自動啟動 |
|---|---|---|---|
| [A. Claude Code plugin](#a-claude-code-plugin) | 有用 Claude Code | `/token-usage` | ✅ 啟動 Claude Code 時自動在背景執行 |
| [B. Codex plugin](#b-codex-plugin) | 只用 Codex | 對 Codex 說「開啟 token 用量儀表板」 | ❌ 需要手動開啟一次 |
| [C. 直接執行](#c-直接執行不安裝-plugin) | 不想裝 plugin，或兩種工具都沒有 plugin 功能 | `start.cmd` / `./start.sh` | ❌ 需要手動開啟一次 |

兩種工具都有用的話，選 A 就好，不需要再裝 B。

### A. Claude Code plugin

在 Claude Code 裡輸入：

```
/plugin marketplace add ChingHua/token-usage
/plugin install token-usage@ai-usage-tools
```

重新啟動 Claude Code，再輸入 `/token-usage` 開啟儀表板。

| 指令 | 作用 |
|---|---|
| `/token-usage` | 啟動儀表板並開啟瀏覽器 |
| `/token-usage status` | 查看伺服器是否在執行 |
| `/token-usage stop` | 停止伺服器 |
| `/token-usage diagnose` | 診斷：列出所有紀錄資料夾與來源，找出讀不到的用量（見[疑難排解](#疑難排解某些用量沒有出現)） |

也可以直接問 Claude「我今天用了多少 token？」，它會用內附的 skill 回答。

每次啟動 Claude Code，plugin 會在背景啟動伺服器，讓門檻通知持續運作。不需要的話可以用 `/plugin disable token-usage@ai-usage-tools` 停用整個 plugin。

**更新**：第三方 plugin 預設**不會**自動更新。建議開啟自動更新：輸入 `/plugin` →「Marketplaces」分頁 → 選 `ai-usage-tools` →「Enable auto-update」。更新後輸入 `/reload-plugins` 或重新啟動即可套用。手動更新：

```
/plugin marketplace update ai-usage-tools
/plugin update token-usage@ai-usage-tools
```

### B. Codex plugin

在終端機執行：

```bash
codex plugin marketplace add ChingHua/token-usage
codex plugin add token-usage@ai-usage-tools
```

開一個**新的** Codex 對話，然後對 Codex 說「開啟 token 用量儀表板」，或直接問「我今天用了多少 token？」。

- Codex 沒有 `/token-usage` 這種指令，是透過 plugin 內附的 skill 來執行。
- 儀表板伺服器要在背景持續執行。Codex 的沙箱可能會擋下來，這時請核准它在沙箱外執行，或改用[直接執行](#c-直接執行不安裝-plugin)的方式開啟。
- Codex 不會執行 plugin 的啟動 hook，所以重開機後要再開啟一次，門檻通知才會繼續運作。
- 用 `codex exec`（非互動模式）時：預設的唯讀沙箱會擋下讀取 skill 的指令，需要加 `--approve-for-me`（或在互動模式按核准）。另外如果伺服器是在 `codex exec` 裡第一次啟動，`codex exec` 會等到伺服器結束才退出；建議先用 `start.cmd` / `./start.sh` 啟動伺服器。
- Codex 自動審核核准時會用到 `codex-auto-review` 模型，OpenAI 官方價目表沒有列出它的價格，所以會顯示為「未定價」。

**更新**：

```bash
codex plugin marketplace upgrade ai-usage-tools
codex plugin add token-usage@ai-usage-tools
```

更新後開一個新的 Codex 對話才會用到新版。

### C. 直接執行（不安裝 plugin）

下載這個倉庫（`git clone https://github.com/ChingHua/token-usage.git`，或在 GitHub 頁面按「Code」→「Download ZIP」解壓縮），然後在資料夾裡執行：

| 系統 | 啟動並開啟瀏覽器 | 停止 | 查看狀態 |
|---|---|---|---|
| Windows | 雙擊 `start.cmd` | `start.cmd --stop` | `start.cmd --status` |
| macOS / Linux | `./start.sh`（用 ZIP 下載的話改用 `sh start.sh`） | `./start.sh --stop` | `./start.sh --status` |

**更新**：`git pull`（或重新下載 ZIP），然後先 `--stop` 再重新啟動。

## 使用

開啟後右上角可以切換：

- **Claude Code** / **Codex**：只看那個工具的資料。模型篩選、價格、圖表都分開；token 類型也依工具不同（例如 Codex 沒有「快取寫入」）。
- **全部比較**：兩個工具放在一起，時間軸和分佈圖改成依工具分顏色。

第一次開啟時會自動選你最近用過的工具，之後會記住你的選擇。

## 功能

- **總覽**：今日 / 5 小時視窗 / 快取命中率、用量時間軸、token 類型組成、模型分佈、5 小時滾動視窗、使用時段熱度圖、專案排行；Codex 另外顯示方案額度使用率
- **情境分析**：依每次呼叫使用的工具分成 8 種情境（讀取/搜尋、編輯檔案、執行指令、網頁/瀏覽器、子代理派工、規劃/流程、MCP 工具、文字回覆），附工具排行與最耗用的提問
- **Sessions**：每個 session 的 token、花費、最大上下文；點選可看上下文成長、累積花費、每次提問的消耗
- **通知與設定**：門檻超過時跳出系統通知（Windows / macOS / Linux）、瀏覽器通知與頁面橫幅；模型價格、多裝置同步

工具之間的差異會自動處理：

- Codex 的 `input_tokens` 已包含快取 token，這裡會拆開成「輸入」與「快取讀取」，和 Claude 的欄位一致。
- Codex 在 Windows 上多數動作都透過 `shell_command`，「情境分析」會依指令內容（例如 `rg`、`Get-Content`）歸到讀取/搜尋或編輯檔案。

## 模型價格

Claude Code 和 Codex 各有自己的價格表（[prices.json](plugins/token-usage/prices.json)），每個模型分別設定輸入、輸出、快取讀取、快取寫入（Claude）、長上下文價格；Claude Opus 的快速模式套用 2 倍價格。

- 價格取自官方價目表（[Claude](https://platform.claude.com/docs/en/about-claude/pricing)、[OpenAI](https://developers.openai.com/api/docs/pricing)）。官方已不列出的舊 Codex 模型標為「估計」，沿用同代模型的價格。
- 比對順序：模型名稱完全相同 → 去掉日期後綴 → 同系列最長前綴，而且只在所屬工具的表裡比對。都找不到的模型標為「未定價」，花費不計入，畫面上方會提示。
- 花費一律依 API 價格換算。如果你用的是訂閱方案（Claude Pro / Max、ChatGPT Plus / Pro 等），這是「等值 API 費用」，不是實際帳單。

### 價格怎麼保持最新

價格有三個來源，後面的優先：

| 來源 | 標示 | 怎麼來的 |
|---|---|---|
| 官方價格表 | 官方 / 估計 | plugin 內建的 `prices.json`。儀表板**每天自動從 GitHub 下載最新版**，作者更新價格後，使用者不用更新 plugin 就會用到。 |
| AI 更新 | AI 更新 | 你對 Claude Code 或 Codex 說「**更新模型價格**」，它會讀官方價目表、列出差異，**經你確認後才寫入**。官方價格表之後更新到比它新的日期時，會自動改回官方價格。 |
| 自訂 | 自訂 | 你在「通知與設定」→「模型價格」手動修改或新增的價格，一律優先，不會被自動更新或 AI 覆蓋。可以按「還原」回到官方價格。 |

- 出現未定價的新模型，或價格表超過 30 天沒更新時，儀表板上方會提醒你可以請 AI 更新。不會自動呼叫 AI，也不會自動花 token。
- 不想連網下載價格表的話，在「模型價格」取消勾選「每天從 GitHub 下載最新的官方價格表」，或在 `config.json` 設 `"remotePrices": false`。下載只是讀取一個公開檔案，不會傳送任何資料。
- AI 更新與自訂價格存在 `config.json` 的 `priceOverrides`，更新版本時不會被覆蓋。

## 多裝置同步（OneDrive）

想看自己多台電腦的合計時：

1. 每台電腦都用上面任一種方式安裝。
2. 在儀表板「通知與設定」→「多裝置同步」，填入同一個 OneDrive 內的資料夾（有偵測到 OneDrive 時可以按「使用偵測到的 OneDrive」），並為每台電腦取個名字。
3. 儲存後，總覽會出現「裝置分佈」，上方也可以用「裝置」篩選。

運作方式：

- 每台電腦只寫入自己的檔案 `<同步資料夾>/devices/<裝置 ID>.json`，約每分鐘更新一次，所以不會有 OneDrive 衝突。其他電腦的資料延遲 = 約 1 分鐘 + OneDrive 同步時間。
- 檔案會保留歷史紀錄：Claude Code 或 Codex 自動清掉舊對話紀錄後，用量仍然留著。沒啟用同步時，歷史存在 `~/.claude-token-usage/history.json`。
- 門檻通知用的是所有裝置的合計；每台開著的電腦都會各自跳通知。

## 疑難排解：某些用量沒有出現

先執行診斷，它會列出這台電腦上所有找得到的 Claude Code / Codex 紀錄資料夾、每個資料夾的紀錄來源（CLI、`exec`、桌面版、IDE 等），以及儀表板讀不讀得到。只會讀取，不會修改任何檔案。

| 安裝方式 | 執行診斷 |
|---|---|
| Claude Code plugin | `/token-usage diagnose` |
| Codex plugin | 對 Codex 說「診斷用量儀表板讀不到的紀錄」 |
| 直接執行 | `node plugins/token-usage/scripts/diagnose.js` |

診斷也會列出每個資料夾裡有幾個壓縮檔（`.jsonl.zst`）；如果顯示「無法解壓」，照[需求](#需求)升級 Node.js 或安裝 `zstd` 指令，再重新啟動儀表板。

如果診斷列出「儀表板目前不會讀」的資料夾，照它印出的那一行加進 `config.json` 的 `extraCodexDirs`，再重新啟動儀表板（`--stop` 後再啟動）。

### Codex 桌面版

| 系統 | 紀錄位置 | 儀表板 |
|---|---|---|
| Windows（原生模式） | `%USERPROFILE%\.codex`，和 Windows 版 CLI 共用 | 預設就會讀 |
| Windows（WSL 模式） | 桌面版「設定」把 agent 切到 WSL 時，Codex 跑在 Linux 子系統裡，紀錄可能在 WSL 裡的 `~/.codex`（例如 `\\wsl.localhost\Ubuntu\home\<帳號>\.codex`） | 用診斷找到後加進 `extraCodexDirs` |
| macOS | `~/.codex`，和 CLI 共用 | 預設就會讀 |

- OpenAI 官方文件說明了 Windows 原生模式與 CLI 共用 `%USERPROFILE%\.codex`、WSL 裡的 CLI 預設用 Linux 家目錄（[Windows 桌面版文件](https://learn.chatgpt.com/docs/windows/windows-app.md)）；macOS 桌面版與 WSL 模式的實際位置官方沒有明寫，請以診斷結果為準。
- 「Codex 額度使用率」是整個帳號共用的數字，已經包含桌面版、CLI 與雲端任務的用量。
- ChatGPT（網頁 / 桌面 / 手機）的聊天，以及在 chatgpt.com 上執行的 Codex 雲端任務，不會在電腦上留下用量紀錄，所以統計不到。

## 隱私

- 所有資料都在你的電腦上處理。儀表板伺服器只監聽 `127.0.0.1`。對外連線只有兩個，而且都只是下載、不會傳送你的資料：網頁從 cdnjs 載入圖表函式庫 Chart.js；伺服器每天從 GitHub 下載一次價格表（可以關閉）。
- 只取用對話紀錄裡的 token 數、模型、時間、工具名稱、專案資料夾名稱、session 標題與每次提問的前 160 字。
- 用量歷史存在 `~/.claude-token-usage/`；啟用多裝置同步時，會寫到你指定的資料夾。這些檔案含有提問片段，不要分享給別人。

## 設定

`~/.claude-token-usage/config.json`（第一次啟動時建立）：

| 設定 | 說明 |
|---|---|
| `port` | 儀表板連接埠，預設 8787 |
| `projectsDir` | Claude Code 紀錄位置 |
| `codexDir` | Codex 資料夾位置 |
| `extraCodexDirs` | 其他要一起讀的 Codex 資料夾（例如 WSL 裡的），可以用診斷找出來 |
| `thresholds` | 通知門檻（也可以在儀表板修改） |
| `priceOverrides` | AI 更新與自訂的模型價格（也可以在儀表板修改） |
| `remotePrices`、`remotePricesUrl` | 是否每天下載最新價格表、下載位址 |
| `syncDir`、`deviceName` | 多裝置同步 |
| `windowsToast` | 是否顯示系統通知（名稱沿用舊版，Windows / macOS / Linux 都適用） |

記錄檔在同一個資料夾的 `server.log`。

## 回報問題

到 [Issues](https://github.com/ChingHua/token-usage/issues/new/choose) 選擇範本：

- **問題回報**：請先執行診斷（`/token-usage diagnose`，Codex 則說「診斷用量儀表板讀不到的紀錄」）並把結果貼上，再填版本、安裝方式、AI 工具與作業系統。貼上前請確認沒有密碼、金鑰或不想公開的內容。
- **價格錯誤 / 新模型**：附上官方價目頁網址。價格表修正後，所有使用者一天內自動更新。
- **功能建議**。

## 版本紀錄

每個版本改了什麼，見 [CHANGELOG.md](CHANGELOG.md)。

## 授權

[MIT](LICENSE)

## 開發

```
plugins/token-usage/
├── .claude-plugin/plugin.json   # Claude Code plugin 設定
├── .codex-plugin/plugin.json    # Codex plugin 設定
├── commands/                    # Claude Code 的 /token-usage 指令
├── skills/usage-query/          # 開啟儀表板、查詢用量（兩種工具共用）
├── skills/update-prices/        # 「更新模型價格」（兩種工具共用）
├── hooks/                       # Claude Code 啟動時自動執行（Codex 不支援 plugin hook）
├── scripts/start.js             # 啟動 / 停止伺服器
├── scripts/prices.js            # 價格工具：show / apply / promote
├── scripts/diagnose.js          # 診斷：找出所有紀錄資料夾與來源
├── prices.json                  # 官方價格表（使用者每天從 GitHub 下載這個檔案）
├── server.js, pricing.js        # 伺服器、價格合併與比對
├── logfile.js                   # 讀取紀錄檔（.jsonl 與壓縮的 .jsonl.zst）
└── public/                      # 儀表板網頁
tests/                           # 自動化測試
.github/                         # issue 範本、CI
.claude-plugin/marketplace.json  # Claude Code 市集
.agents/plugins/marketplace.json # Codex 市集
```

```
npm test                             # 執行自動化測試（假資料，不需要真實紀錄）
node plugins/token-usage/server.js   # 前景執行伺服器
claude plugin validate .             # 驗證 Claude Code 市集與 plugin
```

- 測試在 `tests/`，使用 Node 內建的 `node:test`，沒有相依套件。每次 push 到 main 或開 PR 時，GitHub Actions 會在 Windows、macOS、Linux（Node 18 與 22）上自動執行。
- 給 AI 協作者（Claude Code、Codex、雲端工作階段）的規則寫在 [CLAUDE.md](CLAUDE.md)（Codex 讀 [AGENTS.md](AGENTS.md)）。

更新價格表（不用發佈新版本）：

1. 在這個倉庫裡，對 Claude Code 或 Codex 說「更新模型價格」，確認後它會寫成「AI 更新」。
2. 執行 `node plugins/token-usage/scripts/prices.js promote`，把 AI 更新併進 `prices.json`（日期改成今天）。
3. 檢查 `git diff`，commit 並 push 到 `main`。使用者的儀表板會在一天內自動下載。

發佈新版時：

1. **同時**升 `.claude-plugin/plugin.json` 和 `.codex-plugin/plugin.json` 的 `version`，兩邊要一樣。版本號沒變的話，使用者會繼續用快取裡的舊版。
2. commit 並 push。
3. `claude plugin tag plugins/token-usage`，再 `git push origin --tags`。

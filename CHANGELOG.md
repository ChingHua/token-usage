# 版本紀錄

## 0.6.5（2026-10-17）

- 新增自動化測試（`npm test`，使用假資料），並在 GitHub Actions 上於 Windows、macOS、Linux 自動執行。
- 新增 issue 範本（問題回報、價格錯誤 / 新模型、功能建議）與給 AI 協作者的 CLAUDE.md / AGENTS.md。
- 診斷工具也會檢查 `CODEX_HOME` 指到的資料夾。

## 0.6.4（2026-10-17）

- 整理兩個 skill 的說明：統一腳本路徑寫法、補上 Windows PowerShell 讀檔要加 `-Encoding UTF8`、`usage-query` 加上診斷的使用時機與完整設定表。
- README 修正 Codex 桌面版段落的路徑、補上 `/token-usage diagnose`、新增本版本紀錄。

## 0.6.3（2026-10-17）

- macOS 與 Linux 也有系統通知（macOS 用通知中心、Linux 用 `notify-send`）。
- macOS 可以自動偵測 OneDrive 資料夾。
- 新增診斷工具（`/token-usage diagnose`）：列出所有 Claude Code / Codex 紀錄資料夾與來源，找出儀表板讀不到的用量。
- 新增 `extraCodexDirs` 設定，可以一起讀其他 Codex 資料夾（例如 Codex 桌面版 WSL 模式的紀錄）。

## 0.6.2（2026-10-17）

- 用真正的 Codex 對話測試兩個 skill 後的修正：AI 寫入長上下文價格但少填快取價格時會提醒。
- README 補上 `codex exec`（非互動模式）的使用注意事項。

## 0.6.1（2026-10-17）

全面檢驗後的修正：

- **用量更準確**：Claude Code 同一次回應有時會寫入多次，先前取到的是串流中途的暫時數字，輸出 token 少算了約 3%。
- **安全性**：系統通知的文字不再拼進 PowerShell 指令；儀表板 API 擋下其他網站的跨站請求與 DNS rebinding。
- 跨裝置與分支的 Codex session 不再重複計算；`gpt-5.10` 不會被誤認成 `gpt-5.1`。
- 儀表板開著時，AI 寫入的價格不會因為在網頁上儲存其他價格而被蓋掉。
- 價格表修正 Claude Sonnet 5.5 快取價格，並新增 Opus 4.5、Sonnet 4.5、OpenAI gpt-6 系列。

## 0.6.0（2026-10-17）

- 價格表每天自動從 GitHub 下載，不用更新 plugin 也能拿到新價格。
- 新增「更新模型價格」skill：AI 讀官方價目表、列出差異，經使用者確認後才寫入。

## 0.5.0（2026-10-17）

- 可以安裝成 Codex plugin；也可以不裝 plugin，用 `start.cmd` / `start.sh` 直接執行。
- 第一次開啟時自動切到最近用過的工具。

## 0.4.0（2026-10-17）

- Claude Code 與 Codex 分開檢視，另有「全部比較」。
- 每個模型各自的官方價格（含快取、長上下文、快速模式），可以在網頁上修改。

## 0.3.0（2026-10-17）

- 支援 OpenAI Codex 的用量與方案額度使用率。

## 0.2.0（2026-10-17）

- 多裝置同步（OneDrive），用量歷史在 Claude Code 清掉舊紀錄後仍然保留。

## 0.1.0（2026-10-17）

- 第一版：Claude Code 用量儀表板，含情境分析、session 明細、熱度圖與門檻通知。

---
description: 開啟 Claude Token 用量儀表板（加上 stop 停止、status 查看狀態）
argument-hint: "[stop|status]"
allowed-tools: Bash(node:*)
---

執行下面的指令並把輸出結果用一兩句話告訴使用者（繁體中文）。不要做其他事。

- 如果參數是 `stop`：`node "${CLAUDE_PLUGIN_ROOT}/scripts/start.js" --stop`
- 如果參數是 `status`：`node "${CLAUDE_PLUGIN_ROOT}/scripts/start.js" --status`
- 其他情況（沒有參數）：`node "${CLAUDE_PLUGIN_ROOT}/scripts/start.js"`

參數：$ARGUMENTS

如果指令回報找不到 `node`，告訴使用者這個工具需要 Node.js 18 以上，請到 https://nodejs.org 安裝後再試。

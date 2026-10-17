#!/bin/sh
# AI Token 用量儀表板（不透過 Claude Code / Codex plugin 時使用）
#   ./start.sh            啟動並開啟瀏覽器
#   ./start.sh --stop     停止
#   ./start.sh --status   查看狀態
command -v node >/dev/null 2>&1 || { echo "需要 Node.js 18 以上，請到 https://nodejs.org 安裝"; exit 1; }
exec node "$(dirname "$0")/plugins/token-usage/scripts/start.js" "$@"

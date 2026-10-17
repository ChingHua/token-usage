@echo off
rem AI Token usage dashboard - use when not installed as a Claude Code / Codex plugin
rem   start.cmd           start and open the browser
rem   start.cmd --stop    stop the server
rem   start.cmd --status  show status
where node >nul 2>nul || (echo Node.js 18+ is required: https://nodejs.org & pause & exit /b 1)
node "%~dp0plugins\token-usage\scripts\start.js" %*

#!/usr/bin/env node
// 啟動 / 停止儀表板伺服器。
//   node start.js            啟動（若未執行）並開啟瀏覽器
//   node start.js --background  只在背景啟動，不開瀏覽器、不輸出（給 SessionStart hook 用）
//   node start.js --stop     停止伺服器
//   node start.js --status   顯示狀態
//   node start.js --url      只印出儀表板網址
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const args = new Set(process.argv.slice(2));
const quiet = args.has('--background');
const log = (...a) => { if (!quiet) console.log(...a); };

const DATA_DIR = process.env.TOKEN_USAGE_HOME || path.join(os.homedir(), '.claude-token-usage');
let port = 8787;
try { port = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8')).port || port; } catch { /* 預設值 */ }
const url = `http://localhost:${port}`;

function ping() {
  return new Promise(resolve => {
    const req = http.get(`http://127.0.0.1:${port}/api/ping`, { timeout: 1500 }, res => {
      let b = '';
      res.on('data', d => { b += d; });
      res.on('end', () => { try { const j = JSON.parse(b); resolve(j.app === 'claude-token-usage' ? j : null); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function openBrowser() {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

(async () => {
  if (args.has('--url')) return console.log(url); // 給 skill 用：取得儀表板網址（依設定檔的 port）
  const running = await ping();

  if (args.has('--status')) {
    console.log(running ? `執行中：${url}（pid ${running.pid}）` : '未執行');
    return;
  }
  if (args.has('--stop')) {
    if (!running) return console.log('伺服器沒有在執行');
    process.kill(running.pid);
    return console.log('已停止儀表板伺服器');
  }

  if (!running) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const out = fs.openSync(path.join(DATA_DIR, 'server.log'), 'a');
    spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      detached: true, stdio: ['ignore', out, out], windowsHide: true,
    }).unref();
    for (let i = 0; i < 40 && !(await ping()); i++) await new Promise(r => setTimeout(r, 250));
    if (!(await ping())) {
      log(`啟動失敗，請查看記錄檔：${path.join(DATA_DIR, 'server.log')}`);
      process.exit(quiet ? 0 : 1);
    }
    log(`已啟動儀表板：${url}`);
  } else {
    log(`儀表板已在執行：${url}`);
  }
  if (!quiet && !args.has('--no-open')) openBrowser();
  log(`設定檔：${path.join(DATA_DIR, 'config.json')}`);
})();

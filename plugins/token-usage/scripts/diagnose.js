#!/usr/bin/env node
// 診斷：找出這台電腦上所有 Claude Code / Codex 的紀錄位置與來源，確認儀表板讀得到哪些。只讀取，不修改任何檔案。
//   node diagnose.js
// Windows 會另外檢查 WSL 裡的 Codex 資料夾（Codex 桌面版的 WSL 模式），檢查時可能會啟動 WSL。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { listLogFiles: walk, isCompressed, readLog, zstdMethod } = require('../logfile');

const home = os.homedir();
const DATA_DIR = process.env.TOKEN_USAGE_HOME || path.join(home, '.claude-token-usage');
let config = {};
try { config = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8')); } catch { /* 尚未啟動過 */ }
const port = config.port || 8787;
const configuredCodex = config.codexDir || process.env.CODEX_HOME || path.join(home, '.codex');
const extraDirs = Array.isArray(config.extraCodexDirs) ? config.extraCodexDirs : [];
const isRead = d => [configuredCodex, ...extraDirs].some(x => path.resolve(x) === path.resolve(d));

const exists = p => { try { fs.accessSync(p); return true; } catch { return false; } };

// 讀每個 Codex 紀錄檔的 session_meta，依來源（originator / source）分組
function codexSummary(dir) {
  const files = [...walk(path.join(dir, 'sessions')), ...walk(path.join(dir, 'archived_sessions'))];
  const by = {};
  let newest = 0, compressed = 0, unreadable = 0;
  for (const f of files) {
    let meta = null;
    const zst = isCompressed(f);
    if (zst) compressed++;
    try {
      newest = Math.max(newest, fs.statSync(f).mtimeMs);
      let text;
      if (zst) text = readLog(f).slice(0, 256 * 1024);
      else { const fd = fs.openSync(f, 'r'); const buf = Buffer.alloc(256 * 1024); const n = fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd); text = buf.toString('utf8', 0, n); }
      const line = text.split('\n').find(l => l.includes('"session_meta"'));
      if (line) meta = JSON.parse(line).payload || {};
    } catch (e) { if (e.code === 'NO_ZSTD') unreadable++; /* 其他：檔案不完整 */ }
    const k = meta ? `${meta.originator || '?'} / ${typeof meta.source === 'string' ? meta.source : JSON.stringify(meta.source)}` : '(讀不到 session_meta)';
    by[k] = (by[k] || 0) + 1;
  }
  return { files: files.length, by, newest, compressed, unreadable };
}

// 可能存放 Codex 資料的位置
function codexCandidates() {
  const c = new Set([configuredCodex, ...extraDirs, process.env.CODEX_HOME, path.join(home, '.codex')].filter(Boolean));
  if (process.platform === 'darwin') {
    for (const base of [path.join(home, 'Library', 'Application Support'), path.join(home, 'Library', 'Containers')]) {
      try { for (const n of fs.readdirSync(base)) if (/codex|openai/i.test(n)) c.add(path.join(base, n)); } catch { /* 沒有 */ }
    }
  }
  if (process.platform === 'win32') {
    for (const base of [process.env.APPDATA, process.env.LOCALAPPDATA].filter(Boolean)) {
      try { for (const n of fs.readdirSync(base)) if (/^codex$|openai/i.test(n)) c.add(path.join(base, n)); } catch { /* 沒有 */ }
    }
    // Codex 桌面版的 WSL 模式：紀錄可能在 Linux 那一側的 ~/.codex
    let distros = [];
    try {
      distros = execFileSync('wsl.exe', ['-l', '-q'], { timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString('utf16le').replace(/\0/g, '').split(/\r?\n/).map(s => s.trim())
        .filter(s => /^[\w.-]+$/.test(s)); // 沒裝 WSL 時 wsl.exe 會輸出說明文字，不是發行版名稱
    } catch { /* 沒有 WSL */ }
    for (const d of distros) {
      const root = `\\\\wsl.localhost\\${d}`;
      c.add(path.join(root, 'root', '.codex'));
      try { for (const u of fs.readdirSync(path.join(root, 'home'))) c.add(path.join(root, 'home', u, '.codex')); } catch { /* 無法讀取 */ }
    }
  }
  // 同一個資料夾可能有不同寫法（C:/ 與 C:\），統一後去除重複
  const seen = new Set();
  return [...c].filter(p => { const k = path.resolve(p).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

function get(p) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 3000 }, res => { let b = ''; res.on('data', d => { b += d; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

(async () => {
  const fmt = ms => (ms ? new Date(ms).toLocaleString() : '-');
  console.log(`== 系統：${process.platform} ${os.release()}，Node ${process.version}`);
  console.log(`== 儀表板讀取的 Codex 資料夾：${configuredCodex}`);
  console.log(`== 解壓 .jsonl.zst：${{ node: 'Node 內建 zstd', cli: '系統的 zstd 指令' }[zstdMethod()] || '無法解壓（需要 Node 22.15 以上或 zstd 指令）'}`);

  console.log('\n== 找到的 Codex 資料夾');
  let found = 0;
  const missing = [];
  for (const dir of codexCandidates()) {
    if (!exists(dir)) continue;
    const s = codexSummary(dir);
    if (!s.files && dir !== configuredCodex) continue;
    found++;
    const read = isRead(dir);
    if (!read && s.files) missing.push(dir);
    const tag = read ? '（儀表板會讀）' : '（儀表板目前不會讀）';
    console.log(`${dir} ${tag}`);
    console.log(`  紀錄檔 ${s.files} 個${s.compressed ? `（其中壓縮檔 .jsonl.zst ${s.compressed} 個）` : ''}，最新一筆 ${fmt(s.newest)}`);
    if (s.unreadable) console.log(`  ⚠ ${s.unreadable} 個壓縮檔無法解壓，儀表板不會統計：請把 Node 升級到 22.15 以上，或安裝 zstd 指令`);
    for (const [k, n] of Object.entries(s.by).sort((a, b) => b[1] - a[1])) console.log(`  來源 ${k}：${n}`);
  }
  if (!found) console.log('（沒有找到任何 Codex 紀錄）');
  if (missing.length) {
    console.log(`
→ 有 Codex 紀錄在儀表板沒讀的位置。要一起統計的話，在 ${path.join(DATA_DIR, 'config.json')} 加上這一行，再重新啟動儀表板（--stop 後再啟動）：`);
    console.log(`  "extraCodexDirs": ${JSON.stringify([...extraDirs, ...missing])},`);
  }

  const claudeDir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects');
  console.log(`\n== Claude Code 紀錄：${claudeDir}，${walk(claudeDir).length} 個檔案`);

  console.log('\n== 已安裝的 plugin 版本');
  for (const [label, dir] of [['Claude Code', path.join(home, '.claude', 'plugins', 'cache', 'ai-usage-tools', 'token-usage')], ['Codex', path.join(configuredCodex, 'plugins', 'cache', 'ai-usage-tools', 'token-usage')]]) {
    let v = []; try { v = fs.readdirSync(dir); } catch { /* 沒裝 */ }
    v.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    console.log(`${label}：${v.length ? `${v[v.length - 1]}${v.length > 1 ? `（快取中還有舊版 ${v.slice(0, -1).join(', ')}）` : ''}` : '沒有安裝'}`);
  }

  console.log(`\n== 儀表板（port ${port}）`);
  const data = await get('/api/data');
  if (!data) console.log('沒有在執行');
  else {
    const n = (data.apps || []).map(() => 0);
    for (const r of data.rows) n[r[15] || 0]++;
    console.log(`執行中：${(data.apps || []).map((a, i) => `${a} ${n[i]} 次呼叫`).join('、')}`);
    const un = (data.models_seen || []).filter(m => !m.priceKey).map(m => m.model);
    if (un.length) console.log(`未定價的模型：${un.join('、')}`);
  }
})();

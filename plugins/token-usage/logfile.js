// 讀取對話紀錄檔：一般的 .jsonl，以及 Codex 壓縮過的 .jsonl.zst（舊的 session 會被壓縮）。
// 解壓縮優先用 Node 內建的 zstd（Node 22.15 / 23.8 以上），沒有的話改用系統的 zstd 指令；兩者都沒有就略過壓縮檔。
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const LOG_FILE = /\.jsonl(\.zst)?$/;
const isLogFile = name => LOG_FILE.test(name);
const isCompressed = file => file.endsWith('.zst');
// session 名稱：去掉 .jsonl / .jsonl.zst
const baseName = file => path.basename(file).replace(LOG_FILE, '');

function listLogFiles(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listLogFiles(p, out);
    else if (isLogFile(e.name)) out.push(p);
  }
  return out;
}

const MAX_OUTPUT = 1024 * 1024 * 1024; // 單一紀錄檔解壓後的上限（1 GB），避免壞檔吃光記憶體
let cliOk = null; // 系統是否有 zstd 指令（第一次用到時才檢查）
function zstdMethod() {
  if (typeof zlib.zstdDecompressSync === 'function') return 'node';
  if (cliOk === null) {
    try { execFileSync('zstd', ['--version'], { stdio: 'ignore', windowsHide: true, timeout: 10000 }); cliOk = true; } catch { cliOk = false; }
  }
  return cliOk ? 'cli' : '';
}

// 回傳檔案內容（字串）；壓縮檔無法解壓時丟出錯誤
function readLog(file) {
  if (!isCompressed(file)) return fs.readFileSync(file, 'utf8');
  const method = zstdMethod();
  if (method === 'node') return zlib.zstdDecompressSync(fs.readFileSync(file), { maxOutputLength: MAX_OUTPUT }).toString('utf8');
  if (method === 'cli') return execFileSync('zstd', ['-dcq', '--', file], { maxBuffer: MAX_OUTPUT, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
  const err = new Error('無法解壓 .zst：需要 Node 22.15 以上，或安裝 zstd 指令');
  err.code = 'NO_ZSTD';
  throw err;
}

module.exports = { isLogFile, isCompressed, baseName, listLogFiles, readLog, zstdMethod };

#!/usr/bin/env node
// 模型價格工具，給「更新模型價格」skill 與維護者使用。
//
//   node prices.js show              列出目前的價格表與這台電腦用到的模型（需要伺服器在執行）
//   node prices.js apply <檔案.json>  把 AI 查到的價格寫入（標為「AI 更新」）
//   node prices.js promote           維護者用：把 AI 更新併入 plugin 內建的 prices.json，並清掉這些 AI 更新
//
// apply 的檔案格式：
//   { "changes": [ { "tool": "codex", "model": "gpt-5.5", "input": 5, "output": 30, "cacheRead": 0.5,
//                    "long": { "threshold": 272000, "input": 10, "output": 45, "cacheRead": 1 },
//                    "sourceUrl": "https://developers.openai.com/api/docs/pricing" } ] }
//   價格單位都是美元 / 百萬 token。手動自訂過的模型不會被覆蓋，除非加上 --force。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { TOOLS, PRICE_FIELDS, BUNDLED_PATH, validatePrice, validatePriceFile } = require('../pricing');

const DATA_DIR = process.env.TOKEN_USAGE_HOME || path.join(os.homedir(), '.claude-token-usage');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const readConfig = () => { try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; } };
const port = () => readConfig().port || 8787;
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }; // 本地日期（不是 UTC）
const die = msg => { console.error(msg); process.exit(1); };

function request(method, p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: port(), path: p, method, timeout: 5000 }, res => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', d => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { reject(new Error('回應不是 JSON')); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('逾時')));
    req.end();
  });
}

async function show() {
  let prices, data;
  try { [prices, data] = await Promise.all([request('GET', '/api/prices'), request('GET', '/api/data')]); } catch {
    die(`連不到儀表板伺服器（port ${port()}）。請先執行：node "${path.join(__dirname, 'start.js')}" --no-open`);
  }
  const seen = (data.models_seen || []).map(m => ({ tool: m.app, model: m.model, calls: m.calls, priceKey: m.priceKey || null }));
  console.log(JSON.stringify({
    baseUpdated: prices.updated, baseSource: prices.baseSource, staleDays: prices.staleDays, sources: prices.sources,
    unpriced: seen.filter(m => !m.priceKey),
    seenModels: seen,
    prices: prices.effective,
  }, null, 2));
}

async function apply(file, force) {
  if (!file) die('用法：node prices.js apply <檔案.json> [--force]');
  let input;
  try { input = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { die('讀不到檔案或不是 JSON：' + e.message); }
  const changes = Array.isArray(input) ? input : input.changes;
  if (!Array.isArray(changes) || !changes.length) die('檔案裡沒有 changes');
  const cfg = readConfig();
  cfg.priceOverrides = cfg.priceOverrides || {};
  const done = [], skipped = [];
  for (const c of changes) {
    if (!TOOLS.includes(c.tool)) { skipped.push(`${c.model}：tool 必須是 ${TOOLS.join(' 或 ')}`); continue; }
    if (!c.model || typeof c.model !== 'string') { skipped.push('缺少 model'); continue; }
    const p = {};
    for (const f of PRICE_FIELDS) if (c[f] != null) p[f] = c[f];
    if (c.long) p.long = c.long;
    if (c.fast != null) p.fast = c.fast;
    const err = validatePrice(p);
    if (err) { skipped.push(`${c.tool}/${c.model}：${err}`); continue; }
    const cur = (cfg.priceOverrides[c.tool] || {})[c.model];
    if (cur && cur.source !== 'ai' && !force) { skipped.push(`${c.tool}/${c.model}：使用者手動自訂過，不覆蓋（加 --force 才會覆蓋）`); continue; }
    cfg.priceOverrides[c.tool] = cfg.priceOverrides[c.tool] || {};
    cfg.priceOverrides[c.tool][c.model] = { ...p, source: 'ai', updatedAt: today(), ...(c.sourceUrl ? { sourceUrl: c.sourceUrl } : {}) };
    done.push(`${c.tool}/${c.model}`);
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  let reloaded = false;
  try { await request('POST', '/api/reload'); reloaded = true; } catch { /* 伺服器沒在執行，下次啟動時會讀到 */ }
  console.log(JSON.stringify({ applied: done, skipped, serverReloaded: reloaded }, null, 2));
}

// 維護者用：在倉庫裡執行（要用倉庫裡的這份 prices.js，不是已安裝的 plugin），把 AI 更新併進內建的 prices.json
async function promote() {
  const cfg = readConfig();
  const ov = cfg.priceOverrides || {};
  const bundled = JSON.parse(fs.readFileSync(BUNDLED_PATH, 'utf8'));
  const moved = [];
  for (const tool of TOOLS) {
    for (const [m, p] of Object.entries(ov[tool] || {})) {
      if (!p || p.source !== 'ai') continue;
      const { source, updatedAt, sourceUrl, ...rest } = p; // eslint-disable-line no-unused-vars
      bundled.models[tool][m] = { ...rest, source: 'official' };
      delete ov[tool][m];
      moved.push(`${tool}/${m}`);
    }
  }
  if (!moved.length) die('沒有可以併入的 AI 更新價格');
  bundled.updated = today();
  const err = validatePriceFile(bundled);
  if (err) die('合併後的價格檔有問題：' + err);
  fs.writeFileSync(BUNDLED_PATH, JSON.stringify(bundled, null, 2) + '\n');
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  try { await request('POST', '/api/reload'); } catch { /* 伺服器沒在執行 */ }
  console.log(`已併入 ${moved.length} 個模型到 ${BUNDLED_PATH}（updated = ${bundled.updated}）：\n  ${moved.join('\n  ')}\n請檢查 git diff 後 commit、push；使用者會在一天內自動下載到新的價格表。`);
}

const [cmd, arg, ...rest] = process.argv.slice(2);
const force = [arg, ...rest].includes('--force');
if (cmd === 'show') show();
else if (cmd === 'apply') apply(arg === '--force' ? rest[0] : arg, force);
else if (cmd === 'promote') promote();
else die('用法：node prices.js show | apply <檔案.json> [--force] | promote');

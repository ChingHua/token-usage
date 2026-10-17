// 模型價格：資料在 prices.json（美元 / 百萬 token），這裡負責驗證、合併與比對。
//
// 每個模型的欄位：
//   input 輸入、output 輸出、cacheRead 快取讀取（OpenAI 的 cached input）、
//   cacheWrite5m / cacheWrite1h 快取寫入（只有 Claude；省略時用 input×1.25 / ×2）、
//   long 長上下文價格（提示 token 超過 threshold 時整次呼叫改用這組價格）、
//   fast 快速模式倍率、
//   source 'official' 官方價目 / 'estimate' 官方未列出，沿用同代模型。
//
// 價格的三個來源，後者覆蓋前者：
//   1. 基準價格表：plugin 內建的 prices.json，或每天從 GitHub 下載的較新版本
//   2. AI 更新：使用者用「更新模型價格」skill 寫入的價格（source 'ai'）。
//      基準價格表更新到比它新的日期時，AI 更新就自動退場，改用基準價格。
//   3. 自訂：使用者在儀表板手動改的價格（source 'custom'），一律優先。
//
// 比對方式：模型名稱完全相同 → 去掉日期後綴 → 最長的前綴相符；都找不到就列為「未定價」。
'use strict';
const fs = require('fs');
const path = require('path');

const BUNDLED_PATH = path.join(__dirname, 'prices.json');
const REMOTE_URL = 'https://raw.githubusercontent.com/ChingHua/token-usage/main/plugins/token-usage/prices.json';
const TOOLS = ['claude', 'codex'];
const PRICE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'];

// 檢查價格檔格式；回傳錯誤訊息，沒問題時回傳 null
function validatePriceFile(d) {
  if (!d || d.schema !== 1) return 'schema 不是 1';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.updated || '')) return 'updated 日期格式錯誤';
  if (!d.models || typeof d.models !== 'object') return '缺少 models';
  // 價格檔可能是從網路下載的：連結只接受 https，避免被塞進 javascript: 之類的網址
  for (const [k, u] of Object.entries(d.sources || {})) if (typeof u !== 'string' || !/^https:\/\/[^\s"'<>]+$/.test(u)) return `sources.${k} 不是 https 網址`;
  for (const tool of TOOLS) {
    const t = d.models[tool];
    if (!t || typeof t !== 'object') return `缺少 models.${tool}`;
    for (const [m, p] of Object.entries(t)) {
      const err = validatePrice(p);
      if (err) return `${tool}/${m}：${err}`;
    }
  }
  return null;
}
function validatePrice(p) {
  if (!p || typeof p !== 'object') return '不是物件';
  for (const f of ['input', 'output']) if (typeof p[f] !== 'number') return `缺少 ${f}`;
  for (const f of PRICE_FIELDS) {
    if (p[f] != null && (typeof p[f] !== 'number' || !(p[f] >= 0) || p[f] > 10000)) return `${f} 不合理：${p[f]}`;
  }
  if (p.long) {
    if (!(p.long.threshold > 0)) return 'long.threshold 不合理';
    for (const f of ['input', 'output', 'cacheRead']) if (p.long[f] != null && !(p.long[f] >= 0 && p.long[f] <= 10000)) return `long.${f} 不合理`;
  }
  if (p.fast != null && !(p.fast >= 1 && p.fast <= 10)) return 'fast 倍率不合理';
  if (p.source != null && !['official', 'estimate', 'ai', 'custom'].includes(p.source)) return `source 不合法：${p.source}`;
  return null;
}

function loadBundled() {
  return JSON.parse(fs.readFileSync(BUNDLED_PATH, 'utf8'));
}

// base：基準價格檔（prices.json 的內容）；overrides：config.priceOverrides
function effectivePrices(base, overrides = {}) {
  const out = {};
  for (const tool of TOOLS) {
    out[tool] = {};
    for (const [m, p] of Object.entries(base.models[tool] || {})) out[tool][m] = { ...p };
    for (const [m, p] of Object.entries((overrides && overrides[tool]) || {})) {
      if (p === null) { delete out[tool][m]; continue; }
      if (p.source === 'ai' && out[tool][m] && (p.updatedAt || '') < base.updated) continue; // 基準價格表已經更新
      out[tool][m] = { ...p, source: p.source === 'ai' ? 'ai' : 'custom' };
    }
  }
  return out;
}

function matchModel(table, model) {
  if (table[model]) return model;
  const undated = model.replace(/-\d{8}$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/@.*$/, '');
  if (table[undated]) return undated;
  // 前綴後面必須是分隔字元，避免 gpt-5.10 被當成 gpt-5.1、claude-opus-5-50 被當成 claude-opus-5-5
  let best = null;
  for (const k of Object.keys(table)) {
    if (undated.startsWith(k) && /^[-_@:]/.test(undated.slice(k.length)) && (!best || k.length > best.length)) best = k;
  }
  return best;
}

module.exports = { BUNDLED_PATH, REMOTE_URL, TOOLS, PRICE_FIELDS, validatePriceFile, validatePrice, loadBundled, effectivePrices, matchModel };

// 各工具、各模型的預設價格（美元 / 百萬 token）。
// 欄位：input 輸入、output 輸出、cacheRead 快取讀取（OpenAI 的 cached input）、
//       cacheWrite5m / cacheWrite1h 快取寫入（只有 Claude；省略時用 input×1.25 / ×2）、
//       long 長上下文價格（提示 token 超過 threshold 時整次呼叫改用這組價格）、
//       fast 快速模式倍率、source 'official' 官方價目 / 'estimate' 官方未列出，沿用同代模型。
// 比對方式：模型名稱完全相同 → 去掉日期後綴 → 最長的前綴相符；都找不到就列為「未定價」。
'use strict';

const PRICES_UPDATED = '2026-10-17';
const SOURCES = {
  claude: 'https://claude.com/pricing#api',
  codex: 'https://developers.openai.com/api/docs/pricing',
};

const DEFAULT_PRICES = {
  claude: {
    'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, source: 'official' },
    'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.25, source: 'official' },
    'claude-fable-5': { input: 10, output: 50, cacheRead: 1, source: 'official' },
    'claude-mythos-5': { input: 10, output: 50, cacheRead: 1, source: 'official' },
    'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, fast: 2, source: 'official' },
    'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, fast: 2, source: 'official' },
    'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, source: 'official' },
    'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5, source: 'official' },
    'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, source: 'official' },
    'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, source: 'official' },
    'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, source: 'official' },
    'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, source: 'official' },
    'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, long: { threshold: 100000, input: 0.5, output: 2.5, cacheRead: 0.05 }, source: 'official' },
    'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, source: 'official' },
  },
  codex: {
    'gpt-5.6-sol': { input: 4, output: 20, cacheRead: 0.4, long: { threshold: 272000, input: 8, output: 30, cacheRead: 0.8 }, source: 'official' },
    'gpt-5.6-terra': { input: 2, output: 12, cacheRead: 0.2, long: { threshold: 272000, input: 4, output: 18, cacheRead: 0.4 }, source: 'official' },
    'gpt-5.6-luna': { input: 0.2, output: 1.2, cacheRead: 0.02, long: { threshold: 272000, input: 0.4, output: 1.8, cacheRead: 0.04 }, source: 'official' },
    'gpt-5.5': { input: 5, output: 30, cacheRead: 0.5, long: { threshold: 272000, input: 10, output: 45, cacheRead: 1 }, source: 'official' },
    'gpt-5.5-pro': { input: 30, output: 180, cacheRead: 30, long: { threshold: 272000, input: 60, output: 270, cacheRead: 60 }, source: 'official' },
    'gpt-5.4': { input: 2.5, output: 15, cacheRead: 0.25, long: { threshold: 272000, input: 5, output: 22.5, cacheRead: 0.5 }, source: 'official' },
    'gpt-5.4-pro': { input: 30, output: 180, cacheRead: 30, long: { threshold: 272000, input: 60, output: 270, cacheRead: 60 }, source: 'official' },
    'gpt-5.4-mini': { input: 0.75, output: 4.5, cacheRead: 0.075, source: 'official' },
    'gpt-5.4-nano': { input: 0.2, output: 1.25, cacheRead: 0.02, source: 'official' },
    'gpt-5.3-codex': { input: 1.75, output: 14, cacheRead: 0.175, source: 'official' },
    'gpt-5.2': { input: 1.75, output: 14, cacheRead: 0.175, source: 'official' },
    'gpt-5.2-pro': { input: 21, output: 168, cacheRead: 21, source: 'official' },
    'gpt-5.2-codex': { input: 1.75, output: 14, cacheRead: 0.175, source: 'estimate' },
    'gpt-5.1': { input: 1.25, output: 10, cacheRead: 0.125, source: 'official' },
    'gpt-5.1-codex': { input: 1.25, output: 10, cacheRead: 0.125, source: 'estimate' },
    'gpt-5.1-codex-max': { input: 1.25, output: 10, cacheRead: 0.125, source: 'estimate' },
    'gpt-5.1-codex-mini': { input: 0.25, output: 2, cacheRead: 0.025, source: 'estimate' },
    'gpt-5': { input: 1.25, output: 10, cacheRead: 0.125, source: 'official' },
    'gpt-5-codex': { input: 1.25, output: 10, cacheRead: 0.125, source: 'estimate' },
    'gpt-5-mini': { input: 0.25, output: 2, cacheRead: 0.025, source: 'official' },
    'gpt-5-nano': { input: 0.05, output: 0.4, cacheRead: 0.005, source: 'official' },
    'codex-mini-latest': { input: 1.5, output: 6, cacheRead: 0.375, source: 'estimate' },
    'o3': { input: 2, output: 8, cacheRead: 0.5, source: 'official' },
    'o4-mini': { input: 1.1, output: 4.4, cacheRead: 0.275, source: 'official' },
    'gpt-4.1': { input: 2, output: 8, cacheRead: 0.5, source: 'official' },
  },
};

// 合併預設價格與使用者自訂（overrides[tool][model] 完整取代該模型；值為 null 代表刪除）
function effectivePrices(overrides = {}) {
  const out = {};
  for (const tool of Object.keys(DEFAULT_PRICES)) {
    out[tool] = {};
    for (const [m, p] of Object.entries(DEFAULT_PRICES[tool])) out[tool][m] = { ...p };
    for (const [m, p] of Object.entries(overrides[tool] || {})) {
      if (p === null) delete out[tool][m];
      else out[tool][m] = { ...p, source: 'custom' };
    }
  }
  return out;
}

function matchModel(table, model) {
  if (table[model]) return model;
  const undated = model.replace(/-\d{8}$/, '').replace(/@.*$/, '');
  if (table[undated]) return undated;
  let best = null;
  for (const k of Object.keys(table)) if (undated.startsWith(k) && (!best || k.length > best.length)) best = k;
  return best;
}

module.exports = { PRICES_UPDATED, SOURCES, DEFAULT_PRICES, effectivePrices, matchModel };

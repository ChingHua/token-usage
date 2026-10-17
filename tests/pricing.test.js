// 價格表的格式驗證、模型比對、三層價格合併（官方 < AI 更新 < 自訂）
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { PLUGIN } = require('./helpers');
const P = require(path.join(PLUGIN, 'pricing'));

test('內建 prices.json 格式正確，兩個工具都有模型', () => {
  const b = P.loadBundled();
  assert.equal(P.validatePriceFile(b), null);
  assert.ok(Object.keys(b.models.claude).length > 5);
  assert.ok(Object.keys(b.models.codex).length > 5);
  for (const tool of P.TOOLS) for (const [m, p] of Object.entries(b.models[tool])) {
    assert.ok(['official', 'estimate'].includes(p.source), `${tool}/${m} 的 source 應該是 official 或 estimate`);
  }
});

test('價格檔驗證會擋下不合理或危險的內容', () => {
  const good = P.loadBundled();
  const bad = mutate => { const d = JSON.parse(JSON.stringify(good)); mutate(d); return P.validatePriceFile(d); };
  assert.match(bad(d => { d.schema = 2; }), /schema/);
  assert.match(bad(d => { d.updated = '2026/10/17'; }), /updated/);
  assert.match(bad(d => { d.sources.claude = 'javascript:alert(1)'; }), /https/);
  assert.match(bad(d => { d.models.codex['gpt-5.5'].input = -1; }), /input/);
  assert.match(bad(d => { d.models.codex['gpt-5.5'].output = 999999; }), /output/);
  assert.match(bad(d => { d.models.codex['gpt-5.5'].source = 'x" onmouseover="1'; }), /source/);
  assert.match(bad(d => { d.models.claude['claude-opus-5-5'].fast = 50; }), /fast/);
  assert.match(bad(d => { delete d.models.codex; }), /codex/);
});

test('模型名稱比對：完全相同 → 去日期 → 有分隔字元的最長前綴', () => {
  const t = { 'gpt-5.1': {}, 'gpt-5.5': {}, 'gpt-5.5-pro': {}, 'gpt-5.4-mini': {}, 'claude-opus-5-5': {}, 'claude-opus-5': {}, 'claude-sonnet-4-6': {} };
  assert.equal(P.matchModel(t, 'gpt-5.5'), 'gpt-5.5');
  assert.equal(P.matchModel(t, 'gpt-5.5-pro'), 'gpt-5.5-pro');
  assert.equal(P.matchModel(t, 'gpt-5.4-mini-2026-03-01'), 'gpt-5.4-mini');
  assert.equal(P.matchModel(t, 'claude-opus-5-5-20260101'), 'claude-opus-5-5');
  assert.equal(P.matchModel(t, 'claude-sonnet-4-6@20250929'), 'claude-sonnet-4-6');
  assert.equal(P.matchModel(t, 'gpt-5.10'), null, 'gpt-5.10 不能被當成 gpt-5.1');
  assert.equal(P.matchModel(t, 'gpt-9'), null);
  assert.equal(P.matchModel(t, 'claude-opus-9'), null);
});

test('三層價格：AI 更新比官方表舊就退場，自訂永遠優先，null 代表刪除', () => {
  const base = { schema: 1, updated: '2026-10-17', sources: {}, models: {
    claude: { 'claude-opus-5-5': { input: 4, output: 20, source: 'official' } },
    codex: { 'gpt-5.5': { input: 5, output: 30, source: 'official' }, 'gpt-5': { input: 1.25, output: 10, source: 'official' } },
  } };
  const e = P.effectivePrices(base, {
    codex: {
      'gpt-5.5': { input: 7, output: 30, source: 'ai', updatedAt: '2026-10-01' }, // 比官方表舊 → 退場
      'gpt-new': { input: 1, output: 2, source: 'ai', updatedAt: '2026-10-20' },  // 官方表沒有 → 保留
      'gpt-5': null,                                                              // 刪除
    },
    claude: { 'claude-opus-5-5': { input: 3, output: 15 } },                     // 自訂
  });
  assert.equal(e.codex['gpt-5.5'].input, 5);
  assert.equal(e.codex['gpt-5.5'].source, 'official');
  assert.equal(e.codex['gpt-new'].source, 'ai');
  assert.equal(e.codex['gpt-5'], undefined);
  assert.equal(e.claude['claude-opus-5-5'].input, 3);
  assert.equal(e.claude['claude-opus-5-5'].source, 'custom');
});

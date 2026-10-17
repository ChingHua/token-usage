// 命令列工具：prices.js（show / apply / promote）、start.js、diagnose.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const H = require('./helpers');

const node = (script, args, env) => execFileSync(process.execPath, [script, ...args], { env, encoding: 'utf8', timeout: 60000 });

test('prices.js：show 與 apply（AI 更新、手動自訂不被覆蓋、不合理的價格被擋、長上下文少快取價格會提醒）', async t => {
  const root = H.tmpDir();
  const projectsDir = path.join(root, 'projects');
  const codexDir = path.join(root, 'codex');
  H.writeClaudeFixture(projectsDir);
  H.writeCodexFixture(codexDir);
  const s = await H.startServer({ projectsDir, codexDir, config: { priceOverrides: { claude: { 'claude-haiku-5-5': { input: 0.2, output: 1 } } } } });
  t.after(async () => { await s.stop(); H.rm(root); H.rm(s.home); });
  const PRICES = path.join(H.PLUGIN, 'scripts', 'prices.js');

  const shown = JSON.parse(node(PRICES, ['show'], s.env));
  assert.ok(shown.seenModels.length >= 4);
  assert.ok(Array.isArray(shown.unpriced));

  const file = path.join(root, 'changes.json');
  fs.writeFileSync(file, JSON.stringify({ changes: [
    { tool: 'codex', model: 'gpt-new', input: 1, output: 2, cacheRead: 0.1, long: { threshold: 272000, input: 2, output: 3 }, sourceUrl: 'https://example.test' },
    { tool: 'claude', model: 'claude-haiku-5-5', input: 0.3, output: 1.5 },
    { tool: 'claude', model: 'bad', input: -1, output: 2 },
    { tool: 'gemini', model: 'x', input: 1, output: 1 },
  ] }));
  const r = JSON.parse(node(PRICES, ['apply', file], s.env));
  assert.deepEqual(r.applied, ['codex/gpt-new']);
  assert.ok(r.skipped.some(x => x.includes('claude-haiku-5-5') && x.includes('手動')));
  assert.ok(r.skipped.some(x => x.includes('bad')));
  assert.ok(r.skipped.some(x => x.includes('tool')));
  assert.ok(r.warnings.some(x => x.includes('gpt-new') && x.includes('cacheRead')));
  assert.equal(r.serverReloaded, true);

  const p = await s.get('/api/prices');
  assert.equal(p.effective.codex['gpt-new'].source, 'ai');
  assert.equal(p.effective.claude['claude-haiku-5-5'].source, 'custom');
});

test('prices.js promote：只把 AI 更新併進 prices.json，手動自訂留在設定檔', () => {
  const root = H.tmpDir();
  // 在 plugin 的複本上執行，不動到倉庫裡的 prices.json
  const copy = path.join(root, 'plugin');
  fs.cpSync(H.PLUGIN, copy, { recursive: true });
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port: 1, priceOverrides: {
    codex: { 'gpt-test': { input: 3, output: 18, cacheRead: 0.3, source: 'ai', updatedAt: '2026-10-17' } },
    claude: { 'claude-opus-5-5': { input: 9, output: 9 } },
  } }));
  try {
    const out = node(path.join(copy, 'scripts', 'prices.js'), ['promote'], { ...process.env, TOKEN_USAGE_HOME: home });
    assert.match(out, /codex\/gpt-test/);
    const bundled = JSON.parse(fs.readFileSync(path.join(copy, 'prices.json'), 'utf8'));
    assert.deepEqual(bundled.models.codex['gpt-test'], { input: 3, output: 18, cacheRead: 0.3, source: 'official' });
    const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    assert.equal(cfg.priceOverrides.codex['gpt-test'], undefined);
    assert.ok(cfg.priceOverrides.claude['claude-opus-5-5'], '手動自訂留著');
  } finally { H.rm(root); }
});

test('start.js：--url、啟動、--status、--stop', async t => {
  const home = H.tmpDir();
  const root = H.tmpDir();
  const port = await H.freePort();
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port, windowsToast: false, remotePrices: false, projectsDir: path.join(root, 'p'), codexDir: path.join(root, 'c') }));
  const env = { ...process.env, TOKEN_USAGE_HOME: home };
  const START = path.join(H.PLUGIN, 'scripts', 'start.js');
  t.after(() => { try { node(START, ['--stop'], env); } catch { /* 已停止 */ } H.rm(home); H.rm(root); });

  assert.equal(node(START, ['--url'], env).trim(), `http://localhost:${port}`);
  assert.match(node(START, ['--status'], env), /未執行/);
  assert.match(node(START, ['--no-open'], env), /已啟動/);
  assert.match(node(START, ['--status'], env), /執行中/);
  assert.match(node(START, ['--stop'], env), /已停止/);
});

test('diagnose.js：找到 Codex 資料夾並依來源分組，提示沒讀到的資料夾', () => {
  const root = H.tmpDir();
  const codexDir = path.join(root, 'codex');
  const otherCodex = path.join(root, 'other', '.codex');
  H.writeCodexFixture(codexDir);
  H.writeCodexFixture(otherCodex);
  const zst = H.writeJsonlZst(path.join(codexDir, 'sessions', 'old.jsonl.zst'), H.writeCodexFixture.records.common);
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port: 1, codexDir, extraCodexDirs: [] }));
  try {
    // 用 CODEX_HOME 讓 diagnose 把另一個資料夾也當成候選（模擬桌面版或 WSL 的位置）
    const out = node(path.join(H.PLUGIN, 'scripts', 'diagnose.js'), [], { ...process.env, TOKEN_USAGE_HOME: home, CODEX_HOME: otherCodex });
    assert.ok(out.includes(`${codexDir} （儀表板會讀）`), '列出儀表板讀的資料夾');
    assert.ok(out.includes(`${otherCodex} （儀表板目前不會讀）`), '列出儀表板沒讀的資料夾');
    assert.match(out, zst ? /codex_cli_rs \/ cli：3/ : /codex_cli_rs \/ cli：2/, '壓縮檔也依來源分組');
    if (zst) assert.match(out, /其中壓縮檔 \.jsonl\.zst 1 個/);
    assert.match(out, /"extraCodexDirs":/, '印出要加進設定檔的那一行');
  } finally { H.rm(root); }
});

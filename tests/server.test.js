// 伺服器端到端測試：用假紀錄啟動真正的 server.js，檢查解析、去重、花費、同步、設定 API 與安全性
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const H = require('./helpers');

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}：${a} ≠ ${b}`);
const sum = (rows, k) => rows.reduce((s, r) => s + r[k], 0);

test('解析、去重、花費與多裝置同步', async t => {
  const root = H.tmpDir();
  const projectsDir = path.join(root, 'claude', 'projects');
  const codexDir = path.join(root, 'codex');
  const syncDir = path.join(root, 'sync');
  const home = path.join(root, 'home');
  H.writeClaudeFixture(projectsDir);
  H.writeCodexFixture(codexDir);
  fs.mkdirSync(home, { recursive: true });
  // 舊版（0.6.0 以前）的歷史檔：Codex key 是 codex|<session>|<total>，載入時要換成新格式，不能重複計算
  fs.writeFileSync(path.join(home, 'history.json'), JSON.stringify({
    version: 1, device: { id: 'local', name: 'local' }, updatedAt: H.T0,
    sessions: ['codex-A'], titles: {}, cwds: ['/home/u/gamma'], models: ['gpt-5.5'], prompts: [''],
    rows: [['codex|codex-A|1000', H.T0 + 12 * 60e3, 0, 0, 0, 500, 100, 0, 0, 400, 0, 'shell_command:read', 0, 0, 1, 0]],
  }));
  // 另一台裝置的同步檔：一筆和本機重複（m2，只能算一次）、一筆新的
  fs.mkdirSync(path.join(syncDir, 'devices'), { recursive: true });
  fs.writeFileSync(path.join(syncDir, 'devices', 'LAPTOP.json'), JSON.stringify({
    version: 1, device: { id: 'LAPTOP', name: '筆電' }, updatedAt: H.T0,
    sessions: ['laptop-s'], titles: {}, cwds: ['C:\\proj\\laptop'], models: ['claude-opus-5-5'], prompts: ['hi'],
    rows: [
      ['m2|r2', H.T0, 0, 0, 0, 20, 300, 0, 0, 5000, 0, 'Edit', 0, 0, 0, 0],
      ['L1|x', H.T0 + 60e3, 0, 0, 0, 1000, 500, 0, 0, 0, 0, '', 0, 0, 0, 0],
    ],
  }));

  const s = await H.startServer({ home, projectsDir, codexDir, config: { syncDir, deviceName: '桌機' } });
  t.after(async () => { await s.stop(); H.rm(root); });
  const data = await s.get('/api/data');
  const rows = H.rowsOf(data);
  const local = rows.filter(r => r.device.local);
  const claude = local.filter(r => r.app === 'Claude Code');
  const codex = local.filter(r => r.app === 'Codex');

  await t.test('Claude Code：呼叫數與四種 token（串流暫時值取最終值、接續 session 不重複、排除 synthetic）', () => {
    const E = H.EXPECTED.claude;
    assert.equal(claude.length, E.calls);
    assert.equal(sum(claude, 'input'), E.input);
    assert.equal(sum(claude, 'output'), E.output);
    assert.equal(sum(claude, 'cacheWrite'), E.cacheWrite);
    assert.equal(sum(claude, 'cacheRead'), E.cacheRead);
  });

  await t.test('Claude Code：每筆花費（5 分 / 1 小時快取寫入、長上下文、快速模式）', () => {
    const by = Object.fromEntries(claude.map(r => [`${r.model}|${r.input}|${r.output}|${r.cacheWrite}`, r.cost]));
    const C = H.EXPECTED.claudeCost;
    near(by['claude-opus-5-5|10|120|1000'], C.m1, 'm1');
    near(by['claude-opus-5-5|20|300|0'], C.m2, 'm2');
    near(by['claude-haiku-5-5|150000|100|0'], C.m3, 'm3（Haiku 長上下文）');
    near(by['claude-sonnet-5-5|30|40|0'], C.m4, 'm4');
    near(by['claude-opus-5-5|100|100|0'], C.m5, 'm5（快速模式 2 倍）');
    near(by['claude-opus-5-5|0|0|2000'], C.m6, 'm6（1 小時快取）');
  });

  await t.test('Claude Code：子代理、專案名稱、情境分類', () => {
    assert.equal(claude.filter(r => r.sub).length, 1);
    assert.ok(claude.every(r => r.project === 'alpha'), 'Windows 路徑 C:\\work\\alpha 的專案名稱是 alpha');
    const scen = Object.fromEntries(claude.map(r => [`${r.model}|${r.output}`, r.scenario]));
    assert.equal(scen['claude-opus-5-5|120'], '讀取/搜尋');
    assert.equal(scen['claude-opus-5-5|300'], '編輯檔案');
    assert.equal(scen['claude-sonnet-5-5|40'], '讀取/搜尋');
    assert.equal(scen['claude-haiku-5-5|100'], '文字回覆');
  });

  await t.test('Codex：快取從 input 拆開、重複事件與分支 session 只算一次、舊版 key 不重複', () => {
    const E = H.EXPECTED.codex;
    assert.equal(codex.length, E.calls);
    assert.equal(sum(codex, 'input'), E.input);
    assert.equal(sum(codex, 'output'), E.output);
    assert.equal(sum(codex, 'cacheRead'), E.cacheRead);
    assert.equal(sum(codex, 'cacheWrite'), 0);
    near(sum(codex, 'cost'), E.cost, 'Codex 總花費');
    assert.ok(codex.every(r => r.project === 'gamma'), 'Linux 路徑 /home/u/gamma 的專案名稱是 gamma');
  });

  await t.test('Codex：shell 指令依內容分類、方案額度', () => {
    const scen = codex.map(r => r.scenario).sort();
    assert.deepEqual(scen, ['文字回覆', '編輯檔案', '讀取/搜尋'].sort());
    assert.equal(data.limits.codex.primary.used_percent, 12);
    assert.equal(data.limits.codex.secondary.used_percent, 3);
  });

  await t.test('多裝置：讀到另一台、重複的呼叫只算一次、本機寫出自己的同步檔', () => {
    assert.equal(data.devices.length, 2);
    assert.ok(data.devices.some(d => d.name === '筆電'));
    assert.equal(rows.filter(r => !r.device.local).length, 1);
    const own = fs.readdirSync(path.join(syncDir, 'devices')).filter(f => f !== 'LAPTOP.json');
    assert.equal(own.length, 1, '本機應該寫出一個同步檔');
    const f = JSON.parse(fs.readFileSync(path.join(syncDir, 'devices', own[0]), 'utf8'));
    assert.equal(f.rows.length, local.length);
    assert.equal(f.device.name, '桌機');
  });

  await t.test('models_seen：每個模型對到價格', () => {
    const seen = data.models_seen.map(m => `${m.app}|${m.model}|${m.priceKey}`).sort();
    assert.ok(seen.includes('codex|gpt-5.5|gpt-5.5'));
    assert.ok(seen.includes('claude|claude-haiku-5-5|claude-haiku-5-5'));
    assert.ok(data.models_seen.every(m => m.priceKey), '沒有未定價的模型');
  });
});

test('設定 API、價格修改與安全性', async t => {
  const root = H.tmpDir();
  const projectsDir = path.join(root, 'projects');
  const codexDir = path.join(root, 'codex');
  H.writeClaudeFixture(projectsDir);
  H.writeCodexFixture(codexDir);
  const s = await H.startServer({ projectsDir, codexDir });
  t.after(async () => { await s.stop(); H.rm(root); H.rm(s.home); });
  const host = { Host: `127.0.0.1:${s.port}` };

  await t.test('首頁與靜態檔', async () => {
    assert.equal((await H.request('GET', s.base + '/')).status, 200);
    assert.equal((await H.request('GET', s.base + '/app.js')).status, 200);
    assert.notEqual((await H.request('GET', s.base + '/..%2f..%2fserver.js')).status, 200, '路徑穿越要被擋');
  });

  await t.test('設定：門檻可儲存並寫入檔案；壞掉的 JSON、非物件、相對路徑都回 400', async () => {
    let r = await s.post('/api/config', { thresholds: { dailyCost: 123 } });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.home, 'config.json'), 'utf8')).thresholds.dailyCost, 123);
    assert.equal((await s.post('/api/config', '{bad json')).status, 400);
    assert.equal((await s.post('/api/config', JSON.stringify('a string'))).status, 400);
    assert.equal((await s.post('/api/config', { syncDir: 'relative/path' })).status, 400);
  });

  await t.test('價格修改只送有改的模型，不會蓋掉其他模型；null 還原', async () => {
    let r = await s.post('/api/config', { priceOverridesPatch: { codex: { 'gpt-5': { input: 1.3, output: 10 } } } });
    assert.equal(r.status, 200);
    let p = await s.get('/api/prices');
    assert.equal(p.effective.codex['gpt-5'].source, 'custom');
    assert.equal(p.effective.codex['gpt-5.5'].input, 5, '其他模型的自訂價格保留');
    await s.post('/api/config', { priceOverridesPatch: { codex: { 'gpt-5': null } } });
    p = await s.get('/api/prices');
    assert.notEqual(p.effective.codex['gpt-5'].source, 'custom');
    assert.equal((await s.post('/api/config', { priceOverridesPatch: { gemini: { x: { input: 1, output: 1 } } } })).status, 400);
    assert.equal((await s.post('/api/config', { priceOverridesPatch: { codex: { x: { input: -1, output: 1 } } } })).status, 400);
  });

  await t.test('安全性：其他網站的請求、錯誤的 Host 都被擋', async () => {
    const raw = (opts, body) => new Promise(resolve => {
      const req = http.request({ host: '127.0.0.1', port: s.port, ...opts }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', () => resolve(0));
      req.end(body);
    });
    assert.equal(await raw({ path: '/api/config', method: 'POST', headers: { ...host, Origin: 'https://evil.example' } }, '{}'), 403);
    assert.equal(await raw({ path: '/api/config', method: 'POST', headers: { ...host, 'Sec-Fetch-Site': 'cross-site' } }, '{}'), 403);
    assert.equal(await raw({ path: '/api/data', headers: { Host: 'evil.example' } }), 403);
    assert.equal(await raw({ path: '/api/config', method: 'POST', headers: { ...host, Origin: `http://localhost:${s.port}` } }, '{}'), 200);
  });
});

test('每天下載的價格表：較新的版本會被採用，下載失敗保留原本的', async t => {
  const root = H.tmpDir();
  const remote = JSON.parse(fs.readFileSync(path.join(H.PLUGIN, 'prices.json'), 'utf8'));
  remote.updated = '2099-01-01';
  remote.models.codex['gpt-5.5'].input = 4;
  const fake = http.createServer((req, res) => { if (req.url === '/prices.json') res.end(JSON.stringify(remote)); else { res.statusCode = 404; res.end(); } });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${fake.address().port}`;
  const s = await H.startServer({ projectsDir: path.join(root, 'p'), codexDir: path.join(root, 'c'), config: { remotePrices: true, remotePricesUrl: `${url}/prices.json`, priceOverrides: {} } });
  t.after(async () => { await s.stop(); fake.close(); H.rm(root); H.rm(s.home); });

  let p = await s.post('/api/prices/check').then(r => r.json);
  assert.equal(p.baseSource, 'remote');
  assert.equal(p.updated, '2099-01-01');
  assert.equal(p.effective.codex['gpt-5.5'].input, 4);

  const cfg = JSON.parse(fs.readFileSync(path.join(s.home, 'config.json'), 'utf8'));
  cfg.remotePricesUrl = `${url}/missing.json`;
  fs.writeFileSync(path.join(s.home, 'config.json'), JSON.stringify(cfg));
  await s.post('/api/reload');
  p = await s.post('/api/prices/check').then(r => r.json);
  assert.match(p.remote.error, /404/);
  assert.equal(p.updated, '2099-01-01', '下載失敗時保留原本的價格表');
});

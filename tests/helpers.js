// 測試共用工具：產生假的 Claude Code / Codex 紀錄、啟動與停止儀表板伺服器、發送 HTTP 請求。
// 所有資料都寫在暫存資料夾，不會讀寫使用者真正的 ~/.claude、~/.codex 或 ~/.claude-token-usage。
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const PLUGIN = path.join(__dirname, '..', 'plugins', 'token-usage');

function tmpDir(prefix = 'tu-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function rm(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 上偶爾被佔用，留給系統清 */ }
}
function writeJsonl(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + '\n');
}
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

// ---------- 假資料 ----------
// 數字都經過設計，預期值寫在 EXPECTED，測試直接比對。
const T0 = Date.parse('2026-10-01T02:00:00Z');
const ts = min => new Date(T0 + min * 60e3).toISOString();

const usage = (input, output, cw = 0, cr = 0, extra = {}) => ({
  input_tokens: input, output_tokens: output, cache_creation_input_tokens: cw, cache_read_input_tokens: cr, ...extra,
});
const assistant = (id, req, model, u, content, more = {}) => ({
  type: 'assistant', timestamp: more.timestamp, sessionId: more.sessionId, cwd: more.cwd, requestId: req,
  isSidechain: !!more.isSidechain, uuid: `${id}-${Math.random()}`,
  message: { id, model, role: 'assistant', usage: u, content },
});
const user = (text, more) => ({ type: 'user', timestamp: more.timestamp, sessionId: more.sessionId, cwd: more.cwd, message: { role: 'user', content: text } });

function writeClaudeFixture(projectsDir) {
  const A = { sessionId: 'claude-A', cwd: 'C:\\work\\alpha' };
  const at = (m, o = A) => ({ ...o, timestamp: ts(m) });
  writeJsonl(path.join(projectsDir, 'C--work-alpha', 'claude-A.jsonl'), [
    { type: 'custom-title', sessionId: 'claude-A', customTitle: 'Alpha 任務' },
    user('請讀取設定檔', at(0)),
    // m1：同一次回應寫成兩行，第一行是串流中途的暫時用量（output 5），第二行是最終值（output 120）
    assistant('m1', 'r1', 'claude-opus-5-5', usage(10, 5, 1000, 2000), [{ type: 'tool_use', name: 'Read', input: {} }], at(1)),
    assistant('m1', 'r1', 'claude-opus-5-5', usage(10, 120, 1000, 2000), [{ type: 'text', text: 'ok' }], at(1)),
    assistant('m2', 'r2', 'claude-opus-5-5', usage(20, 300, 0, 5000), [{ type: 'tool_use', name: 'Edit', input: {} }], at(2)),
    // m3：Haiku 5.5 提示超過 100K，套用長上下文價格
    assistant('m3', 'r3', 'claude-haiku-5-5', usage(150000, 100), [{ type: 'text', text: 'long' }], at(3)),
    // m5：快速模式
    assistant('m5', 'r5', 'claude-opus-5-5', usage(100, 100, 0, 0, { speed: 'fast' }), [{ type: 'text', text: 'fast' }], at(4)),
    // m6：1 小時快取寫入
    assistant('m6', 'r6', 'claude-opus-5-5', usage(0, 0, 2000, 0, { cache_creation: { ephemeral_1h_input_tokens: 2000, ephemeral_5m_input_tokens: 0 } }), [{ type: 'text', text: '1h' }], at(5)),
    // 系統產生的假回應，不算
    assistant('syn', 'rs', '<synthetic>', usage(0, 0), [{ type: 'text', text: '' }], at(6)),
  ]);
  // 接續的 session 會複製先前的 m2（而且是較小的暫時值），不能重複計算
  writeJsonl(path.join(projectsDir, 'C--work-alpha', 'claude-A2.jsonl'), [
    assistant('m2', 'r2', 'claude-opus-5-5', usage(20, 250, 0, 5000), [{ type: 'tool_use', name: 'Edit', input: {} }], { sessionId: 'claude-A2', cwd: A.cwd, timestamp: ts(2) }),
  ]);
  // 子代理
  writeJsonl(path.join(projectsDir, 'C--work-alpha', 'claude-A', 'subagents', 'agent-1.jsonl'), [
    assistant('m4', 'r4', 'claude-sonnet-5-5', usage(30, 40, 0, 1000), [{ type: 'tool_use', name: 'Grep', input: {} }], { ...A, timestamp: ts(7), isSidechain: true }),
  ]);
}

function writeCodexFixture(codexDir) {
  const meta = (id, min) => ({ timestamp: ts(min), type: 'session_meta', payload: { id, cwd: '/home/u/gamma', originator: 'codex_cli_rs', source: 'cli' } });
  const tc = (min, total, input, cached, output, limits) => ({
    timestamp: ts(min), type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: { total_tokens: total }, last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0 } }, ...(limits ? { rate_limits: limits } : {}) },
  });
  const call = (min, cmd) => ({ timestamp: ts(min), type: 'response_item', payload: { type: 'function_call', name: 'shell_command', arguments: JSON.stringify({ command: cmd }) } });
  const limits = { primary: { used_percent: 12, window_minutes: 300 }, secondary: { used_percent: 3, window_minutes: 10080 }, plan_type: 'plus' };
  const common = [
    meta('codex-A', 10),
    { timestamp: ts(10), type: 'turn_context', payload: { model: 'gpt-5.5', cwd: '/home/u/gamma' } },
    { timestamp: ts(10), type: 'event_msg', payload: { type: 'user_message', message: '幫我找 bug' } },
    call(11, 'rg TODO'),
    tc(12, 1000, 900, 400, 100, limits),
    tc(12, 1000, 900, 400, 100, limits), // 重複的事件
    call(13, 'Set-Content x.txt hi'),
    tc(14, 3000, 1800, 1000, 200),
  ];
  writeJsonl(path.join(codexDir, 'sessions', '2026', '10', '01', 'rollout-a.jsonl'), common);
  // 分支出來的 session：複製父 session 的事件（時間與累計值相同，只算一次），之後再多一次呼叫
  writeJsonl(path.join(codexDir, 'sessions', '2026', '10', '01', 'rollout-b.jsonl'), [
    meta('codex-B', 15), ...common.slice(1), tc(16, 3500, 450, 0, 50),
  ]);
}

// 固定的測試價格（寫進 config 的 priceOverrides），不受 prices.json 日後更新影響
const TEST_PRICES = {
  claude: {
    'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, fast: 2 },
    'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, long: { threshold: 100000, input: 0.5, output: 2.5, cacheRead: 0.05 } },
    'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  },
  codex: {
    'gpt-5.5': { input: 5, output: 30, cacheRead: 0.5 },
  },
};

const EXPECTED = {
  claude: { calls: 6, input: 150160, output: 660, cacheWrite: 3000, cacheRead: 8000 },
  // 單筆花費（美元）
  claudeCost: { m1: 0.00784, m2: 0.00708, m3: 0.07525, m4: 0.00056, m5: 0.0048, m6: 0.016 },
  codex: { calls: 3, input: 1750, output: 350, cacheRead: 1400, cost: 0.01995 },
};

// ---------- 伺服器 ----------
async function startServer(opts = {}) {
  const home = opts.home || tmpDir('tu-home-');
  const port = await freePort();
  const config = {
    port, windowsToast: false, remotePrices: false,
    projectsDir: opts.projectsDir, codexDir: opts.codexDir,
    priceOverrides: TEST_PRICES,
    thresholds: { dailyCost: 0, dailyTokens: 0, window5hTokens: 0, sessionCost: 0, contextTokens: 0 },
    ...(opts.config || {}),
  };
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
  const env = { ...process.env, TOKEN_USAGE_HOME: home };
  const proc = spawn(process.execPath, [path.join(PLUGIN, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', d => { log += d; });
  proc.stderr.on('data', d => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (await request('GET', `${base}/api/ping`).then(r => r.status === 200, () => false)) break;
    await new Promise(r => setTimeout(r, 100));
  }
  return {
    home, port, base, env, proc, log: () => log,
    get: p => request('GET', base + p).then(r => r.json),
    post: (p, body, headers) => request('POST', base + p, body, headers),
    async stop() { proc.kill(); await new Promise(r => setTimeout(r, 200)); },
  };
}

function request(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers, timeout: 15000 }, res => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', d => { b += d; });
      res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch { /* 非 JSON */ } resolve({ status: res.statusCode, body: b, json }); });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end(body == null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)));
  });
}

// 依欄位名稱取值，避免測試綁死欄位順序
function rowsOf(data) {
  const f = Object.fromEntries(data.fields.map((n, i) => [n, i]));
  return data.rows.map(r => ({
    ts: r[f.ts], session: data.sessions[r[f.session]].id, project: data.projects[r[f.project]], model: data.models[r[f.model]],
    input: r[f.input], output: r[f.output], cacheWrite: r[f.cacheWrite], cacheRead: r[f.cacheRead], cost: r[f.cost],
    scenario: data.scenarios[r[f.scenario]], sub: r[f.sub], device: data.devices[r[f.device]], app: data.apps[r[f.app]],
  }));
}

module.exports = { PLUGIN, tmpDir, rm, writeJsonl, freePort, writeClaudeFixture, writeCodexFixture, TEST_PRICES, EXPECTED, startServer, request, rowsOf, T0 };

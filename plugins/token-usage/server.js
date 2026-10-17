// Claude Token 用量儀表板 — 本機伺服器（無外部相依套件）
// 讀取 ~/.claude/projects/**/*.jsonl，彙整每次 API 呼叫的 token 用量，提供儀表板與門檻通知。
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { execFile } = require('child_process');

const PUBLIC = path.join(__dirname, 'public');
// 設定與通知狀態放在使用者目錄，plugin 更新時不會被覆蓋
const DATA_DIR = process.env.TOKEN_USAGE_HOME || path.join(os.homedir(), '.claude-token-usage');
fs.mkdirSync(DATA_DIR, { recursive: true });
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const ALERT_STATE_PATH = path.join(DATA_DIR, 'alerts-state.json');

const DEFAULT_CONFIG = {
  port: 8787,
  projectsDir: path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects'),
  refreshSeconds: 30,
  windowsToast: true,
  syncDir: '',            // 多裝置同步資料夾（例如 OneDrive 內的資料夾），空白代表不同步
  deviceName: '',         // 顯示用的裝置名稱，空白時用電腦名稱
  // 美元 / 百萬 token（估算值，可自行修改）。key 為模型名稱中包含的字串，依序比對。
  pricing: {
    opus: { input: 5, output: 25 },
    fable: { input: 5, output: 25 },
    sonnet: { input: 3, output: 15 },
    haiku: { input: 1, output: 5 },
    default: { input: 3, output: 15 },
  },
  cacheMultipliers: { write5m: 1.25, write1h: 2, read: 0.1 },
  thresholds: {
    dailyCost: 50,          // 今日估算花費（USD）
    dailyTokens: 50000000,  // 今日總 token（含快取讀取）
    window5hTokens: 20000000, // 近 5 小時滾動視窗總 token
    sessionCost: 20,        // 單一 session 估算花費（USD）
    contextTokens: 180000,  // 單次呼叫的上下文大小（輸入+快取）
  },
};

function loadConfig() {
  let user = {};
  try { user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { /* 首次執行 */ }
  const cfg = {
    ...DEFAULT_CONFIG, ...user,
    pricing: { ...DEFAULT_CONFIG.pricing, ...(user.pricing || {}) },
    cacheMultipliers: { ...DEFAULT_CONFIG.cacheMultipliers, ...(user.cacheMultipliers || {}) },
    thresholds: { ...DEFAULT_CONFIG.thresholds, ...(user.thresholds || {}) },
  };
  if (!fs.existsSync(CONFIG_PATH)) fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  return cfg;
}
let config = loadConfig();

// ---------- 情境分類 ----------
const SCENARIOS = ['讀取/搜尋', '編輯檔案', '執行指令', '網頁/瀏覽器', '子代理派工', '規劃/流程', 'MCP 工具', '文字回覆'];
function classifyTool(name) {
  if (/^(Read|Glob|Grep|LS|NotebookRead)$/.test(name)) return 0;
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) return 1;
  if (/^(Bash|PowerShell|Monitor|BashOutput|KillShell|TaskStop)$/.test(name)) return 2;
  if (/^(WebFetch|WebSearch)$/.test(name) || /Browser|chrome/i.test(name)) return 3;
  if (/^(Agent|Task|Workflow|SendMessage|ListAgents)$/.test(name) || /ccd_session/.test(name)) return 4;
  if (/^(TodoWrite|Skill|ToolSearch|AskUserQuestion|ExitPlanMode|EnterPlanMode)$/.test(name) || /ccd_turn/.test(name)) return 5;
  if (name.startsWith('mcp__')) return 6;
  return 6;
}

// ---------- 解析 ----------
const fileCache = new Map(); // path -> { mtimeMs, size, calls, titles }

function listJsonl(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listJsonl(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function promptText(msg) {
  const c = msg && msg.content;
  let text = '';
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    if (c.some(b => b.type === 'tool_result')) return null;
    text = c.filter(b => b.type === 'text').map(b => b.text).join('\n');
  }
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<[a-z-]+>[\s\S]*?<\/[a-z-]+>/g, m => (/^<(command-name|command-message)/.test(m) ? m.replace(/<[^>]+>/g, '') : ''))
    .trim();
  return text || null;
}

function parseFile(file) {
  const isSub = /[\\/]subagents[\\/]/.test(file);
  const calls = new Map(); // messageId -> call
  const titles = {};
  let lastPrompt = '';
  const raw = fs.readFileSync(file, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'custom-title' && o.sessionId) titles[o.sessionId] = o.customTitle;
    else if (o.type === 'user' && !o.isMeta) {
      const t = promptText(o.message);
      if (t) lastPrompt = t.slice(0, 160);
    } else if (o.type === 'assistant' && o.message && o.message.usage) {
      const m = o.message;
      const key = (m.id || o.uuid) + '|' + (o.requestId || '');
      let c = calls.get(key);
      if (!c) {
        const u = m.usage;
        const cc = u.cache_creation || {};
        const cw = u.cache_creation_input_tokens || 0;
        const cw1h = cc.ephemeral_1h_input_tokens || 0;
        c = {
          key,
          ts: Date.parse(o.timestamp) || 0,
          session: o.sessionId || path.basename(file, '.jsonl'),
          cwd: o.cwd || '',
          model: m.model || 'unknown',
          input: u.input_tokens || 0,
          output: u.output_tokens || 0,
          cacheWrite: cw,
          cacheWrite1h: cw1h,
          cacheRead: u.cache_read_input_tokens || 0,
          thinking: (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0,
          tools: [],
          sub: isSub || !!o.isSidechain,
          prompt: lastPrompt,
        };
        calls.set(key, c);
      }
      for (const b of m.content || []) if (b.type === 'tool_use') c.tools.push(b.name);
    }
  }
  return { calls: [...calls.values()].filter(c => c.model !== '<synthetic>'), titles };
}

function priceFor(model) {
  for (const [k, v] of Object.entries(config.pricing)) if (k !== 'default' && model.includes(k)) return v;
  return config.pricing.default;
}
function costOf(c) {
  const p = priceFor(c.model), m = config.cacheMultipliers;
  const cw5 = c.cacheWrite - c.cacheWrite1h;
  return (c.input * p.input + c.output * p.output + cw5 * p.input * m.write5m +
    c.cacheWrite1h * p.input * m.write1h + c.cacheRead * p.input * m.read) / 1e6;
}

// ---------- 裝置與同步 ----------
// 每台裝置把自己的呼叫紀錄寫成一個檔案（本機 history.json；啟用同步時寫到 <syncDir>/devices/<id>.json），
// 讀取時合併所有裝置的檔案。每台只寫自己的檔案，所以 OneDrive 不會產生衝突；
// 檔案保留歷史，Claude Code 清掉舊對話紀錄後用量也不會消失。
const DEVICE_ID_PATH = path.join(DATA_DIR, 'device-id');
let deviceId = '';
try { deviceId = fs.readFileSync(DEVICE_ID_PATH, 'utf8').trim(); } catch { /* 首次執行 */ }
if (!deviceId) {
  deviceId = `${os.hostname()}-${Math.random().toString(36).slice(2, 8)}`.replace(/[^\w.-]/g, '_');
  fs.writeFileSync(DEVICE_ID_PATH, deviceId);
}
const FILE_VERSION = 1;
const deviceName = () => config.deviceName || os.hostname();

function detectOneDrive() {
  const base = process.env.OneDriveCommercial || process.env.OneDrive || process.env.OneDriveConsumer;
  return base ? path.join(base, 'ClaudeTokenUsage') : '';
}
function ownArchivePath() {
  return config.syncDir ? path.join(config.syncDir, 'devices', `${deviceId}.json`) : path.join(DATA_DIR, 'history.json');
}
const indexer = () => { const m = new Map(), arr = []; return { arr, get(k) { if (!m.has(k)) { m.set(k, arr.length); arr.push(k); } return m.get(k); } }; };

function encodeDevice(calls, titles) {
  const sessions = indexer(), cwds = indexer(), models = indexer(), prompts = indexer();
  const rows = calls.map(c => [c.key, c.ts, sessions.get(c.session), cwds.get(c.cwd), models.get(c.model),
    c.input, c.output, c.cacheWrite, c.cacheWrite1h, c.cacheRead, c.thinking, c.tools.join(','), c.sub ? 1 : 0, prompts.get(c.prompt || '')]);
  const t = {};
  for (const s of sessions.arr) if (titles[s]) t[s] = titles[s];
  return { version: FILE_VERSION, device: { id: deviceId, name: deviceName() }, updatedAt: Date.now(),
    sessions: sessions.arr, titles: t, cwds: cwds.arr, models: models.arr, prompts: prompts.arr, rows };
}
function decodeDevice(d) {
  const calls = d.rows.map(r => ({
    key: r[0], ts: r[1], session: d.sessions[r[2]], cwd: d.cwds[r[3]], model: d.models[r[4]],
    input: r[5], output: r[6], cacheWrite: r[7], cacheWrite1h: r[8], cacheRead: r[9], thinking: r[10],
    tools: r[11] ? r[11].split(',') : [], sub: !!r[12], prompt: d.prompts[r[13]],
  }));
  return { device: d.device, updatedAt: d.updatedAt, calls, titles: d.titles || {} };
}
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function writeJsonAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, p);
}

let archive = null;          // 本機裝置的歷史：Map(key -> call)
let archiveTitles = {};
let archivePathLoaded = '';
let archiveDirty = false, lastArchiveWrite = 0;
let syncError = '';
function loadArchive() {
  const p = ownArchivePath();
  if (archive && archivePathLoaded === p) return;
  archive = archive || new Map();
  // 第一次載入或切換同步資料夾時，合併兩個位置的歷史
  for (const src of new Set([p, path.join(DATA_DIR, 'history.json')])) {
    const d = readJson(src);
    if (d && d.version === FILE_VERSION) {
      const dec = decodeDevice(d);
      for (const c of dec.calls) if (!archive.has(c.key)) archive.set(c.key, c);
      Object.assign(archiveTitles, dec.titles);
    }
  }
  archivePathLoaded = p; archiveDirty = true; lastArchiveWrite = 0;
}
function flushArchive() {
  if (!archiveDirty || Date.now() - lastArchiveWrite < 60e3) return;
  const calls = [...archive.values()].sort((a, b) => a.ts - b.ts);
  try {
    writeJsonAtomic(ownArchivePath(), encodeDevice(calls, archiveTitles));
    archiveDirty = false; lastArchiveWrite = Date.now(); syncError = '';
  } catch (e) { syncError = `寫入同步檔失敗：${e.message}`; console.error(syncError); }
}

const remoteCache = new Map(); // path -> { mtimeMs, dev }
function readRemoteDevices() {
  let changed = false;
  const seen = new Set();
  if (config.syncDir) {
    const dir = path.join(config.syncDir, 'devices');
    let names = [];
    try { names = fs.readdirSync(dir).filter(n => n.endsWith('.json') && n !== `${deviceId}.json`); } catch { /* 資料夾還不存在 */ }
    for (const n of names) {
      const p = path.join(dir, n);
      seen.add(p);
      let st; try { st = fs.statSync(p); } catch { continue; }
      const c = remoteCache.get(p);
      if (c && c.mtimeMs === st.mtimeMs) continue;
      const d = readJson(p);
      if (!d || d.version !== FILE_VERSION) continue; // 可能還在同步中，下次再讀
      remoteCache.set(p, { mtimeMs: st.mtimeMs, dev: decodeDevice(d) });
      changed = true;
    }
  }
  for (const p of [...remoteCache.keys()]) if (!seen.has(p)) { remoteCache.delete(p); changed = true; }
  return { list: [...remoteCache.values()].map(v => v.dev), changed };
}

let dataset = null, datasetStamp = '';
function buildDataset() {
  loadArchive();
  const files = listJsonl(config.projectsDir);
  let changed = !dataset;
  const seen = new Set(files);
  for (const f of files) {
    let st;
    try { st = fs.statSync(f); } catch { continue; }
    const cached = fileCache.get(f);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) continue;
    try {
      const parsed = parseFile(f);
      fileCache.set(f, { mtimeMs: st.mtimeMs, size: st.size });
      for (const c of parsed.calls) archive.set(c.key, c);
      Object.assign(archiveTitles, parsed.titles);
      changed = true; archiveDirty = true;
    } catch (e) { console.error('解析失敗', f, e.message); }
  }
  // 本機紀錄被 Claude Code 清掉時只移除快取，歷史仍保留在 archive
  for (const f of [...fileCache.keys()]) if (!seen.has(f)) fileCache.delete(f);
  flushArchive();
  const remote = readRemoteDevices();
  if (!changed && !remote.changed && dataset) return dataset;

  const devices = [{ device: { id: deviceId, name: deviceName() }, updatedAt: Date.now(), calls: [...archive.values()], titles: archiveTitles, local: true },
    ...remote.list];
  const titles = {};
  const all = [];
  devices.forEach((d, di) => { Object.assign(titles, d.titles); for (const c of d.calls) all.push([c, di]); });
  all.sort((a, b) => a[0].ts - b[0].ts);

  const sessions = indexer(), projects = indexer(), models = indexer(), prompts = indexer();
  const sessionInfo = {};
  const firstCwd = {};
  for (const [c] of all) if (c.cwd && !firstCwd[c.session]) firstCwd[c.session] = c.cwd;
  const rows = all.map(([c, di]) => {
    const si = sessions.get(c.session);
    const cwd0 = firstCwd[c.session] || '';
    const pi = projects.get(cwd0 ? path.basename(cwd0) || cwd0 : '(未知)');
    if (!sessionInfo[si]) sessionInfo[si] = { id: c.session, title: titles[c.session] || '', project: pi, cwd: cwd0, device: di };
    const scen = c.tools.length ? classifyTool(c.tools[0]) : 7;
    return [c.ts, si, pi, models.get(c.model), c.input, c.output, c.cacheWrite, c.cacheRead,
      +costOf(c).toFixed(6), scen, c.sub ? 1 : 0, prompts.get(c.prompt || ''), c.thinking, c.tools.join(','), di];
  });
  dataset = {
    generatedAt: Date.now(),
    scenarios: SCENARIOS,
    devices: devices.map(d => ({ id: d.device.id, name: d.device.name, updatedAt: d.updatedAt, local: !!d.local, calls: d.calls.length })),
    sessions: sessions.arr.map((id, i) => sessionInfo[i]),
    projects: projects.arr, models: models.arr, prompts: prompts.arr,
    fields: ['ts', 'session', 'project', 'model', 'input', 'output', 'cacheWrite', 'cacheRead', 'cost', 'scenario', 'sub', 'prompt', 'thinking', 'tools', 'device'],
    rows,
  };
  datasetStamp = String(dataset.generatedAt);
  return dataset;
}

// ---------- 門檻通知 ----------
let alertState = {};
try { alertState = JSON.parse(fs.readFileSync(ALERT_STATE_PATH, 'utf8')); } catch { alertState = {}; }
const alertLog = []; // 最近的通知

function localDay(ts) { const d = new Date(ts); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; }
const fmtTok = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n);

function checkAlerts(ds) {
  const t = config.thresholds, now = Date.now(), today = localDay(now);
  let dayTok = 0, dayCost = 0, winTok = 0;
  const sessCost = {}, sessCtx = {};
  for (const r of ds.rows) {
    const tok = r[4] + r[5] + r[6] + r[7];
    if (localDay(r[0]) === today) { dayTok += tok; dayCost += r[8]; }
    if (now - r[0] <= 5 * 3600e3) winTok += tok;
    sessCost[r[1]] = (sessCost[r[1]] || 0) + r[8];
    if (now - r[0] <= 24 * 3600e3 && !r[10]) sessCtx[r[1]] = r[4] + r[6] + r[7];
  }
  const fire = (key, title, body) => {
    if (alertState[key]) return;
    alertState[key] = now;
    const a = { key, title, body, ts: now };
    alertLog.unshift(a); alertLog.length = Math.min(alertLog.length, 100);
    console.log(`[通知] ${title} — ${body}`);
    if (config.windowsToast && process.platform === 'win32') toast(title, body);
  };
  if (t.dailyCost && dayCost >= t.dailyCost) fire(`dailyCost|${today}`, '今日花費超過門檻', `今日估算 $${dayCost.toFixed(2)}（門檻 $${t.dailyCost}）`);
  if (t.dailyTokens && dayTok >= t.dailyTokens) fire(`dailyTokens|${today}`, '今日 token 超過門檻', `今日 ${fmtTok(dayTok)} tokens（門檻 ${fmtTok(t.dailyTokens)}）`);
  if (t.window5hTokens && winTok >= t.window5hTokens) fire(`win5h|${Math.floor(now / (5 * 3600e3))}`, '5 小時視窗用量偏高', `近 5 小時 ${fmtTok(winTok)} tokens（門檻 ${fmtTok(t.window5hTokens)}）`);
  for (const [si, c] of Object.entries(sessCost)) {
    if (!(si in sessCtx)) continue; // 只檢查 24 小時內仍活躍的 session
    const s = ds.sessions[si];
    if (t.sessionCost && c >= t.sessionCost) fire(`sessCost|${s.id}`, 'Session 花費超過門檻', `${s.title || s.id.slice(0, 8)}：$${c.toFixed(2)}`);
  }
  for (const [si, ctx] of Object.entries(sessCtx)) {
    const s = ds.sessions[si];
    if (t.contextTokens && ctx >= t.contextTokens) fire(`ctx|${s.id}`, '上下文接近上限', `${s.title || s.id.slice(0, 8)}：目前上下文 ${fmtTok(ctx)} tokens`);
  }
  // 清掉 3 天前的記錄
  for (const [k, v] of Object.entries(alertState)) if (now - v > 3 * 86400e3) delete alertState[k];
  try { fs.writeFileSync(ALERT_STATE_PATH, JSON.stringify(alertState)); } catch { /* ignore */ }
}

function toast(title, body) {
  const esc = s => String(s).replace(/'/g, "''");
  const ps = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$t = $x.GetElementsByTagName('text')
$t.Item(0).AppendChild($x.CreateTextNode('${esc(title)}')) > $null
$t.Item(1).AppendChild($x.CreateTextNode('${esc(body)}')) > $null
$n = [Windows.UI.Notifications.ToastNotification]::new($x)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($n)`;
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true }, err => {
    if (err) console.error('Windows 通知失敗：', err.message);
  });
}

function refresh() {
  try { checkAlerts(buildDataset()); } catch (e) { console.error(e); }
}

// ---------- HTTP ----------
const configView = () => ({ ...config, deviceId, deviceNameResolved: deviceName(), detectedOneDrive: detectOneDrive(), syncError });
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/data') {
    refresh();
    if (req.headers['if-none-match'] === datasetStamp) { res.writeHead(304); return res.end(); }
    res.setHeader('ETag', datasetStamp);
    return send(res, 200, dataset);
  }
  if (url.pathname === '/api/ping') return send(res, 200, { app: 'claude-token-usage', pid: process.pid });
  if (url.pathname === '/api/alerts') return send(res, 200, { alerts: alertLog });
  if (url.pathname === '/api/config' && req.method === 'GET') return send(res, 200, configView());
  if (url.pathname === '/api/config' && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try {
        const patch = JSON.parse(body);
        const next = { ...config };
        if (patch.thresholds) next.thresholds = { ...config.thresholds, ...patch.thresholds };
        if (patch.pricing) next.pricing = patch.pricing;
        if (typeof patch.windowsToast === 'boolean') next.windowsToast = patch.windowsToast;
        if (typeof patch.deviceName === 'string') next.deviceName = patch.deviceName.trim().slice(0, 60);
        if (typeof patch.syncDir === 'string') {
          const dir = patch.syncDir.trim();
          if (dir && !path.isAbsolute(dir)) throw new Error('同步資料夾必須是完整路徑');
          if (dir) fs.mkdirSync(path.join(dir, 'devices'), { recursive: true });
          next.syncDir = dir;
        }
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
        config = next;
        dataset = null; fileCache.clear(); // 價格可能變了，重新計算
        refresh();
        send(res, 200, configView());
      } catch (e) { send(res, 400, { error: e.message }); }
    });
    return;
  }
  if (url.pathname === '/api/test-toast') { toast('Claude Token 儀表板', '這是一則測試通知'); return send(res, 200, { ok: true }); }

  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'forbidden', 'text/plain');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'not found', 'text/plain');
    send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream');
  });
});

refresh();
setInterval(refresh, config.refreshSeconds * 1000);
server.on('error', e => {
  console.error(e.code === 'EADDRINUSE' ? `連接埠 ${config.port} 已被占用，請在 ${CONFIG_PATH} 修改 port` : e.message);
  process.exit(1);
});
server.listen(config.port, '127.0.0.1', () => {
  console.log(`Claude Token 儀表板：http://localhost:${config.port}`);
  console.log(`設定檔：${CONFIG_PATH}`);
  console.log(`資料來源：${config.projectsDir}（${dataset ? dataset.rows.length : 0} 次 API 呼叫）`);
});

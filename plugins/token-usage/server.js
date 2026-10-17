// AI Token 用量儀表板 — 本機伺服器（無外部相依套件）
// 讀取 Claude Code（~/.claude/projects）與 OpenAI Codex（~/.codex/sessions）的對話紀錄，彙整每次 API 呼叫的 token 用量，提供儀表板與門檻通知。
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { execFile } = require('child_process');
const https = require('https');
const { REMOTE_URL, loadBundled, validatePriceFile, effectivePrices, matchModel } = require('./pricing');

const PUBLIC = path.join(__dirname, 'public');
// 設定與通知狀態放在使用者目錄，plugin 更新時不會被覆蓋
const DATA_DIR = process.env.TOKEN_USAGE_HOME || path.join(os.homedir(), '.claude-token-usage');
fs.mkdirSync(DATA_DIR, { recursive: true });
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const ALERT_STATE_PATH = path.join(DATA_DIR, 'alerts-state.json');

const DEFAULT_CONFIG = {
  port: 8787,
  projectsDir: path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects'),
  codexDir: process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), // OpenAI Codex 的資料夾（讀 sessions 與 archived_sessions）
  refreshSeconds: 30,
  windowsToast: true,
  syncDir: '',            // 多裝置同步資料夾（例如 OneDrive 內的資料夾），空白代表不同步
  deviceName: '',         // 顯示用的裝置名稱，空白時用電腦名稱
  // 各模型價格的預設值在 pricing.js；這裡只存使用者自訂的價格：{ claude: { 模型: {...} }, codex: {...} }
  priceOverrides: {},
  remotePrices: true,     // 每天從 GitHub 下載最新的價格表（只下載檔案，不會傳送任何資料）
  remotePricesUrl: REMOTE_URL,
  cacheMultipliers: { write5m: 1.25, write1h: 2 }, // 模型沒有指定快取寫入價格時，以輸入價格乘上這個倍率
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
    priceOverrides: user.priceOverrides || {},
    pricing: undefined, // 舊版的關鍵字價格設定，已改用 pricing.js
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
  // Codex 工具名稱（shell 指令依內容加上 :read / :write）
  if (/:read$/.test(name)) return 0;
  if (/:write$/.test(name)) return 1;
  if (/^(read_file|list_dir|grep_files|view_image)$/.test(name)) return 0;
  if (/^apply_patch$/.test(name)) return 1;
  if (/^(shell|shell_command|local_shell|exec_command|unified_exec|write_stdin)$/.test(name)) return 2;
  if (/^(web_search|web_search_call)$/.test(name)) return 3;
  if (/^(spawn_agent|send_input|wait|close_agent)$/.test(name)) return 4;
  if (/^(update_plan|request_user_input)$/.test(name)) return 5;
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
          fast: u.speed === 'fast',
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

// Codex：每個 token_count 事件的 last_token_usage 就是一次 API 呼叫。
// OpenAI 的 input_tokens 已包含 cached_input_tokens，output_tokens 已包含 reasoning_output_tokens。
// Codex 在 Windows 上幾乎所有動作都透過 shell_command，所以依指令內容細分讀取 / 寫入。
const SHELL_TOOLS = /^(shell|shell_command|local_shell|exec_command|unified_exec)$/;
const READ_CMD = /^(rg|grep|findstr|Get-Content|gc|cat|type|Select-String|sls|Get-ChildItem|gci|ls|dir|Get-Item|Test-Path|head|tail|sed\s+-n|wc|Format-Hex|git\s+(log|show|diff|status|blame))\b/i;
const WRITE_CMD = /^(Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|mkdir|rm|mv|cp|tee)\b/i;
function codexToolName(p) {
  const name = p.name || p.type;
  if (!SHELL_TOOLS.test(name)) return name;
  let cmd = '';
  try { const a = JSON.parse(p.arguments || '{}'); cmd = Array.isArray(a.command) ? a.command.join(' ') : String(a.command || a.cmd || ''); } catch { return name; }
  cmd = cmd.replace(/^(powershell(\.exe)?|pwsh|bash|cmd(\.exe)?)\s+((-|\/)\w+\s+)*/i, '').replace(/^["']/, '').trim();
  return READ_CMD.test(cmd) ? name + ':read' : WRITE_CMD.test(cmd) ? name + ':write' : name;
}

function parseCodexFile(file) {
  const calls = [];
  let session = path.basename(file, '.jsonl'), cwd = '', model = 'unknown', prompt = '', lastTotal = -1, tools = [], limits = null;
  const raw = fs.readFileSync(file, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const p = o.payload || {};
    if (o.type === 'session_meta') { session = p.id || session; cwd = p.cwd || cwd; }
    else if (o.type === 'turn_context') { model = p.model || model; cwd = p.cwd || cwd; }
    else if (o.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call' || p.type === 'web_search_call')) {
      tools.push(codexToolName(p));
    } else if (o.type === 'event_msg' && p.type === 'user_message') {
      const t = String(p.message || '').trim();
      if (t) prompt = t.slice(0, 160);
    } else if (o.type === 'event_msg' && p.type === 'token_count') {
      if (p.rate_limits && p.rate_limits.primary) limits = { ts: Date.parse(o.timestamp) || 0, primary: p.rate_limits.primary, secondary: p.rate_limits.secondary, plan: p.rate_limits.plan_type };
      const info = p.info;
      if (!info || !info.last_token_usage) continue;
      const total = info.total_token_usage ? info.total_token_usage.total_tokens : -1;
      if (total === lastTotal) continue; // 重複的事件
      lastTotal = total;
      const u = info.last_token_usage;
      const cached = u.cached_input_tokens || 0;
      calls.push({
        key: `codex|${session}|${total}`, app: 'codex',
        ts: Date.parse(o.timestamp) || 0, session, cwd, model,
        input: Math.max(0, (u.input_tokens || 0) - cached), output: u.output_tokens || 0,
        cacheWrite: 0, cacheWrite1h: 0, cacheRead: cached, thinking: u.reasoning_output_tokens || 0,
        tools, sub: false, prompt,
      });
      tools = [];
    }
  }
  return { calls, titles: {}, limits };
}

// ---------- 價格 ----------
// 每個工具有自己的價格表，模型只在所屬工具的表裡比對。
// 基準價格表：plugin 內建的 prices.json，或從 GitHub 下載、日期較新的版本。
const REMOTE_CACHE_PATH = path.join(DATA_DIR, 'prices-remote.json');
const REMOTE_STATE_PATH = path.join(DATA_DIR, 'prices-remote-state.json');
let priceBase = loadBundled();
let priceBaseSource = 'bundled';
let remoteState = { lastCheck: 0, error: '' };
try { remoteState = { ...remoteState, ...JSON.parse(fs.readFileSync(REMOTE_STATE_PATH, 'utf8')) }; } catch { /* 首次執行 */ }
try {
  const cached = JSON.parse(fs.readFileSync(REMOTE_CACHE_PATH, 'utf8'));
  if (!validatePriceFile(cached) && cached.updated >= priceBase.updated) { priceBase = cached; priceBaseSource = 'remote'; }
} catch { /* 沒有快取 */ }
let prices = effectivePrices(priceBase, config.priceOverrides);
function refreshPrices() {
  prices = effectivePrices(priceBase, config.priceOverrides);
  priceMatchCache.clear();
  dataset = null; // 重新計算花費
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http; // http 只允許本機（測試用）
    const req = mod.get(url, { timeout: 10000, headers: { 'User-Agent': 'token-usage-dashboard' } }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => { body += d; if (body.length > 1e6) req.destroy(new Error('檔案過大')); });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('不是有效的 JSON')); } });
    });
    req.on('timeout', () => req.destroy(new Error('連線逾時')));
    req.on('error', reject);
  });
}
// 每 24 小時最多下載一次；force 時立即下載
async function checkRemotePrices(force) {
  if (!config.remotePrices || !/^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)[:/])/.test(config.remotePricesUrl || '')) return;
  if (!force && Date.now() - remoteState.lastCheck < 24 * 3600e3) return;
  remoteState.lastCheck = Date.now();
  try {
    const d = await fetchJson(config.remotePricesUrl);
    const err = validatePriceFile(d);
    if (err) throw new Error('價格檔格式錯誤：' + err);
    fs.writeFileSync(REMOTE_CACHE_PATH, JSON.stringify(d));
    remoteState.error = '';
    // 日期較新、或同一天但內容不同（維護者同一天更新了兩次）就改用下載的版本
    if (d.updated > priceBase.updated || (d.updated === priceBase.updated && JSON.stringify(d.models) !== JSON.stringify(priceBase.models))) {
      priceBase = d; priceBaseSource = 'remote';
      refreshPrices();
      console.log(`已更新價格表（${d.updated}）`);
    }
  } catch (e) {
    remoteState.error = e.message;
    console.error('下載價格表失敗：', e.message);
  }
  try { fs.writeFileSync(REMOTE_STATE_PATH, JSON.stringify(remoteState)); } catch { /* ignore */ }
}
const priceMatchCache = new Map(); // `${app}|${model}` -> 價格表 key 或 null
function priceKeyFor(app, model) {
  const k = `${app}|${model}`;
  if (!priceMatchCache.has(k)) priceMatchCache.set(k, matchModel(prices[app] || {}, model));
  return priceMatchCache.get(k);
}
// 回傳 null 代表這個模型沒有價格（不計入花費，在「價格設定」提示）
function costOf(c) {
  const app = c.app || 'claude';
  const key = priceKeyFor(app, c.model);
  if (!key) return null;
  let p = prices[app][key];
  const m = config.cacheMultipliers;
  const promptTokens = c.input + c.cacheWrite + c.cacheRead;
  const base = p;
  if (p.long && promptTokens > p.long.threshold) p = { ...p, ...p.long };
  const cw5Price = p.cacheWrite5m != null && p === base ? p.cacheWrite5m : p.input * m.write5m;
  const cw1hPrice = p.cacheWrite1h != null && p === base ? p.cacheWrite1h : p.input * m.write1h;
  const cw5 = c.cacheWrite - c.cacheWrite1h;
  const cost = (c.input * p.input + c.output * p.output + c.cacheRead * (p.cacheRead ?? p.input) +
    cw5 * cw5Price + c.cacheWrite1h * cw1hPrice) / 1e6;
  return c.fast && p.fast ? cost * p.fast : cost;
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
const APPS = ['claude', 'codex'];
const APP_LABELS = ['Claude Code', 'Codex'];
let codexLimits = null;
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
    c.input, c.output, c.cacheWrite, c.cacheWrite1h, c.cacheRead, c.thinking, c.tools.join(','), c.sub ? 1 : 0, prompts.get(c.prompt || ''), APPS.indexOf(c.app || 'claude'), c.fast ? 1 : 0]);
  const t = {};
  for (const s of sessions.arr) if (titles[s]) t[s] = titles[s];
  return { version: FILE_VERSION, device: { id: deviceId, name: deviceName() }, updatedAt: Date.now(),
    sessions: sessions.arr, titles: t, cwds: cwds.arr, models: models.arr, prompts: prompts.arr, rows };
}
function decodeDevice(d) {
  const calls = d.rows.map(r => ({
    key: r[0], ts: r[1], session: d.sessions[r[2]], cwd: d.cwds[r[3]], model: d.models[r[4]],
    input: r[5], output: r[6], cacheWrite: r[7], cacheWrite1h: r[8], cacheRead: r[9], thinking: r[10],
    tools: r[11] ? r[11].split(',') : [], sub: !!r[12], prompt: d.prompts[r[13]], app: APPS[r[14] || 0], fast: !!r[15],
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
  const codexFiles = config.codexDir ? [...listJsonl(path.join(config.codexDir, 'sessions')), ...listJsonl(path.join(config.codexDir, 'archived_sessions'))] : [];
  const codexSet = new Set(codexFiles);
  const files = [...listJsonl(config.projectsDir), ...codexFiles];
  let changed = !dataset;
  const seen = new Set(files);
  for (const f of files) {
    let st;
    try { st = fs.statSync(f); } catch { continue; }
    const cached = fileCache.get(f);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) continue;
    try {
      const parsed = codexSet.has(f) ? parseCodexFile(f) : parseFile(f);
      fileCache.set(f, { mtimeMs: st.mtimeMs, size: st.size, limits: parsed.limits });
      for (const c of parsed.calls) archive.set(c.key, c);
      Object.assign(archiveTitles, parsed.titles);
      changed = true; archiveDirty = true;
    } catch (e) { console.error('解析失敗', f, e.message); }
  }
  // 本機紀錄被 Claude Code 清掉時只移除快取，歷史仍保留在 archive
  for (const f of [...fileCache.keys()]) if (!seen.has(f)) fileCache.delete(f);
  codexLimits = null;
  for (const v of fileCache.values()) if (v.limits && (!codexLimits || v.limits.ts > codexLimits.ts)) codexLimits = v.limits;
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
  const modelInfo = {}; // `${app}|${model}` -> { app, model, calls, priceKey, exact }
  const rows = all.map(([c, di]) => {
    const si = sessions.get(c.session);
    const cwd0 = firstCwd[c.session] || '';
    const pi = projects.get(cwd0 ? path.basename(cwd0) || cwd0 : '(未知)');
    if (!sessionInfo[si]) sessionInfo[si] = { id: c.session, title: titles[c.session] || '', project: pi, cwd: cwd0, device: di };
    const scen = c.tools.length ? classifyTool(c.tools[0]) : 7;
    const app = c.app || 'claude';
    const mk = `${app}|${c.model}`;
    const mi = modelInfo[mk] || (modelInfo[mk] = { app, model: c.model, calls: 0, priceKey: priceKeyFor(app, c.model) });
    mi.calls++;
    const cost = costOf(c);
    return [c.ts, si, pi, models.get(c.model), c.input, c.output, c.cacheWrite, c.cacheRead,
      cost == null ? 0 : +cost.toFixed(6), scen, c.sub ? 1 : 0, prompts.get(c.prompt || ''), c.thinking, c.tools.join(','), di, Math.max(0, APPS.indexOf(c.app || 'claude'))];
  });
  dataset = {
    generatedAt: Date.now(),
    scenarios: SCENARIOS,
    devices: devices.map(d => ({ id: d.device.id, name: d.device.name, updatedAt: d.updatedAt, local: !!d.local, calls: d.calls.length })),
    sessions: sessions.arr.map((id, i) => sessionInfo[i]),
    projects: projects.arr, models: models.arr, prompts: prompts.arr,
    fields: ['ts', 'session', 'project', 'model', 'input', 'output', 'cacheWrite', 'cacheRead', 'cost', 'scenario', 'sub', 'prompt', 'thinking', 'tools', 'device', 'app'],
    apps: APP_LABELS,
    limits: { codex: codexLimits },
    models_seen: Object.values(modelInfo),
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
const priceView = () => ({
  updated: priceBase.updated, baseSource: priceBaseSource, sources: priceBase.sources,
  defaults: priceBase.models, overrides: config.priceOverrides, effective: prices,
  remote: { enabled: !!config.remotePrices, url: config.remotePricesUrl, lastCheck: remoteState.lastCheck, error: remoteState.error },
  staleDays: Math.floor((Date.now() - Date.parse(priceBase.updated)) / 864e5),
});
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
  if (url.pathname === '/api/prices') return send(res, 200, priceView());
  if (url.pathname === '/api/prices/check' && req.method === 'POST') {
    checkRemotePrices(true).then(() => send(res, 200, priceView()));
    return;
  }
  // prices.js CLI 直接改了 config.json 之後呼叫這個，讓伺服器重新讀取
  if (url.pathname === '/api/reload' && req.method === 'POST') {
    config = loadConfig();
    refreshPrices();
    return send(res, 200, { ok: true });
  }
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
        if (patch.priceOverrides && typeof patch.priceOverrides === 'object') next.priceOverrides = patch.priceOverrides;
        if (typeof patch.windowsToast === 'boolean') next.windowsToast = patch.windowsToast;
        if (typeof patch.remotePrices === 'boolean') next.remotePrices = patch.remotePrices;
        if (typeof patch.deviceName === 'string') next.deviceName = patch.deviceName.trim().slice(0, 60);
        if (typeof patch.syncDir === 'string') {
          const dir = patch.syncDir.trim();
          if (dir && !path.isAbsolute(dir)) throw new Error('同步資料夾必須是完整路徑');
          if (dir) fs.mkdirSync(path.join(dir, 'devices'), { recursive: true });
          next.syncDir = dir;
        }
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
        config = next;
        refreshPrices();
        dataset = null; fileCache.clear(); // 價格可能變了，重新計算
        refresh();
        send(res, 200, configView());
      } catch (e) { send(res, 400, { error: e.message }); }
    });
    return;
  }
  if (url.pathname === '/api/test-toast') { toast('AI Token 用量儀表板', '這是一則測試通知'); return send(res, 200, { ok: true }); }

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
checkRemotePrices(false);
setInterval(() => checkRemotePrices(false), 6 * 3600e3);
server.on('error', e => {
  console.error(e.code === 'EADDRINUSE' ? `連接埠 ${config.port} 已被占用，請在 ${CONFIG_PATH} 修改 port` : e.message);
  process.exit(1);
});
server.listen(config.port, '127.0.0.1', () => {
  console.log(`AI Token 用量儀表板：http://localhost:${config.port}`);
  console.log(`設定檔：${CONFIG_PATH}`);
  console.log(`資料來源：${config.projectsDir}（${dataset ? dataset.rows.length : 0} 次 API 呼叫）`);
});

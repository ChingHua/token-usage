'use strict';
// ---------- 狀態 ----------
const S = {
  data: null, etag: null, config: null,
  range: '7d', metric: 'tokens', project: '', model: '', source: '',
  tab: 'overview', session: null, sessSort: { key: 'last', dir: -1 },
};
const R = { ts: 0, session: 1, project: 2, model: 3, input: 4, output: 5, cw: 6, cr: 7, cost: 8, scen: 9, sub: 10, prompt: 11, thinking: 12, tools: 13 };
const TYPES = [
  { key: 'input', idx: R.input, label: '輸入', slot: 1 },
  { key: 'output', idx: R.output, label: '輸出', slot: 2 },
  { key: 'cw', idx: R.cw, label: '快取寫入', slot: 3 },
  { key: 'cr', idx: R.cr, label: '快取讀取', slot: 4 },
];
const charts = {};
const $ = s => document.querySelector(s);
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const slot = i => css('--s' + i);
const tokOf = r => r[R.input] + r[R.output] + r[R.cw] + r[R.cr];
const val = r => S.metric === 'cost' ? r[R.cost] : tokOf(r);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtTok(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}
const fmtUSD = n => '$' + (n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(3));
const fmtVal = n => S.metric === 'cost' ? fmtUSD(n) : fmtTok(n);
const pad = n => String(n).padStart(2, '0');
const fmtTime = ts => { const d = new Date(ts); return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const startOfDay = ts => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };

// ---------- 篩選 ----------
function rangeStart() {
  const now = Date.now();
  return { today: startOfDay(now), '24h': now - 864e5, '7d': startOfDay(now) - 6 * 864e5, '30d': startOfDay(now) - 29 * 864e5, all: 0 }[S.range];
}
function dimFilter(r) {
  return (S.project === '' || r[R.project] === +S.project) &&
    (S.model === '' || r[R.model] === +S.model) &&
    (S.source === '' || r[R.sub] === +S.source);
}
function filtered() {
  const t0 = rangeStart();
  return S.data.rows.filter(r => r[R.ts] >= t0 && dimFilter(r));
}

// ---------- Chart.js 共用 ----------
function baseOpts(extra = {}) {
  const grid = css('--grid'), muted = css('--muted');
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: css('--text'), titleColor: css('--surface'), bodyColor: css('--surface'),
        padding: 8, boxPadding: 4, usePointStyle: true,
        callbacks: { label: c => ` ${c.dataset.label}: ${extra.fmt ? extra.fmt(c.parsed.y ?? c.parsed) : fmtVal(c.parsed.y ?? c.parsed)}` },
      },
    },
    scales: {
      x: { stacked: !!extra.stacked, grid: { display: false }, border: { color: css('--axis') }, ticks: { color: muted, maxRotation: 0, autoSkipPadding: 12 } },
      y: { stacked: !!extra.stacked, beginAtZero: true, grid: { color: grid }, border: { display: false }, ticks: { color: muted, callback: v => (extra.fmt || fmtVal)(v) } },
    },
  };
}
function draw(id, config) {
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(document.getElementById(id), config);
}
function barDs(label, data, color, last = true) {
  return { label, data, backgroundColor: color, borderColor: css('--surface'), borderWidth: { top: 0, bottom: 0, left: 0, right: 0 }, borderRadius: last ? { topLeft: 4, topRight: 4 } : 0, borderSkipped: false, maxBarThickness: 36, categoryPercentage: 0.85, barPercentage: 0.9 };
}
function legend(el, items) {
  $(el).innerHTML = items.map(([label, color]) => `<span><i style="background:${color}"></i>${esc(label)}</span>`).join('');
}
function doughnut(id, labels, values, colors, fmt = fmtVal) {
  draw(id, {
    type: 'doughnut',
    data: { labels, datasets: [{ data: values, backgroundColor: colors, borderColor: css('--surface'), borderWidth: 2, hoverOffset: 4 }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, cutout: '62%',
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: css('--text'), titleColor: css('--surface'), bodyColor: css('--surface'),
          callbacks: { label: c => { const t = values.reduce((a, b) => a + b, 0) || 1; return ` ${c.label}: ${fmt(c.parsed)}（${(c.parsed / t * 100).toFixed(1)}%）`; } },
        },
      },
    },
  });
}

// ---------- 時間分桶 ----------
function buckets(rows) {
  const hourly = S.range === 'today' || S.range === '24h';
  const size = hourly ? 36e5 : 864e5;
  const t0 = rows.length ? (hourly ? Math.floor(rangeStart() / 36e5) * 36e5 : startOfDay(S.range === 'all' ? rows[0][R.ts] : rangeStart())) : 0;
  const end = Date.now();
  const keys = [];
  if (hourly) for (let t = t0; t <= end; t += size) keys.push(t);
  else for (let t = t0; t <= end; t = startOfDay(t + 36e5 * 26)) keys.push(t);
  const keyOf = ts => hourly ? Math.floor(ts / 36e5) * 36e5 : startOfDay(ts);
  const pos = new Map(keys.map((k, i) => [k, i]));
  const label = k => { const d = new Date(k); return hourly ? `${pad(d.getHours())}:00` : `${d.getMonth() + 1}/${d.getDate()}`; };
  return { keys, labels: keys.map(label), index: ts => pos.get(keyOf(ts)), hourly };
}

// ---------- 總覽 ----------
function renderOverview(rows) {
  const th = S.config ? S.config.thresholds : {};
  const now = Date.now();
  const all = S.data.rows.filter(dimFilter);
  const today = all.filter(r => r[R.ts] >= startOfDay(now));
  const win = all.filter(r => now - r[R.ts] <= 5 * 36e5);
  const sum = (a, f) => a.reduce((s, r) => s + f(r), 0);
  const tot = sum(rows, tokOf), cost = sum(rows, r => r[R.cost]);
  const inputSide = sum(rows, r => r[R.input] + r[R.cw] + r[R.cr]);
  const hit = inputSide ? sum(rows, r => r[R.cr]) / inputSide : 0;
  const sessions = new Set(rows.map(r => r[R.session])).size;
  const todayTok = sum(today, tokOf), todayCost = sum(today, r => r[R.cost]), winTok = sum(win, tokOf);
  const kpi = (label, value, sub, ratio) => {
    const warn = ratio != null && ratio >= 1;
    const meter = ratio != null ? `<div class="meter"><i style="width:${Math.min(100, ratio * 100).toFixed(1)}%"></i></div>` : '';
    return `<div class="kpi${warn ? ' warn' : ''}"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div>${meter}</div>`;
  };
  $('#kpis').innerHTML = [
    kpi('區間總 token', fmtTok(tot), `${rows.length.toLocaleString()} 次呼叫・${sessions} 個 session`),
    kpi('區間估算花費', fmtUSD(cost), `平均每次 ${fmtUSD(rows.length ? cost / rows.length : 0)}`),
    kpi('今日 token', fmtTok(todayTok), th.dailyTokens ? `門檻 ${fmtTok(th.dailyTokens)}` : '未設門檻', th.dailyTokens ? todayTok / th.dailyTokens : null),
    kpi('今日花費', fmtUSD(todayCost), th.dailyCost ? `門檻 ${fmtUSD(th.dailyCost)}` : '未設門檻', th.dailyCost ? todayCost / th.dailyCost : null),
    kpi('近 5 小時 token', fmtTok(winTok), th.window5hTokens ? `門檻 ${fmtTok(th.window5hTokens)}` : '未設門檻', th.window5hTokens ? winTok / th.window5hTokens : null),
    kpi('快取命中率', (hit * 100).toFixed(1) + '%', '快取讀取 ÷ 全部輸入端 token'),
  ].join('');

  // 時間軸：依 token 類型堆疊
  const b = buckets(rows);
  $('#tlNote').textContent = b.hourly ? '每小時' : '每日';
  let sets;
  if (S.metric === 'cost') {
    const byModel = S.data.models.map(() => b.keys.map(() => 0));
    rows.forEach(r => { const i = b.index(r[R.ts]); if (i != null) byModel[r[R.model]][i] += r[R.cost]; });
    const used = S.data.models.map((m, i) => i).filter(i => byModel[i].some(v => v));
    sets = used.map((mi, k) => barDs(S.data.models[mi], byModel[mi], slot(k + 1), k === used.length - 1));
    legend('#tlLegend', used.map((mi, k) => [S.data.models[mi], slot(k + 1)]));
  } else {
    const arr = TYPES.map(() => b.keys.map(() => 0));
    rows.forEach(r => { const i = b.index(r[R.ts]); if (i != null) TYPES.forEach((t, k) => { arr[k][i] += r[t.idx]; }); });
    sets = TYPES.map((t, k) => barDs(t.label, arr[k], slot(t.slot), k === TYPES.length - 1));
    legend('#tlLegend', TYPES.map(t => [t.label, slot(t.slot)]));
  }
  draw('cTimeline', { type: 'bar', data: { labels: b.labels, datasets: sets }, options: baseOpts({ stacked: true }) });

  // Token 類型組成（token 數；花費模式下顯示各類型的花費比重）
  const typeVals = TYPES.map(t => sum(rows, r => r[t.idx]));
  legend('#typeLegend', TYPES.map((t, k) => [`${t.label} ${fmtTok(typeVals[k])}`, slot(t.slot)]));
  doughnut('cTypes', TYPES.map(t => t.label), typeVals, TYPES.map(t => slot(t.slot)), fmtTok);

  // 模型
  const mVals = S.data.models.map((m, i) => sum(rows.filter(r => r[R.model] === i), val));
  const mIdx = mVals.map((v, i) => i).filter(i => mVals[i] > 0).sort((a, b) => mVals[b] - mVals[a]);
  const mColor = i => slot((S.data.models.indexOf(S.data.models[i]) % 8) + 1);
  legend('#modelLegend', mIdx.map(i => [`${S.data.models[i]} ${fmtVal(mVals[i])}`, mColor(i)]));
  doughnut('cModels', mIdx.map(i => S.data.models[i]), mIdx.map(i => mVals[i]), mIdx.map(mColor));

  // 5 小時滾動視窗
  const step = 30 * 6e4, from = now - 48 * 36e5;
  const recent = all.filter(r => r[R.ts] >= from - 5 * 36e5);
  const pts = [], labels = [];
  let lo = 0, acc = 0, hi = 0;
  for (let t = Math.ceil(from / step) * step; t <= now + step; t += step) {
    while (hi < recent.length && recent[hi][R.ts] <= t) { acc += tokOf(recent[hi]); hi++; }
    while (lo < hi && recent[lo][R.ts] <= t - 5 * 36e5) { acc -= tokOf(recent[lo]); lo++; }
    pts.push(acc); labels.push(fmtTime(t));
  }
  const winSets = [{ label: '5 小時累積 token', data: pts, borderColor: slot(1), backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, tension: 0.2 }];
  if (th.window5hTokens) winSets.push({ label: '門檻', data: pts.map(() => th.window5hTokens), borderColor: css('--critical'), borderDash: [4, 4], borderWidth: 1.5, pointRadius: 0 });
  draw('cWindow', { type: 'line', data: { labels, datasets: winSets }, options: baseOpts({ fmt: fmtTok }) });

  renderHeatmap(rows);

  // 專案排行（前 7 + 其他）
  const pv = {};
  rows.forEach(r => { pv[r[R.project]] = (pv[r[R.project]] || 0) + val(r); });
  const ranked = Object.entries(pv).sort((a, b) => b[1] - a[1]);
  const top = ranked.slice(0, 7), rest = ranked.slice(7).reduce((s, x) => s + x[1], 0);
  const pl = top.map(([i]) => S.data.projects[i]), pd = top.map(x => x[1]);
  if (rest) { pl.push('其他'); pd.push(rest); }
  draw('cProjects', {
    type: 'bar',
    data: { labels: pl, datasets: [{ ...barDs(S.metric === 'cost' ? '花費' : 'Token', pd, slot(1)), borderRadius: { topRight: 4, bottomRight: 4 }, backgroundColor: pl.map(l => l === '其他' ? css('--other') : slot(1)) }] },
    options: { ...baseOpts(), indexAxis: 'y', interaction: { mode: 'nearest', axis: 'y', intersect: false },
      scales: { x: { ...baseOpts().scales.y }, y: { grid: { display: false }, ticks: { color: css('--text-2') } } } },
  });
}

function renderHeatmap(rows) {
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  rows.forEach(r => { const d = new Date(r[R.ts]); grid[d.getDay()][d.getHours()] += val(r); });
  const max = Math.max(1, ...grid.flat());
  const steps = ['--seq0', '--seq1', '--seq2', '--seq3', '--seq4', '--seq5'].map(css);
  const color = v => v <= 0 ? steps[0] : steps[Math.min(5, 1 + Math.floor(Math.sqrt(v / max) * 4.999))];
  const days = ['日', '一', '二', '三', '四', '五', '六'];
  let h = '<div></div>' + Array.from({ length: 24 }, (_, i) => `<div class="cl">${i % 3 === 0 ? i : ''}</div>`).join('');
  [1, 2, 3, 4, 5, 6, 0].forEach(d => {
    h += `<div class="rl">週${days[d]}</div>`;
    for (let hr = 0; hr < 24; hr++) h += `<div class="cell" style="background:${color(grid[d][hr])}" data-tip="週${days[d]} ${pad(hr)}:00 — ${fmtVal(grid[d][hr])}"></div>`;
  });
  $('#heatmap').innerHTML = h;
  $('#heatmap').insertAdjacentHTML('afterend', '');
  const scale = document.querySelector('#heatmap + .heat-scale') || (() => { const e = document.createElement('div'); e.className = 'heat-scale'; $('#heatmap').after(e); return e; })();
  scale.innerHTML = `少 ${steps.map(c => `<i style="background:${c}"></i>`).join('')} 多（最高 ${fmtVal(max)}）`;
}

// ---------- 情境分析 ----------
function renderScenario(rows) {
  const sc = S.data.scenarios;
  const sum = (a, f) => a.reduce((s, r) => s + f(r), 0);
  const by = sc.map((_, i) => rows.filter(r => r[R.scen] === i));
  legend('#scenLegend', TYPES.map(t => [t.label, slot(t.slot)]));
  if (S.metric === 'cost') {
    legend('#scenLegend', [['估算花費', slot(1)]]);
    draw('cScen', { type: 'bar', data: { labels: sc, datasets: [{ ...barDs('花費', by.map(a => sum(a, r => r[R.cost])), slot(1)), borderRadius: { topRight: 4, bottomRight: 4 } }] },
      options: { ...baseOpts(), indexAxis: 'y', scales: { x: baseOpts().scales.y, y: { grid: { display: false }, ticks: { color: css('--text-2') } } } } });
  } else {
    const sets = TYPES.map((t, k) => ({ ...barDs(t.label, by.map(a => sum(a, r => r[t.idx])), slot(t.slot)), borderRadius: k === 3 ? { topRight: 4, bottomRight: 4 } : 0 }));
    const o = baseOpts({ stacked: true });
    draw('cScen', { type: 'bar', data: { labels: sc, datasets: sets },
      options: { ...o, indexAxis: 'y', interaction: { mode: 'index', axis: 'y', intersect: false },
        scales: { x: { ...o.scales.y, stacked: true }, y: { stacked: true, grid: { display: false }, ticks: { color: css('--text-2') } } } } });
  }
  const scColors = sc.map((_, i) => slot(i + 1));
  draw('cScenCount', { type: 'bar', data: { labels: sc, datasets: [{ ...barDs('呼叫次數', by.map(a => a.length), scColors) }] },
    options: baseOpts({ fmt: v => Math.round(v).toLocaleString() }) });
  draw('cScenAvg', { type: 'bar', data: { labels: sc, datasets: [{ ...barDs('平均每次', by.map(a => a.length ? sum(a, val) / a.length : 0), scColors) }] },
    options: baseOpts() });

  // 情境佔比隨時間
  const b = buckets(rows);
  const arr = sc.map(() => b.keys.map(() => 0));
  rows.forEach(r => { const i = b.index(r[R.ts]); if (i != null) arr[r[R.scen]][i] += val(r); });
  legend('#scenTimeLegend', sc.map((s, i) => [s, slot(i + 1)]));
  draw('cScenTime', { type: 'bar', data: { labels: b.labels, datasets: sc.map((s, i) => barDs(s, arr[i], slot(i + 1), i === sc.length - 1)) }, options: baseOpts({ stacked: true }) });

  // 工具排行：呼叫中每個工具平均分攤該次呼叫的用量
  const tools = {};
  rows.forEach(r => {
    const names = r[R.tools] ? r[R.tools].split(',') : ['（文字回覆）'];
    names.forEach(n => {
      const t = tools[n] || (tools[n] = { calls: 0, tok: 0, cost: 0 });
      t.calls++; t.tok += tokOf(r) / names.length; t.cost += r[R.cost] / names.length;
    });
  });
  const tl = Object.entries(tools).sort((a, b) => (S.metric === 'cost' ? b[1].cost - a[1].cost : b[1].tok - a[1].tok)).slice(0, 20);
  $('#toolTable').innerHTML = `<thead><tr><th>工具</th><th class="num">使用次數</th><th class="num">Token</th><th class="num">花費</th></tr></thead><tbody>` +
    tl.map(([n, t]) => `<tr><td>${esc(n.startsWith('mcp__') ? n.slice(n.lastIndexOf('__') + 2) + '（MCP）' : n)}</td><td class="num">${t.calls.toLocaleString()}</td><td class="num">${fmtTok(t.tok)}</td><td class="num">${fmtUSD(t.cost)}</td></tr>`).join('') + '</tbody>';

  // 最耗用的提問
  const pm = new Map();
  rows.forEach(r => {
    const k = r[R.session] + '|' + r[R.prompt];
    const p = pm.get(k) || { s: r[R.session], p: r[R.prompt], calls: 0, tok: 0, cost: 0 };
    p.calls++; p.tok += tokOf(r); p.cost += r[R.cost]; pm.set(k, p);
  });
  const pl = [...pm.values()].sort((a, b) => S.metric === 'cost' ? b.cost - a.cost : b.tok - a.tok).slice(0, 15);
  $('#promptTable').innerHTML = `<thead><tr><th>提問</th><th class="num">呼叫</th><th class="num">Token</th><th class="num">花費</th></tr></thead><tbody>` +
    pl.map(p => `<tr><td class="wrap" title="${esc(sessTitle(p.s))}">${esc(S.data.prompts[p.p] || '（無提問文字）').slice(0, 120)}</td><td class="num">${p.calls}</td><td class="num">${fmtTok(p.tok)}</td><td class="num">${fmtUSD(p.cost)}</td></tr>`).join('') + '</tbody>';
}

// ---------- Sessions ----------
function sessTitle(si) {
  const s = S.data.sessions[si];
  return s.title || (S.data.prompts.length && '') || s.id.slice(0, 8);
}
function sessionStats(rows) {
  const m = new Map();
  rows.forEach(r => {
    const si = r[R.session];
    const s = m.get(si) || { si, first: r[R.ts], last: 0, calls: 0, tok: 0, cost: 0, maxCtx: 0, firstPrompt: r[R.prompt] };
    s.last = Math.max(s.last, r[R.ts]); s.calls++; s.tok += tokOf(r); s.cost += r[R.cost];
    if (!r[R.sub]) s.maxCtx = Math.max(s.maxCtx, r[R.input] + r[R.cw] + r[R.cr]);
    m.set(si, s);
  });
  return [...m.values()];
}
function renderSessions(rows) {
  const q = $('#sessSearch').value.trim().toLowerCase();
  const list = sessionStats(rows).map(s => ({
    ...s, title: S.data.sessions[s.si].title || S.data.prompts[s.firstPrompt] || S.data.sessions[s.si].id.slice(0, 8),
    project: S.data.projects[S.data.sessions[s.si].project],
  })).filter(s => !q || s.title.toLowerCase().includes(q) || s.project.toLowerCase().includes(q));
  const { key, dir } = S.sessSort;
  list.sort((a, b) => (typeof a[key] === 'string' ? a[key].localeCompare(b[key]) : a[key] - b[key]) * dir);
  const cols = [['title', '標題'], ['project', '專案'], ['first', '開始'], ['last', '最後活動'], ['calls', '呼叫', 1], ['tok', 'Token', 1], ['cost', '花費', 1], ['maxCtx', '最大上下文', 1]];
  const ctxLimit = S.config ? S.config.thresholds.contextTokens : 0;
  $('#sessTable').innerHTML = `<thead><tr>${cols.map(([k, l, n]) => `<th data-k="${k}" class="${n ? 'num' : ''}">${l}${k === key ? (dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr></thead><tbody>` +
    list.map(s => `<tr data-si="${s.si}" class="${s.si === S.session ? 'sel' : ''}">
      <td class="wrap">${esc(s.title.slice(0, 80))}</td><td>${esc(s.project)}</td><td>${fmtTime(s.first)}</td><td>${fmtTime(s.last)}</td>
      <td class="num">${s.calls}</td><td class="num">${fmtTok(s.tok)}</td><td class="num">${fmtUSD(s.cost)}</td>
      <td class="num">${ctxLimit && s.maxCtx >= ctxLimit ? '⚠ ' : ''}${fmtTok(s.maxCtx)}</td></tr>`).join('') + '</tbody>';
  if (S.session != null) renderSessionDetail();
}
function renderSessionDetail() {
  const si = S.session;
  const rows = S.data.rows.filter(r => r[R.session] === si);
  if (!rows.length) { $('#sessDetail').hidden = true; return; }
  $('#sessDetail').hidden = false;
  const info = S.data.sessions[si];
  $('#sdTitle').textContent = `${info.title || S.data.prompts[rows[0][R.prompt]]?.slice(0, 60) || info.id}`;
  const sum = (a, f) => a.reduce((s, r) => s + f(r), 0);
  const main = rows.filter(r => !r[R.sub]);
  const ctx = main.map(r => r[R.input] + r[R.cw] + r[R.cr]);
  const dur = rows[rows.length - 1][R.ts] - rows[0][R.ts];
  $('#sdKpis').innerHTML = [
    ['總 token', fmtTok(sum(rows, tokOf)), `${rows.length} 次呼叫（子代理 ${rows.length - main.length}）`],
    ['估算花費', fmtUSD(sum(rows, r => r[R.cost])), '專案：' + S.data.projects[info.project]],
    ['輸出 token', fmtTok(sum(rows, r => r[R.output])), `其中思考 ${fmtTok(sum(rows, r => r[R.thinking]))}`],
    ['最大上下文', fmtTok(Math.max(0, ...ctx)), `目前 ${fmtTok(ctx[ctx.length - 1] || 0)}`],
    ['持續時間', dur >= 36e5 ? (dur / 36e5).toFixed(1) + ' 小時' : Math.round(dur / 6e4) + ' 分鐘', `${fmtTime(rows[0][R.ts])} 起`],
  ].map(([l, v, s]) => `<div class="kpi"><div class="label">${l}</div><div class="value">${v}</div><div class="sub">${esc(s)}</div></div>`).join('');

  const labels = main.map((r, i) => `#${i + 1} ${fmtTime(r[R.ts])}`);
  const ctxSets = [{ label: '上下文', data: ctx, borderColor: slot(1), backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, tension: 0.15 }];
  const lim = S.config && S.config.thresholds.contextTokens;
  if (lim) ctxSets.push({ label: '警示線', data: ctx.map(() => lim), borderColor: css('--critical'), borderDash: [4, 4], borderWidth: 1.5, pointRadius: 0 });
  draw('cSdCtx', { type: 'line', data: { labels, datasets: ctxSets }, options: baseOpts({ fmt: fmtTok }) });

  let acc = 0;
  const cum = rows.map(r => (acc += r[R.cost]));
  draw('cSdCum', { type: 'line', data: { labels: rows.map((r, i) => `#${i + 1} ${fmtTime(r[R.ts])}`), datasets: [{ label: '累積花費', data: cum, borderColor: slot(2), backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0 }] }, options: baseOpts({ fmt: fmtUSD }) });

  const sc = S.data.scenarios;
  const sv = sc.map((_, i) => sum(rows.filter(r => r[R.scen] === i), val));
  legend('#sdScenLegend', sc.map((s, i) => [s, slot(i + 1)]).filter((_, i) => sv[i] > 0));
  doughnut('cSdScen', sc, sv, sc.map((_, i) => slot(i + 1)));

  // 依提問分組（連續相同提問視為一輪）
  const turns = [];
  rows.forEach(r => {
    let t = turns[turns.length - 1];
    if (!t || t.p !== r[R.prompt]) { t = { p: r[R.prompt], ts: r[R.ts], calls: 0, tok: 0, cost: 0, sub: 0, scen: sc.map(() => 0), out: 0 }; turns.push(t); }
    t.calls++; t.tok += tokOf(r); t.cost += r[R.cost]; t.out += r[R.output]; t.sub += r[R.sub]; t.scen[r[R.scen]] += tokOf(r);
  });
  $('#sdTurns').innerHTML = `<thead><tr><th>時間</th><th>提問</th><th>主要情境</th><th class="num">呼叫</th><th class="num">輸出</th><th class="num">Token</th><th class="num">花費</th></tr></thead><tbody>` +
    turns.map(t => { const top = t.scen.indexOf(Math.max(...t.scen)); return `<tr><td>${fmtTime(t.ts)}</td><td class="wrap">${esc((S.data.prompts[t.p] || '（無提問文字）').slice(0, 140))}</td>
      <td><span class="dot" style="background:${slot(top + 1)}"></span>${sc[top]}</td><td class="num">${t.calls}${t.sub ? `（子 ${t.sub}）` : ''}</td>
      <td class="num">${fmtTok(t.out)}</td><td class="num">${fmtTok(t.tok)}</td><td class="num">${fmtUSD(t.cost)}</td></tr>`; }).join('') + '</tbody>';
}

// ---------- 通知 ----------
let seenAlertTs = 0;
try { seenAlertTs = +localStorage.getItem('seenAlertTs') || 0; } catch { /* ignore */ }
async function pollAlerts() {
  const { alerts } = await (await fetch('/api/alerts')).json();
  $('#alertList').innerHTML = alerts.length ? alerts.map(a => `<li><b>⚠ ${esc(a.title)}</b>${esc(a.body)}<div class="muted small">${fmtTime(a.ts)}</div></li>`).join('') : '<li class="muted">目前沒有通知</li>';
  const fresh = alerts.filter(a => a.ts > seenAlertTs);
  $('#alertBadge').hidden = !fresh.length;
  $('#alertBadge').textContent = fresh.length;
  if (fresh.length) {
    $('#banner').hidden = false;
    $('#banner').innerHTML = `<span>⚠</span><div>${fresh.slice(0, 3).map(a => `<div><b>${esc(a.title)}</b>　${esc(a.body)}</div>`).join('')}${fresh.length > 3 ? `<div class="muted">還有 ${fresh.length - 3} 則…</div>` : ''}</div><button class="x" aria-label="關閉">✕</button>`;
    const notified = JSON.parse(sessionStorage.getItem('notified') || '[]');
    if ('Notification' in window && Notification.permission === 'granted') {
      fresh.filter(a => !notified.includes(a.key)).forEach(a => { new Notification(a.title, { body: a.body }); notified.push(a.key); });
      sessionStorage.setItem('notified', JSON.stringify(notified));
    }
  }
}
function dismissAlerts() {
  seenAlertTs = Date.now();
  try { localStorage.setItem('seenAlertTs', seenAlertTs); } catch { /* ignore */ }
  $('#banner').hidden = true; $('#alertBadge').hidden = true;
}

// ---------- 設定 ----------
function fillConfig() {
  const f = $('#thForm');
  for (const [k, v] of Object.entries(S.config.thresholds)) if (f.elements[k]) f.elements[k].value = v;
  f.elements.windowsToast.checked = !!S.config.windowsToast;
  $('#pricing').value = JSON.stringify(S.config.pricing, null, 2);
}
async function saveConfig(patch, msgEl) {
  const res = await fetch('/api/config', { method: 'POST', body: JSON.stringify(patch) });
  const j = await res.json();
  if (!res.ok) { $(msgEl).textContent = '儲存失敗：' + j.error; return; }
  S.config = j; fillConfig(); $(msgEl).textContent = '已儲存 ' + fmtTime(Date.now());
  S.etag = null; load();
}

// ---------- 主流程 ----------
function render() {
  if (!S.data) return;
  const rows = filtered();
  if (S.tab === 'overview') renderOverview(rows);
  if (S.tab === 'scenario') renderScenario(rows);
  if (S.tab === 'sessions') renderSessions(rows);
}
function fillSelect(sel, items, keepVal) {
  const el = $(sel);
  el.innerHTML = '<option value="">全部</option>' + items.map((n, i) => `<option value="${i}">${esc(n)}</option>`).sort((a, b) => a.localeCompare(b)).join('');
  el.value = keepVal;
}
async function load() {
  try {
    const res = await fetch('/api/data', { headers: S.etag ? { 'If-None-Match': S.etag } : {} });
    if (res.status === 200) {
      S.etag = res.headers.get('ETag');
      S.data = await res.json();
      fillSelect('#fProject', S.data.projects, S.project);
      fillSelect('#fModel', S.data.models, S.model);
      render();
    }
    $('#status').textContent = `${S.data.rows.length.toLocaleString()} 次 API 呼叫・更新於 ${fmtTime(Date.now())}`;
    await pollAlerts();
  } catch (e) {
    $('#status').textContent = '無法連線到伺服器：' + e.message;
  }
}

function bindSeg(id, key) {
  $(id).addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    $(id).querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    S[key] = b.dataset.v; render();
  });
}
bindSeg('#range', 'range');
bindSeg('#metric', 'metric');
[['#fProject', 'project'], ['#fModel', 'model'], ['#fSource', 'source']].forEach(([id, k]) => $(id).addEventListener('change', e => { S[k] = e.target.value; render(); }));
document.querySelector('.tabs').addEventListener('click', e => {
  const b = e.target.closest('.tab'); if (!b) return;
  S.tab = b.dataset.tab;
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === b));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + S.tab));
  if (S.tab === 'alerts') dismissAlerts();
  render();
});
$('#sessSearch').addEventListener('input', render);
$('#sessTable').addEventListener('click', e => {
  const th = e.target.closest('th');
  if (th) { const k = th.dataset.k; S.sessSort = { key: k, dir: S.sessSort.key === k ? -S.sessSort.dir : -1 }; return render(); }
  const tr = e.target.closest('tr[data-si]');
  if (tr) { S.session = +tr.dataset.si; render(); $('#sessDetail').scrollIntoView({ behavior: 'smooth' }); }
});
$('#sdClose').addEventListener('click', () => { S.session = null; $('#sessDetail').hidden = true; render(); });
$('#banner').addEventListener('click', e => { if (e.target.closest('.x')) dismissAlerts(); });
$('#thForm').addEventListener('submit', e => {
  e.preventDefault();
  const f = e.target, th = {};
  for (const k of Object.keys(S.config.thresholds)) th[k] = +f.elements[k].value || 0;
  saveConfig({ thresholds: th, windowsToast: f.elements.windowsToast.checked }, '#thMsg');
});
$('#savePricing').addEventListener('click', () => {
  let p; try { p = JSON.parse($('#pricing').value); } catch (e) { $('#prMsg').textContent = 'JSON 格式錯誤：' + e.message; return; }
  saveConfig({ pricing: p }, '#prMsg');
});
$('#testToast').addEventListener('click', () => fetch('/api/test-toast').then(() => { $('#thMsg').textContent = '已送出測試通知（請看螢幕右下角）'; }));
$('#enableNotif').addEventListener('click', async () => {
  if (!('Notification' in window)) { $('#thMsg').textContent = '此瀏覽器不支援通知'; return; }
  const p = await Notification.requestPermission();
  $('#thMsg').textContent = p === 'granted' ? '已啟用瀏覽器通知' : '未取得通知權限';
});
// 熱度圖 hover 提示
const tip = $('#tip');
$('#heatmap').addEventListener('mousemove', e => {
  const c = e.target.closest('[data-tip]');
  if (!c) { tip.hidden = true; return; }
  tip.hidden = false; tip.textContent = c.dataset.tip;
  tip.style.left = Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8) + 'px'; tip.style.top = (e.clientY + 14) + 'px';
});
$('#heatmap').addEventListener('mouseleave', () => { tip.hidden = true; });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);

(async () => {
  S.config = await (await fetch('/api/config')).json();
  fillConfig();
  await load();
  setInterval(load, (S.config.refreshSeconds || 30) * 1000);
})();

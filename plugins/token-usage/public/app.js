'use strict';
// ---------- 狀態 ----------
const S = {
  data: null, etag: null, config: null,
  range: '7d', metric: 'tokens', project: '', model: '', source: '', device: '', app: (() => { try { const v = localStorage.getItem('app'); return v == null ? 'auto' : v; } catch { return 'auto'; } })(),
  tab: 'overview', session: null, sessSort: { key: 'last', dir: -1 },
};
const R = { ts: 0, session: 1, project: 2, model: 3, input: 4, output: 5, cw: 6, cr: 7, cost: 8, scen: 9, sub: 10, prompt: 11, thinking: 12, tools: 13, device: 14, app: 15 };
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
    (S.source === '' || r[R.sub] === +S.source) &&
    (S.device === '' || r[R.device] === +S.device) &&
    (S.app === '' || r[R.app] === +S.app);
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
    ...codexQuotaKpis(kpi),
  ].join('');

  // 時間軸：依 token 類型堆疊
  const b = buckets(rows);
  $('#tlNote').textContent = b.hourly ? '每小時' : '每日';
  let sets;
  if (S.app === '') {
    const byApp = S.data.apps.map(() => b.keys.map(() => 0));
    rows.forEach(r => { const i = b.index(r[R.ts]); if (i != null) byApp[r[R.app]][i] += val(r); });
    sets = S.data.apps.map((a, k) => barDs(a, byApp[k], slot(k + 1), k === S.data.apps.length - 1));
    legend('#tlLegend', S.data.apps.map((a, k) => [a, slot(k + 1)]));
  } else if (S.metric === 'cost') {
    const byModel = S.data.models.map(() => b.keys.map(() => 0));
    rows.forEach(r => { const i = b.index(r[R.ts]); if (i != null) byModel[r[R.model]][i] += r[R.cost]; });
    const used = S.data.models.map((m, i) => i).filter(i => byModel[i].some(v => v));
    sets = used.map((mi, k) => barDs(S.data.models[mi], byModel[mi], slot((k % 8) + 1), k === used.length - 1));
    legend('#tlLegend', used.map((mi, k) => [S.data.models[mi], slot((k % 8) + 1)]));
  } else {
    const arr = TYPES.map(() => b.keys.map(() => 0));
    rows.forEach(r => { const i = b.index(r[R.ts]); if (i != null) TYPES.forEach((t, k) => { arr[k][i] += r[t.idx]; }); });
    const used = TYPES.map((t, k) => k).filter(k => arr[k].some(v => v));
    sets = used.map((k, j) => barDs(TYPES[k].label, arr[k], slot(TYPES[k].slot), j === used.length - 1));
    legend('#tlLegend', used.map(k => [TYPES[k].label, slot(TYPES[k].slot)]));
  }
  draw('cTimeline', { type: 'bar', data: { labels: b.labels, datasets: sets }, options: baseOpts({ stacked: true }) });

  // Token 類型組成（token 數；花費模式下顯示各類型的花費比重）
  const typeVals = TYPES.map(t => sum(rows, r => r[t.idx]));
  const usedTypes = TYPES.filter((t, k) => typeVals[k] > 0);
  legend('#typeLegend', usedTypes.map(t => [`${t.label} ${fmtTok(typeVals[TYPES.indexOf(t)])}`, slot(t.slot)]));
  doughnut('cTypes', usedTypes.map(t => t.label), usedTypes.map(t => typeVals[TYPES.indexOf(t)]), usedTypes.map(t => slot(t.slot)), fmtTok);

  // 模型
  if (S.app === '') {
    const av = S.data.apps.map((a, k) => sum(rows.filter(r => r[R.app] === k), val));
    $('#modelTitle').textContent = '工具分佈';
    legend('#modelLegend', S.data.apps.map((a, k) => [`${a} ${fmtVal(av[k])}`, slot(k + 1)]));
    doughnut('cModels', S.data.apps, av, S.data.apps.map((a, k) => slot(k + 1)));
  } else {
  $('#modelTitle').textContent = '模型分佈';
  const mVals = S.data.models.map((m, i) => sum(rows.filter(r => r[R.model] === i), val));
  const mIdx = mVals.map((v, i) => i).filter(i => mVals[i] > 0).sort((a, b) => mVals[b] - mVals[a]);
  const mColor = i => slot((S.data.models.indexOf(S.data.models[i]) % 8) + 1);
  legend('#modelLegend', mIdx.map(i => [`${S.data.models[i]} ${fmtVal(mVals[i])}`, mColor(i)]));
  doughnut('cModels', mIdx.map(i => S.data.models[i]), mIdx.map(i => mVals[i]), mIdx.map(mColor));
  }

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
  renderDeviceChart(rows);

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

function renderDeviceChart(rows) {
  const devs = S.data.devices;
  $('#deviceCard').hidden = devs.length < 2;
  if (devs.length < 2) return;
  const v = devs.map(() => 0);
  rows.forEach(r => { v[r[R.device]] += val(r); });
  $('#deviceNote').textContent = `${devs.length} 台裝置`;
  draw('cDevices', {
    type: 'bar',
    data: { labels: devs.map(deviceLabel), datasets: [{ ...barDs(S.metric === 'cost' ? '花費' : 'Token', v, devs.map((d, i) => slot((i % 8) + 1))), borderRadius: { topRight: 4, bottomRight: 4 } }] },
    options: { ...baseOpts(), indexAxis: 'y', interaction: { mode: 'nearest', axis: 'y', intersect: false },
      scales: { x: { ...baseOpts().scales.y }, y: { grid: { display: false }, ticks: { color: css('--text-2') } } } },
  });
}
const deviceLabel = d => d.name + (d.local ? '（本機）' : '');

// Codex 紀錄裡附帶方案額度使用率（5 小時 / 每週）
function codexQuotaKpis(kpi) {
  const L = S.data.limits && S.data.limits.codex;
  if (!L || S.app === '0') return [];
  const asOf = `截至 ${fmtTime(L.ts)}`;
  const stale = Date.now() - L.ts > 864e5 ? '（資料較舊）' : '';
  const win = w => w.window_minutes >= 1440 ? `每 ${Math.round(w.window_minutes / 1440)} 天` : `每 ${Math.round(w.window_minutes / 60)} 小時`;
  const out = [kpi(`Codex 額度（${win(L.primary)}）`, L.primary.used_percent + '%', asOf + stale, L.primary.used_percent / 100)];
  if (L.secondary) out.push(kpi(`Codex 額度（${win(L.secondary)}）`, L.secondary.used_percent + '%', asOf + stale, L.secondary.used_percent / 100));
  return out;
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
    tl.map(([n, t]) => `<tr><td>${esc(toolLabel(n))}</td><td class="num">${t.calls.toLocaleString()}</td><td class="num">${fmtTok(t.tok)}</td><td class="num">${fmtUSD(t.cost)}</td></tr>`).join('') + '</tbody>';

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
function toolLabel(n) {
  if (n.startsWith('mcp__')) return n.slice(n.lastIndexOf('__') + 2) + '（MCP）';
  return n.replace(/:read$/, '（讀取）').replace(/:write$/, '（寫入）');
}
function sessTitle(si) {
  const s = S.data.sessions[si];
  return s.title || (S.data.prompts.length && '') || s.id.slice(0, 8);
}
function sessionStats(rows) {
  const m = new Map();
  rows.forEach(r => {
    const si = r[R.session];
    const s = m.get(si) || { si, app: r[R.app], first: r[R.ts], last: 0, calls: 0, tok: 0, cost: 0, maxCtx: 0, firstPrompt: r[R.prompt] };
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
    device: S.data.devices[S.data.sessions[s.si].device]?.name || '',
    app: S.data.apps[s.app] || '',
  })).filter(s => !q || s.title.toLowerCase().includes(q) || s.project.toLowerCase().includes(q));
  const { key, dir } = S.sessSort;
  list.sort((a, b) => (typeof a[key] === 'string' ? a[key].localeCompare(b[key]) : a[key] - b[key]) * dir);
  const cols = [['title', '標題'], ['app', '工具'], ['project', '專案'], ['device', '裝置'], ['first', '開始'], ['last', '最後活動'], ['calls', '呼叫', 1], ['tok', 'Token', 1], ['cost', '花費', 1], ['maxCtx', '最大上下文', 1]];
  const ctxLimit = S.config ? S.config.thresholds.contextTokens : 0;
  $('#sessTable').innerHTML = `<thead><tr>${cols.map(([k, l, n]) => `<th data-k="${k}" class="${n ? 'num' : ''}">${l}${k === key ? (dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr></thead><tbody>` +
    list.map(s => `<tr data-si="${s.si}" class="${s.si === S.session ? 'sel' : ''}">
      <td class="wrap">${esc(s.title.slice(0, 80))}</td><td>${esc(s.app)}</td><td>${esc(s.project)}</td><td>${esc(s.device)}</td><td>${fmtTime(s.first)}</td><td>${fmtTime(s.last)}</td>
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
// ---------- 工具與模型 ----------
// 第一次開啟時選最近一次有用到的工具（只裝 Codex 的人會直接看到 Codex）
function pickDefaultApp() {
  const last = S.data.rows.length ? S.data.rows[S.data.rows.length - 1][R.app] : 0;
  S.app = String(last);
  $('#appSeg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === S.app));
}
const APP_KEYS = ['claude', 'codex'];
function viewApps() { return S.app === '' ? [0, 1] : [+S.app]; }
function fillModelSelect() {
  const seen = (S.data.models_seen || []).filter(m => viewApps().includes(APP_KEYS.indexOf(m.app)));
  const el = $('#fModel');
  el.innerHTML = '<option value="">全部</option>' + seen.sort((a, b) => b.calls - a.calls)
    .map(m => `<option value="${S.data.models.indexOf(m.model)}">${esc(m.model)}${S.app === '' ? '（' + S.data.apps[APP_KEYS.indexOf(m.app)] + '）' : ''}</option>`).join('');
  el.value = S.model;
  if (el.value !== S.model) S.model = '';
}
function unpricedModels() {
  return (S.data.models_seen || []).filter(m => !m.priceKey && viewApps().includes(APP_KEYS.indexOf(m.app)));
}
// 有未定價模型、或價格表超過 30 天沒更新時提醒；兩種情況都可以請使用者的 AI「更新模型價格」
function renderPriceNotice() {
  const u = unpricedModels();
  const stale = PRICES && PRICES.staleDays > 30 ? PRICES.staleDays : 0;
  const msgs = [];
  if (u.length) msgs.push(`⚠ 有 ${u.length} 個模型沒有價格，花費未計入：${u.map(m => esc(m.model)).join('、')}。`);
  if (stale) msgs.push(`價格表已經 ${stale} 天沒有更新。`);
  $('#priceNotice').hidden = !msgs.length;
  if (msgs.length) $('#priceNotice').innerHTML = `${msgs.join(' ')}可以對 Claude Code 或 Codex 說「更新模型價格」，或 <a>手動設定價格</a>。`;
}

// ---------- 價格表 ----------
let PRICES = null;
// background：定期更新時呼叫；使用者正在編輯價格表時不重畫表格，避免蓋掉還沒儲存的輸入
async function loadPrices(background) {
  PRICES = await (await fetch('/api/prices')).json();
  const editing = PRICE_DIRTY || $('#priceTables').contains(document.activeElement);
  if (!(background && editing)) renderPrices();
  if (S.data) renderPriceNotice();
}
$('#remotePrices').addEventListener('change', e => {
  saveConfig({ remotePrices: e.target.checked }, '#remoteMsg').then(() => loadPrices());
});
$('#checkPrices').addEventListener('click', async () => {
  $('#remoteMsg').textContent = '檢查中…';
  PRICES = await (await fetch('/api/prices/check', { method: 'POST' })).json();
  S.etag = null; await load();
  renderPrices();
});
const num = v => (v == null || v === '' ? '' : v);
function renderPrices() {
  if (!PRICES || !S.data) return;
  const link = (u, label) => /^https:\/\//.test(u || '') ? `<a href="${esc(u)}" target="_blank" rel="noopener">${label}</a>` : label;
  $('#priceMeta').innerHTML = `官方價格表 ${esc(PRICES.updated)}（${PRICES.baseSource === 'remote' ? 'GitHub 最新版' : 'plugin 內建'}）・${link(PRICES.sources.claude, 'Claude 價目')}・${link(PRICES.sources.codex, 'OpenAI 價目')}`;
  $('#remotePrices').checked = PRICES.remote.enabled;
  $('#checkPrices').disabled = !PRICES.remote.enabled;
  $('#remoteMsg').textContent = !PRICES.remote.enabled ? '已關閉，只使用 plugin 內建的價格表'
    : PRICES.remote.error ? `上次下載失敗：${PRICES.remote.error}`
    : PRICES.remote.lastCheck ? `上次檢查 ${fmtTime(PRICES.remote.lastCheck)}` : '尚未檢查';
  const seen = {};
  (S.data.models_seen || []).forEach(m => { seen[m.app + '|' + m.model] = m; });
  $('#priceTables').innerHTML = viewApps().map(ai => {
    const tool = APP_KEYS[ai];
    const eff = PRICES.effective[tool] || {};
    const isClaude = tool === 'claude';
    // 有用到但沒有價格的模型放最上面，接著依使用次數，最後是其他模型
    const used = Object.values(seen).filter(m => m.app === tool);
    const names = [...new Set([...used.filter(m => !m.priceKey).map(m => m.model),
      ...Object.keys(eff).sort((a, b) => (usedCount(tool, b) - usedCount(tool, a)) || a.localeCompare(b))])];
    const row = name => {
      const p = eff[name];
      const users = used.filter(m => m.priceKey === name && m.model !== name).map(m => m.model);
      const calls = usedCount(tool, name);
      const inp = (f, v, ph = '') => `<input type="number" step="any" min="0" data-tool="${tool}" data-model="${esc(name)}" data-f="${f}" value="${num(v)}" placeholder="${ph}">`;
      const longTxt = p && p.long ? `＞${fmtTok(p.long.threshold)}：${p.long.input} / ${p.long.output}` : '';
      const srcTip = p && p.source === 'ai' ? ` title="${esc(`${p.updatedAt || ''} ${p.sourceUrl || ''}`.trim())}"` : '';
      const SRC = { official: '官方', estimate: '估計', ai: 'AI 更新', custom: '自訂' };
      const srcKey = p && SRC[p.source] ? p.source : 'custom';
      const src = p ? `<span class="src ${srcKey}"${srcTip}>${SRC[srcKey]}</span>` : '<span class="src">未定價</span>';
      const isOverride = p && (p.source === 'custom' || p.source === 'ai');
      const reset = isOverride ? ` <button class="link-btn" data-reset="${tool}|${esc(name)}">${PRICES.defaults[tool][name] ? '還原' : '刪除'}</button>` : '';
      return `<tr class="${p ? '' : 'unpriced'}"><td>${esc(name)}${users.length ? `<div class="muted small">也套用於 ${users.map(esc).join('、')}</div>` : ''}</td>
        <td class="num">${calls ? calls.toLocaleString() : ''}</td>
        <td>${inp('input', p && p.input)}</td><td>${inp('cacheRead', p && p.cacheRead)}</td>
        ${isClaude ? `<td>${inp('cacheWrite5m', p && p.cacheWrite5m, p ? +(p.input * 1.25).toFixed(4) : '')}</td>` : ''}
        <td>${inp('output', p && p.output)}</td><td class="muted small">${longTxt}</td><td>${src}${reset}</td></tr>`;
    };
    return `<div class="table-wrap price-table"><h3>${S.data.apps[ai]}</h3><table>
      <thead><tr><th>模型</th><th class="num">呼叫數</th><th>輸入</th><th>${isClaude ? '快取讀取' : '快取輸入'}</th>${isClaude ? '<th>快取寫入（5 分）</th>' : ''}<th>輸出</th><th>長上下文</th><th>來源</th></tr></thead>
      <tbody>${names.map(row).join('')}
      <tr><td><input type="text" placeholder="新增模型名稱" data-tool="${tool}" data-new="1"></td><td></td>
        <td><input type="number" step="any" min="0" data-tool="${tool}" data-new-f="input"></td><td><input type="number" step="any" min="0" data-tool="${tool}" data-new-f="cacheRead"></td>
        ${isClaude ? '<td><input type="number" step="any" min="0" data-tool="claude" data-new-f="cacheWrite5m"></td>' : ''}
        <td><input type="number" step="any" min="0" data-tool="${tool}" data-new-f="output"></td><td></td><td></td></tr>
      </tbody></table></div>`;
  }).join('');
}
function usedCount(tool, name) {
  return (S.data.models_seen || []).filter(m => m.app === tool && m.priceKey === name).reduce((s, m) => s + m.calls, 0);
}
// 只送出有改動的列（{ 工具: { 模型: 價格 | null } }），由伺服器合併進最新的設定檔；
// 這樣頁面開著時 AI 寫入的價格不會被舊資料蓋掉。改回和官方相同的價格會送 null（刪除自訂）。
let PRICE_DIRTY = false;
function collectPricePatch() {
  const out = {};
  const put = (tool, m, v) => { (out[tool] = out[tool] || {})[m] = v; };
  const read = (tool, model) => {
    const v = {};
    document.querySelectorAll(`#priceTables input[data-tool="${tool}"][data-f]`).forEach(i => {
      if (i.dataset.model === model && i.value !== '') v[i.dataset.f] = +i.value;
    });
    return v;
  };
  const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite5m'];
  for (const ai of viewApps()) {
    const tool = APP_KEYS[ai];
    const models = new Set([...document.querySelectorAll(`#priceTables input[data-tool="${tool}"][data-f]`)].map(i => i.dataset.model));
    for (const m of models) {
      const v = read(tool, m);
      const eff = PRICES.effective[tool][m];
      const def = PRICES.defaults[tool][m];
      if (v.input == null || v.output == null) continue; // 未填完整：不處理
      // 這一列沒有被改動：維持原狀（AI 更新仍是 AI 更新）
      if (eff && FIELDS.every(f => (eff[f] ?? null) === (v[f] ?? (f === 'cacheWrite5m' ? null : eff[f]) ?? null))) continue;
      const merged = { ...v };
      if (eff && eff.long) merged.long = eff.long;
      if (eff && eff.fast) merged.fast = eff.fast;
      const same = def && FIELDS.every(f => (def[f] ?? null) === (merged[f] ?? null));
      put(tool, m, same ? null : merged);
    }
    const nameEl = document.querySelector(`#priceTables input[data-tool="${tool}"][data-new]`);
    const nv = {};
    document.querySelectorAll(`#priceTables input[data-tool="${tool}"][data-new-f]`).forEach(i => { if (i.value !== '') nv[i.dataset.newF] = +i.value; });
    if (nameEl && nameEl.value.trim() && nv.input != null && nv.output != null) put(tool, nameEl.value.trim(), nv);
  }
  return out;
}
$('#priceTables').addEventListener('input', () => { PRICE_DIRTY = true; });
$('#priceTables').addEventListener('click', e => {
  const b = e.target.closest('[data-reset]'); if (!b) return;
  const [tool, model] = b.dataset.reset.split('|');
  PRICE_DIRTY = false;
  saveConfig({ priceOverridesPatch: { [tool]: { [model]: null } } }, '#prMsg').then(() => loadPrices());
});

function renderDevices() {
  const now = Date.now();
  const ago = ts => { const m = Math.round((now - ts) / 6e4); return m < 1 ? '剛剛' : m < 60 ? `${m} 分鐘前` : m < 1440 ? `${Math.round(m / 60)} 小時前` : `${Math.round(m / 1440)} 天前`; };
  $('#deviceTable').innerHTML = '<thead><tr><th>裝置</th><th>最後更新</th><th class="num">呼叫數</th></tr></thead><tbody>' +
    S.data.devices.map(d => `<tr><td>${esc(d.name)}${d.local ? '<span class="tag">本機</span>' : ''}</td><td>${d.local ? '即時' : ago(d.updatedAt)}</td><td class="num">${d.calls.toLocaleString()}</td></tr>`).join('') + '</tbody>';
}
function fillConfig() {
  const sf = $('#syncForm');
  sf.elements.deviceName.value = S.config.deviceName || '';
  sf.elements.deviceName.placeholder = S.config.deviceNameResolved;
  sf.elements.syncDir.value = S.config.syncDir || '';
  if (/Mac/i.test(navigator.platform)) sf.elements.syncDir.placeholder = '例如 /Users/你的帳號/Library/CloudStorage/OneDrive-公司名稱/ClaudeTokenUsage';
  $('#useOneDrive').hidden = !S.config.detectedOneDrive || S.config.syncDir === S.config.detectedOneDrive;
  $('#syncMsg').textContent = S.config.syncError || (S.config.syncDir ? '同步中：' + S.config.syncDir : '目前未同步，只顯示這台電腦的用量');

  const f = $('#thForm');
  for (const [k, v] of Object.entries(S.config.thresholds)) if (f.elements[k]) f.elements[k].value = v;
  f.elements.windowsToast.checked = !!S.config.windowsToast;
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
  el.innerHTML = '<option value="">全部</option>' + items.map((n, i) => [n, i]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    .map(([n, i]) => `<option value="${i}">${esc(n)}</option>`).join('');
  el.value = keepVal;
}
// 每次重建資料時，專案 / 模型 / 裝置 / session 的索引都可能改變；用名稱或 ID 把目前的選擇對回新的索引
function remapSelection(prev, next) {
  const back = (list, i, key) => (i === '' || i == null || !prev ? null : key(list(prev)[+i]));
  const find = (list, v, key) => { const i = list(next).findIndex(x => key(x) === v); return i; };
  const sel = [
    ['project', d => d.projects, x => x],
    ['model', d => d.models, x => x],
    ['device', d => d.devices, x => x && x.id],
  ];
  for (const [k, list, key] of sel) {
    const v = back(list, S[k], key);
    if (v == null) continue;
    const i = find(list, v, key);
    S[k] = i < 0 ? '' : String(i);
  }
  if (S.session != null && prev) {
    const id = prev.sessions[S.session] && prev.sessions[S.session].id;
    const i = next.sessions.findIndex(s => s.id === id);
    S.session = i < 0 ? null : i;
  }
}
async function load() {
  try {
    const res = await fetch('/api/data', { headers: S.etag ? { 'If-None-Match': S.etag } : {} });
    if (res.status === 200) {
      S.etag = res.headers.get('ETag');
      const next = await res.json();
      remapSelection(S.data, next);
      S.data = next;
      if (S.app === 'auto') pickDefaultApp();
      fillSelect('#fProject', S.data.projects, S.project);
      fillModelSelect();
      fillSelect('#fDevice', S.data.devices.map(deviceLabel), S.device);
      renderDevices();
      await loadPrices(true);
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
$('#appSeg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === S.app));
$('#appSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  $('#appSeg').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
  S.app = b.dataset.v; S.model = ''; S.session = null;
  try { localStorage.setItem('app', S.app); } catch { /* ignore */ }
  fillModelSelect(); renderPriceNotice(); renderPrices(); render();
});
$('#priceNotice').addEventListener('click', e => {
  if (!e.target.closest('a')) return;
  document.querySelector('[data-tab=alerts]').click();
  $('#priceTables').scrollIntoView({ behavior: 'smooth' });
});
bindSeg('#metric', 'metric');
[['#fProject', 'project'], ['#fModel', 'model'], ['#fSource', 'source'], ['#fDevice', 'device']].forEach(([id, k]) => $(id).addEventListener('change', e => { S[k] = e.target.value; render(); }));
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
$('#syncForm').addEventListener('submit', e => {
  e.preventDefault();
  saveConfig({ deviceName: e.target.elements.deviceName.value, syncDir: e.target.elements.syncDir.value }, '#syncMsg');
});
$('#useOneDrive').addEventListener('click', () => { $('#syncForm').elements.syncDir.value = S.config.detectedOneDrive; });
$('#savePricing').addEventListener('click', () => {
  PRICE_DIRTY = false;
  saveConfig({ priceOverridesPatch: collectPricePatch() }, '#prMsg').then(() => loadPrices());
});
$('#testToast').addEventListener('click', () => fetch('/api/test-toast').then(() => { $('#thMsg').textContent = '已送出測試通知（Windows 在右下角、macOS 在右上角）'; }));
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
  await loadPrices();
  await load();
  setInterval(load, (S.config.refreshSeconds || 30) * 1000);
})();

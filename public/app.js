/* HX-CCD21 Dashboard — Монгол хэлний SPA (vanilla JS + Chart.js) */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const app = $('#app');
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('mn-MN'));
  const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '—');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const TZ = 'Asia/Ulaanbaatar';
  const dtf = new Intl.DateTimeFormat('mn-MN', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const fmtDT = (d) => (d ? dtf.format(new Date(d)).replace(',', '') : '—');
  const ago = (d) => {
    if (!d) return 'хэзээ ч';
    const s = Math.max(0, Math.floor((Date.now() - new Date(d)) / 1000));
    if (s < 60) return s + ' сек өмнө';
    if (s < 3600) return Math.floor(s / 60) + ' мин өмнө';
    if (s < 86400) return Math.floor(s / 3600) + ' цаг өмнө';
    return Math.floor(s / 86400) + ' өдрийн өмнө';
  };
  const dur = (ms) => { if (!ms) return '—'; const s = Math.round(ms / 1000); return s < 60 ? s + ' сек' : s < 3600 ? Math.round(s / 60) + ' мин' : (s / 3600).toFixed(1) + ' цаг'; };
  const AGE_LABEL = { '0_9': '0–9', '10_16': '10–16', '17_30': '17–30', '31_45': '31–45', '46_60': '46–60', '61_plus': '61+', unknown: 'Тодорхойгүй' };
  const AGE_ORDER = ['0_9', '10_16', '17_30', '31_45', '46_60', '61_plus', 'unknown'];
  const DOW = ['Да', 'Мя', 'Лх', 'Пү', 'Ба', 'Бя', 'Ня'];

  // ---- state ----
  const state = {
    user: null, tenant: null, tenants: [], locations: [], devices: [],
    tenantId: '', locationId: '', sn: '', range: '7d', from: '', to: '', page: 'overview',
  };
  const charts = {};
  const killCharts = () => { for (const k in charts) { charts[k].destroy(); delete charts[k]; } };

  // ---- API ----
  async function api(path, opt = {}) {
    const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', ...opt, body: opt.body ? JSON.stringify(opt.body) : undefined });
    if (r.status === 401 && !path.includes('/auth/login')) { state.user = null; renderLogin(); throw new Error('Нэвтрээгүй'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  }
  function qs(extra = {}) {
    const p = new URLSearchParams();
    const { from, to } = rangeDates();
    if (state.tenantId) p.set('tenant_id', state.tenantId);
    if (state.locationId) p.set('location_id', state.locationId);
    if (state.sn) p.set('sn', state.sn);
    p.set('from', from); p.set('to', to); p.set('tz', TZ);
    for (const [k, v] of Object.entries(extra)) if (v != null) p.set(k, v);
    return '?' + p.toString();
  }
  // Улаанбаатарын цагаар өдрийн эхлэл
  function ubDate(offsetDays = 0) {
    const now = new Date(Date.now() + offsetDays * 86400000);
    const d = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    return d; // YYYY-MM-DD
  }
  function rangeDates() {
    const r = state.range;
    if (r === 'custom' && state.from && state.to) return { from: state.from + 'T00:00:00+08:00', to: state.to + 'T23:59:59+08:00', days: Math.max(1, (new Date(state.to) - new Date(state.from)) / 86400000 + 1) };
    const days = r === 'today' ? 1 : r === '30d' ? 30 : r === '90d' ? 90 : 7;
    return { from: ubDate(-(days - 1)) + 'T00:00:00+08:00', to: ubDate(1) + 'T00:00:00+08:00', days };
  }
  const gran = () => { const d = rangeDates().days; return d <= 2 ? 'hour' : d <= 120 ? 'day' : 'week'; };

  function toast(msg, ms = 2500) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), ms); }
  function modal(html, onMount) {
    const bg = document.createElement('div'); bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal">${html}</div>`;
    bg.addEventListener('click', (e) => { if (e.target === bg) bg.remove(); });
    document.body.appendChild(bg);
    onMount && onMount(bg, () => bg.remove());
    return bg;
  }

  // ---- Chart helpers (Chart.js) ----
  function chartDefaults() {
    Chart.defaults.color = css('--text-2'); Chart.defaults.borderColor = css('--border');
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily; Chart.defaults.font.size = 12;
    Chart.defaults.plugins.legend.labels.boxWidth = 10; Chart.defaults.plugins.legend.labels.boxHeight = 10;
    Chart.defaults.plugins.tooltip.backgroundColor = css('--text'); Chart.defaults.plugins.tooltip.titleColor = css('--bg'); Chart.defaults.plugins.tooltip.bodyColor = css('--bg');
  }
  function mk(id, cfg) { const el = $('#' + id); if (!el) return; if (charts[id]) charts[id].destroy(); charts[id] = new Chart(el, cfg); }
  const bucketLabel = (b, g) => { const d = new Date(b + 'Z'); return g === 'hour' ? d.getUTCHours().toString().padStart(2, '0') + ':00' : g === 'week' ? d.getUTCMonth() + 1 + '/' + d.getUTCDate() + ' 7х' : d.getUTCMonth() + 1 + '/' + d.getUTCDate(); };

  // ================= LOGIN =================
  function renderLogin(err = '') {
    killCharts();
    app.innerHTML = `<div class="login"><div class="card">
      <div class="brand"><div class="logo">F</div><div><b>Footfall</b><small>Хүний урсгалын систем</small></div></div>
      <h1>Нэвтрэх</h1><p>Бүртгэлтэй и-мэйл, нууц үгээ оруулна уу.</p>
      <form class="form" id="loginForm">
        <label>И-мэйл<input type="email" name="email" required autocomplete="username"></label>
        <label>Нууц үг<input type="password" name="password" required autocomplete="current-password"></label>
        <div class="err" id="loginErr">${esc(err)}</div>
        <button class="btn primary" type="submit">Нэвтрэх</button>
      </form></div></div>`;
    $('#loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try { await api('/dash/auth/login', { method: 'POST', body: { email: f.get('email'), password: f.get('password') } }); await boot(); }
      catch (err) { $('#loginErr').textContent = err.message; }
    });
  }

  // ================= SHELL =================
  // Superadmin: байгууллагуудын хяналтын самбар + төхөөрөмж + тохиргоо (байгууллагын урсгалын өгөгдөл харахгүй)
  const NAV_SUPER = [
    ['admin', 'Байгууллагууд', 'M12 7V3H2v18h20V7H12zM6 19H4v-2h2v2zm0-4H4v-2h2v2zm0-4H4V9h2v2zm0-4H4V5h2v2zm4 12H8v-2h2v2zm0-4H8v-2h2v2zm0-4H8V9h2v2zm0-4H8V5h2v2zm10 12h-8v-2h2v-2h-2v-2h2v-2h-2V9h8v10zm-2-8h-2v2h2v-2zm0 4h-2v2h2v-2z'],
    ['devices', 'Төхөөрөмж', 'M4 6h16v10H4zM2 18h20v2H2z'],
    ['settings', 'Тохиргоо', 'M19.4 13a7.7 7.7 0 000-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 00-1.7-1L15 3H9l-.4 2.7a7.4 7.4 0 00-1.7 1l-2.5-1-2 3.5L4.6 11a7.7 7.7 0 000 2l-2.1 1.6 2 3.5 2.5-1c.5.4 1.1.7 1.7 1L9 21h6l.4-2.7c.6-.3 1.2-.6 1.7-1l2.5 1 2-3.5L19.4 13zM12 15.5a3.5 3.5 0 110-7 3.5 3.5 0 010 7z'],
  ];
  const NAV_TENANT = [
    ['overview', 'Тойм', 'M3 13h8V3H3v10zm10 8h8V11h-8v10zM3 21h8v-6H3v6zm10-18v6h8V3h-8z'],
    ['locations', 'Байршил', 'M12 2C8.1 2 5 5.1 5 9c0 5.3 7 13 7 13s7-7.7 7-13c0-3.9-3.1-7-7-7zm0 9.5a2.5 2.5 0 110-5 2.5 2.5 0 010 5z'],
    ['devices', 'Төхөөрөмж', 'M4 6h16v10H4zM2 18h20v2H2z'],
    ['demographics', 'Зочны портрет', 'M16 11c1.7 0 3-1.3 3-3s-1.3-3-3-3-3 1.3-3 3 1.3 3 3 3zm-8 0c1.7 0 3-1.3 3-3S9.7 5 8 5 5 6.3 5 8s1.3 3 3 3zm0 2c-2.3 0-7 1.2-7 3.5V19h14v-2.5C15 14.2 10.3 13 8 13zm8 0c-.3 0-.6 0-1 .1 1.2.8 2 2 2 3.4V19h6v-2.5c0-2.3-4.7-3.5-7-3.5z'],
    ['reid', 'Давхардалгүй зочид', 'M12 4a4 4 0 110 8 4 4 0 010-8zm0 10c4.4 0 8 1.8 8 4v2H4v-2c0-2.2 3.6-4 8-4z'],
    ['settings', 'Тохиргоо', 'M19.4 13a7.7 7.7 0 000-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 00-1.7-1L15 3H9l-.4 2.7a7.4 7.4 0 00-1.7 1l-2.5-1-2 3.5L4.6 11a7.7 7.7 0 000 2l-2.1 1.6 2 3.5 2.5-1c.5.4 1.1.7 1.7 1L9 21h6l.4-2.7c.6-.3 1.2-.6 1.7-1l2.5 1 2-3.5L19.4 13zM12 15.5a3.5 3.5 0 110-7 3.5 3.5 0 010 7z'],
  ];
  let NAV = NAV_TENANT;
  function renderShell() {
    const isSuper = state.user.role === 'superadmin';
    app.innerHTML = `<div class="shell">
      <aside class="sidebar">
        <div class="brand"><div class="logo">F</div><div><b>Footfall</b><small>${esc(state.tenant ? state.tenant.name : 'Бүх байгууллага')}</small></div></div>
        <nav class="nav">${NAV.map(([k, t, d]) => `<a href="#${k}" data-page="${k}"><svg viewBox="0 0 24 24" fill="currentColor"><path d="${d}"/></svg><span>${t}</span></a>`).join('')}</nav>
        <div class="spacer"></div>
        <div class="userbox"><b>${esc(state.user.name || state.user.email)}</b>${esc(state.user.email)} · ${roleName(state.user.role)}<br>
          <a href="#" id="pwBtn">Нууц үг солих</a> · <a href="#" id="logoutBtn">Гарах</a></div>
      </aside>
      <main class="main">
        <div class="topbar"><h1 id="pageTitle"></h1>
          <div class="filters" id="globalFilters">
            ${isSuper ? `<select id="fTenant"><option value="">Бүх байгууллага</option>${state.tenants.map((t) => `<option value="${t.id}" ${String(t.id) === String(state.tenantId) ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>` : ''}
            <select id="fLocation"></select>
            <select id="fDevice"></select>
            <div class="seg" id="fRange">${[['today', 'Өнөөдөр'], ['7d', '7 хоног'], ['30d', '30 хоног'], ['90d', '90 хоног'], ['custom', 'Хугацаа']].map(([k, t]) => `<button data-r="${k}" class="${state.range === k ? 'active' : ''}">${t}</button>`).join('')}</div>
            <span id="customRange" ${state.range === 'custom' ? '' : 'hidden'}><input type="date" id="fFrom" value="${state.from}"> – <input type="date" id="fTo" value="${state.to}"></span>
            <button class="btn" id="refreshBtn" title="Шинэчлэх">↻</button>
          </div></div>
        <div id="page"></div>
      </main></div>`;
    fillLocationSelects();
    $('#logoutBtn').onclick = async (e) => { e.preventDefault(); await api('/dash/auth/logout', { method: 'POST' }); location.hash = ''; renderLogin(); };
    $('#pwBtn').onclick = (e) => { e.preventDefault(); passwordModal(); };
    if (isSuper) $('#fTenant').onchange = async (e) => { state.tenantId = e.target.value; state.locationId = ''; state.sn = ''; await loadMeta(); fillLocationSelects(); render(); };
    $('#fLocation').onchange = (e) => { state.locationId = e.target.value; state.sn = ''; fillLocationSelects(); render(); };
    $('#fDevice').onchange = (e) => { state.sn = e.target.value; render(); };
    $('#fRange').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; state.range = b.dataset.r; [...$('#fRange').children].forEach((x) => x.classList.toggle('active', x === b)); $('#customRange').hidden = state.range !== 'custom'; if (state.range !== 'custom') render(); };
    $('#fFrom').onchange = $('#fTo').onchange = () => { state.from = $('#fFrom').value; state.to = $('#fTo').value; if (state.from && state.to) render(); };
    $('#refreshBtn').onclick = () => render();
    window.onhashchange = () => render();
  }
  const roleName = (r) => ({ superadmin: 'Супер админ', admin: 'Админ', viewer: 'Үзэгч' }[r] || r);
  function fillLocationSelects() {
    const locs = state.locations.filter((l) => !state.tenantId || String(l.tenant_id) === String(state.tenantId));
    $('#fLocation').innerHTML = `<option value="">Бүх байршил</option>` + locs.map((l) => `<option value="${l.id}" ${String(l.id) === String(state.locationId) ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
    const devs = state.devices.filter((d) => (!state.tenantId || String(d.tenant_id) === String(state.tenantId)) && (!state.locationId || String(d.location_id) === String(state.locationId)));
    $('#fDevice').innerHTML = `<option value="">Бүх төхөөрөмж</option>` + devs.map((d) => `<option value="${d.sn}" ${d.sn === state.sn ? 'selected' : ''}>${esc(d.name || d.sn)}</option>`).join('');
  }
  async function loadMeta() {
    const tq = state.tenantId ? '?tenant_id=' + state.tenantId : '';
    const [locs, devs] = await Promise.all([api('/dash/locations' + tq), api('/dash/devices' + tq)]);
    state.locations = locs; state.devices = devs;
    if (state.user.role === 'superadmin') state.tenants = await api('/dash/tenants');
  }

  async function boot() {
    try {
      const me = await api('/dash/auth/me');
      state.user = me.user; state.tenant = me.tenant;
    } catch { return renderLogin(); }
    NAV = state.user.role === 'superadmin' ? NAV_SUPER : NAV_TENANT;
    chartDefaults();
    await loadMeta();
    renderShell();
    render();
  }

  // ================= ROUTER =================
  async function render() {
    const home = NAV[0][0]; // superadmin → 'admin', бусад → 'overview'
    const page = (location.hash || '#' + home).slice(1).split('/')[0];
    state.page = NAV.some((n) => n[0] === page) ? page : home;
    document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === state.page));
    $('#pageTitle').textContent = NAV.find((n) => n[0] === state.page)[1];
    // Superadmin-д огноо/байршлын шүүлтүүр хэрэггүй (байгууллагын өгөгдөл харахгүй)
    $('#globalFilters').style.display = (state.page === 'settings' || state.user.role === 'superadmin') ? 'none' : '';
    killCharts();
    $('#page').innerHTML = '<div class="empty">Ачаалж байна…</div>';
    try { await PAGES[state.page](); } catch (e) { $('#page').innerHTML = `<div class="card err">Алдаа: ${esc(e.message)}</div>`; }
  }

  // ================= OVERVIEW =================
  async function pageOverview() {
    const g = gran();
    const { days } = rangeDates();
    const [ov, prev, heat] = await Promise.all([
      api('/dash/overview' + qs({ granularity: g })),
      api('/dash/flow/totals' + qs({ from: shift(rangeDates().from, -days), to: rangeDates().from })),
      api('/dash/flow/heatmap' + qs()),
    ]);
    const t = ov.totals;
    const delta = (cur, pre) => { if (!pre) return '<span class="delta">өмнөх үе: —</span>'; const d = Math.round(((cur - pre) / pre) * 100); return `<span class="delta ${d > 0 ? 'up' : d < 0 ? 'down' : ''}">${d > 0 ? '▲' : d < 0 ? '▼' : '•'} ${Math.abs(d)}% өмнөх үетэй харьцуулахад</span>`; };
    const online = ov.by_device.filter((d) => d.online).length;
    if (g === 'hour') { // хоосон цагуудыг 0-оор дүүргэнэ
      const day = (ov.series[0] ? ov.series[0].bucket : rangeDates().from).slice(0, 10);
      const m = {}; ov.series.forEach((s) => { m[s.bucket.slice(0, 13)] = s; });
      ov.series = [...Array(24)].map((_, h) => m[`${day}T${String(h).padStart(2, '0')}`] || { bucket: `${day}T${String(h).padStart(2, '0')}:00:00`, in_count: 0, out_count: 0, passby: 0, turnback: 0 });
    }
    $('#page').innerHTML = `
      <div class="grid g-kpi">
        <div class="card kpi accent"><div class="label">Орсон</div><div class="value">${fmt(t.in_count)}</div>${delta(t.in_count, prev.in_count)}</div>
        <div class="card kpi"><div class="label">Гарсан</div><div class="value">${fmt(t.out_count)}</div>${delta(t.out_count, prev.out_count)}</div>
        <div class="card kpi"><div class="label">Одоо байгаа хүн</div><div class="value">${fmt(ov.occupancy.total)}</div><span class="delta">бодит цагийн тооцоо</span></div>
        <div class="card kpi"><div class="label">Өнгөрсөн (орохгүй)</div><div class="value">${fmt(t.passby)}</div><span class="delta">орох хувь: ${pct(t.in_count, t.in_count + t.passby)}</span></div>
        <div class="card kpi"><div class="label">Буцсан</div><div class="value">${fmt(t.turnback)}</div>${delta(t.turnback, prev.turnback)}</div>
        <div class="card kpi"><div class="label">Дундаж байх хугацаа</div><div class="value">${dur(t.avg_stay_ms)}</div><span class="delta">камерын талбайд</span></div>
        <div class="card kpi"><div class="label">Төхөөрөмж</div><div class="value">${online}<span class="muted" style="font-size:16px">/${ov.by_device.length}</span></div><span class="delta ${online < ov.by_device.length ? 'down' : 'up'}">${online < ov.by_device.length ? ov.by_device.length - online + ' offline' : 'бүгд online'}</span></div>
      </div>
      <div class="grid g-2 section">
        <div class="card"><div class="head"><h2>Хүний урсгал</h2><span class="sub">${g === 'hour' ? 'цагаар' : g === 'day' ? 'өдрөөр' : '7 хоногоор'}</span></div><div class="chart-wrap"><canvas id="cFlow"></canvas></div></div>
        <div class="card"><div class="head"><h2>Байршлаар</h2><span class="sub">орсон хүн</span></div><div class="tbl-wrap"><table><thead><tr><th>Байршил</th><th class="num">Орсон</th><th class="num">Гарсан</th><th>Хувь</th></tr></thead><tbody>
          ${ov.by_location.length ? ov.by_location.map((l) => `<tr><td><a href="#locations">${esc(l.location_name)}</a><br><span class="small muted">${esc(l.tenant_name)} · ${l.online_count}/${l.device_count} online</span></td><td class="num">${fmt(l.in_count)}</td><td class="num">${fmt(l.out_count)}</td><td style="width:120px"><div class="bar"><i style="width:${pct(l.in_count, ov.by_location[0].in_count)}"></i></div></td></tr>`).join('') : '<tr><td colspan="4" class="empty">Байршил байхгүй</td></tr>'}
        </tbody></table></div></div>
      </div>
      <div class="grid g-2 section">
        <div class="card"><div class="head"><h2>Долоо хоногийн өдөр × цаг</h2><span class="sub">орсон хүний нягтрал</span></div><div id="heat"></div></div>
        <div class="card"><div class="head"><h2>Одоо байгаа хүн</h2><span class="sub">төхөөрөмж бүрээр</span></div><div class="tbl-wrap"><table><thead><tr><th>Төхөөрөмж</th><th class="num">Одоо</th><th class="num">Өнөөдөр орсон</th></tr></thead><tbody>
          ${ov.occupancy.devices.map((d) => `<tr><td>${esc(d.name || d.sn)}<br><span class="small muted">${d.from_snapshot ? 'төхөөрөмжийн мэдээ ' + ago(d.snapshot_at) : 'орсон − гарсан'}</span></td><td class="num"><b>${fmt(d.current)}</b></td><td class="num">${fmt(d.in_today)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">Өгөгдөл байхгүй</td></tr>'}
        </tbody></table></div></div>
      </div>`;
    mk('cFlow', {
      type: g === 'hour' ? 'line' : 'bar',
      data: { labels: ov.series.map((s) => bucketLabel(s.bucket, g)), datasets: [
        { label: 'Орсон', data: ov.series.map((s) => s.in_count), borderColor: css('--s1'), backgroundColor: g === 'hour' ? css('--s1') + '22' : css('--s1'), fill: g === 'hour', tension: .3, pointRadius: 0, borderWidth: 2, borderRadius: 4 },
        { label: 'Гарсан', data: ov.series.map((s) => s.out_count), borderColor: css('--s2'), backgroundColor: css('--s2'), tension: .3, pointRadius: 0, borderWidth: 2, borderRadius: 4 },
        { label: 'Өнгөрсөн', data: ov.series.map((s) => s.passby), borderColor: css('--s3'), backgroundColor: css('--s3'), tension: .3, pointRadius: 0, borderWidth: 2, borderRadius: 4, hidden: g !== 'hour' },
      ] },
      options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, grid: { color: css('--border') } } }, plugins: { legend: { position: 'top', align: 'end' } } },
    });
    renderHeat(heat);
  }
  const shift = (iso, days) => new Date(new Date(iso).getTime() + days * 86400000).toISOString();
  function renderHeat(rows) {
    const max = Math.max(1, ...rows.map((r) => r.in_count));
    const m = {}; rows.forEach((r) => { m[r.dow + '_' + r.hour] = r.in_count; });
    let h = '<div class="heat"><div></div>' + [...Array(24)].map((_, i) => `<div class="h">${i}</div>`).join('');
    for (let d = 1; d <= 7; d++) { h += `<div class="d">${DOW[d - 1]}</div>`; for (let i = 0; i < 24; i++) { const v = m[d + '_' + i] || 0; h += `<div class="c" title="${DOW[d - 1]} ${i}:00 — ${fmt(v)} хүн" style="opacity:${v ? (0.15 + 0.85 * v / max).toFixed(2) : 0.04}"></div>`; } }
    $('#heat').innerHTML = h + '</div>';
  }

  // ================= LOCATIONS =================
  async function pageLocations() {
    const g = gran();
    const [byLoc, series] = await Promise.all([api('/dash/flow/totals' + qs()), api('/dash/overview' + qs({ granularity: g }))]);
    const locs = series.by_location;
    $('#page').innerHTML = `<div class="stack">
      <div class="card"><div class="head"><h2>Байршлын харьцуулалт</h2><span class="sub">сонгосон хугацаанд</span></div><div class="chart-wrap sm"><canvas id="cLoc"></canvas></div></div>
      <div class="card"><div class="tbl-wrap"><table><thead><tr><th>Байршил</th><th>Байгууллага</th><th class="num">Орсон</th><th class="num">Гарсан</th><th class="num">Өнгөрсөн</th><th class="num">Буцсан</th><th class="num">Орох хувь</th><th>Төхөөрөмж</th><th></th></tr></thead><tbody>
        ${locs.map((l) => `<tr><td><b>${esc(l.location_name)}</b></td><td>${esc(l.tenant_name)}</td><td class="num">${fmt(l.in_count)}</td><td class="num">${fmt(l.out_count)}</td><td class="num">${fmt(l.passby)}</td><td class="num">${fmt(l.turnback)}</td><td class="num">${pct(l.in_count, l.in_count + l.passby)}</td>
          <td><span class="pill ${l.online_count === l.device_count && l.device_count ? 'on' : l.device_count ? 'warn' : 'na'}"><i class="dot"></i>${l.online_count}/${l.device_count} online</span></td>
          <td><button class="btn sm" data-loc="${l.location_id}">Дэлгэрэнгүй</button></td></tr>`).join('') || '<tr><td colspan="9" class="empty">Байршил бүртгээгүй. Тохиргоо хэсгээс нэмнэ үү.</td></tr>'}
      </tbody></table></div></div></div>`;
    $('#page').onclick = (e) => { const b = e.target.closest('[data-loc]'); if (b) { state.locationId = b.dataset.loc; state.sn = ''; fillLocationSelects(); location.hash = '#overview'; } };
    mk('cLoc', { type: 'bar', data: { labels: locs.map((l) => l.location_name), datasets: [
      { label: 'Орсон', data: locs.map((l) => l.in_count), backgroundColor: css('--s1'), borderRadius: 4 },
      { label: 'Өнгөрсөн', data: locs.map((l) => l.passby), backgroundColor: css('--s3'), borderRadius: 4 }] },
      options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, scales: { x: { beginAtZero: true, grid: { color: css('--border') } }, y: { grid: { display: false } } }, plugins: { legend: { position: 'top', align: 'end' } } } });
  }

  // ================= DEVICES =================
  async function pageDevices() {
    const isSuper = state.user.role === 'superadmin';
    const devs = await api('/dash/devices' + (isSuper ? '' : qs()));
    // Superadmin урсгалын тоо харахгүй — зөвхөн төхөөрөмжийн төлөв
    const flow = isSuper ? { by_device: [] } : await api('/dash/overview' + qs({ granularity: 'day' }));
    const fm = {}; flow.by_device.forEach((d) => { fm[d.sn] = d; });
    const canEdit = ['superadmin', 'admin'].includes(state.user.role);
    const unassigned = devs.filter((d) => !d.location_id);
    $('#page').innerHTML = `<div class="stack">
      ${unassigned.length ? `<div class="card" style="border-color:var(--warn)"><b>⚠ ${unassigned.length} шинэ төхөөрөмж байршилд оноогдоогүй байна.</b> <span class="muted">Төхөөрөмж сервер рүү өгөгдөл илгээж эхэлмэгц энд автоматаар бүртгэгдэнэ — нэр, байршил оноож өгнө үү.</span></div>` : ''}
      <div class="card"><div class="tbl-wrap"><table><thead><tr><th>Төлөв</th><th>Нэр / SN</th><th>Байршил</th><th>Сүүлийн heartbeat</th><th>Сүүлийн өгөгдөл</th><th>Холболт</th><th>Firmware</th>${isSuper ? '' : '<th class="num">Орсон</th><th class="num">Гарсан</th>'}<th></th></tr></thead><tbody>
        ${devs.map((d) => `<tr>
          <td><span class="pill ${d.online ? 'on' : d.last_heartbeat ? 'off' : 'na'}"><i class="dot"></i>${d.online ? 'Online' : d.last_heartbeat ? 'Offline' : 'Мэдээгүй'}</span></td>
          <td><b>${esc(d.name || '(нэргүй)')}</b><br><span class="mono muted">${esc(d.sn)}</span></td>
          <td>${d.location_name ? esc(d.location_name) + '<br><span class="small muted">' + esc(d.tenant_name || '') + '</span>' : '<span class="pill warn">Оноогоогүй</span>'}</td>
          <td title="${fmtDT(d.last_heartbeat)}">${ago(d.last_heartbeat)}</td><td title="${fmtDT(d.last_data_at)}">${ago(d.last_data_at)}</td>
          <td class="small">${esc(d.connection_type || '—')} · ${esc(d.ip_address || '—')}<br><span class="muted mono">${esc(d.mac_address || '')}</span></td>
          <td class="small">${esc(d.sw_release || '—')}<br><span class="muted">${esc(d.hw_platform || '')} · ${d.upload_interval === 0 ? 'бодит цаг' : d.upload_interval + ' мин'} · ${d.data_mode}</span></td>
          ${isSuper ? '' : `<td class="num">${fmt(fm[d.sn] ? fm[d.sn].in_count : 0)}</td><td class="num">${fmt(fm[d.sn] ? fm[d.sn].out_count : 0)}</td>`}
          <td><div style="display:flex;flex-direction:column;gap:4px;align-items:flex-start">${canEdit ? `<button class="btn sm" data-edit="${d.sn}">Засах</button><button class="btn sm" data-resync="${d.sn}">Дахин татах</button>` : ''}<button class="btn sm" data-hb="${d.sn}">Лог</button></div></td></tr>`).join('') || '<tr><td colspan="10" class="empty">Төхөөрөмж хараахан холбогдоогүй байна. Төхөөрөмжийн Data Push тохиргоонд энэ серверийн хаягийг оруулна уу.</td></tr>'}
      </tbody></table></div></div>
      <div class="card"><div class="head"><h2>Төхөөрөмжийг холбох</h2>${canEdit ? '<button class="btn primary" id="claimBtn">+ SN-ээр төхөөрөмж нэмэх</button>' : ''}</div>
        <p class="muted small">HX-CCD21 удирдлагын хуудас → Settings → Data Push → HTTP → Add. Протокол: <b>${location.protocol === 'https:' ? 'HTTPS' : 'HTTP'}</b>, Сервер: <b>${location.hostname}</b>, Порт: <b>${location.port || (location.protocol === 'https:' ? 443 : 80)}</b>. Interface хэсэгт замуудыг доорх байдлаар тохируулна:</p>
        <div class="code">Heartbeat:    ${location.origin}/api/camera/heartBeat
Data upload:  ${location.origin}/api/camera/dataUpload
REID:         ${location.origin}/api/camera/reid
DUP:          ${location.origin}/api/camera/dup</div></div></div>`;
    $('#page').onclick = async (e) => {
      const ed = e.target.closest('[data-edit]'); const rs = e.target.closest('[data-resync]'); const hb = e.target.closest('[data-hb]');
      if (ed) deviceModal(devs.find((d) => d.sn === ed.dataset.edit));
      if (rs) resyncModal(rs.dataset.resync);
      if (e.target.id === 'claimBtn') claimModal();
      if (hb) { const rows = await api('/dash/devices/' + hb.dataset.hb + '/heartbeats'); modal(`<h2>Heartbeat лог — ${esc(hb.dataset.hb)}</h2><div class="tbl-wrap" style="max-height:60vh;overflow:auto"><table><thead><tr><th>Цаг</th><th>IP</th><th>Холболт</th><th>Firmware</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${fmtDT(r.ts)}</td><td>${esc(r.payload.ipAddress || '')}</td><td>${esc(r.payload.connectionType || '')}</td><td>${esc(r.payload.swRelease || '')}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">Хоосон</td></tr>'}</tbody></table></div>`); }
    };
  }
  function claimModal() {
    const locs = state.locations.filter((l) => !state.tenantId || String(l.tenant_id) === String(state.tenantId));
    modal(`<h2>Төхөөрөмж нэмэх</h2><p class="muted small">Төхөөрөмжийн арын наалт дээрх SN (жишээ: 201000002501090095)-ийг оруулна. Төхөөрөмж сервер рүү өгөгдөл илгээж эхлэхэд энэ байршилд автоматаар харагдана.</p>
      <form class="form" id="f"><label>SN<input name="sn" required class="mono" placeholder="2010000025..."></label><label>Нэр<input name="name" placeholder="Гол хаалга"></label>
      <label>Байршил<select name="location_id" required>${locs.map((l) => `<option value="${l.id}">${esc(l.tenant_name)} / ${esc(l.name)}</option>`).join('')}</select></label>
      <div class="actions"><button type="button" class="btn" data-close>Болих</button><button class="btn primary">Нэмэх</button></div></form>`, (bg, close) => {
      bg.querySelector('[data-close]').onclick = close;
      bg.querySelector('#f').onsubmit = async (e) => { e.preventDefault(); try { await api('/dash/devices/claim', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); toast('Төхөөрөмж нэмэгдлээ'); close(); await loadMeta(); fillLocationSelects(); render(); } catch (err) { toast(err.message); } };
    });
  }
  function deviceModal(d) {
    const isSuper = state.user.role === 'superadmin';
    const locs = state.locations.filter((l) => !isSuper || !state.tenantId || String(l.tenant_id) === String(state.tenantId));
    modal(`<h2>Төхөөрөмж засах</h2><div class="muted mono small" style="margin-bottom:10px">${esc(d.sn)}</div>
      <form class="form" id="f">
        <label>Нэр (жишээ: Гол хаалга)<input name="name" value="${esc(d.name)}"></label>
        <label>Байршил<select name="location_id"><option value="">— Оноогоогүй —</option>${locs.map((l) => `<option value="${l.id}" ${l.id === d.location_id ? 'selected' : ''}>${esc(l.tenant_name)} / ${esc(l.name)}</option>`).join('')}</select></label>
        <div class="row">
          <label>Илгээх давтамж<select name="upload_interval">${[[0, 'Бодит цаг'], [1, '1 минут'], [5, '5 минут'], [60, '60 минут']].map(([v, t]) => `<option value="${v}" ${v === d.upload_interval ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
          <label>Өгөгдлийн горим<select name="data_mode"><option value="Add" ${d.data_mode === 'Add' ? 'selected' : ''}>Add (нэмэгдэл)</option><option value="Total" ${d.data_mode === 'Total' ? 'selected' : ''}>Total (нийлбэр)</option></select></label>
        </div>
        <label>Цагийн бүс (GMT+)<input type="number" name="timezone_offset" value="${d.timezone_offset}"></label>
        <p class="small muted">Давтамж, горим, цагийн бүсийг дараагийн heartbeat-д төхөөрөмж рүү илгээнэ.</p>
        <div class="actions"><button type="button" class="btn" data-close>Болих</button><button class="btn primary">Хадгалах</button></div></form>`,
      (bg, close) => {
        bg.querySelector('[data-close]').onclick = close;
        bg.querySelector('#f').onsubmit = async (e) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); try { await api('/dash/devices/' + d.sn, { method: 'PUT', body: f }); toast('Хадгалагдлаа'); close(); await loadMeta(); fillLocationSelects(); render(); } catch (err) { toast(err.message); } };
      });
  }
  function resyncModal(sn) {
    modal(`<h2>Түүхэн өгөгдөл дахин татах</h2><p class="muted small">Төхөөрөмж сүүлийн 90 хоногийн өгөгдлийг өөр дээрээ хадгалдаг. Сонгосон хугацааны өгөгдлийг дараагийн heartbeat-д дахин илгээхийг хүснэ.</p>
      <form class="form" id="f"><div class="row"><label>Эхлэх<input type="date" name="from" required value="${ubDate(-7)}"></label><label>Дуусах<input type="date" name="to" required value="${ubDate(0)}"></label></div>
      <div class="actions"><button type="button" class="btn" data-close>Болих</button><button class="btn primary">Хүсэлт илгээх</button></div></form>`,
      (bg, close) => { bg.querySelector('[data-close]').onclick = close; bg.querySelector('#f').onsubmit = async (e) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); try { await api('/dash/devices/' + sn + '/resync', { method: 'POST', body: { from: f.from + 'T00:00:00+08:00', to: f.to + 'T23:59:59+08:00' } }); toast('Хүсэлт бүртгэгдлээ — дараагийн heartbeat-д илгээнэ'); close(); } catch (err) { toast(err.message); } }; });
  }

  // ================= DEMOGRAPHICS =================
  async function pageDemographics() {
    const [d, dd] = await Promise.all([api('/dash/demographics' + qs()), api('/dash/dedup' + qs({ from: rangeDates().from.slice(0, 10), to: rangeDates().to.slice(0, 10) }))]);
    const gm = {}; d.gender.forEach((g) => { gm[g.gender] = g.n; });
    const male = gm[1] || 0, female = gm[2] || 0, unk = (gm[0] || 0) + (gm[-1] || 0);
    const total = male + female + unk;
    const ageRows = AGE_ORDER.map((k) => { const r = d.age_gender.filter((x) => x.age_group === k); return { k, male: r.filter((x) => x.gender === 1).reduce((s, x) => s + x.n, 0), female: r.filter((x) => x.gender === 2).reduce((s, x) => s + x.n, 0) }; }).filter((r) => r.male + r.female > 0 || r.k !== 'unknown');
    const agg = dd.aggregate;
    $('#page').innerHTML = `
      <div class="grid g-kpi">
        <div class="card kpi"><div class="label">Танигдсан зочин</div><div class="value">${fmt(total)}</div><span class="delta">орсон, ажилтныг хассан</span></div>
        <div class="card kpi"><div class="label">Эрэгтэй</div><div class="value">${pct(male, total)}</div><span class="delta">${fmt(male)} хүн</span></div>
        <div class="card kpi"><div class="label">Эмэгтэй</div><div class="value">${pct(female, total)}</div><span class="delta">${fmt(female)} хүн</span></div>
        <div class="card kpi"><div class="label">Ажилтан (картаар)</div><div class="value">${fmt(d.staff)}</div><span class="delta">${pct(d.staff, d.total)} нийт орсноос</span></div>
        <div class="card kpi"><div class="label">Тэргэнцэртэй</div><div class="value">${fmt(d.wheelchair)}</div></div>
        <div class="card kpi"><div class="label">Дундаж өндөр</div><div class="value">${d.avg_height_cm ? d.avg_height_cm + ' см' : '—'}</div><span class="delta">хүүхэд (<140см): ${fmt(d.children_by_height)}</span></div>
      </div>
      <div class="grid g-2 section">
        <div class="card"><div class="head"><h2>Насны бүлэг × хүйс</h2><span class="sub">орсон хүн</span></div><div class="chart-wrap"><canvas id="cAge"></canvas></div></div>
        <div class="card"><div class="head"><h2>Хүйсийн харьцаа</h2></div><div class="chart-wrap sm"><canvas id="cGender"></canvas></div>
          <table style="margin-top:10px"><tbody><tr><td><span class="legend"><span style="--c:var(--s1)">Эрэгтэй</span></span></td><td class="num">${fmt(male)}</td><td class="num">${pct(male, total)}</td></tr><tr><td><span class="legend"><span style="--c:var(--s5)">Эмэгтэй</span></span></td><td class="num">${fmt(female)}</td><td class="num">${pct(female, total)}</td></tr>${unk ? `<tr><td><span class="legend"><span style="--c:var(--muted)">Тодорхойгүй</span></span></td><td class="num">${fmt(unk)}</td><td class="num">${pct(unk, total)}</td></tr>` : ''}</tbody></table></div>
      </div>
      <div class="card section"><div class="head"><h2>Давхардал арилгасан зочны бүтэц (DUP тайлан)</h2><span class="sub">төхөөрөмжийн өдрийн тайлангаас нэгтгэв</span></div>
        ${agg.deduped ? `<div class="grid g-kpi" style="margin-bottom:14px">
          <div class="kpi"><div class="label">Түүхий тоо</div><div class="value">${fmt(agg.raw)}</div></div>
          <div class="kpi"><div class="label">Давхардсан</div><div class="value">${fmt(agg.duplicate)}</div><span class="delta">${pct(agg.duplicate, agg.raw)}</span></div>
          <div class="kpi"><div class="label">Давхардалгүй</div><div class="value">${fmt(agg.deduped)}</div></div>
          <div class="kpi"><div class="label">Жинхэнэ зочин</div><div class="value">${fmt(agg.customer)}</div><span class="delta">насанд хүрэгч ${fmt(agg.adult)} · хүүхэд ${fmt(agg.child)}</span></div>
          <div class="kpi"><div class="label">Зочин бус</div><div class="value">${fmt(agg.non_customer)}</div><span class="delta">ажилтан ${agg.staff} · rider ${agg.rider} · courier ${agg.courier}</span></div></div>
          <div class="tbl-wrap"><table><thead><tr><th>Насны бүлэг</th><th class="num">Эрэгтэй</th><th class="num">Эмэгтэй</th><th class="num">Тодорхойгүй</th><th class="num">Нийт</th><th style="width:30%"></th></tr></thead><tbody>
          ${AGE_ORDER.filter((k) => agg.age_gender[k]).map((k) => { const v = agg.age_gender[k]; const n = v.male + v.female + v.unknown; return `<tr><td>${AGE_LABEL[k]}</td><td class="num">${fmt(v.male)}</td><td class="num">${fmt(v.female)}</td><td class="num">${fmt(v.unknown)}</td><td class="num"><b>${fmt(n)}</b></td><td><div class="bar"><i style="width:${pct(n, agg.customer)}"></i></div></td></tr>`; }).join('')}</tbody></table></div>`
        : '<div class="empty">Энэ хугацаанд DUP тайлан ирээгүй байна. Төхөөрөмж ажлын цаг дууссаны дараа өдөр бүр илгээнэ.</div>'}
      </div>`;
    mk('cAge', { type: 'bar', data: { labels: ageRows.map((r) => AGE_LABEL[r.k]), datasets: [
      { label: 'Эрэгтэй', data: ageRows.map((r) => r.male), backgroundColor: css('--s1'), borderRadius: 4 },
      { label: 'Эмэгтэй', data: ageRows.map((r) => r.female), backgroundColor: css('--s5'), borderRadius: 4 }] },
      options: { responsive: true, maintainAspectRatio: false, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, grid: { color: css('--border') } } }, plugins: { legend: { position: 'top', align: 'end' } } } });
    mk('cGender', { type: 'doughnut', data: { labels: ['Эрэгтэй', 'Эмэгтэй', 'Тодорхойгүй'], datasets: [{ data: [male, female, unk], backgroundColor: [css('--s1'), css('--s5'), css('--muted')], borderWidth: 2, borderColor: css('--surface') }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: '65%', plugins: { legend: { display: false } } } });
  }

  // ================= REID =================
  async function pageReid() {
    const r = await api('/dash/reid' + qs({ from: rangeDates().from.slice(0, 10), to: rangeDates().to.slice(0, 10) }));
    const s = r.summary;
    const order = ['<1м', '1-5м', '5-15м', '15-30м', '30-60м', '>60м'];
    const dm = {}; r.dwell_distribution.forEach((x) => { dm[x.bucket] = x.n; });
    $('#page').innerHTML = `
      <div class="grid g-kpi">
        <div class="card kpi accent"><div class="label">Давхардалгүй зочин</div><div class="value">${fmt(s.unique_visitors)}</div><span class="delta">REID-ээр танигдсан</span></div>
        <div class="card kpi"><div class="label">Жинхэнэ зочин</div><div class="value">${fmt(s.customers)}</div><span class="delta">ажилтан ${fmt(s.staff)} · хүргэлт ${fmt(s.riders_couriers)}</span></div>
        <div class="card kpi"><div class="label">Давтан орсон</div><div class="value">${fmt(s.repeat_visitors)}</div><span class="delta">${pct(s.repeat_visitors, s.unique_visitors)} нэг өдөрт 2+ удаа</span></div>
        <div class="card kpi"><div class="label">Дундаж байх хугацаа</div><div class="value">${dur(s.avg_dwell_ms)}</div><span class="delta">нэг зочинд</span></div>
        <div class="card kpi"><div class="label">Эрэгтэй / Эмэгтэй</div><div class="value">${pct(s.male, s.male + s.female)} <span class="muted" style="font-size:16px">/ ${pct(s.female, s.male + s.female)}</span></div></div>
        <div class="card kpi"><div class="label">Насанд хүрэгч / Хүүхэд</div><div class="value">${fmt(s.adults)} <span class="muted" style="font-size:16px">/ ${fmt(s.children)}</span></div></div>
      </div>
      <div class="grid g-2 section">
        <div class="card"><div class="head"><h2>Өдөр бүрийн давхардалгүй зочин</h2></div><div class="chart-wrap"><canvas id="cDaily"></canvas></div></div>
        <div class="card"><div class="head"><h2>Байх хугацааны тархалт</h2><span class="sub">зочид</span></div><div class="chart-wrap"><canvas id="cDwell"></canvas></div></div>
      </div>
      <div class="card section"><div class="head"><h2>Ирсэн REID тайлангууд</h2><span class="sub">${r.reports.length} тайлан</span></div><div class="tbl-wrap"><table><thead><tr><th>Огноо</th><th>Байршил</th><th>Мастер төхөөрөмж</th><th>Чиглэл</th><th>Хамрагдсан SN</th><th class="num">Давхардалгүй</th><th>Ирсэн</th></tr></thead><tbody>
        ${r.reports.map((x) => `<tr><td>${x.report_date}</td><td>${esc(x.location_name || '—')}</td><td>${esc(x.device_name || x.master_sn)}</td><td>${x.direction === 'in' ? 'Орсон' : 'Гарсан'}</td><td class="mono small">${x.device_sns.join(', ')}</td><td class="num"><b>${fmt(x.unique_count)}</b></td><td class="small muted">${fmtDT(x.received_at)}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">REID тайлан ирээгүй. Төхөөрөмж ажлын цаг дууссаны дараа илгээнэ.</td></tr>'}
      </tbody></table></div></div>`;
    mk('cDaily', { type: 'bar', data: { labels: r.daily.map((x) => x.report_date.slice(5)), datasets: [
      { label: 'Зочин', data: r.daily.map((x) => x.customers), backgroundColor: css('--s1'), borderRadius: 4 },
      { label: 'Зочин бус', data: r.daily.map((x) => x.unique_visitors - x.customers), backgroundColor: css('--s4'), borderRadius: 4 }] },
      options: { responsive: true, maintainAspectRatio: false, scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, beginAtZero: true, grid: { color: css('--border') } } }, plugins: { legend: { position: 'top', align: 'end' } } } });
    mk('cDwell', { type: 'bar', data: { labels: order, datasets: [{ label: 'Зочин', data: order.map((k) => dm[k] || 0), backgroundColor: css('--s3'), borderRadius: 4 }] },
      options: { responsive: true, maintainAspectRatio: false, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, grid: { color: css('--border') } } }, plugins: { legend: { display: false } } } });
  }

  // ================= SETTINGS =================
  async function pageSettings() {
    const isSuper = state.user.role === 'superadmin';
    const isAdmin = isSuper || state.user.role === 'admin';
    const tabs = [['locations', 'Байршил'], ...(isAdmin ? [['users', 'Хэрэглэгч'], ['apikeys', 'API түлхүүр'], ['apidocs', 'API баримт']] : []), ...(isSuper ? [['tenants', 'Байгууллага'], ['log', 'Ingest лог']] : [])];
    let tab = (location.hash.split('/')[1]) || 'locations';
    if (!tabs.some((t) => t[0] === tab)) tab = 'locations';
    $('#page').innerHTML = `<div class="tabs">${tabs.map(([k, t]) => `<button class="${k === tab ? 'active' : ''}" data-tab="${k}">${t}</button>`).join('')}</div><div id="tab"></div>`;
    $('.tabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) location.hash = '#settings/' + b.dataset.tab; };
    await SETTINGS[tab]();
  }
  // Хэрэглэгч нэмэх modal. preset: { tenantId, tenantName, role } — байгууллагын мөрөөс «+ Админ» дарахад tenant/эрх урьдчилан тогтоно
  function userModal(preset = {}, after) {
    const isSuper = state.user.role === 'superadmin';
    const fixedTenant = preset.tenantId != null;
    modal(`<h2>${preset.role === 'admin' ? 'Байгууллагын админ нэмэх' : 'Хэрэглэгч нэмэх'}</h2>${fixedTenant ? `<p class="muted small">Байгууллага: <b>${esc(preset.tenantName || '')}</b></p>` : ''}<form class="form" id="f"><label>Нэр<input name="name"></label><label>И-мэйл<input type="email" name="email" required autocomplete="off"></label><label>Нууц үг<input type="password" name="password" required minlength="6" autocomplete="new-password"></label>
      <label>Эрх<select name="role"><option value="viewer" ${preset.role === 'viewer' ? 'selected' : ''}>Үзэгч — зөвхөн харах</option><option value="admin" ${preset.role === 'admin' ? 'selected' : ''}>Админ — байршил, төхөөрөмж, хэрэглэгч, API түлхүүр удирдах</option>${isSuper && !fixedTenant ? '<option value="superadmin">Супер админ — бүх байгууллага</option>' : ''}</select></label>
      ${fixedTenant ? `<input type="hidden" name="tenant_id" value="${preset.tenantId}">` : tenantSelect('tenant_id', state.tenantId || (state.tenants[0] || {}).id)}
      <div class="actions"><button type="button" class="btn" data-close>Болих</button><button class="btn primary">Нэмэх</button></div></form>`, (bg, close) => { bg.querySelector('[data-close]').onclick = close; bg.querySelector('#f').onsubmit = async (e) => { e.preventDefault(); try { const u = await api('/dash/users', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); toast(`${u.email} нэмэгдлээ`); close(); after && after(); } catch (err) { toast(err.message); } }; });
  }
  const tenantSelect = (name, sel) => state.user.role === 'superadmin' ? `<label>Байгууллага<select name="${name}" required>${state.tenants.map((t) => `<option value="${t.id}" ${String(t.id) === String(sel) ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>` : '';
  const SETTINGS = {
    async locations() {
      const locs = await api('/dash/locations');
      const isAdmin = ['superadmin', 'admin'].includes(state.user.role);
      $('#tab').innerHTML = `<div class="card"><div class="head"><h2>Байршил</h2>${isAdmin ? '<button class="btn primary" id="add">+ Байршил нэмэх</button>' : ''}</div><div class="tbl-wrap"><table><thead><tr><th>Нэр</th><th>Байгууллага</th><th>Хаяг</th><th>Цагийн бүс</th><th>Ажлын цаг</th><th>Төхөөрөмж</th><th></th></tr></thead><tbody>
        ${locs.map((l) => `<tr><td><b>${esc(l.name)}</b></td><td>${esc(l.tenant_name)}</td><td>${esc(l.address)}</td><td>${esc(l.timezone)}</td><td>${l.open_time.slice(0, 5)}–${l.close_time.slice(0, 5)}</td><td>${l.online_count}/${l.device_count} online</td><td style="white-space:nowrap">${isAdmin ? `<button class="btn sm" data-e="${l.id}">Засах</button> <button class="btn sm danger" data-d="${l.id}">Устгах</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">Байршил байхгүй</td></tr>'}</tbody></table></div></div>`;
      const form = (l = {}) => modal(`<h2>${l.id ? 'Байршил засах' : 'Байршил нэмэх'}</h2><form class="form" id="f">
        ${l.id ? '' : tenantSelect('tenant_id', state.tenantId || (state.tenants[0] || {}).id)}
        <label>Нэр<input name="name" required value="${esc(l.name || '')}"></label><label>Хаяг<input name="address" value="${esc(l.address || '')}"></label>
        <div class="row"><label>Цагийн бүс<input name="timezone" value="${esc(l.timezone || 'Asia/Ulaanbaatar')}"></label><label>Нээх / Хаах<div style="display:flex;gap:6px"><input type="time" name="open_time" value="${(l.open_time || '09:00').slice(0, 5)}"><input type="time" name="close_time" value="${(l.close_time || '21:00').slice(0, 5)}"></div></label></div>
        <div class="actions"><button type="button" class="btn" data-close>Болих</button><button class="btn primary">Хадгалах</button></div></form>`, (bg, close) => {
        bg.querySelector('[data-close]').onclick = close;
        bg.querySelector('#f').onsubmit = async (e) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); try { await api(l.id ? '/dash/locations/' + l.id : '/dash/locations', { method: l.id ? 'PUT' : 'POST', body: f }); toast('Хадгалагдлаа'); close(); await loadMeta(); SETTINGS.locations(); } catch (err) { toast(err.message); } };
      });
      if ($('#add')) $('#add').onclick = () => form();
      $('#tab').onclick = async (e) => { const ed = e.target.closest('[data-e]'); const del = e.target.closest('[data-d]'); if (ed) form(locs.find((l) => String(l.id) === ed.dataset.e)); if (del && confirm('Байршлыг устгах уу? Төхөөрөмжүүд оноогоогүй болно.')) { await api('/dash/locations/' + del.dataset.d, { method: 'DELETE' }); await loadMeta(); SETTINGS.locations(); } };
    },
    async tenants() {
      const ts = await api('/dash/tenants');
      $('#tab').innerHTML = `<div class="card"><div class="head"><h2>Байгууллага (tenant)</h2><button class="btn primary" id="add">+ Байгууллага нэмэх</button></div>
        <p class="muted small">Байгууллага үүсгэхдээ түүний админыг хамт үүсгэнэ. Админ өөрийн байгууллагынхаа байршил, төхөөрөмж, хэрэглэгч, API түлхүүрийг удирдана.</p>
        <div class="tbl-wrap"><table><thead><tr><th>Нэр</th><th>Slug</th><th>Админ</th><th class="num">Байршил</th><th class="num">Төхөөрөмж</th><th class="num">Хэрэглэгч</th><th>Үүссэн</th><th></th></tr></thead><tbody>
        ${ts.map((t) => `<tr><td><b>${esc(t.name)}</b></td><td class="mono">${esc(t.slug)}</td><td class="small">${t.admin_emails ? esc(t.admin_emails) : '<span class="pill warn">Админгүй</span>'}</td><td class="num">${t.location_count}</td><td class="num">${t.device_count}</td><td class="num">${t.user_count}</td><td class="small muted">${fmtDT(t.created_at)}</td><td style="white-space:nowrap"><button class="btn sm" data-a="${t.id}">+ Админ</button> <button class="btn sm danger" data-d="${t.id}">Устгах</button></td></tr>`).join('') || '<tr><td colspan="8" class="empty">Байгууллага байхгүй</td></tr>'}</tbody></table></div></div>`;
      $('#add').onclick = () => modal(`<h2>Байгууллага нэмэх</h2><form class="form" id="f">
        <label>Байгууллагын нэр<input name="name" required placeholder="Номин Холдинг"></label><label>Slug (латин, сонголтот)<input name="slug" placeholder="nomin"></label>
        <h3 style="margin-top:6px">Байгууллагын админ</h3>
        <label>Админы нэр<input name="admin_name" placeholder="Б. Батаа"></label>
        <label>Админы и-мэйл<input type="email" name="admin_email" required autocomplete="off"></label>
        <label>Админы нууц үг<input type="password" name="admin_password" required minlength="6" autocomplete="new-password"></label>
        <p class="small muted">Админ энэ и-мэйл, нууц үгээр нэвтэрч орж өөрөө солино.</p>
        <div class="actions"><button type="button" class="btn" data-close>Болих</button><button class="btn primary">Байгууллага + админ үүсгэх</button></div></form>`, (bg, close) => { bg.querySelector('[data-close]').onclick = close; bg.querySelector('#f').onsubmit = async (e) => { e.preventDefault(); try { const t = await api('/dash/tenants', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); toast(`«${t.name}» үүслээ, админ: ${t.admin ? t.admin.email : '—'}`); close(); await loadMeta(); SETTINGS.tenants(); } catch (err) { toast(err.message); } }; });
      $('#tab').onclick = async (e) => {
        const add = e.target.closest('[data-a]'); const del = e.target.closest('[data-d]');
        if (add) { const t = ts.find((x) => String(x.id) === add.dataset.a); userModal({ tenantId: t.id, tenantName: t.name, role: 'admin' }, () => SETTINGS.tenants()); }
        if (del && confirm('Байгууллагыг бүх байршил, хэрэглэгч, API түлхүүрийн хамт устгах уу?')) { await api('/dash/tenants/' + del.dataset.d, { method: 'DELETE' }); await loadMeta(); SETTINGS.tenants(); }
      };
    },
    async users() {
      const us = await api('/dash/users' + (state.tenantId ? '?tenant_id=' + state.tenantId : ''));
      const isSuper = state.user.role === 'superadmin';
      $('#tab').innerHTML = `<div class="card"><div class="head"><h2>Хэрэглэгч</h2><button class="btn primary" id="add">+ Хэрэглэгч нэмэх</button></div><div class="tbl-wrap"><table><thead><tr><th>Нэр</th><th>И-мэйл</th><th>Эрх</th><th>Байгууллага</th><th></th></tr></thead><tbody>
        ${us.map((u) => `<tr><td><b>${esc(u.name)}</b></td><td>${esc(u.email)}</td><td>${roleName(u.role)}</td><td>${esc(u.tenant_name || 'Бүгд')}</td><td>${u.id !== state.user.uid ? `<button class="btn sm danger" data-d="${u.id}">Устгах</button>` : '<span class="muted small">та</span>'}</td></tr>`).join('')}</tbody></table></div></div>`;
      $('#add').onclick = () => userModal({}, () => SETTINGS.users());
      $('#tab').onclick = async (e) => { const del = e.target.closest('[data-d]'); if (del && confirm('Хэрэглэгчийг устгах уу?')) { await api('/dash/users/' + del.dataset.d, { method: 'DELETE' }); SETTINGS.users(); } };
    },
    async apikeys() {
      const ks = await api('/dash/api-keys' + (state.tenantId ? '?tenant_id=' + state.tenantId : ''));
      $('#tab').innerHTML = `<div class="card"><div class="head"><h2>API түлхүүр</h2><button class="btn primary" id="add">+ Түлхүүр үүсгэх</button></div>
        <p class="muted small">Гадаад систем (ERP, BI, Power BI, n8n г.м.) <code>X-API-Key</code> толгойгоор <code>${location.origin}/api/v1/…</code> руу хандаж тухайн байгууллагын өгөгдлийг татна. Түлхүүр зөвхөн үүсгэх үедээ бүтнээрээ харагдана.</p>
        <div class="tbl-wrap"><table><thead><tr><th>Нэр</th><th>Түлхүүр</th><th>Байгууллага</th><th>Сүүлд ашигласан</th><th>Үүссэн</th><th></th></tr></thead><tbody>
        ${ks.map((k) => `<tr><td><b>${esc(k.name)}</b></td><td class="mono">${esc(k.prefix)}…</td><td>${esc(k.tenant_name)}</td><td>${ago(k.last_used)}</td><td class="small muted">${fmtDT(k.created_at)}</td><td><button class="btn sm danger" data-d="${k.id}">Хүчингүй болгох</button></td></tr>`).join('') || '<tr><td colspan="6" class="empty">Түлхүүр байхгүй</td></tr>'}</tbody></table></div></div>`;
      $('#add').onclick = () => modal(`<h2>API түлхүүр үүсгэх</h2><form class="form" id="f"><label>Нэр (юунд ашиглах)<input name="name" required placeholder="ERP интеграц"></label>${tenantSelect('tenant_id', state.tenantId || (state.tenants[0] || {}).id)}<div class="actions"><button type="button" class="btn" data-close>Болих</button><button class="btn primary">Үүсгэх</button></div></form>`, (bg, close) => {
        bg.querySelector('[data-close]').onclick = close;
        bg.querySelector('#f').onsubmit = async (e) => { e.preventDefault(); try { const k = await api('/dash/api-keys', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); close(); modal(`<h2>Түлхүүр үүслээ</h2><p class="small">Энэ түлхүүрийг <b>одоо хуулж</b> аюулгүй газар хадгална уу — дахин харагдахгүй.</p><div class="keybox"><input class="mono" readonly value="${esc(k.key)}" id="kv"><button class="btn" id="cp">Хуулах</button></div><div class="code" style="margin-top:12px">curl -H "X-API-Key: ${esc(k.key)}" \\
  "${location.origin}/api/v1/flow/totals?from=${ubDate(-7)}&to=${ubDate(1)}"</div><div class="actions"><button class="btn primary" data-close>Хаах</button></div>`, (b2, c2) => { b2.querySelector('[data-close]').onclick = () => { c2(); SETTINGS.apikeys(); }; b2.querySelector('#cp').onclick = () => { navigator.clipboard.writeText(k.key); toast('Хуулагдлаа'); }; }); } catch (err) { toast(err.message); } };
      });
      $('#tab').onclick = async (e) => { const del = e.target.closest('[data-d]'); if (del && confirm('Түлхүүрийг хүчингүй болгох уу? Үүнийг ашигладаг интеграц ажиллахаа болино.')) { await api('/dash/api-keys/' + del.dataset.d, { method: 'DELETE' }); SETTINGS.apikeys(); } };
    },
    async apidocs() {
      const O = location.origin;
      const EP = [
        ['GET /api/v1/me', 'Түлхүүрийн байгууллага, эрх'],
        ['GET /api/v1/locations', 'Байршлын жагсаалт (төхөөрөмжийн тоо, online тоо)'],
        ['GET /api/v1/devices', 'Төхөөрөмжүүд: төлөв, сүүлийн heartbeat, IP, firmware'],
        ['GET /api/v1/flow/totals', 'Орсон/гарсан/өнгөрсөн/буцсан нийлбэр'],
        ['GET /api/v1/flow/series?granularity=hour|day|week|month', 'Цаг хугацааны цуваа'],
        ['GET /api/v1/flow/by-location', 'Байршил бүрээр нэгтгэл'],
        ['GET /api/v1/flow/by-device', 'Төхөөрөмж бүрээр нэгтгэл'],
        ['GET /api/v1/flow/records?limit=500', 'Түүхий интервалын бичлэгүүд'],
        ['GET /api/v1/flow/heatmap', 'Долоо хоногийн өдөр × цаг'],
        ['GET /api/v1/occupancy', 'Одоо байгаа хүн (төхөөрөмж бүрээр)'],
        ['GET /api/v1/demographics', 'Нас × хүйс, ажилтан, тэргэнцэр, өндөр'],
        ['GET /api/v1/events?limit=200', 'Хүн бүрийн үйл явдал (нас, хүйс, өндөр, байх хугацаа)'],
        ['GET /api/v1/reid', 'REID давхардалгүй зочид: нэгтгэл, өдрөөр, байх хугацааны тархалт, тайлангууд'],
        ['GET /api/v1/dedup', 'DUP тайлан: түүхий/давхардсан/давхардалгүй, зочин/зочин бус, нас×хүйс'],
      ];
      $('#tab').innerHTML = `<div class="card"><div class="head"><h2>REST API баримт (v1)</h2></div>
        <p><b>Хаяг:</b> <code>${O}/api/v1</code> &nbsp; <b>Нэвтрэлт:</b> <code>X-API-Key: hx_…</code> толгой (эсвэл <code>Authorization: Bearer hx_…</code>)</p>
        <p><b>Нийтлэг шүүлтүүр (query):</b> <code>from</code>, <code>to</code> (ISO огноо/цаг, жишээ <code>2026-09-01</code> эсвэл <code>2026-09-01T09:00:00+08:00</code>), <code>location_id</code>, <code>sn</code>, <code>tz</code> (анхдагч Asia/Ulaanbaatar). Өгөгдөл автоматаар түлхүүрийн байгууллагаар хязгаарлагдана.</p>
        <p><b>Хариу:</b> <code>{ "ok": true, "data": … }</code>; алдаа бол <code>{ "error": "…" }</code> HTTP 401/500.</p>
        <div class="tbl-wrap"><table><thead><tr><th>Endpoint</th><th>Тайлбар</th></tr></thead><tbody>${EP.map(([e, d]) => `<tr><td class="mono">${esc(e)}</td><td>${esc(d)}</td></tr>`).join('')}</tbody></table></div>
        <h3 style="margin-top:16px">Жишээ</h3>
        <div class="code">curl -H "X-API-Key: hx_XXXX" "${O}/api/v1/flow/series?granularity=day&from=${ubDate(-30)}&to=${ubDate(1)}&location_id=1"

# Хариу
{"ok":true,"granularity":"day","data":[{"bucket":"2026-09-01T00:00:00.000","in_count":812,"out_count":790,"passby":410,"turnback":31,"avg_stay_ms":2540}, …]}</div>
        <h3 style="margin-top:16px">Төхөөрөмжийн ingest endpoint (HX-CCD21 → сервер, протокол V2.5)</h3>
        <div class="code">POST ${O}/api/camera/heartBeat    — минут тутам; хариунд uploadInterval, dataMode, timezone, (dataStartTime/dataEndTime)
POST ${O}/api/camera/dataUpload   — урсгал (in/out/passby/turnback + attributes[]) болон residence (currentStay)
POST ${O}/api/camera/reid         — өдрийн REID тайлан
POST ${O}/api/camera/dup          — өдрийн DUP (realtime + final) тайлан</div></div>`;
    },
    async log() {
      const rows = await api('/dash/ingest-log');
      $('#tab').innerHTML = `<div class="card"><div class="head"><h2>Ingest алдааны лог</h2><span class="sub">сүүлийн 100 · амжилттай хүсэлт бүртгэгдэхгүй</span></div><div class="tbl-wrap"><table><thead><tr><th>Цаг</th><th>Зам</th><th>SN</th><th>Код</th><th>Мессеж</th><th>Body</th></tr></thead><tbody>
        ${rows.map((r) => `<tr><td class="small">${fmtDT(r.created_at)}</td><td class="mono">${esc(r.path)}</td><td class="mono">${esc(r.sn || '')}</td><td>${r.status}</td><td>${esc(r.message || '')}</td><td class="mono small" style="max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(JSON.stringify(r.body || {}))}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">Алдаа бүртгэгдээгүй 🎉</td></tr>'}</tbody></table></div></div>`;
    },
  };

  function passwordModal() {
    modal(`<h2>Нууц үг солих</h2><form class="form" id="f"><label>Одоогийн нууц үг<input type="password" name="current" required></label><label>Шинэ нууц үг<input type="password" name="next" required minlength="6"></label><div class="actions"><button type="button" class="btn" data-close>Болих</button><button class="btn primary">Солих</button></div></form>`, (bg, close) => { bg.querySelector('[data-close]').onclick = close; bg.querySelector('#f').onsubmit = async (e) => { e.preventDefault(); try { await api('/dash/auth/password', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); toast('Нууц үг солигдлоо'); close(); } catch (err) { toast(err.message); } }; });
  }

  // ================= SUPERADMIN: БАЙГУУЛЛАГУУД =================
  const bytes = (b) => (b == null ? '—' : b < 1048576 ? Math.round(b / 1024) + ' KB' : b < 1073741824 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1073741824).toFixed(2) + ' GB');
  async function pageAdmin() {
    const s = await api('/dash/admin/summary');
    const t = s.totals;
    const offline = t.devices - t.devices_online;
    const stale = (d) => !d || (Date.now() - new Date(d)) > 24 * 3600 * 1000; // 24 цагаас дээш өгөгдөл ирээгүй
    $('#page').innerHTML = `
      <div class="grid g-kpi">
        <div class="card kpi accent"><div class="label">Байгууллага</div><div class="value">${fmt(t.tenants)}</div><span class="delta">${fmt(t.locations)} байршил</span></div>
        <div class="card kpi"><div class="label">Төхөөрөмж</div><div class="value">${fmt(t.devices_online)}<span class="muted" style="font-size:16px">/${fmt(t.devices)}</span></div><span class="delta ${offline ? 'down' : 'up'}">${offline ? offline + ' offline' : t.devices ? 'бүгд online' : 'холбогдоогүй'}</span></div>
        <div class="card kpi"><div class="label">Оноогоогүй төхөөрөмж</div><div class="value">${fmt(t.devices_unassigned)}</div><span class="delta ${t.devices_unassigned ? 'down' : ''}">${t.devices_unassigned ? 'байршил оноох хэрэгтэй' : 'бүгд оноогдсон'}</span></div>
        <div class="card kpi"><div class="label">Хэрэглэгч</div><div class="value">${fmt(t.users)}</div><span class="delta">${fmt(t.superadmins)} супер админ</span></div>
        <div class="card kpi"><div class="label">API түлхүүр</div><div class="value">${fmt(t.api_keys)}</div><span class="delta">идэвхтэй</span></div>
        <div class="card kpi"><div class="label">Ingest алдаа</div><div class="value">${fmt(t.ingest_errors_24h)}</div><span class="delta ${t.ingest_errors_24h ? 'down' : 'up'}">сүүлийн 24 цагт</span></div>
        <div class="card kpi"><div class="label">Сүүлийн өгөгдөл</div><div class="value" style="font-size:20px">${ago(t.last_data_at)}</div><span class="delta">DB: ${bytes(t.db_bytes)}</span></div>
      </div>
      ${s.unassigned_devices.length ? `<div class="card section" style="border-color:var(--warn)"><div class="head"><h2>⚠ Оноогоогүй төхөөрөмж</h2><span class="sub">${s.unassigned_devices.length} ш — <a href="#devices">Төхөөрөмж хуудсанд</a> байршил оноож өгнө</span></div><div class="tbl-wrap"><table><thead><tr><th>Төлөв</th><th>SN</th><th>IP</th><th>Firmware</th><th>Анх холбогдсон</th><th>Сүүлийн heartbeat</th></tr></thead><tbody>
        ${s.unassigned_devices.map((d) => `<tr><td><span class="pill ${d.online ? 'on' : 'off'}"><i class="dot"></i>${d.online ? 'Online' : 'Offline'}</span></td><td class="mono">${esc(d.sn)}</td><td class="small">${esc(d.ip_address || '—')}</td><td class="small">${esc(d.sw_release || '—')}</td><td class="small muted">${fmtDT(d.first_seen)}</td><td>${ago(d.last_heartbeat)}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
      <div class="card section"><div class="head"><h2>Байгууллагууд</h2><span class="sub">${s.tenants.length} байгууллага · <a href="#settings/tenants">удирдах</a></span></div><div class="tbl-wrap"><table><thead><tr><th>Байгууллага</th><th>Админ</th><th class="num">Байршил</th><th>Төхөөрөмж</th><th class="num">Хэрэглэгч</th><th class="num">API</th><th>Сүүлийн өгөгдөл</th><th>Үүссэн</th></tr></thead><tbody>
        ${s.tenants.map((x) => `<tr>
          <td><b>${esc(x.name)}</b><br><span class="mono muted small">${esc(x.slug)}</span></td>
          <td class="small">${x.admin_emails ? esc(x.admin_emails) : '<span class="pill warn">Админгүй</span>'}</td>
          <td class="num">${fmt(x.location_count)}</td>
          <td><span class="pill ${x.device_count === 0 ? 'na' : x.online_count === x.device_count ? 'on' : x.online_count ? 'warn' : 'off'}"><i class="dot"></i>${x.online_count}/${x.device_count} online</span></td>
          <td class="num">${fmt(x.user_count)}</td>
          <td class="num" title="${x.api_last_used ? 'сүүлд ашигласан ' + fmtDT(x.api_last_used) : ''}">${fmt(x.api_key_count)}</td>
          <td title="${fmtDT(x.last_data_at)}" class="${x.device_count && stale(x.last_data_at) ? 'err' : ''}">${x.device_count ? ago(x.last_data_at) : '<span class="muted">төхөөрөмжгүй</span>'}</td>
          <td class="small muted">${fmtDT(x.created_at)}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">Байгууллага байхгүй — <a href="#settings/tenants">Тохиргоо → Байгууллага</a> хэсгээс үүсгэнэ</td></tr>'}
      </tbody></table></div></div>
      ${s.recent_errors.length ? `<div class="card section"><div class="head"><h2>Сүүлийн ingest алдаа</h2><span class="sub"><a href="#settings/log">бүгдийг харах</a></span></div><div class="tbl-wrap"><table><thead><tr><th>Цаг</th><th>Зам</th><th>SN</th><th>Код</th><th>Мессеж</th></tr></thead><tbody>
        ${s.recent_errors.map((r) => `<tr><td class="small">${fmtDT(r.created_at)}</td><td class="mono">${esc(r.path)}</td><td class="mono">${esc(r.sn || '')}</td><td>${r.status}</td><td>${esc(r.message || '')}</td></tr>`).join('')}</tbody></table></div></div>` : ''}`;
  }

  const PAGES = { admin: pageAdmin, overview: pageOverview, locations: pageLocations, devices: pageDevices, demographics: pageDemographics, reid: pageReid, settings: pageSettings };

  // Бодит цагийн шинэчлэл: тойм хуудсыг 60 сек тутам
  setInterval(() => { if (state.user && (state.page === 'overview' || state.page === 'admin') && !document.hidden && !document.querySelector('.modal-bg')) render(); }, 60000);
  boot();
})();

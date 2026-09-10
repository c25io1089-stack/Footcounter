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

  // Toast: type = 'success' | 'error' | 'info' (анхдагч success)
  const TOAST_ICO = {
    success: '<svg class="ti" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.3 2.3 4.7-5"/></svg>',
    error: '<svg class="ti" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>',
    info: '<svg class="ti" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
  };
  function toast(msg, type = 'success', ms = 3200) {
    let host = $('.toasts'); if (!host) { host = document.createElement('div'); host.className = 'toasts'; document.body.appendChild(host); }
    const t = document.createElement('div'); t.className = 'toast ' + type; t.setAttribute('role', 'status');
    t.innerHTML = TOAST_ICO[type] + '<div></div>'; t.lastChild.textContent = msg; host.appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 220); }, ms);
  }
  // Modal: × товч, ESC, арын дарамт — бүгд хаана. onMount(bg, close)
  function modal(html, onMount) {
    const bg = document.createElement('div'); bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><button class="x" type="button" aria-label="Хаах">✕</button>${html}</div>`;
    const close = () => { if (!bg.isConnected) return; bg.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
    bg.querySelector('.modal > .x').onclick = close;
    document.addEventListener('keydown', onKey);
    document.body.appendChild(bg);
    const first = bg.querySelector('input:not([type=hidden]), select, button:not(.x)'); if (first) setTimeout(() => first.focus(), 30);
    // Гарын focus trap: Tab/Shift+Tab modal дотор эргэлдэнэ
    bg.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const f = [...bg.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')];
      if (!f.length) return; const a = f[0], z = f[f.length - 1];
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); } else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    });
    onMount && onMount(bg, close);
    // Формын submit товч: хариу иртэл loading + давхар илгээхээс сэргийлнэ
    const form = bg.querySelector('form');
    if (form && form.onsubmit) { const h = form.onsubmit; form.onsubmit = (e) => withLoading(form.querySelector('button[type=submit], button.primary'), () => h.call(form, e)); }
    return bg;
  }
  // Баталгаажуулах диалог (native confirm-ийн оронд) → Promise<boolean>
  function confirmDlg(message, { title = 'Баталгаажуулах', ok = 'Тийм, үргэлжлүүлэх', danger = true } = {}) {
    return new Promise((resolve) => {
      modal(`<h2>${esc(title)}</h2><p style="margin:0;color:var(--text-2)">${esc(message)}</p><div class="actions"><button type="button" class="btn" data-no>Болих</button><button type="button" class="btn ${danger ? 'danger' : 'primary'}" data-yes>${esc(ok)}</button></div>`,
        (bg, close) => {
          let done = false; const fin = (v) => { if (done) return; done = true; close(); resolve(v); };
          bg.querySelector('[data-no]').onclick = () => fin(false); bg.querySelector('[data-yes]').onclick = () => fin(true);
          bg.querySelector('.modal > .x').onclick = () => fin(false); bg.addEventListener('click', (e) => { if (e.target === bg) fin(false); });
          setTimeout(() => bg.querySelector('[data-yes]').focus(), 30);
        });
    });
  }
  // Товчны loading төлөв: await withLoading(btn, async () => …)
  async function withLoading(btn, fn) { if (!btn) return fn(); btn.classList.add('loading'); try { return await fn(); } finally { btn.classList.remove('loading'); } }
  const initials = (s) => String(s || '?').trim().split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
  const skeleton = () => `<div class="grid g-kpi"><div class="skeleton sk-kpi"></div><div class="skeleton sk-kpi"></div><div class="skeleton sk-kpi"></div><div class="skeleton sk-kpi"></div></div><div class="grid g-2 section"><div class="skeleton sk-block"></div><div class="skeleton sk-block"></div></div>`;

  // ---- KPI карт: icon + label + value + delta chip + sparkline ----
  const ICO = {
    in: '<path d="M12 3v12m0 0 4-4m-4 4-4-4M4 21h16"/>', out: '<path d="M12 15V3m0 0 4 4m-4-4-4 4M4 21h16"/>',
    people: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    pass: '<path d="M4 12h16m0 0-5-5m5 5-5 5"/>', back: '<path d="M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-2"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', device: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    building: '<path d="M3 21h18M5 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M15 9h2a2 2 0 0 1 2 2v10M9 7h2M9 11h2M9 15h2"/>',
    warn: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/>',
    key: '<path d="m21 2-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zm0 0L19 4m-3 3 2 2"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>', db: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
    pulse: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  };
  const icon = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICO[n] || ICO.pulse}</svg>`;
  // kpi({label, value, sub, delta:{cur,prev,label}, ico, c (өнгө 1-8), spark:[..], accent})
  function kpi(o) {
    let chip = '';
    if (o.delta) {
      const { cur, prev } = o.delta;
      if (!prev) chip = `<span class="delta">өмнөх үе: —</span>`;
      else { const d = Math.round(((cur - prev) / prev) * 100); chip = `<span class="delta ${d > 0 ? 'up' : d < 0 ? 'down' : ''}" title="өмнөх ижил урттай үетэй харьцуулахад">${d > 0 ? '↑' : d < 0 ? '↓' : '•'} ${Math.abs(d)}%</span>`; }
    } else if (o.sub) chip = `<span class="delta ${o.subClass || ''}">${o.sub}</span>`;
    const spark = o.spark && o.spark.length > 1 ? `<div class="spark"><canvas data-v="${o.spark.join(',')}" data-c="${o.c || 1}"></canvas></div>` : '';
    return `<div class="card kpi ${o.accent ? 'accent' : ''}"><div class="top"><div class="ico c${o.c || 1}">${icon(o.ico)}</div><div class="label">${o.label}</div></div><div class="value">${o.value}</div><div class="bottom">${chip}${spark}</div></div>`;
  }
  function drawSparks() {
    document.querySelectorAll('.spark canvas').forEach((el, i) => {
      const v = el.dataset.v.split(',').map(Number); const col = css('--s' + el.dataset.c);
      const id = 'spark' + i + '_' + Date.now(); el.id = id;
      mk(id, { type: 'line', data: { labels: v.map((_, k) => k), datasets: [{ data: v, borderColor: col, backgroundColor: col + '22', fill: true, tension: .4, borderWidth: 1.5, pointRadius: 0 }] },
        options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false }, tooltip: { enabled: false } }, scales: { x: { display: false }, y: { display: false, beginAtZero: true } }, elements: { line: { capBezierPoints: true } } } });
    });
  }

  // ---- Chart helpers (Chart.js) ----
  function chartDefaults() {
    Chart.defaults.color = css('--text-2'); Chart.defaults.borderColor = css('--border');
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily; Chart.defaults.font.size = 12;
    Chart.defaults.plugins.legend.labels.boxWidth = 10; Chart.defaults.plugins.legend.labels.boxHeight = 10; Chart.defaults.plugins.legend.labels.usePointStyle = true; Chart.defaults.plugins.legend.labels.pointStyle = 'circle';
    Chart.defaults.plugins.tooltip.backgroundColor = css('--text'); Chart.defaults.plugins.tooltip.titleColor = css('--bg'); Chart.defaults.plugins.tooltip.bodyColor = css('--bg');
    Chart.defaults.plugins.tooltip.padding = 10; Chart.defaults.plugins.tooltip.cornerRadius = 8; Chart.defaults.plugins.tooltip.displayColors = true; Chart.defaults.plugins.tooltip.boxPadding = 4;
    Chart.defaults.elements.bar.borderRadius = 5; Chart.defaults.elements.bar.borderSkipped = false; Chart.defaults.elements.line.borderWidth = 2; Chart.defaults.elements.point.radius = 0; Chart.defaults.elements.point.hoverRadius = 4;
    Chart.defaults.scales.linear.ticks.padding = 6; Chart.defaults.scales.category.ticks.padding = 4; Chart.defaults.animation.duration = 500;
  }
  function mk(id, cfg) { const el = $('#' + id); if (!el) return; if (charts[id]) charts[id].destroy(); charts[id] = new Chart(el, cfg); }
  const bucketLabel = (b, g) => { const d = new Date(b + 'Z'); return g === 'hour' ? d.getUTCHours().toString().padStart(2, '0') + ':00' : g === 'week' ? d.getUTCMonth() + 1 + '/' + d.getUTCDate() + ' 7х' : d.getUTCMonth() + 1 + '/' + d.getUTCDate(); };

  // ================= LOGIN =================
  function renderLogin(err = '') {
    killCharts();
    app.innerHTML = `<div class="login">
      <aside class="hero">
        <div class="brand"><div class="logo">F</div><div><b>Footfall</b><small>Хүний урсгалын систем</small></div></div>
        <div>
          <h2>Дэлгүүрийнхээ урсгалыг<br>тоогоор удирд.</h2>
          <p>HX-CCD21 3D AI тоологчоос ирэх орсон, гарсан, өнгөрсөн хүний тоо, зочны нас, хүйс, давхардалгүй зочид — олон байршил, бодит цагт.</p>
          <div class="mock" aria-hidden="true">
            <div class="mk"><div><small>Орсон</small><b>12,148</b><i>↑ 8%</i></div><div><small>Одоо байгаа</small><b>39</b><i>бодит цагт</i></div><div><small>Орох хувь</small><b>63%</b><i>↑ 2%</i></div></div>
            <div class="bars">${[38, 30, 52, 44, 70, 62, 88, 80, 64, 58, 46, 40, 74, 66].map((h) => `<span style="height:${h}%"></span>`).join('')}</div>
          </div>
          <ul><li>Бодит цагийн орсон/гарсан</li><li>Өдөр × цагийн нягтрал</li><li>Зочны портрет, REID</li><li>REST API (ERP/BI)</li></ul>
        </div>
        <div class="foot">© ${new Date().getFullYear()} Footfall · Chipmo</div>
      </aside>
      <div class="pane"><div class="card">
        <div class="brand"><div class="logo">F</div><div><b>Footfall</b><small>Хүний урсгалын систем</small></div></div>
        <h1>Нэвтрэх</h1><p>Бүртгэлтэй и-мэйл, нууц үгээ оруулна уу.</p>
        <form class="form" id="loginForm" novalidate>
          <label>И-мэйл<input type="email" name="email" required autocomplete="username" placeholder="name@company.mn" autofocus></label>
          <label>Нууц үг<input type="password" name="password" required autocomplete="current-password" placeholder="••••••••"></label>
          <div class="err" id="loginErr" role="alert">${esc(err)}</div>
          <button class="btn primary" type="submit">Нэвтрэх</button>
        </form></div></div></div>`;
    $('#loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      if (!f.get('email') || !f.get('password')) { $('#loginErr').textContent = 'И-мэйл, нууц үгээ оруулна уу'; return; }
      await withLoading(e.target.querySelector('button[type=submit]'), async () => {
        try { await api('/dash/auth/login', { method: 'POST', body: { email: f.get('email'), password: f.get('password') } }); await boot(); }
        catch (err) { $('#loginErr').textContent = err.message; }
      });
    });
  }

  // ================= SHELL =================
  // Superadmin: байгууллагуудын хяналтын самбар + төхөөрөмж + тохиргоо (байгууллагын урсгалын өгөгдөл харахгүй)
  const NAV_SUPER = [
    ['admin', 'Байгууллагууд', 'M12 7V3H2v18h20V7H12zM6 19H4v-2h2v2zm0-4H4v-2h2v2zm0-4H4V9h2v2zm0-4H4V5h2v2zm4 12H8v-2h2v2zm0-4H8v-2h2v2zm0-4H8V9h2v2zm0-4H8V5h2v2zm10 12h-8v-2h2v-2h-2v-2h2v-2h-2V9h8v10zm-2-8h-2v2h2v-2zm0 4h-2v2h2v-2z', 'Бүх байгууллагын төлөв, төхөөрөмж, хэрэглэгч — нэг дэлгэцэнд'],
    ['devices', 'Төхөөрөмж', 'M4 6h16v10H4zM2 18h20v2H2z', 'Online/offline төлөв, холболт, firmware, тохиргоо'],
    ['settings', 'Тохиргоо', 'M19.4 13a7.7 7.7 0 000-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 00-1.7-1L15 3H9l-.4 2.7a7.4 7.4 0 00-1.7 1l-2.5-1-2 3.5L4.6 11a7.7 7.7 0 000 2l-2.1 1.6 2 3.5 2.5-1c.5.4 1.1.7 1.7 1L9 21h6l.4-2.7c.6-.3 1.2-.6 1.7-1l2.5 1 2-3.5L19.4 13zM12 15.5a3.5 3.5 0 110-7 3.5 3.5 0 010 7z', 'Байгууллага, байршил, хэрэглэгч, API түлхүүр, лог'],
  ];
  const NAV_TENANT = [
    ['overview', 'Тойм', 'M3 13h8V3H3v10zm10 8h8V11h-8v10zM3 21h8v-6H3v6zm10-18v6h8V3h-8z', 'Орсон, гарсан, одоо байгаа хүн, цагийн нягтрал'],
    ['live', 'Бодит цаг', 'M3 12h4l3-8 4 16 3-8h4', 'Одоо дотор байгаа хүн, шууд урсгал — 5 сек тутам'],
    ['locations', 'Байршил', 'M12 2C8.1 2 5 5.1 5 9c0 5.3 7 13 7 13s7-7.7 7-13c0-3.9-3.1-7-7-7zm0 9.5a2.5 2.5 0 110-5 2.5 2.5 0 010 5z', 'Байршил бүрийн урсгал, орох хувь, төхөөрөмжийн төлөв'],
    ['devices', 'Төхөөрөмж', 'M4 6h16v10H4zM2 18h20v2H2z', 'Online/offline төлөв, холболт, firmware, тохиргоо'],
    ['demographics', 'Зочны портрет', 'M16 11c1.7 0 3-1.3 3-3s-1.3-3-3-3-3 1.3-3 3 1.3 3 3 3zm-8 0c1.7 0 3-1.3 3-3S9.7 5 8 5 5 6.3 5 8s1.3 3 3 3zm0 2c-2.3 0-7 1.2-7 3.5V19h14v-2.5C15 14.2 10.3 13 8 13zm8 0c-.3 0-.6 0-1 .1 1.2.8 2 2 2 3.4V19h6v-2.5c0-2.3-4.7-3.5-7-3.5z', 'Нас, хүйс, ажилтан, тэргэнцэр, давхардал арилгасан бүтэц'],
    ['reid', 'Давхардалгүй зочид', 'M12 4a4 4 0 110 8 4 4 0 010-8zm0 10c4.4 0 8 1.8 8 4v2H4v-2c0-2.2 3.6-4 8-4z', 'REID-ээр танигдсан давхардалгүй зочид, давтан ирэлт, байх хугацаа'],
    ['settings', 'Тохиргоо', 'M19.4 13a7.7 7.7 0 000-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 00-1.7-1L15 3H9l-.4 2.7a7.4 7.4 0 00-1.7 1l-2.5-1-2 3.5L4.6 11a7.7 7.7 0 000 2l-2.1 1.6 2 3.5 2.5-1c.5.4 1.1.7 1.7 1L9 21h6l.4-2.7c.6-.3 1.2-.6 1.7-1l2.5 1 2-3.5L19.4 13zM12 15.5a3.5 3.5 0 110-7 3.5 3.5 0 010 7z', 'Байршил, хэрэглэгч, API түлхүүр, API баримт'],
  ];
  let NAV = NAV_TENANT;
  function renderShell() {
    const isSuper = state.user.role === 'superadmin';
    app.innerHTML = `<div class="shell">
      <aside class="sidebar">
        <div class="brand"><div class="logo">F</div><div><b>Footfall</b><small>Хүний урсгалын систем</small></div></div>
        <div class="ws"><span class="dot"></span><b>${esc(state.tenant ? state.tenant.name : 'Бүх байгууллага')}</b><small>${isSuper ? 'superadmin' : 'workspace'}</small></div>
        <div class="nav-label">Цэс</div>
        <nav class="nav">${NAV.map(([k, t, d]) => `<a href="#${k}" data-page="${k}"><svg viewBox="0 0 24 24" fill="currentColor"><path d="${d}"/></svg><span>${t}</span></a>`).join('')}</nav>
        <div class="spacer"></div>
        <div class="userbox"><div class="avatar">${esc(initials(state.user.name || state.user.email))}</div><div class="who"><b>${esc(state.user.name || state.user.email)}</b><span>${roleName(state.user.role)}</span>
          <div class="links"><a href="#" id="pwBtn">Нууц үг солих</a> · <a href="#" id="logoutBtn">Гарах</a></div></div></div>
      </aside>
      <main class="main">
        <div class="topbar"><div class="title"><h1 id="pageTitle"></h1><p class="page-sub" id="pageSub"></p></div>
          <div class="umenu"><button class="avatar" id="umBtn" aria-label="Хэрэглэгчийн цэс">${esc(initials(state.user.name || state.user.email))}</button>
            <div class="pop" id="umPop" hidden><div class="who"><b>${esc(state.user.name || state.user.email)}</b>${esc(state.user.email)} · ${roleName(state.user.role)}</div>
              <button type="button" id="umPw">Нууц үг солих</button><button type="button" class="danger" id="umOut">Гарах</button></div></div>
        </div>
        <div class="toolbar" id="globalFilters">
          ${isSuper ? `<label class="fld"><span>Байгууллага</span><select id="fTenant"><option value="">Бүх байгууллага</option>${state.tenants.map((t) => `<option value="${t.id}" ${String(t.id) === String(state.tenantId) ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>` : ''}
          <label class="fld"><span>Байршил</span><select id="fLocation"></select></label>
          <label class="fld"><span>Төхөөрөмж</span><select id="fDevice"></select></label>
          <div class="fld range"><span>Хугацаа</span><div class="filters"><div class="seg" id="fRange">${[['today', 'Өнөөдөр'], ['7d', '7 хоног'], ['30d', '30 хоног'], ['90d', '90 хоног'], ['custom', 'Сонгох']].map(([k, t]) => `<button data-r="${k}" class="${state.range === k ? 'active' : ''}">${t}</button>`).join('')}</div>
            <span id="customRange" class="filters" ${state.range === 'custom' ? '' : 'hidden'}><input type="date" id="fFrom" value="${state.from}"> – <input type="date" id="fTo" value="${state.to}"></span></div></div>
          <div class="grow"></div>
          <div class="fld upd"><span id="lastUpd" class="muted small"></span><button class="btn" id="refreshBtn" aria-label="Өгөгдөл шинэчлэх"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6"/></svg> Шинэчлэх</button></div>
        </div>
        <div class="content"><div id="page"></div></div>
      </main></div>`;
    fillLocationSelects();
    const logout = async (e) => { e && e.preventDefault(); await api('/dash/auth/logout', { method: 'POST' }); location.hash = ''; state.user = null; renderLogin(); };
    $('#logoutBtn').onclick = logout; $('#umOut').onclick = logout;
    $('#pwBtn').onclick = (e) => { e.preventDefault(); passwordModal(); }; $('#umPw').onclick = () => { $('#umPop').hidden = true; passwordModal(); };
    $('#umBtn').onclick = (e) => { e.stopPropagation(); $('#umPop').hidden = !$('#umPop').hidden; };
    document.addEventListener('click', (e) => { const p = $('#umPop'); if (p && !p.hidden && !e.target.closest('.umenu')) p.hidden = true; });
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
      state.user = me.user; state.tenant = me.tenant; state.cfg = me.config || {};
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
    document.querySelectorAll('.nav a').forEach((a) => { const on = a.dataset.page === state.page; a.classList.toggle('active', on); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    const nav = NAV.find((n) => n[0] === state.page);
    $('#pageTitle').textContent = nav[1];
    document.title = `${nav[1]} · Footfall`;
    // Superadmin-д огноо/байршлын шүүлтүүр хэрэггүй (байгууллагын өгөгдөл харахгүй)
    const dataPage = state.page !== 'settings' && state.user.role !== 'superadmin';
    $('#globalFilters').style.display = dataPage ? '' : 'none';
    // Дэд гарчиг = одоогийн контекст (аль байршил/төхөөрөмж, ямар хугацаа) — хэрэглэгч санахгүй, харна
    $('#pageSub').textContent = dataPage && !['devices', 'live'].includes(state.page) ? contextLabel() : (nav[3] || '');
    killCharts();
    (state.liveTimers || []).forEach(clearInterval); state.liveTimers = [];
    const rangeFld = $('.fld.range'); if (rangeFld) rangeFld.style.display = state.page === 'live' ? 'none' : '';
    $('#page').innerHTML = skeleton();
    const rb = $('#refreshBtn'); if (rb) rb.classList.add('loading');
    try {
      await PAGES[state.page]();
      $('#page').classList.remove('page-enter'); void $('#page').offsetWidth; $('#page').classList.add('page-enter');
      const lu = $('#lastUpd'); if (lu) lu.textContent = 'Шинэчилсэн ' + new Date().toLocaleTimeString('mn-MN', { hour: '2-digit', minute: '2-digit', hour12: false });
    } catch (e) {
      $('#page').innerHTML = `<div class="card empty-state"><div class="ico">${icon('alert')}</div><b>Өгөгдөл ачаалж чадсангүй</b><p>${esc(e.message)}</p><div style="margin-top:14px"><button class="btn primary" id="retryBtn">Дахин оролдох</button></div></div>`;
      $('#retryBtn').onclick = () => render();
    } finally { if (rb) rb.classList.remove('loading'); }
  }
  // «Эмарт Хан-Уул · Гол хаалга · 03.09–09.09 (7 хоног)»
  function contextLabel() {
    const parts = [];
    const loc = state.locations.find((l) => String(l.id) === String(state.locationId));
    const dev = state.devices.find((d) => d.sn === state.sn);
    parts.push(loc ? loc.name : 'Бүх байршил');
    if (dev) parts.push(dev.name || dev.sn);
    const { from, to, days } = rangeDates();
    const f = from.slice(0, 10), t = new Date(new Date(to.slice(0, 10)).getTime() - 86400000).toISOString().slice(0, 10);
    const dm = (s) => s.slice(8, 10) + '.' + s.slice(5, 7);
    parts.push(state.range === 'today' ? 'Өнөөдөр (' + dm(f) + ')' : `${dm(f)}–${dm(t)} (${days} хоног)`);
    return parts.join(' · ');
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
    // Анхны хэрэглэгч: төхөөрөмж холбогдоогүй бол тоо биш, дараагийн алхмыг харуул
    if (!ov.by_device.length && !state.locationId && !state.sn) { renderOnboarding(); return; }
    const total = ov.by_device.length, offline = total - online;
    const prevRate = prev.in_count + prev.passby ? prev.in_count / (prev.in_count + prev.passby) : 0;
    const curRate = t.in_count + t.passby ? t.in_count / (t.in_count + t.passby) : 0;
    $('#page').innerHTML = `
      ${offline ? `<div class="notice warn"><b>${offline} төхөөрөмж offline</b> — тоо дутуу байж болзошгүй. <a href="#devices">Төхөөрөмж хуудсанд шалгах →</a></div>` : ''}
      <div class="grid g-kpi hero">
        ${kpi({ label: 'Орсон зочин', value: fmt(t.in_count), delta: { cur: t.in_count, prev: prev.in_count }, ico: 'in', c: 1, accent: true, spark: ov.series.map((s) => s.in_count) })}
        ${kpi({ label: 'Одоо дотор байгаа', value: fmt(ov.occupancy.total), sub: 'бодит цагт', ico: 'people', c: 3 })}
        ${kpi({ label: 'Орох хувь', value: pct(t.in_count, t.in_count + t.passby), delta: { cur: curRate, prev: prevRate }, ico: 'pass', c: 4, spark: ov.series.map((s) => (s.in_count + s.passby ? Math.round(100 * s.in_count / (s.in_count + s.passby)) : 0)) })}
        ${kpi({ label: 'Дундаж байх хугацаа', value: dur(t.avg_stay_ms), sub: 'камерын талбайд', ico: 'clock', c: 7 })}
      </div>
      <div class="stats"><span><b>${fmt(t.out_count)}</b> гарсан</span><span><b>${fmt(t.passby)}</b> өнгөрсөн (орохгүй)</span><span><b>${fmt(t.turnback)}</b> буцсан</span><span><b>${online}/${total}</b> төхөөрөмж online</span></div>
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
      options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, grid: { color: css('--border') }, border: { display: false } } }, plugins: { legend: { position: 'top', align: 'end' } } },
    });
    renderHeat(heat);
    drawSparks();
  }
  const shift = (iso, days) => new Date(new Date(iso).getTime() + days * 86400000).toISOString();
  // Төхөөрөмжийн Data Push-д бичих хаяг: серверийн DEVICE_PUSH_* тохиргоо байвал түүнийг, үгүй бол одоогийн хаягийг
  function pushCfg() {
    const c = state.cfg || {};
    const proto = (c.push_protocol || (location.protocol === 'https:' ? 'HTTPS' : 'HTTP')).toUpperCase();
    const host = c.push_host || location.hostname;
    const port = c.push_port || location.port || (proto === 'HTTPS' ? 443 : 80);
    const origin = `${proto.toLowerCase()}://${host}${(proto === 'HTTPS' && String(port) === '443') || (proto === 'HTTP' && String(port) === '80') ? '' : ':' + port}`;
    return { proto, host, port, origin };
  }
  // Анхны тохиргооны алхмууд (төхөөрөмжгүй байгууллага)
  function renderOnboarding() {
    const isAdmin = ['superadmin', 'admin'].includes(state.user.role);
    const hasLoc = state.locations.length > 0;
    const step = (n, done, title, body, cta) => `<div class="step ${done ? 'done' : ''}"><div class="n">${done ? '✓' : n}</div><div><b>${title}</b><p>${body}</p>${cta && !done ? cta : ''}</div></div>`;
    $('#page').innerHTML = `<div class="card onboard">
      <h2>Footfall-д тавтай морил 👋</h2><p class="muted">Тоо гарч эхлэхийн тулд 2 алхам үлдлээ. Төхөөрөмж эхний heartbeat илгээмэгц энэ дэлгэц өөрөө өгөгдөлтэй болно.</p>
      <div class="steps">
        ${step(1, hasLoc, 'Байршил үүсгэх', hasLoc ? `${state.locations.length} байршил бүртгэлтэй.` : 'Дэлгүүр/салбар бүр нэг байршил. Төхөөрөмжийг байршилд оноож өгнө.', isAdmin ? '<a class="btn primary sm" href="#settings/locations">Байршил нэмэх</a>' : '')}
        ${step(2, false, 'HX-CCD21 төхөөрөмжийг холбох', `Төхөөрөмжийн удирдлагын хуудас → Settings → Data Push → HTTP → Add: Protocol <b>${pushCfg().proto}</b> · Server <b>${esc(pushCfg().host)}</b> · Port <b>${pushCfg().port}</b>. Замууд анхдагчаараа зөв (<span class="mono">/api/camera/heartBeat</span> …). Төхөөрөмж интернэттэй сүлжээнд (кабель эсвэл 2.4GHz WiFi) залгаастай байх ёстой.`, '<a class="btn sm" href="#devices">Дэлгэрэнгүй заавар</a>')}
        ${step(3, false, 'Төхөөрөмжид нэр, байршил оноох', 'Эхний heartbeat ирмэгц Төхөөрөмж хуудсанд «Оноогоогүй» гэж гарна → Засах.', '')}
      </div></div>`;
  }
  function renderHeat(rows) {
    const max = Math.max(1, ...rows.map((r) => r.in_count));
    const m = {}; rows.forEach((r) => { m[r.dow + '_' + r.hour] = r.in_count; });
    let h = '<div class="heat"><div></div>' + [...Array(24)].map((_, i) => `<div class="h">${i}</div>`).join('');
    for (let d = 1; d <= 7; d++) { h += `<div class="d">${DOW[d - 1]}</div>`; for (let i = 0; i < 24; i++) { const v = m[d + '_' + i] || 0; h += `<div class="c" title="${DOW[d - 1]} ${i}:00 — ${fmt(v)} хүн" style="opacity:${v ? (0.15 + 0.85 * v / max).toFixed(2) : 0.04}"></div>`; } }
    $('#heat').innerHTML = h + '</div>' + `<div class="heat-legend"><span>бага</span><i></i><span>их (${fmt(max)} хүн/цаг)</span></div>`;
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
          <td class="small">${esc(d.sw_release || '—')}<br><span class="muted">${esc(d.hw_platform || '')} · ${d.upload_interval === 0 ? 'бодит цаг' : d.upload_interval + ' мин'} · ${d.data_mode}</span>${d.clock_skew_sec ? `<br><span class="pill warn" title="Төхөөрөмжийн цаг серверээс ${Math.round(d.clock_skew_sec / 60)} минут зөрүүтэй илгээж байна — сервер автоматаар засаж хадгална">цаг ${(d.clock_skew_sec / 3600).toFixed(d.clock_skew_sec % 3600 ? 1 : 0)}ц зөрүү · засаж байна</span>` : ''}</td>
          ${isSuper ? '' : `<td class="num">${fmt(fm[d.sn] ? fm[d.sn].in_count : 0)}</td><td class="num">${fmt(fm[d.sn] ? fm[d.sn].out_count : 0)}</td>`}
          <td><div class="row-actions">${canEdit ? `<button class="btn sm" data-edit="${d.sn}">Засах</button><button class="btn sm ghost" data-resync="${d.sn}">Дахин татах</button>` : ''}<button class="btn sm ghost" data-hb="${d.sn}">Лог</button>${d.ip_address ? `<a class="btn sm ghost" href="http://${esc(d.ip_address)}" target="_blank" rel="noopener" title="Төхөөрөмжийн өөрийн удирдлагын хуудас (${esc(d.ip_address)}) — зөвхөн дэлгүүрийн сүлжээнд байхад нээгдэнэ">Төхөөрөмжийн web ↗</a>` : ''}${isSuper ? `<button class="btn sm ghost danger" data-del="${esc(d.sn)}" title="Төхөөрөмж ба түүний бүх өгөгдлийг устгана">Устгах</button>` : ''}</div></td></tr>`).join('') || `<tr><td colspan="10"><div class="empty-state"><div class="ico">${icon('device')}</div><b>Төхөөрөмж хараахан холбогдоогүй</b><p>Төхөөрөмжийн Data Push тохиргоонд доорх серверийн хаягийг оруулмагц эхний heartbeat-ээр энд автоматаар гарч ирнэ.</p></div></td></tr>`}
      </tbody></table></div></div>
      <div class="card"><div class="head"><h2>Шинэ төхөөрөмж холбох</h2>${canEdit ? '<button class="btn primary" id="claimBtn">+ SN-ээр нэмэх</button>' : ''}</div>
        <details ${devs.length ? '' : 'open'}><summary>Төхөөрөмжийн тохиргооны заавар (Data Push)</summary>
        <p class="muted small">Төхөөрөмж интернэттэй сүлжээнд (кабель эсвэл <b>2.4GHz</b> WiFi) залгаастай байх ёстой — өөрийнх нь hotspot-оор биш. HX-CCD21 удирдлагын хуудас → Settings → Data Push → HTTP → Add:</p>
        <div class="code">Protocol:       ${pushCfg().proto}
Server Address: ${esc(pushCfg().host)}
Server Port:    ${pushCfg().port}
Data Mode:      Add (Increment)

Interface (анхдагч зөв бол хөндөхгүй):
  Heartbeat API: /api/camera/heartBeat
  Data API:      /api/camera/dataUpload
  REID:          /api/camera/reid
  DUP:           /api/camera/dup</div></details></div></div>`;
    $('#page').onclick = async (e) => {
      const ed = e.target.closest('[data-edit]'); const rs = e.target.closest('[data-resync]'); const hb = e.target.closest('[data-hb]');
      if (ed) deviceModal(devs.find((d) => d.sn === ed.dataset.edit));
      if (rs) resyncModal(rs.dataset.resync);
      const del = e.target.closest('[data-del]');
      if (del && await confirmDlg(`${del.dataset.del} төхөөрөмжийг бүх өгөгдөл, heartbeat логтой нь хамт бүрмөсөн устгах уу? Төхөөрөмж дахин heartbeat илгээвэл хуваарилаагүй байдлаар дахин бүртгэгдэнэ.`, { danger: true })) { try { await api('/dash/devices/' + del.dataset.del, { method: 'DELETE' }); toast('Төхөөрөмж устгагдлаа'); await loadMeta(); fillLocationSelects(); render(); } catch (err) { toast(err.message, 'error'); } }
      if (e.target.id === 'claimBtn') claimModal();
      if (hb) {
        const dv = devs.find((x) => x.sn === hb.dataset.hb) || {};
        const rows = await api('/dash/devices/' + hb.dataset.hb + '/heartbeats');
        modal(`<h2>Лог — ${esc(dv.name || hb.dataset.hb)}</h2>
          <h3 style="margin-bottom:6px">Сүүлийн dataUpload (төхөөрөмжөөс ирсэн бодит body)</h3>
          ${dv.last_upload ? `<div class="code" style="max-height:32vh;overflow:auto;white-space:pre-wrap">${esc(JSON.stringify(dv.last_upload, null, 2))}</div>` : '<p class="muted small">Хараахан өгөгдөл ирээгүй</p>'}
          <h3 style="margin:14px 0 6px">Heartbeat (сүүлийн 50)</h3>
          <div class="tbl-wrap" style="max-height:32vh;overflow:auto"><table><thead><tr><th>Цаг</th><th>IP</th><th>Холболт</th><th>Firmware</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${fmtDT(r.ts)}</td><td>${esc(r.payload.ipAddress || '')}</td><td>${esc(r.payload.connectionType || '')}</td><td>${esc(r.payload.swRelease || '')}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">Хоосон</td></tr>'}</tbody></table></div>`);
      }
    };
  }
  // superadmin: SN-ийг байгууллагад хуваарилна (байршил сонголтот); admin: өөрт хуваарилагдсан SN-ийг байршилд нь тавина
  function claimModal(presetSn = '') {
    const isSuper = state.user.role === 'superadmin';
    const locs = state.locations.filter((l) => !state.tenantId || String(l.tenant_id) === String(state.tenantId));
    const locOpts = (tid) => `<option value="">— Дараа нь оноох —</option>` + locs.filter((l) => !tid || String(l.tenant_id) === String(tid)).map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
    const firstTid = state.tenantId || (state.tenants[0] || {}).id;
    modal(`<h2>${isSuper ? 'Төхөөрөмж хуваарилах' : 'Төхөөрөмж нэмэх'}</h2>
      <p class="muted small">${isSuper ? 'SN-ийг байгууллагад хуваарилна. Тэр байгууллагын админ дараа нь өөрөө байршилд нь тавьж болно. Төхөөрөмж хараахан холбогдоогүй байсан ч урьдчилан бүртгэж болно.' : 'Footfall-ийн superadmin танай байгууллагад хуваарилсан төхөөрөмжийн SN (арын наалт дээр, жишээ: 201000002501090095)-ийг оруулна.'}</p>
      <form class="form" id="f"><label>SN<input name="sn" required class="mono" placeholder="2010000025..." value="${esc(presetSn)}" pattern="[A-Za-z0-9_-]{4,64}" title="Үсэг, тоо, зураас"></label><label>Нэр (сонголтот)<input name="name" placeholder="Гол хаалга"></label>
      ${isSuper ? `<label>Байгууллага<select name="tenant_id" id="cTenant" required>${state.tenants.map((t) => `<option value="${t.id}" ${String(t.id) === String(firstTid) ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
      <label>Байршил (сонголтот)<select name="location_id" id="cLoc">${locOpts(firstTid)}</select></label>`
      : `<label>Байршил<select name="location_id" required>${locs.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('') || '<option value="">Эхлээд байршил үүсгэнэ үү</option>'}</select></label>`}
      <div class="actions"><button type="button" class="btn" data-close>Болих</button><button class="btn primary">${isSuper ? 'Хуваарилах' : 'Нэмэх'}</button></div></form>`, (bg, close) => {
      bg.querySelector('[data-close]').onclick = close;
      const ct = bg.querySelector('#cTenant'); if (ct) ct.onchange = () => { bg.querySelector('#cLoc').innerHTML = locOpts(ct.value); };
      bg.querySelector('#f').onsubmit = async (e) => { e.preventDefault(); try { const d = await api('/dash/devices/claim', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); toast(isSuper ? `${d.sn} хуваарилагдлаа` : 'Төхөөрөмж нэмэгдлээ'); close(); await loadMeta(); fillLocationSelects(); render(); } catch (err) { toast(err.message, 'error'); } };
    });
  }
  function deviceModal(d) {
    const isSuper = state.user.role === 'superadmin';
    const locs = state.locations.filter((l) => !isSuper || !state.tenantId || String(l.tenant_id) === String(state.tenantId));
    const locOpts = (tid) => `<option value="">— Оноогоогүй —</option>` + locs.filter((l) => !tid || String(l.tenant_id) === String(tid)).map((l) => `<option value="${l.id}" ${l.id === d.location_id ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
    modal(`<h2>Төхөөрөмж засах</h2><div class="muted mono small" style="margin-bottom:10px">${esc(d.sn)}</div>
      <form class="form" id="f">
        <label>Нэр (жишээ: Гол хаалга)<input name="name" value="${esc(d.name)}"></label>
        ${isSuper ? `<label>Байгууллага<select name="tenant_id" id="dTenant"><option value="">— Хуваарилаагүй —</option>${state.tenants.map((t) => `<option value="${t.id}" ${t.id === d.tenant_id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>` : ''}
        <label>Байршил<select name="location_id" id="dLoc">${locOpts(isSuper ? d.tenant_id : null)}</select></label>
        <div class="row">
          <label>Илгээх давтамж<select name="upload_interval">${[[0, 'Бодит цаг'], [1, '1 минут'], [5, '5 минут'], [60, '60 минут']].map(([v, t]) => `<option value="${v}" ${v === d.upload_interval ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
          <label>Өгөгдлийн горим<select name="data_mode"><option value="Add" ${d.data_mode === 'Add' ? 'selected' : ''}>Add (нэмэгдэл)</option><option value="Total" ${d.data_mode === 'Total' ? 'selected' : ''}>Total (нийлбэр)</option></select></label>
        </div>
        <label>Цагийн бүс (GMT+)<input type="number" name="timezone_offset" value="${d.timezone_offset}"></label>
        <p class="small muted">Давтамж, горим, цагийн бүсийг дараагийн heartbeat-д төхөөрөмж рүү илгээнэ.</p>
        <div class="actions"><button type="button" class="btn danger ghost" id="purgeBtn" style="margin-right:auto">Өгөгдөл цэвэрлэх…</button><button type="button" class="btn" data-close>Болих</button><button class="btn primary">Хадгалах</button></div></form>`,
      (bg, close) => {
        bg.querySelector('[data-close]').onclick = close;
        bg.querySelector('#purgeBtn').onclick = () => { close(); purgeModal(d); };
        const dt = bg.querySelector('#dTenant'); if (dt) dt.onchange = () => { bg.querySelector('#dLoc').innerHTML = locOpts(dt.value); };
        bg.querySelector('#f').onsubmit = async (e) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); try { await api('/dash/devices/' + d.sn, { method: 'PUT', body: f }); toast('Хадгалагдлаа'); close(); await loadMeta(); fillLocationSelects(); render(); } catch (err) { toast(err.message, 'error'); } };
      });
  }
  // Төхөөрөмжийн өгөгдөл цэвэрлэх (туршилтын өгөгдөл арилгах) — бүгд эсвэл хугацаагаар; SN-ийг бичүүлж баталгаажуулна
  function purgeModal(d) {
    modal(`<h2>Өгөгдөл цэвэрлэх — ${esc(d.name || d.sn)}</h2>
      <p class="small">Энэ төхөөрөмжийн орсон/гарсан бичлэг, хүн бүрийн үйл явдал, occupancy, REID/DUP тайланг <b>бүрмөсөн устгана</b>. Төхөөрөмж, тохиргоо, heartbeat лог хэвээр үлдэнэ. Буцаах боломжгүй.</p>
      <form class="form" id="f">
        <label>Хүрээ<select name="scope" id="pScope"><option value="all">Бүх өгөгдөл</option><option value="range">Хугацаагаар</option></select></label>
        <div class="row" id="pRange" hidden><label>Эхлэх<input type="date" name="from"></label><label>Дуусах (оролцохгүй)<input type="date" name="to"></label></div>
        <label>Баталгаажуулахын тулд SN-ийг бич<input name="confirm" class="mono" placeholder="${esc(d.sn)}" autocomplete="off" required></label>
        <div class="actions"><button type="button" class="btn" data-close>Болих</button><button class="btn danger" id="pGo" disabled>Устгах</button></div></form>`, (bg, close) => {
      bg.querySelector('[data-close]').onclick = close;
      const sc = bg.querySelector('#pScope'), rg = bg.querySelector('#pRange'), go = bg.querySelector('#pGo'), cf = bg.querySelector('[name=confirm]');
      sc.onchange = () => { rg.hidden = sc.value !== 'range'; };
      cf.oninput = () => { go.disabled = cf.value.trim() !== d.sn; };
      bg.querySelector('#f').onsubmit = async (e) => {
        e.preventDefault(); const f = Object.fromEntries(new FormData(e.target));
        const body = f.scope === 'range' ? { from: f.from ? f.from + 'T00:00:00+08:00' : null, to: f.to ? f.to + 'T00:00:00+08:00' : null } : {};
        if (f.scope === 'range' && !f.from && !f.to) return toast('Хугацаагаа сонгоно уу', 'error');
        try { const r = await api('/dash/devices/' + d.sn + '/purge', { method: 'POST', body }); const n = r.deleted; toast(`Устгав: ${fmt(n.flow_records)} бичлэг, ${fmt(n.person_events)} үйл явдал, ${fmt(n.reid_reports + n.dedup_reports)} тайлан`, 'success', 6000); close(); await loadMeta(); render(); }
        catch (err) { toast(err.message, 'error'); }
      };
    });
  }
  function resyncModal(sn) {
    modal(`<h2>Түүхэн өгөгдөл дахин татах</h2><p class="muted small">Төхөөрөмж сүүлийн 90 хоногийн өгөгдлийг өөр дээрээ хадгалдаг. Сонгосон хугацааны өгөгдлийг дараагийн heartbeat-д дахин илгээхийг хүснэ.</p>
      <form class="form" id="f"><div class="row"><label>Эхлэх<input type="date" name="from" required value="${ubDate(-7)}"></label><label>Дуусах<input type="date" name="to" required value="${ubDate(0)}"></label></div>
      <div class="actions"><button type="button" class="btn" data-close>Болих</button><button class="btn primary">Хүсэлт илгээх</button></div></form>`,
      (bg, close) => { bg.querySelector('[data-close]').onclick = close; bg.querySelector('#f').onsubmit = async (e) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); try { await api('/dash/devices/' + sn + '/resync', { method: 'POST', body: { from: f.from + 'T00:00:00+08:00', to: f.to + 'T23:59:59+08:00' } }); toast('Хүсэлт бүртгэгдлээ — дараагийн heartbeat-д илгээнэ'); close(); } catch (err) { toast(err.message, 'error'); } }; });
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
      <div class="actions"><button type="button" class="btn" data-close>Болих</button><button class="btn primary">Нэмэх</button></div></form>`, (bg, close) => { bg.querySelector('[data-close]').onclick = close; bg.querySelector('#f').onsubmit = async (e) => { e.preventDefault(); try { const u = await api('/dash/users', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); toast(`${u.email} нэмэгдлээ`); close(); after && after(); } catch (err) { toast(err.message, 'error'); } }; });
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
        bg.querySelector('#f').onsubmit = async (e) => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); try { await api(l.id ? '/dash/locations/' + l.id : '/dash/locations', { method: l.id ? 'PUT' : 'POST', body: f }); toast('Хадгалагдлаа'); close(); await loadMeta(); SETTINGS.locations(); } catch (err) { toast(err.message, 'error'); } };
      });
      if ($('#add')) $('#add').onclick = () => form();
      $('#tab').onclick = async (e) => { const ed = e.target.closest('[data-e]'); const del = e.target.closest('[data-d]'); if (ed) form(locs.find((l) => String(l.id) === ed.dataset.e)); if (del && await confirmDlg('Байршлыг устгах уу? Төхөөрөмжүүд оноогоогүй болно.')) { await api('/dash/locations/' + del.dataset.d, { method: 'DELETE' }); await loadMeta(); SETTINGS.locations(); } };
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
        <div class="actions"><button type="button" class="btn" data-close>Болих</button><button class="btn primary">Байгууллага + админ үүсгэх</button></div></form>`, (bg, close) => { bg.querySelector('[data-close]').onclick = close; bg.querySelector('#f').onsubmit = async (e) => { e.preventDefault(); try { const t = await api('/dash/tenants', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); toast(`«${t.name}» үүслээ, админ: ${t.admin ? t.admin.email : '—'}`); close(); await loadMeta(); SETTINGS.tenants(); } catch (err) { toast(err.message, 'error'); } }; });
      $('#tab').onclick = async (e) => {
        const add = e.target.closest('[data-a]'); const del = e.target.closest('[data-d]');
        if (add) { const t = ts.find((x) => String(x.id) === add.dataset.a); userModal({ tenantId: t.id, tenantName: t.name, role: 'admin' }, () => SETTINGS.tenants()); }
        if (del && await confirmDlg('Байгууллагыг бүх байршил, хэрэглэгч, API түлхүүрийн хамт устгах уу?')) { await api('/dash/tenants/' + del.dataset.d, { method: 'DELETE' }); await loadMeta(); SETTINGS.tenants(); }
      };
    },
    async users() {
      const us = await api('/dash/users' + (state.tenantId ? '?tenant_id=' + state.tenantId : ''));
      const isSuper = state.user.role === 'superadmin';
      $('#tab').innerHTML = `<div class="card"><div class="head"><h2>Хэрэглэгч</h2><button class="btn primary" id="add">+ Хэрэглэгч нэмэх</button></div><div class="tbl-wrap"><table><thead><tr><th>Нэр</th><th>И-мэйл</th><th>Эрх</th><th>Байгууллага</th><th></th></tr></thead><tbody>
        ${us.map((u) => `<tr><td><b>${esc(u.name)}</b></td><td>${esc(u.email)}</td><td>${roleName(u.role)}</td><td>${esc(u.tenant_name || 'Бүгд')}</td><td>${u.id !== state.user.uid ? `<button class="btn sm danger" data-d="${u.id}">Устгах</button>` : '<span class="muted small">та</span>'}</td></tr>`).join('')}</tbody></table></div></div>`;
      $('#add').onclick = () => userModal({}, () => SETTINGS.users());
      $('#tab').onclick = async (e) => { const del = e.target.closest('[data-d]'); if (del && await confirmDlg('Хэрэглэгчийг устгах уу?')) { await api('/dash/users/' + del.dataset.d, { method: 'DELETE' }); SETTINGS.users(); } };
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
  "${location.origin}/api/v1/flow/totals?from=${ubDate(-7)}&to=${ubDate(1)}"</div><div class="actions"><button class="btn primary" data-close>Хаах</button></div>`, (b2, c2) => { b2.querySelector('[data-close]').onclick = () => { c2(); SETTINGS.apikeys(); }; b2.querySelector('#cp').onclick = async (ev) => { try { await navigator.clipboard.writeText(k.key); ev.target.textContent = 'Хуулагдлаа ✓'; toast('Түлхүүр хуулагдлаа'); } catch { b2.querySelector('#kv').select(); toast('Гараар хуулна уу (Ctrl+C)', 'info'); } }; }); } catch (err) { toast(err.message, 'error'); } };
      });
      $('#tab').onclick = async (e) => { const del = e.target.closest('[data-d]'); if (del && await confirmDlg('Түлхүүрийг хүчингүй болгох уу? Үүнийг ашигладаг интеграц ажиллахаа болино.')) { await api('/dash/api-keys/' + del.dataset.d, { method: 'DELETE' }); SETTINGS.apikeys(); } };
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
    modal(`<h2>Нууц үг солих</h2><form class="form" id="f"><label>Одоогийн нууц үг<input type="password" name="current" required></label><label>Шинэ нууц үг<input type="password" name="next" required minlength="6"></label><div class="actions"><button type="button" class="btn" data-close>Болих</button><button class="btn primary">Солих</button></div></form>`, (bg, close) => { bg.querySelector('[data-close]').onclick = close; bg.querySelector('#f').onsubmit = async (e) => { e.preventDefault(); try { await api('/dash/auth/password', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); toast('Нууц үг солигдлоо'); close(); } catch (err) { toast(err.message, 'error'); } }; });
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
        ${kpi({ label: 'Байгууллага', value: fmt(t.tenants), sub: fmt(t.locations) + ' байршил', ico: 'building', c: 1, accent: true })}
        ${kpi({ label: 'Төхөөрөмж', value: `${fmt(t.devices_online)}<span class="muted" style="font-size:16px;font-weight:500">/${fmt(t.devices)}</span>`, sub: offline ? offline + ' offline' : t.devices ? 'бүгд online' : 'холбогдоогүй', subClass: offline ? 'down' : t.devices ? 'up' : '', ico: 'device', c: offline ? 8 : 3 })}
        ${kpi({ label: 'Оноогоогүй төхөөрөмж', value: fmt(t.devices_unassigned), sub: t.devices_unassigned ? 'байршил оноох хэрэгтэй' : 'бүгд оноогдсон', subClass: t.devices_unassigned ? 'down' : '', ico: 'warn', c: t.devices_unassigned ? 4 : 3 })}
        ${kpi({ label: 'Хэрэглэгч', value: fmt(t.users), sub: fmt(t.superadmins) + ' супер админ', ico: 'users', c: 7 })}
        ${kpi({ label: 'API түлхүүр', value: fmt(t.api_keys), sub: 'идэвхтэй', ico: 'key', c: 5 })}
        ${kpi({ label: 'Ingest алдаа', value: fmt(t.ingest_errors_24h), sub: 'сүүлийн 24 цагт', subClass: t.ingest_errors_24h ? 'down' : 'up', ico: 'alert', c: t.ingest_errors_24h ? 8 : 3 })}
        ${kpi({ label: 'Сүүлийн өгөгдөл', value: `<span style="font-size:20px">${ago(t.last_data_at)}</span>`, sub: 'DB ' + bytes(t.db_bytes), ico: 'db', c: 2 })}
      </div>
      ${s.unassigned_devices.length ? `<div class="card section" style="border-color:var(--warn)"><div class="head"><h2>⚠ Хуваарилаагүй төхөөрөмж</h2><span class="sub">${s.unassigned_devices.length} ш — байгууллагад хуваарилтал өгөгдөл нь хэнд ч харагдахгүй</span></div><div class="tbl-wrap"><table><thead><tr><th>Төлөв</th><th>SN</th><th>IP</th><th>Firmware</th><th>Анх холбогдсон</th><th>Сүүлийн heartbeat</th><th></th></tr></thead><tbody>
        ${s.unassigned_devices.map((d) => `<tr><td><span class="pill ${d.online ? 'on' : 'off'}"><i class="dot"></i>${d.online ? 'Online' : 'Offline'}</span></td><td class="mono">${esc(d.sn)}</td><td class="small">${esc(d.ip_address || '—')}</td><td class="small">${esc(d.sw_release || '—')}</td><td class="small muted">${fmtDT(d.first_seen)}</td><td>${ago(d.last_heartbeat)}</td><td><button class="btn sm primary" data-claim="${esc(d.sn)}">Хуваарилах</button></td></tr>`).join('')}</tbody></table></div></div>` : ''}
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
    $('#page').onclick = (e) => { const c = e.target.closest('[data-claim]'); if (c) claimModal(c.dataset.claim); };
  }

  // ================= LIVE (бодит цаг) =================
  const EV = { 0: ['Орсон', 'in'], 1: ['Гарсан', 'out'], 2: ['Өнгөрсөн', 'pass'], 3: ['Буцсан', 'back'] };
  const setText = (id, v) => { const el = $('#' + id); if (el && el.innerHTML !== String(v)) el.innerHTML = v; };
  // Огноог TZ-ийн 'YYYY-MM-DDTHH:MM' түлхүүр болгоно (серверийн минутын bucket-тэй тааруулахад)
  function tzKey(d) {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
    const g = (t) => (p.find((x) => x.type === t) || {}).value; return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}`;
  }
  function toggleFs() { if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => toast('Бүтэн дэлгэц дэмжигдэхгүй', 'error')); else document.exitFullscreen(); }
  document.addEventListener('fullscreenchange', () => document.body.classList.toggle('fs', !!document.fullscreenElement));
  async function pageLive() {
    const from = ubDate() + 'T00:00:00+08:00', to = ubDate(1) + 'T00:00:00+08:00';
    const q = () => { const p = new URLSearchParams(); if (state.locationId) p.set('location_id', state.locationId); if (state.sn) p.set('sn', state.sn); p.set('from', from); p.set('to', to); p.set('tz', TZ); return '?' + p.toString(); };
    const loc = state.locations.find((l) => String(l.id) === String(state.locationId)); const dev = state.devices.find((d) => d.sn === state.sn);
    const ctx = [loc ? loc.name : (state.tenant ? state.tenant.name : 'Бүх байршил'), dev ? (dev.name || dev.sn) : null].filter(Boolean).join(' · ');
    $('#page').innerHTML = `<div class="live">
      <div class="live-top"><div class="live-ctx"><span class="pill on"><i class="dot"></i>LIVE</span> ${esc(ctx)}</div><div class="live-actions"><span class="live-clock" id="lvClock"></span><button class="btn" id="fsBtn" title="TV/монитор дээр тавихад">⛶ Бүтэн дэлгэц</button></div></div>
      <div class="live-grid">
        <div class="card live-hero"><div class="label">Одоо дотор байгаа</div><div class="big" id="lvOcc">—</div><div class="live-sub muted" id="lvOccSub"></div></div>
        <div class="live-side">
          <div class="card kpi"><div class="top"><div class="ico c1">${icon('in')}</div><div class="label">Өнөөдөр орсон</div></div><div class="value" id="lvIn">—</div><div class="bottom"><span class="delta" id="lvInSub"></span></div></div>
          <div class="card kpi"><div class="top"><div class="ico c2">${icon('out')}</div><div class="label">Өнөөдөр гарсан</div></div><div class="value" id="lvOut">—</div><div class="bottom"><span class="delta" id="lvOutSub"></span></div></div>
          <div class="card kpi"><div class="top"><div class="ico c4">${icon('pass')}</div><div class="label">Орох хувь</div></div><div class="value" id="lvRate">—</div><div class="bottom"><span class="delta" id="lvRateSub"></span></div></div>
        </div>
      </div>
      <div class="grid g-2 section">
        <div class="card"><div class="head"><h2>Сүүлийн 60 минут</h2><span class="sub" id="lvLastMin"></span></div><div class="chart-wrap sm"><canvas id="cLive"></canvas></div></div>
        <div class="card"><div class="head"><h2>Шууд урсгал</h2><span class="sub">хүн бүрийн үйл явдал</span></div><div class="ticker" id="lvTicker"><div class="empty">Хүлээж байна…</div></div></div>
      </div>
      <div class="card section"><div class="head"><h2>Төхөөрөмж</h2><span class="sub" id="lvDevSub"></span></div><div class="live-devices" id="lvDevs"></div></div>
    </div>`;
    $('#fsBtn').onclick = toggleFs;
    const seen = new Set(); let lastOcc = null;
    const clock = () => setText('lvClock', new Date().toLocaleTimeString('mn-MN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }));
    async function tick() {
      if (document.hidden || state.page !== 'live') return;
      let d; try { d = await api('/dash/live' + q()); } catch (e) { setText('lvOccSub', 'Холболт тасарсан: ' + esc(e.message)); return; }
      if (state.page !== 'live' || !$('#lvOcc')) return;
      const t = d.today, occ = d.occupancy.total;
      setText('lvOcc', fmt(occ));
      if (lastOcc !== null && lastOcc !== occ) { const el = $('#lvOcc'); el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); } lastOcc = occ;
      setText('lvOccSub', d.occupancy.devices.some((x) => x.from_snapshot) ? 'төхөөрөмжийн бодит тоолол' : 'өнөөдрийн орсон − гарсан');
      setText('lvIn', fmt(t.in_count)); setText('lvOut', fmt(t.out_count)); setText('lvRate', pct(t.in_count, t.in_count + t.passby));
      setText('lvInSub', fmt(t.turnback) + ' буцсан'); setText('lvOutSub', dur(t.avg_stay_ms) + ' дундаж байх'); setText('lvRateSub', fmt(t.passby) + ' өнгөрсөн (орохгүй)');
      // 60 минут — хоосон минутуудыг 0-оор
      const m = {}; d.series.forEach((s) => { m[String(s.bucket).replace(' ', 'T').slice(0, 16)] = s; });
      const now = new Date(d.now); const labels = [], ins = [], outs = []; let last5 = 0;
      for (let i = 59; i >= 0; i--) { const k = tzKey(new Date(now.getTime() - i * 60000)); const s = m[k]; labels.push(k.slice(11)); ins.push(s ? s.in_count : 0); outs.push(s ? s.out_count : 0); if (i < 5 && s) last5 += s.in_count; }
      setText('lvLastMin', `сүүлийн 5 мин: ${fmt(last5)} орсон`);
      if (charts.cLive) { const c = charts.cLive; c.data.labels = labels; c.data.datasets[0].data = ins; c.data.datasets[1].data = outs; c.update('none'); }
      else mk('cLive', { type: 'bar', data: { labels, datasets: [{ label: 'Орсон', data: ins, backgroundColor: css('--s1') }, { label: 'Гарсан', data: outs, backgroundColor: css('--s2') }] },
        options: { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false }, scales: { x: { stacked: false, grid: { display: false }, ticks: { maxTicksLimit: 7 } }, y: { beginAtZero: true, grid: { color: css('--border') }, border: { display: false }, ticks: { precision: 0 } } }, plugins: { legend: { position: 'top', align: 'end' } } } });
      // Ticker — шинэ үйл явдлыг дээр нь нэмнэ
      const tk = $('#lvTicker'); const evs = d.events.slice(0, 30);
      if (!evs.length) tk.innerHTML = '<div class="empty">Сүүлийн 1 цагт үйл явдал ирээгүй</div>';
      else {
        if (tk.querySelector('.empty')) tk.innerHTML = '';
        const fresh = evs.filter((e) => !seen.has(e.id)).reverse();
        for (const e of fresh) {
          seen.add(e.id);
          const [name, cls] = EV[e.event_type] || ['?', ''];
          const who = [e.gender === 1 ? 'Эр' : e.gender === 2 ? 'Эм' : null, e.age_min != null ? `${e.age_min}–${e.age_max}` : null, e.height_cm ? `${e.height_cm} см` : null, e.workcard ? 'ажилтан' : null, e.wheelchair ? 'тэргэнцэр' : null].filter(Boolean).join(' · ');
          const row = document.createElement('div'); row.className = 'tk new';
          row.innerHTML = `<span class="t">${new Date(e.ts).toLocaleTimeString('mn-MN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</span><span class="ev ${cls}">${name}</span><span class="who">${esc(who || '—')}</span><span class="dev">${esc(e.device_name || e.sn)}</span>`;
          tk.prepend(row);
        }
        while (tk.children.length > 30) tk.lastChild.remove();
      }
      // Төхөөрөмж
      const on = d.devices.filter((x) => x.online).length;
      setText('lvDevSub', `${on}/${d.devices.length} online`);
      setText('lvDevs', d.devices.map((x) => `<span class="pill ${x.online ? 'on' : x.last_heartbeat ? 'off' : 'na'}" title="heartbeat ${ago(x.last_heartbeat)} · өгөгдөл ${ago(x.last_data_at)}"><i class="dot"></i>${esc(x.name || x.sn)}${x.location_name ? ' · ' + esc(x.location_name) : ''}</span>`).join('') || '<span class="muted">Төхөөрөмж байхгүй</span>');
      const lu = $('#lastUpd'); if (lu) lu.textContent = 'Шинэчилсэн ' + new Date().toLocaleTimeString('mn-MN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    }
    clock(); await tick();
    state.liveTimers = [setInterval(tick, 5000), setInterval(clock, 1000)];
  }

  const PAGES = { admin: pageAdmin, overview: pageOverview, live: pageLive, locations: pageLocations, devices: pageDevices, demographics: pageDemographics, reid: pageReid, settings: pageSettings };

  // Бодит цагийн шинэчлэл: тойм хуудсыг 60 сек тутам
  setInterval(() => { if (state.user && (state.page === 'overview' || state.page === 'admin') && !document.hidden && !document.querySelector('.modal-bg')) render(); }, 60000);
  boot();
})();

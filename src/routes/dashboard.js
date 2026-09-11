// Dashboard-ийн дотоод API (cookie нэвтрэлт)
const express = require('express');
const db = require('../lib/db');
// Админы үйлдлийн тэмдэглэл (ingest_log-д, status 0 = мэдээлэл)
async function log(path, sn, status, message, body) {
  try { await db.query('INSERT INTO ingest_log(path, sn, status, message, body) VALUES($1,$2,$3,$4,$5)', [path, sn || null, status, message || null, body ? JSON.stringify(body) : null]); }
  catch (e) { console.error('audit log', e.message); }
}
const { query } = db;
const auth = require('../lib/auth');
const stats = require('../lib/stats');

const router = express.Router();

// ---- Нэвтрэлт ----
router.post('/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'И-мэйл, нууц үг шаардлагатай' });
  const r = await query('SELECT * FROM users WHERE lower(email)=lower($1)', [email]);
  const u = r.rows[0];
  if (!u || !(await auth.bcrypt.compare(password, u.password_hash))) return res.status(401).json({ error: 'И-мэйл эсвэл нууц үг буруу' });
  auth.setSessionCookie(res, auth.signSession(u));
  res.json({ ok: true, user: { id: u.id, email: u.email, name: u.name, role: u.role, tenant_id: u.tenant_id } });
});
router.post('/auth/logout', (req, res) => { auth.clearSessionCookie(res); res.json({ ok: true }); });
router.get('/auth/me', auth.requireUser, async (req, res) => {
  let tenant = null;
  if (req.user.tid) tenant = (await query('SELECT id, name, slug FROM tenants WHERE id=$1', [req.user.tid])).rows[0];
  // Төхөөрөмжийн Data Push-д бичих хаяг: HX-CCD21 HTTPS хийж чаддаггүй тул энгийн HTTP хаяг (Railway TCP proxy г.м.) env-ээр өгнө
  const config = {
    push_protocol: process.env.DEVICE_PUSH_PROTOCOL || null, push_host: process.env.DEVICE_PUSH_HOST || null, push_port: process.env.DEVICE_PUSH_PORT || null,
  };
  res.json({ user: req.user, tenant, config });
});
router.post('/auth/password', auth.requireUser, async (req, res) => {
  const { current, next } = req.body || {};
  const u = (await query('SELECT * FROM users WHERE id=$1', [req.user.uid])).rows[0];
  if (!u || !(await auth.bcrypt.compare(current || '', u.password_hash))) return res.status(400).json({ error: 'Одоогийн нууц үг буруу' });
  if (!next || next.length < 6) return res.status(400).json({ error: 'Шинэ нууц үг 6-аас дээш тэмдэгт' });
  await query('UPDATE users SET password_hash=$2 WHERE id=$1', [u.id, await auth.bcrypt.hash(next, 10)]);
  res.json({ ok: true });
});

router.use(auth.requireUser);

// Шүүлтүүр: tenant хамрах хүрээ + байршил/SN/огноо
// "a,b,c" → ['a','b','c'] (нэг утга бол өөрөө, хоосон бол null)
function listParam(v, cast) {
  if (v == null || v === '') return null;
  const a = String(v).split(',').map((x) => x.trim()).filter(Boolean).map(cast).filter((x) => x != null && x === x);
  if (!a.length) return null;
  return a.length === 1 ? a[0] : a;
}

function filters(req) {
  const q = req.query;
  return {
    tenantId: auth.tenantScope(req),
    locationId: listParam(q.location_id, Number),
    sn: listParam(q.sn, String),
    from: q.from || null,
    to: q.to || null,
    granularity: q.granularity || 'hour',
    tz: q.tz || stats.DEFAULT_TZ,
    limit: q.limit,
  };
}
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(e); res.status(500).json({ error: e.message }); });

// ---- Superadmin-ий самбар: байгууллагуудын тоо, төлөв — байгууллагын урсгалын өгөгдөл ОРОХГҮЙ ----
router.get('/admin/summary', auth.requireRole('superadmin'), wrap(async (req, res) => {
  const W = stats.ONLINE_WINDOW_MIN;
  const [totals, tenants, unassigned, errors] = await Promise.all([
    query(`SELECT
        (SELECT count(*)::int FROM tenants) AS tenants,
        (SELECT count(*)::int FROM locations) AS locations,
        (SELECT count(*)::int FROM devices) AS devices,
        (SELECT count(*)::int FROM devices WHERE last_heartbeat > now() - interval '${W} minutes') AS devices_online,
        (SELECT count(*)::int FROM devices WHERE tenant_id IS NULL OR location_id IS NULL) AS devices_unassigned,
        (SELECT count(*)::int FROM users WHERE role<>'superadmin') AS users,
        (SELECT count(*)::int FROM users WHERE role='superadmin') AS superadmins,
        (SELECT count(*)::int FROM api_keys WHERE revoked_at IS NULL) AS api_keys,
        (SELECT count(*)::int FROM ingest_log WHERE created_at > now() - interval '24 hours') AS ingest_errors_24h,
        (SELECT max(last_data_at) FROM devices) AS last_data_at,
        pg_database_size(current_database())::bigint AS db_bytes`),
    query(`SELECT t.id, t.name, t.slug, t.created_at,
        (SELECT string_agg(u.email, ', ' ORDER BY u.email) FROM users u WHERE u.tenant_id=t.id AND u.role='admin') AS admin_emails,
        (SELECT count(*)::int FROM users u WHERE u.tenant_id=t.id) AS user_count,
        (SELECT count(*)::int FROM locations l WHERE l.tenant_id=t.id) AS location_count,
        (SELECT count(*)::int FROM devices d WHERE d.tenant_id=t.id) AS device_count,
        (SELECT count(*)::int FROM devices d WHERE d.tenant_id=t.id AND d.last_heartbeat > now() - interval '${W} minutes') AS online_count,
        (SELECT count(*)::int FROM api_keys k WHERE k.tenant_id=t.id AND k.revoked_at IS NULL) AS api_key_count,
        (SELECT max(k.last_used) FROM api_keys k WHERE k.tenant_id=t.id) AS api_last_used,
        (SELECT max(d.last_data_at) FROM devices d WHERE d.tenant_id=t.id) AS last_data_at,
        (SELECT max(d.last_heartbeat) FROM devices d WHERE d.tenant_id=t.id) AS last_heartbeat
      FROM tenants t ORDER BY t.name`),
    query(`SELECT d.sn, d.name, d.tenant_id, d.location_id, d.first_seen, d.last_heartbeat, d.ip_address, d.sw_release,
        (d.last_heartbeat > now() - interval '${W} minutes') AS online
      FROM devices d WHERE d.tenant_id IS NULL OR d.location_id IS NULL ORDER BY d.first_seen DESC`),
    query(`SELECT path, sn, status, message, created_at FROM ingest_log ORDER BY id DESC LIMIT 10`),
  ]);
  res.json({ totals: totals.rows[0], tenants: tenants.rows, unassigned_devices: unassigned.rows, recent_errors: errors.rows, online_window_min: W });
}));

// ---- Өгөгдөл (зөвхөн байгууллагын admin/viewer; superadmin байгууллагын өгөгдлийг харахгүй) ----
const tenantData = auth.requireRole('admin', 'viewer');
router.use(['/overview', '/live', '/data', '/flow', '/occupancy', '/demographics', '/events', '/reid', '/dedup'], tenantData);
// 30 минутын нэгтгэл (Өгөгдөл хуудас + Хяналтын самбар)
router.get('/data', wrap(async (req, res) => res.json(await stats.dataBuckets(filters(req)))));
// Бодит цагийн самбар: одоо байгаа хүн, өнөөдрийн нийлбэр (from/to query), сүүлийн 60 минут минутаар, сүүлийн 1 цагийн хүн бүрийн үйл явдал, төхөөрөмжийн төлөв
router.get('/live', wrap(async (req, res) => {
  const f = filters(req);
  const now = Date.now();
  const hourAgo = new Date(now - 60 * 60000).toISOString();
  const [occupancy, today, series, live, devices] = await Promise.all([
    stats.currentOccupancy(f),
    stats.flowTotals(f),
    stats.flowSeries({ ...f, from: hourAgo, to: null, granularity: 'minute' }),
    stats.liveVisits(f),
    stats.listDevices(f),
  ]);
  res.json({ now: new Date(now).toISOString(), occupancy, today, series, visits: live.visits, passes: live.passes, devices: devices.map((d) => ({ sn: d.sn, name: d.name, online: d.online, last_heartbeat: d.last_heartbeat, last_data_at: d.last_data_at, location_name: d.location_name })) });
}));
router.get('/overview', wrap(async (req, res) => {
  const f = filters(req);
  const [totals, occupancy, byLocation, byDevice, series] = await Promise.all([
    stats.flowTotals(f), stats.currentOccupancy(f), stats.flowByLocation(f), stats.flowByDevice(f), stats.flowSeries(f),
  ]);
  res.json({ totals, occupancy, by_location: byLocation, by_device: byDevice, series });
}));
router.get('/flow/series', wrap(async (req, res) => res.json(await stats.flowSeries(filters(req)))));
router.get('/flow/totals', wrap(async (req, res) => res.json(await stats.flowTotals(filters(req)))));
router.get('/flow/records', wrap(async (req, res) => res.json(await stats.flowRecords(filters(req)))));
router.get('/flow/heatmap', wrap(async (req, res) => res.json(await stats.heatmap(filters(req)))));
router.get('/occupancy', wrap(async (req, res) => res.json(await stats.currentOccupancy(filters(req)))));
router.get('/demographics', wrap(async (req, res) => res.json(await stats.demographics(filters(req)))));
router.get('/events', wrap(async (req, res) => res.json(await stats.personEvents(filters(req)))));
router.get('/reid', wrap(async (req, res) => res.json(await stats.reidSummary(filters(req)))));
router.get('/dedup', wrap(async (req, res) => res.json(await stats.dedupSummary(filters(req)))));
router.get('/locations', wrap(async (req, res) => res.json(await stats.listLocations(auth.tenantScope(req)))));
router.get('/devices', wrap(async (req, res) => res.json(await stats.listDevices(filters(req)))));
// Төхөөрөмж хэрэглэгчийн хамрах хүрээнд байгаа эсэх (superadmin → бүгд; бусад → өөрийн tenant эсвэл оноогдоогүй)
async function deviceInScope(req, sn) {
  const d = (await query('SELECT sn, tenant_id FROM devices WHERE sn=$1', [sn])).rows[0];
  if (!d) return null;
  if (req.user.role === 'superadmin') return d;
  return (!d.tenant_id || d.tenant_id === req.user.tid) ? d : null;
}
router.get('/devices/:sn/heartbeats', wrap(async (req, res) => {
  if (!(await deviceInScope(req, req.params.sn))) return res.status(404).json({ error: 'Төхөөрөмж олдсонгүй' });
  const r = await query('SELECT ts, payload FROM heartbeats WHERE sn=$1 ORDER BY ts DESC LIMIT 50', [req.params.sn]);
  res.json(r.rows);
}));
router.get('/ingest-log', auth.requireRole('superadmin', 'admin'), wrap(async (req, res) => {
  const r = await query('SELECT id, path, sn, status, message, created_at, body FROM ingest_log ORDER BY id DESC LIMIT 100');
  res.json(r.rows);
}));

// Кирилл нэрийг латин slug болгоно («Номин Холдинг» → nomin-holding)
const CYR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'j', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', ө: 'u', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ү: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sh', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
function slugify(v) {
  return String(v || '').toLowerCase().split('').map((c) => (c in CYR ? CYR[c] : c)).join('')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ---- Tenant (зөвхөн superadmin) ----
router.get('/tenants', auth.requireRole('superadmin'), wrap(async (req, res) => {
  const r = await query(`SELECT t.*, (SELECT count(*) FROM locations l WHERE l.tenant_id=t.id) AS location_count,
    (SELECT count(*) FROM devices d WHERE d.tenant_id=t.id) AS device_count,
    (SELECT count(*) FROM users u WHERE u.tenant_id=t.id) AS user_count,
    (SELECT string_agg(u.email, ', ' ORDER BY u.email) FROM users u WHERE u.tenant_id=t.id AND u.role='admin') AS admin_emails
    FROM tenants t ORDER BY t.name`);
  res.json(r.rows);
}));
// Байгууллага үүсгэх — admin_email/admin_password өгвөл байгууллагын админыг хамт нэг transaction-д үүсгэнэ
router.post('/tenants', auth.requireRole('superadmin'), wrap(async (req, res) => {
  const { name, slug, admin_name, admin_email, admin_password } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Нэр шаардлагатай' });
  const s = slugify(slug || name) || 'tenant-' + Date.now();
  const withAdmin = !!(admin_email || admin_password);
  if (withAdmin) {
    if (!admin_email || !admin_password) return res.status(400).json({ error: 'Админы и-мэйл, нууц үг хоёулаа шаардлагатай' });
    if (admin_password.length < 6) return res.status(400).json({ error: 'Админы нууц үг 6-аас дээш тэмдэгт' });
    const dup = await query('SELECT 1 FROM users WHERE lower(email)=lower($1)', [admin_email]);
    if (dup.rowCount) return res.status(409).json({ error: 'Энэ и-мэйлтэй хэрэглэгч аль хэдийн бүртгэлтэй' });
  }
  const slugDup = await query('SELECT 1 FROM tenants WHERE slug=$1', [s]);
  if (slugDup.rowCount) return res.status(409).json({ error: `"${s}" slug-тай байгууллага байна — өөр slug оруулна уу` });
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const t = (await client.query('INSERT INTO tenants(name, slug) VALUES($1,$2) RETURNING *', [name, s])).rows[0];
    let admin = null;
    if (withAdmin) {
      admin = (await client.query(
        'INSERT INTO users(tenant_id, email, name, password_hash, role) VALUES($1,$2,$3,$4,$5) RETURNING id, email, name, role, tenant_id',
        [t.id, admin_email.trim(), admin_name || '', await auth.bcrypt.hash(admin_password, 10), 'admin'])).rows[0];
    }
    await client.query('COMMIT');
    res.json({ ...t, admin });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}));
router.put('/tenants/:id', auth.requireRole('superadmin'), wrap(async (req, res) => {
  const { name, slug } = req.body || {};
  const r = await query('UPDATE tenants SET name=coalesce($2,name), slug=coalesce($3,slug) WHERE id=$1 RETURNING *', [req.params.id, name, slug]);
  res.json(r.rows[0]);
}));
router.delete('/tenants/:id', auth.requireRole('superadmin'), wrap(async (req, res) => {
  await query('DELETE FROM tenants WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ---- Байршил ----
function ownTenant(req, tenantIdFromBody) {
  if (req.user.role === 'superadmin') return tenantIdFromBody ? Number(tenantIdFromBody) : auth.tenantScope(req);
  return req.user.tid;
}
router.post('/locations', auth.requireRole('superadmin', 'admin'), wrap(async (req, res) => {
  const { name, address, timezone, open_time, close_time, tenant_id } = req.body || {};
  const tid = ownTenant(req, tenant_id);
  if (!tid) return res.status(400).json({ error: 'Tenant сонгоно уу' });
  if (!name) return res.status(400).json({ error: 'Нэр шаардлагатай' });
  const r = await query(
    'INSERT INTO locations(tenant_id, name, address, timezone, open_time, close_time) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
    [tid, name, address || '', timezone || stats.DEFAULT_TZ, open_time || '09:00', close_time || '21:00']);
  res.json(r.rows[0]);
}));
router.put('/locations/:id', auth.requireRole('superadmin', 'admin'), wrap(async (req, res) => {
  const { name, address, timezone, open_time, close_time } = req.body || {};
  const p = [req.params.id, name, address, timezone, open_time, close_time];
  let sql = 'UPDATE locations SET name=coalesce($2,name), address=coalesce($3,address), timezone=coalesce($4,timezone), open_time=coalesce($5,open_time), close_time=coalesce($6,close_time) WHERE id=$1';
  if (req.user.role !== 'superadmin') { p.push(req.user.tid); sql += ` AND tenant_id=$${p.length}`; }
  const r = await query(sql + ' RETURNING *', p);
  if (!r.rowCount) return res.status(404).json({ error: 'Олдсонгүй' });
  res.json(r.rows[0]);
}));
router.delete('/locations/:id', auth.requireRole('superadmin', 'admin'), wrap(async (req, res) => {
  const p = [req.params.id];
  let sql = 'DELETE FROM locations WHERE id=$1';
  if (req.user.role !== 'superadmin') { p.push(req.user.tid); sql += ' AND tenant_id=$2'; }
  await query(sql, p);
  res.json({ ok: true });
}));

// ---- Төхөөрөмж ----
router.put('/devices/:sn', auth.requireRole('superadmin', 'admin'), wrap(async (req, res) => {
  const { name, location_id, tenant_id, upload_interval, data_mode, timezone_offset } = req.body || {};
  const sn = req.params.sn;
  const cur = (await query('SELECT * FROM devices WHERE sn=$1', [sn])).rows[0];
  if (!cur) return res.status(404).json({ error: 'Төхөөрөмж олдсонгүй' });
  // admin ЗӨВХӨН өөрийн байгууллагад хуваарилагдсан төхөөрөмжийг өөрчилнө (хуваарилаагүй SN-ийг superadmin л онооно)
  if (req.user.role !== 'superadmin' && cur.tenant_id !== req.user.tid) return res.status(403).json({ error: 'Энэ төхөөрөмж танай байгууллагад хуваарилагдаагүй байна — superadmin-д хандана уу' });
  let tid = cur.tenant_id;
  if (req.user.role === 'superadmin' && tenant_id !== undefined) tid = tenant_id ? Number(tenant_id) : null;
  if (req.user.role !== 'superadmin') tid = req.user.tid;
  let lid = location_id === undefined ? cur.location_id : (location_id ? Number(location_id) : null);
  if (lid) {
    const loc = (await query('SELECT tenant_id FROM locations WHERE id=$1', [lid])).rows[0];
    if (!loc) return res.status(400).json({ error: 'Байршил олдсонгүй' });
    if (req.user.role !== 'superadmin' && loc.tenant_id !== req.user.tid) return res.status(403).json({ error: 'Байршил өөр байгууллагынх байна' });
    if (req.user.role === 'superadmin' && tid && tid !== loc.tenant_id) return res.status(400).json({ error: 'Байршил сонгосон байгууллагад хамаарахгүй байна' });
    tid = loc.tenant_id; // байршил онооход tenant автоматаар тохирно
  }
  const r = await query(
    `UPDATE devices SET name=coalesce($2,name), location_id=$3, tenant_id=$4,
       upload_interval=coalesce($5,upload_interval), data_mode=coalesce($6,data_mode), timezone_offset=coalesce($7,timezone_offset)
     WHERE sn=$1 RETURNING *`,
    [sn, name, lid, tid, upload_interval != null ? Number(upload_interval) : null, data_mode || null,
      timezone_offset != null ? Number(timezone_offset) : null]);
  res.json(r.rows[0]);
}));
// Төхөөрөмж хуваарилах / холбох.
//  superadmin: SN-ийг байгууллагад ХУВААРИЛНА (tenant_id заавал; байршил сонголтот) — SN урьд нь ирээгүй байсан ч бүртгэнэ
//  admin:      зөвхөн өөрт нь хуваарилагдсан SN-ийг байршилд нь тавина — хуваарилаагүй/өөр байгууллагын SN-ийг авч чадахгүй
router.post('/devices/claim', auth.requireRole('superadmin', 'admin'), wrap(async (req, res) => {
  const { sn: rawSn, location_id, name, tenant_id } = req.body || {};
  const sn = String(rawSn || '').trim();
  if (!sn) return res.status(400).json({ error: 'SN шаардлагатай' });
  const loc = location_id ? (await query('SELECT * FROM locations WHERE id=$1', [location_id])).rows[0] : null;
  if (location_id && !loc) return res.status(400).json({ error: 'Байршил олдсонгүй' });
  const cur = (await query('SELECT * FROM devices WHERE sn=$1', [sn])).rows[0];
  let tid;
  if (req.user.role === 'superadmin') {
    tid = loc ? loc.tenant_id : (tenant_id ? Number(tenant_id) : null);
    if (!tid) return res.status(400).json({ error: 'Байгууллага сонгоно уу' });
    if (loc && tenant_id && Number(tenant_id) !== loc.tenant_id) return res.status(400).json({ error: 'Байршил сонгосон байгууллагад хамаарахгүй байна' });
  } else {
    tid = req.user.tid;
    if (!cur || cur.tenant_id !== tid) return res.status(403).json({ error: 'Энэ SN танай байгууллагад хуваарилагдаагүй байна. Төхөөрөмжийг Footfall-ийн superadmin хуваарилсны дараа энд нэмнэ.' });
    if (loc && loc.tenant_id !== tid) return res.status(403).json({ error: 'Байршил өөр байгууллагынх байна' });
  }
  const r = await query(
    `INSERT INTO devices(sn, tenant_id, location_id, name) VALUES($1,$2,$3,$4)
     ON CONFLICT (sn) DO UPDATE SET tenant_id=EXCLUDED.tenant_id, location_id=COALESCE(EXCLUDED.location_id, CASE WHEN devices.tenant_id=EXCLUDED.tenant_id THEN devices.location_id END),
       name=CASE WHEN EXCLUDED.name<>'' THEN EXCLUDED.name ELSE devices.name END
     RETURNING *`, [sn, tid, loc ? loc.id : null, name || '']);
  res.json(r.rows[0]);
}));

// Түүхэн өгөгдөл дахин татах хүсэлт (90 хоног хүртэл)
router.post('/devices/:sn/resync', auth.requireRole('superadmin', 'admin'), wrap(async (req, res) => {
  const { from, to } = req.body || {};
  if (!from || !to) return res.status(400).json({ error: 'from/to шаардлагатай' });
  if (!(await deviceInScope(req, req.params.sn))) return res.status(404).json({ error: 'Төхөөрөмж олдсонгүй' });
  await query('UPDATE devices SET resync_start=$2, resync_end=$3 WHERE sn=$1', [req.params.sn, from, to]);
  res.json({ ok: true, note: 'Дараагийн heartbeat-д төхөөрөмж рүү илгээнэ' });
}));
// Төхөөрөмжийн өгөгдлийг цэвэрлэх (туршилтын өгөгдөл арилгах): from/to өгвөл тэр хугацааных, үгүй бол бүгд.
// Төхөөрөмж өөрөө, тохиргоо, heartbeat лог хэвээр үлдэнэ.
router.post('/devices/:sn/purge', auth.requireRole('superadmin', 'admin'), wrap(async (req, res) => {
  const sn = req.params.sn;
  if (!(await deviceInScope(req, sn))) return res.status(404).json({ error: 'Төхөөрөмж олдсонгүй' });
  const { from, to } = req.body || {};
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const p = [sn]; let w = '';
    if (from) { p.push(from); w += ` AND ts >= $${p.length}`; }
    if (to) { p.push(to); w += ` AND ts < $${p.length}`; }
    const out = {};
    out.flow_records = (await client.query(`DELETE FROM flow_records WHERE sn=$1${w}`, p)).rowCount;
    out.person_events = (await client.query(`DELETE FROM person_events WHERE sn=$1${w}`, p)).rowCount;
    out.occupancy_snapshots = (await client.query(`DELETE FROM occupancy_snapshots WHERE sn=$1${w}`, p)).rowCount;
    const pd = [sn]; let wd = '';
    if (from) { pd.push(from.slice(0, 10)); wd += ` AND report_date >= $${pd.length}`; }
    if (to) { pd.push(to.slice(0, 10)); wd += ` AND report_date < $${pd.length}`; }
    out.reid_reports = (await client.query(`DELETE FROM reid_reports WHERE master_sn=$1${wd}`, pd)).rowCount;
    out.dedup_reports = (await client.query(`DELETE FROM dedup_reports WHERE master_sn=$1${wd}`, pd)).rowCount;
    if (!from && !to) await client.query('UPDATE devices SET last_data_at=NULL WHERE sn=$1', [sn]);
    await client.query('COMMIT');
    await log(`purge ${sn}`, sn, 0, `${req.user.email} устгав: ${JSON.stringify(out)} ${from || to ? `(${from || '…'} → ${to || '…'})` : '(бүгд)'}`, null);
    res.json({ ok: true, deleted: out });
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}));
router.delete('/devices/:sn', auth.requireRole('superadmin'), wrap(async (req, res) => {
  await query('DELETE FROM devices WHERE sn=$1', [req.params.sn]);
  res.json({ ok: true });
}));

// ---- Хэрэглэгч ----
router.get('/users', auth.requireRole('superadmin', 'admin'), wrap(async (req, res) => {
  const p = [];
  let w = '';
  const tid = auth.tenantScope(req);
  if (tid) { p.push(tid); w = 'WHERE u.tenant_id=$1'; }
  const r = await query(`SELECT u.id, u.email, u.name, u.role, u.tenant_id, t.name AS tenant_name, u.created_at
    FROM users u LEFT JOIN tenants t ON t.id=u.tenant_id ${w} ORDER BY u.email`, p);
  res.json(r.rows);
}));
router.post('/users', auth.requireRole('superadmin', 'admin'), wrap(async (req, res) => {
  const { email, name, password, role, tenant_id } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'И-мэйл, нууц үг шаардлагатай' });
  let r = role || 'viewer';
  let tid = ownTenant(req, tenant_id);
  if (req.user.role !== 'superadmin' && r === 'superadmin') r = 'admin';
  if (r === 'superadmin') tid = null;
  if (r !== 'superadmin' && !tid) return res.status(400).json({ error: 'Tenant сонгоно уу' });
  const out = await query('INSERT INTO users(tenant_id, email, name, password_hash, role) VALUES($1,$2,$3,$4,$5) RETURNING id, email, name, role, tenant_id',
    [tid, email, name || '', await auth.bcrypt.hash(password, 10), r]);
  res.json(out.rows[0]);
}));
router.delete('/users/:id', auth.requireRole('superadmin', 'admin'), wrap(async (req, res) => {
  const p = [req.params.id];
  let sql = 'DELETE FROM users WHERE id=$1 AND id<>$2';
  p.push(req.user.uid);
  if (req.user.role !== 'superadmin') { p.push(req.user.tid); sql += ' AND tenant_id=$3'; }
  await query(sql, p);
  res.json({ ok: true });
}));

// ---- API түлхүүр ----
router.get('/api-keys', auth.requireRole('superadmin', 'admin'), wrap(async (req, res) => {
  const p = [];
  let w = 'WHERE k.revoked_at IS NULL';
  const tid = auth.tenantScope(req);
  if (tid) { p.push(tid); w += ' AND k.tenant_id=$1'; }
  const r = await query(`SELECT k.id, k.name, k.prefix, k.scopes, k.last_used, k.created_at, k.tenant_id, t.name AS tenant_name
    FROM api_keys k JOIN tenants t ON t.id=k.tenant_id ${w} ORDER BY k.created_at DESC`, p);
  res.json(r.rows);
}));
router.post('/api-keys', auth.requireRole('superadmin', 'admin'), wrap(async (req, res) => {
  const { name, tenant_id } = req.body || {};
  const tid = ownTenant(req, tenant_id);
  if (!tid) return res.status(400).json({ error: 'Tenant сонгоно уу' });
  const k = auth.generateApiKey();
  const r = await query('INSERT INTO api_keys(tenant_id, name, prefix, key_hash) VALUES($1,$2,$3,$4) RETURNING id, name, prefix, created_at',
    [tid, name || 'API түлхүүр', k.prefix, k.hash]);
  res.json({ ...r.rows[0], key: k.raw }); // raw түлхүүр зөвхөн энэ удаа харагдана
}));
router.delete('/api-keys/:id', auth.requireRole('superadmin', 'admin'), wrap(async (req, res) => {
  const p = [req.params.id];
  let sql = 'UPDATE api_keys SET revoked_at=now() WHERE id=$1';
  if (req.user.role !== 'superadmin') { p.push(req.user.tid); sql += ' AND tenant_id=$2'; }
  await query(sql, p);
  res.json({ ok: true });
}));

module.exports = router;

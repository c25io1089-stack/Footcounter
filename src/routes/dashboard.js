// Dashboard-ийн дотоод API (cookie нэвтрэлт)
const express = require('express');
const { query } = require('../lib/db');
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
  res.json({ user: req.user, tenant });
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
function filters(req) {
  const q = req.query;
  return {
    tenantId: auth.tenantScope(req),
    locationId: q.location_id ? Number(q.location_id) : null,
    sn: q.sn || null,
    from: q.from || null,
    to: q.to || null,
    granularity: q.granularity || 'hour',
    tz: q.tz || stats.DEFAULT_TZ,
    limit: q.limit,
  };
}
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(e); res.status(500).json({ error: e.message }); });

// ---- Өгөгдөл ----
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
router.get('/devices/:sn/heartbeats', wrap(async (req, res) => {
  const r = await query('SELECT ts, payload FROM heartbeats WHERE sn=$1 ORDER BY ts DESC LIMIT 50', [req.params.sn]);
  res.json(r.rows);
}));
router.get('/ingest-log', auth.requireRole('superadmin', 'admin'), wrap(async (req, res) => {
  const r = await query('SELECT id, path, sn, status, message, created_at, body FROM ingest_log ORDER BY id DESC LIMIT 100');
  res.json(r.rows);
}));

// ---- Tenant (зөвхөн superadmin) ----
router.get('/tenants', auth.requireRole('superadmin'), wrap(async (req, res) => {
  const r = await query(`SELECT t.*, (SELECT count(*) FROM locations l WHERE l.tenant_id=t.id) AS location_count,
    (SELECT count(*) FROM devices d WHERE d.tenant_id=t.id) AS device_count,
    (SELECT count(*) FROM users u WHERE u.tenant_id=t.id) AS user_count FROM tenants t ORDER BY t.name`);
  res.json(r.rows);
}));
router.post('/tenants', auth.requireRole('superadmin'), wrap(async (req, res) => {
  const { name, slug } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Нэр шаардлагатай' });
  const s = (slug || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'tenant-' + Date.now();
  const r = await query('INSERT INTO tenants(name, slug) VALUES($1,$2) RETURNING *', [name, s]);
  res.json(r.rows[0]);
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
  // admin зөвхөн өөрийн tenant-ийн эсвэл оноогдоогүй төхөөрөмжийг өөрчилнө
  if (req.user.role !== 'superadmin' && cur.tenant_id && cur.tenant_id !== req.user.tid) return res.status(403).json({ error: 'Эрх хүрэлцэхгүй' });
  let tid = cur.tenant_id;
  if (req.user.role === 'superadmin' && tenant_id !== undefined) tid = tenant_id ? Number(tenant_id) : null;
  if (req.user.role !== 'superadmin') tid = req.user.tid;
  let lid = location_id === undefined ? cur.location_id : (location_id ? Number(location_id) : null);
  if (lid) {
    const loc = (await query('SELECT tenant_id FROM locations WHERE id=$1', [lid])).rows[0];
    if (!loc) return res.status(400).json({ error: 'Байршил олдсонгүй' });
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
// Оноогдоогүй төхөөрөмжийг SN-ээр өөрийн байгууллагад холбох (admin)
router.post('/devices/claim', auth.requireRole('superadmin', 'admin'), wrap(async (req, res) => {
  const { sn, location_id, name } = req.body || {};
  if (!sn) return res.status(400).json({ error: 'SN шаардлагатай' });
  const loc = location_id ? (await query('SELECT * FROM locations WHERE id=$1', [location_id])).rows[0] : null;
  if (location_id && !loc) return res.status(400).json({ error: 'Байршил олдсонгүй' });
  const tid = loc ? loc.tenant_id : ownTenant(req);
  if (!tid) return res.status(400).json({ error: 'Байршил сонгоно уу' });
  if (req.user.role !== 'superadmin' && tid !== req.user.tid) return res.status(403).json({ error: 'Эрх хүрэлцэхгүй' });
  const cur = (await query('SELECT * FROM devices WHERE sn=$1', [sn.trim()])).rows[0];
  if (cur && cur.tenant_id && cur.tenant_id !== tid && req.user.role !== 'superadmin') return res.status(409).json({ error: 'Энэ SN өөр байгууллагад бүртгэлтэй байна' });
  const r = await query(
    `INSERT INTO devices(sn, tenant_id, location_id, name) VALUES($1,$2,$3,$4)
     ON CONFLICT (sn) DO UPDATE SET tenant_id=EXCLUDED.tenant_id, location_id=EXCLUDED.location_id, name=CASE WHEN EXCLUDED.name<>'' THEN EXCLUDED.name ELSE devices.name END
     RETURNING *`, [sn.trim(), tid, loc ? loc.id : null, name || '']);
  res.json(r.rows[0]);
}));

// Түүхэн өгөгдөл дахин татах хүсэлт (90 хоног хүртэл)
router.post('/devices/:sn/resync', auth.requireRole('superadmin', 'admin'), wrap(async (req, res) => {
  const { from, to } = req.body || {};
  if (!from || !to) return res.status(400).json({ error: 'from/to шаардлагатай' });
  await query('UPDATE devices SET resync_start=$2, resync_end=$3 WHERE sn=$1', [req.params.sn, from, to]);
  res.json({ ok: true, note: 'Дараагийн heartbeat-д төхөөрөмж рүү илгээнэ' });
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

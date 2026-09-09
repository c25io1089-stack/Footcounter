require('dotenv').config();
const express = require('express');
const path = require('path');
const helmet = require('helmet');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const { init, migrate, query, describe, APP_TZ } = require('./lib/db');
const auth = require('./lib/auth');

const app = express();
app.set('trust proxy', 1); // Railway proxy ард

app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(express.json({ limit: '20mb', type: ['application/json', 'text/plain', 'application/*+json'] }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// Төхөөрөмжөөс ирэх body заримдаа text/plain байдаг тул JSON-г гараар задлана
app.use((req, res, next) => {
  if (typeof req.body === 'string') { try { req.body = JSON.parse(req.body); } catch { /* ignore */ } }
  next();
});

// Буруу JSON / хэт том body → HTML биш, протоколын маягийн JSON хариу
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
    return res.status(200).json({ code: 2, msg: 'invalid body: ' + err.type });
  }
  next(err);
});

app.get('/health', async (req, res) => {
  try { await query('SELECT 1'); res.json({ ok: true, time: new Date().toISOString() }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 1) Төхөөрөмжийн ingest (нэвтрэлтгүй; SN-ээр таньдаг)
app.use(require('./routes/ingest'));
// 2) Dashboard дотоод API
app.use('/dash', require('./routes/dashboard'));
// 3) Гадаад REST API
app.use('/api/v1', require('./routes/publicApi'));

// Статик dashboard
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
app.get(['/', '/app', '/app/{*splat}'], (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// Анхны superadmin үүсгэх (ADMIN_EMAIL / ADMIN_PASSWORD орчны хувьсагч)
async function seedAdmin() {
  const n = await query('SELECT count(*)::int AS n FROM users');
  if (n.rows[0].n > 0) return;
  const email = process.env.ADMIN_EMAIL || 'admin@example.com';
  const password = process.env.ADMIN_PASSWORD || 'admin1234';
  await query('INSERT INTO users(tenant_id, email, name, password_hash, role) VALUES(NULL,$1,$2,$3,$4)',
    [email, 'Супер админ', await auth.bcrypt.hash(password, 10), 'superadmin']);
  console.log(`Анхны superadmin үүсгэв: ${email} (нууц үг: ${process.env.ADMIN_PASSWORD ? '***' : password})`);
}

// Хуучин лог цэвэрлэх (ingest_log 7 хоног, heartbeats 30 хоног)
async function housekeeping() {
  try {
    await query(`DELETE FROM ingest_log WHERE created_at < now() - interval '7 days'`);
    await query(`DELETE FROM heartbeats WHERE ts < now() - interval '30 days'`);
    await query(`DELETE FROM occupancy_snapshots WHERE ts < now() - interval '90 days'`);
  } catch (e) { console.error('housekeeping', e.message); }
}

const PORT = process.env.PORT || 3000;
process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));
process.on('uncaughtException', (e) => { console.error('uncaughtException', e); process.exit(1); });

(async () => {
  console.log(`Footfall эхэлж байна · node ${process.version} · PORT ${PORT} · NODE_ENV ${process.env.NODE_ENV || '-'} · APP_TZ ${APP_TZ} · DB ${describe()}`);
  await init();       // Postgres холболт (SSL авто-тодорхойлолт, дахин оролдлого)
  await migrate();
  await seedAdmin();
  await housekeeping();
  setInterval(housekeeping, 6 * 3600 * 1000);
  app.listen(PORT, '0.0.0.0', () => console.log(`Footfall dashboard: http://localhost:${PORT}`));
})().catch((e) => { console.error('Эхлүүлэх алдаа:', e && e.message ? e.message : e); process.exit(1); });

const { Pool, types } = require('pg');
// DATE → 'YYYY-MM-DD' мөр (JS Date-д хөрвүүлж цагийн бүсээр гажуулахгүй), int8 → Number
types.setTypeParser(1082, (v) => v);
types.setTypeParser(20, (v) => Number(v));
// TIMESTAMP (цагийн бүсгүй, date_trunc … AT TIME ZONE-ийн үр дүн) → мөр хэвээр (серверийн локал цагаар гажуулахгүй)
types.setTypeParser(1114, (v) => v);
const fs = require('fs');
const path = require('path');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL тохируулаагүй байна');
  process.exit(1);
}

// SSL: Railway-ийн ГАДААД proxy (proxy.rlwy.net), Render/Supabase/Neon/RDS шаарддаг; local болон Railway-ийн
// ДОТООД сүлжээ (*.railway.internal — SSL дэмждэггүй, SSL албадвал "server does not support SSL" гэж унана) хэрэггүй.
// PGSSL=1 албадан асаана, PGSSL=0 албадан унтраана; URL-д sslmode=disable байвал мөн унтарна.
const url = connectionString.toLowerCase();
let needSsl = /rlwy\.net|railway\.app|render\.com|supabase|neon\.tech|amazonaws/.test(url);
if (/\.railway\.internal|sslmode=disable/.test(url)) needSsl = false;
if (process.env.PGSSL === '1') needSsl = true;
if (process.env.PGSSL === '0') needSsl = false;
// Огноо-only ('2026-09-01') утгууд серверийн биш, дэлгүүрийн цагийн бүсээр тайлбарлагдана (Railway UTC дээр ч).
// Startup параметрээр өгнө — холболт бүрд SET явуулах шаардлагагүй.
const APP_TZ = process.env.APP_TZ || 'Asia/Ulaanbaatar';
const pool = new Pool({
  connectionString,
  ssl: needSsl ? { rejectUnauthorized: false } : false,
  max: 10,
  options: `-c TimeZone=${APP_TZ}`,
});

pool.on('error', (err) => console.error('PG pool алдаа', err));

async function query(text, params) {
  return pool.query(text, params);
}

async function migrate() {
  await query(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`);
  const dir = path.join(__dirname, '..', '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const done = await query('SELECT 1 FROM _migrations WHERE name=$1', [f]);
    if (done.rowCount) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _migrations(name) VALUES($1)', [f]);
      await client.query('COMMIT');
      console.log('Migration хэрэгжүүлэв:', f);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}

module.exports = { pool, query, migrate, APP_TZ };

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

// Нууц үггүй хост тайлбар (логд)
function describe() {
  try { const u = new URL(connectionString); return `${u.hostname}:${u.port || 5432}${u.pathname}`; } catch { return '(URL задлагдсангүй)'; }
}

function makePool(ssl) {
  const p = new Pool({
    connectionString,
    ssl: ssl ? { rejectUnauthorized: false } : false,
    max: 10,
    options: `-c TimeZone=${APP_TZ}`,
    connectionTimeoutMillis: 10000,
  });
  p.on('error', (err) => console.error('PG pool алдаа', err.message));
  return p;
}

let pool = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Асахдаа: таамагласан SSL горимоор, бүтэлгүйтвэл эсрэг горимоор туршина (Railway дотоод/гадаад, SSL-тэй/гүй Postgres
// аль ч байсан ажиллана). DB бэлэн болоогүй байж болзошгүй тул нийт ~60 сек хүртэл дахин оролдоно.
async function init() {
  const modes = needSsl ? [true, false] : [false, true];
  let lastErr = null;
  for (let attempt = 1; attempt <= 12; attempt++) {
    for (const ssl of modes) {
      const p = makePool(ssl);
      try {
        const r = await p.query('SELECT current_setting(\'server_version\') AS v, current_setting(\'TimeZone\') AS tz');
        pool = p;
        console.log(`PG холбогдов: ${describe()} · ssl=${ssl} · Postgres ${r.rows[0].v} · TimeZone ${r.rows[0].tz}`);
        return;
      } catch (e) {
        lastErr = e;
        console.warn(`PG холболт бүтэлгүй (оролдлого ${attempt}, ssl=${ssl}): ${e.message}`);
        await p.end().catch(() => {});
      }
    }
    await sleep(5000);
  }
  throw new Error(`Postgres-д холбогдож чадсангүй (${describe()}): ${lastErr && lastErr.message}`);
}

async function query(text, params) {
  if (!pool) throw new Error('DB init хийгдээгүй');
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

// pool-ийг getter-ээр өгнө — init() дуусахаас өмнө require хийсэн модулиуд ч шинэ pool-ийг авна
module.exports = { get pool() { return pool; }, init, query, migrate, APP_TZ, describe };

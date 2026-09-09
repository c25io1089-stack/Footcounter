const { Pool, types } = require('pg');
// DATE → 'YYYY-MM-DD' мөр (JS Date-д хөрвүүлж цагийн бүсээр гажуулахгүй), int8 → Number
types.setTypeParser(1082, (v) => v);
types.setTypeParser(20, (v) => Number(v));
const fs = require('fs');
const path = require('path');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL тохируулаагүй байна');
  process.exit(1);
}

// Railway Postgres нь SSL шаарддаг; local-д хэрэггүй
const needSsl = /railway|render|supabase|neon|amazonaws/i.test(connectionString) || process.env.PGSSL === '1';
const pool = new Pool({
  connectionString,
  ssl: needSsl ? { rejectUnauthorized: false } : false,
  max: 10,
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

module.exports = { pool, query, migrate };

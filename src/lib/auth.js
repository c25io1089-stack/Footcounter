const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { query } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) console.warn('JWT_SECRET тохируулаагүй — сервер дахин асахад нэвтрэлт хүчингүй болно');

const COOKIE = 'hx_session';

function signSession(user) {
  return jwt.sign(
    { uid: user.id, tid: user.tenant_id, role: user.role, email: user.email, name: user.name },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function setSessionCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 3600 * 1000,
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE);
}

// Dashboard хэрэглэгчийн нэвтрэлт (cookie)
function requireUser(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE];
  if (!token) return res.status(401).json({ error: 'Нэвтрээгүй байна' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Нэвтрэлт хүчингүй' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) return res.status(403).json({ error: 'Эрх хүрэлцэхгүй' });
    next();
  };
}

// Гадаад REST API түлхүүр (X-API-Key)
function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function generateApiKey() {
  const raw = 'hx_' + crypto.randomBytes(24).toString('base64url');
  return { raw, prefix: raw.slice(0, 10), hash: hashKey(raw) };
}

async function requireApiKey(req, res, next) {
  const key = req.get('x-api-key') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '') || req.query.api_key;
  if (!key) return res.status(401).json({ error: 'X-API-Key толгой шаардлагатай' });
  const r = await query(
    `SELECT k.id, k.tenant_id, k.scopes, t.name AS tenant_name FROM api_keys k JOIN tenants t ON t.id=k.tenant_id
     WHERE k.key_hash=$1 AND k.revoked_at IS NULL`,
    [hashKey(key)]
  );
  if (!r.rowCount) return res.status(401).json({ error: 'API түлхүүр буруу эсвэл хүчингүй' });
  req.apiKey = r.rows[0];
  req.tenantId = r.rows[0].tenant_id;
  query('UPDATE api_keys SET last_used=now() WHERE id=$1', [r.rows[0].id]).catch(() => {});
  next();
}

// Tenant хамрах хүрээ: superadmin бол ?tenant_id=, бусад бол өөрийн tenant
function tenantScope(req) {
  if (req.tenantId) return req.tenantId; // API key
  if (req.user.role === 'superadmin') {
    const t = req.query.tenant_id || req.headers['x-tenant-id'];
    return t ? Number(t) : null; // null = бүх tenant
  }
  return req.user.tid;
}

module.exports = {
  signSession, setSessionCookie, clearSessionCookie, requireUser, requireRole,
  requireApiKey, generateApiKey, hashKey, tenantScope, bcrypt, COOKIE,
};

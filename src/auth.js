'use strict';
const crypto = require('node:crypto');
const config = require('./config');

const SECRET = config.secret;
const COOKIE = config.session.cookieName;
const MAX_AGE_DAYS = config.session.days;

/* ---------- password hashing (scrypt, no external deps) ---------- */

function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(plain, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(plain, stored) {
  const [scheme, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const candidate = crypto.scryptSync(plain, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

/* ---------- stateless signed token stored in an httpOnly cookie ---------- */

const b64 = (s) => Buffer.from(s).toString('base64url');
const unb64 = (s) => Buffer.from(s, 'base64url').toString();

function signToken(payload) {
  const body = b64(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function readToken(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(unb64(body));
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch { return null; }
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setAuthCookie(res, user) {
  const token = signToken({
    uid: user.id,
    role: user.role,
    exp: Date.now() + MAX_AGE_DAYS * 86400_000,
  });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.session.secure,     // HTTPS-only once COOKIE_SECURE / production is on
    maxAge: MAX_AGE_DAYS * 86400_000,
  });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE);
}

/* ---------- middleware ---------- */

const DRIVER = config.driver;

/** Looks the user up in whichever database this deployment is using. */
async function loadUser(id) {
  if (DRIVER === 'sqlite') {
    // Required lazily: loading db.js creates data/cinema.db, which would fail on
    // read-only hosting filesystems where SQLite is not even in use.
    return require('./db').db.prepare('SELECT id, name, email, phone, role, blocked FROM users WHERE id = ?').get(id);
  }
  const user = await require('./store').findUserById(id);
  if (!user) return null;
  return { id: user.id, name: user.name, email: user.email, phone: user.phone, role: user.role, blocked: user.blocked };
}

/** Attaches req.user when a valid cookie is present. Never rejects. */
async function attachUser(req, _res, next) {
  req.user = null;
  try {
    const token = parseCookies(req.headers.cookie || '')[COOKIE];
    const data = readToken(token);
    if (data) {
      const user = await loadUser(data.uid);
      if (user && !user.blocked) req.user = user;
    }
  } catch (err) {
    console.error('attachUser failed:', err.message);
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Login required' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Login required' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access only' });
  next();
}

/** Single-use, time-limited token for a password reset link. */
const newResetToken = () => crypto.randomBytes(24).toString('base64url');

module.exports = {
  hashPassword, verifyPassword, newResetToken,
  setAuthCookie, clearAuthCookie,
  attachUser, requireAuth, requireAdmin,
  COOKIE,
};

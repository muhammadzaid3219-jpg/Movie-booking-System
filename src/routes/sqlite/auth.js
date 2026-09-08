'use strict';
const express = require('express');
const { db } = require('../../db');
const A = require('../../auth');
const config = require('../../config');

const router = express.Router();

const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || ''));
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role });

/** Local wall-clock stamp, matching how show times are stored. */
function now(offsetMinutes = 0) {
  const d = new Date(Date.now() + offsetMinutes * 60_000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

router.post('/register', (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const phone = String(req.body.phone || '').trim();
  const password = String(req.body.password || '');

  if (name.length < 3) return res.status(400).json({ error: 'Name must be at least 3 characters' });
  if (!emailOk(email)) return res.status(400).json({ error: 'Enter a valid email address' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'This email is already registered' });
  }

  const info = db.prepare('INSERT INTO users (name, email, phone, password_hash) VALUES (?, ?, ?, ?)')
    .run(name, email, phone, A.hashPassword(password));

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  A.setAuthCookie(res, user);
  res.status(201).json({ user: publicUser(user) });
});

router.post('/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!row || !A.verifyPassword(password, row.password_hash)) {
    return res.status(401).json({ error: 'Email or password is incorrect' });
  }
  if (row.blocked) return res.status(403).json({ error: 'Your account has been blocked' });

  A.setAuthCookie(res, row);
  res.json({ user: publicUser(row) });
});

router.post('/logout', (_req, res) => {
  A.clearAuthCookie(res);
  res.json({ ok: true });
});

router.get('/me', (req, res) => res.json({ user: req.user }));

router.patch('/me', A.requireAuth, (req, res) => {
  const name = String(req.body.name || '').trim();
  const phone = String(req.body.phone || '').trim();
  if (name.length < 3) return res.status(400).json({ error: 'Name must be at least 3 characters' });

  db.prepare('UPDATE users SET name = ?, phone = ? WHERE id = ?').run(name, phone, req.user.id);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
});

router.post('/change-password', A.requireAuth, (req, res) => {
  const current = String(req.body.current_password || '');
  const next = String(req.body.new_password || '');
  if (next.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });

  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!A.verifyPassword(current, row.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(A.hashPassword(next), req.user.id);
  res.json({ ok: true });
});

/* ---------------- forgot / reset password ---------------- */

/**
 * Answers identically whether or not the email exists, so this cannot be used
 * to discover which addresses are registered.
 */
router.post('/forgot-password', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const generic = { ok: true, message: 'If that email is registered, a reset link has been sent to it.' };
  if (!emailOk(email)) return res.json(generic);

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || user.blocked) return res.json(generic);

  const token = A.newResetToken();
  const expires = now(config.passwordReset.ttlMinutes);
  db.prepare('INSERT INTO password_resets (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, user.id, expires);

  const link = `/reset-password.html?token=${token}`;
  console.log(`[password reset] ${email} -> ${link} (valid until ${expires})`);

  res.json(config.passwordReset.revealLink ? { ...generic, reset_link: link, expires_at: expires } : generic);
});

router.get('/reset-password/:token', (req, res) => {
  const row = db.prepare('SELECT * FROM password_resets WHERE token = ?').get(req.params.token);
  const valid = Boolean(row) && !row.used && row.expires_at > now();
  res.json({ valid, expires_at: valid ? row.expires_at : null });
});

router.post('/reset-password', (req, res) => {
  const token = String(req.body.token || '');
  const password = String(req.body.password || '');
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const row = db.prepare('SELECT * FROM password_resets WHERE token = ?').get(token);
  if (!row || row.used || row.expires_at <= now()) {
    return res.status(400).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });
  }

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(A.hashPassword(password), row.user_id);
  db.prepare('UPDATE password_resets SET used = 1 WHERE token = ?').run(token);
  res.json({ ok: true, message: 'Password updated. You can log in now.' });
});

module.exports = router;

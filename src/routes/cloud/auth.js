'use strict';
const express = require('express');
const S = require('../../store');
const A = require('../../auth');
const config = require('../../config');
const FA = require('../../firebaseauth');

const router = express.Router();
const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || ''));
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role });

router.post('/register', async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const phone = String(req.body.phone || '').trim();
  const password = String(req.body.password || '');

  if (name.length < 3) return res.status(400).json({ error: 'Name must be at least 3 characters' });
  if (!emailOk(email)) return res.status(400).json({ error: 'Enter a valid email address' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  if (await S.findUserByEmail(email)) {
    return res.status(409).json({ error: 'This email is already registered' });
  }

  /*
   * With Firebase Auth the credentials live there and the profile record here,
   * joined by firebase_uid. Locally the password hash sits on the profile.
   */
  let extra = { password_hash: A.hashPassword(password) };
  if (FA.isEnabled()) {
    if (await FA.getByEmail(email)) {
      return res.status(409).json({ error: 'This email is already registered' });
    }
    try {
      extra = { firebase_uid: await FA.createUser({ email, password, name, phone }) };
    } catch (e) {
      return res.status(400).json({ error: e.message.replace(/^.*?: /, '') });
    }
  }

  const user = await S.createUser({ name, email, phone, ...extra });
  A.setAuthCookie(res, user);
  res.status(201).json({ user: publicUser(user) });
});

router.post('/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  const row = await S.findUserByEmail(email);

  if (FA.isEnabled()) {
    const check = await FA.verifyPassword(email, password);
    if (check.error) return res.status(401).json({ error: check.error });
    if (!row) return res.status(401).json({ error: 'Email or password is incorrect' });
  } else if (!row || !A.verifyPassword(password, row.password_hash)) {
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

router.patch('/me', A.requireAuth, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const phone = String(req.body.phone || '').trim();
  if (name.length < 3) return res.status(400).json({ error: 'Name must be at least 3 characters' });

  await S.updateUser(req.user.id, { name, phone });

  const updated = await S.findUserById(req.user.id);
  if (FA.isEnabled() && updated.firebase_uid) await FA.updateUser(updated.firebase_uid, { name });

  res.json({ user: publicUser(updated) });
});

router.post('/change-password', A.requireAuth, async (req, res) => {
  const current = String(req.body.current_password || '');
  const next = String(req.body.new_password || '');
  if (next.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });

  const row = await S.findUserById(req.user.id);

  if (FA.isEnabled()) {
    const check = await FA.verifyPassword(row.email, current);
    if (check.error) return res.status(400).json({ error: 'Current password is incorrect' });
    await FA.updateUser(row.firebase_uid || check.uid, { password: next });
  } else {
    if (!A.verifyPassword(current, row.password_hash)) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }
    await S.updateUser(req.user.id, { password_hash: A.hashPassword(next) });
  }
  res.json({ ok: true });
});

/* ---------------- forgot / reset password ---------------- */

/**
 * Always answers the same way whether or not the email exists, so this cannot
 * be used to discover which addresses are registered.
 */
router.post('/forgot-password', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const generic = { ok: true, message: 'If that email is registered, a reset link has been sent to it.' };
  if (!emailOk(email)) return res.json(generic);

  const user = await S.findUserByEmail(email);
  if (!user || user.blocked) return res.json(generic);

  const token = A.newResetToken();
  const expires = S.now(config.passwordReset.ttlMinutes);
  await S.saveResetToken(token, user.id, expires);

  // A real deployment emails this. Until a mail service is wired up the link is
  // returned directly in development so the flow is testable end to end.
  const link = `/reset-password.html?token=${token}`;
  console.log(`[password reset] ${email} -> ${link} (valid until ${expires})`);

  res.json(config.passwordReset.revealLink ? { ...generic, reset_link: link, expires_at: expires } : generic);
});

/** Lets the reset page tell the user up front that a link is stale. */
router.get('/reset-password/:token', async (req, res) => {
  const row = await S.getResetToken(req.params.token);
  const valid = Boolean(row) && !row.used && row.expires_at > S.now();
  res.json({ valid, expires_at: valid ? row.expires_at : null });
});

router.post('/reset-password', async (req, res) => {
  const token = String(req.body.token || '');
  const password = String(req.body.password || '');
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const row = await S.getResetToken(token);
  if (!row || row.used || row.expires_at <= S.now()) {
    return res.status(400).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });
  }

  if (FA.isEnabled()) {
    const profile = await S.findUserById(row.user_id);
    const uid = profile?.firebase_uid || (await FA.getByEmail(profile.email))?.uid;
    if (!uid) return res.status(400).json({ error: 'This account has no Firebase login yet.' });
    await FA.updateUser(uid, { password });
  } else {
    await S.updateUser(row.user_id, { password_hash: A.hashPassword(password) });
  }
  await S.consumeResetToken(token);
  res.json({ ok: true, message: 'Password updated. You can log in now.' });
});

module.exports = router;

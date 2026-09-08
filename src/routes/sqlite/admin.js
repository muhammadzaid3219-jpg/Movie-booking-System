'use strict';
const express = require('express');
const { db, tx, releaseExpiredHolds } = require('../../db');
const A = require('../../auth');
const config = require('../../config');

const router = express.Router();
router.use(A.requireAdmin);

const ROW_LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DEFAULT_MULTIPLIER = { SILVER: 1.0, GOLD: 1.5, RECLINER: 2.2 };

/* =========================================================
   shared helpers
   ========================================================= */

const clamp = (n, lo, hi) => Math.min(Math.max(Number(n) || 0, lo), hi);

/**
 * Reads the seat-tier layout an admin submitted.
 * Falls back to the classic split (front Silver, middle Gold, back row Recliner).
 */
function readLayout(body) {
  const cols = clamp(body.col_count ?? 12, 1, 30);
  const hasTiers = body.silver_rows != null || body.gold_rows != null || body.recliner_rows != null;

  let tiers;
  if (hasTiers) {
    tiers = [
      { type: 'SILVER', rows: clamp(body.silver_rows ?? 0, 0, 26) },
      { type: 'GOLD', rows: clamp(body.gold_rows ?? 0, 0, 26) },
      { type: 'RECLINER', rows: clamp(body.recliner_rows ?? 0, 0, 26) },
    ];
  } else {
    const total = clamp(body.row_count ?? 8, 1, 26);
    const recliner = total > 1 ? 1 : 0;
    const gold = Math.max(0, total - recliner - Math.floor(total / 2));
    tiers = [
      { type: 'SILVER', rows: total - recliner - gold },
      { type: 'GOLD', rows: gold },
      { type: 'RECLINER', rows: recliner },
    ];
  }

  const rows = tiers.reduce((sum, t) => sum + t.rows, 0);
  if (rows < 1) return { error: 'A screen needs at least one row of seats' };
  if (rows > 26) return { error: 'A screen can have at most 26 rows' };

  const mult = {
    SILVER: Number(body.silver_price ?? DEFAULT_MULTIPLIER.SILVER) || DEFAULT_MULTIPLIER.SILVER,
    GOLD: Number(body.gold_price ?? DEFAULT_MULTIPLIER.GOLD) || DEFAULT_MULTIPLIER.GOLD,
    RECLINER: Number(body.recliner_price ?? DEFAULT_MULTIPLIER.RECLINER) || DEFAULT_MULTIPLIER.RECLINER,
  };

  return { rows, cols, tiers, mult };
}

/** Deletes any existing seats for the screen and lays out a fresh grid. */
function buildSeats(screenId, layout) {
  db.prepare('DELETE FROM seats WHERE screen_id = ?').run(screenId);
  const ins = db.prepare(
    'INSERT INTO seats (screen_id, row_label, seat_no, seat_type, price_multiplier) VALUES (?, ?, ?, ?, ?)'
  );
  let r = 0;
  for (const tier of layout.tiers) {
    for (let i = 0; i < tier.rows; i++, r++) {
      for (let c = 1; c <= layout.cols; c++) {
        ins.run(screenId, ROW_LABELS[r], c, tier.type, layout.mult[tier.type]);
      }
    }
  }
}

/** Seats already sold or held on this screen — a layout change would orphan them. */
function screenIsInUse(screenId) {
  return db.prepare(`
    SELECT COUNT(*) AS v FROM booking_seats bs
      JOIN seats st ON st.id = bs.seat_id
     WHERE st.screen_id = ?`).get(screenId).v > 0;
}

/* =========================================================
   dashboard
   ========================================================= */

router.get('/stats', (_req, res) => {
  releaseExpiredHolds();
  const one = (sql, ...p) => db.prepare(sql).get(...p);

  const revenue = one(`SELECT IFNULL(SUM(total_amount), 0) AS v FROM bookings WHERE status = 'CONFIRMED'`).v;
  const refunded = one(`SELECT IFNULL(SUM(amount), 0) AS v FROM payments WHERE status = 'REFUNDED'`).v;
  const seatsSold = one(`
    SELECT COUNT(*) AS v FROM booking_seats bs
      JOIN bookings b ON b.id = bs.booking_id WHERE b.status = 'CONFIRMED'`).v;

  /*
   * Occupancy is measured over TODAY's shows only. Averaging across every future
   * show would divide by weeks of unsold inventory and always read close to zero,
   * which tells an operator nothing.
   */
  const todayShows = db.prepare(`
    SELECT s.id,
           (SELECT COUNT(*) FROM seats st WHERE st.screen_id = s.screen_id AND st.disabled = 0) AS total
      FROM shows s
     WHERE s.status = 'active' AND date(s.start_time) = date('now','localtime')`).all();

  const seatsOfferedToday = todayShows.reduce((sum, s) => sum + s.total, 0);
  const seatsSoldToday = one(`
    SELECT COUNT(*) AS v FROM booking_seats bs
      JOIN bookings b ON b.id = bs.booking_id AND b.status = 'CONFIRMED'
      JOIN shows s    ON s.id = bs.show_id
     WHERE s.status = 'active' AND date(s.start_time) = date('now','localtime')`).v;

  const todayStats = one(`
    SELECT COUNT(*) AS n, IFNULL(SUM(total_amount), 0) AS v
      FROM bookings WHERE status = 'CONFIRMED' AND date(created_at) = date('now','localtime')`);

  /* A continuous 14-day series, so the chart has no gaps on quiet days. */
  const dayMap = new Map(db.prepare(`
    SELECT date(created_at) AS day, COUNT(*) AS bookings, SUM(total_amount) AS revenue
      FROM bookings WHERE status = 'CONFIRMED'
     GROUP BY day`).all().map((r) => [r.day, r]));

  const series = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const hit = dayMap.get(key);
    series.push({ day: key, bookings: hit?.bookings || 0, revenue: hit?.revenue || 0 });
  }

  res.json({
    totals: {
      movies: one('SELECT COUNT(*) AS v FROM movies').v,
      cinemas: one('SELECT COUNT(*) AS v FROM cinemas').v,
      screens: one('SELECT COUNT(*) AS v FROM screens').v,
      shows: one(`SELECT COUNT(*) AS v FROM shows WHERE status = 'active'`).v,
      users: one(`SELECT COUNT(*) AS v FROM users WHERE role = 'user'`).v,
      bookings: one(`SELECT COUNT(*) AS v FROM bookings WHERE status = 'CONFIRMED'`).v,
      bookings_today: todayStats.n,
      revenue_today: todayStats.v,
      revenue, refunded,
      seats_sold: seatsSold,
      occupancy: seatsOfferedToday ? Math.round((seatsSoldToday / seatsOfferedToday) * 100) : 0,
      occupancy_seats: `${seatsSoldToday}/${seatsOfferedToday}`,
      shows_today: todayShows.length,
    },
    series,
    daily: [...dayMap.values()].sort((a, b) => b.day.localeCompare(a.day)).slice(0, 14),
    top_movies: db.prepare(`
      SELECT m.title, COUNT(bs.id) AS seats, IFNULL(SUM(bs.price), 0) AS revenue
        FROM booking_seats bs
        JOIN bookings b ON b.id = bs.booking_id AND b.status = 'CONFIRMED'
        JOIN shows s    ON s.id = b.show_id
        JOIN movies m   ON m.id = s.movie_id
       GROUP BY m.id ORDER BY seats DESC LIMIT 5`).all(),
    upcoming_shows: db.prepare(`
      SELECT s.id, s.start_time, m.title, c.name AS cinema, sc.name AS screen,
             (SELECT COUNT(*) FROM seats st WHERE st.screen_id = s.screen_id AND st.disabled = 0) AS total,
             (SELECT COUNT(*) FROM booking_seats bs
                JOIN bookings b ON b.id = bs.booking_id AND b.status = 'CONFIRMED'
               WHERE bs.show_id = s.id) AS sold
        FROM shows s
        JOIN movies m   ON m.id = s.movie_id
        JOIN screens sc ON sc.id = s.screen_id
        JOIN cinemas c  ON c.id = sc.cinema_id
       WHERE s.status = 'active' AND s.start_time >= datetime('now','localtime')
       ORDER BY s.start_time LIMIT 8`).all()
      .map((s) => ({ ...s, fill: s.total ? Math.round((s.sold / s.total) * 100) : 0 })),
    recent_bookings: db.prepare(`
      SELECT b.id, b.booking_ref, b.total_amount, b.seats_snapshot, b.created_at,
             u.name AS user_name, m.title
        FROM bookings b
        JOIN users u  ON u.id = b.user_id
        JOIN shows s  ON s.id = b.show_id
        JOIN movies m ON m.id = s.movie_id
       WHERE b.status = 'CONFIRMED'
       ORDER BY b.created_at DESC LIMIT 8`).all(),
    currency: config.payment.currencySymbol,
  });
});

/* =========================================================
   movies
   ========================================================= */

function movieFields(body) {
  return [
    String(body.title || '').trim(),
    String(body.description || '').trim(),
    String(body.genre || '').trim(),
    String(body.language || '').trim(),
    Number(body.duration_min) || 120,
    String(body.certificate || 'U/A').trim(),
    String(body.director || '').trim(),
    String(body.cast_list || '').trim(),
    String(body.poster_url || '').trim(),
    String(body.banner_url || '').trim(),
    String(body.trailer_url || '').trim(),
    String(body.release_date || '').trim(),
    ['now_showing', 'coming_soon', 'archived'].includes(body.status) ? body.status : 'now_showing',
  ];
}

router.get('/movies', (_req, res) => {
  // A movie is only bookable once it has an upcoming show, so the panel says so.
  res.json({
    movies: db.prepare(`
      SELECT m.*,
             (SELECT COUNT(*) FROM shows s
               WHERE s.movie_id = m.id AND s.status = 'active'
                 AND s.start_time >= datetime('now','localtime')) AS upcoming_shows
        FROM movies m ORDER BY m.id DESC`).all(),
  });
});

router.post('/movies', (req, res) => {
  const f = movieFields(req.body);
  if (!f[0]) return res.status(400).json({ error: 'Title is required' });
  const info = db.prepare(`
    INSERT INTO movies (title, description, genre, language, duration_min, certificate,
                        director, cast_list, poster_url, banner_url, trailer_url, release_date, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...f);
  res.status(201).json({ movie: db.prepare('SELECT * FROM movies WHERE id = ?').get(info.lastInsertRowid) });
});

router.put('/movies/:id', (req, res) => {
  const f = movieFields(req.body);
  if (!f[0]) return res.status(400).json({ error: 'Title is required' });
  const info = db.prepare(`
    UPDATE movies SET title = ?, description = ?, genre = ?, language = ?, duration_min = ?,
                      certificate = ?, director = ?, cast_list = ?, poster_url = ?, banner_url = ?,
                      trailer_url = ?, release_date = ?, status = ?
     WHERE id = ?`).run(...f, req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Movie not found' });
  res.json({ movie: db.prepare('SELECT * FROM movies WHERE id = ?').get(req.params.id) });
});

router.delete('/movies/:id', (req, res) => {
  const sold = db.prepare(`
    SELECT COUNT(DISTINCT b.id) AS v FROM bookings b
      JOIN shows s ON s.id = b.show_id
     WHERE s.movie_id = ? AND b.status = 'CONFIRMED'`).get(req.params.id).v;

  // Deleting would cascade away paying customers' bookings, so it is refused.
  // The response says how many, so the panel can offer archiving instead.
  if (sold > 0) {
    return res.status(409).json({
      error: `This movie has ${sold} confirmed booking${sold > 1 ? 's' : ''}. `
           + 'Archive it instead, or cancel those bookings first.',
      blocked_by: sold,
      can_archive: true,
    });
  }

  const shows = db.prepare('SELECT COUNT(*) AS v FROM shows WHERE movie_id = ?').get(req.params.id).v;
  db.prepare('DELETE FROM movies WHERE id = ?').run(req.params.id);
  res.json({ ok: true, removed_shows: shows });
});

/* =========================================================
   cinemas
   ========================================================= */

router.get('/cinemas', (_req, res) => {
  const cinemas = db.prepare('SELECT * FROM cinemas ORDER BY city, name').all();
  for (const c of cinemas) {
    c.screens = db.prepare(`
      SELECT sc.*,
             (SELECT COUNT(*) FROM seats s WHERE s.screen_id = sc.id) AS seat_count,
             (SELECT COUNT(*) FROM seats s WHERE s.screen_id = sc.id AND s.seat_type = 'SILVER')   AS silver_seats,
             (SELECT COUNT(*) FROM seats s WHERE s.screen_id = sc.id AND s.seat_type = 'GOLD')     AS gold_seats,
             (SELECT COUNT(*) FROM seats s WHERE s.screen_id = sc.id AND s.seat_type = 'RECLINER') AS recliner_seats
        FROM screens sc WHERE sc.cinema_id = ? ORDER BY sc.name`).all(c.id);
    for (const s of c.screens) s.in_use = screenIsInUse(s.id);
  }
  res.json({ cinemas });
});

router.post('/cinemas', (req, res) => {
  const name = String(req.body.name || '').trim();
  const city = String(req.body.city || '').trim();
  if (!name || !city) return res.status(400).json({ error: 'Cinema name and city are required' });
  const info = db.prepare('INSERT INTO cinemas (name, city, address) VALUES (?, ?, ?)')
    .run(name, city, String(req.body.address || '').trim());
  res.status(201).json({ cinema: db.prepare('SELECT * FROM cinemas WHERE id = ?').get(info.lastInsertRowid) });
});

router.put('/cinemas/:id', (req, res) => {
  const name = String(req.body.name || '').trim();
  const city = String(req.body.city || '').trim();
  if (!name || !city) return res.status(400).json({ error: 'Cinema name and city are required' });
  const info = db.prepare('UPDATE cinemas SET name = ?, city = ?, address = ? WHERE id = ?')
    .run(name, city, String(req.body.address || '').trim(), req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Cinema not found' });
  res.json({ cinema: db.prepare('SELECT * FROM cinemas WHERE id = ?').get(req.params.id) });
});

router.delete('/cinemas/:id', (req, res) => {
  db.prepare('DELETE FROM cinemas WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/* =========================================================
   screens (seat grid is generated from the tier layout)
   ========================================================= */

router.post('/screens', (req, res) => {
  const cinemaId = Number(req.body.cinema_id);
  const name = String(req.body.name || '').trim();

  if (!db.prepare('SELECT id FROM cinemas WHERE id = ?').get(cinemaId)) {
    return res.status(400).json({ error: 'Cinema not found' });
  }
  if (!name) return res.status(400).json({ error: 'Screen name is required' });

  const layout = readLayout(req.body);
  if (layout.error) return res.status(400).json({ error: layout.error });

  const screenId = tx(() => {
    const info = db.prepare('INSERT INTO screens (cinema_id, name, row_count, col_count) VALUES (?, ?, ?, ?)')
      .run(cinemaId, name, layout.rows, layout.cols);
    buildSeats(Number(info.lastInsertRowid), layout);
    return Number(info.lastInsertRowid);
  });

  res.status(201).json({ screen: db.prepare('SELECT * FROM screens WHERE id = ?').get(screenId) });
});

router.put('/screens/:id', (req, res) => {
  const screen = db.prepare('SELECT * FROM screens WHERE id = ?').get(req.params.id);
  if (!screen) return res.status(404).json({ error: 'Screen not found' });

  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Screen name is required' });

  const layout = readLayout(req.body);
  if (layout.error) return res.status(400).json({ error: layout.error });

  const layoutChanged = layout.rows !== screen.row_count || layout.cols !== screen.col_count
    || req.body.silver_rows != null || req.body.silver_price != null;

  if (layoutChanged && screenIsInUse(screen.id)) {
    // Renaming is still fine; rebuilding the grid would orphan sold seats.
    db.prepare('UPDATE screens SET name = ? WHERE id = ?').run(name, screen.id);
    return res.status(409).json({
      error: 'This screen has tickets booked, so only the name was updated. Cancel those bookings first to change the seat layout.',
    });
  }

  tx(() => {
    db.prepare('UPDATE screens SET name = ?, row_count = ?, col_count = ? WHERE id = ?')
      .run(name, layout.rows, layout.cols, screen.id);
    buildSeats(screen.id, layout);
  });

  res.json({ screen: db.prepare('SELECT * FROM screens WHERE id = ?').get(screen.id) });
});

router.delete('/screens/:id', (req, res) => {
  db.prepare('DELETE FROM screens WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/* =========================================================
   shows
   ========================================================= */

/** Returns a clashing show on the same screen, or null. `exceptId` skips the show being edited. */
function findClash(screenId, startTime, durationMin, exceptId = 0) {
  return db.prepare(`
    SELECT s.id, s.start_time, m.title
      FROM shows s JOIN movies m ON m.id = s.movie_id
     WHERE s.screen_id = ? AND s.status = 'active' AND s.id != ?
       AND datetime(?) < datetime(s.start_time, '+' || (m.duration_min + 20) || ' minutes')
       AND datetime(s.start_time) < datetime(?, ?)
  `).get(screenId, exceptId, startTime, startTime, `+${durationMin + 20} minutes`);
}

function readShow(body) {
  const startTime = String(body.start_time || '').trim().replace('T', ' ').slice(0, 16);
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(startTime)) {
    return { error: 'Start time must look like 2026-09-10 18:30' };
  }
  const movie = db.prepare('SELECT * FROM movies WHERE id = ?').get(Number(body.movie_id));
  if (!movie) return { error: 'Movie not found' };
  if (!db.prepare('SELECT id FROM screens WHERE id = ?').get(Number(body.screen_id))) {
    return { error: 'Screen not found' };
  }
  return {
    movie,
    screenId: Number(body.screen_id),
    startTime,
    basePrice: Number(body.base_price) || 500,
    status: body.status === 'cancelled' ? 'cancelled' : 'active',
  };
}

router.get('/shows', (_req, res) => {
  releaseExpiredHolds();
  res.json({
    shows: db.prepare(`
      SELECT s.*, m.title, m.duration_min, sc.name AS screen, c.name AS cinema, c.city,
             (SELECT COUNT(*) FROM seats st WHERE st.screen_id = s.screen_id) AS total_seats,
             (SELECT COUNT(*) FROM booking_seats bs WHERE bs.show_id = s.id) AS taken_seats
        FROM shows s
        JOIN movies m   ON m.id = s.movie_id
        JOIN screens sc ON sc.id = s.screen_id
        JOIN cinemas c  ON c.id = sc.cinema_id
       ORDER BY s.start_time DESC`).all(),
  });
});

router.post('/shows', (req, res) => {
  const p = readShow(req.body);
  if (p.error) return res.status(400).json({ error: p.error });

  const clash = findClash(p.screenId, p.startTime, p.movie.duration_min);
  if (clash) return res.status(409).json({ error: `Screen is busy: "${clash.title}" starts at ${clash.start_time}` });

  const info = db.prepare(
    'INSERT INTO shows (movie_id, screen_id, start_time, base_price, status) VALUES (?, ?, ?, ?, ?)'
  ).run(p.movie.id, p.screenId, p.startTime, p.basePrice, p.status);
  res.status(201).json({ show: db.prepare('SELECT * FROM shows WHERE id = ?').get(info.lastInsertRowid) });
});

router.put('/shows/:id', (req, res) => {
  const show = db.prepare('SELECT * FROM shows WHERE id = ?').get(req.params.id);
  if (!show) return res.status(404).json({ error: 'Show not found' });

  const p = readShow(req.body);
  if (p.error) return res.status(400).json({ error: p.error });

  const booked = db.prepare('SELECT COUNT(*) AS v FROM booking_seats WHERE show_id = ?').get(show.id).v;
  if (booked > 0 && p.screenId !== show.screen_id) {
    return res.status(409).json({ error: 'Tickets are already booked, so this show cannot be moved to another screen.' });
  }

  const clash = findClash(p.screenId, p.startTime, p.movie.duration_min, show.id);
  if (clash) return res.status(409).json({ error: `Screen is busy: "${clash.title}" starts at ${clash.start_time}` });

  db.prepare(`
    UPDATE shows SET movie_id = ?, screen_id = ?, start_time = ?, base_price = ?, status = ?
     WHERE id = ?`).run(p.movie.id, p.screenId, p.startTime, p.basePrice, p.status, show.id);

  res.json({ show: db.prepare('SELECT * FROM shows WHERE id = ?').get(show.id) });
});

router.delete('/shows/:id', (req, res) => {
  const sold = db.prepare(`
    SELECT COUNT(*) AS v FROM booking_seats bs
      JOIN bookings b ON b.id = bs.booking_id AND b.status = 'CONFIRMED'
     WHERE bs.show_id = ?`).get(req.params.id).v;
  if (sold > 0) {
    db.prepare(`UPDATE shows SET status = 'cancelled' WHERE id = ?`).run(req.params.id);
    return res.json({ ok: true, note: 'Show had bookings, so it was cancelled instead of deleted.' });
  }
  db.prepare('DELETE FROM shows WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/* =========================================================
   bookings
   ========================================================= */

router.get('/bookings', (req, res) => {
  releaseExpiredHolds();
  const status = String(req.query.status || '').trim();
  const q = `%${String(req.query.search || '').trim()}%`;
  const hasQ = String(req.query.search || '').trim() !== '';
  res.json({
    bookings: db.prepare(`
      SELECT b.id, b.booking_ref, b.status, b.subtotal, b.discount, b.total_amount,
             b.seats_snapshot, b.created_at, u.name AS user_name, u.email,
             m.title, s.start_time, c.name AS cinema, sc.name AS screen,
             (SELECT method FROM payments p WHERE p.booking_id = b.id) AS payment_method
        FROM bookings b
        JOIN users u    ON u.id = b.user_id
        JOIN shows s    ON s.id = b.show_id
        JOIN movies m   ON m.id = s.movie_id
        JOIN screens sc ON sc.id = s.screen_id
        JOIN cinemas c  ON c.id = sc.cinema_id
       WHERE (? = '' OR b.status = ?)
         AND (? = 0 OR b.booking_ref LIKE ? OR u.name LIKE ? OR u.email LIKE ?
                    OR m.title LIKE ? OR c.name LIKE ? OR b.seats_snapshot LIKE ?)
       ORDER BY b.created_at DESC LIMIT 300`)
      .all(status, status, hasQ ? 1 : 0, q, q, q, q, q, q),
  });
});

router.post('/bookings/:id/cancel', (req, res) => {
  const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!b) return res.status(404).json({ error: 'Booking not found' });
  tx(() => {
    db.prepare('DELETE FROM booking_seats WHERE booking_id = ?').run(b.id);
    db.prepare(`UPDATE bookings SET status = 'CANCELLED', expires_at = NULL WHERE id = ?`).run(b.id);
    db.prepare(`UPDATE payments SET status = 'REFUNDED' WHERE booking_id = ?`).run(b.id);
  });
  res.json({ ok: true });
});

/* =========================================================
   users
   ========================================================= */

router.get('/users', (req, res) => {
  const q = `%${String(req.query.search || '').trim()}%`;
  const hasQ = String(req.query.search || '').trim() !== '';
  res.json({
    users: db.prepare(`
      SELECT u.id, u.name, u.email, u.phone, u.role, u.blocked, u.created_at,
             (SELECT COUNT(*) FROM bookings b WHERE b.user_id = u.id AND b.status = 'CONFIRMED') AS bookings,
             (SELECT IFNULL(SUM(b.total_amount), 0) FROM bookings b
               WHERE b.user_id = u.id AND b.status = 'CONFIRMED') AS spent
        FROM users u
       WHERE (? = 0 OR u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)
       ORDER BY u.created_at DESC`).all(hasQ ? 1 : 0, q, q, q),
  });
});

router.post('/users', (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const role = req.body.role === 'admin' ? 'admin' : 'user';

  if (name.length < 3) return res.status(400).json({ error: 'Name must be at least 3 characters' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'This email is already registered' });
  }

  db.prepare('INSERT INTO users (name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, ?)')
    .run(name, email, String(req.body.phone || '').trim(), A.hashPassword(password), role);
  res.status(201).json({ ok: true });
});

router.put('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const name = String(req.body.name || '').trim();
  if (name.length < 3) return res.status(400).json({ error: 'Name must be at least 3 characters' });

  const role = req.body.role === 'admin' ? 'admin' : 'user';
  if (id === req.user.id && role !== 'admin') {
    return res.status(400).json({ error: 'You cannot remove your own admin role' });
  }

  db.prepare('UPDATE users SET name = ?, phone = ?, role = ? WHERE id = ?')
    .run(name, String(req.body.phone || '').trim(), role, id);

  const newPassword = String(req.body.password || '');
  if (newPassword) {
    if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(A.hashPassword(newPassword), id);
  }

  res.json({ ok: true });
});

router.patch('/users/:id/block', (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'You cannot block your own account' });
  const blocked = req.body.blocked ? 1 : 0;
  const info = db.prepare('UPDATE users SET blocked = ? WHERE id = ?').run(blocked, id);
  if (!info.changes) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true, blocked });
});

router.delete('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
  const booked = db.prepare(`SELECT COUNT(*) AS v FROM bookings WHERE user_id = ? AND status = 'CONFIRMED'`).get(id).v;
  if (booked > 0) {
    return res.status(409).json({ error: 'This user has confirmed bookings. Block the account instead of deleting it.' });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

/** One user's full booking history, for the admin's user drill-down. */
router.get('/users/:id/bookings', (req, res) => {
  const user = db.prepare('SELECT id, name, email, phone, role FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const bookings = db.prepare(`
    SELECT b.id, b.booking_ref, b.status, b.total_amount, b.seats_snapshot, b.created_at,
           s.start_time, m.title, c.name AS cinema, sc.name AS screen
      FROM bookings b
      JOIN shows s    ON s.id = b.show_id
      JOIN movies m   ON m.id = s.movie_id
      JOIN screens sc ON sc.id = s.screen_id
      JOIN cinemas c  ON c.id = sc.cinema_id
     WHERE b.user_id = ?
     ORDER BY b.created_at DESC`).all(req.params.id);

  res.json({ user, bookings });
});

/* =========================================================
   seat availability
   ========================================================= */

/** Full seat grid for one screen, so an admin can take seats out of service. */
router.get('/screens/:id/seats', (req, res) => {
  const screen = db.prepare('SELECT * FROM screens WHERE id = ?').get(req.params.id);
  if (!screen) return res.status(404).json({ error: 'Screen not found' });

  const seats = db.prepare(
    'SELECT * FROM seats WHERE screen_id = ? ORDER BY row_label, seat_no'
  ).all(screen.id);

  const rows = [];
  for (const s of seats) {
    let row = rows.find((r) => r.row_label === s.row_label);
    if (!row) { row = { row_label: s.row_label, seats: [] }; rows.push(row); }
    row.seats.push({ ...s, label: `${s.row_label}${s.seat_no}`, disabled: Boolean(s.disabled) });
  }

  res.json({ screen, rows, total: seats.length, disabled: seats.filter((s) => s.disabled).length });
});

router.patch('/seats/disable', (req, res) => {
  const seatIds = Array.isArray(req.body.seat_ids) ? req.body.seat_ids.map(Number).filter(Number.isFinite) : [];
  if (!seatIds.length) return res.status(400).json({ error: 'Select at least one seat' });

  const disabled = req.body.disabled ? 1 : 0;
  const upd = db.prepare('UPDATE seats SET disabled = ? WHERE id = ?');
  tx(() => { for (const id of seatIds) upd.run(disabled, id); });

  res.json({ ok: true, updated: seatIds.length, disabled: Boolean(disabled) });
});

/* =========================================================
   promos
   ========================================================= */

function readPromo(body) {
  const code = String(body.code || '').trim().toUpperCase();
  const type = body.discount_type === 'flat' ? 'flat' : 'percent';
  const value = Number(body.discount_value);
  if (!code) return { error: 'Promo code is required' };
  if (!(value > 0)) return { error: 'Discount value must be greater than 0' };
  if (type === 'percent' && value > 100) return { error: 'A percentage discount cannot be over 100' };
  return {
    code, type, value,
    max: body.max_discount ? Number(body.max_discount) : null,
    min: Number(body.min_amount) || 0,
    expires: String(body.expires_at || '').trim() || null,
    active: body.active === undefined ? 1 : (body.active ? 1 : 0),
  };
}

router.get('/promos', (_req, res) => {
  res.json({ promos: db.prepare('SELECT * FROM promos ORDER BY id DESC').all() });
});

router.post('/promos', (req, res) => {
  const p = readPromo(req.body);
  if (p.error) return res.status(400).json({ error: p.error });
  if (db.prepare('SELECT id FROM promos WHERE code = ?').get(p.code)) {
    return res.status(409).json({ error: 'This promo code already exists' });
  }
  db.prepare(`
    INSERT INTO promos (code, discount_type, discount_value, max_discount, min_amount, expires_at, active)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(p.code, p.type, p.value, p.max, p.min, p.expires, p.active);
  res.status(201).json({ ok: true });
});

router.put('/promos/:id', (req, res) => {
  const p = readPromo(req.body);
  if (p.error) return res.status(400).json({ error: p.error });
  const clash = db.prepare('SELECT id FROM promos WHERE code = ? AND id != ?').get(p.code, req.params.id);
  if (clash) return res.status(409).json({ error: 'Another promo already uses this code' });

  const info = db.prepare(`
    UPDATE promos SET code = ?, discount_type = ?, discount_value = ?, max_discount = ?,
                      min_amount = ?, expires_at = ?, active = ?
     WHERE id = ?`).run(p.code, p.type, p.value, p.max, p.min, p.expires, p.active, req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Promo not found' });
  res.json({ ok: true });
});

router.patch('/promos/:id', (req, res) => {
  db.prepare('UPDATE promos SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

router.delete('/promos/:id', (req, res) => {
  db.prepare('DELETE FROM promos WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;

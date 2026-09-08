'use strict';
const express = require('express');
const crypto = require('node:crypto');
const { db, tx, releaseExpiredHolds } = require('../../db');
const A = require('../../auth');
const config = require('../../config');
const payments = require('../../payments');

const router = express.Router();

const HOLD_MINUTES = config.booking.holdMinutes;
const MAX_SEATS = config.booking.maxSeats;

const newRef = () => 'MBS' + crypto.randomBytes(4).toString('hex').toUpperCase();
const toDate = (sqlTime) => new Date(String(sqlTime).replace(' ', 'T'));
const started = (sqlTime) => toDate(sqlTime) < new Date();

/** Returns { discount } or { error }. */
function applyPromo(code, subtotal) {
  if (!code) return { discount: 0 };

  const p = db.prepare(`
    SELECT * FROM promos WHERE code = ? AND active = 1
       AND (expires_at IS NULL OR expires_at >= date('now','localtime'))
  `).get(code);
  if (!p) return { error: 'Promo code is invalid or expired' };
  if (subtotal < p.min_amount) {
    return { error: `This promo needs a minimum booking of ${config.payment.currencySymbol} ${p.min_amount}` };
  }

  let discount = p.discount_type === 'percent' ? (subtotal * p.discount_value) / 100 : p.discount_value;
  if (p.max_discount != null) discount = Math.min(discount, p.max_discount);
  return { discount: Math.min(Math.round(discount), subtotal) };
}

/** Booking plus the movie / cinema details the summary and ticket need. */
function loadBooking(id, userId) {
  const b = db.prepare(`
    SELECT b.*, s.start_time, s.base_price, s.movie_id,
           m.title, m.poster_url, m.duration_min, m.certificate, m.language,
           sc.name AS screen, c.name AS cinema, c.city, c.address
      FROM bookings b
      JOIN shows s    ON s.id = b.show_id
      JOIN movies m   ON m.id = s.movie_id
      JOIN screens sc ON sc.id = s.screen_id
      JOIN cinemas c  ON c.id = sc.cinema_id
     WHERE b.id = ?
  `).get(id);
  if (!b) return null;
  if (userId != null && b.user_id !== userId) return null;

  b.seats = db.prepare(`
    SELECT st.row_label || st.seat_no AS label, st.seat_type, bs.price, bs.seat_id
      FROM booking_seats bs JOIN seats st ON st.id = bs.seat_id
     WHERE bs.booking_id = ? ORDER BY st.row_label, st.seat_no
  `).all(b.id);

  b.payment = db.prepare(
    'SELECT method, amount, status, provider, message, txn_ref, created_at FROM payments WHERE booking_id = ?'
  ).get(b.id) || null;
  b.currency = config.payment.currencySymbol;
  return b;
}

/* ---------------- STEP 1: hold the seats ---------------- */

router.post('/hold', A.requireAuth, (req, res) => {
  releaseExpiredHolds();

  const showId = Number(req.body.show_id);
  const seatIds = Array.isArray(req.body.seat_ids) ? req.body.seat_ids.map(Number) : [];

  if (!showId || seatIds.length === 0) return res.status(400).json({ error: 'Select at least one seat' });
  if (seatIds.some((id) => !Number.isFinite(id))) return res.status(400).json({ error: 'Invalid seat selection' });
  if (new Set(seatIds).size !== seatIds.length) return res.status(400).json({ error: 'Duplicate seats selected' });
  if (seatIds.length > MAX_SEATS) {
    return res.status(400).json({ error: `You can book at most ${MAX_SEATS} seats at a time` });
  }

  const show = db.prepare(`SELECT * FROM shows WHERE id = ? AND status = 'active'`).get(showId);
  if (!show) return res.status(404).json({ error: 'Show not found' });
  if (started(show.start_time)) return res.status(400).json({ error: 'This show has already started' });

  const placeholders = seatIds.map(() => '?').join(',');
  const seats = db.prepare(
    `SELECT * FROM seats WHERE id IN (${placeholders}) AND screen_id = ?`
  ).all(...seatIds, show.screen_id);

  if (seats.length !== seatIds.length) {
    return res.status(400).json({ error: 'One or more seats do not belong to this screen' });
  }
  if (seats.some((s) => s.disabled)) {
    return res.status(400).json({ error: 'One or more of those seats is out of service' });
  }

  const priced = seats.map((s) => ({ ...s, price: Math.round(show.base_price * s.price_multiplier) }));
  const money = payments.priceBooking(priced.map((s) => s.price));
  const label = priced.map((s) => `${s.row_label}${s.seat_no}`).join(', ');

  try {
    const bookingId = tx(() => {
      const info = db.prepare(`
        INSERT INTO bookings (booking_ref, user_id, show_id, subtotal, discount, booking_fee,
                              service_fee, total_amount, seats_snapshot, status, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', datetime('now','localtime',?))
      `).run(newRef(), req.user.id, show.id, money.subtotal, money.discount, money.booking_fee,
             money.service_fee, money.total_amount, label, `+${HOLD_MINUTES} minutes`);

      const ins = db.prepare('INSERT INTO booking_seats (booking_id, show_id, seat_id, price) VALUES (?, ?, ?, ?)');
      for (const s of priced) ins.run(info.lastInsertRowid, show.id, s.id, s.price);
      return Number(info.lastInsertRowid);
    });

    const booking = loadBooking(bookingId, req.user.id);
    res.status(201).json({ booking, hold_minutes: HOLD_MINUTES, expires_at: booking.expires_at });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'Sorry, one of those seats was just taken. Please pick again.' });
    }
    throw err;
  }
});

/* ---------------- promo preview ---------------- */

router.post('/promo/check', A.requireAuth, (req, res) => {
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ? AND user_id = ?')
    .get(Number(req.body.booking_id), req.user.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  const result = applyPromo(String(req.body.code || '').trim(), booking.subtotal);
  if (result.error) return res.status(400).json({ error: result.error });

  // Priced from the stored seats, never from an amount the browser sent.
  const seatPrices = db.prepare('SELECT price FROM booking_seats WHERE booking_id = ?')
    .all(booking.id).map((r) => r.price);
  res.json(payments.priceBooking(seatPrices, result.discount));
});

/* ---------------- STEP 2: pay & confirm ---------------- */

router.post('/:id/confirm', A.requireAuth, async (req, res) => {
  releaseExpiredHolds();

  const booking = db.prepare('SELECT * FROM bookings WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.status === 'CONFIRMED') return res.status(400).json({ error: 'This booking is already confirmed' });
  if (booking.status !== 'PENDING') {
    return res.status(410).json({ error: 'Your seat hold expired. Please select seats again.' });
  }

  const method = String(req.body.method || 'card');
  if (!payments.isValidMethod(method)) return res.status(400).json({ error: 'Invalid payment method' });

  const code = String(req.body.promo_code || '').trim();
  const { discount = 0, error } = applyPromo(code, booking.subtotal);
  if (error) return res.status(400).json({ error });

  const seatPrices = db.prepare('SELECT price FROM booking_seats WHERE booking_id = ?')
    .all(booking.id).map((r) => r.price);
  const money = payments.priceBooking(seatPrices, discount);

  const result = await payments.charge({
    amount: money.total_amount, method, bookingRef: booking.booking_ref, userId: req.user.id,
  });

  db.prepare(`
    INSERT INTO payments (booking_id, method, amount, status, provider, message, txn_ref)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(booking.id, method, money.total_amount, result.status, result.provider,
         result.message, result.txn_ref || payments.newTxnRef());

  if (result.status === 'FAILED') {
    // The hold stays alive so the customer can try a different method.
    return res.status(402).json({
      error: result.message,
      payment_status: 'FAILED',
      booking: loadBooking(booking.id, req.user.id),
    });
  }

  db.prepare(`
    UPDATE bookings
       SET status = 'CONFIRMED', subtotal = ?, discount = ?, booking_fee = ?, service_fee = ?,
           total_amount = ?, promo_code = ?, expires_at = NULL
     WHERE id = ?
  `).run(money.subtotal, money.discount, money.booking_fee, money.service_fee,
         money.total_amount, code || null, booking.id);

  res.json({
    booking: loadBooking(booking.id, req.user.id),
    payment_status: result.status,
    message: result.message,
  });
});

/* ---------------- cancel ---------------- */

router.post('/:id/cancel', A.requireAuth, (req, res) => {
  const b = db.prepare(`
    SELECT b.*, s.start_time FROM bookings b JOIN shows s ON s.id = b.show_id
     WHERE b.id = ? AND b.user_id = ?
  `).get(req.params.id, req.user.id);

  if (!b) return res.status(404).json({ error: 'Booking not found' });
  if (b.status === 'CANCELLED') return res.status(400).json({ error: 'Already cancelled' });
  if (b.status === 'EXPIRED') return res.status(400).json({ error: 'This booking already expired' });

  const minutesLeft = (toDate(b.start_time) - Date.now()) / 60000;
  if (minutesLeft < config.booking.cancelCutoffMinutes) {
    return res.status(400).json({
      error: `Bookings can only be cancelled more than ${config.booking.cancelCutoffMinutes} minutes before the show starts.`,
    });
  }

  tx(() => {
    db.prepare('DELETE FROM booking_seats WHERE booking_id = ?').run(b.id);
    db.prepare(`UPDATE bookings SET status = 'CANCELLED', expires_at = NULL WHERE id = ?`).run(b.id);
    db.prepare(`UPDATE payments SET status = 'REFUNDED' WHERE booking_id = ?`).run(b.id);
  });

  res.json({ ok: true, refunded: b.status === 'CONFIRMED' ? b.total_amount : 0 });
});

/* ---------------- my bookings ---------------- */

router.get('/mine', A.requireAuth, (req, res) => {
  releaseExpiredHolds();

  const rows = db.prepare(`
    SELECT b.id, b.booking_ref, b.status, b.total_amount, b.seats_snapshot, b.created_at,
           s.start_time, m.title, m.poster_url, c.name AS cinema, c.city, sc.name AS screen,
           (SELECT status FROM payments p WHERE p.booking_id = b.id) AS payment_status,
           (SELECT COUNT(*) FROM booking_seats bs WHERE bs.booking_id = b.id) AS seat_count
      FROM bookings b
      JOIN shows s    ON s.id = b.show_id
      JOIN movies m   ON m.id = s.movie_id
      JOIN screens sc ON sc.id = s.screen_id
      JOIN cinemas c  ON c.id = sc.cinema_id
     WHERE b.user_id = ? AND b.status != 'EXPIRED'
     ORDER BY b.created_at DESC
  `).all(req.user.id);

  const cutoff = config.booking.cancelCutoffMinutes;
  const isUpcoming = (r) => toDate(r.start_time) >= new Date();

  res.json({
    upcoming: rows.filter(isUpcoming).map((r) => ({
      ...r,
      cancellable: r.status !== 'CANCELLED' && (toDate(r.start_time) - Date.now()) / 60000 >= cutoff,
    })),
    past: rows.filter((r) => !isUpcoming(r)),
    cancel_cutoff_minutes: cutoff,
  });
});

router.get('/:id', A.requireAuth, (req, res) => {
  const b = loadBooking(req.params.id, req.user.id);
  if (!b) return res.status(404).json({ error: 'Booking not found' });
  res.json({ booking: b });
});

module.exports = router;

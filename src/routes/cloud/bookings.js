'use strict';
const express = require('express');
const crypto = require('node:crypto');
const S = require('../../store');
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
async function applyPromo(code, subtotal) {
  if (!code) return { discount: 0 };

  const p = await S.getPromo(code);
  if (!p || !p.active) return { error: 'Promo code is invalid or expired' };
  if (p.expires_at && p.expires_at < S.now().slice(0, 10)) {
    return { error: 'Promo code is invalid or expired' };
  }
  if (subtotal < (p.min_amount || 0)) {
    return { error: `This promo needs a minimum booking of ${config.payment.currencySymbol} ${p.min_amount}` };
  }

  let discount = p.discount_type === 'percent' ? (subtotal * p.discount_value) / 100 : p.discount_value;
  if (p.max_discount != null) discount = Math.min(discount, p.max_discount);
  return { discount: Math.min(Math.round(discount), subtotal) };
}

/** Booking plus the movie / cinema details the summary and ticket need. */
async function fullBooking(booking) {
  const show = await S.getShow(booking.show_id);
  if (!show) return booking;
  const [movie, screen] = await Promise.all([S.getMovie(show.movie_id), S.getScreen(show.screen_id)]);
  const cinema = screen && (await S.getCinema(screen.cinema_id));
  return {
    ...booking,
    start_time: show.start_time,
    base_price: show.base_price,
    title: movie?.title,
    poster_url: movie?.poster_url,
    duration_min: movie?.duration_min,
    certificate: movie?.certificate,
    language: movie?.language,
    screen: screen?.name,
    cinema: cinema?.name,
    city: cinema?.city,
    address: cinema?.address,
    payment: await S.paymentForBooking(booking.id),
    currency: config.payment.currencySymbol,
  };
}

/* ---------------- STEP 1: hold the seats ---------------- */

router.post('/hold', A.requireAuth, async (req, res) => {
  await S.releaseExpiredHolds();

  const showId = Number(req.body.show_id);
  const seatIds = Array.isArray(req.body.seat_ids) ? req.body.seat_ids.map(Number) : [];

  if (!showId || seatIds.length === 0) return res.status(400).json({ error: 'Select at least one seat' });
  if (seatIds.some((id) => !Number.isFinite(id))) return res.status(400).json({ error: 'Invalid seat selection' });
  if (new Set(seatIds).size !== seatIds.length) return res.status(400).json({ error: 'Duplicate seats selected' });
  if (seatIds.length > MAX_SEATS) {
    return res.status(400).json({ error: `You can book at most ${MAX_SEATS} seats at a time` });
  }

  const show = await S.getShow(showId);
  if (!show || show.status !== 'active') return res.status(404).json({ error: 'Show not found' });
  if (started(show.start_time)) return res.status(400).json({ error: 'This show has already started' });

  // Seats must belong to this show's screen, and must not be out of service.
  const screenSeats = await S.listSeats(show.screen_id);
  const seats = seatIds.map((id) => screenSeats.find((s) => Number(s.id) === id)).filter(Boolean);
  if (seats.length !== seatIds.length) {
    return res.status(400).json({ error: 'One or more seats do not belong to this screen' });
  }
  if (seats.some((s) => s.disabled)) {
    return res.status(400).json({ error: 'One or more of those seats is out of service' });
  }

  try {
    const booking = await S.holdSeats({
      userId: req.user.id, show, seats, holdMinutes: HOLD_MINUTES, bookingRef: newRef(),
    });
    res.status(201).json({
      booking: await fullBooking(booking),
      hold_minutes: HOLD_MINUTES,
      expires_at: booking.expires_at,
    });
  } catch (err) {
    if (err.code === 'SEAT_TAKEN') {
      return res.status(409).json({ error: 'Sorry, one of those seats was just taken. Please pick again.' });
    }
    throw err;
  }
});

/* ---------------- promo preview ---------------- */

router.post('/promo/check', A.requireAuth, async (req, res) => {
  const bookingId = Number(req.body.booking_id);
  const booking = bookingId ? await S.getBooking(bookingId) : null;
  if (!booking || Number(booking.user_id) !== Number(req.user.id)) {
    return res.status(404).json({ error: 'Booking not found' });
  }

  // Priced from the stored seats, never from an amount the browser sent.
  const result = await applyPromo(String(req.body.code || '').trim(), booking.subtotal);
  if (result.error) return res.status(400).json({ error: result.error });

  res.json({ ...payments.priceBooking((booking.seats || []).map((s) => s.price), result.discount) });
});

/* ---------------- STEP 2: pay & confirm ---------------- */

router.post('/:id/confirm', A.requireAuth, async (req, res) => {
  await S.releaseExpiredHolds();

  const booking = await S.getBooking(req.params.id);
  if (!booking || Number(booking.user_id) !== Number(req.user.id)) {
    return res.status(404).json({ error: 'Booking not found' });
  }
  if (booking.status === 'CONFIRMED') return res.status(400).json({ error: 'This booking is already confirmed' });
  if (booking.status !== 'PENDING') {
    return res.status(410).json({ error: 'Your seat hold expired. Please select seats again.' });
  }

  const method = String(req.body.method || 'card');
  if (!payments.isValidMethod(method)) return res.status(400).json({ error: 'Invalid payment method' });

  const code = String(req.body.promo_code || '').trim();
  const { discount = 0, error } = await applyPromo(code, booking.subtotal);
  if (error) return res.status(400).json({ error });

  // Server-side pricing. Anything the browser sent about money is ignored.
  const money = payments.priceBooking((booking.seats || []).map((s) => s.price), discount);

  const result = await payments.charge({
    amount: money.total_amount, method, bookingRef: booking.booking_ref, userId: req.user.id,
  });

  await S.createPayment({
    booking_id: Number(booking.id), method, amount: money.total_amount,
    status: result.status, provider: result.provider, message: result.message,
    txn_ref: result.txn_ref || payments.newTxnRef(), created_at: S.now(),
  });

  if (result.status === 'FAILED') {
    // The hold stays alive so the customer can try a different method.
    return res.status(402).json({
      error: result.message,
      payment_status: 'FAILED',
      booking: await fullBooking(await S.getBooking(booking.id)),
    });
  }

  await S.updateBooking(booking.id, {
    ...money,
    status: 'CONFIRMED',
    promo_code: code || null,
    payment_status: result.status,     // PAID, or PENDING for pay-at-counter
    expires_at: null,
  });

  res.json({
    booking: await fullBooking(await S.getBooking(booking.id)),
    payment_status: result.status,
    message: result.message,
  });
});

/* ---------------- cancel ---------------- */

router.post('/:id/cancel', A.requireAuth, async (req, res) => {
  const booking = await S.getBooking(req.params.id);
  if (!booking || Number(booking.user_id) !== Number(req.user.id)) {
    return res.status(404).json({ error: 'Booking not found' });
  }
  if (booking.status === 'CANCELLED') return res.status(400).json({ error: 'Already cancelled' });
  if (booking.status === 'EXPIRED') return res.status(400).json({ error: 'This booking already expired' });

  const show = await S.getShow(booking.show_id);
  if (show) {
    const minutesLeft = (toDate(show.start_time) - Date.now()) / 60000;
    if (minutesLeft < config.booking.cancelCutoffMinutes) {
      return res.status(400).json({
        error: `Bookings can only be cancelled more than ${config.booking.cancelCutoffMinutes} minutes before the show starts.`,
      });
    }
  }

  await S.releaseBooking(booking.id, booking.show_id, { status: 'CANCELLED', expires_at: null });
  await S.refundPayments(booking.id);

  res.json({ ok: true, refunded: booking.status === 'CONFIRMED' ? booking.total_amount : 0 });
});

/* ---------------- my bookings ---------------- */

router.get('/mine', A.requireAuth, async (req, res) => {
  await S.releaseExpiredHolds();

  const bookings = (await S.bookingsForUser(req.user.id)).filter((b) => b.status !== 'EXPIRED');
  const rows = [];
  for (const b of bookings) {
    const full = await fullBooking(b);
    // A booking whose show was deleted has nothing to display; skip it rather
    // than rendering "Invalid Date" on the customer's page.
    if (!full.start_time) continue;
    rows.push({
      id: full.id, booking_ref: full.booking_ref, status: full.status,
      total_amount: full.total_amount, seats_snapshot: full.seats_snapshot,
      created_at: full.created_at, start_time: full.start_time,
      title: full.title, poster_url: full.poster_url,
      cinema: full.cinema, city: full.city, screen: full.screen,
      payment_status: full.payment?.status || null,
      seat_count: full.seats?.length || 0,
    });
  }
  rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

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

router.get('/:id', A.requireAuth, async (req, res) => {
  const booking = await S.getBooking(req.params.id);
  if (!booking || Number(booking.user_id) !== Number(req.user.id)) {
    return res.status(404).json({ error: 'Booking not found' });
  }

  const full = await fullBooking(booking);
  if (!full.start_time) {
    return res.status(410).json({ error: 'This show was removed, so the ticket is no longer available.' });
  }
  res.json({ booking: full });
});

module.exports = router;

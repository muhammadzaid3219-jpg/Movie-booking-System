'use strict';
const express = require('express');
const { db, releaseExpiredHolds } = require('../../db');
const A = require('../../auth');
const config = require('../../config');
const payments = require('../../payments');

const router = express.Router();

const SORTS = {
  title: 'm.title ASC',
  rating: 'avg_rating DESC NULLS LAST, m.title ASC',
  newest: 'm.release_date DESC',
  oldest: 'm.release_date ASC',
  duration: 'm.duration_min DESC',
};

/** Movie list with ratings joined in, filtered and sorted entirely in SQL. */
function queryMovies({ search = '', genre = '', language = '', status = '', sort = '' } = {}) {
  const like = `%${search.trim()}%`;
  const order = SORTS[sort]
    || `CASE m.status WHEN 'now_showing' THEN 0 ELSE 1 END, m.release_date DESC`;

  return db.prepare(`
    SELECT m.*,
           ROUND(AVG(r.rating), 1) AS avg_rating,
           COUNT(r.id)             AS review_count
      FROM movies m
      LEFT JOIN reviews r ON r.movie_id = m.id
     WHERE m.status != 'archived'
       AND (? = '' OR m.title LIKE ? OR m.genre LIKE ?)
       AND (? = '' OR m.genre LIKE '%' || ? || '%')
       AND (? = '' OR m.language = ?)
       AND (? = '' OR m.status = ?)
     GROUP BY m.id
     ORDER BY ${order}
  `).all(search.trim(), like, like, genre, genre, language, language, status, status);
}

/* ---------------- movies ---------------- */

router.get('/movies', (req, res) => {
  res.json({
    movies: queryMovies({
      search: String(req.query.search || ''),
      genre: String(req.query.genre || ''),
      language: String(req.query.language || ''),
      status: String(req.query.status || ''),
      sort: String(req.query.sort || ''),
    }),
  });
});

/** Home-page rows: now showing, coming soon and most-reviewed. */
router.get('/home', (_req, res) => {
  const all = queryMovies({});
  const popular = all
    .filter((m) => m.status === 'now_showing')
    .sort((a, b) => (b.review_count || 0) - (a.review_count || 0) || (b.avg_rating || 0) - (a.avg_rating || 0))
    .slice(0, 6);

  res.json({
    now_showing: all.filter((m) => m.status === 'now_showing').slice(0, 12),
    coming_soon: all.filter((m) => m.status === 'coming_soon').slice(0, 8),
    popular,
    featured: popular[0] || all[0] || null,
  });
});

router.get('/movies/:id', (req, res) => {
  const movie = db.prepare(`
    SELECT m.*, ROUND(AVG(r.rating), 1) AS avg_rating, COUNT(r.id) AS review_count
      FROM movies m LEFT JOIN reviews r ON r.movie_id = m.id
     WHERE m.id = ? GROUP BY m.id
  `).get(req.params.id);
  if (!movie) return res.status(404).json({ error: 'Movie not found' });
  res.json({ movie });
});

router.get('/movies/:id/shows', (req, res) => {
  releaseExpiredHolds();
  const date = String(req.query.date || '').trim();
  const city = String(req.query.city || '').trim();

  const rows = db.prepare(`
    SELECT s.id, s.start_time, s.base_price,
           c.name AS cinema, c.city, sc.name AS screen,
           (SELECT COUNT(*) FROM seats st WHERE st.screen_id = sc.id AND st.disabled = 0) AS total_seats,
           (SELECT COUNT(*) FROM booking_seats bs WHERE bs.show_id = s.id) AS taken_seats
      FROM shows s
      JOIN screens sc ON sc.id = s.screen_id
      JOIN cinemas c  ON c.id = sc.cinema_id
     WHERE s.movie_id = ? AND s.status = 'active'
       AND s.start_time >= datetime('now','localtime')
       AND (? = '' OR date(s.start_time) = ?)
       AND (? = '' OR c.city = ?)
     ORDER BY s.start_time
  `).all(req.params.id, date, date, city, city);

  const byCinema = new Map();
  for (const r of rows) {
    const key = `${r.cinema}|${r.city}`;
    if (!byCinema.has(key)) byCinema.set(key, { cinema: r.cinema, city: r.city, shows: [] });
    byCinema.get(key).shows.push({
      id: r.id, start_time: r.start_time, base_price: r.base_price, screen: r.screen,
      seats_left: r.total_seats - r.taken_seats, total_seats: r.total_seats,
    });
  }
  res.json({ cinemas: [...byCinema.values()] });
});

/* ---------------- show + seat map ---------------- */

router.get('/shows/:id', (req, res) => {
  releaseExpiredHolds();

  const show = db.prepare(`
    SELECT s.*, m.title, m.duration_min, m.certificate, m.language, m.poster_url,
           sc.name AS screen, sc.row_count, sc.col_count,
           c.name AS cinema, c.city, c.address
      FROM shows s
      JOIN movies  m  ON m.id = s.movie_id
      JOIN screens sc ON sc.id = s.screen_id
      JOIN cinemas c  ON c.id = sc.cinema_id
     WHERE s.id = ?
  `).get(req.params.id);
  if (!show) return res.status(404).json({ error: 'Show not found' });

  const taken = new Set(
    db.prepare('SELECT seat_id FROM booking_seats WHERE show_id = ?').all(show.id).map((r) => r.seat_id)
  );

  const seats = db.prepare(`
    SELECT id, row_label, seat_no, seat_type, price_multiplier, disabled
      FROM seats WHERE screen_id = ? ORDER BY row_label, seat_no
  `).all(show.screen_id).map((s) => ({
    ...s,
    label: `${s.row_label}${s.seat_no}`,
    price: Math.round(show.base_price * s.price_multiplier),
    booked: taken.has(s.id),
    disabled: Boolean(s.disabled),
  }));

  const rows = [];
  for (const s of seats) {
    let row = rows.find((r) => r.row_label === s.row_label);
    if (!row) { row = { row_label: s.row_label, seats: [] }; rows.push(row); }
    row.seats.push(s);
  }

  res.json({
    show,
    rows,
    seats_left: seats.filter((s) => !s.booked && !s.disabled).length,
    pricing: {
      currency: config.payment.currencySymbol,
      booking_fee_per_seat: config.booking.bookingFeePerSeat,
      service_fee_percent: config.booking.serviceFeePercent,
      hold_minutes: config.booking.holdMinutes,
      max_seats: config.booking.maxSeats,
    },
  });
});

/* ---------------- cinemas ---------------- */

router.get('/cinemas', (req, res) => {
  releaseExpiredHolds();
  const city = String(req.query.city || '').trim();

  const cinemas = db.prepare(`
    SELECT * FROM cinemas WHERE (? = '' OR city = ?) ORDER BY city, name
  `).all(city, city);

  for (const c of cinemas) {
    c.screens = db.prepare(`
      SELECT sc.id, sc.name,
             (SELECT COUNT(*) FROM seats s WHERE s.screen_id = sc.id AND s.disabled = 0) AS seat_count
        FROM screens sc WHERE sc.cinema_id = ? ORDER BY sc.name
    `).all(c.id);

    c.screen_count = c.screens.length;
    c.total_seats = c.screens.reduce((sum, s) => sum + s.seat_count, 0);
    c.upcoming_shows = db.prepare(`
      SELECT COUNT(*) AS v FROM shows s JOIN screens sc ON sc.id = s.screen_id
       WHERE sc.cinema_id = ? AND s.status = 'active' AND s.start_time >= datetime('now','localtime')
    `).get(c.id).v;
    c.now_showing = db.prepare(`
      SELECT DISTINCT m.title FROM shows s
        JOIN screens sc ON sc.id = s.screen_id
        JOIN movies m   ON m.id = s.movie_id
       WHERE sc.cinema_id = ? AND s.status = 'active' AND s.start_time >= datetime('now','localtime')
       LIMIT 6
    `).all(c.id).map((r) => r.title);
  }

  res.json({ cinemas });
});

/** Every upcoming show at one cinema, grouped by movie. */
router.get('/cinemas/:id/shows', (req, res) => {
  releaseExpiredHolds();

  const cinema = db.prepare('SELECT * FROM cinemas WHERE id = ?').get(req.params.id);
  if (!cinema) return res.status(404).json({ error: 'Cinema not found' });

  const date = String(req.query.date || '').trim();
  const rows = db.prepare(`
    SELECT s.id, s.start_time, s.base_price, sc.name AS screen,
           m.id AS movie_id, m.title, m.poster_url, m.genre, m.language,
           m.certificate, m.duration_min,
           (SELECT COUNT(*) FROM seats st WHERE st.screen_id = sc.id AND st.disabled = 0) AS total_seats,
           (SELECT COUNT(*) FROM booking_seats bs WHERE bs.show_id = s.id) AS taken_seats
      FROM shows s
      JOIN screens sc ON sc.id = s.screen_id
      JOIN movies m   ON m.id = s.movie_id
     WHERE sc.cinema_id = ? AND s.status = 'active'
       AND s.start_time >= datetime('now','localtime')
       AND (? = '' OR date(s.start_time) = ?)
     ORDER BY m.title, s.start_time
  `).all(cinema.id, date, date);

  const byMovie = new Map();
  for (const r of rows) {
    if (!byMovie.has(r.movie_id)) {
      byMovie.set(r.movie_id, {
        movie_id: r.movie_id, title: r.title, poster_url: r.poster_url,
        genre: r.genre, language: r.language, certificate: r.certificate,
        duration_min: r.duration_min, shows: [],
      });
    }
    byMovie.get(r.movie_id).shows.push({
      id: r.id, start_time: r.start_time, base_price: r.base_price, screen: r.screen,
      total_seats: r.total_seats, seats_left: r.total_seats - r.taken_seats,
    });
  }

  res.json({ cinema, movies: [...byMovie.values()] });
});

/* ---------------- filters and settings ---------------- */

router.get('/cities', (_req, res) => {
  res.json({ cities: db.prepare('SELECT DISTINCT city FROM cinemas ORDER BY city').all().map((r) => r.city) });
});

router.get('/genres', (_req, res) => {
  const set = new Set();
  // Archived movies are hidden from the site, so their genres must not appear
  // either - a chip that leads to an empty list is a dead end.
  for (const r of db.prepare(`
    SELECT genre FROM movies
     WHERE status != 'archived' AND genre IS NOT NULL AND genre != ''`).all()) {
    for (const g of r.genre.split(',')) if (g.trim()) set.add(g.trim());
  }
  res.json({ genres: [...set].sort() });
});

/** Payment methods and money settings, so the front end never hardcodes them. */
router.get('/payment-methods', (_req, res) => {
  res.json({
    methods: payments.METHODS,
    currency: config.payment.currencySymbol,
    booking_fee_per_seat: config.booking.bookingFeePerSeat,
    service_fee_percent: config.booking.serviceFeePercent,
  });
});

/* ---------------- reviews ---------------- */

router.get('/movies/:id/reviews', (req, res) => {
  res.json({
    reviews: db.prepare(`
      SELECT r.id, r.rating, r.comment, r.created_at, u.name AS user_name
        FROM reviews r JOIN users u ON u.id = r.user_id
       WHERE r.movie_id = ? ORDER BY r.created_at DESC
    `).all(req.params.id),
  });
});

router.post('/movies/:id/reviews', A.requireAuth, (req, res) => {
  const rating = Number(req.body.rating);
  const comment = String(req.body.comment || '').trim().slice(0, 500);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Rating must be between 1 and 5' });
  }
  if (!db.prepare('SELECT id FROM movies WHERE id = ?').get(req.params.id)) {
    return res.status(404).json({ error: 'Movie not found' });
  }

  db.prepare(`
    INSERT INTO reviews (movie_id, user_id, rating, comment) VALUES (?, ?, ?, ?)
    ON CONFLICT (movie_id, user_id)
    DO UPDATE SET rating = excluded.rating, comment = excluded.comment,
                  created_at = datetime('now','localtime')
  `).run(req.params.id, req.user.id, rating, comment);

  res.status(201).json({ ok: true });
});

module.exports = router;

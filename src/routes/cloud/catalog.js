'use strict';
const express = require('express');
const S = require('../../store');
const A = require('../../auth');
const config = require('../../config');

const router = express.Router();

/* ---------------- movies ---------------- */

router.get('/movies', async (req, res) => {
  res.json({
    movies: await S.listMovies({
      search: String(req.query.search || ''),
      genre: String(req.query.genre || ''),
      language: String(req.query.language || ''),
      status: String(req.query.status || ''),
      sort: String(req.query.sort || ''),
    }),
  });
});

/** Home-page rows: now showing, coming soon and most-reviewed. */
router.get('/home', async (_req, res) => {
  const [all, popular] = await Promise.all([S.listMovies({}), S.popularMovies(6)]);
  res.json({
    now_showing: all.filter((m) => m.status === 'now_showing').slice(0, 12),
    coming_soon: all.filter((m) => m.status === 'coming_soon').slice(0, 8),
    popular,
    featured: popular[0] || all[0] || null,
  });
});

router.get('/movies/:id', async (req, res) => {
  const movie = await S.getMovie(req.params.id);
  if (!movie) return res.status(404).json({ error: 'Movie not found' });
  res.json({ movie });
});

router.get('/movies/:id/shows', async (req, res) => {
  await S.releaseExpiredHolds();

  const date = String(req.query.date || '').trim();
  const city = String(req.query.city || '').trim();
  const stamp = S.now();

  const [shows, screens, cinemas, seatCounts, takenMap] = await Promise.all([
    S.showsForMovie(req.params.id), S.listAllScreens(), S.listCinemas(),
    S.seatCountsByScreen(), S.allTakenSeats(),
  ]);
  const screenById = new Map(screens.map((s) => [Number(s.id), s]));
  const cinemaById = new Map(cinemas.map((c) => [Number(c.id), c]));

  const upcoming = shows
    .filter((s) => s.status === 'active' && s.start_time >= stamp)
    .filter((s) => !date || s.start_time.startsWith(date))
    .sort((a, b) => a.start_time.localeCompare(b.start_time));

  const byCinema = new Map();
  for (const show of upcoming) {
    const screen = screenById.get(Number(show.screen_id));
    const cinema = screen && cinemaById.get(Number(screen.cinema_id));
    if (!screen || !cinema) continue;
    if (city && cinema.city !== city) continue;

    const total = seatCounts.get(Number(screen.id)) || 0;
    const taken = takenMap.get(Number(show.id)) || {};
    const key = `${cinema.name}|${cinema.city}`;
    if (!byCinema.has(key)) byCinema.set(key, { cinema: cinema.name, city: cinema.city, shows: [] });

    byCinema.get(key).shows.push({
      id: show.id, start_time: show.start_time, base_price: show.base_price,
      screen: screen.name,
      total_seats: total,
      seats_left: total - Object.keys(taken).length,
    });
  }

  res.json({ cinemas: [...byCinema.values()] });
});

/* ---------------- show + seat map ---------------- */

router.get('/shows/:id', async (req, res) => {
  await S.releaseExpiredHolds();

  const show = await S.getShow(req.params.id);
  if (!show) return res.status(404).json({ error: 'Show not found' });

  const [movie, screen] = await Promise.all([S.getMovie(show.movie_id), S.getScreen(show.screen_id)]);
  if (!movie || !screen) return res.status(404).json({ error: 'Show not found' });
  const cinema = await S.getCinema(screen.cinema_id);

  const [seats, taken] = await Promise.all([S.listSeats(screen.id), S.takenSeats(show.id)]);

  const mapped = seats.map((s) => ({
    id: s.id, row_label: s.row_label, seat_no: s.seat_no,
    seat_type: s.seat_type, price_multiplier: s.price_multiplier,
    label: `${s.row_label}${s.seat_no}`,
    price: Math.round(show.base_price * s.price_multiplier),
    booked: Boolean(taken[s.id]),
    disabled: Boolean(s.disabled),        // taken out of service, never bookable
  }));

  const rows = [];
  for (const s of mapped) {
    let row = rows.find((r) => r.row_label === s.row_label);
    if (!row) { row = { row_label: s.row_label, seats: [] }; rows.push(row); }
    row.seats.push(s);
  }

  res.json({
    show: {
      ...show,
      title: movie.title, duration_min: movie.duration_min, certificate: movie.certificate,
      language: movie.language, poster_url: movie.poster_url,
      screen: screen.name, row_count: screen.row_count, col_count: screen.col_count,
      cinema: cinema?.name, city: cinema?.city, address: cinema?.address,
    },
    rows,
    seats_left: mapped.filter((s) => !s.booked && !s.disabled).length,
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

router.get('/cinemas', async (req, res) => {
  await S.releaseExpiredHolds();
  const city = String(req.query.city || '').trim();

  const [cinemas, screens, shows, movies, seatCounts] = await Promise.all([
    S.listCinemas(), S.listAllScreens(), S.listShows(), S.listMoviesRaw(), S.seatCountsByScreen(),
  ]);
  const stamp = S.now();
  const movieM = new Map(movies.map((m) => [Number(m.id), m]));

  const rows = cinemas
    .filter((c) => !city || c.city === city)
    .map((c) => {
      const own = screens.filter((s) => Number(s.cinema_id) === Number(c.id));
      const ids = new Set(own.map((s) => Number(s.id)));
      const upcoming = shows.filter((s) =>
        s.status === 'active' && ids.has(Number(s.screen_id)) && s.start_time >= stamp);

      const titles = [...new Set(upcoming.map((s) => movieM.get(Number(s.movie_id))?.title).filter(Boolean))];
      return {
        id: c.id, name: c.name, city: c.city, address: c.address,
        screens: own.map((s) => ({ id: s.id, name: s.name, seat_count: seatCounts.get(Number(s.id)) || 0 })),
        screen_count: own.length,
        total_seats: own.reduce((sum, s) => sum + (seatCounts.get(Number(s.id)) || 0), 0),
        upcoming_shows: upcoming.length,
        now_showing: titles.slice(0, 6),
      };
    })
    .sort((a, b) => String(a.city).localeCompare(String(b.city)) || String(a.name).localeCompare(String(b.name)));

  res.json({ cinemas: rows });
});

/** Every upcoming show at one cinema, grouped by date then movie. */
router.get('/cinemas/:id/shows', async (req, res) => {
  await S.releaseExpiredHolds();

  const cinema = await S.getCinema(req.params.id);
  if (!cinema) return res.status(404).json({ error: 'Cinema not found' });

  const date = String(req.query.date || '').trim();
  const [screens, shows, movies, seatCounts, takenMap] = await Promise.all([
    S.listAllScreens(), S.listShows(), S.listMoviesRaw(), S.seatCountsByScreen(), S.allTakenSeats(),
  ]);

  const own = screens.filter((s) => Number(s.cinema_id) === Number(cinema.id));
  const screenM = new Map(own.map((s) => [Number(s.id), s]));
  const movieM = new Map(movies.map((m) => [Number(m.id), m]));
  const stamp = S.now();

  const byMovie = new Map();
  for (const show of shows) {
    if (show.status !== 'active' || !screenM.has(Number(show.screen_id))) continue;
    if (show.start_time < stamp) continue;
    if (date && !show.start_time.startsWith(date)) continue;

    const movie = movieM.get(Number(show.movie_id));
    if (!movie) continue;
    const total = seatCounts.get(Number(show.screen_id)) || 0;

    if (!byMovie.has(movie.id)) {
      byMovie.set(movie.id, {
        movie_id: movie.id, title: movie.title, poster_url: movie.poster_url,
        genre: movie.genre, language: movie.language, certificate: movie.certificate,
        duration_min: movie.duration_min, shows: [],
      });
    }
    byMovie.get(movie.id).shows.push({
      id: show.id, start_time: show.start_time, base_price: show.base_price,
      screen: screenM.get(Number(show.screen_id)).name,
      total_seats: total,
      seats_left: total - Object.keys(takenMap.get(Number(show.id)) || {}).length,
    });
  }

  for (const m of byMovie.values()) m.shows.sort((a, b) => a.start_time.localeCompare(b.start_time));
  res.json({ cinema, movies: [...byMovie.values()] });
});

/* ---------------- filters ---------------- */

router.get('/cities', async (_req, res) => {
  const cities = [...new Set((await S.listCinemas()).map((c) => c.city))].sort();
  res.json({ cities });
});

router.get('/genres', async (_req, res) => {
  // Archived movies are hidden from the site, so their genres must not appear
  // either - a chip that leads to an empty list is a dead end.
  const set = new Set();
  for (const m of await S.listMoviesRaw()) {
    if (m.status === 'archived') continue;
    for (const g of String(m.genre || '').split(',')) {
      if (g.trim()) set.add(g.trim());
    }
  }
  res.json({ genres: [...set].sort() });
});

/** Payment methods and money settings, so the front end never hardcodes them. */
router.get('/payment-methods', (_req, res) => {
  res.json({
    methods: require('../../payments').METHODS,
    currency: config.payment.currencySymbol,
    booking_fee_per_seat: config.booking.bookingFeePerSeat,
    service_fee_percent: config.booking.serviceFeePercent,
  });
});

/* ---------------- reviews ---------------- */

router.get('/movies/:id/reviews', async (req, res) => {
  const [reviews, users] = await Promise.all([S.listReviews(req.params.id), S.listUsersRaw()]);
  const nameById = new Map(users.map((u) => [Number(u.id), u.name]));
  res.json({
    reviews: reviews.map((r) => ({
      id: r.id, rating: r.rating, comment: r.comment, created_at: r.created_at,
      user_name: nameById.get(Number(r.user_id)) || 'Unknown',
    })),
  });
});

router.post('/movies/:id/reviews', A.requireAuth, async (req, res) => {
  const rating = Number(req.body.rating);
  const comment = String(req.body.comment || '').trim().slice(0, 500);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Rating must be between 1 and 5' });
  }
  if (!(await S.getMovie(req.params.id))) return res.status(404).json({ error: 'Movie not found' });

  await S.upsertReview(req.params.id, req.user.id, { rating, comment });
  res.status(201).json({ ok: true });
});

module.exports = router;

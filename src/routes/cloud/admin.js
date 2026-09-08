'use strict';
const express = require('express');
const S = require('../../store');
const A = require('../../auth');
const config = require('../../config');
const FA = require('../../firebaseauth');

const router = express.Router();
router.use(A.requireAdmin);

const DEFAULT_MULTIPLIER = { SILVER: 1.0, GOLD: 1.5, RECLINER: 2.2 };
const clamp = (n, lo, hi) => Math.min(Math.max(Number(n) || 0, lo), hi);

/* ---------------- shared ---------------- */

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

  return {
    rows, cols, tiers,
    mult: {
      SILVER: Number(body.silver_price ?? DEFAULT_MULTIPLIER.SILVER) || DEFAULT_MULTIPLIER.SILVER,
      GOLD: Number(body.gold_price ?? DEFAULT_MULTIPLIER.GOLD) || DEFAULT_MULTIPLIER.GOLD,
      RECLINER: Number(body.recliner_price ?? DEFAULT_MULTIPLIER.RECLINER) || DEFAULT_MULTIPLIER.RECLINER,
    },
  };
}

/** Every booking with the movie / cinema names joined in. */
async function bookingsWithDetail() {
  const [bookings, shows, movies, screens, cinemas, users, payments] = await Promise.all([
    S.listBookings(), S.listShows(), S.listMoviesRaw(), S.listAllScreens(),
    S.listCinemas(), S.listUsersRaw(), S.listPayments(),
  ]);
  const by = (list) => new Map(list.map((x) => [Number(x.id), x]));
  const showM = by(shows), movieM = by(movies), screenM = by(screens), cinemaM = by(cinemas), userM = by(users);

  return bookings.map((b) => {
    const show = showM.get(Number(b.show_id));
    const movie = show && movieM.get(Number(show.movie_id));
    const screen = show && screenM.get(Number(show.screen_id));
    const cinema = screen && cinemaM.get(Number(screen.cinema_id));
    const user = userM.get(Number(b.user_id));
    const payment = payments.find((p) => Number(p.booking_id) === Number(b.id));
    return {
      ...b,
      user_name: user?.name, email: user?.email,
      title: movie?.title, start_time: show?.start_time,
      cinema: cinema?.name, screen: screen?.name,
      payment_method: payment?.method || null,
    };
  });
}

/* ---------------- dashboard ---------------- */

router.get('/stats', async (_req, res) => {
  await S.releaseExpiredHolds();

  const [bookings, shows, movies, cinemas, users, payments, screens] = await Promise.all([
    S.listBookings(), S.listShows(), S.listMoviesRaw(), S.listCinemas(),
    S.listUsersRaw(), S.listPayments(), S.listAllScreens(),
  ]);

  const confirmed = bookings.filter((b) => b.status === 'CONFIRMED');
  const revenue = confirmed.reduce((s, b) => s + (b.total_amount || 0), 0);
  const refunded = payments.filter((p) => p.status === 'REFUNDED').reduce((s, p) => s + (p.amount || 0), 0);
  const seatsSold = confirmed.reduce((s, b) => s + (b.seats?.length || 0), 0);
  const seatCounts = await S.seatCountsByScreen();

  /*
   * Occupancy is measured over TODAY's shows only. Averaging across every future
   * show would divide by weeks of unsold inventory and always read close to zero,
   * which tells an operator nothing.
   */
  const todayStr = S.now().slice(0, 10);
  const todaysShows = shows.filter((s) => s.status === 'active' && String(s.start_time).startsWith(todayStr));
  const todayShowIds = new Set(todaysShows.map((s) => Number(s.id)));

  const seatsOfferedToday = todaysShows
    .reduce((sum, s) => sum + (seatCounts.get(Number(s.screen_id)) || 0), 0);
  const seatsSoldToday = confirmed
    .filter((b) => todayShowIds.has(Number(b.show_id)))
    .reduce((sum, b) => sum + (b.seats?.length || 0), 0);

  const dayMap = new Map();
  for (const b of confirmed) {
    const day = String(b.created_at || '').slice(0, 10);
    const cur = dayMap.get(day) || { day, bookings: 0, revenue: 0 };
    cur.bookings++; cur.revenue += b.total_amount || 0;
    dayMap.set(day, cur);
  }

  const movieMap = new Map();
  const showM = new Map(shows.map((s) => [Number(s.id), s]));
  for (const b of confirmed) {
    const show = showM.get(Number(b.show_id));
    const movie = show && movies.find((m) => Number(m.id) === Number(show.movie_id));
    if (!movie) continue;
    const cur = movieMap.get(movie.title) || { title: movie.title, seats: 0, revenue: 0 };
    cur.seats += b.seats?.length || 0;
    cur.revenue += (b.seats || []).reduce((s, x) => s + x.price, 0);
    movieMap.set(movie.title, cur);
  }

  const today = S.now().slice(0, 10);
  const todays = confirmed.filter((b) => String(b.created_at || '').startsWith(today));
  const stamp = S.now();

  const screenM = new Map(screens.map((sc) => [Number(sc.id), sc]));
  const cinemaM = new Map(cinemas.map((c) => [Number(c.id), c]));

  const upcomingShows = shows
    .filter((s) => s.status === 'active' && s.start_time >= stamp)
    .sort((a, b) => a.start_time.localeCompare(b.start_time))
    .slice(0, 8)
    .map((s) => {
      const screen = screenM.get(Number(s.screen_id));
      const cinema = screen && cinemaM.get(Number(screen.cinema_id));
      const total = seatCounts.get(Number(s.screen_id)) || 0;
      const sold = (bookings.filter((b) => Number(b.show_id) === Number(s.id) && b.status === 'CONFIRMED')
        .reduce((sum, b) => sum + (b.seats?.length || 0), 0));
      return {
        id: s.id, start_time: s.start_time,
        title: movies.find((m) => Number(m.id) === Number(s.movie_id))?.title,
        cinema: cinema?.name, screen: screen?.name,
        sold, total, fill: total ? Math.round((sold / total) * 100) : 0,
      };
    });

  const recent = confirmed
    .slice()
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 8)
    .map((b) => ({
      id: b.id, booking_ref: b.booking_ref, total_amount: b.total_amount,
      seats_snapshot: b.seats_snapshot, created_at: b.created_at,
      user_name: users.find((u) => Number(u.id) === Number(b.user_id))?.name,
      title: movies.find((m) => Number(m.id) === Number(showM.get(Number(b.show_id))?.movie_id))?.title,
    }));

  /* A continuous 14-day series, so the chart has no gaps on quiet days. */
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
      movies: movies.length,
      cinemas: cinemas.length,
      screens: screens.length,
      shows: shows.filter((s) => s.status === 'active').length,
      users: users.filter((u) => u.role === 'user').length,
      bookings: confirmed.length,
      bookings_today: todays.length,
      revenue_today: todays.reduce((s, b) => s + (b.total_amount || 0), 0),
      revenue, refunded,
      seats_sold: seatsSold,
      occupancy: seatsOfferedToday ? Math.round((seatsSoldToday / seatsOfferedToday) * 100) : 0,
      occupancy_seats: `${seatsSoldToday}/${seatsOfferedToday}`,
      shows_today: todaysShows.length,
    },
    series,
    daily: [...dayMap.values()].sort((a, b) => b.day.localeCompare(a.day)).slice(0, 14),
    top_movies: [...movieMap.values()].sort((a, b) => b.seats - a.seats).slice(0, 5),
    upcoming_shows: upcomingShows,
    recent_bookings: recent,
    currency: config.payment.currencySymbol,
  });
});

/* ---------------- movies ---------------- */

function movieFields(body) {
  return {
    title: String(body.title || '').trim(),
    description: String(body.description || '').trim(),
    genre: String(body.genre || '').trim(),
    language: String(body.language || '').trim(),
    duration_min: Number(body.duration_min) || 120,
    certificate: String(body.certificate || 'U/A').trim(),
    director: String(body.director || '').trim(),
    cast_list: String(body.cast_list || '').trim(),
    poster_url: String(body.poster_url || '').trim(),
    banner_url: String(body.banner_url || '').trim(),
    trailer_url: String(body.trailer_url || '').trim(),
    release_date: String(body.release_date || '').trim(),
    status: ['now_showing', 'coming_soon', 'archived'].includes(body.status) ? body.status : 'now_showing',
  };
}

router.get('/movies', async (_req, res) => {
  const [movies, shows] = await Promise.all([S.listMoviesRaw(), S.listShows()]);
  const stamp = S.now();

  // A movie is only bookable once it has an upcoming show, so the panel says so.
  for (const m of movies) {
    m.upcoming_shows = shows.filter((sh) =>
      Number(sh.movie_id) === Number(m.id) && sh.status === 'active' && sh.start_time >= stamp).length;
  }

  movies.sort((a, b) => Number(b.id) - Number(a.id));
  res.json({ movies });
});

router.post('/movies', async (req, res) => {
  const f = movieFields(req.body);
  if (!f.title) return res.status(400).json({ error: 'Title is required' });
  res.status(201).json({ movie: await S.createMovie(f) });
});

router.put('/movies/:id', async (req, res) => {
  const f = movieFields(req.body);
  if (!f.title) return res.status(400).json({ error: 'Title is required' });
  const movie = await S.updateMovie(req.params.id, f);
  if (!movie) return res.status(404).json({ error: 'Movie not found' });
  res.json({ movie });
});

router.delete('/movies/:id', async (req, res) => {
  const shows = (await S.listShows()).filter((s) => Number(s.movie_id) === Number(req.params.id));
  const showIds = new Set(shows.map((s) => Number(s.id)));
  const sold = (await S.listBookings())
    .filter((b) => b.status === 'CONFIRMED' && showIds.has(Number(b.show_id)));

  // Deleting would cascade away paying customers' bookings, so it is refused.
  // The response says how many, so the panel can offer archiving instead.
  if (sold.length) {
    return res.status(409).json({
      error: `This movie has ${sold.length} confirmed booking${sold.length > 1 ? 's' : ''}. `
           + 'Archive it instead, or cancel those bookings first.',
      blocked_by: sold.length,
      can_archive: true,
    });
  }

  for (const s of shows) await S.deleteShow(s.id);
  await S.deleteMovie(req.params.id);
  res.json({ ok: true, removed_shows: shows.length });
});

/* ---------------- cinemas & screens ---------------- */

router.get('/cinemas', async (_req, res) => {
  const cinemas = await S.listCinemas();
  cinemas.sort((a, b) => String(a.city).localeCompare(String(b.city)) || String(a.name).localeCompare(String(b.name)));

  // Prefetched once, so this endpoint costs a handful of reads instead of one per screen.
  const [allScreens, shows, taken] = await Promise.all([
    S.listAllScreens(), S.listShows(), S.allTakenSeats(),
  ]);

  for (const c of cinemas) {
    c.screens = allScreens.filter((sc) => Number(sc.cinema_id) === Number(c.id));
    c.screens.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    for (const sc of c.screens) {
      const seats = await S.listSeats(sc.id);
      sc.seat_count = seats.length;
      sc.silver_seats = seats.filter((s) => s.seat_type === 'SILVER').length;
      sc.gold_seats = seats.filter((s) => s.seat_type === 'GOLD').length;
      sc.recliner_seats = seats.filter((s) => s.seat_type === 'RECLINER').length;
      sc.in_use = await S.screenIsInUse(sc.id, shows, taken);
    }
  }
  res.json({ cinemas });
});

router.post('/cinemas', async (req, res) => {
  const name = String(req.body.name || '').trim();
  const city = String(req.body.city || '').trim();
  if (!name || !city) return res.status(400).json({ error: 'Cinema name and city are required' });
  res.status(201).json({ cinema: await S.createCinema({ name, city, address: String(req.body.address || '').trim() }) });
});

router.put('/cinemas/:id', async (req, res) => {
  const name = String(req.body.name || '').trim();
  const city = String(req.body.city || '').trim();
  if (!name || !city) return res.status(400).json({ error: 'Cinema name and city are required' });
  const cinema = await S.updateCinema(req.params.id, { name, city, address: String(req.body.address || '').trim() });
  if (!cinema) return res.status(404).json({ error: 'Cinema not found' });
  res.json({ cinema });
});

router.delete('/cinemas/:id', async (req, res) => {
  await S.deleteCinema(req.params.id);
  res.json({ ok: true });
});

router.post('/screens', async (req, res) => {
  const cinemaId = Number(req.body.cinema_id);
  const name = String(req.body.name || '').trim();
  if (!(await S.getCinema(cinemaId))) return res.status(400).json({ error: 'Cinema not found' });
  if (!name) return res.status(400).json({ error: 'Screen name is required' });

  const layout = readLayout(req.body);
  if (layout.error) return res.status(400).json({ error: layout.error });

  res.status(201).json({ screen: await S.createScreen(cinemaId, name, layout) });
});

router.put('/screens/:id', async (req, res) => {
  const screen = await S.getScreen(req.params.id);
  if (!screen) return res.status(404).json({ error: 'Screen not found' });

  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Screen name is required' });

  const layout = readLayout(req.body);
  if (layout.error) return res.status(400).json({ error: layout.error });

  const layoutChanged = layout.rows !== screen.row_count || layout.cols !== screen.col_count
    || req.body.silver_rows != null || req.body.silver_price != null;

  if (layoutChanged && await S.screenIsInUse(screen.id)) {
    await S.updateScreen(screen.id, { name });
    return res.status(409).json({
      error: 'This screen has tickets booked, so only the name was updated. Cancel those bookings first to change the seat layout.',
    });
  }

  await S.updateScreen(screen.id, { name, row_count: layout.rows, col_count: layout.cols });
  await S.replaceSeats(screen.id, layout);
  res.json({ screen: await S.getScreen(screen.id) });
});

router.delete('/screens/:id', async (req, res) => {
  await S.deleteScreen(req.params.id);
  res.json({ ok: true });
});

/* ---------------- shows ---------------- */

async function findClash(screenId, startTime, durationMin, exceptId = 0) {
  const [shows, movies] = await Promise.all([S.showsForScreen(screenId), S.listMoviesRaw()]);
  const movieM = new Map(movies.map((m) => [Number(m.id), m]));
  const startMs = new Date(startTime.replace(' ', 'T')).getTime();
  const endMs = startMs + (durationMin + 20) * 60_000;

  for (const s of shows) {
    if (Number(s.id) === Number(exceptId) || s.status !== 'active') continue;
    const m = movieM.get(Number(s.movie_id));
    const otherStart = new Date(String(s.start_time).replace(' ', 'T')).getTime();
    const otherEnd = otherStart + ((m?.duration_min || 120) + 20) * 60_000;
    if (startMs < otherEnd && otherStart < endMs) return { ...s, title: m?.title };
  }
  return null;
}

async function readShow(body) {
  const startTime = String(body.start_time || '').trim().replace('T', ' ').slice(0, 16);
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(startTime)) {
    return { error: 'Start time must look like 2026-09-10 18:30' };
  }
  const movie = await S.getMovie(Number(body.movie_id));
  if (!movie) return { error: 'Movie not found' };
  if (!(await S.getScreen(Number(body.screen_id)))) return { error: 'Screen not found' };

  return {
    movie,
    screenId: Number(body.screen_id),
    startTime,
    basePrice: Number(body.base_price) || 500,
    status: body.status === 'cancelled' ? 'cancelled' : 'active',
  };
}

router.get('/shows', async (_req, res) => {
  await S.releaseExpiredHolds();

  const [shows, movies, screens, cinemas] = await Promise.all([
    S.listShows(), S.listMoviesRaw(), S.listAllScreens(), S.listCinemas(),
  ]);
  const movieM = new Map(movies.map((m) => [Number(m.id), m]));
  const screenM = new Map(screens.map((s) => [Number(s.id), s]));
  const cinemaM = new Map(cinemas.map((c) => [Number(c.id), c]));

  const [seatCounts, takenMap] = await Promise.all([S.seatCountsByScreen(), S.allTakenSeats()]);

  const rows = [];
  for (const s of shows) {
    const movie = movieM.get(Number(s.movie_id));
    const screen = screenM.get(Number(s.screen_id));
    const cinema = screen && cinemaM.get(Number(screen.cinema_id));
    rows.push({
      ...s,
      title: movie?.title, duration_min: movie?.duration_min,
      screen: screen?.name, cinema: cinema?.name, city: cinema?.city,
      total_seats: seatCounts.get(Number(s.screen_id)) || 0,
      taken_seats: Object.keys(takenMap.get(Number(s.id)) || {}).length,
    });
  }
  rows.sort((a, b) => String(b.start_time).localeCompare(String(a.start_time)));
  res.json({ shows: rows });
});

router.post('/shows', async (req, res) => {
  const p = await readShow(req.body);
  if (p.error) return res.status(400).json({ error: p.error });

  const clash = await findClash(p.screenId, p.startTime, p.movie.duration_min);
  if (clash) return res.status(409).json({ error: `Screen is busy: "${clash.title}" starts at ${clash.start_time}` });

  const show = await S.createShow({
    movie_id: Number(p.movie.id), screen_id: p.screenId,
    start_time: p.startTime, base_price: p.basePrice, status: p.status,
  });
  res.status(201).json({ show });
});

router.put('/shows/:id', async (req, res) => {
  const show = await S.getShow(req.params.id);
  if (!show) return res.status(404).json({ error: 'Show not found' });

  const p = await readShow(req.body);
  if (p.error) return res.status(400).json({ error: p.error });

  const booked = Object.keys(await S.takenSeats(show.id)).length;
  if (booked > 0 && p.screenId !== Number(show.screen_id)) {
    return res.status(409).json({ error: 'Tickets are already booked, so this show cannot be moved to another screen.' });
  }

  const clash = await findClash(p.screenId, p.startTime, p.movie.duration_min, show.id);
  if (clash) return res.status(409).json({ error: `Screen is busy: "${clash.title}" starts at ${clash.start_time}` });

  res.json({
    show: await S.updateShow(show.id, {
      movie_id: Number(p.movie.id), screen_id: p.screenId,
      start_time: p.startTime, base_price: p.basePrice, status: p.status,
    }),
  });
});

router.delete('/shows/:id', async (req, res) => {
  const bookings = await S.listBookings();
  const mine = bookings.filter((b) => Number(b.show_id) === Number(req.params.id));

  if (mine.some((b) => b.status === 'CONFIRMED')) {
    await S.updateShow(req.params.id, { status: 'cancelled' });
    return res.json({ ok: true, note: 'Show had bookings, so it was cancelled instead of deleted.' });
  }

  // Only cancelled or expired bookings can remain here, and a booking whose show
  // no longer exists has nothing to display. Remove them with the show.
  for (const b of mine) await S.deleteBooking(b.id);

  await S.deleteShow(req.params.id);
  res.json({ ok: true, removed_bookings: mine.length });
});

/* ---------------- bookings ---------------- */

router.get('/bookings', async (req, res) => {
  await S.releaseExpiredHolds();
  const status = String(req.query.status || '').trim();

  const q = String(req.query.search || '').trim().toLowerCase();

  let rows = await bookingsWithDetail();
  if (status) rows = rows.filter((b) => b.status === status);
  if (q) {
    rows = rows.filter((b) => [b.booking_ref, b.user_name, b.email, b.title, b.cinema, b.seats_snapshot]
      .some((v) => String(v || '').toLowerCase().includes(q)));
  }
  rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  res.json({ bookings: rows.slice(0, 300) });
});

router.post('/bookings/:id/cancel', async (req, res) => {
  const booking = await S.getBooking(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  await S.releaseBooking(booking.id, booking.show_id, { status: 'CANCELLED', expires_at: null });
  await S.refundPayments(booking.id);
  res.json({ ok: true });
});

/* ---------------- users ---------------- */

router.get('/users', async (req, res) => {
  const q = String(req.query.search || '').trim().toLowerCase();
  const [users, bookings] = await Promise.all([S.listUsersRaw(), S.listBookings()]);

  const filtered = q
    ? users.filter((u) => [u.name, u.email, u.phone].some((v) => String(v || '').toLowerCase().includes(q)))
    : users;

  const rows = filtered.map((u) => {
    const mine = bookings.filter((b) => Number(b.user_id) === Number(u.id) && b.status === 'CONFIRMED');
    return {
      id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role,
      blocked: u.blocked, created_at: u.created_at,
      bookings: mine.length,
      spent: mine.reduce((s, b) => s + (b.total_amount || 0), 0),
    };
  });
  rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  res.json({ users: rows });
});

router.post('/users', async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const role = req.body.role === 'admin' ? 'admin' : 'user';

  if (name.length < 3) return res.status(400).json({ error: 'Name must be at least 3 characters' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (await S.findUserByEmail(email)) return res.status(409).json({ error: 'This email is already registered' });

  let extra = { password_hash: A.hashPassword(password) };
  if (FA.isEnabled()) {
    if (await FA.getByEmail(email)) return res.status(409).json({ error: 'This email is already registered' });
    try {
      extra = { firebase_uid: await FA.createUser({ email, password, name, role }) };
    } catch (e) {
      return res.status(400).json({ error: e.message.replace(/^.*?: /, '') });
    }
  }

  await S.createUser({ name, email, phone: String(req.body.phone || '').trim(), ...extra, role });
  res.status(201).json({ ok: true });
});

router.put('/users/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!(await S.findUserById(id))) return res.status(404).json({ error: 'User not found' });

  const name = String(req.body.name || '').trim();
  if (name.length < 3) return res.status(400).json({ error: 'Name must be at least 3 characters' });

  const role = req.body.role === 'admin' ? 'admin' : 'user';
  if (id === Number(req.user.id) && role !== 'admin') {
    return res.status(400).json({ error: 'You cannot remove your own admin role' });
  }

  const existing = await S.findUserById(id);
  const patch = { name, phone: String(req.body.phone || '').trim(), role };
  const newPassword = String(req.body.password || '');
  if (newPassword && newPassword.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  if (FA.isEnabled() && existing.firebase_uid) {
    await FA.updateUser(existing.firebase_uid, { name, password: newPassword || undefined });
    await FA.setRole(existing.firebase_uid, role);
  } else if (newPassword) {
    patch.password_hash = A.hashPassword(newPassword);
  }

  await S.updateUser(id, patch);
  res.json({ ok: true });
});

router.patch('/users/:id/block', async (req, res) => {
  const id = Number(req.params.id);
  if (id === Number(req.user.id)) return res.status(400).json({ error: 'You cannot block your own account' });
  if (!(await S.findUserById(id))) return res.status(404).json({ error: 'User not found' });

  const blocked = req.body.blocked ? 1 : 0;
  const existing = await S.findUserById(id);

  // Blocking here also disables the Firebase account, so the sign-in itself fails.
  if (FA.isEnabled() && existing.firebase_uid) {
    await FA.updateUser(existing.firebase_uid, { disabled: Boolean(blocked) });
  }

  await S.updateUser(id, { blocked });
  res.json({ ok: true, blocked });
});

router.delete('/users/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (id === Number(req.user.id)) return res.status(400).json({ error: 'You cannot delete your own account' });

  const booked = (await S.listBookings())
    .some((b) => Number(b.user_id) === id && b.status === 'CONFIRMED');
  if (booked) {
    return res.status(409).json({ error: 'This user has confirmed bookings. Block the account instead of deleting it.' });
  }
  const existing = await S.findUserById(id);
  if (FA.isEnabled() && existing?.firebase_uid) await FA.deleteUser(existing.firebase_uid);

  await S.deleteUser(id);
  res.json({ ok: true });
});

/** One user's full booking history, for the admin's user drill-down. */
router.get('/users/:id/bookings', async (req, res) => {
  const user = await S.findUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const all = await bookingsWithDetail();
  const rows = all
    .filter((b) => Number(b.user_id) === Number(req.params.id))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

  res.json({
    user: { id: user.id, name: user.name, email: user.email, phone: user.phone, role: user.role },
    bookings: rows,
  });
});

/* ---------------- seat availability ---------------- */

/** Full seat grid for one screen, so an admin can take seats out of service. */
router.get('/screens/:id/seats', async (req, res) => {
  const screen = await S.getScreen(req.params.id);
  if (!screen) return res.status(404).json({ error: 'Screen not found' });

  const seats = await S.listSeats(screen.id);
  const rows = [];
  for (const s of seats) {
    let row = rows.find((r) => r.row_label === s.row_label);
    if (!row) { row = { row_label: s.row_label, seats: [] }; rows.push(row); }
    row.seats.push({ ...s, label: `${s.row_label}${s.seat_no}`, disabled: Boolean(s.disabled) });
  }
  res.json({ screen, rows, total: seats.length, disabled: seats.filter((s) => s.disabled).length });
});

router.patch('/seats/disable', async (req, res) => {
  const seatIds = Array.isArray(req.body.seat_ids) ? req.body.seat_ids.map(Number).filter(Number.isFinite) : [];
  if (!seatIds.length) return res.status(400).json({ error: 'Select at least one seat' });

  await S.setSeatsDisabled(seatIds, Boolean(req.body.disabled));
  res.json({ ok: true, updated: seatIds.length, disabled: Boolean(req.body.disabled) });
});

/* ---------------- promos ---------------- */

function readPromo(body) {
  const code = String(body.code || '').trim().toUpperCase();
  const type = body.discount_type === 'flat' ? 'flat' : 'percent';
  const value = Number(body.discount_value);
  if (!code) return { error: 'Promo code is required' };
  if (!(value > 0)) return { error: 'Discount value must be greater than 0' };
  if (type === 'percent' && value > 100) return { error: 'A percentage discount cannot be over 100' };
  return {
    code,
    data: {
      code,
      discount_type: type,
      discount_value: value,
      max_discount: body.max_discount ? Number(body.max_discount) : null,
      min_amount: Number(body.min_amount) || 0,
      expires_at: String(body.expires_at || '').trim() || null,
      active: body.active === undefined ? 1 : (body.active ? 1 : 0),
    },
  };
}

router.get('/promos', async (_req, res) => {
  const promos = await S.listPromos();
  promos.sort((a, b) => String(a.code).localeCompare(String(b.code)));
  res.json({ promos });
});

router.post('/promos', async (req, res) => {
  const p = readPromo(req.body);
  if (p.error) return res.status(400).json({ error: p.error });
  if (await S.getPromo(p.code)) return res.status(409).json({ error: 'This promo code already exists' });
  await S.setPromo(p.code, p.data);
  res.status(201).json({ ok: true });
});

/** The document ID is the code, so renaming means writing a new doc and dropping the old one. */
router.put('/promos/:id', async (req, res) => {
  const oldCode = String(req.params.id).toUpperCase();
  const p = readPromo(req.body);
  if (p.error) return res.status(400).json({ error: p.error });

  if (!(await S.getPromo(oldCode))) return res.status(404).json({ error: 'Promo not found' });
  if (p.code !== oldCode && await S.getPromo(p.code)) {
    return res.status(409).json({ error: 'Another promo already uses this code' });
  }

  await S.setPromo(p.code, p.data);
  if (p.code !== oldCode) await S.deletePromo(oldCode);
  res.json({ ok: true });
});

router.patch('/promos/:id', async (req, res) => {
  const promo = await S.getPromo(req.params.id);
  if (!promo) return res.status(404).json({ error: 'Promo not found' });
  await S.setPromo(promo.code, { ...promo, id: undefined, active: req.body.active ? 1 : 0 });
  res.json({ ok: true });
});

router.delete('/promos/:id', async (req, res) => {
  await S.deletePromo(req.params.id);
  res.json({ ok: true });
});

module.exports = router;

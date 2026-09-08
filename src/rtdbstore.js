'use strict';
/**
 * Realtime Database data layer.
 *
 * Exposes exactly the same functions as src/fstore.js, so the shared route files
 * work against either database unchanged.
 *
 * Realtime Database is a single JSON tree with no collections and no queries
 * worth the name, so filtering happens in memory - which is what the Firestore
 * layer already did anyway. What it does have is `ref.transaction()`, an atomic
 * compare-and-set with automatic retry, and that is exactly the primitive the
 * double-booking guard needs.
 */
const R = require('./rtdb');

const db = () => R.db();
const ref = (path) => db().ref(path);

/* ---------- helpers ---------- */

const numOrStr = (id) => (/^\d+$/.test(String(id)) ? Number(id) : id);

/** Realtime Database rejects `undefined`, and treats `null` as "delete this key". */
function clean(value) {
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = clean(v);
    return out;
  }
  return value === undefined ? null : value;
}

/** A whole node read back as an array of records, each carrying its key as `id`. */
async function readAll(path) {
  const snap = await ref(path).get();
  const val = snap.val();
  if (!val) return [];
  return Object.entries(val).map(([id, data]) => ({ id: numOrStr(id), ...data }));
}

async function readOne(path, id) {
  const snap = await ref(`${path}/${id}`).get();
  const val = snap.val();
  return val ? { id: numOrStr(id), ...val } : null;
}

const writeOne = (path, id, data) => ref(`${path}/${id}`).set(clean(data));
const mergeOne = (path, id, patch) => ref(`${path}/${id}`).update(clean(patch));
const removeOne = (path, id) => ref(`${path}/${id}`).remove();

/** Local wall-clock 'YYYY-MM-DD HH:MM:SS', matching how show times are stored. */
function now(offsetMinutes = 0) {
  const d = new Date(Date.now() + offsetMinutes * 60_000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Auto-increment ids, so records keep the same numeric keys everywhere. */
async function nextId(name) {
  const result = await ref(`_meta/counters/${name}`).transaction((current) => (current || 1) + 1);
  return result.snapshot.val() - 1;
}

/** Multi-path atomic update, standing in for Firestore's batch writes. */
async function batchWrite(ops) {
  const updates = {};
  for (const op of ops) {
    const path = op.path || op.ref;
    if (op.delete) updates[path] = null;
    else if (op.merge) for (const [k, v] of Object.entries(clean(op.data))) updates[`${path}/${k}`] = v;
    else updates[path] = clean(op.data);
  }
  if (Object.keys(updates).length) await ref('/').update(updates);
}

/* =========================================================
   users
   ========================================================= */

async function findUserByEmail(email) {
  const target = String(email).toLowerCase();
  return (await readAll('users')).find((u) => String(u.email).toLowerCase() === target) || null;
}

const findUserById = (id) => readOne('users', id);

async function createUser({ name, email, phone = '', password_hash, firebase_uid, role = 'user' }) {
  const id = await nextId('users');
  // firebase_uid is set when Firebase Auth holds the credentials; password_hash
  // when they are hashed locally. Exactly one of the two is present.
  const user = {
    name, email: String(email).toLowerCase(), phone, role,
    blocked: 0, created_at: now(),
    ...(password_hash ? { password_hash } : {}),
    ...(firebase_uid ? { firebase_uid } : {}),
  };
  await writeOne('users', id, user);
  return { id, ...user };
}

const updateUser = (id, patch) => mergeOne('users', id, patch);
const listUsersRaw = () => readAll('users');
const deleteUser = (id) => removeOne('users', id);

/* ---------- password resets ---------- */

const saveResetToken = (token, userId, expiresAt) =>
  writeOne('passwordResets', token, { user_id: Number(userId), expires_at: expiresAt, used: 0, created_at: now() });

const getResetToken = (token) => readOne('passwordResets', token);
const consumeResetToken = (token) => mergeOne('passwordResets', token, { used: 1 });

/* =========================================================
   movies
   ========================================================= */

async function attachRatings(movies) {
  if (!movies.length) return movies;
  const reviews = await readAll('reviews');
  for (const m of movies) {
    const mine = reviews.filter((r) => Number(r.movie_id) === Number(m.id));
    m.review_count = mine.length;
    m.avg_rating = mine.length
      ? Math.round((mine.reduce((s, r) => s + r.rating, 0) / mine.length) * 10) / 10
      : null;
  }
  return movies;
}

async function listMovies({ search = '', genre = '', language = '', status = '', sort = '' } = {}) {
  let movies = (await readAll('movies')).filter((m) => m.status !== 'archived');

  const q = search.trim().toLowerCase();
  if (q) movies = movies.filter((m) =>
    String(m.title || '').toLowerCase().includes(q) || String(m.genre || '').toLowerCase().includes(q));
  if (genre) movies = movies.filter((m) => String(m.genre || '').toLowerCase().includes(genre.toLowerCase()));
  if (language) movies = movies.filter((m) => m.language === language);
  if (status) movies = movies.filter((m) => m.status === status);

  await attachRatings(movies);

  const SORTS = {
    title: (a, b) => String(a.title).localeCompare(String(b.title)),
    rating: (a, b) => (b.avg_rating || 0) - (a.avg_rating || 0),
    newest: (a, b) => String(b.release_date || '').localeCompare(String(a.release_date || '')),
    oldest: (a, b) => String(a.release_date || '').localeCompare(String(b.release_date || '')),
    duration: (a, b) => (b.duration_min || 0) - (a.duration_min || 0),
  };
  movies.sort(SORTS[sort] || ((a, b) =>
    (a.status === 'now_showing' ? 0 : 1) - (b.status === 'now_showing' ? 0 : 1)
    || String(b.release_date || '').localeCompare(String(a.release_date || ''))));
  return movies;
}

/** Ranked by review count then average, for the "Popular" row. */
async function popularMovies(limit = 6) {
  return (await listMovies({ status: 'now_showing' }))
    .sort((a, b) => (b.review_count || 0) - (a.review_count || 0) || (b.avg_rating || 0) - (a.avg_rating || 0))
    .slice(0, limit);
}

async function getMovie(id) {
  const movie = await readOne('movies', id);
  if (!movie) return null;
  await attachRatings([movie]);
  return movie;
}

const listMoviesRaw = () => readAll('movies');

async function createMovie(data) {
  const id = await nextId('movies');
  const movie = { ...data, created_at: now() };
  await writeOne('movies', id, movie);
  return { id, ...movie };
}

async function updateMovie(id, data) {
  if (!(await readOne('movies', id))) return null;
  await mergeOne('movies', id, data);
  return readOne('movies', id);
}

const deleteMovie = (id) => removeOne('movies', id);

/* =========================================================
   cinemas, screens, seats
   ========================================================= */

const listCinemas = () => readAll('cinemas');
const getCinema = (id) => readOne('cinemas', id);

async function createCinema(data) {
  const id = await nextId('cinemas');
  await writeOne('cinemas', id, data);
  return { id, ...data };
}

async function updateCinema(id, data) {
  if (!(await readOne('cinemas', id))) return null;
  await mergeOne('cinemas', id, data);
  return readOne('cinemas', id);
}

async function deleteCinema(id) {
  for (const s of await listScreens(id)) await deleteScreen(s.id);
  await removeOne('cinemas', id);
}

async function listScreens(cinemaId) {
  return (await readAll('screens')).filter((s) => Number(s.cinema_id) === Number(cinemaId));
}

const listAllScreens = () => readAll('screens');
const getScreen = (id) => readOne('screens', id);

/* ---------- seats live inside their screen record ---------- */

const SEAT_CACHE_MS = 10 * 60_000;
let seatCache = { at: 0, byScreen: new Map() };

const sortSeats = (list) =>
  list.sort((a, b) => String(a.row_label).localeCompare(String(b.row_label)) || a.seat_no - b.seat_no);

/** Realtime Database may hand an array back as an object; normalise both. */
const asList = (v) => (Array.isArray(v) ? v.filter(Boolean) : v && typeof v === 'object' ? Object.values(v) : []);

async function loadAllSeats(force = false) {
  if (!force && Date.now() - seatCache.at < SEAT_CACHE_MS) return seatCache.byScreen;

  const byScreen = new Map();
  for (const sc of await readAll('screens')) {
    const seats = asList(sc.seats).map((x) => ({ ...x, screen_id: Number(sc.id) }));
    byScreen.set(Number(sc.id), sortSeats(seats));
  }
  seatCache = { at: Date.now(), byScreen };
  return byScreen;
}

const invalidateSeats = () => { seatCache = { at: 0, byScreen: new Map() }; };

const listSeats = async (screenId) => (await loadAllSeats()).get(Number(screenId)) || [];

async function seatCountsByScreen() {
  const byScreen = await loadAllSeats();
  return new Map([...byScreen].map(([id, list]) => [id, list.filter((x) => !x.disabled).length]));
}

const stripScreenId = (list) => list.map(({ screen_id, ...rest }) => rest);

async function setSeatsDisabled(seatIds, disabled) {
  const wanted = new Set(seatIds.map(Number));
  const byScreen = await loadAllSeats(true);
  const updates = {};

  for (const [screenId, list] of byScreen) {
    if (!list.some((x) => wanted.has(Number(x.id)))) continue;
    const next = list.map((x) => (wanted.has(Number(x.id)) ? { ...x, disabled: disabled ? 1 : 0 } : x));
    updates[`screens/${screenId}/seats`] = clean(stripScreenId(next));
  }

  if (Object.keys(updates).length) await ref('/').update(updates);
  invalidateSeats();
}

async function replaceSeats(screenId, layout) {
  const ROW_LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const seats = [];
  let seatId = await nextId('seats');
  let r = 0;

  for (const tier of layout.tiers) {
    for (let i = 0; i < tier.rows; i++, r++) {
      for (let c = 1; c <= layout.cols; c++) {
        seats.push({
          id: seatId++, row_label: ROW_LABELS[r], seat_no: c,
          seat_type: tier.type, price_multiplier: layout.mult[tier.type], disabled: 0,
        });
      }
    }
  }

  await ref('_meta/counters/seats').set(seatId);
  await ref(`screens/${screenId}/seats`).set(clean(seats));
  invalidateSeats();
  return seats.length;
}

async function createScreen(cinemaId, name, layout) {
  const id = await nextId('screens');
  await writeOne('screens', id, {
    cinema_id: Number(cinemaId), name, row_count: layout.rows, col_count: layout.cols,
  });
  await replaceSeats(id, layout);
  return { id, cinema_id: Number(cinemaId), name, row_count: layout.rows, col_count: layout.cols };
}

async function updateScreen(id, patch) {
  await mergeOne('screens', id, patch);
  return getScreen(id);
}

async function deleteScreen(id) {
  for (const s of await showsForScreen(id)) await deleteShow(s.id);
  await removeOne('screens', id);          // its seats live inside that record
  invalidateSeats();
}

/**
 * True when any seat on this screen is sold or held.
 * Pass pre-fetched maps when checking several screens, so this stays one read.
 */
async function screenIsInUse(screenId, shows = null, taken = null) {
  const showList = shows || (await showsForScreen(screenId));
  const takenMap = taken || (await allTakenSeats());
  return showList
    .filter((s) => Number(s.screen_id) === Number(screenId))
    .some((s) => Object.keys(takenMap.get(Number(s.id)) || {}).length > 0);
}

/* =========================================================
   shows
   ========================================================= */

const listShows = () => readAll('shows');
const getShow = (id) => readOne('shows', id);

const showsForMovie = async (movieId) =>
  (await readAll('shows')).filter((s) => Number(s.movie_id) === Number(movieId));

const showsForScreen = async (screenId) =>
  (await readAll('shows')).filter((s) => Number(s.screen_id) === Number(screenId));

async function createShow(data) {
  const id = await nextId('shows');
  await writeOne('shows', id, data);
  return { id, ...data };
}

async function updateShow(id, data) {
  if (!(await readOne('shows', id))) return null;
  await mergeOne('shows', id, data);
  return readOne('shows', id);
}

async function deleteShow(id) {
  await removeOne('showSeats', id);
  await removeOne('shows', id);
}

/** { seatId: bookingId } for a show. */
async function takenSeats(showId) {
  const snap = await ref(`showSeats/${showId}/taken`).get();
  return snap.val() || {};
}

/** showId -> { seatId: bookingId }, in one read. */
async function allTakenSeats() {
  const snap = await ref('showSeats').get();
  const val = snap.val() || {};
  return new Map(Object.entries(val).map(([showId, v]) => [numOrStr(showId), (v && v.taken) || {}]));
}

/* =========================================================
   bookings
   ========================================================= */

const getBooking = async (id) => {
  const b = await readOne('bookings', id);
  if (b) b.seats = asList(b.seats);
  return b;
};

const listBookings = async () =>
  (await readAll('bookings')).map((b) => ({ ...b, seats: asList(b.seats) }));

const bookingsForUser = async (userId) =>
  (await listBookings()).filter((b) => Number(b.user_id) === Number(userId));

/**
 * Reserves seats. This is the double-booking guard: the show's `taken` map is
 * claimed with a Realtime Database transaction, which is an atomic
 * compare-and-set that retries on contention. Two simultaneous requests for the
 * same seat cannot both succeed - the loser re-runs, sees the seat taken and
 * aborts.
 */
async function holdSeats({ userId, show, seats, holdMinutes, bookingRef }) {
  const bookingId = await nextId('bookings');

  const priced = seats.map((s) => ({
    seat_id: Number(s.id),
    label: `${s.row_label}${s.seat_no}`,
    seat_type: s.seat_type,
    price: Math.round(show.base_price * s.price_multiplier),
  }));
  const money = require('./payments').priceBooking(priced.map((s) => s.price));

  const booking = {
    booking_ref: bookingRef,
    user_id: Number(userId),
    show_id: Number(show.id),
    ...money,
    promo_code: null,
    seats: priced,
    seats_snapshot: priced.map((s) => s.label).join(', '),
    status: 'PENDING',
    expires_at: now(holdMinutes),
    created_at: now(),
  };

  const result = await ref(`showSeats/${show.id}/taken`).transaction((current) => {
    const taken = current || {};
    for (const s of priced) if (taken[s.seat_id]) return undefined;   // abort: already claimed
    const next = { ...taken };
    for (const s of priced) next[s.seat_id] = bookingId;
    return next;
  });

  if (!result.committed) {
    const err = new Error('SEAT_TAKEN');
    err.code = 'SEAT_TAKEN';
    throw err;
  }

  try {
    await ref(`showSeats/${show.id}/show_id`).set(Number(show.id));
    await writeOne('bookings', bookingId, booking);
  } catch (err) {
    // Never leave seats claimed by a booking that failed to save.
    await releaseSeatsOf(bookingId, show.id);
    throw err;
  }

  return { id: bookingId, ...booking };
}

/** Removes every seat claimed by one booking from a show's `taken` map. */
async function releaseSeatsOf(bookingId, showId) {
  await ref(`showSeats/${showId}/taken`).transaction((current) => {
    if (!current) return current;
    const next = {};
    for (const [seatId, owner] of Object.entries(current)) {
      if (Number(owner) !== Number(bookingId)) next[seatId] = owner;
    }
    return Object.keys(next).length ? next : null;
  });
}

async function releaseBooking(bookingId, showId, patch) {
  await releaseSeatsOf(bookingId, showId);
  await mergeOne('bookings', bookingId, patch);
}

const updateBooking = (id, patch) => mergeOne('bookings', id, patch);

/** Frees seats held by PENDING bookings whose timer ran out. */
async function releaseExpiredHolds() {
  const stamp = now();
  let freed = 0;
  for (const b of await listBookings()) {
    if (b.status === 'PENDING' && b.expires_at && b.expires_at < stamp) {
      await releaseBooking(b.id, b.show_id, { status: 'EXPIRED', expires_at: null });
      freed++;
    }
  }
  return freed;
}

/* =========================================================
   payments, reviews, promos
   ========================================================= */

async function createPayment(data) {
  const id = await nextId('payments');
  await writeOne('payments', id, data);
  return { id, ...data };
}

const listPayments = () => readAll('payments');

const paymentForBooking = async (bookingId) =>
  (await readAll('payments')).find((p) => Number(p.booking_id) === Number(bookingId)) || null;

async function refundPayments(bookingId) {
  const updates = {};
  for (const p of await readAll('payments')) {
    if (Number(p.booking_id) === Number(bookingId)) updates[`payments/${p.id}/status`] = 'REFUNDED';
  }
  if (Object.keys(updates).length) await ref('/').update(updates);
}

const listReviews = async (movieId) =>
  (await readAll('reviews'))
    .filter((r) => Number(r.movie_id) === Number(movieId))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

/** The key gives "one review per user per movie" for free. */
const upsertReview = (movieId, userId, data) =>
  writeOne('reviews', `${movieId}_${userId}`, {
    movie_id: Number(movieId), user_id: Number(userId), ...data, created_at: now(),
  });

/** The key is the code, so codes are unique without a constraint. */
const getPromo = (code) => readOne('promos', String(code).toUpperCase());
const listPromos = () => readAll('promos');
const setPromo = (code, data) => writeOne('promos', String(code).toUpperCase(), data);
const deletePromo = (code) => removeOne('promos', String(code).toUpperCase());


/** Used when a show is deleted: a booking with no show has nothing to show. */
async function deleteBooking(id) {
  const b = await readOne('bookings', id);
  if (b) await releaseSeatsOf(id, b.show_id);
  await removeOne('bookings', id);
  const payments = (await readAll('payments')).filter((p) => Number(p.booking_id) === Number(id));
  for (const p of payments) await removeOne('payments', p.id);
}

module.exports = {
  now, nextId, batchWrite,
  findUserByEmail, findUserById, createUser, updateUser, listUsersRaw, deleteUser,
  saveResetToken, getResetToken, consumeResetToken,
  listMovies, getMovie, listMoviesRaw, createMovie, updateMovie, deleteMovie, attachRatings, popularMovies,
  listCinemas, getCinema, createCinema, updateCinema, deleteCinema,
  listScreens, listAllScreens, getScreen, createScreen, updateScreen, deleteScreen,
  listSeats, replaceSeats, screenIsInUse, seatCountsByScreen, allTakenSeats, invalidateSeats, setSeatsDisabled,
  listShows, getShow, showsForMovie, showsForScreen, createShow, updateShow, deleteShow, takenSeats,
  getBooking, listBookings, bookingsForUser, holdSeats, deleteBooking, releaseBooking, updateBooking, releaseExpiredHolds,
  createPayment, paymentForBooking, refundPayments, listPayments,
  listReviews, upsertReview,
  getPromo, listPromos, setPromo, deletePromo,
};

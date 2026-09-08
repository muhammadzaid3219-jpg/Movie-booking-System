'use strict';
/**
 * Firestore data layer.
 *
 * Firestore has no UNIQUE constraint, so uniqueness is enforced two ways:
 *   - document IDs        promos/{CODE}, reviews/{movieId}_{userId}
 *   - transactions        showSeats/{showId} holds every taken seat and is only
 *                         ever written inside runTransaction(), which is what
 *                         stops two people buying the same seat.
 */
const F = require('./firestore');

const fs = () => F.db();
const col = (name) => fs().collection(name);

/* ---------- helpers ---------- */

const withId = (doc) => (doc.exists ? { id: numOrStr(doc.id), ...doc.data() } : null);
const allOf = (snap) => snap.docs.map((d) => ({ id: numOrStr(d.id), ...d.data() }));
const numOrStr = (id) => (/^\d+$/.test(id) ? Number(id) : id);

/** Local wall-clock 'YYYY-MM-DD HH:MM:SS', matching how show times are stored. */
function now(offsetMinutes = 0) {
  const d = new Date(Date.now() + offsetMinutes * 60_000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Auto-increment IDs, so documents keep the same numeric keys the app already uses. */
async function nextId(name) {
  const ref = fs().doc('_meta/counters');
  return fs().runTransaction(async (t) => {
    const snap = await t.get(ref);
    const counters = snap.exists ? snap.data() : {};
    const id = counters[name] || 1;
    t.set(ref, { ...counters, [name]: id + 1 });
    return id;
  });
}

/* =========================================================
   users
   ========================================================= */

async function findUserByEmail(email) {
  const snap = await col('users').where('email', '==', String(email).toLowerCase()).limit(1).get();
  return snap.empty ? null : { id: numOrStr(snap.docs[0].id), ...snap.docs[0].data() };
}

const findUserById = async (id) => withId(await col('users').doc(String(id)).get());

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
  await col('users').doc(String(id)).set(user);
  return { id, ...user };
}

const updateUser = (id, patch) => col('users').doc(String(id)).set(patch, { merge: true });
const listUsersRaw = async () => allOf(await col('users').get());
const deleteUser = (id) => col('users').doc(String(id)).delete();

/* ---------- password resets ---------- */

const saveResetToken = (token, userId, expiresAt) =>
  col('passwordResets').doc(token).set({ user_id: Number(userId), expires_at: expiresAt, used: 0, created_at: now() });

const getResetToken = async (token) => withId(await col('passwordResets').doc(String(token)).get());
const consumeResetToken = (token) => col('passwordResets').doc(String(token)).set({ used: 1 }, { merge: true });

/* =========================================================
   movies
   ========================================================= */

async function listMovies({ search = '', genre = '', language = '', status = '', sort = '' } = {}) {
  // Firestore has no LIKE, so the catalog is filtered in memory.
  // Fine for a cinema-sized catalog; swap in Algolia if it ever grows.
  let movies = allOf(await col('movies').get()).filter((m) => m.status !== 'archived');

  const q = search.trim().toLowerCase();
  if (q) movies = movies.filter((m) =>
    (m.title || '').toLowerCase().includes(q) || (m.genre || '').toLowerCase().includes(q));
  if (genre) movies = movies.filter((m) => (m.genre || '').toLowerCase().includes(genre.toLowerCase()));
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
  const movies = (await listMovies({ status: 'now_showing' }));
  return movies
    .slice()
    .sort((a, b) => (b.review_count || 0) - (a.review_count || 0) || (b.avg_rating || 0) - (a.avg_rating || 0))
    .slice(0, limit);
}

async function attachRatings(movies) {
  if (!movies.length) return movies;
  const reviews = allOf(await col('reviews').get());
  for (const m of movies) {
    const mine = reviews.filter((r) => Number(r.movie_id) === Number(m.id));
    m.review_count = mine.length;
    m.avg_rating = mine.length
      ? Math.round((mine.reduce((s, r) => s + r.rating, 0) / mine.length) * 10) / 10
      : null;
  }
  return movies;
}

async function getMovie(id) {
  const movie = withId(await col('movies').doc(String(id)).get());
  if (!movie) return null;
  await attachRatings([movie]);
  return movie;
}

const listMoviesRaw = async () => allOf(await col('movies').get());

async function createMovie(data) {
  const id = await nextId('movies');
  const movie = { ...data, created_at: now() };
  await col('movies').doc(String(id)).set(movie);
  return { id, ...movie };
}

async function updateMovie(id, data) {
  const ref = col('movies').doc(String(id));
  if (!(await ref.get()).exists) return null;
  await ref.set(data, { merge: true });
  return withId(await ref.get());
}

const deleteMovie = (id) => col('movies').doc(String(id)).delete();

/* =========================================================
   cinemas, screens, seats
   ========================================================= */

const listCinemas = async () => allOf(await col('cinemas').get());
const getCinema = async (id) => withId(await col('cinemas').doc(String(id)).get());

async function createCinema(data) {
  const id = await nextId('cinemas');
  await col('cinemas').doc(String(id)).set(data);
  return { id, ...data };
}

async function updateCinema(id, data) {
  const ref = col('cinemas').doc(String(id));
  if (!(await ref.get()).exists) return null;
  await ref.set(data, { merge: true });
  return withId(await ref.get());
}

/** Deletes a cinema and everything under it. */
async function deleteCinema(id) {
  const screens = await listScreens(id);
  for (const s of screens) await deleteScreen(s.id);
  await col('cinemas').doc(String(id)).delete();
}

const listScreens = async (cinemaId) =>
  allOf(await col('screens').where('cinema_id', '==', Number(cinemaId)).get());

const listAllScreens = async () => allOf(await col('screens').get());
const getScreen = async (id) => withId(await col('screens').doc(String(id)).get());

/**
 * Seats live INSIDE their screen document, as a `seats` array - not as one
 * document each.
 *
 * The original design gave every seat its own document, so building a seat map
 * meant reading ~766 documents. That is what exhausted the Firestore free tier's
 * 50,000 reads a day. A screen's whole seat plan is a few kilobytes, far under
 * the 1 MiB document limit, so the entire estate now costs one read per screen.
 *
 * Seat ids are preserved exactly, so existing bookings keep pointing at the
 * right seats.
 */
const SEAT_CACHE_MS = 10 * 60_000;
let seatCache = { at: 0, byScreen: new Map() };

const sortSeats = (list) =>
  list.sort((a, b) => String(a.row_label).localeCompare(String(b.row_label)) || a.seat_no - b.seat_no);

async function loadAllSeats(force = false) {
  if (!force && Date.now() - seatCache.at < SEAT_CACHE_MS) return seatCache.byScreen;

  const byScreen = new Map();
  const screens = allOf(await col('screens').get());          // one read per screen
  let legacy = [];

  for (const sc of screens) {
    if (Array.isArray(sc.seats)) {
      byScreen.set(Number(sc.id), sortSeats(sc.seats.map((x) => ({ ...x, screen_id: Number(sc.id) }))));
    } else {
      legacy.push(Number(sc.id));                             // written by an older migration
    }
  }

  // Fall back to the old per-document layout only for screens not yet converted.
  if (legacy.length) {
    for (const seat of allOf(await col('seats').get())) {
      const key = Number(seat.screen_id);
      if (!legacy.includes(key)) continue;
      if (!byScreen.has(key)) byScreen.set(key, []);
      byScreen.get(key).push(seat);
    }
    for (const key of legacy) if (byScreen.has(key)) sortSeats(byScreen.get(key));
  }

  seatCache = { at: Date.now(), byScreen };
  return byScreen;
}

const invalidateSeats = () => { seatCache = { at: 0, byScreen: new Map() }; };

const listSeats = async (screenId) => (await loadAllSeats()).get(Number(screenId)) || [];

/** screenId -> number of bookable (not out-of-service) seats. */
async function seatCountsByScreen() {
  const byScreen = await loadAllSeats();
  return new Map([...byScreen].map(([id, list]) => [id, list.filter((x) => !x.disabled).length]));
}

/** Marks individual seats in or out of service, on whichever screens they belong to. */
async function setSeatsDisabled(seatIds, disabled) {
  const wanted = new Set(seatIds.map(Number));
  const byScreen = await loadAllSeats(true);
  const writes = [];

  for (const [screenId, list] of byScreen) {
    if (!list.some((x) => wanted.has(Number(x.id)))) continue;
    const next = list.map((x) => (wanted.has(Number(x.id)) ? { ...x, disabled: disabled ? 1 : 0 } : x));
    writes.push({ ref: col('screens').doc(String(screenId)), data: { seats: stripScreenId(next) }, merge: true });
  }

  await batchWrite(writes);
  invalidateSeats();
}

/** screen_id is implied by the parent document, so it is not stored per seat. */
const stripScreenId = (list) => list.map(({ screen_id, ...rest }) => rest);

/** showId -> { seatId: bookingId }, in a single read. */
async function allTakenSeats() {
  const map = new Map();
  for (const doc of (await col('showSeats').get()).docs) {
    map.set(numOrStr(doc.id), doc.data().taken || {});
  }
  return map;
}

/** Writes documents in chunks, staying under Firestore's 500-per-batch limit. */
async function batchWrite(ops) {
  for (let i = 0; i < ops.length; i += 450) {
    const batch = fs().batch();
    for (const op of ops.slice(i, i + 450)) {
      if (op.delete) batch.delete(op.ref);
      else batch.set(op.ref, op.data, op.merge ? { merge: true } : undefined);
    }
    await batch.commit();
  }
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

  await fs().doc('_meta/counters').set({ seats: seatId }, { merge: true });
  await col('screens').doc(String(screenId)).set({ seats }, { merge: true });
  invalidateSeats();
  return seats.length;
}

async function createScreen(cinemaId, name, layout) {
  const id = await nextId('screens');
  await col('screens').doc(String(id)).set({
    cinema_id: Number(cinemaId), name, row_count: layout.rows, col_count: layout.cols,
  });
  await replaceSeats(id, layout);
  return { id, cinema_id: Number(cinemaId), name, row_count: layout.rows, col_count: layout.cols };
}

async function updateScreen(id, patch) {
  await col('screens').doc(String(id)).set(patch, { merge: true });
  return getScreen(id);
}

async function deleteScreen(id) {
  const shows = await col('shows').where('screen_id', '==', Number(id)).get();
  for (const s of shows.docs) await deleteShow(numOrStr(s.id));

  await col('screens').doc(String(id)).delete();   // its seats live inside that document
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

const listShows = async () => allOf(await col('shows').get());
const getShow = async (id) => withId(await col('shows').doc(String(id)).get());

const showsForMovie = async (movieId) =>
  allOf(await col('shows').where('movie_id', '==', Number(movieId)).get());

const showsForScreen = async (screenId) =>
  allOf(await col('shows').where('screen_id', '==', Number(screenId)).get());

async function createShow(data) {
  const id = await nextId('shows');
  await col('shows').doc(String(id)).set(data);
  return { id, ...data };
}

async function updateShow(id, data) {
  const ref = col('shows').doc(String(id));
  if (!(await ref.get()).exists) return null;
  await ref.set(data, { merge: true });
  return withId(await ref.get());
}

async function deleteShow(id) {
  await col('showSeats').doc(String(id)).delete();
  await col('shows').doc(String(id)).delete();
}

/** { seatId: bookingId } for a show. */
async function takenSeats(showId) {
  const doc = await col('showSeats').doc(String(showId)).get();
  return doc.exists ? (doc.data().taken || {}) : {};
}

/* =========================================================
   bookings
   ========================================================= */

const getBooking = async (id) => withId(await col('bookings').doc(String(id)).get());
const listBookings = async () => allOf(await col('bookings').get());

const bookingsForUser = async (userId) =>
  allOf(await col('bookings').where('user_id', '==', Number(userId)).get());

/**
 * Reserves seats for eight minutes. This is the double-booking guard:
 * showSeats/{showId} is read and written inside one transaction, so two
 * simultaneous requests for the same seat cannot both succeed - Firestore
 * retries the loser, which then sees the seat as taken.
 */
async function holdSeats({ userId, show, seats, holdMinutes, bookingRef }) {
  const bookingId = await nextId('bookings');
  const seatRef = col('showSeats').doc(String(show.id));
  const bookRef = col('bookings').doc(String(bookingId));

  const priced = seats.map((s) => ({
    seat_id: Number(s.id),
    label: `${s.row_label}${s.seat_no}`,
    seat_type: s.seat_type,
    price: Math.round(show.base_price * s.price_multiplier),
  }));
  // Fees are computed here so the summary shows the true total from the start.
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

  await fs().runTransaction(async (t) => {
    const snap = await t.get(seatRef);
    const taken = snap.exists ? { ...(snap.data().taken || {}) } : {};

    for (const s of priced) {
      if (taken[s.seat_id]) {
        const err = new Error('SEAT_TAKEN');
        err.code = 'SEAT_TAKEN';
        throw err;
      }
    }
    for (const s of priced) taken[s.seat_id] = bookingId;

    t.set(seatRef, { show_id: Number(show.id), taken }, { merge: true });
    t.set(bookRef, booking);
  });

  return { id: bookingId, ...booking };
}

/** Removes this booking's seats from the show, then applies the status change. */
async function releaseBooking(bookingId, showId, patch) {
  const seatRef = col('showSeats').doc(String(showId));
  const bookRef = col('bookings').doc(String(bookingId));

  await fs().runTransaction(async (t) => {
    const snap = await t.get(seatRef);
    if (snap.exists) {
      const taken = { ...(snap.data().taken || {}) };
      for (const [seatId, owner] of Object.entries(taken)) {
        if (Number(owner) === Number(bookingId)) delete taken[seatId];
      }
      t.set(seatRef, { taken }, { merge: false });
    }
    t.set(bookRef, patch, { merge: true });
  });
}

const updateBooking = (id, patch) => col('bookings').doc(String(id)).set(patch, { merge: true });

/** Frees seats held by PENDING bookings whose timer ran out. */
async function releaseExpiredHolds() {
  const snap = await col('bookings').where('status', '==', 'PENDING').get();
  const stamp = now();
  let freed = 0;
  for (const doc of snap.docs) {
    const b = doc.data();
    if (b.expires_at && b.expires_at < stamp) {
      await releaseBooking(numOrStr(doc.id), b.show_id, { status: 'EXPIRED', expires_at: null });
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
  await col('payments').doc(String(id)).set(data);
  return { id, ...data };
}

const paymentForBooking = async (bookingId) => {
  const snap = await col('payments').where('booking_id', '==', Number(bookingId)).limit(1).get();
  return snap.empty ? null : { id: numOrStr(snap.docs[0].id), ...snap.docs[0].data() };
};

async function refundPayments(bookingId) {
  const snap = await col('payments').where('booking_id', '==', Number(bookingId)).get();
  await batchWrite(snap.docs.map((d) => ({ ref: d.ref, data: { ...d.data(), status: 'REFUNDED' } })));
}

const listPayments = async () => allOf(await col('payments').get());

const listReviews = async (movieId) => {
  const reviews = allOf(await col('reviews').where('movie_id', '==', Number(movieId)).get());
  reviews.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return reviews;
};

/** Document ID gives "one review per user per movie" for free. */
const upsertReview = (movieId, userId, data) =>
  col('reviews').doc(`${movieId}_${userId}`).set(
    { movie_id: Number(movieId), user_id: Number(userId), ...data, created_at: now() },
    { merge: true }
  );

/** Document ID is the code, so codes are unique without a constraint. */
const getPromo = async (code) =>
  withId(await col('promos').doc(String(code).toUpperCase()).get());

const listPromos = async () => allOf(await col('promos').get());
const setPromo = (code, data) => col('promos').doc(String(code).toUpperCase()).set(data);
const deletePromo = (code) => col('promos').doc(String(code).toUpperCase()).delete();


/** Used when a show is deleted: a booking with no show has nothing to show. */
async function deleteBooking(id) {
  const b = await getBooking(id);
  if (b) await releaseBooking(id, b.show_id, {});
  await col('bookings').doc(String(id)).delete();
  const snap = await col('payments').where('booking_id', '==', Number(id)).get();
  await batchWrite(snap.docs.map((d) => ({ ref: d.ref, delete: true })));
}

module.exports = {
  now, nextId, batchWrite,
  findUserByEmail, findUserById, createUser, updateUser, listUsersRaw, deleteUser,
  listMovies, getMovie, listMoviesRaw, createMovie, updateMovie, deleteMovie, attachRatings,
  listCinemas, getCinema, createCinema, updateCinema, deleteCinema,
  listScreens, listAllScreens, getScreen, createScreen, updateScreen, deleteScreen,
  listSeats, replaceSeats, screenIsInUse, seatCountsByScreen, allTakenSeats, invalidateSeats, setSeatsDisabled,
  saveResetToken, getResetToken, consumeResetToken, popularMovies,
  listShows, getShow, showsForMovie, showsForScreen, createShow, updateShow, deleteShow, takenSeats,
  getBooking, listBookings, bookingsForUser, holdSeats, deleteBooking, releaseBooking, updateBooking, releaseExpiredHolds,
  createPayment, paymentForBooking, refundPayments, listPayments,
  listReviews, upsertReview,
  getPromo, listPromos, setPromo, deletePromo,
};

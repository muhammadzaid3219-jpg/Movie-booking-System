'use strict';
/**
 * Copies everything from the SQLite database into Firestore:  npm run migrate
 *
 * Document IDs are chosen so that Firestore's "one document per ID" rule
 * replaces the UNIQUE constraints SQLite was enforcing:
 *
 *   promos/{CODE}                  -> one promo per code
 *   reviews/{movieId}_{userId}     -> one review per user per movie
 *   showSeats/{showId}             -> holds every taken seat for a show,
 *                                     written only inside a transaction,
 *                                     which is what stops double booking
 *
 * Re-running is safe: documents are overwritten, not duplicated.
 */
const { db: sqlite } = require('./db');
const F = require('./firestore');
const R = require('./rtdb');
const config = require('./config');

const RESET = process.argv.includes('--reset');

/** --target overrides DB_DRIVER, so you can seed either cloud database. */
const argTarget = (process.argv.find((a) => a.startsWith('--target=')) || '').split('=')[1];
const TARGET = argTarget || (config.driver === 'rtdb' ? 'rtdb' : 'firestore');

const rows = (sql, ...p) => sqlite.prepare(sql).all(...p);

/** Firestore allows 500 writes per batch. */
async function writeAll(fs, collection, docs, idOf) {
  let written = 0;
  for (let i = 0; i < docs.length; i += 450) {
    const batch = fs.batch();
    for (const doc of docs.slice(i, i + 450)) {
      batch.set(fs.collection(collection).doc(String(idOf(doc))), doc);
    }
    await batch.commit();
    written += Math.min(450, docs.length - i);
    process.stdout.write(`\r  ${collection}: ${written}/${docs.length}   `);
  }
  console.log(`\r  ${collection}: ${docs.length} document(s)          `);
  return docs.length;
}

async function clearCollection(fs, name) {
  const snap = await fs.collection(name).limit(450).get();
  if (snap.empty) return 0;
  const batch = fs.batch();
  snap.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
  return snap.size + (await clearCollection(fs, name));
}

const COLLECTIONS = ['movies', 'cinemas', 'screens', 'seats', 'shows',
  'users', 'bookings', 'showSeats', 'payments', 'reviews', 'promos', 'passwordResets'];

/* ---------------- Realtime Database target ---------------- */

/**
 * Realtime Database is one JSON tree, so the whole dataset is assembled in
 * memory and written node by node. Keys mirror the Firestore document ids,
 * which is what keeps the two cloud data layers interchangeable.
 */
async function migrateToRtdb() {
  const rtdb = R.db();
  console.log('\nMigrating SQLite -> Realtime Database');
  console.log('  ' + R.databaseURL() + '\n');

  const keyBy = (list, idOf) => Object.fromEntries(list.map((x) => [String(idOf(x)), x]));

  const screens = rows('SELECT * FROM screens').map((sc) => ({
    ...sc,
    seats: rows(
      'SELECT id, row_label, seat_no, seat_type, price_multiplier, disabled' +
      '  FROM seats WHERE screen_id = ? ORDER BY row_label, seat_no', sc.id),
  }));

  const bookings = rows('SELECT * FROM bookings').map((b) => ({
    ...b,
    seats: rows(
      'SELECT bs.seat_id, bs.price, st.row_label || st.seat_no AS label, st.seat_type' +
      '  FROM booking_seats bs JOIN seats st ON st.id = bs.seat_id' +
      ' WHERE bs.booking_id = ?', b.id),
  }));

  const taken = {};
  for (const bs of rows('SELECT show_id, seat_id, booking_id FROM booking_seats')) {
    (taken[bs.show_id] ||= {})[bs.seat_id] = bs.booking_id;
  }

  const nextId = (t) => sqlite.prepare('SELECT IFNULL(MAX(id), 0) + 1 AS v FROM ' + t).get().v;
  const counters = {};
  for (const t of ['movies', 'cinemas', 'screens', 'seats', 'shows', 'users', 'bookings', 'payments', 'promos']) {
    counters[t] = nextId(t);
  }

  const tree = {
    movies: keyBy(rows('SELECT * FROM movies'), (m) => m.id),
    cinemas: keyBy(rows('SELECT * FROM cinemas'), (c) => c.id),
    screens: keyBy(screens, (s) => s.id),
    shows: keyBy(rows('SELECT * FROM shows'), (s) => s.id),
    users: keyBy(rows('SELECT * FROM users'), (u) => u.id),
    payments: keyBy(rows('SELECT * FROM payments'), (p) => p.id),
    bookings: keyBy(bookings, (b) => b.id),
    showSeats: Object.fromEntries(Object.entries(taken)
      .map(([showId, seats]) => [showId, { show_id: Number(showId), taken: seats }])),
    reviews: keyBy(rows('SELECT * FROM reviews'), (r) => r.movie_id + '_' + r.user_id),
    promos: keyBy(rows('SELECT * FROM promos'), (p) => p.code.toUpperCase()),
    _meta: { counters },
  };

  /* Realtime Database rejects undefined and treats null as "delete this key". */
  const clean = (v) => {
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) if (val !== undefined) out[k] = clean(val);
      return out;
    }
    return v === undefined ? null : v;
  };

  if (RESET) {
    console.log('Clearing the tree...');
    for (const k of [...Object.keys(tree), 'passwordResets']) await rtdb.ref(k).remove();
    console.log('');
  }

  for (const [name, node] of Object.entries(tree)) {
    await rtdb.ref(name).update(clean(node));
    console.log('  ' + name + ': ' + Object.keys(node).length +
                (name === '_meta' ? ' node(s)' : ' record(s)'));
  }
  console.log('  seats: ' + screens.reduce((n, s) => n + s.seats.length, 0) +
              ' embedded in ' + screens.length + ' screen record(s)');

  console.log('\nMigration complete.\n');
  process.exit(0);
}

(async () => {
  if (!F.isConfigured()) {
    console.error('\nNo Firebase key found. Run "npm run firebase:check" first.\n');
    process.exit(1);
  }

  if (TARGET === 'rtdb') return migrateToRtdb();

  const fs = F.db();
  console.log(`\nMigrating SQLite -> Firestore (project: ${F.projectId()})\n`);

  if (RESET) {
    console.log('Clearing existing collections...');
    for (const c of COLLECTIONS) {
      const n = await clearCollection(fs, c);
      if (n) console.log(`  cleared ${c}: ${n}`);
    }
    console.log('');
  }

  /* ---- straightforward tables ---- */

  await writeAll(fs, 'movies', rows('SELECT * FROM movies'), (m) => m.id);
  await writeAll(fs, 'cinemas', rows('SELECT * FROM cinemas'), (c) => c.id);
  // Seats are embedded in their screen document rather than written one-by-one:
  // a seat map then costs one read instead of ~766.
  const screens = rows('SELECT * FROM screens').map((sc) => ({
    ...sc,
    seats: rows(`
      SELECT id, row_label, seat_no, seat_type, price_multiplier, disabled
        FROM seats WHERE screen_id = ? ORDER BY row_label, seat_no`, sc.id),
  }));
  await writeAll(fs, 'screens', screens, (s) => s.id);
  console.log(`  seats: ${screens.reduce((n, s) => n + s.seats.length, 0)} embedded in ${screens.length} screen document(s)`);
  await writeAll(fs, 'shows', rows('SELECT * FROM shows'), (s) => s.id);
  await writeAll(fs, 'payments', rows('SELECT * FROM payments'), (p) => p.id);

  /* ---- users: password hashes carry over, so existing logins keep working ---- */
  await writeAll(fs, 'users', rows('SELECT * FROM users'), (u) => u.id);

  /* ---- bookings: seats are embedded so a ticket is one read ---- */
  const bookings = rows('SELECT * FROM bookings').map((b) => ({
    ...b,
    seats: rows(`
      SELECT bs.seat_id, bs.price, st.row_label || st.seat_no AS label, st.seat_type
        FROM booking_seats bs JOIN seats st ON st.id = bs.seat_id
       WHERE bs.booking_id = ?`, b.id),
  }));
  await writeAll(fs, 'bookings', bookings, (b) => b.id);

  /* ---- showSeats: the double-booking guard ---- */
  const taken = {};
  for (const bs of rows('SELECT show_id, seat_id, booking_id FROM booking_seats')) {
    (taken[bs.show_id] ||= {})[bs.seat_id] = bs.booking_id;
  }
  const showSeats = Object.entries(taken).map(([showId, seats]) => ({ show_id: Number(showId), taken: seats }));
  await writeAll(fs, 'showSeats', showSeats, (s) => s.show_id);

  /* ---- ID-enforced uniqueness ---- */
  await writeAll(fs, 'reviews', rows('SELECT * FROM reviews'), (r) => `${r.movie_id}_${r.user_id}`);
  await writeAll(fs, 'promos', rows('SELECT * FROM promos'), (p) => p.code.toUpperCase());

  /* ---- counters, so new records do not collide with migrated IDs ---- */
  const nextId = (table) => (sqlite.prepare(`SELECT IFNULL(MAX(id), 0) + 1 AS v FROM ${table}`).get().v);
  // 'seats' is no longer its own collection, but the counter still hands out seat ids.
  const counters = {};
  for (const t of ['movies', 'cinemas', 'screens', 'seats', 'shows', 'users', 'bookings', 'payments', 'promos']) {
    counters[t] = nextId(t);
  }
  await fs.collection('_meta').doc('counters').set(counters);
  console.log('  _meta/counters:', JSON.stringify(counters));

  console.log('\nMigration complete.\n');
  process.exit(0);
})().catch((e) => {
  console.error('\nMigration failed:', e.message, '\n');
  process.exit(1);
});

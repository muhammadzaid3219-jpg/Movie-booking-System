'use strict';
/**
 * Empties the demo content so the system starts blank:  npm run clean
 *
 * Removes every movie, cinema, screen, seat, show, booking, payment, review and
 * promo code, plus the demo customer accounts. Keeps admin accounts, so you can
 * still sign in and add your own data.
 *
 *   npm run clean              cleans the database DB_DRIVER points at
 *   npm run clean -- --all     cleans SQLite and both Firebase databases
 *   npm run clean -- --keep-promos
 *
 * To get the demo data back:  npm run reset  (then npm run migrate / migrate:rtdb)
 */
const config = require('./config');

const args = process.argv.slice(2);
const ALL = args.includes('--all');
const KEEP_PROMOS = args.includes('--keep-promos');
const YES = args.includes('--yes') || args.includes('-y');

const CONTENT = ['bookings', 'payments', 'reviews', 'shows', 'showSeats',
                 'seats', 'screens', 'cinemas', 'movies', 'passwordResets'];

/* ---------------- SQLite ---------------- */

function cleanSqlite() {
  const { db, tx } = require('./db');
  const before = {};
  const count = (t) => db.prepare(`SELECT COUNT(*) AS v FROM ${t}`).get().v;

  for (const t of ['movies', 'cinemas', 'screens', 'seats', 'shows', 'bookings', 'users']) before[t] = count(t);

  tx(() => {
    db.exec('PRAGMA foreign_keys = OFF');
    const tables = ['payments', 'booking_seats', 'bookings', 'reviews', 'shows',
                    'seats', 'screens', 'cinemas', 'movies', 'password_resets'];
    if (!KEEP_PROMOS) tables.push('promos');

    for (const t of tables) {
      db.exec(`DELETE FROM ${t}`);
      db.exec(`DELETE FROM sqlite_sequence WHERE name = '${t}'`);
    }
    db.prepare(`DELETE FROM users WHERE role != 'admin'`).run();
    db.exec('PRAGMA foreign_keys = ON');
  });

  const admins = db.prepare(`SELECT name, email FROM users WHERE role = 'admin'`).all();
  return { before, admins };
}

/* ---------------- Realtime Database ---------------- */

async function cleanRtdb() {
  const R = require('./rtdb');
  const db = R.db();

  const snap = await db.ref('/').get();
  const tree = snap.val() || {};
  const before = Object.fromEntries(
    ['movies', 'cinemas', 'screens', 'shows', 'bookings', 'users']
      .map((k) => [k, Object.keys(tree[k] || {}).length])
  );

  const updates = {};
  for (const node of CONTENT) updates[node] = null;
  if (!KEEP_PROMOS) updates.promos = null;

  const admins = [];
  for (const [id, u] of Object.entries(tree.users || {})) {
    if (u.role === 'admin') admins.push({ name: u.name, email: u.email });
    else updates[`users/${id}`] = null;
  }

  /*
   * Counters restart at 1 so new records get clean ids. Users carry on past the
   * admins that survive. Written as one object: Realtime Database rejects an
   * update whose paths overlap.
   */
  const counters = Object.fromEntries(
    ['movies', 'cinemas', 'screens', 'seats', 'shows', 'bookings', 'payments', 'promos'].map((k) => [k, 1])
  );
  counters.users = Math.max(...Object.keys(tree.users || { 0: 1 }).map(Number).filter(Number.isFinite), 0) + 1;
  updates['_meta/counters'] = counters;

  await db.ref('/').update(updates);
  return { before, admins };
}

/* ---------------- Firestore ---------------- */

async function cleanFirestore() {
  const F = require('./firestore');
  const fs = F.db();

  const wipe = async (name) => {
    let removed = 0;
    for (;;) {
      const snap = await fs.collection(name).limit(400).get();
      if (snap.empty) return removed;
      const batch = fs.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      removed += snap.size;
    }
  };

  const before = {};
  for (const k of ['movies', 'cinemas', 'screens', 'shows', 'bookings', 'users']) {
    before[k] = (await fs.collection(k).count().get()).data().count;
  }

  for (const name of CONTENT) await wipe(name);
  if (!KEEP_PROMOS) await wipe('promos');

  const admins = [];
  const users = await fs.collection('users').get();
  const batch = fs.batch();
  for (const doc of users.docs) {
    const u = doc.data();
    if (u.role === 'admin') admins.push({ name: u.name, email: u.email });
    else batch.delete(doc.ref);
  }
  await batch.commit();

  await fs.doc('_meta/counters').set(Object.fromEntries(
    ['movies', 'cinemas', 'screens', 'seats', 'shows', 'bookings', 'payments', 'promos'].map((k) => [k, 1])
  ), { merge: true });

  return { before, admins };
}

/* ---------------- run ---------------- */

const CLEANERS = { sqlite: cleanSqlite, rtdb: cleanRtdb, firestore: cleanFirestore };

(async () => {
  const targets = ALL ? ['sqlite', 'rtdb', 'firestore'] : [config.driver];

  console.log(`\nClearing demo content from: ${targets.join(', ')}`);
  console.log(KEEP_PROMOS ? 'Promo codes will be kept.\n' : 'Promo codes will be removed too.\n');

  if (!YES) {
    console.log('This cannot be undone. Re-run with --yes to go ahead.');
    console.log('(To restore the demo data later: npm run reset, then npm run migrate:rtdb)\n');
    process.exit(0);
  }

  let failed = 0;
  for (const t of targets) {
    try {
      const { before, admins } = await CLEANERS[t]();
      const summary = Object.entries(before).map(([k, v]) => `${k} ${v}`).join(', ');
      console.log(`  ${t.padEnd(10)} cleared (was: ${summary})`);
      console.log(`  ${''.padEnd(10)} kept ${admins.length} admin account(s): ${admins.map((a) => a.email).join(', ') || 'none'}`);
      if (!admins.length) {
        console.log(`  ${''.padEnd(10)} WARNING: no admin account remains - you will not be able to sign in.`);
      }
    } catch (e) {
      failed++;
      console.log(`  ${t.padEnd(10)} FAILED: ${e.message.slice(0, 90)}`);
    }
  }

  if (failed) {
    console.log(`\n${failed} target(s) failed — nothing was cleared for those.\n`);
    process.exit(1);
  }

  console.log('\nDone. The site is now empty apart from your admin login.');
  console.log('Add a cinema and a screen first, then movies, then showtimes.\n');
  process.exit(0);
})();

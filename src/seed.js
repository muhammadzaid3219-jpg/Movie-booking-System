'use strict';
/**
 * Fills the SQLite database with realistic demo data.
 *   node src/seed.js           -> only seeds if the database is empty
 *   node src/seed.js --reset   -> wipes everything first
 *
 * Run `npm run migrate` afterwards to push the same data into Firestore.
 */
const { db, tx } = require('./db');
const { hashPassword } = require('./auth');
const { priceBooking } = require('./payments');
const crypto = require('node:crypto');

const RESET = process.argv.includes('--reset');
const SEAT_TYPE_MULTIPLIER = { SILVER: 1.0, GOLD: 1.5, RECLINER: 2.2 };
const ROW_LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

if (RESET) {
  db.exec('PRAGMA foreign_keys = OFF');
  for (const t of ['payments', 'booking_seats', 'bookings', 'reviews', 'shows', 'seats',
                   'screens', 'cinemas', 'movies', 'promos', 'password_resets', 'users']) {
    db.exec(`DELETE FROM ${t}`);
    db.exec(`DELETE FROM sqlite_sequence WHERE name = '${t}'`);
  }
  db.exec('PRAGMA foreign_keys = ON');
  console.log('Database cleared.');
}

if (db.prepare('SELECT COUNT(*) AS v FROM users').get().v > 0) {
  console.log('Database already has data. Use "npm run reset" to rebuild it.');
  process.exit(0);
}

/* ---------------- helpers ---------------- */

const pad = (n) => String(n).padStart(2, '0');
const dayOffset = (d) => {
  const t = new Date();
  t.setDate(t.getDate() + d);
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
};

function makeScreen(cinemaId, name, tiers, cols) {
  const rows = tiers.reduce((s, t) => s + t.rows, 0);
  const info = db.prepare('INSERT INTO screens (cinema_id, name, row_count, col_count) VALUES (?, ?, ?, ?)')
    .run(cinemaId, name, rows, cols);

  const ins = db.prepare(
    'INSERT INTO seats (screen_id, row_label, seat_no, seat_type, price_multiplier) VALUES (?, ?, ?, ?, ?)'
  );
  let r = 0;
  for (const tier of tiers) {
    for (let i = 0; i < tier.rows; i++, r++) {
      for (let c = 1; c <= cols; c++) {
        ins.run(info.lastInsertRowid, ROW_LABELS[r], c, tier.type, SEAT_TYPE_MULTIPLIER[tier.type]);
      }
    }
  }
  return Number(info.lastInsertRowid);
}

const tiers = (silver, gold, recliner) => [
  { type: 'SILVER', rows: silver }, { type: 'GOLD', rows: gold }, { type: 'RECLINER', rows: recliner },
];

/* ---------------- data ---------------- */

const MOVIES = [
  {
    title: 'Interstellar Dawn', genre: 'Sci-Fi, Adventure', language: 'English', duration_min: 148,
    certificate: 'U/A', poster: '#1f3a5f,#5b8fb9', banner: '#0d1c2e,#3d6d94',
    director: 'Amara Silva',
    cast: 'Daniel Roth, Priya Anand, Tom Weller, Nadia Qureshi',
    trailer: 'https://www.youtube.com/watch?v=zSWdZVtXT7E',
    description: 'When Earth\'s harvests begin to fail, a former pilot leads a crew through a newly discovered wormhole in search of a habitable world - and discovers that time itself is the cruellest obstacle.',
  },
  {
    title: 'Karachi Nights', genre: 'Thriller, Drama', language: 'Urdu', duration_min: 132,
    certificate: 'A', poster: '#3d1e4f,#a05fb4', banner: '#25102f,#6d3b80',
    director: 'Hassan Iqbal',
    cast: 'Sanam Zaidi, Bilal Ahmed, Rukhsana Malik, Faraz Sheikh',
    trailer: 'https://www.youtube.com/watch?v=BdJKm16Co6M',
    description: 'A tired detective on his final case chases a smuggling ring through the neon-lit streets of a city that never sleeps, only to find the trail leading back to his own department.',
  },
  {
    title: 'The Last Summit', genre: 'Action, Adventure', language: 'English', duration_min: 121,
    certificate: 'U/A', poster: '#123d2f,#3fa37a', banner: '#0a2a20,#2d7d5c',
    director: 'Erik Lindqvist',
    cast: 'Marcus Bell, Ayesha Noor, Jonas Frey, Lena Vogt',
    trailer: 'https://www.youtube.com/watch?v=6ZfuNTqbHE8',
    description: 'Two rival climbers who have spent a decade trying to beat each other must work together when a storm traps them three hundred metres below the summit of K2.',
  },
  {
    title: 'Chai Aur Cricket', genre: 'Comedy, Family', language: 'Urdu', duration_min: 118,
    certificate: 'U', poster: '#5a3211,#d99b52', banner: '#3a2109,#b57c3a',
    director: 'Naveed Chaudhry',
    cast: 'Imran Baig, Mehwish Tariq, Kamran Zafar, Sadia Yousuf',
    trailer: 'https://www.youtube.com/watch?v=hA6hldpSTF8',
    description: 'A street cricket team from a Lahore mohalla stumbles its way into the national tournament, armed with nothing but a taped tennis ball and an unreasonable amount of confidence.',
  },
  {
    title: 'Silent Frequency', genre: 'Mystery, Horror', language: 'English', duration_min: 106,
    certificate: 'A', poster: '#2b2b2b,#6e6e6e', banner: '#1a1a1a,#4a4a4a',
    director: 'Claire Bennett',
    cast: 'Oliver Grant, Ruth Mwangi, Peter Hale, Ingrid Sorensen',
    trailer: 'https://www.youtube.com/watch?v=9ix7TUGVYIo',
    description: 'A night-shift radio engineer starts receiving broadcasts from a station that shut down forty years ago - and the voice on the other end knows her name.',
  },
  {
    title: 'Monsoon Letters', genre: 'Romance, Drama', language: 'Urdu', duration_min: 127,
    certificate: 'U/A', poster: '#4a1f2b,#c76b86', banner: '#2e1219,#9c4c62',
    director: 'Fariha Alam',
    cast: 'Zara Hameed, Usman Riaz, Nighat Sultana, Adeel Khan',
    trailer: 'https://www.youtube.com/watch?v=d9MyW72ELq0',
    description: 'Two strangers keep writing to the same wrong address, and keep answering, through three monsoon seasons and one very patient postman.',
  },
  {
    title: 'Neon Circuit', genre: 'Action, Sci-Fi', language: 'English', duration_min: 134,
    certificate: 'U/A', poster: '#141a3a,#4d5fd6', banner: '#0b0f26,#37469e', status: 'coming_soon',
    director: 'Kenji Watanabe',
    cast: 'Rosa Delgado, Andre Cole, Mika Tanaka, Sam Oyelaran',
    trailer: 'https://www.youtube.com/watch?v=vKQi3bBA1y8',
    description: 'In 2091, an illegal street racer with a stolen memory is recruited to break into the tower that owns her past.',
  },
  {
    title: 'Dastaan-e-Sindh', genre: 'Historical, Drama', language: 'Urdu', duration_min: 155,
    certificate: 'U/A', poster: '#4d3a10,#c9a227', banner: '#2f2409,#96790f', status: 'coming_soon',
    director: 'Shahid Memon',
    cast: 'Talat Hussain, Sabreen Jalal, Arif Lakhani, Hina Solangi',
    trailer: 'https://www.youtube.com/watch?v=eIPnvyNlPd4',
    description: 'An epic retelling of the traders, poets and rulers whose quarrels and courage shaped the banks of the Indus.',
  },
];

const CINEMAS = [
  { name: 'CineStar Mall', city: 'Karachi', address: 'Main Rashid Minhas Road, Gulshan-e-Iqbal',
    screens: [['Screen 1', tiers(4, 3, 1), 12], ['Screen 2', tiers(3, 2, 1), 10], ['IMAX', tiers(5, 4, 1), 14]] },
  { name: 'Nueplex Cinemas', city: 'Karachi', address: 'DHA Phase VIII, Askari IV',
    screens: [['Audi A', tiers(4, 3, 1), 12], ['Audi B', tiers(4, 2, 1), 10]] },
  { name: 'Cinepax Lahore', city: 'Lahore', address: 'Packages Mall, Walton Road',
    screens: [['Hall 1', tiers(5, 3, 1), 12], ['Hall 2', tiers(3, 2, 1), 10]] },
  { name: 'Centaurus Cineplex', city: 'Islamabad', address: 'The Centaurus Mall, F-8',
    screens: [['Gold Class', tiers(2, 2, 1), 8], ['Screen 2', tiers(4, 3, 1), 12]] },
];

const SHOW_TIMES = ['11:30', '14:45', '18:00', '21:15'];

/* ---------------- build ---------------- */

tx(() => {
  /* users */
  const insUser = db.prepare('INSERT INTO users (name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, ?)');
  const adminId = Number(insUser.run('System Admin', 'admin@cinema.com', '03001234567', hashPassword('admin123'), 'admin').lastInsertRowid);
  const aliId = Number(insUser.run('Ali Raza', 'ali@example.com', '03111234567', hashPassword('user123'), 'user').lastInsertRowid);
  const saraId = Number(insUser.run('Sara Khan', 'sara@example.com', '03221234567', hashPassword('user123'), 'user').lastInsertRowid);
  const bilalId = Number(insUser.run('Bilal Ahmed', 'bilal@example.com', '03331234567', hashPassword('user123'), 'user').lastInsertRowid);

  /* movies */
  const insMovie = db.prepare(`
    INSERT INTO movies (title, description, genre, language, duration_min, certificate,
                        director, cast_list, poster_url, banner_url, trailer_url, release_date, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const movieIds = MOVIES.map((m, i) => Number(insMovie.run(
    m.title, m.description, m.genre, m.language, m.duration_min, m.certificate,
    m.director, m.cast, m.poster, m.banner, m.trailer,
    m.status === 'coming_soon' ? dayOffset(14 + i * 7) : dayOffset(-30 + i * 3),
    m.status || 'now_showing'
  ).lastInsertRowid));

  /* cinemas, screens, seats */
  const insCinema = db.prepare('INSERT INTO cinemas (name, city, address) VALUES (?, ?, ?)');
  const screenIds = [];
  for (const c of CINEMAS) {
    const cid = Number(insCinema.run(c.name, c.city, c.address).lastInsertRowid);
    for (const [name, tierList, cols] of c.screens) screenIds.push(makeScreen(cid, name, tierList, cols));
  }

  /* a couple of seats taken out of service, so the "disabled" state is visible */
  db.prepare(`UPDATE seats SET disabled = 1 WHERE screen_id = ? AND row_label = 'A' AND seat_no IN (1, 2)`)
    .run(screenIds[0]);

  /* shows for the next 7 days */
  const showing = movieIds.filter((_, i) => (MOVIES[i].status || 'now_showing') === 'now_showing');
  const insShow = db.prepare('INSERT OR IGNORE INTO shows (movie_id, screen_id, start_time, base_price) VALUES (?, ?, ?, ?)');
  let pick = 0;
  for (let d = 0; d < 7; d++) {
    for (const screenId of screenIds) {
      for (const time of SHOW_TIMES) {
        insShow.run(showing[pick++ % showing.length], screenId, `${dayOffset(d)} ${time}`, 450 + (pick % 4) * 50);
      }
    }
  }

  /* promos */
  const insPromo = db.prepare(`
    INSERT INTO promos (code, discount_type, discount_value, max_discount, min_amount, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)`);
  insPromo.run('WELCOME20', 'percent', 20, 500, 800, dayOffset(60));
  insPromo.run('FLAT200', 'flat', 200, null, 1500, dayOffset(30));
  insPromo.run('STUDENT10', 'percent', 10, 300, 0, dayOffset(90));

  /* reviews */
  const insReview = db.prepare('INSERT INTO reviews (movie_id, user_id, rating, comment) VALUES (?, ?, ?, ?)');
  insReview.run(movieIds[0], aliId, 5, 'Visuals were unreal on IMAX. Worth every rupee.');
  insReview.run(movieIds[0], saraId, 4, 'Great film, slightly slow in the middle.');
  insReview.run(movieIds[0], bilalId, 5, 'The third act had the whole hall silent.');
  insReview.run(movieIds[1], aliId, 4, 'Solid thriller, the last twenty minutes are excellent.');
  insReview.run(movieIds[1], saraId, 5, 'Best Urdu thriller in years.');
  insReview.run(movieIds[3], saraId, 5, 'Laughed the whole way through. Take the family.');
  insReview.run(movieIds[4], bilalId, 3, 'Creepy, but the ending did not land for me.');
  insReview.run(movieIds[5], aliId, 4, 'Quietly lovely. The letters are beautifully written.');

  /* sample bookings, so the dashboard and My Bookings are not empty on first run */
  const bookSeats = (userId, showId, count, status) => {
    const show = db.prepare('SELECT * FROM shows WHERE id = ?').get(showId);
    const free = db.prepare(`
      SELECT s.* FROM seats s
       WHERE s.screen_id = ? AND s.disabled = 0
         AND s.id NOT IN (SELECT seat_id FROM booking_seats WHERE show_id = ?)
       ORDER BY s.row_label, s.seat_no LIMIT ?`).all(show.screen_id, showId, count);
    if (free.length < count) return null;

    const priced = free.map((s) => ({ ...s, price: Math.round(show.base_price * s.price_multiplier) }));
    const money = priceBooking(priced.map((s) => s.price));
    const ref = 'MBS' + crypto.randomBytes(4).toString('hex').toUpperCase();

    const info = db.prepare(`
      INSERT INTO bookings (booking_ref, user_id, show_id, subtotal, discount, booking_fee,
                            service_fee, total_amount, seats_snapshot, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      ref, userId, showId, money.subtotal, money.discount, money.booking_fee,
      money.service_fee, money.total_amount,
      priced.map((s) => `${s.row_label}${s.seat_no}`).join(', '), status);

    const bookingId = Number(info.lastInsertRowid);
    const insSeat = db.prepare('INSERT INTO booking_seats (booking_id, show_id, seat_id, price) VALUES (?, ?, ?, ?)');
    for (const s of priced) insSeat.run(bookingId, showId, s.id, s.price);

    if (status === 'CONFIRMED') {
      db.prepare(`INSERT INTO payments (booking_id, method, amount, status, provider, message, txn_ref)
                  VALUES (?, ?, ?, 'PAID', 'mock', 'Seeded demo payment', ?)`)
        .run(bookingId, ['card', 'easypaisa', 'jazzcash'][bookingId % 3], money.total_amount,
             'TXN' + crypto.randomBytes(6).toString('hex').toUpperCase());
    } else if (status === 'CANCELLED') {
      // Cancelling releases the seats, exactly as the running app does - the
      // snapshot on the booking is all that is kept for history.
      db.prepare('DELETE FROM booking_seats WHERE booking_id = ?').run(bookingId);
      db.prepare(`INSERT INTO payments (booking_id, method, amount, status, provider, message, txn_ref)
                  VALUES (?, 'card', ?, 'REFUNDED', 'mock', 'Seeded demo refund', ?)`)
        .run(bookingId, money.total_amount, 'TXN' + crypto.randomBytes(6).toString('hex').toUpperCase());
    }
    return bookingId;
  };

  const upcoming = db.prepare(`SELECT id FROM shows WHERE start_time > datetime('now','localtime') ORDER BY start_time LIMIT 12`).all();
  bookSeats(aliId, upcoming[0].id, 3, 'CONFIRMED');
  bookSeats(saraId, upcoming[1].id, 2, 'CONFIRMED');
  bookSeats(bilalId, upcoming[2].id, 4, 'CONFIRMED');
  bookSeats(aliId, upcoming[5].id, 2, 'CONFIRMED');
  bookSeats(saraId, upcoming[7].id, 5, 'CONFIRMED');
  bookSeats(bilalId, upcoming[9].id, 2, 'CANCELLED');
});

const count = (t) => db.prepare(`SELECT COUNT(*) AS v FROM ${t}`).get().v;
console.log(`
Seed complete.
  movies   : ${count('movies')}
  cinemas  : ${count('cinemas')}
  screens  : ${count('screens')}
  seats    : ${count('seats')}
  shows    : ${count('shows')}
  bookings : ${count('bookings')}
  reviews  : ${count('reviews')}
  promos   : ${count('promos')}

Login details
  Admin : admin@cinema.com / admin123
  User  : ali@example.com  / user123
  User  : sara@example.com / user123
  User  : bilal@example.com / user123
`);

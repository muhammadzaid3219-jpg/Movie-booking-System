'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'cinema.db');
const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone         TEXT,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  blocked       INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS movies (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  description  TEXT,
  genre        TEXT,
  language     TEXT,
  duration_min INTEGER NOT NULL DEFAULT 120,
  certificate  TEXT DEFAULT 'U/A',
  director     TEXT,
  cast_list    TEXT,
  poster_url   TEXT,
  banner_url   TEXT,
  trailer_url  TEXT,
  release_date TEXT,
  status       TEXT NOT NULL DEFAULT 'now_showing'
                 CHECK (status IN ('now_showing','coming_soon','archived')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS cinemas (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  name    TEXT NOT NULL,
  city    TEXT NOT NULL,
  address TEXT
);

CREATE TABLE IF NOT EXISTS screens (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  cinema_id INTEGER NOT NULL REFERENCES cinemas(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 8,
  col_count INTEGER NOT NULL DEFAULT 12
);

CREATE TABLE IF NOT EXISTS seats (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  screen_id        INTEGER NOT NULL REFERENCES screens(id) ON DELETE CASCADE,
  row_label        TEXT NOT NULL,
  seat_no          INTEGER NOT NULL,
  seat_type        TEXT NOT NULL DEFAULT 'SILVER'
                     CHECK (seat_type IN ('SILVER','GOLD','RECLINER')),
  price_multiplier REAL NOT NULL DEFAULT 1.0,
  disabled         INTEGER NOT NULL DEFAULT 0,   -- taken out of service by an admin
  UNIQUE (screen_id, row_label, seat_no)
);

CREATE TABLE IF NOT EXISTS shows (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  movie_id   INTEGER NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
  screen_id  INTEGER NOT NULL REFERENCES screens(id) ON DELETE CASCADE,
  start_time TEXT NOT NULL,              -- 'YYYY-MM-DD HH:MM'
  base_price REAL NOT NULL DEFAULT 500,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  UNIQUE (screen_id, start_time)
);

CREATE TABLE IF NOT EXISTS bookings (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_ref    TEXT NOT NULL UNIQUE,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  show_id        INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  subtotal       REAL NOT NULL DEFAULT 0,
  discount       REAL NOT NULL DEFAULT 0,
  booking_fee    REAL NOT NULL DEFAULT 0,
  service_fee    REAL NOT NULL DEFAULT 0,
  total_amount   REAL NOT NULL DEFAULT 0,
  promo_code     TEXT,
  seats_snapshot TEXT,                   -- 'A1, A2' kept for history
  status         TEXT NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING','CONFIRMED','CANCELLED','EXPIRED')),
  expires_at     TEXT,                   -- seat hold expiry (PENDING only)
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- The double-booking guard: one seat can exist only once per show.
CREATE TABLE IF NOT EXISTS booking_seats (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  show_id    INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  seat_id    INTEGER NOT NULL REFERENCES seats(id) ON DELETE CASCADE,
  price      REAL NOT NULL,
  UNIQUE (show_id, seat_id)
);

CREATE TABLE IF NOT EXISTS payments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  method     TEXT NOT NULL CHECK (method IN ('card','wallet','easypaisa','jazzcash','counter')),
  amount     REAL NOT NULL,
  status     TEXT NOT NULL DEFAULT 'PAID'
               CHECK (status IN ('PAID','PENDING','FAILED','REFUNDED')),
  provider   TEXT,
  message    TEXT,
  txn_ref    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS reviews (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  movie_id   INTEGER NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating     INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (movie_id, user_id)
);

CREATE TABLE IF NOT EXISTS promos (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  discount_type  TEXT NOT NULL CHECK (discount_type IN ('percent','flat')),
  discount_value REAL NOT NULL,
  max_discount   REAL,
  min_amount     REAL NOT NULL DEFAULT 0,
  active         INTEGER NOT NULL DEFAULT 1,
  expires_at     TEXT
);

CREATE TABLE IF NOT EXISTS password_resets (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_shows_movie   ON shows(movie_id, start_time);
CREATE INDEX IF NOT EXISTS idx_bs_booking    ON booking_seats(booking_id);
CREATE INDEX IF NOT EXISTS idx_book_user     ON bookings(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_seats_screen  ON seats(screen_id);
`);

/**
 * Frees seats held by PENDING bookings whose hold timer ran out.
 * Called before every read/write that touches seat availability.
 */
function releaseExpiredHolds() {
  const expired = db.prepare(
    `SELECT id FROM bookings WHERE status = 'PENDING' AND expires_at IS NOT NULL AND expires_at < datetime('now','localtime')`
  ).all();
  if (expired.length === 0) return 0;
  const delSeats = db.prepare('DELETE FROM booking_seats WHERE booking_id = ?');
  const mark = db.prepare(`UPDATE bookings SET status = 'EXPIRED', expires_at = NULL WHERE id = ?`);
  for (const b of expired) { delSeats.run(b.id); mark.run(b.id); }
  return expired.length;
}

/** Runs fn() inside a transaction, rolling back on any throw. */
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

module.exports = { db, tx, releaseExpiredHolds, DB_PATH };

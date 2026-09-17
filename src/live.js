'use strict';
/**
 * Live updates.
 *
 * Browsers hold an EventSource on /api/events and get told which collection
 * changed; they then re-fetch just that view. Only the collection name travels,
 * never the data, so one stream is safe for every page.
 *
 * Where the change is noticed depends on the driver:
 *   rtdb       Realtime Database `child_changed` / `child_added` listeners
 *   firestore  onSnapshot listeners
 *   sqlite     nothing to listen to, so the server announces its own writes
 */
const { EventEmitter } = require('node:events');
const config = require('./config');

const hub = new EventEmitter();
hub.setMaxListeners(0);

/** Collections worth telling the browser about. */
const WATCHED = ['movies', 'cinemas', 'screens', 'shows', 'bookings', 'users', 'promos', 'reviews'];

/** Only admins are told about these; the rest are harmless to anyone signed in. */
const ADMIN_ONLY = new Set(['users', 'bookings']);

let started = false;
let lastAt = new Map();

/** Announces a change, collapsing bursts so a batch write is one event. */
function announce(collection) {
  if (!WATCHED.includes(collection)) return;
  const now = Date.now();
  if (now - (lastAt.get(collection) || 0) < 400) return;   // debounce
  lastAt.set(collection, now);
  hub.emit('change', { collection, at: new Date().toISOString() });
}

/* ---------------- driver watchers ---------------- */

function watchRtdb() {
  const db = require('./rtdb').db();
  for (const name of WATCHED) {
    const ref = db.ref(name);
    // `value` would resend the whole node on every change; child events are cheap.
    ref.on('child_added', () => announce(name));
    ref.on('child_changed', () => announce(name));
    ref.on('child_removed', () => announce(name));
  }
  console.log('  Live updates -> Realtime Database listeners active');
}

function watchFirestore() {
  const db = require('./firestore').db();
  for (const name of WATCHED) {
    db.collection(name).onSnapshot(
      (snap) => { if (!snap.metadata.fromCache) announce(name); },
      (err) => console.error(`live: ${name} listener stopped:`, err.message)
    );
  }
  console.log('  Live updates -> Firestore snapshot listeners active');
}

/** Starts watching. Safe to call more than once. */
function start() {
  if (started) return;
  started = true;
  try {
    if (config.driver === 'rtdb') watchRtdb();
    else if (config.driver === 'firestore') watchFirestore();
    else console.log('  Live updates -> announced by the server on each write (SQLite)');
  } catch (e) {
    started = false;
    console.error('  Live updates unavailable:', e.message);
  }
}

/**
 * Express handler for the event stream.
 * Sends a comment every 25s so proxies do not time the connection out.
 */
function stream(req, res) {
  /*
   * Behind Firebase Hosting a response is held until it finishes (and cut at 60
   * seconds), so a long-lived stream never delivers anything - it would only keep
   * an instance busy. 204 tells the browser not to reconnect; it polls instead.
   */
  if (require('./firebaseapp').onGoogleCloud()) return res.status(204).end();

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write(`event: ready\ndata: ${JSON.stringify({ driver: config.driver })}\n\n`);

  const isAdmin = req.user?.role === 'admin';
  const onChange = (payload) => {
    if (ADMIN_ONLY.has(payload.collection) && !isAdmin) return;
    res.write(`event: change\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  hub.on('change', onChange);
  const beat = setInterval(() => res.write(': keep-alive\n\n'), 25_000);

  req.on('close', () => {
    clearInterval(beat);
    hub.off('change', onChange);
  });
}

module.exports = { start, stream, announce, WATCHED };

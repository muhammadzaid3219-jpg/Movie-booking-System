'use strict';
const path = require('node:path');
const express = require('express');

const config = require('./src/config');
const { attachUser } = require('./src/auth');

const app = express();
const PORT = config.port;

/**
 * DB_DRIVER picks the database:
 *   sqlite     local file, no cloud account
 *   firestore  Cloud Firestore
 *   rtdb       Firebase Realtime Database
 *
 * Firestore and Realtime Database share one set of route files, because both
 * data layers expose the same functions through src/store.js.
 */
const DRIVER = config.driver;
if (!['firestore', 'sqlite', 'rtdb'].includes(DRIVER)) {
  console.error(`Unknown DB_DRIVER "${DRIVER}". Use "sqlite", "firestore" or "rtdb".`);
  process.exit(1);
}
/*
 * A Firebase driver without the service-account key cannot answer a single
 * request, and used to surface only as "Something went wrong on the server".
 * This happens every time the project is cloned, because the key is git-ignored
 * on purpose. Explain it plainly and fall back to SQLite so the site still runs.
 */
if (DRIVER !== 'sqlite' && !require('./src/firebaseapp').isConfigured()) {
  console.warn(
    `\n  DB_DRIVER=${DRIVER} needs firebase-key.json, which is not in this folder.\n` +
    '  (It is git-ignored on purpose, so a fresh clone never has it.)\n' +
    '  Fix: copy your service-account key here as firebase-key.json and restart.\n' +
    '  Running on SQLite until then - data you add now goes to the local file.\n'
  );
  config.driver = 'sqlite';
  config.auth.provider = 'local';
}
const DRIVER_ACTIVE = config.driver;
const ROUTE_DIR = DRIVER_ACTIVE === 'sqlite' ? 'sqlite' : 'cloud';

/*
 * The SQLite routes always hash passwords locally, so asking for Firebase Auth
 * there would silently do nothing. Say so rather than pretending.
 */
if (DRIVER_ACTIVE === 'sqlite' && config.auth.provider === 'firebase') {
  console.warn(
    '\n  AUTH_PROVIDER=firebase is ignored on the SQLite driver.\n' +
    '  Firebase Authentication needs a Firebase database - set DB_DRIVER to rtdb or firestore.\n' +
    '  Falling back to local password hashing.\n'
  );
  config.auth.provider = 'local';
}

/**
 * Express 4 does not catch rejected promises from async handlers - the request
 * would just hang. This forwards any rejection to the error middleware.
 */
function catchAsync(router) {
  for (const layer of router.stack || []) {
    if (layer.route) {
      for (const entry of layer.route.stack) {
        const fn = entry.handle;
        if (fn.length > 3) continue;              // already an error handler
        entry.handle = function wrapped(req, res, next) {
          const out = fn.call(this, req, res, next);
          if (out && typeof out.catch === 'function') out.catch(next);
          return out;
        };
      }
    } else if (layer.handle && Array.isArray(layer.handle.stack)) {
      catchAsync(layer.handle);
    }
  }
  return router;
}

const route = (name) => catchAsync(require(`./src/routes/${ROUTE_DIR}/${name}`));

app.use(express.json({ limit: '12mb' }));   // large enough for base64 image uploads
app.use(express.urlencoded({ extended: true }));
app.use(attachUser);

const live = require('./src/live');

/*
 * Live updates: browsers hold this stream open and are told which collection
 * changed, so lists refresh themselves instead of needing a page reload.
 */
app.get('/api/events', (req, res) => live.stream(req, res));

/*
 * SQLite cannot push change notifications, so the server announces its own
 * successful writes. The cloud drivers get this from database listeners instead.
 */
if (DRIVER_ACTIVE === 'sqlite') {
  app.use((req, res, next) => {
    if (req.method === 'GET') return next();
    res.on('finish', () => {
      if (res.statusCode >= 400) return;
      const hit = live.WATCHED.find((c) => req.originalUrl.includes('/' + c));
      if (hit) live.announce(hit);
      else if (req.originalUrl.includes('/bookings')) live.announce('bookings');
      else if (req.originalUrl.includes('/auth/register')) live.announce('users');
    });
    next();
  });
}

app.use('/api/auth', route('auth'));
app.use('/api', route('catalog'));
app.use('/api/bookings', route('bookings'));
app.use('/api/admin/uploads', catchAsync(require('./src/routes/uploads')));
app.use('/api/admin', route('admin'));

/*
 * Pages and scripts must not be cached, or an edit to the front end keeps
 * running the old copy until someone thinks to hard-refresh. Images and fonts
 * still cache normally.
 */
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  setHeaders(res, filePath) {
    if (/\.(html|js|css)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  },
}));

app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Something went wrong on the server' });
});

/* Free abandoned seat holds even when nobody is browsing. */
const releaseExpiredHolds = DRIVER_ACTIVE === 'sqlite'
  ? require('./src/db').releaseExpiredHolds
  : require('./src/store').releaseExpiredHolds;

setInterval(async () => {
  try { await releaseExpiredHolds(); }
  catch (e) { console.error('hold cleanup failed:', e.message); }
}, 60_000).unref();

live.start();

/*
 * `node server.js` listens on a port. When required instead - by the Cloud
 * Function in index.js - the app is exported and Google's runtime serves it.
 */
if (require.main === module) {
  app.listen(PORT, () => {
    const accounts = config.auth.provider === 'firebase' ? 'Firebase Auth' : 'local passwords';
    console.log(`\n  Movie Booking System`);
    console.log(`  Data     -> ${DRIVER_ACTIVE.toUpperCase()}          (DB_DRIVER)`);
    console.log(`  Accounts -> ${accounts}   (AUTH_PROVIDER)`);
    console.log(`  Site        -> http://localhost:${PORT}`);
    console.log(`  Admin panel -> http://localhost:${PORT}/admin.html\n`);
  });
}

module.exports = app;

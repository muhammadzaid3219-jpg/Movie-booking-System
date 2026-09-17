'use strict';
/**
 * Image uploads without a multipart library.
 * The browser reads the file as a base64 data URL and posts it as JSON; this
 * route decodes it and stores it.
 *
 * Where it is stored (UPLOAD_TARGET overrides the choice):
 *   database   the same Firebase database as everything else. The default on
 *              the Firebase drivers, because hosts such as Render wipe their own
 *              disk on every restart and deploy, and Firebase Storage needs the
 *              paid Blaze plan on new projects.
 *   storage    Firebase Storage. The default on Google Cloud.
 *   local      public/uploads/, served by Express. The default on SQLite.
 *
 * Every target hands out the same kind of URL, /uploads/<name> (or a Storage
 * download URL), so the pages never need to know where an image lives.
 */
const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const A = require('../auth');
const App = require('../firebaseapp');
const config = require('../config');

const router = express.Router();
router.use(A.requireAdmin);

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'public', 'uploads');
const PREFIX = 'uploads/';

function target() {
  const chosen = String(process.env.UPLOAD_TARGET || '').toLowerCase();
  if (['database', 'storage', 'local'].includes(chosen)) return chosen;
  if (App.onGoogleCloud()) return 'storage';
  return config.driver === 'sqlite' ? 'local' : 'database';
}

const MAX_BYTES = 5 * 1024 * 1024;   // 5 MB per image on disk or Storage
/*
 * A Firestore document holds at most 1 MB, and base64 adds a third, so database
 * images stay under 700 KB. The admin pages shrink photos before upload, so a
 * normal poster lands far below this.
 */
const DB_MAX_BYTES = 700 * 1024;
const EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};
const MIME = Object.fromEntries(Object.entries(EXT).map(([m, e]) => [e.slice(1), m]));

/** Only files this route itself could have written. */
const SAFE_NAME = /^[a-f0-9]{16}\.(png|jpg|webp|gif)$/;

/* ---------------- database ---------------- */

/* Realtime Database keys may not contain a dot. */
const dbKey = (name) => name.replace('.', '_');
const nameFromKey = (key) => key.replace('_', '.');

const images = {
  async save(name, doc) {
    if (config.driver === 'rtdb') return require('../rtdb').db().ref('images/' + dbKey(name)).set(doc);
    return require('../firestore').db().collection('images').doc(dbKey(name)).set(doc);
  },
  async get(name) {
    if (config.driver === 'rtdb') return (await require('../rtdb').db().ref('images/' + dbKey(name)).get()).val();
    const snap = await require('../firestore').db().collection('images').doc(dbKey(name)).get();
    return snap.exists ? snap.data() : null;
  },
  async remove(name) {
    if (config.driver === 'rtdb') return require('../rtdb').db().ref('images/' + dbKey(name)).remove();
    return require('../firestore').db().collection('images').doc(dbKey(name)).delete();
  },
  /** Everything but the picture itself, for the media library. */
  async list() {
    if (config.driver === 'rtdb') {
      // A shallow read is not available in the Admin SDK, so metadata lives beside the data.
      const val = (await require('../rtdb').db().ref('imageIndex').get()).val() || {};
      return Object.entries(val).map(([key, meta]) => ({ name: nameFromKey(key), ...meta }));
    }
    const snap = await require('../firestore').db().collection('images').select('size', 'created_at').get();
    return snap.docs.map((d) => ({ name: nameFromKey(d.id), ...d.data() }));
  },
  async index(name, meta) {
    if (config.driver === 'rtdb') await require('../rtdb').db().ref('imageIndex/' + dbKey(name)).set(meta);
  },
};

/* Images never change once written (every upload gets a new name), so they cache well. */
const cache = new Map();
const CACHE_LIMIT = 40 * 1024 * 1024;
let cacheBytes = 0;

function remember(name, entry) {
  cache.set(name, entry);
  cacheBytes += entry.body.length;
  for (const [key, old] of cache) {
    if (cacheBytes <= CACHE_LIMIT) break;
    cache.delete(key);
    cacheBytes -= old.body.length;
  }
}

function forget(name) {
  const old = cache.get(name);
  if (old) { cacheBytes -= old.body.length; cache.delete(name); }
}

/**
 * GET /uploads/:name for images kept in the database. Mounted after the static
 * files, so an image that exists on disk is still served from there.
 */
async function serveFromDatabase(req, res, next) {
  const name = String(req.params.name);
  if (config.driver === 'sqlite' || !SAFE_NAME.test(name)) return next();
  try {
    let entry = cache.get(name);
    if (!entry) {
      const doc = await images.get(name);
      if (!doc?.data) return res.status(404).end();
      entry = { mime: doc.mime || MIME[name.split('.').pop()], body: Buffer.from(doc.data, 'base64') };
      remember(name, entry);
    }
    res.setHeader('Content-Type', entry.mime);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.end(entry.body);
  } catch (e) {
    next(e);
  }
}

/* ---------------- Firebase Storage ---------------- */

const bucketName = () => process.env.STORAGE_BUCKET || process.env.FIREBASE_STORAGE_BUCKET
  || App.runtimeConfig().storageBucket || `${App.projectId()}.firebasestorage.app`;
const bucket = () => require('firebase-admin/storage').getStorage(App.get()).bucket(bucketName());

const STORAGE_MISSING =
  'Image upload needs Firebase Storage, which is not set up for this project yet. '
  + 'Open the Firebase console, go to Storage and click "Get started". '
  + 'Until then, paste an image URL in the poster field instead.';

/** A download URL carrying a token, so no public ACL or security rule is needed. */
const tokenUrl = (name, token) =>
  `https://firebasestorage.googleapis.com/v0/b/${bucketName()}/o/${encodeURIComponent(PREFIX + name)}?alt=media&token=${token}`;

const isMissingBucket = (e) => e?.code === 404 || /does not exist|bucket.*not found/i.test(e?.message || '');

/* ---------------- routes ---------------- */

router.get('/', async (_req, res) => {
  const where = target();

  if (where === 'database') {
    const rows = (await images.list())
      .filter((f) => SAFE_NAME.test(f.name))
      .map((f) => ({ name: f.name, url: '/uploads/' + f.name, size: Number(f.size || 0), created_at: f.created_at || '' }))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return res.json({ files: rows });
  }

  if (where === 'storage') {
    let files;
    try {
      [files] = await bucket().getFiles({ prefix: PREFIX });
    } catch (e) {
      if (isMissingBucket(e)) return res.json({ files: [], notice: STORAGE_MISSING });
      throw e;
    }
    const rows = files
      .map((f) => ({ f, name: f.name.slice(PREFIX.length) }))
      .filter(({ name }) => SAFE_NAME.test(name))
      .map(({ f, name }) => ({
        name,
        url: tokenUrl(name, f.metadata?.metadata?.firebaseStorageDownloadTokens),
        size: Number(f.metadata?.size || 0),
        created_at: f.metadata?.timeCreated || '',
      }))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return res.json({ files: rows });
  }

  if (!fs.existsSync(UPLOAD_DIR)) return res.json({ files: [] });
  const files = fs.readdirSync(UPLOAD_DIR)
    .filter((f) => SAFE_NAME.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(UPLOAD_DIR, f));
      return { name: f, url: '/uploads/' + f, size: st.size, created_at: st.mtime.toISOString() };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  res.json({ files });
});

router.post('/', async (req, res) => {
  const dataUrl = String(req.body.data || '');
  const match = /^data:([\w/+.-]+);base64,(.+)$/s.exec(dataUrl);
  if (!match) return res.status(400).json({ error: 'Could not read the image file' });

  const [, mime, b64] = match;
  const ext = EXT[mime.toLowerCase()];
  if (!ext) return res.status(400).json({ error: 'Only PNG, JPG, WEBP and GIF images are allowed' });

  const buffer = Buffer.from(b64, 'base64');
  if (buffer.length === 0) return res.status(400).json({ error: 'The image file is empty' });
  if (buffer.length > MAX_BYTES) {
    return res.status(413).json({ error: 'Image is larger than 5 MB. Please use a smaller file.' });
  }

  const name = crypto.randomBytes(8).toString('hex') + ext;
  const where = target();

  if (where === 'database') {
    if (buffer.length > DB_MAX_BYTES) {
      return res.status(413).json({ error: 'Image is larger than 700 KB. Please use a smaller picture.' });
    }
    const created_at = new Date().toISOString();
    await images.save(name, { mime: mime.toLowerCase(), size: buffer.length, created_at, data: buffer.toString('base64') });
    await images.index(name, { size: buffer.length, created_at });
    return res.status(201).json({ url: '/uploads/' + name, name, size: buffer.length });
  }

  if (where === 'storage') {
    const token = crypto.randomUUID();
    try {
      await bucket().file(PREFIX + name).save(buffer, {
        resumable: false,
        metadata: {
          contentType: mime.toLowerCase(),
          cacheControl: 'public, max-age=31536000',
          metadata: { firebaseStorageDownloadTokens: token },
        },
      });
    } catch (e) {
      if (isMissingBucket(e)) return res.status(503).json({ error: STORAGE_MISSING });
      throw e;
    }
    return res.status(201).json({ url: tokenUrl(name, token), name, size: buffer.length });
  }

  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buffer);
  res.status(201).json({ url: '/uploads/' + name, name, size: buffer.length });
});

router.delete('/:name', async (req, res) => {
  const name = String(req.params.name);
  if (!SAFE_NAME.test(name)) return res.status(400).json({ error: 'Invalid file name' });
  const where = target();

  if (where === 'database') {
    if (!(await images.get(name))) return res.status(404).json({ error: 'File not found' });
    await images.remove(name);
    if (config.driver === 'rtdb') await require('../rtdb').db().ref('imageIndex/' + dbKey(name)).remove();
    forget(name);
    return res.json({ ok: true });
  }

  if (where === 'storage') {
    try {
      await bucket().file(PREFIX + name).delete();
    } catch (e) {
      if (e?.code === 404) return res.status(404).json({ error: 'File not found' });
      throw e;
    }
    return res.json({ ok: true });
  }

  const file = path.join(UPLOAD_DIR, name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'File not found' });

  fs.unlinkSync(file);
  res.json({ ok: true });
});

module.exports = router;
module.exports.serveFromDatabase = serveFromDatabase;

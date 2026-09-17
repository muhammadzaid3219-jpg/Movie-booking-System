'use strict';
/**
 * Image uploads without a multipart library.
 * The browser reads the file as a base64 data URL and posts it as JSON; this
 * route decodes it and stores a real file.
 *
 * Where it is stored depends on where the app runs:
 *   locally      public/uploads/, served by Express
 *   deployed     Firebase Storage - a Cloud Function's own folder is read-only
 *                and wiped whenever the instance is replaced
 * Set UPLOAD_TARGET=storage to use Firebase Storage locally too.
 */
const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const A = require('../auth');
const App = require('../firebaseapp');

const router = express.Router();
router.use(A.requireAdmin);

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'public', 'uploads');
const PREFIX = 'uploads/';

const useStorage = () => process.env.UPLOAD_TARGET === 'storage' || App.onGoogleCloud();

const MAX_BYTES = 5 * 1024 * 1024;   // 5 MB per image
const EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

/** Only files this route itself could have written. */
const SAFE_NAME = /^[a-f0-9]{16}\.(png|jpg|webp|gif)$/;

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
  if (useStorage()) {
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

  if (useStorage()) {
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

  if (useStorage()) {
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

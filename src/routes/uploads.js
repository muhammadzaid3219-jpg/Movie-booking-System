'use strict';
/**
 * Image uploads without any npm dependency.
 * The browser reads the file as a base64 data URL and posts it as JSON;
 * this route decodes it and writes a real file into public/uploads.
 */
const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const A = require('../auth');

const router = express.Router();
router.use(A.requireAdmin);

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'public', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MAX_BYTES = 5 * 1024 * 1024;   // 5 MB per image
const EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

/** Only files this route itself could have written. */
const SAFE_NAME = /^[a-f0-9]{16}\.(png|jpg|webp|gif)$/;

router.get('/', (_req, res) => {
  const files = fs.readdirSync(UPLOAD_DIR)
    .filter((f) => SAFE_NAME.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(UPLOAD_DIR, f));
      return { name: f, url: '/uploads/' + f, size: st.size, created_at: st.mtime.toISOString() };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  res.json({ files });
});

router.post('/', (req, res) => {
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
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buffer);
  res.status(201).json({ url: '/uploads/' + name, name, size: buffer.length });
});

router.delete('/:name', (req, res) => {
  const name = String(req.params.name);
  if (!SAFE_NAME.test(name)) return res.status(400).json({ error: 'Invalid file name' });

  const file = path.join(UPLOAD_DIR, name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'File not found' });

  fs.unlinkSync(file);
  res.json({ ok: true });
});

module.exports = router;

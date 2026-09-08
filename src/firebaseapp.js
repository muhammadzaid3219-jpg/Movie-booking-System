'use strict';
/**
 * The one Firebase app instance, shared by Firestore, Realtime Database and
 * Authentication.
 *
 * These used to initialise their own app, so whichever module loaded first
 * decided the options - and if that was Authentication, the app had no
 * databaseURL and Realtime Database then failed with "Can't determine Firebase
 * Database URL". Initialising in one place with every option set removes that
 * whole class of ordering bug.
 */
const fs = require('node:fs');
const path = require('node:path');

const KEY_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS
  || path.join(__dirname, '..', 'firebase-key.json');

let cached = null;
let app = null;

/** True when a service-account key is available. */
const isConfigured = () => Boolean(process.env.FIREBASE_SERVICE_ACCOUNT) || fs.existsSync(KEY_PATH);

function credential() {
  if (cached) return cached;

  if (process.env.FIREBASE_SERVICE_ACCOUNT) return (cached = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT));

  if (!fs.existsSync(KEY_PATH)) {
    throw new Error(
      'No Firebase key found.\n' +
      '  Download a service-account key from the Firebase console\n' +
      '  (Project settings -> Service accounts -> Generate new private key)\n' +
      `  and save it as: ${KEY_PATH}`
    );
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
  } catch {
    throw new Error(`${KEY_PATH} is not valid JSON. Re-download the key from the Firebase console.`);
  }

  // The web app config is the file people grab by mistake; it looks nothing like this one.
  if (raw.apiKey || raw.authDomain || raw.messagingSenderId) {
    throw new Error(
      'This is the Firebase WEB APP config (apiKey / authDomain), which is for browsers.\n' +
      '  This server needs the SERVICE ACCOUNT key instead:\n' +
      '  Firebase console -> gear icon -> Project settings -> Service accounts tab\n' +
      '  -> "Generate new private key". That file contains project_id, client_email and private_key.'
    );
  }
  for (const field of ['project_id', 'client_email', 'private_key']) {
    if (!raw[field]) throw new Error(`The key file is missing "${field}" - it is not a service-account key.`);
  }
  return (cached = raw);
}

const projectId = () => credential().project_id;

const databaseURL = () =>
  process.env.FIREBASE_DATABASE_URL || `https://${projectId()}-default-rtdb.firebaseio.com`;

/** The shared app, created once with every option any module might need. */
function get() {
  if (app) return app;

  const { getApps, initializeApp, cert } = require('firebase-admin/app');
  const existing = getApps();
  app = existing.length
    ? existing[0]
    : initializeApp({
        credential: cert(credential()),
        projectId: projectId(),
        databaseURL: databaseURL(),
      });
  return app;
}

/** An OAuth token for the Firebase Management API. */
const accessToken = async () => (await get().options.credential.getAccessToken()).access_token;

module.exports = { get, credential, projectId, databaseURL, isConfigured, accessToken, KEY_PATH };

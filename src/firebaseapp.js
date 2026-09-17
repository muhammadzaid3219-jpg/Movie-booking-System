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

/** The key downloaded from the Firebase console, kept next to package.json. */
const LOCAL_KEY = path.join(__dirname, '..', 'firebase-key.json');

/**
 * GOOGLE_APPLICATION_CREDENTIALS is only treated as a key when it points at a
 * service account. Tools such as the Firebase emulator point it at a user login
 * file instead, which has no project_id and must go through applicationDefault().
 */
function isServiceAccountFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).type === 'service_account'; } catch { return false; }
}
const envKey = process.env.GOOGLE_APPLICATION_CREDENTIALS;
const KEY_PATH = fs.existsSync(LOCAL_KEY) ? LOCAL_KEY
  : envKey && isServiceAccountFile(envKey) ? envKey
  : LOCAL_KEY;

let cached = null;
let app = null;

/**
 * Running inside Google Cloud (a deployed Cloud Function or Cloud Run service).
 * There the runtime supplies credentials itself, so no key file is shipped.
 */
const onGoogleCloud = () =>
  Boolean(process.env.K_SERVICE || process.env.FUNCTION_TARGET) && !process.env.FUNCTIONS_EMULATOR;

const hasKeyFile = () => Boolean(process.env.FIREBASE_SERVICE_ACCOUNT) || isServiceAccountFile(KEY_PATH);

/** Credentials Google's libraries find on their own: a login file, or the cloud runtime. */
const hasAmbientCredentials = () => onGoogleCloud() || Boolean(envKey && fs.existsSync(envKey));

/** True when Firebase can be reached: a key file locally, or built-in credentials otherwise. */
const isConfigured = () => hasKeyFile() || hasAmbientCredentials();

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

const projectId = () => (hasKeyFile()
  ? credential().project_id
  : process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || JSON.parse(process.env.FIREBASE_CONFIG || '{}').projectId);

/** Settings Google injects into a deployed function (projectId, databaseURL, storageBucket). */
const runtimeConfig = () => { try { return JSON.parse(process.env.FIREBASE_CONFIG || '{}'); } catch { return {}; } };

const databaseURL = () =>
  process.env.DATABASE_URL || process.env.FIREBASE_DATABASE_URL || runtimeConfig().databaseURL
  || `https://${projectId()}-default-rtdb.firebaseio.com`;

/** The shared app, created once with every option any module might need. */
function get() {
  if (app) return app;

  const { getApps, initializeApp, cert, applicationDefault } = require('firebase-admin/app');
  const existing = getApps();
  app = existing.length
    ? existing[0]
    : initializeApp({
        // Locally: the downloaded service-account key. Deployed: Google's own credentials.
        credential: hasKeyFile() ? cert(credential()) : applicationDefault(),
        projectId: projectId(),
        databaseURL: databaseURL(),
      });
  return app;
}

/** An OAuth token for the Firebase Management API. */
const accessToken = async () => (await get().options.credential.getAccessToken()).access_token;

module.exports = { get, credential, projectId, databaseURL, runtimeConfig, isConfigured, onGoogleCloud, accessToken, KEY_PATH };

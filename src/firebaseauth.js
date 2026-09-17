'use strict';
/**
 * Firebase Authentication.
 *
 * When AUTH_PROVIDER=firebase, accounts live in Firebase Auth (visible in the
 * console's Authentication tab) instead of being password-hashed locally. The
 * app still keeps a profile record per user for name, phone, role and bookings;
 * the two are tied together by `firebase_uid`.
 *
 * The Admin SDK can create, edit and delete users but deliberately cannot check
 * a password. Sign-in therefore goes through Google's Identity Toolkit REST
 * endpoint, which needs the project's Web API key - discovered automatically
 * from the Firebase Management API, or set as FIREBASE_WEB_API_KEY.
 */
const App = require('./firebaseapp');
const config = require('./config');

let webApiKey = null;

const isEnabled = () => config.auth.provider === 'firebase';
const auth = () => require('firebase-admin/auth').getAuth(App.get());

/** The Web API key, from the environment or looked up once and cached. */
async function apiKey() {
  if (webApiKey) return webApiKey;
  // WEB_API_KEY on Cloud Functions, where every FIREBASE_* variable name is reserved.
  const fromEnv = process.env.WEB_API_KEY || process.env.FIREBASE_WEB_API_KEY;
  if (fromEnv) return (webApiKey = fromEnv);

  const head = { Authorization: 'Bearer ' + (await App.accessToken()) };
  const list = await fetch(`https://firebase.googleapis.com/v1beta1/projects/${App.projectId()}/webApps`,
    { headers: head }).then((r) => r.json());

  const first = (list.apps || [])[0];
  if (!first) {
    throw new Error(
      'This Firebase project has no web app, so the Web API key cannot be found.\n' +
      '  Add one in the console (Project settings -> Your apps -> Web), or set FIREBASE_WEB_API_KEY.'
    );
  }

  const cfg = await fetch(`https://firebase.googleapis.com/v1beta1/${first.name}/config`, { headers: head })
    .then((r) => r.json());
  if (!cfg.apiKey) throw new Error('Could not read the Web API key from the Firebase project.');
  return (webApiKey = cfg.apiKey);
}

/* ---------- account management (Admin SDK) ---------- */

async function createUser({ email, password, name, phone, role = 'user' }) {
  const user = await auth().createUser({
    email: String(email).toLowerCase(),
    password,
    displayName: name || undefined,
    phoneNumber: undefined,          // Firebase demands E.164; local numbers are kept on the profile
  });
  await auth().setCustomUserClaims(user.uid, { role });
  return user.uid;
}

async function updateUser(uid, { name, email, password, disabled } = {}) {
  const patch = {};
  if (name !== undefined) patch.displayName = name || null;
  if (email !== undefined) patch.email = String(email).toLowerCase();
  if (password) patch.password = password;
  if (disabled !== undefined) patch.disabled = Boolean(disabled);
  if (Object.keys(patch).length) await auth().updateUser(uid, patch);
}

const setRole = (uid, role) => auth().setCustomUserClaims(uid, { role });

async function deleteUser(uid) {
  try { await auth().deleteUser(uid); }
  catch (e) { if (e.code !== 'auth/user-not-found') throw e; }
}

async function getByEmail(email) {
  try { return await auth().getUserByEmail(String(email).toLowerCase()); }
  catch (e) { if (e.code === 'auth/user-not-found') return null; throw e; }
}

async function listUsers(limit = 1000) {
  const out = [];
  let page;
  do {
    const res = await auth().listUsers(Math.min(limit - out.length, 1000), page);
    out.push(...res.users);
    page = res.pageToken;
  } while (page && out.length < limit);
  return out;
}

/* ---------- password sign-in (Identity Toolkit REST) ---------- */

const FRIENDLY = {
  EMAIL_NOT_FOUND: 'Email or password is incorrect',
  INVALID_PASSWORD: 'Email or password is incorrect',
  INVALID_LOGIN_CREDENTIALS: 'Email or password is incorrect',
  USER_DISABLED: 'Your account has been blocked',
  OPERATION_NOT_ALLOWED:
    'Email/Password sign-in is turned off for this Firebase project. '
    + 'Enable it under Authentication -> Sign-in method.',
  TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many failed attempts. Please try again in a few minutes.',
};

/**
 * Checks an email and password against Firebase Auth.
 * @returns {{uid:string}|{error:string}}
 */
async function verifyPassword(email, password) {
  let key;
  try { key = await apiKey(); }
  catch (e) { return { error: e.message }; }

  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: String(email).toLowerCase(), password, returnSecureToken: true }),
  });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const code = String(data.error?.message || '').split(' ')[0];
    return { error: FRIENDLY[code] || 'Email or password is incorrect' };
  }
  return { uid: data.localId };
}

/** Confirms the setup works, for the startup banner and the check script. */
async function selfTest() {
  const projectId = App.projectId();
  await auth().listUsers(1);
  await apiKey();
  return { projectId, count: (await auth().listUsers(1000)).users.length };
}

module.exports = {
  isEnabled, apiKey, createUser, updateUser, setRole, deleteUser,
  getByEmail, listUsers, verifyPassword, selfTest,
};

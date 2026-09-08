'use strict';
/**
 * Moves existing accounts into Firebase Authentication:  npm run auth:sync
 *
 * Locally stored passwords are scrypt hashes and cannot be reversed, so every
 * account created here needs a fresh password. Pass one, or let the script
 * generate and print one per user.
 *
 *   npm run auth:sync                      show what would change
 *   npm run auth:sync -- --yes             create the missing accounts
 *   npm run auth:sync -- --yes --password=Cinema123
 *
 * Also reports Firebase accounts that have no profile here, and profiles whose
 * Firebase account has gone.
 */
const crypto = require('node:crypto');
const config = require('./config');
const FA = require('./firebaseauth');

const args = process.argv.slice(2);
const YES = args.includes('--yes') || args.includes('-y');
const FIXED = (args.find((a) => a.startsWith('--password=')) || '').split('=')[1];

const newPassword = () => 'Cx' + crypto.randomBytes(6).toString('base64url');

(async () => {
  if (config.driver === 'sqlite') {
    console.error('\nFirebase Auth pairs with a Firebase database. Set DB_DRIVER to rtdb or firestore first.\n');
    process.exit(1);
  }

  const S = require('./store');

  console.log('\nSyncing accounts with Firebase Authentication');
  console.log(`  project : ${JSON.parse(require('node:fs').readFileSync(
    process.env.GOOGLE_APPLICATION_CREDENTIALS || require('node:path').join(__dirname, '..', 'firebase-key.json'),
    'utf8')).project_id}\n`);

  const [profiles, firebaseUsers] = await Promise.all([S.listUsersRaw(), FA.listUsers()]);
  const byEmail = new Map(firebaseUsers.map((u) => [String(u.email || '').toLowerCase(), u]));

  const toCreate = [];
  const toLink = [];
  for (const p of profiles) {
    const match = byEmail.get(String(p.email).toLowerCase());
    if (!match) toCreate.push(p);
    else if (p.firebase_uid !== match.uid) toLink.push({ profile: p, uid: match.uid });
  }

  const emails = new Set(profiles.map((p) => String(p.email).toLowerCase()));
  const orphans = firebaseUsers.filter((u) => !emails.has(String(u.email || '').toLowerCase()));

  console.log(`  profiles here            : ${profiles.length}`);
  console.log(`  accounts in Firebase     : ${firebaseUsers.length}`);
  console.log(`  need a Firebase account  : ${toCreate.length}${toCreate.length ? ' -> ' + toCreate.map((p) => p.email).join(', ') : ''}`);
  console.log(`  already there, to link   : ${toLink.length}${toLink.length ? ' -> ' + toLink.map((x) => x.profile.email).join(', ') : ''}`);
  console.log(`  in Firebase but no profile: ${orphans.length}${orphans.length ? ' -> ' + orphans.map((u) => u.email).join(', ') : ''}`);

  const stale = profiles.filter((p) => p.firebase_uid && p.password_hash);
  if (stale.length) {
    console.log(`  stale local password hashes: ${stale.length} -> ${stale.map((p) => p.email).join(', ')}`);
    console.log('    (these will be cleared - a Firebase account should have no local password)');
  }

  if (!YES) {
    console.log('\nNothing changed. Re-run with --yes to apply.');
    console.log('Accounts that must be created get a new password, printed here.\n');
    process.exit(0);
  }

  console.log('');
  const created = [];

  for (const p of toCreate) {
    const password = FIXED || newPassword();
    try {
      const uid = await FA.createUser({ email: p.email, password, name: p.name, role: p.role });
      // Drop the old local hash. Leaving it behind means the previous password
      // would quietly work again if AUTH_PROVIDER were ever switched back.
      await S.updateUser(p.id, { firebase_uid: uid, password_hash: null });
      created.push({ email: p.email, role: p.role, password });
      console.log(`  created  ${p.email}`);
    } catch (e) {
      console.log(`  FAILED   ${p.email}: ${e.message.slice(0, 80)}`);
    }
  }

  for (const { profile, uid } of toLink) {
    await S.updateUser(profile.id, { firebase_uid: uid, password_hash: null });
    await FA.setRole(uid, profile.role);
    console.log(`  linked   ${profile.email}`);
  }

  for (const p of stale) {
    await S.updateUser(p.id, { password_hash: null });
    console.log(`  cleared  ${p.email} (stale local password removed)`);
  }

  if (created.length) {
    console.log('\n  New passwords - note these down, they are not stored anywhere:\n');
    for (const c of created) {
      console.log(`    ${c.email.padEnd(28)} ${c.password}   (${c.role})`);
    }
  }

  console.log('\nDone. Set AUTH_PROVIDER=firebase in .env to start using these accounts.\n');
  process.exit(0);
})().catch((e) => { console.error('\nSync failed:', e.message, '\n'); process.exit(1); });

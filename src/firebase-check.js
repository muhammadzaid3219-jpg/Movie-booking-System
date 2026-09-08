'use strict';
/**
 * Verifies the Firebase setup end to end:  npm run firebase:check
 * Writes one temporary document, reads it back, then deletes it.
 */
const F = require('./firestore');

const ok = (m) => console.log('  OK    ' + m);
const bad = (m) => console.log('  FAIL  ' + m);

(async () => {
  console.log('\nChecking Firebase setup...\n');

  if (!F.isConfigured()) {
    bad('No service-account key found.');
    console.log(`
  Do this:
    1. https://console.firebase.google.com  ->  your project
    2. Gear icon -> Project settings -> Service accounts
    3. "Generate new private key" -> Generate key
    4. Save the downloaded file as:

       ${F.KEY_PATH}
`);
    process.exit(1);
  }

  let project;
  try {
    project = F.projectId();
    ok('Key file found and readable');
    ok('Project: ' + project);
  } catch (e) {
    bad(e.message);
    process.exit(1);
  }

  const db = F.db();
  const ref = db.collection('_healthcheck').doc('ping');

  try {
    await ref.set({ at: new Date().toISOString(), from: 'movie-booking-system' });
    ok('Write succeeded');

    const snap = await ref.get();
    if (!snap.exists) throw new Error('document did not come back');
    ok('Read succeeded -> ' + JSON.stringify(snap.data()));

    await ref.delete();
    ok('Delete succeeded');

    console.log('\nFirestore is connected and working.\n');
    console.log('Next step:  npm run migrate\n');
    process.exit(0);
  } catch (e) {
    bad('Could not talk to Firestore: ' + e.message);
    if (String(e.message).includes('NOT_FOUND') || String(e.code) === '5') {
      console.log(`
  This usually means the Firestore database has not been created yet.
  In the Firebase console: Build -> Firestore Database -> Create database
  (pick "Start in production mode", location asia-south1).
`);
    }
    if (String(e.message).includes('PERMISSION_DENIED')) {
      console.log('\n  The key may belong to a different project, or the API is not enabled yet.\n');
    }
    process.exit(1);
  }
})();

'use strict';
/**
 * Cloud Firestore connection.
 *
 * Credentials come from the shared Firebase app in firebaseapp.js, so every
 * Firebase product in this project uses one consistently configured instance.
 */
const App = require('./firebaseapp');

let firestore = null;

/** Lazily connects and returns the Firestore instance. */
function db() {
  if (firestore) return firestore;
  firestore = require('firebase-admin/firestore').getFirestore(App.get());
  firestore.settings({ ignoreUndefinedProperties: true });
  return firestore;
}

const FieldValue = () => require('firebase-admin/firestore').FieldValue;
const Timestamp = () => require('firebase-admin/firestore').Timestamp;

module.exports = {
  db, FieldValue, Timestamp,
  isConfigured: App.isConfigured,
  projectId: App.projectId,
  KEY_PATH: App.KEY_PATH,
};

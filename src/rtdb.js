'use strict';
/**
 * Firebase Realtime Database connection.
 *
 * Realtime Database is a separate product from Cloud Firestore with its own,
 * separate free-tier allowance - billed on stored bytes and bandwidth rather
 * than per-document reads.
 */
const App = require('./firebaseapp');

let database = null;

function db() {
  if (database) return database;
  database = require('firebase-admin/database').getDatabase(App.get());
  return database;
}

module.exports = {
  db,
  isConfigured: App.isConfigured,
  projectId: App.projectId,
  databaseURL: App.databaseURL,
  KEY_PATH: App.KEY_PATH,
};

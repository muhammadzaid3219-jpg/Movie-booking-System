'use strict';
/**
 * Picks the cloud data layer for the configured driver.
 *
 * fstore.js (Cloud Firestore) and rtdbstore.js (Realtime Database) expose the
 * same functions, so the route files in src/routes/cloud/ work against either
 * one without a single change.
 */
const config = require('./config');

module.exports = config.driver === 'rtdb'
  ? require('./rtdbstore')
  : require('./fstore');

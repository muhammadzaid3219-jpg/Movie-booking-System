'use strict';
/**
 * Cloud Function entry point, used by `firebase deploy`.
 *
 * Firebase Hosting serves the pages in public/ and forwards every /api/** request
 * to this function, which runs the same Express app as `npm start`.
 * Locally, keep using `npm start` - this file is only for the deployed site.
 */
const { onRequest } = require('firebase-functions/v2/https');
const app = require('./server');

exports.api = onRequest(
  {
    region: 'us-central1',   // must match the region in firebase.json's rewrite
    memory: '512MiB',
    timeoutSeconds: 60,
    maxInstances: 3,         // a hard cap on cost if something loops or is abused
    concurrency: 80,
  },
  app
);

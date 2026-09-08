'use strict';
/**
 * Every tunable value and secret in one place, all overridable by environment.
 * Nothing secret is hardcoded: APP_SECRET must be set in production, and the
 * Firebase key is a git-ignored file, never a literal in the source.
 */
const path = require('node:path');
const fs = require('node:fs');

/* Load .env if present. Node 20.6+ ships this, so no dotenv dependency. */
const ENV_FILE = path.join(__dirname, '..', '.env');
if (fs.existsSync(ENV_FILE) && typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(ENV_FILE); } catch (e) { console.warn('Could not read .env:', e.message); }
}

const num = (v, fallback) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? fallback : Number(v));
const bool = (v, fallback) => (v === undefined ? fallback : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProd = NODE_ENV === 'production';

const config = {
  env: NODE_ENV,
  isProd,
  port: num(process.env.PORT, 3000),

  /** 'firestore' (default) or 'sqlite'. */
  driver: (process.env.DB_DRIVER || 'firestore').toLowerCase(),

  /** Signs session cookies. Must be set in production. */
  secret: process.env.APP_SECRET || 'dev-only-secret-change-me',

  session: {
    days: num(process.env.SESSION_DAYS, 7),
    cookieName: process.env.SESSION_COOKIE || 'mbs_token',
    /** Cookies go secure-only once you are behind HTTPS. */
    secure: bool(process.env.COOKIE_SECURE, isProd),
  },

  auth: {
    /**
     * 'local'    passwords hashed with scrypt in this app's own database
     * 'firebase' accounts live in Firebase Authentication and appear in its console
     */
    provider: (process.env.AUTH_PROVIDER || 'local').toLowerCase(),
  },

  booking: {
    holdMinutes: num(process.env.HOLD_MINUTES, 8),
    maxSeats: num(process.env.MAX_SEATS_PER_BOOKING, 10),
    /** Percentage added to the subtotal, shown as a separate line on the summary. */
    serviceFeePercent: num(process.env.SERVICE_FEE_PERCENT, 5),
    /** Flat per-ticket booking fee. */
    bookingFeePerSeat: num(process.env.BOOKING_FEE_PER_SEAT, 20),
    /** Cancellation is refused once the show is this close. */
    cancelCutoffMinutes: num(process.env.CANCEL_CUTOFF_MINUTES, 60),
  },

  payment: {
    /** 'mock' simulates a gateway. Swap for 'stripe' etc. once keys exist. */
    provider: process.env.PAYMENT_PROVIDER || 'mock',
    currency: process.env.CURRENCY || 'PKR',
    currencySymbol: process.env.CURRENCY_SYMBOL || 'Rs',
    /** Fraction of mock payments that fail, so the failure path stays testable. */
    mockFailureRate: num(process.env.MOCK_FAILURE_RATE, 0),
  },

  uploads: {
    maxBytes: num(process.env.UPLOAD_MAX_BYTES, 5 * 1024 * 1024),
  },

  passwordReset: {
    ttlMinutes: num(process.env.RESET_TTL_MINUTES, 30),
    /**
     * With no mail service wired up, the reset link is returned by the API so it
     * can be shown on screen. Turn this off once real email is connected.
     */
    revealLink: bool(process.env.RESET_REVEAL_LINK, !isProd),
  },
};

if (isProd && config.secret === 'dev-only-secret-change-me') {
  console.error('\n  APP_SECRET is not set. Refusing to start in production with the default secret.\n');
  process.exit(1);
}

module.exports = config;

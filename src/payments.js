'use strict';
/**
 * Payment abstraction.
 *
 * Routes only ever call `charge()` and get back a normalised result, so a real
 * gateway can be dropped in by adding a provider here - no route changes, and
 * no card data ever reaches this server.
 */
const crypto = require('node:crypto');
const config = require('./config');

const METHODS = [
  { id: 'card', label: 'Credit / Debit Card', instant: true },
  { id: 'easypaisa', label: 'Easypaisa', instant: true },
  { id: 'jazzcash', label: 'JazzCash', instant: true },
  { id: 'wallet', label: 'Cineplex Wallet', instant: true },
  { id: 'counter', label: 'Pay at the Counter', instant: false },
];

const isValidMethod = (id) => METHODS.some((m) => m.id === id);
const newTxnRef = () => 'TXN' + crypto.randomBytes(6).toString('hex').toUpperCase();

/**
 * Simulated gateway. Approves immediately, except that counter payments stay
 * PENDING (paid in person) and a configurable share fail, so the failure path
 * can actually be exercised.
 */
const mockProvider = {
  name: 'mock',
  async charge({ amount, method, bookingRef }) {
    await new Promise((r) => setTimeout(r, 250));   // stand-in for network latency

    if (method === 'counter') {
      return {
        status: 'PENDING',
        txn_ref: newTxnRef(),
        message: 'Reserved. Pay at the counter before the show starts.',
      };
    }
    if (config.payment.mockFailureRate > 0 && Math.random() < config.payment.mockFailureRate) {
      return {
        status: 'FAILED',
        txn_ref: newTxnRef(),
        message: 'The payment was declined by the issuing bank. Please try another method.',
      };
    }
    return {
      status: 'PAID',
      txn_ref: newTxnRef(),
      message: `Payment of ${config.payment.currencySymbol} ${amount} received for ${bookingRef}.`,
    };
  },
};

/**
 * Placeholder for a real gateway. Kept deliberately explicit so nobody wires up
 * a live provider without also handling redirects and webhooks.
 */
const unimplementedProvider = (name) => ({
  name,
  async charge() {
    return {
      status: 'FAILED',
      txn_ref: newTxnRef(),
      message: `The "${name}" payment provider is not configured on this server yet.`,
    };
  },
});

const PROVIDERS = {
  mock: mockProvider,
  stripe: unimplementedProvider('stripe'),
  easypaisa: unimplementedProvider('easypaisa'),
  jazzcash: unimplementedProvider('jazzcash'),
};

const provider = () => PROVIDERS[config.payment.provider] || mockProvider;

/**
 * Charges a booking.
 * @returns {{status:'PAID'|'PENDING'|'FAILED', txn_ref:string, message:string, provider:string}}
 */
async function charge({ amount, method, bookingRef, userId }) {
  if (!isValidMethod(method)) {
    return { status: 'FAILED', txn_ref: null, message: 'Unknown payment method', provider: provider().name };
  }
  if (!(amount >= 0)) {
    return { status: 'FAILED', txn_ref: null, message: 'Invalid amount', provider: provider().name };
  }
  const result = await provider().charge({ amount, method, bookingRef, userId });
  return { ...result, provider: provider().name };
}

/**
 * Money is always recomputed here from the server's own seat prices - never
 * from anything the browser sent.
 */
function priceBooking(seatPrices, discount = 0) {
  const subtotal = seatPrices.reduce((sum, p) => sum + p, 0);
  const bookingFee = config.booking.bookingFeePerSeat * seatPrices.length;
  const serviceFee = Math.round(((subtotal - discount) * config.booking.serviceFeePercent) / 100);
  const total = Math.max(0, subtotal - discount + bookingFee + serviceFee);
  return {
    subtotal,
    discount,
    booking_fee: bookingFee,
    service_fee: serviceFee,
    total_amount: total,
  };
}

module.exports = { METHODS, isValidMethod, charge, priceBooking, newTxnRef };

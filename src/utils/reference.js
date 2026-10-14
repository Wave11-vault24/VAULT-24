'use strict';

const crypto = require('crypto');

// Crockford base32: no I, L, O, U to avoid misreading on receipts.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomCode(length) {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
  return out;
}

/**
 * Receipt reference like DEP-20261014-7K3QX9MZ2A. Contains the UTC date and
 * 10 random characters (~50 bits), never an internal database ID.
 */
function generateReference(prefix) {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `${prefix}-${date}-${randomCode(10)}`;
}

module.exports = { generateReference, randomCode };

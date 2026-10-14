'use strict';

const argon2 = require('argon2');

// OWASP-recommended Argon2id baseline (19 MiB, 2 iterations, 1 lane).
const HASH_OPTIONS = Object.freeze({ type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });

async function hashPassword(plain) {
  return argon2.hash(plain, HASH_OPTIONS);
}

async function verifyPassword(hash, plain) {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

/** Minimum policy: 12+ chars with upper, lower and digit. */
function isStrongPassword(pw) {
  return typeof pw === 'string' && pw.length >= 12 && pw.length <= 128
    && /[a-z]/.test(pw) && /[A-Z]/.test(pw) && /\d/.test(pw);
}

module.exports = { hashPassword, verifyPassword, isStrongPassword };

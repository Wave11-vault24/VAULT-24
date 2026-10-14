'use strict';

const crypto = require('crypto');
const { ACCOUNT_TYPES } = require('../config/constants');

/**
 * Fictional account number: V24 + 2-digit product code + 8 random digits.
 *   savings  -> V2410xxxxxxxx
 *   student  -> V2420xxxxxxxx
 *   salary   -> V2430xxxxxxxx
 *   business -> V2440xxxxxxxx
 * Random (not sequential) so numbers don't reveal how many accounts exist.
 * Uniqueness is guaranteed by the UNIQUE constraint; callers retry on collision.
 */
function generateAccountNumber(accountType) {
  const type = ACCOUNT_TYPES[accountType];
  if (!type) throw new Error(`Unsupported account type: ${accountType}`);
  const random = crypto.randomInt(0, 100_000_000).toString().padStart(8, '0');
  return `V24${type.code}${random}`;
}

function accountTypeFromNumber(accountNumber) {
  const code = String(accountNumber).slice(3, 5);
  return Object.keys(ACCOUNT_TYPES).find((k) => ACCOUNT_TYPES[k].code === code) || null;
}

module.exports = { generateAccountNumber, accountTypeFromNumber };

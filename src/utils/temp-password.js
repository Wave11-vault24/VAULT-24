'use strict';

const crypto = require('crypto');

/**
 * One-time temporary password, e.g. "Vt7-kQ2m-Xr9p-Hd4w". Always contains
 * upper, lower and digits so it satisfies the password policy. Returned to the
 * staff member once, never stored in plain text, and must be changed at first login.
 */
function generateTempPassword() {
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const upper = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  const digit = '23456789';
  const all = lower + upper + digit;
  const pick = (set) => set[crypto.randomInt(0, set.length)];
  const groups = [];
  for (let g = 0; g < 4; g++) groups.push(pick(upper) + pick(lower) + pick(digit) + pick(all));
  return groups.join('-');
}

module.exports = { generateTempPassword };

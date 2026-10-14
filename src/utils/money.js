'use strict';

/** Format integer minor units as a decimal string using integer maths only. 50000 -> "500.00" */
function formatMinor(minor) {
  const n = BigInt(minor);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

module.exports = { formatMinor };

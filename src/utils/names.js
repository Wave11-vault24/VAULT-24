'use strict';

/**
 * Account-name normalisation policy used to compare a teller-entered name
 * with the authoritative account name:
 *   1. Unicode NFKC normalisation (full-width letters, ligatures -> plain)
 *   2. Trim leading/trailing whitespace
 *   3. Collapse any run of internal whitespace to one space
 *   4. Lower-case
 * The normalised strings must then match exactly. No fuzzy matching, no
 * dropping of words or initials: "Jane Mwangi" != "J. Mwangi".
 */
function normalizeName(name) {
  return String(name).normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function namesMatch(supplied, authoritative) {
  return normalizeName(supplied) === normalizeName(authoritative);
}

/** Tidy a person's name for storage: NFKC, trimmed, single-spaced, case kept. */
function cleanName(name) {
  return String(name).normalize('NFKC').trim().replace(/\s+/g, ' ');
}

module.exports = { normalizeName, namesMatch, cleanName };

'use strict';

/** Current UTC timestamp in the project-wide format: 2026-10-14T20:48:00.000Z */
function nowUtc() {
  return new Date().toISOString();
}

module.exports = { nowUtc };

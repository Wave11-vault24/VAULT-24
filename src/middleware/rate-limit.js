'use strict';

const { rateLimit } = require('express-rate-limit');

/**
 * Per-route rate limiters. In-memory store: fine for one process; a
 * multi-instance deployment would need a shared store.
 * Authenticated limiters key on user ID so one user can't dodge limits by
 * changing IP; login keys on IP.
 */
function buildLimiters({ enabled = true } = {}) {
  const make = (name, windowMs, limit, keyByUser) => rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => !enabled,
    keyGenerator: keyByUser
      ? (req) => (req.user ? `u:${req.user.id}` : `ip:${req.ip}`)
      : undefined,
    validate: keyByUser ? { keyGeneratorIpFallback: false } : undefined,
    handler: (req, res) => res.status(429).json({
      error: { code: 'RATE_LIMITED', message: `Too many ${name} requests. Please wait and try again.`, request_id: req.id },
    }),
  });

  return {
    login: make('login', 15 * 60 * 1000, 10, false),
    customerCreate: make('registration', 60 * 60 * 1000, 30, true),
    upload: make('upload', 60 * 60 * 1000, 30, true),
    deposit: make('deposit', 60 * 1000, 20, true),
    transfer: make('transfer', 60 * 1000, 10, true),
  };
}

module.exports = { buildLimiters };

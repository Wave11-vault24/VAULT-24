'use strict';

const crypto = require('crypto');
const { AppError } = require('../utils/errors');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Synchronizer-token CSRF protection.
 *  - GET /api/auth/csrf-token returns a random token stored in the session.
 *  - Every state-changing request (including login) must echo it in the
 *    X-CSRF-Token header. A cross-site attacker can make the browser send the
 *    cookie but cannot read the token, so the request is rejected.
 *  - Combined with SameSite=Strict cookies as a second layer.
 */
function issueCsrfToken(req) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  return req.session.csrfToken;
}

function csrfProtection(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const expected = req.session && req.session.csrfToken;
  const supplied = req.get('X-CSRF-Token');
  if (expected && typeof supplied === 'string' && supplied.length === expected.length
    && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    return next();
  }
  return next(new AppError(403, 'CSRF_INVALID', 'Missing or invalid CSRF token.'));
}

module.exports = { csrfProtection, issueCsrfToken };

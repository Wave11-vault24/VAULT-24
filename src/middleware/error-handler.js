'use strict';

const { AppError } = require('../utils/errors');

function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found.', request_id: req.id } });
}

/**
 * Centralised error handler. Only AppError messages reach the client; anything
 * else (SQL errors, stack traces, file paths) becomes a generic 500 and is
 * logged server-side with the request ID only.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // Malformed JSON / oversized body from express.json()
  if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
    const status = err.type === 'entity.too.large' ? 413 : 400;
    return res.status(status).json({
      error: { code: status === 413 ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST', message: 'Request body is invalid or too large.', request_id: req.id },
    });
  }

  if (err instanceof AppError) {
    const body = { code: err.code, message: err.message, request_id: req.id };
    if (err.details) body.details = err.details;
    return res.status(err.status).json({ error: body });
  }

  if (process.env.NODE_ENV !== 'test') {
    // Log only the error name/code, not request bodies or headers.
    console.error(`[${req.id}] Unhandled error: ${err && err.name}${err && err.code ? ` (${err.code})` : ''}`);
  }
  return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', request_id: req.id } });
}

module.exports = { errorHandler, notFoundHandler };

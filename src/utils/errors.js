'use strict';

/** An error whose message is safe to show to API clients. */
class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = true;
  }
}

const badRequest = (msg = 'Invalid request.', details) => new AppError(400, 'BAD_REQUEST', msg, details);
const unauthorized = (msg = 'Authentication required.') => new AppError(401, 'UNAUTHORIZED', msg);
const forbidden = (msg = 'You do not have permission to perform this action.') => new AppError(403, 'FORBIDDEN', msg);
const notFound = (msg = 'Resource not found.') => new AppError(404, 'NOT_FOUND', msg);
const conflict = (msg = 'Conflict.') => new AppError(409, 'CONFLICT', msg);

module.exports = { AppError, badRequest, unauthorized, forbidden, notFound, conflict };

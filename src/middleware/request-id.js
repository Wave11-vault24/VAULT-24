'use strict';

const crypto = require('crypto');

/** Attach a server-generated correlation ID to every request and response. */
function requestId(req, res, next) {
  req.id = crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}

module.exports = requestId;

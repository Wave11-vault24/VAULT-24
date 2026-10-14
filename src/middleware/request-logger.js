'use strict';

/**
 * One line per request: request ID, method, path (no query string), status,
 * duration and user ID. Never logs bodies, headers, cookies or query strings,
 * so passwords, CSRF tokens and session IDs can't leak into logs.
 */
function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const pathOnly = (req.originalUrl || req.url).split('?')[0];
    const user = req.user ? ` user=${req.user.id}` : '';
    console.log(`[${req.id}] ${req.method} ${pathOnly} ${res.statusCode} ${ms.toFixed(1)}ms${user}`);
  });
  next();
}

module.exports = requestLogger;

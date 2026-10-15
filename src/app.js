'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const session = require('express-session');

const { SqliteSessionStore } = require('./config/session-store');
const { LIMITS } = require('./config/constants');
const requestId = require('./middleware/request-id');
const requestLogger = require('./middleware/request-logger');
const { csrfProtection } = require('./middleware/csrf');
const { buildLimiters } = require('./middleware/rate-limit');
const { errorHandler, notFoundHandler } = require('./middleware/error-handler');

const SESSION_COOKIE = 'vault24.sid';
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

/**
 * Build the Express app. The database handle and config are injected so tests
 * can run against an isolated database.
 * options.rateLimit = false disables limiters (used by most tests).
 */
function createApp({ db, config, options = {} }) {
  if (!db || !config) throw new Error('createApp requires { db, config }');

  const app = express();
  const sessionStore = new SqliteSessionStore({ db, cleanupIntervalMs: config.isTest ? 0 : 15 * 60 * 1000 });
  const limiters = buildLimiters({ enabled: options.rateLimit !== false });

  app.locals.db = db;
  app.locals.config = config;
  app.locals.sessionStore = sessionStore;
  app.locals.sessionCookieName = SESSION_COOKIE;

  app.disable('x-powered-by');
  if (config.isProduction) app.set('trust proxy', 1);

  app.use(requestId);
  if (!config.isTest) app.use(requestLogger);
  app.use(helmet());
  app.use(cors({
    origin: config.FRONTEND_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'X-CSRF-Token'],
    exposedHeaders: ['X-Request-Id', 'Idempotent-Replayed'],
  }));
  app.use(express.json({ limit: '20kb' }));

  // Banking data must never be cached by browsers or proxies.
  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  app.get('/api/health', (req, res) => {
    let database = 'ok';
    try {
      db.prepare('SELECT 1').get();
    } catch {
      database = 'unavailable';
    }
    res.status(database === 'ok' ? 200 : 503).json({ status: database === 'ok' ? 'ok' : 'degraded', database });
  });

  // Frontend (same origin as the API, so cookies + CSRF need no CORS).
  // Served before the session middleware so static files never create sessions.
  // HTML is revalidated on every load; assets may be cached briefly.
  app.use(express.static(PUBLIC_DIR, {
    index: 'index.html',
    extensions: ['html'],
    dotfiles: 'ignore',
    setHeaders(res, filePath) {
      res.set('Cache-Control', filePath.endsWith('.html') ? 'no-cache' : 'public, max-age=3600');
    },
  }));

  app.use(session({
    name: SESSION_COOKIE,
    secret: config.SESSION_SECRET,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    rolling: true, // idle timeout: each request extends the session
    unset: 'destroy',
    cookie: {
      httpOnly: true,
      secure: config.isProduction, // HTTPS-only cookies in production
      sameSite: 'strict',
      maxAge: LIMITS.SESSION_IDLE_MS,
    },
  }));
  app.use('/api', csrfProtection);

  app.use('/api/auth', require('./routes/auth.routes')({ limiters }));
  app.use('/api/staff/deposits', require('./routes/deposits.routes')({ limiters }));
  app.use('/api/staff', require('./routes/staff.routes')({ limiters, config }));
  app.use('/api/accounts', require('./routes/accounts.routes')({ config }));
  app.use('/api/transfers', require('./routes/transfers.routes')({ limiters }));
  app.use('/api/profile', require('./routes/profile.routes')());
  app.use('/api/documents', require('./routes/documents.routes')({ config }));
  app.use('/api/admin', require('./routes/admin.routes')());

  // Unknown non-API page in a browser -> friendly HTML 404; API clients keep JSON.
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api') && req.accepts(['html', 'json']) === 'html') {
      return res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'));
    }
    return next();
  });
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp, SESSION_COOKIE };

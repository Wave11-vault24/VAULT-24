'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');

const requestId = require('./middleware/request-id');
const { errorHandler, notFoundHandler } = require('./middleware/error-handler');

/**
 * Build the Express app. The database handle and config are injected so tests
 * can run against an isolated database.
 */
function createApp({ db, config }) {
  if (!db || !config) throw new Error('createApp requires { db, config }');

  const app = express();
  app.locals.db = db;
  app.locals.config = config;

  app.disable('x-powered-by');
  if (config.isProduction) app.set('trust proxy', 1);

  app.use(requestId);
  app.use(helmet());
  app.use(cors({
    origin: config.FRONTEND_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  }));
  app.use(express.json({ limit: '20kb' }));

  app.get('/api/health', (req, res) => {
    let database = 'ok';
    try {
      db.prepare('SELECT 1').get();
    } catch {
      database = 'unavailable';
    }
    res.status(database === 'ok' ? 200 : 503).json({ status: database === 'ok' ? 'ok' : 'degraded', database });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };

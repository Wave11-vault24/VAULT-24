'use strict';

const { config } = require('./config/env');
const { openDatabase } = require('./config/database');
const { migrate } = require('./db/migrate');
const { createApp } = require('./app');

const db = openDatabase(config.DATABASE_PATH);
const applied = migrate(db);
if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);
if (config.usingFallbackSecret) console.warn('WARNING: SESSION_SECRET not set; using an insecure development fallback.');

if (!config.rateLimitEnabled) console.warn('WARNING: rate limiting disabled (DISABLE_RATE_LIMIT=true). Never use this outside tests.');
const app = createApp({ db, config, options: { rateLimit: config.rateLimitEnabled } });
const server = app.listen(config.PORT, () => {
  console.log(`Vault24 API listening on port ${config.PORT} (${config.NODE_ENV})`);
});

function shutdown() {
  server.close(() => {
    app.locals.sessionStore.close();
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

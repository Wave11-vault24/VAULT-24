'use strict';

const { config } = require('../src/config/env');
const { openDatabase } = require('../src/config/database');
const { migrate } = require('../src/db/migrate');

const db = openDatabase(config.DATABASE_PATH);
try {
  const applied = migrate(db);
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
} finally {
  db.close();
}

'use strict';

const { openDatabase } = require('../src/config/database');
const { migrate } = require('../src/db/migrate');
const { loadConfig } = require('../src/config/env');

/** Fresh, isolated, fully-migrated in-memory database per test file. */
function createTestDb() {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}

function testConfig(overrides = {}) {
  return loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:', ...overrides });
}

// A syntactically valid Argon2id-shaped hash for direct DB fixtures (no real password).
const FAKE_HASH = '$argon2id$v=19$m=19456,t=2,p=1$ZmFrZXNhbHQ$ZmFrZWhhc2g';

/** Insert fixture users directly (bypasses services; for schema tests only). */
function insertUser(db, { role = 'customer', email, createdBy = null, name = 'Test User' } = {}) {
  const e = email || `${role}.${Math.random().toString(36).slice(2)}@vault24.test`;
  return Number(db.prepare(
    'INSERT INTO users (full_name, email, password_hash, role, created_by) VALUES (?, ?, ?, ?, ?)',
  ).run(name, e, FAKE_HASH, role, createdBy).lastInsertRowid);
}

module.exports = { createTestDb, testConfig, insertUser, FAKE_HASH };

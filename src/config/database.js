'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

/**
 * Open a SQLite connection with the pragmas every Vault24 connection needs.
 * foreign_keys is per-connection in SQLite, so it must be set here every time.
 */
function openDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000'); // wait up to 5s for the single writer lock
  if (dbPath !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  if (db.pragma('foreign_keys', { simple: true }) !== 1) {
    throw new Error('Failed to enable SQLite foreign key enforcement.');
  }
  return db;
}

/**
 * Run fn inside a BEGIN IMMEDIATE transaction so the write lock is taken up
 * front. This avoids read-then-upgrade deadlocks and SQLITE_BUSY mid-way
 * through a financial operation. Any throw rolls the whole thing back.
 */
function withWriteTransaction(db, fn) {
  return db.transaction(fn).immediate();
}

module.exports = { openDatabase, withWriteTransaction };

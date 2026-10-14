'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'migrations');

/**
 * Apply every pending migrations/NNN_name.sql file, in order, each in its own
 * transaction. A checksum is stored so an already-applied file that was later
 * edited is detected instead of silently ignored.
 */
function migrate(db, dir = MIGRATIONS_DIR) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);

  const files = fs.readdirSync(dir).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort();
  const applied = new Map(
    db.prepare('SELECT version, checksum FROM schema_migrations').all().map((r) => [r.version, r.checksum]),
  );

  const newlyApplied = [];
  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const checksum = crypto.createHash('sha256').update(sql).digest('hex');

    if (applied.has(file)) {
      if (applied.get(file) !== checksum) {
        throw new Error(`Migration ${file} was modified after being applied. Create a new migration instead.`);
      }
      continue;
    }

    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, checksum) VALUES (?, ?)').run(file, checksum);
    })();
    newlyApplied.push(file);
  }
  return newlyApplied;
}

module.exports = { migrate, MIGRATIONS_DIR };

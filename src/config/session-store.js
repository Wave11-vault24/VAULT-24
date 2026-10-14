'use strict';

const session = require('express-session');

/**
 * Minimal express-session store backed by the `sessions` table created in
 * migration 001. Written in-house (≈60 lines) so its behaviour is easy to
 * explain and its cleanup timer can be stopped cleanly.
 */
class SqliteSessionStore extends session.Store {
  constructor({ db, cleanupIntervalMs = 15 * 60 * 1000 } = {}) {
    super();
    this.db = db;
    this.stmts = {
      get: db.prepare("SELECT sess FROM sessions WHERE sid = ? AND expire > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"),
      set: db.prepare(`INSERT INTO sessions (sid, sess, expire) VALUES (?, ?, ?)
                       ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expire = excluded.expire`),
      destroy: db.prepare('DELETE FROM sessions WHERE sid = ?'),
      touch: db.prepare('UPDATE sessions SET expire = ? WHERE sid = ?'),
      clearExpired: db.prepare("DELETE FROM sessions WHERE expire <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"),
      destroyForUser: db.prepare("DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ?"),
    };
    if (cleanupIntervalMs > 0) {
      this.timer = setInterval(() => this.clearExpired(), cleanupIntervalMs);
      this.timer.unref(); // never keep the process alive just for cleanup
    }
  }

  static expiryOf(sess) {
    const ms = sess && sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86_400_000;
    return new Date(ms).toISOString();
  }

  get(sid, cb) {
    try {
      const row = this.stmts.get.get(sid);
      cb(null, row ? JSON.parse(row.sess) : null);
    } catch (err) { cb(err); }
  }

  set(sid, sess, cb = () => {}) {
    try {
      this.stmts.set.run(sid, JSON.stringify(sess), SqliteSessionStore.expiryOf(sess));
      cb(null);
    } catch (err) { cb(err); }
  }

  touch(sid, sess, cb = () => {}) {
    try {
      this.stmts.touch.run(SqliteSessionStore.expiryOf(sess), sid);
      cb(null);
    } catch (err) { cb(err); }
  }

  destroy(sid, cb = () => {}) {
    try {
      this.stmts.destroy.run(sid);
      cb(null);
    } catch (err) { cb(err); }
  }

  /** Remove every session belonging to a user (used on suspend/lock and password change). */
  destroyAllForUser(userId) {
    return this.stmts.destroyForUser.run(userId).changes;
  }

  clearExpired() {
    try { this.stmts.clearExpired.run(); } catch { /* database closed during shutdown */ }
  }

  close() {
    if (this.timer) clearInterval(this.timer);
  }
}

module.exports = { SqliteSessionStore };

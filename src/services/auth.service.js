'use strict';

const { hashPassword, verifyPassword } = require('../utils/password');
const { AppError, unauthorized, badRequest } = require('../utils/errors');
const { LIMITS } = require('../config/constants');
const audit = require('./audit.service');

// Verifying against a dummy hash when the email is unknown keeps response time
// similar, so attackers can't discover which emails exist by timing.
let dummyHashPromise;
const dummyHash = () => (dummyHashPromise ||= hashPassword('dummy-password-for-timing-equalisation-1A'));

const GENERIC_LOGIN_ERROR = 'Invalid email or password.';

/**
 * Check credentials. Returns the user row on success.
 * Lockout: MAX_FAILED_LOGINS consecutive failures set status = 'locked';
 * only an administrator can unlock.
 * A wrong password always yields the same generic message. Only a CORRECT
 * password for an inactive user reveals that the user is inactive.
 */
async function login(db, { email, password, requestId }) {
  const user = db.prepare(
    'SELECT id, role, status, password_hash, must_change_password, failed_login_attempts FROM users WHERE email = ?',
  ).get(email);

  if (!user) {
    await verifyPassword(await dummyHash(), password);
    audit.recordSafe(db, { action: 'auth.login', targetType: 'user', outcome: 'failure', requestId, metadata: { reason: 'unknown_email' } });
    throw unauthorized(GENERIC_LOGIN_ERROR);
  }

  const ok = await verifyPassword(user.password_hash, password);

  if (!ok) {
    if (user.status === 'active') {
      const attempts = user.failed_login_attempts + 1;
      const lock = attempts >= LIMITS.MAX_FAILED_LOGINS;
      db.prepare(`UPDATE users SET failed_login_attempts = ?, status = CASE WHEN ? THEN 'locked' ELSE status END, updated_at = ?
                  WHERE id = ?`).run(attempts, lock ? 1 : 0, new Date().toISOString(), user.id);
      if (lock) {
        audit.recordSafe(db, { action: 'user.locked', targetType: 'user', targetId: user.id, outcome: 'success', requestId, metadata: { reason: 'too_many_failed_logins' } });
      }
    }
    audit.recordSafe(db, { actorUserId: user.id, action: 'auth.login', targetType: 'user', targetId: user.id, outcome: 'failure', requestId, metadata: { reason: 'bad_password' } });
    throw unauthorized(GENERIC_LOGIN_ERROR);
  }

  if (user.status !== 'active') {
    audit.recordSafe(db, { actorUserId: user.id, action: 'auth.login', targetType: 'user', targetId: user.id, outcome: 'failure', requestId, metadata: { reason: `status_${user.status}` } });
    throw new AppError(403, 'ACCOUNT_INACTIVE', 'This user account is not active. Contact the bank.');
  }

  db.prepare('UPDATE users SET failed_login_attempts = 0 WHERE id = ? AND failed_login_attempts <> 0').run(user.id);
  audit.recordSafe(db, { actorUserId: user.id, action: 'auth.login', targetType: 'user', targetId: user.id, outcome: 'success', requestId });
  return { id: user.id, role: user.role, mustChangePassword: user.must_change_password === 1 };
}

async function changePassword(db, { userId, currentPassword, newPassword, requestId }) {
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
  if (!row || !(await verifyPassword(row.password_hash, currentPassword))) {
    audit.recordSafe(db, { actorUserId: userId, action: 'auth.change_password', targetType: 'user', targetId: userId, outcome: 'failure', requestId, metadata: { reason: 'bad_current_password' } });
    throw badRequest('Current password is incorrect.');
  }
  const newHash = await hashPassword(newPassword);
  db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, failed_login_attempts = 0, updated_at = ? WHERE id = ?')
      .run(newHash, new Date().toISOString(), userId);
    audit.record(db, { actorUserId: userId, action: 'auth.change_password', targetType: 'user', targetId: userId, outcome: 'success', requestId });
  })();
}

module.exports = { login, changePassword, GENERIC_LOGIN_ERROR };

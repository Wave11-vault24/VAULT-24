'use strict';

const { unauthorized, AppError } = require('../utils/errors');

/**
 * Load the signed-in user FROM THE DATABASE on every request, so role and
 * status changes (e.g. an admin suspending someone) take effect immediately.
 * Session data is only trusted for the user ID.
 *
 * Locked/suspended policy: an inactive user cannot use any protected route;
 * their session is destroyed on the spot.
 *
 * Users holding a temporary password may only reach routes created with
 * { allowPasswordChangePending: true } (me, logout, change-password).
 */
function authenticate({ allowPasswordChangePending = false } = {}) {
  return (req, res, next) => {
    const userId = req.session && req.session.userId;
    if (!userId) return next(unauthorized());

    const user = req.app.locals.db.prepare(`
      SELECT id, full_name, email, phone_number, role, status, verification_status, must_change_password
      FROM users WHERE id = ?
    `).get(userId);

    if (!user || user.status !== 'active') {
      return req.session.destroy(() => {
        next(user
          ? new AppError(403, 'ACCOUNT_INACTIVE', 'This user account is not active. Contact the bank.')
          : unauthorized());
      });
    }

    req.user = user;
    if (user.must_change_password && !allowPasswordChangePending) {
      return next(new AppError(403, 'PASSWORD_CHANGE_REQUIRED', 'You must change your temporary password first.'));
    }
    return next();
  };
}

module.exports = authenticate;
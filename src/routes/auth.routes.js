'use strict';

const { Router } = require('express');
const { promisify } = require('util');
const validate = require('../middleware/validate');
const authenticate = require('../middleware/authenticate');
const { issueCsrfToken } = require('../middleware/csrf');
const schemas = require('../validators/schemas');
const authService = require('../services/auth.service');
const userService = require('../services/user.service');
const audit = require('../services/audit.service');

module.exports = function authRoutes({ limiters }) {
  const router = Router();

  // Step 1 for any client: fetch a CSRF token (also creates the session cookie).
  router.get('/csrf-token', (req, res) => {
    res.json({ csrf_token: issueCsrfToken(req) });
  });

  router.post('/login', limiters.login, validate({ body: schemas.auth.login }), async (req, res) => {
    const { email, password } = req.valid.body;
    const result = await authService.login(req.app.locals.db, { email, password, requestId: req.id });

    // New session ID after login prevents session fixation. A fresh CSRF token comes with it.
    await promisify(req.session.regenerate.bind(req.session))();
    req.session.userId = result.id;
    const csrfToken = issueCsrfToken(req);
    await promisify(req.session.save.bind(req.session))();

    res.json({
      user: userService.getProfile(req.app.locals.db, result.id),
      must_change_password: result.mustChangePassword,
      csrf_token: csrfToken,
    });
  });

  router.post('/logout', authenticate({ allowPasswordChangePending: true }), async (req, res) => {
    audit.recordSafe(req.app.locals.db, { ...audit.fromReq(req), action: 'auth.logout', targetType: 'user', targetId: req.user.id });
    await promisify(req.session.destroy.bind(req.session))();
    res.clearCookie(req.app.locals.sessionCookieName);
    res.status(204).end();
  });

  router.get('/me', authenticate({ allowPasswordChangePending: true }), (req, res) => {
    const { must_change_password: mcp, ...user } = req.user;
    res.json({ user, must_change_password: mcp === 1 });
  });

  router.post('/change-password', authenticate({ allowPasswordChangePending: true }), validate({ body: schemas.auth.changePassword }), async (req, res) => {
    const { db, sessionStore } = req.app.locals;
    await authService.changePassword(db, {
      userId: req.user.id, currentPassword: req.valid.body.current_password, newPassword: req.valid.body.new_password, requestId: req.id,
    });
    // Sign out every other session of this user, then rotate this one.
    sessionStore.destroyAllForUser(req.user.id);
    const userId = req.user.id;
    await promisify(req.session.regenerate.bind(req.session))();
    req.session.userId = userId;
    const csrfToken = issueCsrfToken(req);
    await promisify(req.session.save.bind(req.session))();
    res.json({ message: 'Password changed.', csrf_token: csrfToken });
  });

  return router;
};

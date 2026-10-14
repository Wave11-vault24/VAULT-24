'use strict';

const { forbidden } = require('../utils/errors');
const audit = require('../services/audit.service');

/** Allow only the listed roles. Denials are audited. Must run after authenticate(). */
function authorize(...roles) {
  return (req, res, next) => {
    if (req.user && roles.includes(req.user.role)) return next();
    audit.recordSafe(req.app.locals.db, {
      ...audit.fromReq(req),
      action: 'authz.denied',
      targetType: 'route',
      targetId: `${req.method} ${req.baseUrl}${req.route ? req.route.path : ''}`,
      outcome: 'failure',
      metadata: { role: req.user && req.user.role, required: roles },
    });
    return next(forbidden());
  };
}

module.exports = authorize;

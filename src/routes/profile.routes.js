'use strict';

const { Router } = require('express');
const validate = require('../middleware/validate');
const authenticate = require('../middleware/authenticate');
const schemas = require('../validators/schemas');
const userService = require('../services/user.service');

/** Any signed-in user. Only phone_number is editable; everything else is rejected by the strict schema. */
module.exports = function profileRoutes() {
  const router = Router();
  router.use(authenticate());

  router.get('/', (req, res) => {
    res.json({ profile: userService.getProfile(req.app.locals.db, req.user.id) });
  });

  router.patch('/', validate({ body: schemas.users.updateProfile }), (req, res) => {
    res.json({ profile: userService.updateProfile(req.app.locals.db, { user: req.user, changes: req.valid.body, requestId: req.id }) });
  });

  return router;
};

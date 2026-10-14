'use strict';

const { Router } = require('express');
const validate = require('../middleware/validate');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const schemas = require('../validators/schemas');
const depositService = require('../services/deposit.service');

/** POST /api/staff/deposits — teller cash deposit. performed_by always comes from the session. */
module.exports = function depositRoutes({ limiters }) {
  const router = Router();
  router.post('/', authenticate(), authorize('staff'), limiters.deposit, validate({ body: schemas.deposits.create }), (req, res) => {
    const receipt = depositService.postDeposit(req.app.locals.db, { staff: req.user, input: req.valid.body, requestId: req.id });
    res.status(201).json({ receipt });
  });
  return router;
};

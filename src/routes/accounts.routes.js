'use strict';

const { Router } = require('express');
const validate = require('../middleware/validate');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const schemas = require('../validators/schemas');
const accountService = require('../services/account.service');
const { ACCOUNT_TYPES } = require('../config/constants');

module.exports = function accountRoutes({ config }) {
  const router = Router();
  router.use(authenticate());

  // Product catalogue for the frontend (labels and daily limits).
  router.get('/types', (req, res) => {
    res.json({
      account_types: Object.entries(ACCOUNT_TYPES).map(([key, t]) => ({
        account_type: key, label: t.label, number_prefix: `V24${t.code}`, daily_transfer_limit_minor: t.dailyTransferLimitMinor,
      })),
    });
  });

  router.get('/', validate({ query: schemas.accounts.list }), (req, res) => {
    res.json({ accounts: accountService.listAccounts(req.app.locals.db, { user: req.user, customerId: req.valid.query.customer_id }) });
  });

  router.get('/:accountId', validate({ params: schemas.accounts.accountIdParams }), (req, res) => {
    res.json({ account: accountService.getAccount(req.app.locals.db, { user: req.user, accountId: req.valid.params.accountId, requestId: req.id }) });
  });

  router.get('/:accountId/transactions', validate({ params: schemas.accounts.accountIdParams, query: schemas.accounts.history }), (req, res) => {
    res.json(accountService.listTransactions(req.app.locals.db, {
      user: req.user, accountId: req.valid.params.accountId, limit: req.valid.query.limit, beforeId: req.valid.query.before_id, requestId: req.id,
    }));
  });

  // Staff-only account opening. Body: { customer_id, account_type }. No balance, name or number accepted.
  router.post('/', authorize('staff'), validate({ body: schemas.accounts.open }), (req, res) => {
    const account = accountService.openAccount(req.app.locals.db, config, {
      staff: req.user, customerId: req.valid.body.customer_id, accountType: req.valid.body.account_type, requestId: req.id,
    });
    res.status(201).json({ account });
  });

  return router;
};

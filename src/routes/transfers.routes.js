'use strict';

const { Router } = require('express');
const validate = require('../middleware/validate');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const schemas = require('../validators/schemas');
const transferService = require('../services/transfer.service');

module.exports = function transferRoutes({ limiters }) {
  const router = Router();
  router.use(authenticate());

  router.post('/', authorize('customer'), limiters.transfer, validate({ body: schemas.transfers.create }), (req, res) => {
    const { replayed, transfer } = transferService.createTransfer(req.app.locals.db, {
      customer: req.user, input: req.valid.body, requestId: req.id,
    });
    if (replayed) res.set('Idempotent-Replayed', 'true');

    if (transfer.status === 'failed') {
      const messages = {
        INSUFFICIENT_FUNDS: 'Insufficient funds for this transfer.',
        DAILY_LIMIT_EXCEEDED: 'This transfer would exceed the daily limit for this account type.',
      };
      return res.status(422).json({
        error: { code: transfer.failure_reason, message: messages[transfer.failure_reason], request_id: req.id },
        transfer,
      });
    }
    return res.status(replayed ? 200 : 201).json({ transfer });
  });

  router.get('/:reference', validate({ params: schemas.transfers.referenceParams }), (req, res) => {
    res.json({ transfer: transferService.getTransfer(req.app.locals.db, { user: req.user, reference: req.valid.params.reference, requestId: req.id }) });
  });

  return router;
};

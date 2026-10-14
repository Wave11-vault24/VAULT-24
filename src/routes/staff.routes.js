'use strict';

const { Router } = require('express');
const validate = require('../middleware/validate');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const { identityDocumentUpload } = require('../middleware/upload');
const schemas = require('../validators/schemas');
const userService = require('../services/user.service');
const documentService = require('../services/document.service');
const accountService = require('../services/account.service');

/** /api/staff — bank staff only. Admins use /api/admin (separation of duties). */
module.exports = function staffRoutes({ limiters, config }) {
  const router = Router();
  router.use(authenticate(), authorize('staff'));
  const upload = identityDocumentUpload(config.MAX_DOCUMENT_SIZE_BYTES);

  // Register a customer: multipart/form-data with full_name, email, phone_number and identity_document (PDF).
  router.post('/customers', limiters.customerCreate, upload, validate({ body: schemas.users.registerCustomer }), async (req, res) => {
    const result = await userService.registerCustomer(req.app.locals.db, config, {
      staff: req.user, input: req.valid.body, file: req.file, requestId: req.id,
    });
    res.status(201).json(result);
  });

  router.get('/customers', validate({ query: schemas.users.search }), (req, res) => {
    res.json({ customers: userService.searchCustomers(req.app.locals.db, req.valid.query.q) });
  });

  router.get('/customers/:customerId', validate({ params: schemas.users.customerIdParams }), (req, res) => {
    const { db } = req.app.locals;
    const { customerId } = req.valid.params;
    res.json({
      customer: userService.getCustomer(db, customerId),
      accounts: accountService.listAccounts(db, { user: req.user, customerId }),
      documents: documentService.listForCustomer(db, customerId),
    });
  });

  router.post('/customers/:customerId/documents', limiters.upload, validate({ params: schemas.users.customerIdParams }), upload, async (req, res) => {
    const document = documentService.uploadForCustomer(req.app.locals.db, config, {
      staff: req.user, customerId: req.valid.params.customerId, file: req.file, requestId: req.id,
    });
    res.status(201).json({ document });
  });

  router.get('/customers/:customerId/documents', validate({ params: schemas.users.customerIdParams }), (req, res) => {
    res.json({ documents: documentService.listForCustomer(req.app.locals.db, req.valid.params.customerId) });
  });

  // Pre-deposit check: confirm account number and holder name with the customer.
  router.get('/accounts/lookup', validate({ query: schemas.accounts.lookup }), (req, res) => {
    res.json({ account: accountService.lookupForStaff(req.app.locals.db, req.valid.query.account_number) });
  });

  return router;
};

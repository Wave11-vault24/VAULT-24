'use strict';

const { Router } = require('express');
const validate = require('../middleware/validate');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const schemas = require('../validators/schemas');
const userService = require('../services/user.service');
const documentService = require('../services/document.service');
const accountService = require('../services/account.service');
const adminService = require('../services/admin.service');

/** /api/admin — administrators only. There is deliberately no role-change or balance-edit endpoint. */
module.exports = function adminRoutes() {
  const router = Router();
  router.use(authenticate(), authorize('admin'));

  router.post('/staff', validate({ body: schemas.users.createStaff }), async (req, res) => {
    res.status(201).json(await userService.createStaff(req.app.locals.db, { admin: req.user, input: req.valid.body, requestId: req.id }));
  });

  router.get('/users', validate({ query: schemas.users.listUsers }), (req, res) => {
    res.json({ users: userService.listUsers(req.app.locals.db, req.valid.query) });
  });

  router.patch('/users/:userId/status', validate({ params: schemas.users.userIdParams, body: schemas.users.setStatus }), (req, res) => {
    const { db, sessionStore } = req.app.locals;
    res.json({
      user: userService.setUserStatus(db, sessionStore, {
        admin: req.user, userId: req.valid.params.userId, status: req.valid.body.status, reason: req.valid.body.reason, requestId: req.id,
      }),
    });
  });

  router.get('/documents', validate({ query: schemas.documents.list }), (req, res) => {
    res.json({ documents: documentService.listByStatus(req.app.locals.db, req.valid.query.status) });
  });

  router.patch('/documents/:documentId/review', validate({ params: schemas.documents.docIdParams, body: schemas.documents.review }), (req, res) => {
    res.json({
      document: documentService.review(req.app.locals.db, {
        documentId: req.valid.params.documentId, reviewer: req.user, decision: req.valid.body.decision,
        rejectionReason: req.valid.body.rejection_reason, requestId: req.id,
      }),
    });
  });

  router.patch('/accounts/:accountId/status', validate({ params: schemas.accounts.accountIdParams, body: schemas.accounts.setStatus }), (req, res) => {
    res.json({
      account: accountService.setAccountStatus(req.app.locals.db, {
        admin: req.user, accountId: req.valid.params.accountId, status: req.valid.body.status, reason: req.valid.body.reason, requestId: req.id,
      }),
    });
  });

  router.get('/audit-logs', validate({ query: schemas.audit.list }), (req, res) => {
    const q = req.valid.query;
    res.json(adminService.listAuditLogs(req.app.locals.db, { action: q.action, actorUserId: q.actor_user_id, limit: q.limit, beforeId: q.before_id }));
  });

  router.get('/reconciliation', (req, res) => {
    const mismatches = adminService.reconcile(req.app.locals.db);
    res.json({ healthy: mismatches.length === 0, mismatches });
  });

  return router;
};

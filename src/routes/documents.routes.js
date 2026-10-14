'use strict';

const { Router } = require('express');
const validate = require('../middleware/validate');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const schemas = require('../validators/schemas');
const documentService = require('../services/document.service');

/**
 * GET /api/documents/:documentId/download — staff and admins only.
 * The document ID is not a URL to a file; the file is streamed through this
 * authorised route from private storage, always as a download, never cached.
 */
module.exports = function documentRoutes({ config }) {
  const router = Router();
  router.get('/:documentId/download', authenticate(), authorize('staff', 'admin'), validate({ params: schemas.documents.docIdParams }), (req, res, next) => {
    const { fullPath, filename } = documentService.getForDownload(req.app.locals.db, config, {
      documentId: req.valid.params.documentId, actor: req.user, requestId: req.id,
    });
    res.set({ 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.download(fullPath, filename, (err) => { if (err && !res.headersSent) next(err); });
  });
  return router;
};

'use strict';

const multer = require('multer');
const { AppError, badRequest } = require('../utils/errors');

/**
 * Multer configured for a single identity PDF in memory (bounded by the size
 * limit). Bytes are validated by signature in document.service before anything
 * touches disk. Only the field named "identity_document" is accepted.
 */
function identityDocumentUpload(maxBytes) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1, fields: 10, fieldSize: 1024, parts: 12 },
  }).single('identity_document');

  return (req, res, next) => {
    upload(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(new AppError(413, 'FILE_TOO_LARGE', `Identity document exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MB limit.`));
      }
      if (err instanceof multer.MulterError) return next(badRequest('Invalid upload. Send one PDF in the "identity_document" field.'));
      return next(badRequest('Invalid multipart request.'));
    });
  };
}

module.exports = { identityDocumentUpload };

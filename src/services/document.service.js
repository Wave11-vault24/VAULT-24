'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { looksLikePdf, sanitizeFilename } = require('../utils/pdf');
const { AppError, notFound, conflict, forbidden } = require('../utils/errors');
const { withWriteTransaction } = require('../config/database');
const audit = require('./audit.service');

const KEY_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Validate an uploaded identity document. The browser-supplied MIME type and
 * extension are checked, but the decision rests on the file's own bytes.
 */
function assertValidIdentityPdf(file) {
  if (!file) throw new AppError(400, 'IDENTITY_DOCUMENT_REQUIRED', 'A PDF identity document is required (field "identity_document").');
  if (file.mimetype !== 'application/pdf' || !/\.pdf$/i.test(file.originalname || '')) {
    throw new AppError(400, 'INVALID_DOCUMENT', 'Identity document must be a PDF file.');
  }
  if (!looksLikePdf(file.buffer)) {
    throw new AppError(400, 'INVALID_DOCUMENT', 'File content is not a valid PDF.');
  }
}

/** Resolve a storage key to a path, refusing anything that could escape the storage directory. */
function resolveStoragePath(storageDir, key) {
  if (!KEY_PATTERN.test(key)) throw new Error('Invalid storage key');
  const root = path.resolve(storageDir);
  const full = path.resolve(root, key);
  if (path.dirname(full) !== root) throw new Error('Storage path escaped root');
  return full;
}

/** Write bytes under a random 256-bit name; owner read/write only. */
function storeFile(storageDir, buffer) {
  fs.mkdirSync(storageDir, { recursive: true, mode: 0o700 });
  const key = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(resolveStoragePath(storageDir, key), buffer, { flag: 'wx', mode: 0o600 });
  return key;
}

function deleteFileQuietly(storageDir, key) {
  try { fs.unlinkSync(resolveStoragePath(storageDir, key)); } catch { /* already gone */ }
}

function insertDocumentRow(db, { userId, file, storageKey, uploadedBy }) {
  return Number(db.prepare(`
    INSERT INTO user_documents (user_id, document_type, original_filename, storage_key, mime_type, file_size, verification_status, uploaded_by, created_at)
    VALUES (?, 'identity_document', ?, ?, 'application/pdf', ?, 'pending', ?, ?)
  `).run(userId, sanitizeFilename(file.originalname), storageKey, file.buffer.length, uploadedBy, new Date().toISOString()).lastInsertRowid);
}

// Public shape: never includes storage_key or filesystem paths.
const PUBLIC_COLUMNS = `d.id, d.user_id, d.document_type, d.original_filename, d.mime_type, d.file_size,
  d.verification_status, d.uploaded_by, d.reviewed_by, d.reviewed_at, d.rejection_reason, d.created_at`;

function listForCustomer(db, customerId) {
  const exists = db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'customer'").get(customerId);
  if (!exists) throw notFound('Customer not found.');
  return db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM user_documents d WHERE d.user_id = ? ORDER BY d.id DESC`).all(customerId);
}

function listByStatus(db, status) {
  return db.prepare(`
    SELECT ${PUBLIC_COLUMNS}, u.full_name AS customer_name
    FROM user_documents d JOIN users u ON u.id = d.user_id
    WHERE (? IS NULL OR d.verification_status = ?) ORDER BY d.id DESC LIMIT 200
  `).all(status ?? null, status ?? null);
}

/** Staff upload of an additional identity document (e.g. after a rejection). */
function uploadForCustomer(db, config, { staff, customerId, file, requestId }) {
  assertValidIdentityPdf(file);
  const customer = db.prepare("SELECT id, verification_status FROM users WHERE id = ? AND role = 'customer'").get(customerId);
  if (!customer) throw notFound('Customer not found.');

  const key = storeFile(config.DOCUMENT_STORAGE_PATH, file.buffer);
  try {
    return withWriteTransaction(db, () => {
      const documentId = insertDocumentRow(db, { userId: customerId, file, storageKey: key, uploadedBy: staff.id });
      // A rejected customer goes back to pending while the new document awaits review.
      if (customer.verification_status === 'rejected') {
        db.prepare("UPDATE users SET verification_status = 'pending', updated_at = ? WHERE id = ?").run(new Date().toISOString(), customerId);
      }
      audit.record(db, { actorUserId: staff.id, action: 'document.upload', targetType: 'user_document', targetId: documentId, requestId, metadata: { customer_id: customerId, size: file.buffer.length } });
      return db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM user_documents d WHERE d.id = ?`).get(documentId);
    });
  } catch (err) {
    deleteFileQuietly(config.DOCUMENT_STORAGE_PATH, key);
    throw err;
  }
}

/** Staff/admin download. Returns metadata plus an absolute path for res.sendFile; never sent to clients. */
function getForDownload(db, config, { documentId, actor, requestId }) {
  const row = db.prepare('SELECT id, user_id, original_filename, storage_key FROM user_documents WHERE id = ?').get(documentId);
  if (!row) throw notFound('Document not found.');
  const fullPath = resolveStoragePath(config.DOCUMENT_STORAGE_PATH, row.storage_key);
  if (!fs.existsSync(fullPath)) throw notFound('Document file is unavailable.');
  audit.recordSafe(db, { actorUserId: actor.id, action: 'document.download', targetType: 'user_document', targetId: row.id, requestId, metadata: { customer_id: row.user_id } });
  return { fullPath, filename: row.original_filename };
}

/**
 * Admin review. Only pending documents can be reviewed, and a reviewer can
 * never approve a document they uploaded (separation of duties).
 * Approving sets the customer to verified; rejecting sets them to rejected
 * unless they already have another verified document.
 */
function review(db, { documentId, reviewer, decision, rejectionReason, requestId }) {
  return withWriteTransaction(db, () => {
    const doc = db.prepare('SELECT id, user_id, verification_status, uploaded_by FROM user_documents WHERE id = ?').get(documentId);
    if (!doc) throw notFound('Document not found.');
    if (doc.verification_status !== 'pending') throw conflict('This document has already been reviewed.');
    if (doc.uploaded_by === reviewer.id) throw forbidden('You cannot review a document you uploaded.');

    const now = new Date().toISOString();
    db.prepare(`UPDATE user_documents SET verification_status = ?, reviewed_by = ?, reviewed_at = ?, rejection_reason = ? WHERE id = ?`)
      .run(decision, reviewer.id, now, decision === 'rejected' ? rejectionReason : null, documentId);

    if (decision === 'verified') {
      db.prepare("UPDATE users SET verification_status = 'verified', updated_at = ? WHERE id = ?").run(now, doc.user_id);
    } else {
      const hasVerified = db.prepare("SELECT 1 FROM user_documents WHERE user_id = ? AND verification_status = 'verified'").get(doc.user_id);
      if (!hasVerified) db.prepare("UPDATE users SET verification_status = 'rejected', updated_at = ? WHERE id = ?").run(now, doc.user_id);
    }

    audit.record(db, { actorUserId: reviewer.id, action: 'document.review', targetType: 'user_document', targetId: documentId, requestId, metadata: { decision, customer_id: doc.user_id } });
    return db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM user_documents d WHERE d.id = ?`).get(documentId);
  });
}

module.exports = {
  assertValidIdentityPdf, storeFile, deleteFileQuietly, insertDocumentRow, listForCustomer, listByStatus,
  uploadForCustomer, getForDownload, review, resolveStoragePath, PUBLIC_COLUMNS,
};

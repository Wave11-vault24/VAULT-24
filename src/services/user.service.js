'use strict';

const { hashPassword } = require('../utils/password');
const { generateTempPassword } = require('../utils/temp-password');
const { cleanName } = require('../utils/names');
const { conflict, notFound, forbidden } = require('../utils/errors');
const { withWriteTransaction } = require('../config/database');
const documents = require('./document.service');
const audit = require('./audit.service');

const PUBLIC_USER = `id, full_name, email, phone_number, role, status, verification_status, created_by, created_at, updated_at`;

const isUniqueEmail = (err) => err && err.code === 'SQLITE_CONSTRAINT_UNIQUE' && /users\.email/.test(err.message);

/**
 * Staff-only customer registration (spec section 4).
 * Order matters:
 *   1. the PDF is validated before anything is written;
 *   2. the password is hashed outside the write transaction (Argon2 is slow);
 *   3. the file is written, then user + document + audit insert in ONE transaction;
 *   4. if the transaction fails, the orphaned file is deleted.
 * Role, creator and verification status are always set by the server.
 */
async function registerCustomer(db, config, { staff, input, file, requestId }) {
  documents.assertValidIdentityPdf(file);

  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(input.email)) {
    audit.recordSafe(db, { actorUserId: staff.id, action: 'customer.register', targetType: 'user', outcome: 'failure', requestId, metadata: { reason: 'duplicate_email' } });
    throw conflict('A user with this email address already exists.');
  }

  const temporaryPassword = generateTempPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const storageKey = documents.storeFile(config.DOCUMENT_STORAGE_PATH, file.buffer);

  try {
    const result = withWriteTransaction(db, () => {
      const now = new Date().toISOString();
      const customerId = Number(db.prepare(`
        INSERT INTO users (full_name, email, phone_number, password_hash, role, status, verification_status, must_change_password, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'customer', 'active', 'pending', 1, ?, ?, ?)
      `).run(cleanName(input.full_name), input.email, input.phone_number ?? null, passwordHash, staff.id, now, now).lastInsertRowid);

      const documentId = documents.insertDocumentRow(db, { userId: customerId, file, storageKey, uploadedBy: staff.id });
      audit.record(db, { actorUserId: staff.id, action: 'customer.register', targetType: 'user', targetId: customerId, requestId, metadata: { document_id: documentId } });

      return {
        customer: db.prepare(`SELECT ${PUBLIC_USER} FROM users WHERE id = ?`).get(customerId),
        document: db.prepare(`SELECT ${documents.PUBLIC_COLUMNS} FROM user_documents d WHERE d.id = ?`).get(documentId),
      };
    });
    // Shown once to the staff member to hand to the customer; never stored or logged.
    return { ...result, temporary_password: temporaryPassword };
  } catch (err) {
    documents.deleteFileQuietly(config.DOCUMENT_STORAGE_PATH, storageKey);
    if (isUniqueEmail(err)) throw conflict('A user with this email address already exists.');
    throw err;
  }
}

/** Admin-only staff creation. Staff are bank employees, so they are created verified. */
async function createStaff(db, { admin, input, requestId }) {
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(input.email)) {
    throw conflict('A user with this email address already exists.');
  }
  const temporaryPassword = generateTempPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  try {
    const staff = withWriteTransaction(db, () => {
      const now = new Date().toISOString();
      const id = Number(db.prepare(`
        INSERT INTO users (full_name, email, phone_number, password_hash, role, status, verification_status, must_change_password, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'staff', 'active', 'verified', 1, ?, ?, ?)
      `).run(cleanName(input.full_name), input.email, input.phone_number ?? null, passwordHash, admin.id, now, now).lastInsertRowid);
      audit.record(db, { actorUserId: admin.id, action: 'staff.create', targetType: 'user', targetId: id, requestId });
      return db.prepare(`SELECT ${PUBLIC_USER} FROM users WHERE id = ?`).get(id);
    });
    return { staff, temporary_password: temporaryPassword };
  } catch (err) {
    if (isUniqueEmail(err)) throw conflict('A user with this email address already exists.');
    throw err;
  }
}

function getProfile(db, userId) {
  return db.prepare(`SELECT id, full_name, email, phone_number, role, status, verification_status, created_at, updated_at FROM users WHERE id = ?`).get(userId);
}

/** Only phone_number is self-editable. Name and email are identity data, changed only via the bank. */
function updateProfile(db, { user, changes, requestId }) {
  return withWriteTransaction(db, () => {
    db.prepare('UPDATE users SET phone_number = ?, updated_at = ? WHERE id = ?').run(changes.phone_number ?? null, new Date().toISOString(), user.id);
    audit.record(db, { actorUserId: user.id, action: 'profile.update', targetType: 'user', targetId: user.id, requestId, metadata: { fields: Object.keys(changes) } });
    return getProfile(db, user.id);
  });
}

function searchCustomers(db, q) {
  if (!q) {
    return db.prepare(`SELECT ${PUBLIC_USER} FROM users WHERE role = 'customer' ORDER BY id DESC LIMIT 50`).all();
  }
  // LIKE wildcards in user input are escaped so "%" can't match everything.
  const pattern = `%${q.toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  return db.prepare(`
    SELECT ${PUBLIC_USER} FROM users
    WHERE role = 'customer' AND (lower(full_name) LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\')
    ORDER BY full_name LIMIT 50
  `).all(pattern, pattern);
}

function getCustomer(db, customerId) {
  const customer = db.prepare(`SELECT ${PUBLIC_USER} FROM users WHERE id = ? AND role = 'customer'`).get(customerId);
  if (!customer) throw notFound('Customer not found.');
  return customer;
}

function listUsers(db, { role, status }) {
  return db.prepare(`
    SELECT ${PUBLIC_USER}, failed_login_attempts FROM users
    WHERE (? IS NULL OR role = ?) AND (? IS NULL OR status = ?)
    ORDER BY id LIMIT 500
  `).all(role ?? null, role ?? null, status ?? null, status ?? null);
}

/**
 * Admin changes a user's status (active / locked / suspended).
 * Admins cannot change their own status. Re-activating clears the failed-login
 * counter. Locking or suspending kills the user's sessions immediately.
 */
function setUserStatus(db, sessionStore, { admin, userId, status, reason, requestId }) {
  if (userId === admin.id) throw forbidden('You cannot change your own status.');
  const updated = withWriteTransaction(db, () => {
    const target = db.prepare('SELECT id, role, status FROM users WHERE id = ?').get(userId);
    if (!target) throw notFound('User not found.');
    db.prepare(`UPDATE users SET status = ?, failed_login_attempts = CASE WHEN ? = 'active' THEN 0 ELSE failed_login_attempts END, updated_at = ? WHERE id = ?`)
      .run(status, status, new Date().toISOString(), userId);
    audit.record(db, { actorUserId: admin.id, action: 'user.status_change', targetType: 'user', targetId: userId, requestId, metadata: { from: target.status, to: status, reason } });
    return db.prepare(`SELECT ${PUBLIC_USER} FROM users WHERE id = ?`).get(userId);
  });
  if (status !== 'active' && sessionStore) sessionStore.destroyAllForUser(userId);
  return updated;
}

module.exports = {
  registerCustomer, createStaff, getProfile, updateProfile, searchCustomers, getCustomer, listUsers, setUserStatus, PUBLIC_USER,
};

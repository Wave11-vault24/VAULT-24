'use strict';

const { ACCOUNT_TYPES } = require('../config/constants');
const { generateAccountNumber } = require('../utils/account-number');
const { formatMinor } = require('../utils/money');
const { AppError, notFound, conflict, badRequest } = require('../utils/errors');
const { withWriteTransaction } = require('../config/database');
const audit = require('./audit.service');

function present(row) {
  if (!row) return row;
  const type = ACCOUNT_TYPES[row.account_type];
  return {
    id: row.id,
    account_number: row.account_number,
    account_name: row.account_name,
    account_type: row.account_type,
    account_type_label: type.label,
    currency: row.currency,
    balance_minor: row.balance_minor,
    balance: formatMinor(row.balance_minor),
    // No holds exist in this prototype, so available == ledger balance.
    available_balance_minor: row.balance_minor,
    daily_transfer_limit_minor: type.dailyTransferLimitMinor,
    status: row.status,
    user_id: row.user_id,
    created_at: row.created_at,
  };
}

/**
 * Staff-only account opening (spec section 6). Policy:
 *   - target must be an existing, active customer;
 *   - their identity must be VERIFIED by an admin;
 *   - at most one open account per type per customer;
 *   - account name comes from the verified customer record, never the client;
 *   - number generated server-side; balance always starts at zero.
 */
function openAccount(db, config, { staff, customerId, accountType, requestId }) {
  // Thrown inside the transaction, audited after rollback (see catch below).
  const fail = (code, message, status = 422) => Object.assign(new AppError(status, code, message), { auditFailure: true });

  try {
    return withWriteTransaction(db, () => {
      const customer = db.prepare("SELECT id, full_name, status, verification_status FROM users WHERE id = ? AND role = 'customer'").get(customerId);
      if (!customer) throw fail('CUSTOMER_NOT_FOUND', 'Customer not found.', 404);
      if (customer.status !== 'active') throw fail('CUSTOMER_NOT_ELIGIBLE', 'Customer is not active.');
      if (customer.verification_status !== 'verified') {
        throw fail('IDENTITY_NOT_VERIFIED', 'Customer identity must be verified by an administrator before an account can be opened.');
      }
      const existing = db.prepare("SELECT 1 FROM accounts WHERE user_id = ? AND account_type = ? AND status <> 'closed'").get(customerId, accountType);
      if (existing) throw fail('ACCOUNT_TYPE_EXISTS', `Customer already has an open ${ACCOUNT_TYPES[accountType].label}.`, 409);

      const now = new Date().toISOString();
      const insert = db.prepare(`
        INSERT INTO accounts (account_number, account_name, user_id, account_type, currency, balance_minor, status, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 0, 'active', ?, ?, ?)
      `);
      // 10^8 numbers per type; collisions are rare but handled by retrying.
      let accountId;
      for (let attempt = 0; attempt < 5 && !accountId; attempt++) {
        try {
          accountId = Number(insert.run(generateAccountNumber(accountType), customer.full_name, customerId, accountType, config.BANK_CURRENCY, staff.id, now, now).lastInsertRowid);
        } catch (err) {
          if (!(err.code === 'SQLITE_CONSTRAINT_UNIQUE' && /account_number/.test(err.message))) throw err;
        }
      }
      if (!accountId) throw new Error('Could not allocate a unique account number');

      audit.record(db, { actorUserId: staff.id, action: 'account.open', targetType: 'account', targetId: accountId, requestId, metadata: { customer_id: customerId, account_type: accountType } });
      return present(db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId));
    });
  } catch (err) {
    if (err.auditFailure) {
      audit.recordSafe(db, { actorUserId: staff.id, action: 'account.open', targetType: 'user', targetId: customerId, outcome: 'failure', requestId, metadata: { reason: err.code, account_type: accountType } });
    }
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' && /user_id/.test(err.message)) throw conflict('Customer already has an open account of this type.');
    throw err;
  }
}

/** Customers see only their own accounts. Staff/admin must name a customer. */
function listAccounts(db, { user, customerId }) {
  if (user.role === 'customer') {
    return db.prepare('SELECT * FROM accounts WHERE user_id = ? ORDER BY id').all(user.id).map(present);
  }
  if (!customerId) throw badRequest('customer_id query parameter is required for staff and administrators.');
  return db.prepare('SELECT * FROM accounts WHERE user_id = ? ORDER BY id').all(customerId).map(present);
}

/**
 * Fetch an account the user may see. A customer asking for someone else's
 * account gets 404, the same as a non-existent ID, so IDs can't be probed.
 */
function getAccessibleAccount(db, { user, accountId, requestId }) {
  const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  if (!row) throw notFound('Account not found.');
  if (user.role === 'customer' && row.user_id !== user.id) {
    audit.recordSafe(db, { actorUserId: user.id, action: 'authz.denied', targetType: 'account', targetId: accountId, outcome: 'failure', requestId, metadata: { reason: 'not_owner' } });
    throw notFound('Account not found.');
  }
  return row;
}

function getAccount(db, args) {
  return present(getAccessibleAccount(db, args));
}

/** Newest-first ledger with keyset pagination (before_id). */
function listTransactions(db, { user, accountId, limit = 20, beforeId, requestId }) {
  const account = getAccessibleAccount(db, { user, accountId, requestId });
  const rows = db.prepare(`
    SELECT t.id, t.reference, t.transaction_type, t.amount_minor, t.balance_after_minor, t.narration, t.created_at,
           tr.reference AS transfer_reference
    FROM transactions t LEFT JOIN transfers tr ON tr.id = t.transfer_id
    WHERE t.account_id = ? AND (? IS NULL OR t.id < ?)
    ORDER BY t.id DESC LIMIT ?
  `).all(accountId, beforeId ?? null, beforeId ?? null, limit);
  const total = db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?').get(accountId).n;
  return {
    account: { id: account.id, account_number: account.account_number, currency: account.currency },
    total_count: total,
    transactions: rows.map((r) => ({
      ...r,
      direction: r.amount_minor > 0 ? 'credit' : 'debit',
      amount: formatMinor(r.amount_minor),
      balance_after: formatMinor(r.balance_after_minor),
    })),
    next_before_id: rows.length === limit ? rows[rows.length - 1].id : null,
  };
}

/** Staff pre-deposit lookup: enough to confirm identity, no balance. */
function lookupForStaff(db, accountNumber) {
  const row = db.prepare(`
    SELECT a.account_number, a.account_name, a.account_type, a.currency, a.status,
           u.status AS owner_status, u.verification_status AS owner_verification_status
    FROM accounts a JOIN users u ON u.id = a.user_id WHERE a.account_number = ?
  `).get(accountNumber);
  if (!row) throw notFound('Account not found.');
  return { ...row, account_type_label: ACCOUNT_TYPES[row.account_type].label };
}

/**
 * Admin account status change. 'closed' is final and requires a zero balance,
 * so no money is stranded in a closed account.
 */
function setAccountStatus(db, { admin, accountId, status, reason, requestId }) {
  return withWriteTransaction(db, () => {
    const acct = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
    if (!acct) throw notFound('Account not found.');
    if (acct.status === 'closed') throw conflict('Closed accounts cannot be changed.');
    if (status === 'closed' && acct.balance_minor !== 0) throw new AppError(422, 'BALANCE_NOT_ZERO', 'Only accounts with a zero balance can be closed.');
    db.prepare('UPDATE accounts SET status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), accountId);
    audit.record(db, { actorUserId: admin.id, action: 'account.status_change', targetType: 'account', targetId: accountId, requestId, metadata: { from: acct.status, to: status, reason } });
    return present(db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId));
  });
}

module.exports = { openAccount, listAccounts, getAccount, listTransactions, lookupForStaff, setAccountStatus, present };

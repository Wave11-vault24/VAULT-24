'use strict';

const crypto = require('crypto');
const { ACCOUNT_TYPES } = require('../config/constants');
const { generateReference } = require('../utils/reference');
const { formatMinor } = require('../utils/money');
const { AppError, notFound } = require('../utils/errors');
const { withWriteTransaction } = require('../config/database');
const audit = require('./audit.service');

/** SHA-256 of the validated request. Same key + different fingerprint = misuse. */
function fingerprint(input) {
  const canonical = JSON.stringify([input.from_account_number, input.to_account_number, input.amount_minor, input.currency, input.narration ?? null]);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function startOfUtcDay() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

function presentTransfer(db, transferId) {
  const t = db.prepare(`
    SELECT t.reference, t.amount_minor, t.currency, t.status, t.failure_reason, t.created_at, t.completed_at,
           s.account_number AS from_account_number, r.account_number AS to_account_number, r.account_name AS to_account_name,
           (SELECT narration FROM transactions WHERE transfer_id = t.id AND transaction_type = 'transfer_debit') AS narration,
           (SELECT balance_after_minor FROM transactions WHERE transfer_id = t.id AND transaction_type = 'transfer_debit') AS sender_balance_after_minor
    FROM transfers t JOIN accounts s ON s.id = t.sender_account_id JOIN accounts r ON r.id = t.recipient_account_id
    WHERE t.id = ?
  `).get(transferId);
  return { ...t, amount: formatMinor(t.amount_minor) };
}

/**
 * Customer transfer (spec section 8). The whole function body runs inside a
 * single BEGIN IMMEDIATE transaction, which holds SQLite's one write lock, so
 * no other write can interleave between the funds check and the debit.
 *
 * Outcomes:
 *   - completed:  balances moved, transfer + 2 ledger rows + audit committed.
 *   - failed:     INSUFFICIENT_FUNDS / DAILY_LIMIT_EXCEEDED. A 'failed' transfer row
 *                 is committed (no money moves) so a retry with the same key
 *                 returns the same answer instead of silently succeeding later.
 *   - rejected:   bad input/ownership/status. Nothing committed; the key stays free.
 *   - replayed:   same key + same request => the stored outcome, nothing new written.
 *   - error:      any exception rolls EVERYTHING back. Safe to retry with the same key.
 */
function createTransfer(db, { customer, input, requestId }) {
  const reject = (code, message, status = 422) => Object.assign(new AppError(status, code, message), { auditFailure: true });
  const fp = fingerprint(input);

  try {
    return withWriteTransaction(db, () => {
      // 1. Idempotency: has this user already used this key?
      const prior = db.prepare('SELECT id, request_fingerprint FROM transfers WHERE initiated_by = ? AND idempotency_key = ?')
        .get(customer.id, input.idempotency_key);
      if (prior) {
        if (prior.request_fingerprint !== fp) {
          throw reject('IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used for a different transfer. Use a new key.', 409);
        }
        return { replayed: true, transfer: presentTransfer(db, prior.id) };
      }

      // 2. Sender must exist AND belong to this customer. Not-owned looks identical to not-found.
      const sender = db.prepare('SELECT * FROM accounts WHERE account_number = ?').get(input.from_account_number);
      if (!sender || sender.user_id !== customer.id) throw reject('SENDER_ACCOUNT_NOT_FOUND', 'Source account not found.', 404);
      if (sender.status !== 'active') throw reject('SENDER_ACCOUNT_NOT_ACTIVE', 'Your source account cannot send transfers.');

      // 3. Recipient must be an active account whose owner is active.
      const recipient = db.prepare(`
        SELECT a.*, u.status AS owner_status FROM accounts a JOIN users u ON u.id = a.user_id WHERE a.account_number = ?
      `).get(input.to_account_number);
      if (!recipient || recipient.status !== 'active' || recipient.owner_status !== 'active') {
        throw reject('RECIPIENT_NOT_AVAILABLE', 'Recipient account not found or cannot receive transfers.', 404);
      }
      if (recipient.id === sender.id) throw reject('SELF_TRANSFER', 'You cannot transfer to the same account.');
      if (input.currency !== sender.currency || sender.currency !== recipient.currency) {
        throw reject('CURRENCY_MISMATCH', 'Currency does not match the accounts involved.');
      }

      const now = new Date().toISOString();
      const reference = generateReference('TRF');
      const insertTransfer = db.prepare(`
        INSERT INTO transfers (reference, sender_account_id, recipient_account_id, amount_minor, currency, status, failure_reason,
                               idempotency_key, request_fingerprint, initiated_by, created_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const recordFailed = (reason) => {
        const id = Number(insertTransfer.run(reference, sender.id, recipient.id, input.amount_minor, input.currency, 'failed', reason,
          input.idempotency_key, fp, customer.id, now, null).lastInsertRowid);
        audit.record(db, { actorUserId: customer.id, action: 'transfer.create', targetType: 'transfer', targetId: id, outcome: 'failure', requestId, metadata: { reference, reason, amount_minor: input.amount_minor } });
        return { replayed: false, transfer: presentTransfer(db, id) };
      };

      // 4. Daily outgoing limit for this account type (UTC day).
      const sentToday = db.prepare(`
        SELECT COALESCE(-SUM(amount_minor), 0) AS sent FROM transactions
        WHERE account_id = ? AND transaction_type = 'transfer_debit' AND created_at >= ?
      `).get(sender.id, startOfUtcDay()).sent;
      if (sentToday + input.amount_minor > ACCOUNT_TYPES[sender.account_type].dailyTransferLimitMinor) {
        return recordFailed('DAILY_LIMIT_EXCEEDED');
      }

      // 5. Funds check (inside the write lock, so it can't go stale).
      if (sender.balance_minor < input.amount_minor) return recordFailed('INSUFFICIENT_FUNDS');

      // 6. Debit, conditional: the WHERE clause itself refuses to overdraw.
      const debit = db.prepare(`
        UPDATE accounts SET balance_minor = balance_minor - ?, updated_at = ?
        WHERE id = ? AND status = 'active' AND balance_minor >= ?
      `).run(input.amount_minor, now, sender.id, input.amount_minor);
      if (debit.changes !== 1) return recordFailed('INSUFFICIENT_FUNDS');

      // 7. Credit.
      const credit = db.prepare(`UPDATE accounts SET balance_minor = balance_minor + ?, updated_at = ? WHERE id = ? AND status = 'active'`)
        .run(input.amount_minor, now, recipient.id);
      if (credit.changes !== 1) throw new Error('Recipient credit failed'); // rolls back the debit too

      const balance = (id) => db.prepare('SELECT balance_minor FROM accounts WHERE id = ?').get(id).balance_minor;

      // 8. Transfer record + both ledger legs + audit, all linked.
      const transferId = Number(insertTransfer.run(reference, sender.id, recipient.id, input.amount_minor, input.currency, 'completed', null,
        input.idempotency_key, fp, customer.id, now, now).lastInsertRowid);

      const leg = db.prepare(`
        INSERT INTO transactions (reference, account_id, transfer_id, transaction_type, amount_minor, balance_after_minor, narration, performed_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      leg.run(`${reference}-D`, sender.id, transferId, 'transfer_debit', -input.amount_minor, balance(sender.id),
        input.narration ?? `Transfer to ${recipient.account_number}`, customer.id, now);
      leg.run(`${reference}-C`, recipient.id, transferId, 'transfer_credit', input.amount_minor, balance(recipient.id),
        input.narration ?? `Transfer from ${sender.account_number}`, customer.id, now);

      audit.record(db, { actorUserId: customer.id, action: 'transfer.create', targetType: 'transfer', targetId: transferId, requestId, metadata: { reference, amount_minor: input.amount_minor } });

      return { replayed: false, transfer: presentTransfer(db, transferId) };
    });
  } catch (err) {
    if (err.auditFailure) {
      audit.recordSafe(db, { actorUserId: customer.id, action: 'transfer.create', targetType: 'transfer', outcome: 'failure', requestId, metadata: { reason: err.code, amount_minor: input.amount_minor } });
    }
    throw err;
  }
}

/**
 * Look up a transfer by reference. Customers may see it only if they own the
 * sending or receiving account (anything else is a 404). Recipients don't see
 * the sender's post-transfer balance.
 */
function getTransfer(db, { user, reference, requestId }) {
  const row = db.prepare(`
    SELECT t.id, s.user_id AS sender_owner, r.user_id AS recipient_owner
    FROM transfers t JOIN accounts s ON s.id = t.sender_account_id JOIN accounts r ON r.id = t.recipient_account_id
    WHERE t.reference = ?
  `).get(reference);
  if (!row) throw notFound('Transfer not found.');

  if (user.role === 'customer') {
    const isSender = row.sender_owner === user.id;
    const isRecipient = row.recipient_owner === user.id;
    if (!isSender && !isRecipient) {
      audit.recordSafe(db, { actorUserId: user.id, action: 'authz.denied', targetType: 'transfer', targetId: row.id, outcome: 'failure', requestId, metadata: { reason: 'not_party' } });
      throw notFound('Transfer not found.');
    }
    const t = presentTransfer(db, row.id);
    if (!isSender) {
      delete t.sender_balance_after_minor;
      delete t.failure_reason;
    }
    return t;
  }
  return presentTransfer(db, row.id);
}

module.exports = { createTransfer, getTransfer, fingerprint };

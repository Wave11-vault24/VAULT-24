'use strict';

const { namesMatch } = require('../utils/names');
const { generateReference } = require('../utils/reference');
const { formatMinor } = require('../utils/money');
const { AppError } = require('../utils/errors');
const { withWriteTransaction } = require('../config/database');
const audit = require('./audit.service');

/**
 * Staff cash deposit (spec section 7). Everything below runs in ONE
 * BEGIN IMMEDIATE transaction: balance update, ledger entry and audit row
 * commit together or not at all.
 *
 * PROTOTYPE LIMITATION: matching account number + name prevents keying
 * mistakes, but nothing here proves physical cash was received. A real bank
 * would reconcile against the teller's till.
 */
function postDeposit(db, { staff, input, requestId }) {
  // Rejections are thrown inside the transaction (rolling it back) and audited
  // AFTER the rollback, otherwise the rollback would erase the failure record.
  const reject = (code, message, status = 422) => Object.assign(new AppError(status, code, message), { auditFailure: true });

  try {
    return withWriteTransaction(db, () => {
      const account = db.prepare(`
        SELECT a.id, a.account_number, a.account_name, a.account_type, a.currency, a.status,
               u.status AS owner_status, u.verification_status AS owner_verification
        FROM accounts a JOIN users u ON u.id = a.user_id WHERE a.account_number = ?
      `).get(input.account_number);

      if (!account) throw reject('ACCOUNT_NOT_FOUND', 'No account matches that account number.', 404);
      if (!namesMatch(input.account_name, account.account_name)) {
        throw reject('ACCOUNT_NAME_MISMATCH', 'The account name does not match the account number. Check both with the customer.');
      }
      if (account.status !== 'active') throw reject('ACCOUNT_NOT_ACTIVE', 'This account cannot receive deposits.');
      if (account.owner_status !== 'active' || account.owner_verification !== 'verified') {
        throw reject('CUSTOMER_NOT_ELIGIBLE', 'The account holder is not eligible to receive deposits.');
      }
      if (input.currency !== account.currency) throw reject('CURRENCY_MISMATCH', `This account only accepts ${account.currency}.`);

      const now = new Date().toISOString();
      // Conditional update: re-checks status inside the write so a concurrent freeze wins.
      const upd = db.prepare(`UPDATE accounts SET balance_minor = balance_minor + ?, updated_at = ? WHERE id = ? AND status = 'active'`)
        .run(input.amount_minor, now, account.id);
      if (upd.changes !== 1) throw reject('ACCOUNT_NOT_ACTIVE', 'This account cannot receive deposits.');

      const balanceAfter = db.prepare('SELECT balance_minor FROM accounts WHERE id = ?').get(account.id).balance_minor;
      const reference = generateReference('DEP');

      db.prepare(`
        INSERT INTO transactions (reference, account_id, transfer_id, transaction_type, amount_minor, balance_after_minor, narration, performed_by, created_at)
        VALUES (?, ?, NULL, 'cash_deposit', ?, ?, ?, ?, ?)
      `).run(reference, account.id, input.amount_minor, balanceAfter, input.narration, staff.id, now);

      audit.record(db, { actorUserId: staff.id, action: 'deposit.create', targetType: 'account', targetId: account.id, requestId, metadata: { reference, amount_minor: input.amount_minor } });

      return {
        reference,
        account_number: account.account_number,
        account_name: account.account_name,
        account_type: account.account_type,
        amount_minor: input.amount_minor,
        amount: formatMinor(input.amount_minor),
        currency: account.currency,
        narration: input.narration,
        balance_after_minor: balanceAfter,
        balance_after: formatMinor(balanceAfter),
        performed_by: staff.id,
        created_at: now,
      };
    });
  } catch (err) {
    if (err.auditFailure) {
      audit.recordSafe(db, { actorUserId: staff.id, action: 'deposit.create', targetType: 'account', targetId: input.account_number, outcome: 'failure', requestId, metadata: { reason: err.code, amount_minor: input.amount_minor } });
    }
    throw err;
  }
}

module.exports = { postDeposit };

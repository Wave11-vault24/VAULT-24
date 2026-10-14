'use strict';

/** Read-only audit trail for administrators, newest first, keyset-paginated. */
function listAuditLogs(db, { action, actorUserId, limit = 50, beforeId }) {
  const rows = db.prepare(`
    SELECT id, actor_user_id, action, target_type, target_id, outcome, request_id, metadata_json, created_at
    FROM audit_logs
    WHERE (? IS NULL OR action = ?) AND (? IS NULL OR actor_user_id = ?) AND (? IS NULL OR id < ?)
    ORDER BY id DESC LIMIT ?
  `).all(action ?? null, action ?? null, actorUserId ?? null, actorUserId ?? null, beforeId ?? null, beforeId ?? null, limit);
  return {
    audit_logs: rows.map(({ metadata_json: m, ...r }) => ({ ...r, metadata: JSON.parse(m) })),
    next_before_id: rows.length === limit ? rows[rows.length - 1].id : null,
  };
}

/**
 * Ledger reconciliation: for every account, the stored balance must equal the
 * sum of its ledger entries, and the last entry's balance_after must match.
 * Returns only accounts that DON'T reconcile (empty array = healthy).
 */
function reconcile(db) {
  return db.prepare(`
    SELECT a.id, a.account_number, a.balance_minor,
           COALESCE(SUM(t.amount_minor), 0) AS ledger_sum,
           (SELECT balance_after_minor FROM transactions WHERE account_id = a.id ORDER BY id DESC LIMIT 1) AS last_balance_after
    FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id
    GROUP BY a.id
    HAVING a.balance_minor <> ledger_sum OR (last_balance_after IS NOT NULL AND last_balance_after <> a.balance_minor)
  `).all();
}

module.exports = { listAuditLogs, reconcile };

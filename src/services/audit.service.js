'use strict';

// Keys whose values must never reach the audit trail, at any nesting depth.
const SENSITIVE_KEY = /pass(word)?|secret|token|cookie|session|sid|authorization|hash|storage_key|csrf/i;
const MAX_METADATA_CHARS = 1500;

function sanitize(value, depth = 0) {
  if (depth > 3) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitize(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : sanitize(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') return value.slice(0, 200);
  return value;
}

/**
 * Append an audit record. Pass the same `db` handle inside a transaction to
 * make the audit row commit or roll back together with the business change.
 */
function record(db, { actorUserId = null, action, targetType, targetId = null, outcome = 'success', requestId = null, metadata = {} }) {
  let json = JSON.stringify(sanitize(metadata));
  if (json.length > MAX_METADATA_CHARS) json = JSON.stringify({ truncated: true });
  db.prepare(`
    INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, outcome, request_id, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(actorUserId, action, targetType, targetId == null ? null : String(targetId), outcome, requestId, json, new Date().toISOString());
}

/** Best-effort audit for failure paths that happen outside a transaction. */
function recordSafe(db, entry) {
  try {
    record(db, entry);
  } catch {
    // Auditing a failure must never turn a 4xx into a 500.
  }
}

/** Build the common audit fields from an Express request. */
function fromReq(req) {
  return { actorUserId: req.user ? req.user.id : null, requestId: req.id };
}

module.exports = { record, recordSafe, fromReq, sanitize };

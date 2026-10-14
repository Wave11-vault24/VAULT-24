'use strict';

const { z } = require('zod');
const { hashPassword, isStrongPassword } = require('../utils/password');
const { withWriteTransaction } = require('../config/database');

const adminSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  password: z.string().refine(isStrongPassword, 'Password must be 12+ chars with upper, lower and a digit.'),
});

/**
 * Create the first administrator. Refuses if any admin already exists, so it
 * cannot be used to mint extra admins after setup.
 */
async function createInitialAdmin(db, input) {
  const parsed = adminSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Invalid administrator details: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  const { fullName, email, password } = parsed.data;
  const passwordHash = await hashPassword(password); // hash outside the write transaction

  return withWriteTransaction(db, () => {
    const existing = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
    if (existing > 0) throw new Error('An administrator already exists. Bootstrap refused.');

    const { lastInsertRowid } = db.prepare(`
      INSERT INTO users (full_name, email, password_hash, role, status, verification_status, created_by)
      VALUES (?, ?, ?, 'admin', 'active', 'verified', NULL)
    `).run(fullName, email, passwordHash);

    db.prepare(`
      INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, outcome, metadata_json)
      VALUES (NULL, 'admin.bootstrap', 'user', ?, 'success', '{}')
    `).run(String(lastInsertRowid));

    return { id: Number(lastInsertRowid), email };
  });
}

module.exports = { createInitialAdmin };

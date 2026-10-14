'use strict';

// Single source of truth for enumerations. Migrations mirror these values in
// CHECK constraints; tests/db.integrity.test.js verifies the two stay in sync.

const ROLES = Object.freeze(['customer', 'staff', 'admin']);
const USER_STATUSES = Object.freeze(['active', 'locked', 'suspended']);
const VERIFICATION_STATUSES = Object.freeze(['pending', 'verified', 'rejected']);

// Supported account types. Each has a two-digit code embedded in the
// generated account number so staff can recognise the product at a glance.
const ACCOUNT_TYPES = Object.freeze({
  savings: { code: '10', label: 'Savings Account' },
  student: { code: '20', label: 'Student Account' },
  salary: { code: '30', label: 'Salary Account' },
  business: { code: '40', label: 'Business Account' },
});
const ACCOUNT_TYPE_KEYS = Object.freeze(Object.keys(ACCOUNT_TYPES));

const ACCOUNT_STATUSES = Object.freeze(['active', 'frozen', 'closed']);
const TRANSFER_STATUSES = Object.freeze(['pending', 'completed', 'failed']);
const TRANSACTION_TYPES = Object.freeze(['cash_deposit', 'transfer_debit', 'transfer_credit']);
const DOCUMENT_TYPES = Object.freeze(['identity_document']);
const AUDIT_OUTCOMES = Object.freeze(['success', 'failure']);

module.exports = {
  ROLES,
  USER_STATUSES,
  VERIFICATION_STATUSES,
  ACCOUNT_TYPES,
  ACCOUNT_TYPE_KEYS,
  ACCOUNT_STATUSES,
  TRANSFER_STATUSES,
  TRANSACTION_TYPES,
  DOCUMENT_TYPES,
  AUDIT_OUTCOMES,
};

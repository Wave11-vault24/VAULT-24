'use strict';

// Single source of truth for enumerations and business limits. Migrations
// mirror the enumerations in CHECK constraints; tests verify they stay in sync.
// All money values are INTEGER minor units (1 ZMW = 100 ngwee).

const ROLES = Object.freeze(['customer', 'staff', 'admin']);
const USER_STATUSES = Object.freeze(['active', 'locked', 'suspended']);
const VERIFICATION_STATUSES = Object.freeze(['pending', 'verified', 'rejected']);

// Supported account types. `code` is embedded in the account number;
// `dailyTransferLimitMinor` caps outgoing customer transfers per UTC day.
const ACCOUNT_TYPES = Object.freeze({
  savings: Object.freeze({ code: '10', label: 'Savings Account', dailyTransferLimitMinor: 2_000_000 }), // 20,000 ZMW
  student: Object.freeze({ code: '20', label: 'Student Account', dailyTransferLimitMinor: 500_000 }), //  5,000 ZMW
  salary: Object.freeze({ code: '30', label: 'Salary Account', dailyTransferLimitMinor: 5_000_000 }), // 50,000 ZMW
  business: Object.freeze({ code: '40', label: 'Business Account', dailyTransferLimitMinor: 20_000_000 }), // 200,000 ZMW
});
const ACCOUNT_TYPE_KEYS = Object.freeze(Object.keys(ACCOUNT_TYPES));

const ACCOUNT_STATUSES = Object.freeze(['active', 'frozen', 'closed']);
const TRANSFER_STATUSES = Object.freeze(['pending', 'completed', 'failed']);
const TRANSACTION_TYPES = Object.freeze(['cash_deposit', 'transfer_debit', 'transfer_credit']);
const DOCUMENT_TYPES = Object.freeze(['identity_document']);
const AUDIT_OUTCOMES = Object.freeze(['success', 'failure']);

const LIMITS = Object.freeze({
  MAX_DEPOSIT_MINOR: 10_000_000, // 100,000 ZMW per teller deposit
  MAX_TRANSFER_MINOR: 20_000_000, // hard ceiling per single transfer
  NARRATION_MAX: 140,
  MAX_FAILED_LOGINS: 5, // consecutive failures before the user is locked
  SESSION_IDLE_MS: 30 * 60 * 1000, // 30 minutes, rolling
});

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
  LIMITS,
};

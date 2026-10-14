-- Milestone 3+ additions. New migration rather than editing 001 (001 is checksummed).

-- Temporary passwords issued by staff/admin must be changed at first login.
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0
  CHECK (must_change_password IN (0, 1));

-- Consecutive failed logins; at the threshold the user is set to 'locked'.
ALTER TABLE users ADD COLUMN failed_login_attempts INTEGER NOT NULL DEFAULT 0
  CHECK (failed_login_attempts >= 0);

-- Why a transfer ended as 'failed' (e.g. INSUFFICIENT_FUNDS). Stored so an
-- idempotent replay returns the same outcome.
ALTER TABLE transfers ADD COLUMN failure_reason TEXT
  CHECK (failure_reason IS NULL OR failure_reason IN ('INSUFFICIENT_FUNDS', 'DAILY_LIMIT_EXCEEDED'));

-- Policy: a customer holds at most one open account of each type.
CREATE UNIQUE INDEX uq_accounts_user_type_open ON accounts(user_id, account_type) WHERE status <> 'closed';

-- Lets the daily-limit query scan only one account's recent debits.
CREATE INDEX idx_transactions_account_type_time ON transactions(account_id, transaction_type, created_at);

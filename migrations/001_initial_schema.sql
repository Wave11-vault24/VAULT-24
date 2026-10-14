-- Vault24 initial schema.
-- Conventions:
--   * Timestamps: UTC ISO-8601 with milliseconds, e.g. 2026-10-14T20:48:00.000Z
--   * Money: INTEGER minor units (1 ZMW = 100 ngwee). Never REAL.
--   * Enumerations mirror src/config/constants.js (checked by tests).

CREATE TABLE users (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name           TEXT    NOT NULL CHECK (length(trim(full_name)) BETWEEN 2 AND 120),
  email               TEXT    NOT NULL UNIQUE CHECK (email = lower(trim(email)) AND length(email) <= 254),
  phone_number        TEXT    CHECK (phone_number IS NULL OR length(phone_number) <= 20),
  password_hash       TEXT    NOT NULL CHECK (password_hash LIKE '$argon2id$%'),
  role                TEXT    NOT NULL CHECK (role IN ('customer', 'staff', 'admin')),
  status              TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'locked', 'suspended')),
  verification_status TEXT    NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending', 'verified', 'rejected')),
  created_by          INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- Only the bootstrap administrator may lack a creator.
  CHECK (created_by IS NOT NULL OR role = 'admin')
);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_created_by ON users(created_by);

-- created_by is immutable once set.
CREATE TRIGGER trg_users_created_by_immutable
BEFORE UPDATE OF created_by ON users
WHEN OLD.created_by IS NOT NEW.created_by
BEGIN
  SELECT RAISE(ABORT, 'users.created_by is immutable');
END;

CREATE TABLE user_documents (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  document_type       TEXT    NOT NULL CHECK (document_type IN ('identity_document')),
  original_filename   TEXT    NOT NULL CHECK (length(original_filename) BETWEEN 1 AND 255
                                             AND instr(original_filename, '/') = 0
                                             AND instr(original_filename, '\') = 0),
  storage_key         TEXT    NOT NULL UNIQUE CHECK (length(storage_key) >= 32),
  mime_type           TEXT    NOT NULL CHECK (mime_type = 'application/pdf'),
  file_size           INTEGER NOT NULL CHECK (file_size > 0),
  verification_status TEXT    NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending', 'verified', 'rejected')),
  uploaded_by         INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_by         INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_at         TEXT,
  rejection_reason    TEXT    CHECK (rejection_reason IS NULL OR length(rejection_reason) <= 200),
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- A reviewed document must say who reviewed it and when; a pending one must not.
  CHECK ((verification_status = 'pending') = (reviewed_by IS NULL AND reviewed_at IS NULL)),
  CHECK (rejection_reason IS NULL OR verification_status = 'rejected')
);
CREATE INDEX idx_user_documents_user ON user_documents(user_id);
CREATE INDEX idx_user_documents_status ON user_documents(verification_status);

CREATE TABLE accounts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  account_number TEXT    NOT NULL UNIQUE CHECK (account_number GLOB 'V24[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
  account_name   TEXT    NOT NULL CHECK (length(trim(account_name)) BETWEEN 2 AND 120),
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  account_type   TEXT    NOT NULL CHECK (account_type IN ('savings', 'student', 'salary', 'business')),
  currency       TEXT    NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
  balance_minor  INTEGER NOT NULL DEFAULT 0 CHECK (typeof(balance_minor) = 'integer' AND balance_minor >= 0),
  status         TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen', 'closed')),
  created_by     INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_accounts_user ON accounts(user_id);

-- Accounts always open at zero; money only arrives via deposits/transfers.
CREATE TRIGGER trg_accounts_open_at_zero
BEFORE INSERT ON accounts
WHEN NEW.balance_minor <> 0
BEGIN
  SELECT RAISE(ABORT, 'accounts must open with a zero balance');
END;

-- Ownership, number, type, currency and creator never change after opening.
CREATE TRIGGER trg_accounts_identity_immutable
BEFORE UPDATE OF account_number, user_id, account_type, currency, created_by ON accounts
WHEN OLD.account_number IS NOT NEW.account_number
  OR OLD.user_id        IS NOT NEW.user_id
  OR OLD.account_type   IS NOT NEW.account_type
  OR OLD.currency       IS NOT NEW.currency
  OR OLD.created_by     IS NOT NEW.created_by
BEGIN
  SELECT RAISE(ABORT, 'account identity fields are immutable');
END;

CREATE TABLE transfers (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  reference            TEXT    NOT NULL UNIQUE,
  sender_account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  recipient_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  amount_minor         INTEGER NOT NULL CHECK (typeof(amount_minor) = 'integer' AND amount_minor > 0),
  currency             TEXT    NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
  status               TEXT    NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  idempotency_key      TEXT    NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_fingerprint  TEXT    NOT NULL CHECK (length(request_fingerprint) = 64),
  initiated_by         INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at         TEXT,
  CHECK (sender_account_id <> recipient_account_id),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);
-- Idempotency scope: one key per initiating user.
CREATE UNIQUE INDEX uq_transfers_idempotency ON transfers(initiated_by, idempotency_key);
CREATE INDEX idx_transfers_sender ON transfers(sender_account_id);
CREATE INDEX idx_transfers_recipient ON transfers(recipient_account_id);

CREATE TABLE transactions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  reference           TEXT    NOT NULL UNIQUE,
  account_id          INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  transfer_id         INTEGER REFERENCES transfers(id) ON DELETE RESTRICT,
  transaction_type    TEXT    NOT NULL CHECK (transaction_type IN ('cash_deposit', 'transfer_debit', 'transfer_credit')),
  amount_minor        INTEGER NOT NULL CHECK (typeof(amount_minor) = 'integer' AND amount_minor <> 0),
  balance_after_minor INTEGER NOT NULL CHECK (typeof(balance_after_minor) = 'integer' AND balance_after_minor >= 0),
  narration           TEXT    CHECK (narration IS NULL OR length(narration) <= 140),
  performed_by        INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- Sign must match type; transfer legs must link to a transfer, deposits must not.
  CHECK (
    (transaction_type = 'cash_deposit'    AND amount_minor > 0 AND transfer_id IS NULL) OR
    (transaction_type = 'transfer_credit' AND amount_minor > 0 AND transfer_id IS NOT NULL) OR
    (transaction_type = 'transfer_debit'  AND amount_minor < 0 AND transfer_id IS NOT NULL)
  )
);
CREATE INDEX idx_transactions_account ON transactions(account_id, id);
CREATE INDEX idx_transactions_transfer ON transactions(transfer_id);

-- The ledger is append-only.
CREATE TRIGGER trg_transactions_no_update
BEFORE UPDATE ON transactions
BEGIN
  SELECT RAISE(ABORT, 'ledger entries are append-only');
END;
CREATE TRIGGER trg_transactions_no_delete
BEFORE DELETE ON transactions
BEGIN
  SELECT RAISE(ABORT, 'ledger entries are append-only');
END;

CREATE TABLE audit_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  action        TEXT    NOT NULL CHECK (length(action) BETWEEN 1 AND 64),
  target_type   TEXT    NOT NULL CHECK (length(target_type) BETWEEN 1 AND 32),
  target_id     TEXT,
  outcome       TEXT    NOT NULL CHECK (outcome IN ('success', 'failure')),
  request_id    TEXT,
  metadata_json TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json) AND length(metadata_json) <= 2000),
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_audit_actor ON audit_logs(actor_user_id, id);
CREATE INDEX idx_audit_action ON audit_logs(action, id);

-- Audit records are append-only.
CREATE TRIGGER trg_audit_no_update
BEFORE UPDATE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit logs are append-only');
END;
CREATE TRIGGER trg_audit_no_delete
BEFORE DELETE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit logs are append-only');
END;

-- Session table, same shape better-sqlite3-session-store expects.
CREATE TABLE sessions (
  sid    TEXT NOT NULL PRIMARY KEY,
  sess   JSON NOT NULL,
  expire TEXT NOT NULL
);
CREATE INDEX idx_sessions_expire ON sessions(expire);

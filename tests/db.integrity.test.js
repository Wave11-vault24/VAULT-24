'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase } = require('../src/config/database');
const { migrate, MIGRATIONS_DIR } = require('../src/db/migrate');
const { createInitialAdmin } = require('../src/services/bootstrap.service');
const { generateAccountNumber, accountTypeFromNumber } = require('../src/utils/account-number');
const { ACCOUNT_TYPE_KEYS, ACCOUNT_TYPES } = require('../src/config/constants');
const { createTestDb, insertUser } = require('./helpers');

const TABLES = ['users', 'user_documents', 'accounts', 'transfers', 'transactions', 'audit_logs', 'sessions'];

function openAccount(db, { userId, staffId, type = 'savings', name = 'Test User' }) {
  return Number(db.prepare(`
    INSERT INTO accounts (account_number, account_name, user_id, account_type, currency, created_by)
    VALUES (?, ?, ?, ?, 'ZMW', ?)
  `).run(generateAccountNumber(type), name, userId, type, staffId).lastInsertRowid);
}

describe('Milestone 2 — migrations', () => {
  test('apply cleanly to an empty database and create every table', () => {
    const db = openDatabase(':memory:');
    const applied = migrate(db);
    expect(applied).toContain('001_initial_schema.sql');
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    for (const t of TABLES) expect(names).toContain(t);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    db.close();
  });

  test('re-running is a no-op', () => {
    const db = createTestDb();
    expect(migrate(db)).toEqual([]);
    db.close();
  });

  test('editing an applied migration is detected', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault24-mig-'));
    fs.copyFileSync(path.join(MIGRATIONS_DIR, '001_initial_schema.sql'), path.join(dir, '001_initial_schema.sql'));
    const db = openDatabase(':memory:');
    try {
      migrate(db, dir);
      fs.appendFileSync(path.join(dir, '001_initial_schema.sql'), '\n-- tampered\n');
      expect(() => migrate(db, dir)).toThrow(/modified after being applied/);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('session table matches the shape the session store expects', () => {
    const db = createTestDb();
    const cols = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
    expect(cols).toEqual(['sid', 'sess', 'expire']);
    db.close();
  });
});

describe('Milestone 2 — users table', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => db.close());

  test('rejects unknown roles', () => {
    const admin = insertUser(db, { role: 'admin' });
    expect(() => insertUser(db, { role: 'superuser', createdBy: admin })).toThrow(/CHECK constraint/);
  });

  test('email must be unique and stored lower-case', () => {
    const admin = insertUser(db, { role: 'admin' });
    insertUser(db, { role: 'staff', email: 'teller@vault24.test', createdBy: admin });
    expect(() => insertUser(db, { role: 'staff', email: 'teller@vault24.test', createdBy: admin })).toThrow(/UNIQUE/);
    expect(() => insertUser(db, { role: 'staff', email: 'Teller2@Vault24.test', createdBy: admin })).toThrow(/CHECK/);
  });

  test('only an admin may lack a creator', () => {
    expect(() => insertUser(db, { role: 'customer', createdBy: null })).toThrow(/CHECK/);
    expect(() => insertUser(db, { role: 'staff', createdBy: null })).toThrow(/CHECK/);
    expect(insertUser(db, { role: 'admin', createdBy: null })).toBeGreaterThan(0);
  });

  test('created_by must reference a real user and is immutable', () => {
    const admin = insertUser(db, { role: 'admin' });
    expect(() => insertUser(db, { role: 'staff', createdBy: 9999 })).toThrow(/FOREIGN KEY/);
    const staff = insertUser(db, { role: 'staff', createdBy: admin });
    const staff2 = insertUser(db, { role: 'staff', createdBy: admin });
    expect(() => db.prepare('UPDATE users SET created_by = ? WHERE id = ?').run(staff2, staff)).toThrow(/immutable/);
  });

  test('password_hash must be an Argon2id hash', () => {
    expect(() => db.prepare(
      "INSERT INTO users (full_name, email, password_hash, role) VALUES ('X Y', 'x@vault24.test', 'plaintext', 'admin')",
    ).run()).toThrow(/CHECK/);
  });
});

describe('Milestone 2 — account types', () => {
  let db;
  let staff;
  let customer;
  beforeEach(() => {
    db = createTestDb();
    const admin = insertUser(db, { role: 'admin' });
    staff = insertUser(db, { role: 'staff', createdBy: admin });
    customer = insertUser(db, { role: 'customer', createdBy: staff });
  });
  afterEach(() => db.close());

  test('the four supported types are savings, student, salary and business', () => {
    expect(ACCOUNT_TYPE_KEYS).toEqual(['savings', 'student', 'salary', 'business']);
  });

  test.each(ACCOUNT_TYPE_KEYS)('a %s account can be opened', (type) => {
    const id = openAccount(db, { userId: customer, staffId: staff, type });
    const row = db.prepare('SELECT account_type, account_number, balance_minor FROM accounts WHERE id = ?').get(id);
    expect(row.account_type).toBe(type);
    expect(row.balance_minor).toBe(0);
    expect(accountTypeFromNumber(row.account_number)).toBe(type);
  });

  test('unsupported account types are rejected by the database', () => {
    expect(() => db.prepare(`
      INSERT INTO accounts (account_number, account_name, user_id, account_type, currency, created_by)
      VALUES ('V241000000001', 'Test User', ?, 'checking', 'ZMW', ?)
    `).run(customer, staff)).toThrow(/CHECK/);
  });

  test('schema CHECK list matches constants.js', () => {
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'accounts'").get().sql;
    const match = sql.match(/account_type\s+TEXT\s+NOT NULL CHECK \(account_type IN \(([^)]+)\)\)/);
    const inSchema = match[1].split(',').map((s) => s.trim().replace(/'/g, ''));
    expect(inSchema).toEqual(ACCOUNT_TYPE_KEYS);
  });

  test('a customer may hold one of each type', () => {
    for (const type of ACCOUNT_TYPE_KEYS) openAccount(db, { userId: customer, staffId: staff, type });
    expect(db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE user_id = ?').get(customer).n).toBe(4);
  });
});

describe('Milestone 2 — account number generation', () => {
  test.each(ACCOUNT_TYPE_KEYS)('%s numbers carry the right product code', (type) => {
    for (let i = 0; i < 50; i++) {
      const n = generateAccountNumber(type);
      expect(n).toMatch(new RegExp(`^V24${ACCOUNT_TYPES[type].code}\\d{8}$`));
    }
  });

  test('rejects unknown types', () => {
    expect(() => generateAccountNumber('checking')).toThrow();
  });

  test('numbers are not sequential', () => {
    const set = new Set(Array.from({ length: 200 }, () => generateAccountNumber('savings')));
    expect(set.size).toBeGreaterThan(195);
  });
});

describe('Milestone 2 — accounts table integrity', () => {
  let db;
  let staff;
  let customer;
  beforeEach(() => {
    db = createTestDb();
    const admin = insertUser(db, { role: 'admin' });
    staff = insertUser(db, { role: 'staff', createdBy: admin });
    customer = insertUser(db, { role: 'customer', createdBy: staff });
  });
  afterEach(() => db.close());

  test('accounts cannot open with a non-zero balance', () => {
    expect(() => db.prepare(`
      INSERT INTO accounts (account_number, account_name, user_id, account_type, currency, balance_minor, created_by)
      VALUES (?, 'Test User', ?, 'savings', 'ZMW', 100000, ?)
    `).run(generateAccountNumber('savings'), customer, staff)).toThrow(/zero balance/);
  });

  test('account numbers are unique', () => {
    const num = generateAccountNumber('salary');
    const sql = `INSERT INTO accounts (account_number, account_name, user_id, account_type, currency, created_by)
                 VALUES (?, 'Test User', ?, 'salary', 'ZMW', ?)`;
    db.prepare(sql).run(num, customer, staff);
    expect(() => db.prepare(sql).run(num, customer, staff)).toThrow(/UNIQUE/);
  });

  test('balance can never go negative', () => {
    const id = openAccount(db, { userId: customer, staffId: staff });
    expect(() => db.prepare('UPDATE accounts SET balance_minor = -1 WHERE id = ?').run(id)).toThrow(/CHECK/);
  });

  test('balance must be an integer (no floating-point money)', () => {
    const id = openAccount(db, { userId: customer, staffId: staff });
    expect(() => db.prepare('UPDATE accounts SET balance_minor = 10.5 WHERE id = ?').run(id)).toThrow(/CHECK/);
  });

  test('owner, type, number and currency are immutable', () => {
    const id = openAccount(db, { userId: customer, staffId: staff, type: 'student' });
    const other = insertUser(db, { role: 'customer', createdBy: staff });
    expect(() => db.prepare('UPDATE accounts SET user_id = ? WHERE id = ?').run(other, id)).toThrow(/immutable/);
    expect(() => db.prepare("UPDATE accounts SET account_type = 'business' WHERE id = ?").run(id)).toThrow(/immutable/);
    expect(() => db.prepare("UPDATE accounts SET currency = 'USD' WHERE id = ?").run(id)).toThrow(/immutable/);
  });

  test('users who own accounts cannot be deleted', () => {
    openAccount(db, { userId: customer, staffId: staff });
    expect(() => db.prepare('DELETE FROM users WHERE id = ?').run(customer)).toThrow(/FOREIGN KEY/);
  });
});

describe('Milestone 2 — ledger and audit integrity', () => {
  let db;
  let staff;
  let acct;
  beforeEach(() => {
    db = createTestDb();
    const admin = insertUser(db, { role: 'admin' });
    staff = insertUser(db, { role: 'staff', createdBy: admin });
    const customer = insertUser(db, { role: 'customer', createdBy: staff });
    acct = openAccount(db, { userId: customer, staffId: staff });
  });
  afterEach(() => db.close());

  const insertTxn = (overrides) => {
    const t = { ref: `TX${Math.random()}`, type: 'cash_deposit', amount: 500, transfer: null, ...overrides };
    return db.prepare(`
      INSERT INTO transactions (reference, account_id, transfer_id, transaction_type, amount_minor, balance_after_minor, narration, performed_by)
      VALUES (?, ?, ?, ?, ?, 500, 'test', ?)
    `).run(t.ref, acct, t.transfer, t.type, t.amount, staff);
  };

  test('deposits must be positive and unlinked to a transfer', () => {
    expect(() => insertTxn({ amount: -500 })).toThrow(/CHECK/);
    expect(() => insertTxn({ amount: 0 })).toThrow(/CHECK/);
    expect(insertTxn({}).changes).toBe(1);
  });

  test('transfer legs must reference a transfer', () => {
    expect(() => insertTxn({ type: 'transfer_debit', amount: -500 })).toThrow(/CHECK/);
    expect(() => insertTxn({ type: 'transfer_credit', amount: 500 })).toThrow(/CHECK/);
  });

  test('ledger entries cannot be updated or deleted', () => {
    const id = insertTxn({}).lastInsertRowid;
    expect(() => db.prepare('UPDATE transactions SET amount_minor = 999 WHERE id = ?').run(id)).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM transactions WHERE id = ?').run(id)).toThrow(/append-only/);
  });

  test('audit logs cannot be updated or deleted and metadata must be JSON', () => {
    const id = db.prepare(
      "INSERT INTO audit_logs (actor_user_id, action, target_type, outcome) VALUES (?, 'test', 'user', 'success')",
    ).run(staff).lastInsertRowid;
    expect(() => db.prepare("UPDATE audit_logs SET outcome = 'failure' WHERE id = ?").run(id)).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM audit_logs WHERE id = ?').run(id)).toThrow(/append-only/);
    expect(() => db.prepare(
      "INSERT INTO audit_logs (action, target_type, outcome, metadata_json) VALUES ('x', 'y', 'success', 'not json')",
    ).run()).toThrow(/CHECK/);
  });

  test('transfers reject self-transfer, non-positive amounts and duplicate idempotency keys', () => {
    const customer2 = insertUser(db, { role: 'customer', createdBy: staff });
    const acct2 = openAccount(db, { userId: customer2, staffId: staff, type: 'business' });
    const fp = 'a'.repeat(64);
    const sql = `INSERT INTO transfers (reference, sender_account_id, recipient_account_id, amount_minor, currency, status, idempotency_key, request_fingerprint, initiated_by)
                 VALUES (?, ?, ?, ?, 'ZMW', 'pending', ?, ?, ?)`;
    expect(() => db.prepare(sql).run('R1', acct, acct, 100, 'key-0000000000001', fp, staff)).toThrow(/CHECK/);
    expect(() => db.prepare(sql).run('R2', acct, acct2, 0, 'key-0000000000002', fp, staff)).toThrow(/CHECK/);
    db.prepare(sql).run('R3', acct, acct2, 100, 'key-0000000000003', fp, staff);
    expect(() => db.prepare(sql).run('R4', acct, acct2, 100, 'key-0000000000003', fp, staff)).toThrow(/UNIQUE/);
  });

  test('a pending document cannot carry a reviewer; a reviewed one must', () => {
    const customer = db.prepare("SELECT id FROM users WHERE role = 'customer'").get().id;
    const sql = `INSERT INTO user_documents (user_id, document_type, original_filename, storage_key, mime_type, file_size, verification_status, uploaded_by, reviewed_by, reviewed_at)
                 VALUES (?, 'identity_document', 'id.pdf', ?, 'application/pdf', 1000, ?, ?, ?, ?)`;
    const key = () => require('crypto').randomBytes(24).toString('hex');
    expect(() => db.prepare(sql).run(customer, key(), 'verified', staff, null, null)).toThrow(/CHECK/);
    expect(() => db.prepare(sql).run(customer, key(), 'pending', staff, staff, '2026-01-01T00:00:00.000Z')).toThrow(/CHECK/);
    expect(db.prepare(sql).run(customer, key(), 'pending', staff, null, null).changes).toBe(1);
  });

  test('document filenames cannot contain path separators and must be PDF', () => {
    const customer = db.prepare("SELECT id FROM users WHERE role = 'customer'").get().id;
    const sql = `INSERT INTO user_documents (user_id, document_type, original_filename, storage_key, mime_type, file_size, uploaded_by)
                 VALUES (?, 'identity_document', ?, ?, ?, 1000, ?)`;
    const key = () => require('crypto').randomBytes(24).toString('hex');
    expect(() => db.prepare(sql).run(customer, '../../etc/passwd', key(), 'application/pdf', staff)).toThrow(/CHECK/);
    expect(() => db.prepare(sql).run(customer, 'id.png', key(), 'image/png', staff)).toThrow(/CHECK/);
  });
});

describe('Milestone 2 — administrator bootstrap', () => {
  const valid = { fullName: 'Ada Admin', email: 'Admin@Vault24.test', password: 'Str0ngPassw0rd!' };

  test('creates exactly one admin with an Argon2id hash and an audit record', async () => {
    const db = createTestDb();
    const admin = await createInitialAdmin(db, valid);
    const row = db.prepare('SELECT email, role, password_hash, created_by FROM users WHERE id = ?').get(admin.id);
    expect(row.email).toBe('admin@vault24.test');
    expect(row.role).toBe('admin');
    expect(row.created_by).toBeNull();
    expect(row.password_hash.startsWith('$argon2id$')).toBe(true);
    expect(row.password_hash).not.toContain(valid.password);
    const audit = db.prepare("SELECT * FROM audit_logs WHERE action = 'admin.bootstrap'").get();
    expect(audit.outcome).toBe('success');
    expect(audit.metadata_json).not.toContain(valid.password);
    db.close();
  });

  test('refuses to create a second admin', async () => {
    const db = createTestDb();
    await createInitialAdmin(db, valid);
    await expect(createInitialAdmin(db, { ...valid, email: 'other@vault24.test' })).rejects.toThrow(/already exists/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n).toBe(1);
    db.close();
  });

  test('rejects weak passwords', async () => {
    const db = createTestDb();
    await expect(createInitialAdmin(db, { ...valid, password: 'password' })).rejects.toThrow(/Password/);
    db.close();
  });
});

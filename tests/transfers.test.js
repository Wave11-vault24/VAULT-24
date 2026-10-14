'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const { createWorld } = require('./harness');
const { openDatabase } = require('../src/config/database');
const { migrate } = require('../src/db/migrate');
const { generateAccountNumber } = require('../src/utils/account-number');
const { reconcile } = require('../src/services/admin.service');
const { FAKE_HASH } = require('./helpers');

let w;
beforeAll(async () => { w = await createWorld(); });
afterAll(() => w.close());

const key = () => crypto.randomUUID();

/** A customer with a funded account plus a separate recipient. */
async function scenario({ balance = 100_000, senderType = 'savings', recipientType = 'business' } = {}) {
  const sender = w.addUser({ name: 'Jane Mwangi' });
  const recipient = w.addUser({ name: 'John Daka' });
  const from = w.addAccount(sender, { type: senderType, balance });
  const to = w.addAccount(recipient, { type: recipientType });
  const client = await w.login(sender);
  return { sender, recipient, from, to, client };
}

const transfer = (s, extra = {}) => s.client.post('/api/transfers', {
  from_account_number: s.from.account_number, to_account_number: s.to.account_number,
  amount_minor: 25_000, currency: 'ZMW', narration: 'Rent share', idempotency_key: key(), ...extra,
});

const transferRows = (fromId) => w.db.prepare('SELECT * FROM transfers WHERE sender_account_id = ?').all(fromId);

describe('Customer transfers', () => {
  test('a valid transfer moves money atomically with linked debit and credit entries', async () => {
    const s = await scenario();
    const res = await transfer(s);
    expect(res.status).toBe(201);
    expect(res.body.transfer).toMatchObject({
      status: 'completed', amount_minor: 25_000, amount: '250.00', from_account_number: s.from.account_number,
      to_account_number: s.to.account_number, to_account_name: 'John Daka', narration: 'Rent share', sender_balance_after_minor: 75_000,
    });
    expect(res.body.transfer.reference).toMatch(/^TRF-\d{8}-[0-9A-Z]{10}$/);
    expect(w.balanceOf(s.from.id)).toBe(75_000);
    expect(w.balanceOf(s.to.id)).toBe(25_000);

    const [t] = transferRows(s.from.id);
    expect(t).toMatchObject({ status: 'completed', initiated_by: s.sender.id });
    expect(t.completed_at).not.toBeNull();
    const legs = w.db.prepare('SELECT transaction_type, account_id, amount_minor, balance_after_minor FROM transactions WHERE transfer_id = ? ORDER BY id').all(t.id);
    expect(legs).toEqual([
      { transaction_type: 'transfer_debit', account_id: s.from.id, amount_minor: -25_000, balance_after_minor: 75_000 },
      { transaction_type: 'transfer_credit', account_id: s.to.id, amount_minor: 25_000, balance_after_minor: 25_000 },
    ]);
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'transfer.create' AND outcome = 'success' AND target_id = ?").get(String(t.id)).n).toBe(1);
  });

  test('both parties see it in their history; the sender\'s balance is hidden from the recipient', async () => {
    const s = await scenario();
    const ref = (await transfer(s)).body.transfer.reference;
    const asSender = await s.client.get(`/api/transfers/${ref}`);
    expect(asSender.body.transfer.sender_balance_after_minor).toBe(75_000);
    const recipientClient = await w.login(s.recipient);
    const asRecipient = await recipientClient.get(`/api/transfers/${ref}`);
    expect(asRecipient.status).toBe(200);
    expect(asRecipient.body.transfer.sender_balance_after_minor).toBeUndefined();
    const history = await recipientClient.get(`/api/accounts/${s.to.id}/transactions`);
    expect(history.body.transactions[0]).toMatchObject({ transaction_type: 'transfer_credit', transfer_reference: ref });
  });

  test('an unrelated customer cannot look up a transfer (404)', async () => {
    const s = await scenario();
    const ref = (await transfer(s)).body.transfer.reference;
    const stranger = await w.login(w.addUser());
    expect((await stranger.get(`/api/transfers/${ref}`)).status).toBe(404);
  });

  test('insufficient funds is rejected and no money moves', async () => {
    const s = await scenario({ balance: 10_000 });
    const res = await transfer(s, { amount_minor: 10_001 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INSUFFICIENT_FUNDS');
    expect(res.body.transfer.status).toBe('failed');
    expect(w.balanceOf(s.from.id)).toBe(10_000);
    expect(w.balanceOf(s.to.id)).toBe(0);
    expect(w.db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE transfer_id IS NOT NULL AND account_id IN (?, ?)').get(s.from.id, s.to.id).n).toBe(0);
  });

  test('transferring the exact balance leaves zero (no off-by-one)', async () => {
    const s = await scenario({ balance: 10_000 });
    expect((await transfer(s, { amount_minor: 10_000 })).status).toBe(201);
    expect(w.balanceOf(s.from.id)).toBe(0);
  });

  test('self-transfers are rejected', async () => {
    const s = await scenario();
    const res = await transfer(s, { to_account_number: s.from.account_number });
    expect(res.status).toBe(400);
  });

  test('transfers between two of the customer\'s own accounts are allowed', async () => {
    const s = await scenario();
    const own = w.addAccount(s.sender, { type: 'student' });
    expect((await transfer(s, { to_account_number: own.account_number })).status).toBe(201);
  });

  test('a customer cannot send from an account they do not own', async () => {
    const s = await scenario();
    const victim = w.addAccount(w.addUser(), { balance: 500_000 });
    const res = await transfer(s, { from_account_number: victim.account_number });
    expect(res.status).toBe(404);
    expect(w.balanceOf(victim.id)).toBe(500_000);
  });

  test('staff and admins cannot initiate customer transfers', async () => {
    const s = await scenario();
    for (const u of [w.staff, w.admin]) {
      const c = await w.login(u);
      const res = await c.post('/api/transfers', {
        from_account_number: s.from.account_number, to_account_number: s.to.account_number, amount_minor: 100, currency: 'ZMW', idempotency_key: key(),
      });
      expect(res.status).toBe(403);
    }
    expect(w.balanceOf(s.from.id)).toBe(100_000);
  });

  test('frozen sender, frozen recipient and unknown recipient are rejected', async () => {
    const s = await scenario();
    const frozenTo = w.addAccount(w.addUser(), { status: 'frozen' });
    expect((await transfer(s, { to_account_number: frozenTo.account_number })).body.error.code).toBe('RECIPIENT_NOT_AVAILABLE');
    expect((await transfer(s, { to_account_number: 'V244099999999' })).status).toBe(404);
    w.db.prepare("UPDATE accounts SET status = 'frozen' WHERE id = ?").run(s.from.id);
    expect((await transfer(s)).body.error.code).toBe('SENDER_ACCOUNT_NOT_ACTIVE');
    expect(w.balanceOf(s.from.id)).toBe(100_000);
  });

  test.each([['zero', 0], ['negative', -5], ['fractional', 1.5], ['string', '100']])('invalid amount (%s) is rejected', async (_l, amount) => {
    const s = await scenario();
    expect((await transfer(s, { amount_minor: amount })).status).toBe(400);
  });

  test('missing or malformed idempotency keys are rejected', async () => {
    const s = await scenario();
    expect((await transfer(s, { idempotency_key: undefined })).status).toBe(400);
    expect((await transfer(s, { idempotency_key: 'short' })).status).toBe(400);
    expect((await transfer(s, { idempotency_key: 'has spaces in it but long enough' })).status).toBe(400);
  });
});

describe('Idempotency', () => {
  test('repeating a key returns the original result and does not duplicate the transfer', async () => {
    const s = await scenario();
    const k = key();
    const first = await transfer(s, { idempotency_key: k });
    const second = await transfer(s, { idempotency_key: k });
    const third = await transfer(s, { idempotency_key: k });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.transfer.reference).toBe(first.body.transfer.reference);
    expect(third.body.transfer.reference).toBe(first.body.transfer.reference);
    expect(transferRows(s.from.id)).toHaveLength(1);
    expect(w.balanceOf(s.from.id)).toBe(75_000);
  });

  test('reusing a key with a different payload is rejected', async () => {
    const s = await scenario();
    const k = key();
    await transfer(s, { idempotency_key: k });
    const res = await transfer(s, { idempotency_key: k, amount_minor: 99 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(w.balanceOf(s.from.id)).toBe(75_000);
  });

  test('a failed outcome is also idempotent: topping up does not make the old key succeed later', async () => {
    const s = await scenario({ balance: 1_000 });
    const k = key();
    expect((await transfer(s, { idempotency_key: k, amount_minor: 5_000 })).status).toBe(422);
    w.fund(s.from.id, 10_000);
    const retry = await transfer(s, { idempotency_key: k, amount_minor: 5_000 });
    expect(retry.status).toBe(422);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(w.balanceOf(s.from.id)).toBe(11_000);
  });

  test('keys are scoped per user: two customers may use the same key', async () => {
    const a = await scenario();
    const b = await scenario();
    const k = key();
    expect((await transfer(a, { idempotency_key: k })).status).toBe(201);
    expect((await transfer(b, { idempotency_key: k })).status).toBe(201);
  });
});

describe('Daily limits per account type', () => {
  test('student accounts are capped at 5,000.00 ZMW per day', async () => {
    const s = await scenario({ balance: 1_000_000, senderType: 'student' });
    expect((await transfer(s, { amount_minor: 300_000 })).status).toBe(201);
    expect((await transfer(s, { amount_minor: 200_000 })).status).toBe(201);
    const over = await transfer(s, { amount_minor: 1 });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('DAILY_LIMIT_EXCEEDED');
    expect(w.balanceOf(s.from.id)).toBe(500_000);
  });

  test('a business account can send more than a student account in one day', async () => {
    const s = await scenario({ balance: 3_000_000, senderType: 'business' });
    expect((await transfer(s, { amount_minor: 2_500_000 })).status).toBe(201);
  });
});

describe('Rollback', () => {
  test('a failure while writing the credit leg rolls back the debit, the credit and the transfer record', async () => {
    const s = await scenario();
    const k = key();
    w.db.exec("CREATE TEMP TRIGGER fail_credit BEFORE INSERT ON transactions WHEN NEW.transaction_type = 'transfer_credit' BEGIN SELECT RAISE(ABORT, 'simulated crash'); END;");
    try {
      const res = await transfer(s, { idempotency_key: k });
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toMatch(/simulated|SQLITE|stack/);
    } finally {
      w.db.exec('DROP TRIGGER temp.fail_credit');
    }
    expect(w.balanceOf(s.from.id)).toBe(100_000);
    expect(w.balanceOf(s.to.id)).toBe(0);
    expect(transferRows(s.from.id)).toHaveLength(0);

    // Nothing was committed, so retrying with the SAME key is safe and succeeds exactly once.
    expect((await transfer(s, { idempotency_key: k })).status).toBe(201);
    expect(w.balanceOf(s.from.id)).toBe(75_000);
    expect(transferRows(s.from.id)).toHaveLength(1);
  });
});

describe('Concurrency (single process, many simultaneous requests)', () => {
  test('20 parallel transfers of 100 against a balance of 1,000: exactly 10 succeed, no overdraft', async () => {
    const s = await scenario({ balance: 1_000 });
    const results = await Promise.all(Array.from({ length: 20 }, () => transfer(s, { amount_minor: 100 })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(10);
    expect(results.filter((r) => r.status === 422)).toHaveLength(10);
    expect(w.balanceOf(s.from.id)).toBe(0);
    expect(w.balanceOf(s.to.id)).toBe(1_000);
  });

  test('10 parallel requests with the same key create one transfer', async () => {
    const s = await scenario();
    const k = key();
    const results = await Promise.all(Array.from({ length: 10 }, () => transfer(s, { idempotency_key: k })));
    expect(new Set(results.map((r) => r.body.transfer.reference)).size).toBe(1);
    expect(transferRows(s.from.id)).toHaveLength(1);
    expect(w.balanceOf(s.from.id)).toBe(75_000);
  });

  test('the ledger reconciles with balances after everything above', () => {
    expect(reconcile(w.db)).toEqual([]);
  });
});

describe('Concurrency (multiple threads, separate connections, shared database file)', () => {
  let dir;
  let dbPath;
  let ids;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault24-conc-'));
    dbPath = path.join(dir, 'concurrency.db');
    const db = openDatabase(dbPath);
    migrate(db);
    const ins = (role, email, by) => Number(db.prepare(
      "INSERT INTO users (full_name, email, password_hash, role, verification_status, created_by) VALUES (?, ?, ?, ?, 'verified', ?)",
    ).run(`User ${email.split('@')[0]}`, email, FAKE_HASH, role, by).lastInsertRowid);
    const admin = ins('admin', 'a@vault24.test', null);
    const staff = ins('staff', 's@vault24.test', admin);
    const sender = ins('customer', 'c1@vault24.test', staff);
    const receiver = ins('customer', 'c2@vault24.test', staff);
    const acct = (owner, type) => {
      const num = generateAccountNumber(type);
      db.prepare("INSERT INTO accounts (account_number, account_name, user_id, account_type, currency, created_by) VALUES (?, 'User x', ?, ?, 'ZMW', ?)").run(num, owner, type, staff);
      return { id: db.prepare('SELECT id FROM accounts WHERE account_number = ?').get(num).id, number: num };
    };
    const from = acct(sender, 'business');
    const to = acct(receiver, 'savings');
    db.transaction(() => {
      db.prepare('UPDATE accounts SET balance_minor = 5000 WHERE id = ?').run(from.id);
      db.prepare("INSERT INTO transactions (reference, account_id, transaction_type, amount_minor, balance_after_minor, narration, performed_by) VALUES ('SEED-1', ?, 'cash_deposit', 5000, 5000, 'seed', ?)").run(from.id, staff);
    })();
    db.close();
    ids = { sender, from, to };
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const runWorkers = (n, data) => Promise.all(Array.from({ length: n }, (_, i) => new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'workers', 'transfer-worker.js'), {
      workerData: { dbPath, customerId: ids.sender, from: ids.from.number, to: ids.to.number, keyPrefix: `w${i}-${crypto.randomUUID()}`, ...data },
    });
    worker.once('message', resolve);
    worker.once('error', reject);
  })));

  test('8 threads x 25 transfers of 100 against a balance of 5,000: exactly 50 complete, never overdrawn', async () => {
    const outcomes = await runWorkers(8, { amount: 100, count: 25 });
    const total = outcomes.reduce((acc, o) => ({
      completed: acc.completed + o.completed, failed: acc.failed + o.failed, busy: acc.busy + o.busy, errors: acc.errors.concat(o.errors),
    }), { completed: 0, failed: 0, busy: 0, errors: [] });

    expect(total.errors).toEqual([]);
    expect(total.busy).toBe(0);
    expect(total.completed).toBe(50);
    expect(total.failed).toBe(150);

    const db = openDatabase(dbPath);
    try {
      expect(db.prepare('SELECT balance_minor FROM accounts WHERE id = ?').get(ids.from.id).balance_minor).toBe(0);
      expect(db.prepare('SELECT balance_minor FROM accounts WHERE id = ?').get(ids.to.id).balance_minor).toBe(5000);
      expect(reconcile(db)).toEqual([]);
    } finally {
      db.close();
    }
  }, 60_000);

  test('8 threads racing with one shared idempotency key create exactly one transfer', async () => {
    const db = openDatabase(dbPath);
    db.transaction(() => {
      db.prepare('UPDATE accounts SET balance_minor = balance_minor + 1000 WHERE id = ?').run(ids.from.id);
      const bal = db.prepare('SELECT balance_minor FROM accounts WHERE id = ?').get(ids.from.id).balance_minor;
      db.prepare("INSERT INTO transactions (reference, account_id, transaction_type, amount_minor, balance_after_minor, narration, performed_by) VALUES ('SEED-2', ?, 'cash_deposit', 1000, ?, 'seed', 2)").run(ids.from.id, bal);
    })();
    db.close();

    const sharedKey = `shared-${crypto.randomUUID()}`;
    const outcomes = await runWorkers(8, { amount: 300, count: 3, sharedKey });
    const completed = outcomes.reduce((n, o) => n + o.completed, 0);
    const replayed = outcomes.reduce((n, o) => n + o.replayed, 0);
    expect(completed).toBe(1);
    expect(replayed).toBe(23);

    const check = openDatabase(dbPath);
    try {
      expect(check.prepare('SELECT COUNT(*) AS n FROM transfers WHERE idempotency_key = ?').get(sharedKey).n).toBe(1);
      expect(check.prepare('SELECT balance_minor FROM accounts WHERE id = ?').get(ids.from.id).balance_minor).toBe(700);
      expect(reconcile(check)).toEqual([]);
    } finally {
      check.close();
    }
  }, 60_000);
});

'use strict';

const { createWorld } = require('./harness');

let w;
let staff;
beforeAll(async () => {
  w = await createWorld();
  staff = await w.login(w.staff);
});
afterAll(() => w.close());

function setup(opts = {}) {
  const owner = w.addUser({ name: 'Alex Example', ...opts.owner });
  const acct = w.addAccount(owner, { type: 'savings', ...opts.account });
  return { owner, acct };
}

const body = (acct, extra = {}) => ({
  account_number: acct.account_number, account_name: acct.account_name, amount_minor: 50_000, currency: 'ZMW', narration: 'Cash deposit at branch', ...extra,
});

const ledgerCount = (accountId) => w.db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?').get(accountId).n;

describe('Staff cash deposits', () => {
  test('a valid deposit updates the balance once, writes one ledger entry and returns a receipt', async () => {
    const { acct } = setup();
    const res = await staff.post('/api/staff/deposits', body(acct));
    expect(res.status).toBe(201);
    expect(res.body.receipt).toMatchObject({
      account_number: acct.account_number, account_name: 'Alex Example', amount_minor: 50_000, amount: '500.00',
      narration: 'Cash deposit at branch', balance_after_minor: 50_000, balance_after: '500.00', performed_by: w.staff.id,
    });
    expect(res.body.receipt.reference).toMatch(/^DEP-\d{8}-[0-9A-Z]{10}$/);
    expect(w.balanceOf(acct.id)).toBe(50_000);

    const entries = w.db.prepare('SELECT * FROM transactions WHERE account_id = ?').all(acct.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ transaction_type: 'cash_deposit', amount_minor: 50_000, balance_after_minor: 50_000, performed_by: w.staff.id, reference: res.body.receipt.reference });
    const auditRow = w.db.prepare("SELECT * FROM audit_logs WHERE action = 'deposit.create' AND outcome = 'success' AND target_id = ?").get(String(acct.id));
    expect(JSON.parse(auditRow.metadata_json).reference).toBe(res.body.receipt.reference);
  });

  test('a second deposit accumulates correctly', async () => {
    const { acct } = setup();
    await staff.post('/api/staff/deposits', body(acct, { amount_minor: 12_345 }));
    const res = await staff.post('/api/staff/deposits', body(acct, { amount_minor: 655 }));
    expect(res.body.receipt.balance_after_minor).toBe(13_000);
    expect(ledgerCount(acct.id)).toBe(2);
  });

  test('every deposit reference is unique', async () => {
    const { acct } = setup();
    const refs = new Set();
    for (let i = 0; i < 15; i++) refs.add((await staff.post('/api/staff/deposits', body(acct, { amount_minor: 100 }))).body.receipt.reference);
    expect(refs.size).toBe(15);
  });

  test('an incorrect account number fails safely', async () => {
    const res = await staff.post('/api/staff/deposits', { ...body({ account_number: 'V241099999999', account_name: 'Alex Example' }) });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ACCOUNT_NOT_FOUND');
  });

  test.each(['Alex Exampel', 'A. Example', 'Alex', 'Example Alex'])('account-name mismatch "%s" fails and nothing changes', async (name) => {
    const { acct } = setup();
    const res = await staff.post('/api/staff/deposits', body(acct, { account_name: name }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ACCOUNT_NAME_MISMATCH');
    expect(w.balanceOf(acct.id)).toBe(0);
    expect(ledgerCount(acct.id)).toBe(0);
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'deposit.create' AND outcome = 'failure' AND target_id = ?").get(acct.account_number).n).toBe(1);
  });

  test.each(['alex example', '  ALEX   EXAMPLE ', 'Ａｌｅｘ Example'])('documented normalisation accepts "%s"', async (name) => {
    const { acct } = setup();
    expect((await staff.post('/api/staff/deposits', body(acct, { account_name: name }))).status).toBe(201);
  });

  test.each([
    ['zero', 0], ['negative', -100], ['fractional', 10.5], ['string', '500'], ['over the limit', 10_000_001], ['huge', Number.MAX_SAFE_INTEGER + 2],
  ])('an invalid amount (%s) is rejected', async (_label, amount) => {
    const { acct } = setup();
    const res = await staff.post('/api/staff/deposits', body(acct, { amount_minor: amount }));
    expect(res.status).toBe(400);
    expect(w.balanceOf(acct.id)).toBe(0);
  });

  test('missing or invalid narration and currency are rejected', async () => {
    const { acct } = setup();
    expect((await staff.post('/api/staff/deposits', body(acct, { narration: '' }))).status).toBe(400);
    expect((await staff.post('/api/staff/deposits', body(acct, { narration: 'x'.repeat(141) }))).status).toBe(400);
    expect((await staff.post('/api/staff/deposits', body(acct, { narration: 'bad\u0000text' }))).status).toBe(400);
    expect((await staff.post('/api/staff/deposits', body(acct, { currency: 'zmw' }))).status).toBe(400);
    expect((await staff.post('/api/staff/deposits', body(acct, { currency: 'USD' }))).body.error.code).toBe('CURRENCY_MISMATCH');
  });

  test('staff cannot choose performed_by', async () => {
    const { acct } = setup();
    expect((await staff.post('/api/staff/deposits', body(acct, { performed_by: w.admin.id }))).status).toBe(400);
  });

  test('customers and admins cannot post deposits', async () => {
    const { owner, acct } = setup();
    const customer = await w.login(owner);
    expect((await customer.post('/api/staff/deposits', body(acct))).status).toBe(403);
    const admin = await w.login(w.admin);
    expect((await admin.post('/api/staff/deposits', body(acct))).status).toBe(403);
    expect(w.balanceOf(acct.id)).toBe(0);
  });

  test('frozen accounts and ineligible holders cannot receive deposits', async () => {
    const frozen = setup({ account: { status: 'frozen' } });
    expect((await staff.post('/api/staff/deposits', body(frozen.acct))).body.error.code).toBe('ACCOUNT_NOT_ACTIVE');
    const unverified = setup({ owner: { verification: 'pending' } });
    expect((await staff.post('/api/staff/deposits', body(unverified.acct))).body.error.code).toBe('CUSTOMER_NOT_ELIGIBLE');
    const suspended = setup({ owner: { status: 'suspended' } });
    expect((await staff.post('/api/staff/deposits', body(suspended.acct))).body.error.code).toBe('CUSTOMER_NOT_ELIGIBLE');
  });

  test('a failed ledger insert rolls back the balance update (and the success audit)', async () => {
    const { acct } = setup();
    const auditBefore = w.db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'deposit.create' AND outcome = 'success'").get().n;
    w.db.exec("CREATE TEMP TRIGGER fail_ledger BEFORE INSERT ON transactions BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END;");
    try {
      const res = await staff.post('/api/staff/deposits', body(acct));
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toMatch(/simulated|SQLITE|transactions/);
    } finally {
      w.db.exec('DROP TRIGGER temp.fail_ledger');
    }
    expect(w.balanceOf(acct.id)).toBe(0);
    expect(ledgerCount(acct.id)).toBe(0);
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'deposit.create' AND outcome = 'success'").get().n).toBe(auditBefore);
  });

  test('a failed audit insert also rolls back the deposit', async () => {
    const { acct } = setup();
    w.db.exec("CREATE TEMP TRIGGER fail_audit BEFORE INSERT ON audit_logs WHEN NEW.action = 'deposit.create' AND NEW.outcome = 'success' BEGIN SELECT RAISE(ABORT, 'audit down'); END;");
    try {
      expect((await staff.post('/api/staff/deposits', body(acct))).status).toBe(500);
    } finally {
      w.db.exec('DROP TRIGGER temp.fail_audit');
    }
    expect(w.balanceOf(acct.id)).toBe(0);
    expect(ledgerCount(acct.id)).toBe(0);
  });
});

'use strict';

const request = require('supertest');
const { createWorld } = require('./harness');
const { ACCOUNT_TYPE_KEYS, ACCOUNT_TYPES } = require('../src/config/constants');

let w;
let staff;
beforeAll(async () => {
  w = await createWorld();
  staff = await w.login(w.staff);
});
afterAll(() => w.close());

describe('Account opening', () => {
  test.each(ACCOUNT_TYPE_KEYS)('staff can open a %s account for a verified customer', async (type) => {
    const customer = w.addUser({ name: 'Jane Mwangi' });
    const res = await staff.post('/api/accounts', { customer_id: customer.id, account_type: type });
    expect(res.status).toBe(201);
    expect(res.body.account).toMatchObject({
      account_type: type,
      account_type_label: ACCOUNT_TYPES[type].label,
      account_name: 'Jane Mwangi',
      currency: 'ZMW',
      balance_minor: 0,
      balance: '0.00',
      status: 'active',
    });
    expect(res.body.account.account_number).toMatch(new RegExp(`^V24${ACCOUNT_TYPES[type].code}\\d{8}$`));
    const row = w.db.prepare('SELECT created_by FROM accounts WHERE id = ?').get(res.body.account.id);
    expect(row.created_by).toBe(w.staff.id);
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'account.open' AND target_id = ?").get(String(res.body.account.id)).n).toBe(1);
  });

  test('one customer can hold all four types, but not two open accounts of the same type', async () => {
    const customer = w.addUser();
    for (const type of ACCOUNT_TYPE_KEYS) {
      expect((await staff.post('/api/accounts', { customer_id: customer.id, account_type: type })).status).toBe(201);
    }
    const dup = await staff.post('/api/accounts', { customer_id: customer.id, account_type: 'savings' });
    expect(dup.status).toBe(409);
  });

  test('unsupported account types are rejected', async () => {
    const customer = w.addUser();
    expect((await staff.post('/api/accounts', { customer_id: customer.id, account_type: 'checking' })).status).toBe(400);
  });

  test('unverified customers cannot have accounts opened', async () => {
    for (const verification of ['pending', 'rejected']) {
      const customer = w.addUser({ verification });
      const res = await staff.post('/api/accounts', { customer_id: customer.id, account_type: 'savings' });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('IDENTITY_NOT_VERIFIED');
    }
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'account.open' AND outcome = 'failure'").get().n).toBeGreaterThanOrEqual(2);
  });

  test('suspended customers and non-customers are not eligible', async () => {
    const suspended = w.addUser({ status: 'suspended' });
    expect((await staff.post('/api/accounts', { customer_id: suspended.id, account_type: 'savings' })).body.error.code).toBe('CUSTOMER_NOT_ELIGIBLE');
    expect((await staff.post('/api/accounts', { customer_id: w.staff.id, account_type: 'savings' })).status).toBe(404);
  });

  test('client-supplied balance, number, name or owner fields are rejected', async () => {
    const customer = w.addUser();
    for (const extra of [{ balance_minor: 1_000_000 }, { account_number: 'V241000000001' }, { account_name: 'Someone Else' }, { created_by: 1 }]) {
      const res = await staff.post('/api/accounts', { customer_id: customer.id, account_type: 'business', ...extra });
      expect(res.status).toBe(400);
    }
  });

  test('customers cannot open accounts, even with a direct HTTP request', async () => {
    const customer = w.addUser();
    const c = await w.login(customer);
    const res = await c.post('/api/accounts', { customer_id: customer.id, account_type: 'savings' });
    expect(res.status).toBe(403);
    expect(w.db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE user_id = ?').get(customer.id).n).toBe(0);
  });

  test('admins cannot open accounts (staff-only)', async () => {
    const admin = await w.login(w.admin);
    expect((await admin.post('/api/accounts', { customer_id: w.addUser().id, account_type: 'savings' })).status).toBe(403);
  });

  test('anonymous users cannot open or view accounts', async () => {
    expect((await request(w.app).get('/api/accounts')).status).toBe(401);
  });
});

describe('Account access', () => {
  let alice;
  let bob;
  let aliceAcct;
  let bobAcct;
  beforeAll(() => {
    alice = w.addUser({ name: 'Alice Tembo' });
    bob = w.addUser({ name: 'Bob Zulu' });
    aliceAcct = w.addAccount(alice, { type: 'salary', balance: 75_000 });
    bobAcct = w.addAccount(bob, { type: 'student', balance: 5_000 });
  });

  test('customers list only their own accounts', async () => {
    const c = await w.login(alice);
    const res = await c.get('/api/accounts');
    expect(res.status).toBe(200);
    expect(res.body.accounts.map((a) => a.id)).toEqual([aliceAcct.id]);
    expect(res.body.accounts[0]).toMatchObject({ balance_minor: 75_000, balance: '750.00', available_balance_minor: 75_000 });
  });

  test('customers cannot read another customer\'s account or history (404, not 403)', async () => {
    const c = await w.login(alice);
    expect((await c.get(`/api/accounts/${bobAcct.id}`)).status).toBe(404);
    expect((await c.get(`/api/accounts/${bobAcct.id}/transactions`)).status).toBe(404);
    expect((await c.get('/api/accounts/999999')).status).toBe(404);
  });

  test('customers cannot use ?customer_id to see other people\'s accounts', async () => {
    const c = await w.login(alice);
    const res = await c.get(`/api/accounts?customer_id=${bob.id}`);
    expect(res.body.accounts.every((a) => a.user_id === alice.id)).toBe(true);
  });

  test('customers can read their own transaction history with a total count', async () => {
    const c = await w.login(alice);
    const res = await c.get(`/api/accounts/${aliceAcct.id}/transactions?limit=10`);
    expect(res.status).toBe(200);
    expect(res.body.total_count).toBe(1);
    expect(res.body.transactions[0]).toMatchObject({ transaction_type: 'cash_deposit', direction: 'credit', amount: '750.00' });
  });

  test('staff must name a customer to list accounts', async () => {
    expect((await staff.get('/api/accounts')).status).toBe(400);
    expect((await staff.get(`/api/accounts?customer_id=${bob.id}`)).body.accounts[0].id).toBe(bobAcct.id);
  });

  test('staff lookup returns holder details for deposit checks but no balance', async () => {
    const res = await staff.get(`/api/staff/accounts/lookup?account_number=${bobAcct.account_number}`);
    expect(res.status).toBe(200);
    expect(res.body.account).toMatchObject({ account_name: 'Bob Zulu', account_type: 'student', status: 'active' });
    expect(res.body.account.balance_minor).toBeUndefined();
  });

  test('account types catalogue lists all four with limits', async () => {
    const c = await w.login(alice);
    const res = await c.get('/api/accounts/types');
    expect(res.body.account_types.map((t) => t.account_type)).toEqual(['savings', 'student', 'salary', 'business']);
  });

  test('there is no endpoint for editing balances', async () => {
    const admin = await w.login(w.admin);
    for (const [method, url] of [['patch', `/api/accounts/${aliceAcct.id}`], ['post', `/api/accounts/${aliceAcct.id}`], ['patch', `/api/admin/accounts/${aliceAcct.id}`]]) {
      const res = await admin.agent[method](url).set('X-CSRF-Token', admin.csrf).send({ balance_minor: 999_999_999 });
      expect(res.status).toBe(404);
    }
    expect(w.balanceOf(aliceAcct.id)).toBe(75_000);
  });
});

describe('Admin account status', () => {
  test('admin can freeze and unfreeze; closing requires a zero balance', async () => {
    const admin = await w.login(w.admin);
    const owner = w.addUser();
    const acct = w.addAccount(owner, { balance: 100 });
    expect((await admin.patch(`/api/admin/accounts/${acct.id}/status`, { status: 'frozen', reason: 'Suspicious activity' })).body.account.status).toBe('frozen');
    expect((await admin.patch(`/api/admin/accounts/${acct.id}/status`, { status: 'closed', reason: 'Customer request' })).body.error.code).toBe('BALANCE_NOT_ZERO');
    const empty = w.addAccount(w.addUser());
    expect((await admin.patch(`/api/admin/accounts/${empty.id}/status`, { status: 'closed', reason: 'Customer request' })).status).toBe(200);
    expect((await admin.patch(`/api/admin/accounts/${empty.id}/status`, { status: 'active', reason: 'Reopen' })).status).toBe(409);
  });

  test('staff cannot change account status', async () => {
    const acct = w.addAccount(w.addUser());
    expect((await staff.patch(`/api/admin/accounts/${acct.id}/status`, { status: 'frozen', reason: 'test' })).status).toBe(403);
  });
});

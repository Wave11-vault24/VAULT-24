'use strict';

const request = require('supertest');
const { createWorld } = require('./harness');
const { createApp } = require('../src/app');
const { loadConfig } = require('../src/config/env');
const { reconcile } = require('../src/services/admin.service');
const { sanitize } = require('../src/services/audit.service');

let w;
beforeAll(async () => { w = await createWorld(); });
afterAll(() => w.close());

const PROTECTED = [
  ['get', '/api/auth/me'], ['post', '/api/auth/logout'], ['get', '/api/profile'], ['patch', '/api/profile'],
  ['get', '/api/accounts'], ['get', '/api/accounts/1'], ['get', '/api/accounts/1/transactions'], ['post', '/api/accounts'],
  ['post', '/api/transfers'], ['get', '/api/transfers/TRF-20260101-ABCDEFGHJK'],
  ['post', '/api/staff/customers'], ['get', '/api/staff/customers'], ['post', '/api/staff/deposits'], ['get', '/api/staff/accounts/lookup'],
  ['get', '/api/documents/1/download'],
  ['get', '/api/admin/users'], ['post', '/api/admin/staff'], ['get', '/api/admin/audit-logs'], ['patch', '/api/admin/documents/1/review'],
];

const STAFF_ONLY = [['post', '/api/staff/customers'], ['get', '/api/staff/customers'], ['post', '/api/staff/deposits'], ['post', '/api/accounts'], ['get', '/api/staff/accounts/lookup?account_number=V241000000001']];
const ADMIN_ONLY = [['get', '/api/admin/users'], ['post', '/api/admin/staff'], ['get', '/api/admin/audit-logs'], ['get', '/api/admin/documents'], ['patch', '/api/admin/documents/1/review'], ['get', '/api/admin/reconciliation']];

const call = (client, method, url) => client.agent[method](url).set('X-CSRF-Token', client.csrf).send({});

describe('Route protection matrix', () => {
  test.each(PROTECTED)('anonymous %s %s is rejected with 401', async (method, url) => {
    const anon = await w.anonymous();
    expect((await call(anon, method, url)).status).toBe(401);
  });

  test.each([...STAFF_ONLY, ...ADMIN_ONLY])('customers are forbidden from %s %s', async (method, url) => {
    const c = await w.login(w.addUser());
    expect((await call(c, method, url)).status).toBe(403);
  });

  test.each(ADMIN_ONLY)('staff are forbidden from %s %s', async (method, url) => {
    const c = await w.login(w.staff);
    expect((await call(c, method, url)).status).toBe(403);
  });

  test('authorization failures are audited', async () => {
    const user = w.addUser();
    const c = await w.login(user);
    await c.get('/api/admin/users');
    const row = w.db.prepare("SELECT * FROM audit_logs WHERE action = 'authz.denied' AND actor_user_id = ? ORDER BY id DESC").get(user.id);
    expect(row.outcome).toBe('failure');
  });

  test.each([['locked'], ['suspended']])('%s users cannot perform protected operations', async (status) => {
    const user = w.addUser();
    const acct = w.addAccount(user, { balance: 10_000 });
    const c = await w.login(user);
    w.db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, user.id);
    const res = await c.post('/api/transfers', {
      from_account_number: acct.account_number, to_account_number: w.addAccount(w.addUser()).account_number,
      amount_minor: 100, currency: 'ZMW', idempotency_key: 'k-1234567890abcdef',
    });
    expect(res.status).toBe(403);
    expect(w.balanceOf(acct.id)).toBe(10_000);
  });

  test('a suspended staff member cannot post deposits', async () => {
    const staff2 = w.addUser({ role: 'staff' });
    const c = await w.login(staff2);
    w.db.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").run(staff2.id);
    const acct = w.addAccount(w.addUser());
    expect((await c.post('/api/staff/deposits', { account_number: acct.account_number, account_name: acct.account_name, amount_minor: 100, currency: 'ZMW', narration: 'Cash in' })).status).toBe(403);
  });
});

describe('Injection resistance', () => {
  test('SQL metacharacters in search are treated as data', async () => {
    const staff = await w.login(w.staff);
    const before = w.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    for (const q of ["' OR 1=1 --", "%' UNION SELECT password_hash FROM users --", '%%', '__']) {
      const res = await staff.get(`/api/staff/customers?q=${encodeURIComponent(q)}`);
      expect(res.status).toBe(200);
      expect(res.body.customers).toEqual([]);
      expect(JSON.stringify(res.body)).not.toMatch(/argon2/);
    }
    expect(w.db.prepare('SELECT COUNT(*) AS n FROM users').get().n).toBe(before);
  });

  test('route parameters reject non-numeric IDs', async () => {
    const c = await w.login(w.addUser());
    expect((await c.get('/api/accounts/1%20OR%201=1')).status).toBe(400);
    expect((await c.get('/api/accounts/-1')).status).toBe(400);
  });

  test('JSON prototype-pollution payloads are rejected by strict schemas', async () => {
    const c = await w.login(w.addUser());
    const res = await c.agent.patch('/api/profile').set('X-CSRF-Token', c.csrf).set('Content-Type', 'application/json')
      .send('{"phone_number":"+260971000000","__proto__":{"role":"admin"}}');
    expect([200, 400]).toContain(res.status);
    expect({}.role).toBeUndefined();
  });
});

describe('Safe logging and auditing', () => {
  test('request logs never contain passwords, cookies or CSRF tokens', async () => {
    const lines = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((...a) => lines.push(a.join(' ')));
    const spyErr = jest.spyOn(console, 'error').mockImplementation((...a) => lines.push(a.join(' ')));
    try {
      // An app instance with logging switched on (non-test config).
      const config = loadConfig({ NODE_ENV: 'development', SESSION_SECRET: 'x'.repeat(40), DOCUMENT_STORAGE_PATH: w.storageDir });
      const app = createApp({ db: w.db, config, options: { rateLimit: false } });
      const user = w.addUser();
      const agent = request.agent(app);
      const csrf = (await agent.get('/api/auth/csrf-token')).body.csrf_token;
      const login = await agent.post('/api/auth/login?password=Leaky-Query-1').set('X-CSRF-Token', csrf).send({ email: user.email, password: w.PASSWORD });
      expect(login.status).toBe(200);
      await agent.post('/api/auth/login').set('X-CSRF-Token', 'bad').send({ email: user.email, password: 'Secret-Wrong-Pass1' });
      const sid = login.headers['set-cookie'][0].split(';')[0].split('=')[1];
      app.locals.sessionStore.close();

      const all = lines.join('\n');
      expect(lines.length).toBeGreaterThan(0);
      for (const secret of [w.PASSWORD, 'Secret-Wrong-Pass1', 'Leaky-Query-1', csrf, login.body.csrf_token, decodeURIComponent(sid), 'x'.repeat(40)]) {
        expect(all).not.toContain(secret);
      }
    } finally {
      spy.mockRestore();
      spyErr.mockRestore();
    }
  });

  test('audit logs and session rows never contain passwords or hashes', async () => {
    const user = w.addUser({ mustChange: 1 });
    const c = await w.login(user);
    await c.post('/api/auth/change-password', { current_password: w.PASSWORD, new_password: 'Unique-Secret-99x' });
    const audits = w.db.prepare('SELECT metadata_json FROM audit_logs').all().map((r) => r.metadata_json).join('\n');
    const sessions = w.db.prepare('SELECT sess FROM sessions').all().map((r) => r.sess).join('\n');
    for (const blob of [audits, sessions]) {
      expect(blob).not.toContain(w.PASSWORD);
      expect(blob).not.toContain('Unique-Secret-99x');
      expect(blob).not.toMatch(/\$argon2/);
    }
  });

  test('audit metadata sanitiser redacts sensitive keys at any depth', () => {
    expect(sanitize({ password: 'p', nested: { session_id: 's', csrfToken: 't', ok: 1 }, list: [{ authorization: 'Bearer x' }] }))
      .toEqual({ password: '[redacted]', nested: { session_id: '[redacted]', csrfToken: '[redacted]', ok: 1 }, list: [{ authorization: '[redacted]' }] });
  });

  test('audit logs are not editable through any endpoint', async () => {
    const admin = await w.login(w.admin);
    const id = w.db.prepare('SELECT id FROM audit_logs ORDER BY id LIMIT 1').get().id;
    for (const method of ['patch', 'post', 'delete']) {
      expect((await admin.agent[method](`/api/admin/audit-logs/${id}`).set('X-CSRF-Token', admin.csrf).send({ outcome: 'success' })).status).toBe(404);
    }
    const list = await admin.get('/api/admin/audit-logs?limit=5');
    expect(list.status).toBe(200);
    expect(list.body.audit_logs.length).toBeLessThanOrEqual(5);
  });
});

describe('Error responses', () => {
  test('unexpected server errors return a generic message with no stack trace or SQL', async () => {
    const user = w.addUser();
    const c = await w.login(user);
    w.db.exec("CREATE TEMP TRIGGER boom BEFORE UPDATE ON users BEGIN SELECT RAISE(ABORT, 'internal detail /var/secret.db'); END;");
    try {
      const res = await c.patch('/api/profile', { phone_number: '+260971234567' });
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', request_id: expect.any(String) } });
    } finally {
      w.db.exec('DROP TRIGGER temp.boom');
    }
  });

  test('SQLITE_BUSY becomes a retryable 503', async () => {
    const user = w.addUser();
    const c = await w.login(user);
    const orig = w.db.prepare.bind(w.db);
    const spy = jest.spyOn(w.db, 'prepare').mockImplementation((sql) => {
      if (/UPDATE users SET phone_number/.test(sql)) throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
      return orig(sql);
    });
    try {
      const res = await c.patch('/api/profile', { phone_number: '+260971234567' });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('SERVICE_BUSY');
      expect(res.headers['retry-after']).toBe('1');
    } finally {
      spy.mockRestore();
    }
  });

  test('responses on /api are marked no-store', async () => {
    const c = await w.login(w.addUser());
    expect((await c.get('/api/accounts')).headers['cache-control']).toBe('no-store');
  });
});

describe('Ledger consistency', () => {
  test('admin reconciliation endpoint reports healthy', async () => {
    const admin = await w.login(w.admin);
    const res = await admin.get('/api/admin/reconciliation');
    expect(res.body).toEqual({ healthy: true, mismatches: [] });
  });

  test('reconciliation detects a tampered balance', () => {
    const acct = w.addAccount(w.addUser(), { balance: 1_000 });
    w.db.prepare('UPDATE accounts SET balance_minor = 999999 WHERE id = ?').run(acct.id);
    expect(reconcile(w.db).map((r) => r.id)).toContain(acct.id);
    w.db.prepare('UPDATE accounts SET balance_minor = 1000 WHERE id = ?').run(acct.id);
    expect(reconcile(w.db)).toEqual([]);
  });
});

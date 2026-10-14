'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/utils/password');
const { generateAccountNumber } = require('../src/utils/account-number');
const { createTestDb, testConfig } = require('./helpers');
const { syntheticIdentityPdf } = require('../scripts/lib/synthetic-pdf');

const PASSWORD = 'Fictional-Passw0rd';
let passwordHashPromise;
const passwordHash = () => (passwordHashPromise ||= hashPassword(PASSWORD));

/**
 * A full, isolated Vault24 instance: in-memory DB, temp document storage,
 * bootstrap admin + one staff member. Call world.close() in afterAll.
 */
async function createWorld({ rateLimit = false } = {}) {
  const db = createTestDb();
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault24-docs-'));
  const config = testConfig({ DOCUMENT_STORAGE_PATH: storageDir });
  const app = createApp({ db, config, options: { rateLimit } });
  const hash = await passwordHash();
  let seq = 0;

  function addUser({ role = 'customer', name, status = 'active', verification = 'verified', createdBy, mustChange = 0 } = {}) {
    seq += 1;
    const email = `${role}${seq}@vault24.test`;
    const fullName = name || `Test ${role.charAt(0).toUpperCase()}${role.slice(1)} ${String.fromCharCode(64 + (seq % 26) + 1)}`;
    const id = Number(db.prepare(`
      INSERT INTO users (full_name, email, password_hash, role, status, verification_status, must_change_password, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(fullName, email, hash, role, status, verification, mustChange, role === 'admin' ? null : (createdBy ?? world.admin.id)).lastInsertRowid);
    return { id, email, full_name: fullName, role };
  }

  function addAccount(owner, { type = 'savings', balance = 0, status = 'active' } = {}) {
    const number = generateAccountNumber(type);
    const id = Number(db.prepare(`
      INSERT INTO accounts (account_number, account_name, user_id, account_type, currency, created_by)
      VALUES (?, ?, ?, ?, 'ZMW', ?)
    `).run(number, owner.full_name, owner.id, type, world.staff.id).lastInsertRowid);
    if (balance > 0) fund(id, balance);
    if (status !== 'active') db.prepare('UPDATE accounts SET status = ? WHERE id = ?').run(status, id);
    return { id, account_number: number, account_name: owner.full_name };
  }

  // Give an account money through a proper ledger entry so reconciliation holds.
  function fund(accountId, amount) {
    db.transaction(() => {
      db.prepare('UPDATE accounts SET balance_minor = balance_minor + ? WHERE id = ?').run(amount, accountId);
      const bal = db.prepare('SELECT balance_minor FROM accounts WHERE id = ?').get(accountId).balance_minor;
      db.prepare(`INSERT INTO transactions (reference, account_id, transaction_type, amount_minor, balance_after_minor, narration, performed_by)
                  VALUES (?, ?, 'cash_deposit', ?, ?, 'Test funding', ?)`).run(`FUND-${accountId}-${Math.random()}`, accountId, amount, bal, world.staff.id);
    })();
  }

  const balanceOf = (accountId) => db.prepare('SELECT balance_minor FROM accounts WHERE id = ?').get(accountId).balance_minor;

  /** A cookie-keeping client with a CSRF token. Not logged in. */
  async function anonymous() {
    const agent = request.agent(app);
    const res = await agent.get('/api/auth/csrf-token');
    return wrap(agent, res.body.csrf_token);
  }

  /** Logged-in client for a user created with addUser (shared PASSWORD). */
  async function login(user) {
    const client = await anonymous();
    const res = await client.post('/api/auth/login', { email: user.email, password: PASSWORD });
    if (res.status !== 200) throw new Error(`login failed for ${user.email}: ${res.status} ${JSON.stringify(res.body)}`);
    client.csrf = res.body.csrf_token;
    return client;
  }

  function wrap(agent, csrf) {
    const c = {
      agent,
      csrf,
      get: (url) => agent.get(url),
      post: (url, body) => agent.post(url).set('X-CSRF-Token', c.csrf).send(body),
      patch: (url, body) => agent.patch(url).set('X-CSRF-Token', c.csrf).send(body),
      multipart: (url) => agent.post(url).set('X-CSRF-Token', c.csrf),
    };
    return c;
  }

  const world = {
    app, db, config, storageDir, addUser, addAccount, fund, balanceOf, anonymous, login, PASSWORD,
    pdf: syntheticIdentityPdf,
    close() {
      app.locals.sessionStore.close();
      db.close();
      fs.rmSync(storageDir, { recursive: true, force: true });
    },
  };
  world.admin = addUser({ role: 'admin', name: 'Ada Admin' });
  world.staff = addUser({ role: 'staff', name: 'Tom Teller' });
  return world;
}

module.exports = { createWorld, PASSWORD };

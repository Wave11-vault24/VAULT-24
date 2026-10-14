'use strict';

const request = require('supertest');
const { createWorld } = require('./harness');

describe('Authentication and sessions', () => {
  let w;
  beforeAll(async () => { w = await createWorld(); });
  afterAll(() => w.close());

  test('login without a CSRF token is rejected', async () => {
    const user = w.addUser();
    const res = await request(w.app).post('/api/auth/login').send({ email: user.email, password: w.PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_INVALID');
  });

  test('successful login returns the profile, never the hash, and sets a hardened cookie', async () => {
    const user = w.addUser();
    const c = await w.anonymous();
    const res = await c.post('/api/auth/login', { email: user.email.toUpperCase(), password: w.PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(user.email);
    expect(JSON.stringify(res.body)).not.toMatch(/argon2|password_hash/);
    const cookie = res.headers['set-cookie'].join(';');
    expect(cookie).toMatch(/vault24\.sid=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    const me = await c.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(user.id);
  });

  test('session ID is regenerated at login (no session fixation)', async () => {
    const user = w.addUser();
    const c = await w.anonymous();
    const before = w.db.prepare('SELECT sid FROM sessions').all().map((r) => r.sid);
    await c.post('/api/auth/login', { email: user.email, password: w.PASSWORD });
    const owned = w.db.prepare("SELECT sid FROM sessions WHERE json_extract(sess, '$.userId') = ?").all(user.id);
    expect(owned).toHaveLength(1);
    expect(before).not.toContain(owned[0].sid);
  });

  test('wrong password and unknown email give the same generic error', async () => {
    const user = w.addUser();
    const c = await w.anonymous();
    const bad = await c.post('/api/auth/login', { email: user.email, password: 'Wrong-Passw0rd' });
    const unknown = await c.post('/api/auth/login', { email: 'nobody@vault24.test', password: 'Wrong-Passw0rd' });
    expect(bad.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(bad.body.error.message).toBe(unknown.body.error.message);
  });

  test.each([
    ["' OR '1'='1", 'x'],
    ["admin@vault24.test' --", 'x'],
    ['customer1@vault24.test', "' OR '1'='1"],
    ['customer1@vault24.test', '"; DROP TABLE users; --'],
  ])('SQL injection does not bypass login (email=%s)', async (email, password) => {
    const c = await w.anonymous();
    const res = await c.post('/api/auth/login', { email, password });
    expect([400, 401]).toContain(res.status);
    expect((await c.get('/api/auth/me')).status).toBe(401);
    expect(w.db.prepare('SELECT COUNT(*) AS n FROM users').get().n).toBeGreaterThan(0);
  });

  test('logout destroys the server-side session; the old cookie stops working', async () => {
    const user = w.addUser();
    const c = await w.login(user);
    const res = await c.post('/api/auth/logout');
    expect(res.status).toBe(204);
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE json_extract(sess, '$.userId') = ?").get(user.id).n).toBe(0);
    expect((await c.get('/api/auth/me')).status).toBe(401);
  });

  test('a replayed session cookie is useless after logout', async () => {
    const user = w.addUser();
    const c = await w.anonymous();
    const login = await c.post('/api/auth/login', { email: user.email, password: w.PASSWORD });
    const sidCookie = login.headers['set-cookie'][0].split(';')[0];
    c.csrf = login.body.csrf_token;
    await c.post('/api/auth/logout');
    const replay = await request(w.app).get('/api/auth/me').set('Cookie', sidCookie);
    expect(replay.status).toBe(401);
  });

  test('five consecutive failures lock the user; then even the right password is refused', async () => {
    const user = w.addUser();
    const c = await w.anonymous();
    for (let i = 0; i < 5; i++) await c.post('/api/auth/login', { email: user.email, password: 'Wrong-Passw0rd' });
    expect(w.db.prepare('SELECT status FROM users WHERE id = ?').get(user.id).status).toBe('locked');
    const res = await c.post('/api/auth/login', { email: user.email, password: w.PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_INACTIVE');
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'user.locked' AND target_id = ?").get(String(user.id)).n).toBe(1);
  });

  test('a successful login resets the failure counter', async () => {
    const user = w.addUser();
    const c = await w.anonymous();
    for (let i = 0; i < 4; i++) await c.post('/api/auth/login', { email: user.email, password: 'Wrong-Passw0rd' });
    await c.post('/api/auth/login', { email: user.email, password: w.PASSWORD });
    expect(w.db.prepare('SELECT failed_login_attempts FROM users WHERE id = ?').get(user.id).failed_login_attempts).toBe(0);
  });

  test('suspending a user cuts off an existing session immediately', async () => {
    const user = w.addUser();
    const c = await w.login(user);
    expect((await c.get('/api/profile')).status).toBe(200);
    w.db.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").run(user.id);
    const res = await c.get('/api/profile');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_INACTIVE');
  });

  test('suspended users cannot log in', async () => {
    const user = w.addUser({ status: 'suspended' });
    const c = await w.anonymous();
    expect((await c.post('/api/auth/login', { email: user.email, password: w.PASSWORD })).status).toBe(403);
  });

  test('temporary-password users must change it before doing anything else', async () => {
    const user = w.addUser({ mustChange: 1 });
    const c = await w.login(user);
    expect((await c.get('/api/accounts')).body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await c.get('/api/auth/me')).body.must_change_password).toBe(true);

    const weak = await c.post('/api/auth/change-password', { current_password: w.PASSWORD, new_password: 'short' });
    expect(weak.status).toBe(400);
    const wrong = await c.post('/api/auth/change-password', { current_password: 'Not-The-Passw0rd', new_password: 'Brand-New-Passw0rd' });
    expect(wrong.status).toBe(400);

    const ok = await c.post('/api/auth/change-password', { current_password: w.PASSWORD, new_password: 'Brand-New-Passw0rd' });
    expect(ok.status).toBe(200);
    c.csrf = ok.body.csrf_token;
    expect((await c.get('/api/accounts')).status).toBe(200);
    const hash = w.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id).password_hash;
    expect(hash.startsWith('$argon2id$')).toBe(true);
  });

  test('changing password signs out the user\'s other sessions', async () => {
    const user = w.addUser();
    const a = await w.login(user);
    const b = await w.login(user);
    const res = await a.post('/api/auth/change-password', { current_password: w.PASSWORD, new_password: 'Another-Passw0rd9' });
    expect(res.status).toBe(200);
    a.csrf = res.body.csrf_token;
    expect((await b.get('/api/auth/me')).status).toBe(401);
    expect((await a.get('/api/auth/me')).status).toBe(200);
  });

  test('state-changing requests with a stale or wrong CSRF token are rejected', async () => {
    const user = w.addUser();
    const c = await w.login(user);
    const res = await c.agent.patch('/api/profile').set('X-CSRF-Token', 'a'.repeat(64)).send({ phone_number: '+260971000000' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_INVALID');
  });
});

describe('Login rate limiting', () => {
  test('the 11th login attempt within the window is throttled', async () => {
    const w = await createWorld({ rateLimit: true });
    try {
      const c = await w.anonymous();
      const statuses = [];
      for (let i = 0; i < 11; i++) {
        statuses.push((await c.post('/api/auth/login', { email: 'nobody@vault24.test', password: 'Wrong-Passw0rd' })).status);
      }
      expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
      expect(statuses[10]).toBe(429);
    } finally {
      w.close();
    }
  });
});

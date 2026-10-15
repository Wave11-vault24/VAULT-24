'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { createApp } = require('../src/app');
const { openDatabase } = require('../src/config/database');
const { loadConfig } = require('../src/config/env');
const { createTestDb, testConfig } = require('./helpers');

describe('Milestone 1 — foundation', () => {
  let db;
  let app;

  beforeAll(() => {
    db = createTestDb();
    app = createApp({ db, config: testConfig() });
  });
  afterAll(() => db.close());

  test('health check reports database connectivity', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', database: 'ok' });
  });

  test('every response carries a request ID', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('security headers are set and X-Powered-By is hidden', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  test('unknown routes return a JSON 404', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  test('malformed JSON is rejected without leaking a stack trace', async () => {
    const res = await request(app)
      .post('/api/health')
      .set('Content-Type', 'application/json')
      .send('{"broken": ');
    expect(res.status).toBe(400);
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/at\s+\S+\s+\(|node_modules|SyntaxError/);
  });

  test('oversized JSON bodies are rejected', async () => {
    const res = await request(app)
      .post('/api/health')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ blob: 'x'.repeat(30_000) }));
    expect(res.status).toBe(413);
  });

  test('CORS only allows the configured frontend origin', async () => {
    const allowed = await request(app).get('/api/health').set('Origin', 'http://localhost:5173');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    const denied = await request(app).get('/api/health').set('Origin', 'https://evil.example');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('health check reports degraded when the database is unavailable', async () => {
    const brokenDb = createTestDb();
    const brokenApp = createApp({ db: brokenDb, config: testConfig() });
    brokenDb.close();
    const res = await request(brokenApp).get('/api/health');
    expect(res.status).toBe(503);
    expect(res.body.database).toBe('unavailable');
  });
});

describe('Milestone 1 — environment validation', () => {
  test('production refuses to start without a strong SESSION_SECRET', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', SESSION_SECRET: '' })).toThrow(/SESSION_SECRET/);
    expect(() => loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
  });

  test('production accepts a strong secret', () => {
    const cfg = loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'a'.repeat(48) });
    expect(cfg.isProduction).toBe(true);
  });

  test('validation errors name the key but never echo its value', () => {
    let message = '';
    try {
      loadConfig({ NODE_ENV: 'test', PORT: 'super-secret-value' });
    } catch (err) {
      message = err.message;
    }
    expect(message).toMatch(/PORT/);
    expect(message).not.toMatch(/super-secret-value/);
  });

  test('defaults to a 5 MB document limit and ZMW', () => {
    const cfg = loadConfig({ NODE_ENV: 'test' });
    expect(cfg.MAX_DOCUMENT_SIZE_BYTES).toBe(5 * 1024 * 1024);
    expect(cfg.BANK_CURRENCY).toBe('ZMW');
  });
});

describe('Milestone 1 — SQLite connection settings', () => {
  test('file database enables foreign keys, WAL and a busy timeout', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault24-test-'));
    const db = openDatabase(path.join(dir, 'conn.db'));
    try {
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Frontend serving', () => {
  let db;
  let app;
  beforeAll(() => {
    db = createTestDb();
    app = createApp({ db, config: testConfig() });
  });
  afterAll(() => { app.locals.sessionStore.close(); db.close(); });

  test.each(['/', '/login.html', '/app.html', '/css/tokens.css', '/js/api.js', '/assets/icons/sprite.svg', '/assets/images/logo-mark-navy.png'])('serves %s', async (url) => {
    const res = await request(app).get(url);
    expect(res.status).toBe(200);
  });

  test('pages are revalidated, assets cached briefly, and both carry the strict CSP', async () => {
    const html = await request(app).get('/app.html');
    expect(html.headers['cache-control']).toBe('no-cache');
    expect(html.headers['content-security-policy']).toMatch(/script-src 'self'/);
    expect(html.headers['content-security-policy']).toMatch(/script-src-attr 'none'/);
    const css = await request(app).get('/css/base.css');
    expect(css.headers['cache-control']).toBe('public, max-age=3600');
  });

  test('static files never create a session', async () => {
    const res = await request(app).get('/app.html');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n).toBe(0);
  });

  test('unknown pages get the HTML 404 for browsers and JSON for API clients', async () => {
    const page = await request(app).get('/no-such-page').set('Accept', 'text/html');
    expect(page.status).toBe(404);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.text).toMatch(/Page not found/);
    const api = await request(app).get('/api/no-such-route').set('Accept', 'text/html');
    expect(api.status).toBe(404);
    expect(api.body.error.code).toBe('NOT_FOUND');
  });

  test('path traversal outside public/ is refused', async () => {
    const res = await request(app).get('/..%2f..%2fpackage.json');
    expect([400, 403, 404]).toContain(res.status);
    expect(res.text).not.toMatch(/"dependencies"/);
  });

  test('GET /api/auth/session answers 200 false without creating a session', async () => {
    const res = await request(app).get('/api/auth/session');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authenticated: false });
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

describe('Rate-limit switch', () => {
  test('DISABLE_RATE_LIMIT only works outside production', () => {
    expect(loadConfig({ NODE_ENV: 'development', DISABLE_RATE_LIMIT: 'true' }).rateLimitEnabled).toBe(false);
    expect(loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'a'.repeat(48), DISABLE_RATE_LIMIT: 'true' }).rateLimitEnabled).toBe(true);
    expect(loadConfig({ NODE_ENV: 'development' }).rateLimitEnabled).toBe(true);
  });
});

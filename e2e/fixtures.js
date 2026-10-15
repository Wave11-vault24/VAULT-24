// Shared E2E helpers. Credentials are the FICTIONAL demo users created by scripts/seed.js.
const base = require('@playwright/test');
const crypto = require('crypto');

const USERS = {
  admin: { email: 'admin@vault24.test', password: 'Vault24-Admin-Demo1' },
  staff: { email: 'teller@vault24.test', password: 'Vault24-Staff-Demo1' },
  jane: { email: 'jane@vault24.test', password: 'Vault24-Customer-Demo1' },
  john: { email: 'john@vault24.test', password: 'Vault24-Customer-Demo1' },
  mary: { email: 'mary@vault24.test', password: 'Vault24-Customer-Demo1' },
};

// Browsers log every non-2xx fetch as "Failed to load resource". Tests that
// exercise error paths expect those; anything else on the console fails the test.
const EXPECTED_HTTP_NOISE = /Failed to load resource: the server responded with a status of 4\d\d/;

const test = base.test.extend({
  page: async ({ page }, use, testInfo) => {
    const problems = [];
    page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      if (EXPECTED_HTTP_NOISE.test(msg.text()) && !testInfo.annotations.some((a) => a.type === 'strict-console')) return;
      // Tests that deliberately cut the network declare it; only then is the browser's net error allowed.
      if (/net::ERR_FAILED/.test(msg.text()) && testInfo.annotations.some((a) => a.type === 'simulated-network-failure')) return;
      problems.push(`console.error: ${msg.text()}`);
    });
    await use(page);
    base.expect(problems, 'browser console/page errors').toEqual([]);
  },
});

async function login(page, who) {
  const u = USERS[who] || who;
  await page.goto('/login.html');
  await page.getByLabel('Email address').fill(u.email);
  await page.getByLabel('Password', { exact: true }).fill(u.password);
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await page.waitForURL(/\/app\.html#\//);
  await page.locator('[data-page-title]').waitFor();
}

/** An authenticated API client (separate cookie jar) used only to VERIFY results server-side. */
async function apiAs(playwright, baseURL, who) {
  const u = USERS[who] || who;
  const ctx = await playwright.request.newContext({ baseURL });
  const { csrf_token: t0 } = await (await ctx.get('/api/auth/csrf-token')).json();
  const res = await ctx.post('/api/auth/login', { data: { email: u.email, password: u.password }, headers: { 'X-CSRF-Token': t0 } });
  if (!res.ok()) throw new Error(`apiAs login failed for ${u.email}: ${res.status()}`);
  const { csrf_token: csrf } = await res.json();
  const call = async (method, path, data) => {
    const r = await ctx.fetch(`/api${path}`, { method, data, headers: method === 'GET' ? {} : { 'X-CSRF-Token': csrf } });
    return { status: r.status(), body: r.headers()['content-type']?.includes('json') ? await r.json() : null };
  };
  return { get: (p) => call('GET', p), post: (p, d) => call('POST', p, d), patch: (p, d) => call('PATCH', p, d), dispose: () => ctx.dispose() };
}

/** Minimal valid synthetic PDF (fictional, obviously fake). */
function syntheticPdf(name = 'E2E Person') {
  const { syntheticIdentityPdf } = require('../scripts/lib/synthetic-pdf');
  return syntheticIdentityPdf(name);
}

const uniqueEmail = (prefix) => `${prefix}.${crypto.randomBytes(4).toString('hex')}@vault24.test`;

module.exports = { test, expect: base.expect, login, apiAs, USERS, syntheticPdf, uniqueEmail };

const { test, expect, login, apiAs, uniqueEmail } = require('./fixtures');

test.describe('Authentication', () => {
  test('landing page links to login', async ({ page }) => {
    test.info().annotations.push({ type: 'strict-console' });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Welcome to');
    await page.getByRole('link', { name: 'Login', exact: true }).click();
    await expect(page).toHaveURL(/login\.html/);
    await expect(page.getByRole('heading', { name: 'Login to Your Account' })).toBeVisible();
  });

  test('client-side validation runs before contacting the server', async ({ page }) => {
    await page.goto('/login.html');
    await page.getByRole('button', { name: 'Login', exact: true }).click();
    await expect(page.locator('#email-err')).toHaveText(/Enter your email/);
    await expect(page.locator('#email')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#email')).toBeFocused();
  });

  test('wrong password shows a safe, generic error and keeps the email', async ({ page }) => {
    await page.goto('/login.html');
    await page.getByLabel('Email address').fill('jane@vault24.test');
    await page.getByLabel('Password', { exact: true }).fill('Not-The-Right-Passw0rd');
    await page.getByRole('button', { name: 'Login', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('The email or password is incorrect');
    await expect(page.getByLabel('Email address')).toHaveValue('jane@vault24.test');
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
  });

  test('password visibility toggle is accessible', async ({ page }) => {
    await page.goto('/login.html');
    const pw = page.getByLabel('Password', { exact: true });
    await pw.fill('secret-value');
    await page.getByRole('button', { name: 'Show password' }).click();
    await expect(pw).toHaveAttribute('type', 'text');
    await expect(page.getByRole('button', { name: 'Hide password' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('customer login reaches the dashboard with customer-only navigation', async ({ page }) => {
    test.info().annotations.push({ type: 'strict-console' });
    await login(page, 'jane');
    await expect(page.getByRole('heading', { name: 'Welcome back, Jane!' })).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link')).toHaveText(['Dashboard', 'My Accounts', 'Transfer Funds', 'Transaction History', 'Profile', 'Security']);
    await expect(nav.getByRole('link', { name: 'Cash Deposit' })).toHaveCount(0);
    expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k !== 'vault24.hideBalances'))).toEqual([]);
    expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual([]);
    expect(await page.evaluate(() => document.cookie)).toBe(''); // session cookie is HttpOnly
  });

  test('staff and admin get their own navigation', async ({ page }) => {
    await login(page, 'staff');
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link')).toHaveText(['Dashboard', 'Register Customer', 'Customers', 'Cash Deposit', 'Profile', 'Security']);
    await page.getByRole('button', { name: 'Logout' }).first().click();
    await page.waitForURL(/login\.html/);
    await login(page, 'admin');
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link')).toHaveText(['Dashboard', 'Users & Staff', 'ID Documents', 'Audit Log', 'Profile', 'Security']);
  });

  test('a customer opening an admin URL sees Access denied, and the API refuses too', async ({ page }) => {
    await login(page, 'jane');
    await page.goto('/app.html#/admin/users');
    await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
    const status = await page.evaluate(async () => (await fetch('/api/admin/users')).status);
    expect(status).toBe(403);
  });

  test('logout ends the server session; the app then requires login again', async ({ page }) => {
    await login(page, 'jane');
    await page.getByRole('button', { name: 'Logout' }).first().click();
    await expect(page).toHaveURL(/login\.html\?signedout=1/);
    await expect(page.getByText('You have signed out')).toBeVisible();
    await page.goto('/app.html#/dashboard');
    await expect(page).toHaveURL(/login\.html/);
    expect(await page.evaluate(async () => (await fetch('/api/auth/me')).status)).toBe(401);
  });

  test('an expired session sends the user to login with an explanation', async ({ page, context }) => {
    await login(page, 'jane');
    await context.clearCookies(); // simulates the server-side idle timeout
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'My Accounts' }).click();
    await expect(page).toHaveURL(/login\.html\?expired=1/);
    await expect(page.getByText('Your session has ended')).toBeVisible();
  });

  test('protected pages redirect anonymous visitors and return them after login', async ({ page }) => {
    test.info().annotations.push({ type: 'strict-console' });
    await page.goto('/app.html#/history');
    await expect(page).toHaveURL(/login\.html\?next=%23%2Fhistory/);
    await page.getByLabel('Email address').fill('jane@vault24.test');
    await page.getByLabel('Password', { exact: true }).fill('Vault24-Customer-Demo1');
    await page.getByRole('button', { name: 'Login', exact: true }).click();
    await expect(page).toHaveURL(/app\.html#\/history/);
    await expect(page.getByRole('heading', { name: 'Transaction History' })).toBeVisible();
  });

  test('a user with a temporary password must change it before anything else', async ({ page, playwright, baseURL }) => {
    const admin = await apiAs(playwright, baseURL, 'admin');
    const email = uniqueEmail('newstaff');
    const created = await admin.post('/admin/staff', { full_name: 'Nora Newstaff', email });
    expect(created.status).toBe(201);
    await admin.dispose();

    await login(page, { email, password: created.body.temporary_password });
    await expect(page).toHaveURL(/#\/security\?required=1/);
    await expect(page.getByText('Please set a new password')).toBeVisible();
    await page.goto('/app.html#/staff/customers');
    await expect(page).toHaveURL(/#\/security/);

    await page.getByLabel(/^Current password/).fill(created.body.temporary_password);
    await page.getByLabel(/^New password/).fill('Weak');
    await page.getByLabel(/^Confirm new password/).fill('Weak');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByText('Use at least 12 characters.')).toBeVisible();

    await page.getByLabel(/^New password/).fill('Nora-Strong-Passw0rd');
    await page.getByLabel(/^Confirm new password/).fill('Nora-Strong-Passw0rd');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page).toHaveURL(/#\/dashboard/, { timeout: 5000 });
    await expect(page.getByRole('heading', { name: /Good to see you, Nora/ })).toBeVisible();
  });

  test('locked accounts are told to contact the branch', async ({ page, playwright, baseURL }) => {
    const admin = await apiAs(playwright, baseURL, 'admin');
    const email = uniqueEmail('lockme');
    const { body } = await admin.post('/admin/staff', { full_name: 'Lock Me', email });
    const users = (await admin.get('/admin/users?role=staff')).body.users;
    const id = users.find((u) => u.email === email).id;
    await admin.patch(`/admin/users/${id}/status`, { status: 'locked', reason: 'E2E lock test' });
    await admin.dispose();
    await page.goto('/login.html');
    await page.getByLabel('Email address').fill(email);
    await page.getByLabel('Password', { exact: true }).fill(body.temporary_password);
    await page.getByRole('button', { name: 'Login', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('locked or suspended');
  });

  test('rate limiting (429) is explained instead of shown as a crash', async ({ page }) => {
    await page.route('**/api/auth/login', (route) => route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Too many login requests.' } }) }));
    await page.goto('/login.html');
    await page.getByLabel('Email address').fill('jane@vault24.test');
    await page.getByLabel('Password', { exact: true }).fill('anything-here');
    await page.getByRole('button', { name: 'Login', exact: true }).click();
    await expect(page.getByText('Too many attempts')).toBeVisible();
  });
});

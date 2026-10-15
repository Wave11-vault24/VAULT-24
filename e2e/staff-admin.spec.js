const { test, expect, login, apiAs, syntheticPdf, uniqueEmail } = require('./fixtures');

const pdfFile = (name = 'synthetic-id.pdf', buffer = syntheticPdf()) => ({ name, mimeType: 'application/pdf', buffer });

async function logout(page) {
  await page.getByRole('button', { name: 'Logout' }).first().click();
  await page.waitForURL(/login\.html/);
}

test.describe('Staff and admin journey', () => {
  test('register → approve ID → open account → deposit → customer sees it', async ({ page }) => {
    const email = uniqueEmail('grace');

    // 1. Staff registers the customer with a synthetic PDF.
    await login(page, 'staff');
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Register Customer' }).click();
    await page.getByLabel(/^Full name/).fill('Grace Phiri');
    await page.getByLabel(/^Email address/).fill(email);
    await page.getByLabel(/^Phone number/).fill('+260 971 222 333');
    await page.locator('input[type=file]').setInputFiles(pdfFile('grace-id.pdf', syntheticPdf('Grace Phiri')));
    await expect(page.locator('.file-chip')).toContainText('grace-id.pdf');
    await page.getByRole('button', { name: 'Register customer' }).click();
    await expect(page.getByRole('heading', { name: 'Customer registered' })).toBeVisible();
    await expect(page.locator('dl')).toContainText('Pending'); // never shown as verified
    const tempPassword = (await page.locator('.secret span').first().textContent()).trim();
    expect(tempPassword).toMatch(/^[\w-]{19}$/);

    // 2. Account opening is blocked until the ID is approved.
    await page.getByRole('link', { name: 'Open customer record' }).click();
    await expect(page.getByText('Not eligible yet')).toBeVisible();
    await logout(page);

    // 3. Admin downloads and approves the document.
    await login(page, 'admin');
    await page.goto('/app.html#/admin/documents?status=pending');
    const card = page.locator('.doc-card', { hasText: 'Grace Phiri' });
    const download = page.waitForEvent('download');
    await card.getByRole('button', { name: 'Download PDF' }).click();
    expect((await download).suggestedFilename()).toBe('grace-id.pdf');
    await card.getByRole('button', { name: 'Approve' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByText('Document verified')).toBeVisible();
    await expect(page.locator('.doc-card', { hasText: 'Grace Phiri' })).toHaveCount(0);
    await logout(page);

    // 4. Staff opens a student account (zero balance, server-generated number).
    await login(page, 'staff');
    await page.goto('/app.html#/staff/customers?q=Grace');
    await page.getByRole('link', { name: 'Open Grace Phiri' }).click();
    await page.getByLabel(/^Account type/).selectOption('student');
    await page.getByRole('button', { name: 'Open account' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Open account' }).click();
    const opened = page.getByRole('dialog', { name: 'Account opened' });
    await expect(opened).toContainText('ZMW 0.00');
    const number = (await opened.locator('.mono').textContent()).replace(/\s+/g, '');
    expect(number).toMatch(/^V2420\d{8}$/);
    await opened.getByRole('button', { name: 'Done' }).click();

    // 5. Teller verifies and deposits 250.00.
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Cash Deposit' }).click();
    await expect(page.getByText('Simulated transaction')).toBeVisible();
    await page.getByLabel(/^Account number/).fill(number);
    await page.getByRole('button', { name: 'Verify account' }).click();
    await expect(page.locator('.lookup-card')).toContainText('Grace Phiri');
    await page.getByLabel(/^Account name/).fill('Grace Phiry');
    await expect(page.getByText('Name does not match')).toBeVisible();
    await page.getByLabel(/^Account name/).fill('  grace   PHIRI ');
    await expect(page.getByText('Name matches')).toBeVisible();
    await page.getByLabel(/^Amount/).fill('250');
    await page.getByRole('button', { name: 'Review deposit' }).click();
    await expect(page.getByRole('dialog')).toContainText('ZMW 250.00');
    await page.getByRole('dialog').getByRole('button', { name: 'Post deposit' }).click();
    await expect(page.getByRole('heading', { name: 'Deposit receipt' })).toBeVisible();
    await expect(page.locator('.receipt')).toContainText(/DEP-\d{8}-[0-9A-Z]{10}/);
    await expect(page.locator('.receipt')).toContainText('ZMW 250.00');
    await logout(page);

    // 6. The new customer must set a password, then sees the money.
    await login(page, { email, password: tempPassword });
    await page.getByLabel(/^Current password/).fill(tempPassword);
    await page.getByLabel(/^New password/).fill('Grace-Own-Passw0rd');
    await page.getByLabel(/^Confirm new password/).fill('Grace-Own-Passw0rd');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByRole('heading', { name: 'Welcome back, Grace!' })).toBeVisible();
    await expect(page.locator('.stat-grid')).toContainText('ZMW 250.00');
    await expect(page.locator('tbody tr').first()).toContainText('Cash deposit at branch');
  });

  test('server-side PDF validation: fake PDF rejected, oversized blocked in the browser', async ({ page }) => {
    await login(page, 'staff');
    await page.goto('/app.html#/staff/register');
    await page.getByLabel(/^Full name/).fill('Fake File');
    await page.getByLabel(/^Email address/).fill(uniqueEmail('fake'));
    // Correct extension + MIME, wrong bytes: only the server's signature check can catch this.
    await page.locator('input[type=file]').setInputFiles({ name: 'id.pdf', mimeType: 'application/pdf', buffer: Buffer.from('this is not really a pdf file at all') });
    await page.getByRole('button', { name: 'Register customer' }).click();
    await expect(page.locator('.field-error:visible')).toContainText('File content is not a valid PDF.');
    await expect(page.getByText('Customer registered')).toHaveCount(0);

    await page.getByRole('button', { name: 'Remove' }).click();
    const big = Buffer.concat([syntheticPdf(), Buffer.alloc(5 * 1024 * 1024 + 1, 0x20)]);
    await page.locator('input[type=file]').setInputFiles({ name: 'big.pdf', mimeType: 'application/pdf', buffer: big });
    await expect(page.locator('.field-error:visible')).toContainText('The limit is 5.00 MB');
    await page.locator('input[type=file]').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from('png') });
    await expect(page.locator('.field-error:visible')).toContainText('Choose a PDF file');
  });

  test('missing document and duplicate email are handled', async ({ page }) => {
    await login(page, 'staff');
    await page.goto('/app.html#/staff/register');
    await page.getByLabel(/^Full name/).fill('Jane Again');
    await page.getByLabel(/^Email address/).fill('jane@vault24.test');
    await page.getByRole('button', { name: 'Register customer' }).click();
    await expect(page.getByText("Attach the customer's identity document")).toBeVisible();
    await page.locator('input[type=file]').setInputFiles(pdfFile());
    await page.getByRole('button', { name: 'Register customer' }).click();
    await expect(page.locator('.field-error:visible')).toContainText('already exists');
    await expect(page.getByLabel(/^Full name/)).toHaveValue('Jane Again'); // input preserved
  });

  test('deposit to an unknown account and a mismatched name are rejected by the server', async ({ page, playwright, baseURL }) => {
    const john = await apiAs(playwright, baseURL, 'john');
    const acct = (await john.get('/accounts')).body.accounts[0];
    await john.dispose();
    await login(page, 'staff');
    await page.goto('/app.html#/staff/deposit');
    await page.getByLabel(/^Account number/).fill('V241099999999');
    await page.getByLabel(/^Account name/).fill('Nobody');
    await page.getByLabel(/^Amount/).fill('10');
    await page.getByRole('button', { name: 'Review deposit' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Post deposit' }).click();
    await expect(page.locator('.field-error:visible')).toContainText('No account matches');

    await page.getByLabel(/^Account number/).fill(acct.account_number);
    await page.getByLabel(/^Account name/).fill('Johnny Daka');
    await page.getByRole('button', { name: 'Review deposit' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Post deposit' }).click();
    await expect(page.locator('.field-error:visible')).toContainText('does not match');
    await expect(page.getByText('Deposit receipt')).toHaveCount(0);
  });

  test('admin rejects a document with a reason; the customer becomes rejected', async ({ page, playwright, baseURL }) => {
    const staff = await apiAs(playwright, baseURL, 'staff');
    const email = uniqueEmail('reject');
    // Create a pending customer through the real multipart endpoint.
    const ctxReq = await playwright.request.newContext({ baseURL });
    const t0 = (await (await ctxReq.get('/api/auth/csrf-token')).json()).csrf_token;
    const t1 = (await (await ctxReq.post('/api/auth/login', { data: { email: 'teller@vault24.test', password: 'Vault24-Staff-Demo1' }, headers: { 'X-CSRF-Token': t0 } })).json()).csrf_token;
    const reg = await ctxReq.post('/api/staff/customers', {
      headers: { 'X-CSRF-Token': t1 },
      multipart: { full_name: 'Rex Reject', email, identity_document: { name: 'rex.pdf', mimeType: 'application/pdf', buffer: syntheticPdf('Rex Reject') } },
    });
    expect(reg.status()).toBe(201);
    await ctxReq.dispose();
    await staff.dispose();

    await login(page, 'admin');
    await page.goto('/app.html#/admin/documents?status=pending');
    const card = page.locator('.doc-card', { hasText: 'Rex Reject' });
    await card.getByRole('button', { name: 'Reject' }).click();
    const dialog = page.getByRole('dialog', { name: 'Reject this identity document?' });
    await dialog.getByRole('button', { name: 'Reject document' }).click();
    await expect(dialog.locator('.field-error:visible')).toContainText('at least 3 characters');
    await dialog.getByLabel(/^Reason for rejection/).fill('Synthetic image unreadable');
    await dialog.getByRole('button', { name: 'Reject document' }).click();
    await expect(page.getByText('Document rejected')).toBeVisible();
    await page.getByRole('tab', { name: 'Rejected' }).click();
    await expect(page.locator('.doc-card', { hasText: 'Rex Reject' })).toContainText('Synthetic image unreadable');
  });

  test('admin creates staff, suspends and reactivates a user, and cannot change themself', async ({ page }) => {
    await login(page, 'admin');
    await page.goto('/app.html#/admin/users');
    await page.getByRole('button', { name: 'Create staff member' }).click();
    const create = page.getByRole('dialog', { name: 'Create staff member' });
    const email = uniqueEmail('tina');
    await create.getByLabel(/^Full name/).fill('Tina Teller');
    await create.getByLabel(/^Work email/).fill(email);
    await create.getByRole('button', { name: 'Create staff' }).click();
    const done = page.getByRole('dialog', { name: 'Staff member created' });
    await expect(done.locator('.secret')).toBeVisible();
    await done.getByRole('button', { name: 'Done' }).click();

    const row = page.locator('tr', { hasText: email });
    await row.getByRole('button', { name: 'Change status' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel(/^New status/).selectOption('suspended');
    await dlg.getByLabel(/^Reason/).fill('E2E suspension');
    await dlg.getByRole('button', { name: 'Save status' }).click();
    await expect(row).toContainText('Suspended');
    await row.getByRole('button', { name: 'Change status' }).click();
    await page.getByRole('dialog').getByLabel(/^New status/).selectOption('active');
    await page.getByRole('dialog').getByRole('button', { name: 'Save status' }).click();
    await expect(row).toContainText('Active');

    await expect(page.locator('tr', { hasText: 'admin@vault24.test' }).getByRole('button', { name: 'Change status' })).toHaveCount(0);
  });

  test('admin can freeze an account; closing a funded account is refused by the bank', async ({ page, playwright, baseURL }) => {
    const admin = await apiAs(playwright, baseURL, 'admin');
    const chanda = (await admin.get('/admin/users?role=customer')).body.users.find((u) => u.email === 'chanda@vault24.test');
    await admin.dispose();
    await login(page, 'admin');
    await page.goto(`/app.html#/admin/users/${chanda.id}`);
    const card = page.locator('.account-card', { hasText: 'Savings Account' });
    await card.getByRole('button', { name: 'Change status' }).click();
    let dlg = page.getByRole('dialog');
    await dlg.getByLabel(/^New status/).selectOption('closed');
    await dlg.getByLabel(/^Reason/).fill('Customer request');
    await dlg.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('dialog', { name: 'Close this account permanently?' }).getByRole('button', { name: 'Close account' }).click();
    await expect(page.getByRole('dialog').locator('.alert--error')).toContainText('zero balance');
    await page.getByRole('dialog').getByLabel(/^New status/).selectOption('frozen');
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await expect(card).toContainText('Frozen');
    // Unfreeze to leave seed data usable
    await card.getByRole('button', { name: 'Change status' }).click();
    dlg = page.getByRole('dialog');
    await dlg.getByLabel(/^New status/).selectOption('active');
    await dlg.getByLabel(/^Reason/).fill('Review complete');
    await dlg.getByRole('button', { name: 'Save' }).click();
    await expect(card).toContainText('Active');
  });

  test('admin dashboard and audit log show real, read-only data', async ({ page }) => {
    test.info().annotations.push({ type: 'strict-console' });
    await login(page, 'admin');
    await expect(page.getByText('Balanced')).toBeVisible();
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Audit Log' }).click();
    await expect(page.locator('tbody tr').first()).toBeVisible();
    await page.getByLabel('Event', { exact: true }).fill('deposit.create');
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await expect(page).toHaveURL(/action=deposit\.create/);
    for (const row of (await page.locator('tbody tr').all()).slice(0, 5)) await expect(row).toContainText('deposit.create');
    await expect(page.getByRole('button', { name: /edit|delete/i })).toHaveCount(0);
  });

  test('staff cannot reach admin screens and admins cannot post deposits', async ({ page }) => {
    await login(page, 'staff');
    await page.goto('/app.html#/admin/audit');
    await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
    await logout(page);
    await login(page, 'admin');
    await page.goto('/app.html#/staff/deposit');
    await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
  });
});

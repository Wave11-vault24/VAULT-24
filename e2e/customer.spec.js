const { test, expect, login, apiAs } = require('./fixtures');

test.describe('Customer screens', () => {
  test('dashboard shows the real balance and recent transactions from the API', async ({ page, playwright, baseURL }) => {
    test.info().annotations.push({ type: 'strict-console' });
    const api = await apiAs(playwright, baseURL, 'jane');
    const { accounts } = (await api.get('/accounts')).body;
    const first = accounts[0];
    const history = (await api.get(`/accounts/${first.id}/transactions?limit=6`)).body;
    await api.dispose();

    await login(page, 'jane');
    const stats = page.locator('.stat-grid');
    await expect(stats).toContainText(`ZMW ${Number(first.balance).toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
    await expect(stats).toContainText(String(history.total_count).padStart(4, '0'));
    const rows = page.locator('section[aria-labelledby="recent-title"] tbody tr');
    await expect(rows).toHaveCount(history.transactions.length);
    await expect(rows.first()).toContainText(history.transactions[0].narration);
  });

  test('balances can be hidden and shown, with a screen-reader label', async ({ page }) => {
    await login(page, 'jane');
    await page.getByRole('button', { name: 'Hide balances' }).first().click();
    await expect(page.locator('.stat-grid')).not.toContainText('ZMW 1');
    await expect(page.locator('.stat-grid .visually-hidden').first()).toHaveText('hidden');
    await page.getByRole('button', { name: 'Show balances' }).first().click();
    await expect(page.locator('.stat-grid')).toContainText('ZMW');
  });

  test('switching account tabs reloads that account', async ({ page }) => {
    await login(page, 'jane');
    const tabs = page.getByRole('tab');
    await expect(tabs).toHaveCount(2);
    await tabs.nth(1).click();
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.stat-grid')).toContainText('Salary Account');
  });

  test('transaction details open in an accessible dialog and close with Escape', async ({ page }) => {
    await login(page, 'jane');
    const firstDetails = page.getByRole('button', { name: /^Details for/ }).first();
    await firstDetails.click();
    const dialog = page.getByRole('dialog', { name: 'Transaction details' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(/TRF-|DEP-/);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(firstDetails).toBeFocused();
  });

  test('accounts page lists only own accounts; another customer\'s account URL is refused', async ({ page, playwright, baseURL }) => {
    await login(page, 'jane');
    await page.goto('/app.html#/accounts');
    await expect(page.locator('.account-card')).toHaveCount(2);
    const john = await apiAs(playwright, baseURL, 'john');
    const johnAccount = (await john.get('/accounts')).body.accounts[0];
    await john.dispose();
    await page.goto(`/app.html#/accounts/${johnAccount.id}`);
    await expect(page.getByText('Account not available')).toBeVisible();
    await expect(page.locator('body')).not.toContainText(johnAccount.account_number);
  });

  test('history pages through the server and filters loaded rows', async ({ page }) => {
    await login(page, 'jane');
    await page.goto('/app.html#/history');
    await expect(page.locator('tbody tr').first()).toBeVisible();
    await page.getByLabel('Filter').fill('groceries');
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(page.locator('tbody tr')).toContainText('Money for groceries');
    await page.getByLabel('Filter').fill('zzzz-no-match');
    await expect(page.getByText('No matches')).toBeVisible();
    await page.getByLabel('Filter').fill('');
    await page.getByLabel('Type').selectOption('debit');
    for (const row of await page.locator('tbody tr').all()) await expect(row).toContainText('Debit');
  });

  test('header search opens history filtered by the query', async ({ page }) => {
    await login(page, 'jane');
    await page.getByLabel('Search your transactions').fill('groceries');
    await page.getByLabel('Search your transactions').press('Enter');
    await expect(page).toHaveURL(/#\/history\?q=groceries/);
    await expect(page.getByLabel('Filter')).toHaveValue('groceries');
    await expect(page.locator('tbody tr')).toHaveCount(1);
  });

  test('profile edits only the phone number; identity fields are read-only text', async ({ page, playwright, baseURL }) => {
    await login(page, 'mary');
    await page.goto('/app.html#/profile');
    await expect(page.locator('#content input')).toHaveCount(1); // only the phone field is editable
    await page.getByLabel('Phone number').fill('12');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.locator('.field-error:visible')).toContainText('7–19 digits');
    await page.getByLabel('Phone number').fill('+260 977 555 111');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Profile updated')).toBeVisible();
    const api = await apiAs(playwright, baseURL, 'mary');
    expect((await api.get('/profile')).body.profile.phone_number).toBe('+260 977 555 111');
    await api.dispose();
  });
});

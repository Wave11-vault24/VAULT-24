const { test, expect, login, apiAs } = require('./fixtures');

async function accountsOf(playwright, baseURL, who) {
  const api = await apiAs(playwright, baseURL, who);
  const { accounts } = (await api.get('/accounts')).body;
  return { api, accounts };
}

async function fillTransfer(page, { from, to, amount, narration }) {
  await page.goto(from ? `/app.html#/transfer?from=${from}` : '/app.html#/transfer');
  await page.getByLabel(/^Recipient account number/).fill(to);
  await page.getByLabel(/^Amount/).fill(amount);
  if (narration) await page.getByLabel(/^Narration/).fill(narration);
  await page.getByRole('button', { name: 'Review transfer' }).click();
}

test.describe('Transfers', () => {
  test('valid transfer: review, confirm, authoritative receipt, balances refresh', async ({ page, playwright, baseURL }) => {
    const { api: johnApi, accounts: johnAccts } = await accountsOf(playwright, baseURL, 'john');
    const { api: janeApi, accounts: janeAccts } = await accountsOf(playwright, baseURL, 'jane');
    const from = janeAccts.find((a) => a.account_type === 'savings');
    const to = johnAccts[0];

    await login(page, 'jane');
    await fillTransfer(page, { from: from.account_number, to: to.account_number, amount: '123.45', narration: 'E2E lunch' });
    const review = page.getByRole('heading', { name: 'Review your transfer' });
    await expect(review).toBeFocused();
    await expect(page.getByText('ZMW 123.45')).toBeVisible();
    await page.getByRole('button', { name: 'Confirm transfer' }).click();

    await expect(page.getByRole('heading', { name: 'Transfer completed' })).toBeVisible();
    await expect(page.locator('.receipt')).toContainText(/TRF-\d{8}-[0-9A-Z]{10}/);
    await expect(page.locator('.receipt')).toContainText(to.account_name); // name comes from the server response

    const after = (await janeApi.get(`/accounts/${from.id}`)).body.account;
    expect(after.balance_minor).toBe(from.balance_minor - 12345);
    const johnAfter = (await johnApi.get(`/accounts/${to.id}`)).body.account;
    expect(johnAfter.balance_minor).toBe(to.balance_minor + 12345);

    await page.getByRole('link', { name: 'View history' }).click();
    await expect(page.locator('tbody tr').first()).toContainText('E2E lunch');
    await janeApi.dispose();
    await johnApi.dispose();
  });

  test('invalid input is caught in the browser with field-level errors', async ({ page }) => {
    await login(page, 'jane');
    await fillTransfer(page, { to: 'V24123', amount: '10.999' });
    await expect(page.getByText('Account numbers look like V24 followed by 10 digits.')).toBeVisible();
    await expect(page.getByText(/Enter a valid amount/)).toBeVisible();
    await expect(page.getByLabel(/^Recipient account number/)).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByLabel(/^Recipient account number/)).toBeFocused();
  });

  test('unknown recipient comes back from the server as a field error', async ({ page }) => {
    await login(page, 'jane');
    await fillTransfer(page, { to: 'V244099999999', amount: '1.00' });
    await page.getByRole('button', { name: 'Confirm transfer' }).click();
    await expect(page.locator('.field-error:visible')).toContainText('Recipient account not found');
    await expect(page.getByLabel(/^Amount/)).toHaveValue('1.00'); // input preserved
  });

  test('insufficient funds: the bank declines, nothing moves, no fake success', async ({ page, playwright, baseURL }) => {
    const { api, accounts } = await accountsOf(playwright, baseURL, 'mary');
    const from = accounts[0];
    const { accounts: johnAccts } = await accountsOf(playwright, baseURL, 'john');
    await login(page, 'mary');
    await fillTransfer(page, { to: johnAccts[0].account_number, amount: '4999.00' });
    await expect(page.getByText('More than your available balance')).toBeVisible();
    await page.getByRole('button', { name: 'Confirm transfer' }).click();
    await expect(page.getByRole('heading', { name: 'Transfer declined' })).toBeVisible();
    await expect(page.getByText('There is not enough money')).toBeVisible();
    await expect(page.getByText('Transfer completed')).toHaveCount(0);
    expect((await api.get(`/accounts/${from.id}`)).body.account.balance_minor).toBe(from.balance_minor);
    await api.dispose();
  });

  test('double-clicking Confirm sends exactly one transfer', async ({ page, playwright, baseURL }) => {
    const { api, accounts } = await accountsOf(playwright, baseURL, 'jane');
    const from = accounts.find((a) => a.account_type === 'salary');
    const { accounts: johnAccts } = await accountsOf(playwright, baseURL, 'john');
    const before = (await api.get(`/accounts/${from.id}/transactions?limit=1`)).body.total_count;

    let posts = 0;
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/api/transfers')) posts += 1; });
    await login(page, 'jane');
    await fillTransfer(page, { from: from.account_number, to: johnAccts[0].account_number, amount: '7.00', narration: 'Double click' });
    await page.getByRole('button', { name: 'Confirm transfer' }).dblclick();
    await expect(page.getByRole('heading', { name: 'Transfer completed' })).toBeVisible();
    expect(posts).toBe(1);
    expect((await api.get(`/accounts/${from.id}/transactions?limit=1`)).body.total_count).toBe(before + 1);
    await api.dispose();
  });

  test('connection lost AFTER the bank processed it: outcome unknown, safe retry shows the original, no duplicate', async ({ page, playwright, baseURL }) => {
    test.info().annotations.push({ type: 'simulated-network-failure' });
    const { api, accounts } = await accountsOf(playwright, baseURL, 'jane');
    const from = accounts.find((a) => a.account_type === 'salary');
    const { accounts: johnAccts } = await accountsOf(playwright, baseURL, 'john');
    const before = (await api.get(`/accounts/${from.id}`)).body.account.balance_minor;

    // First POST reaches the server (which commits) but the response is dropped.
    const keys = [];
    let dropped = false;
    await page.route('**/api/transfers', async (route) => {
      keys.push(JSON.parse(route.request().postData()).idempotency_key);
      if (!dropped) {
        dropped = true;
        await route.fetch();          // the server really processes it
        await route.abort('failed');  // ...but the browser never sees the reply
      } else {
        await route.continue();
      }
    });

    await login(page, 'jane');
    await fillTransfer(page, { from: from.account_number, to: johnAccts[0].account_number, amount: '11.00', narration: 'Flaky network' });
    await page.getByRole('button', { name: 'Confirm transfer' }).click();
    await expect(page.getByRole('heading', { name: 'We could not confirm your transfer' })).toBeVisible();
    await expect(page.getByText('Transfer completed')).toHaveCount(0); // never claims success it can't prove

    await page.getByRole('button', { name: 'Check status and retry safely' }).click();
    await expect(page.getByRole('heading', { name: 'Transfer completed' })).toBeVisible();
    await expect(page.getByText('Already processed')).toBeVisible();

    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]); // same idempotency key on retry
    expect((await api.get(`/accounts/${from.id}`)).body.account.balance_minor).toBe(before - 1100); // debited once
    await api.dispose();
  });

  test('editing after review starts a new attempt with a new idempotency key', async ({ page, playwright, baseURL }) => {
    const { accounts: johnAccts } = await accountsOf(playwright, baseURL, 'john');
    const keys = [];
    await page.route('**/api/transfers', async (route) => {
      keys.push(JSON.parse(route.request().postData()).idempotency_key);
      await route.continue();
    });
    await login(page, 'jane');
    await fillTransfer(page, { to: johnAccts[0].account_number, amount: '2.00' });
    await page.getByRole('button', { name: 'Edit' }).click();
    await page.getByLabel(/^Amount/).fill('3.00');
    await page.getByRole('button', { name: 'Review transfer' }).click();
    await page.getByRole('button', { name: 'Confirm transfer' }).click();
    await expect(page.getByRole('heading', { name: 'Transfer completed' })).toBeVisible();
    await page.getByRole('button', { name: 'Make another transfer' }).click();
    await page.getByLabel(/^Recipient account number/).fill(johnAccts[0].account_number);
    await page.getByLabel(/^Amount/).fill('3.00');
    await page.getByRole('button', { name: 'Review transfer' }).click();
    await page.getByRole('button', { name: 'Confirm transfer' }).click();
    await expect(page.getByRole('heading', { name: 'Transfer completed' })).toBeVisible();
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
    await expect(page.getByText('Already processed')).toHaveCount(0);
  });
});

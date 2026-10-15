const AxeBuilder = require('@axe-core/playwright').default;
const { test, expect, login } = require('./fixtures');

const WIDTHS = [320, 360, 375, 390, 430, 768, 1024, 1280, 1440, 1920];

async function noHorizontalOverflow(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const offenders = [];
    if (doc.scrollWidth > doc.clientWidth + 1) {
      // Report the widest elements to make failures actionable.
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (r.right > doc.clientWidth + 1 && getComputedStyle(el).position !== 'fixed' && !el.closest('.table-wrap, .tabs, .sidebar:not(.is-open)')) {
          offenders.push(`${el.tagName.toLowerCase()}.${el.className}`.slice(0, 80));
        }
      }
    }
    return { overflow: doc.scrollWidth - doc.clientWidth, offenders: offenders.slice(0, 5) };
  });
}

const PAGES = {
  public: ['/', '/login.html', '/no-such-page'],
  jane: ['#/dashboard', '#/accounts', '#/transfer', '#/history', '#/profile'],
  staff: ['#/staff/register', '#/staff/deposit'],
  admin: ['#/admin/users', '#/admin/audit'],
};

test.describe('Responsive layout: no horizontal page scroll', () => {
  for (const width of WIDTHS) {
    test(`${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: width < 768 ? 800 : 900 });
      const failures = [];
      for (const url of PAGES.public) {
        await page.goto(url);
        await page.waitForLoadState('networkidle');
        const r = await noHorizontalOverflow(page);
        if (r.overflow > 1) failures.push(`${url}: +${r.overflow}px ${r.offenders.join(', ')}`);
      }
      for (const who of ['jane', 'staff', 'admin']) {
        await login(page, who);
        for (const hash of PAGES[who]) {
          await page.goto(`/app.html${hash}`);
          await page.locator('[data-page-title]').waitFor();
          await page.waitForLoadState('networkidle');
          const r = await noHorizontalOverflow(page);
          if (r.overflow > 1) failures.push(`${who} ${hash}: +${r.overflow}px ${r.offenders.join(', ')}`);
        }
        await page.context().clearCookies();
      }
      expect(failures).toEqual([]);
    });
  }
});

test.describe('Money is never clipped', () => {
  for (const width of WIDTHS) {
    test(`dashboard stat values fully visible at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await login(page, 'jane');
      await page.locator('.stat-grid .stat__value').first().waitFor();
      const clipped = await page.$$eval('.stat__value', (els) => els
        .map((el) => {
          const card = el.closest('.stat').getBoundingClientRect();
          const r = el.getBoundingClientRect();
          const overflow = el.scrollWidth > el.clientWidth + 1 || r.right > card.right + 1;
          return overflow ? el.textContent.trim() : null;
        })
        .filter(Boolean));
      expect(clipped).toEqual([]);
    });
  }
});

test.describe('Mobile navigation', () => {
  test('menu opens, traps nothing, closes with Escape and returns focus', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await login(page, 'jane');
    const menuBtn = page.getByRole('button', { name: 'Open menu' });
    await expect(menuBtn).toBeVisible();
    await expect(menuBtn).toHaveAttribute('aria-expanded', 'false');
    await menuBtn.click();
    await expect(menuBtn).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Dashboard' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menuBtn).toHaveAttribute('aria-expanded', 'false');
    await expect(menuBtn).toBeFocused();
    await menuBtn.click();
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Transfer Funds' }).click();
    await expect(page.getByRole('heading', { name: 'Transfer Funds' })).toBeVisible();
    await expect(menuBtn).toHaveAttribute('aria-expanded', 'false');
  });

  test('desktop shows the sidebar permanently and hides the menu button', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await login(page, 'jane');
    await expect(page.getByRole('button', { name: 'Open menu' })).toBeHidden();
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  });

  test('dialogs fit inside a 320px viewport', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await login(page, 'jane');
    await page.getByRole('button', { name: /^Details for/ }).first().click();
    const box = await page.getByRole('dialog').boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
  });
});

test.describe('Keyboard and focus', () => {
  test('login works with the keyboard alone', async ({ page }) => {
    await page.goto('/login.html');
    await page.keyboard.press('Tab'); // skip link
    await expect(page.getByRole('link', { name: 'Skip to login form' })).toBeFocused();
    await page.getByLabel('Email address').focus();
    await page.keyboard.type('jane@vault24.test');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Vault24-Customer-Demo1');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/app\.html#\/dashboard/);
  });

  test('focused buttons and links show a visible focus ring', async ({ page }) => {
    await login(page, 'jane');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    const outline = await page.evaluate(() => {
      const s = getComputedStyle(document.activeElement);
      return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) };
    });
    expect(outline.style).not.toBe('none');
    expect(outline.width).toBeGreaterThanOrEqual(2);
  });

  test('route changes move focus to the new page heading', async ({ page }) => {
    await login(page, 'jane');
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Profile' }).click();
    await expect(page.getByRole('heading', { name: 'Profile', level: 1 })).toBeFocused();
    await expect(page).toHaveTitle('Profile — Vault24');
  });

  test('reduced-motion preference disables animations', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await login(page, 'jane');
    const duration = await page.evaluate(() => {
      const el = document.createElement('div');
      el.className = 'spinner';
      document.body.append(el);
      const d = getComputedStyle(el).animationDuration;
      el.remove();
      return d;
    });
    expect(parseFloat(duration)).toBeLessThan(0.01);
  });
});

test.describe('Automated accessibility scan (axe-core, WCAG 2.x A/AA)', () => {
  const scan = async (page) => {
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
    return results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  };

  for (const url of ['/', '/login.html']) {
    test(`public ${url}`, async ({ page }) => {
      await page.goto(url);
      expect(await scan(page)).toEqual([]);
    });
  }

  const APP = [['jane', '#/dashboard'], ['jane', '#/transfer'], ['jane', '#/history'], ['jane', '#/profile'], ['jane', '#/security'],
    ['staff', '#/dashboard'], ['staff', '#/staff/register'], ['staff', '#/staff/deposit'], ['admin', '#/dashboard'], ['admin', '#/admin/users'], ['admin', '#/admin/documents?status='], ['admin', '#/admin/audit']];
  for (const [who, hash] of APP) {
    test(`${who} ${hash}`, async ({ page }) => {
      await login(page, who);
      await page.goto(`/app.html${hash}`);
      await page.locator('[data-page-title]').waitFor();
      await page.waitForLoadState('networkidle');
      expect(await scan(page)).toEqual([]);
    });
  }

  test('form errors are announced and linked to their fields', async ({ page }) => {
    await login(page, 'jane');
    await page.goto('/app.html#/transfer');
    await page.getByRole('button', { name: 'Review transfer' }).click();
    const input = page.getByLabel(/^Recipient account number/);
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    const describedBy = await input.getAttribute('aria-describedby');
    const errId = describedBy.split(' ').find((id) => id.endsWith('-err'));
    await expect(page.locator(`[id="${errId}"]`)).toContainText('Enter the recipient account number');
    expect(await scan(page)).toEqual([]);
  });
});

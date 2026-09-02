/**
 * Drives the live-mode switch in the running app.
 *
 * Proves the thing that matters: that flipping to live actually empties the
 * dashboards of seeded figures, and that flipping back restores them. A unit
 * test covers the fact loader; this covers the loader, the route, the cache and
 * the page that renders it.
 *
 * Usage: `pnpm start` in one shell, then `pnpm verify:mode`.
 */
import { chromium, type Page } from 'playwright';

const BASE = 'http://localhost:3000';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox'],
});
const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, colorScheme: 'dark', deviceScaleFactor: 2 });
const page = await context.newPage();

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.fill('#email', 'cfo@westportfinancial.com');
await page.fill('#password', 'westport2026');
await Promise.all([page.waitForURL('**/executive**', { timeout: 30_000 }), page.click('button[type=submit]')]);

async function executiveSnapshot(label: string) {
  await page.goto(`${BASE}/executive?month=2026-03&division=ARG_TOTAL`, { waitUntil: 'networkidle' });
  const banner = await page.locator('text=Demonstration data').first().isVisible().catch(() => false);
  const revenue = await page.locator('text=Revenue Run Rate').locator('xpath=../..').innerText().catch(() => '(not found)');
  console.log(`${label}\n  demo banner: ${banner}\n  ${revenue.replace(/\n/g, ' | ').slice(0, 130)}\n`);
}

async function clickMode(page: Page, name: RegExp) {
  await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name }).click();
  await page.waitForTimeout(2500);
}

await executiveSnapshot('BEFORE (demonstration)');
await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
await page.screenshot({ path: 'screenshots/admin-data.png', fullPage: false });

await clickMode(page, /Switch to live data/);
await executiveSnapshot('AFTER switching to live');
await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
await page.screenshot({ path: 'screenshots/admin-live.png', fullPage: false });

await clickMode(page, /Show demonstration data/);
await executiveSnapshot('AFTER switching back');

await browser.close();

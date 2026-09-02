/**
 * Clicks "Sign in with QuickBooks" in the real app and follows where it goes.
 *
 * The only thing that proves the connect flow: session, the start route, the
 * live Composio API, the pending-state row, and the redirect the user actually
 * lands on. It stops at the provider's consent screen — completing it needs a
 * real QuickBooks login.
 *
 * Usage: `pnpm start` in one shell, then `pnpm verify:connect`.
 */
import { chromium } from 'playwright';

const BASE = 'http://localhost:3000';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox'],
});
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, colorScheme: 'dark', deviceScaleFactor: 2 });
const page = await context.newPage();

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.fill('#email', 'cfo@westportfinancial.com');
await page.fill('#password', 'westport2026');
await Promise.all([page.waitForURL('**/executive**', { timeout: 30_000 }), page.click('button[type=submit]')]);

await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
await page.screenshot({ path: 'screenshots/connect-admin.png' });

for (const label of ['Sign in with QuickBooks', 'Sign in with HubSpot', 'Sign in with Google']) {
  const link = page.getByRole('link', { name: label });
  if ((await link.count()) === 0) { console.log(`${label}: BUTTON MISSING`); continue; }

  await link.click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(2500);

  const url = page.url();
  const admin = url.includes('/admin');
  const error = admin ? new URL(url).searchParams.get('connect_error') : null;
  console.log(`${label}\n  -> ${url.slice(0, 110)}`);
  if (error) console.log(`  !! ${error}`);
  else console.log(`  page title: ${(await page.title()).slice(0, 80)}`);
  console.log();

  await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
}

await browser.close();

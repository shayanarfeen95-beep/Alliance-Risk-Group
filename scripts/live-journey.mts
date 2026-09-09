/**
 * The whole journey a real deployment makes, on an empty database.
 *
 * Setup the first administrator, sign in, reach Admin, and confirm the
 * dashboards are honest about having nothing yet. This is the path that
 * demonstration mode used to paper over: it seeded itself, so nobody ever saw
 * what a genuinely empty deployment does.
 *
 * Usage: delete .pgdata, `pnpm build`, `pnpm start`, then run this.
 */
import { chromium } from 'playwright';

const BASE = 'http://localhost:3000';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox'],
});
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, colorScheme: 'dark', deviceScaleFactor: 2 });
const page = await context.newPage();
page.setDefaultTimeout(120_000);
page.setDefaultNavigationTimeout(120_000);

// 1. A bare deployment sends the first visitor to setup, not to a login form
//    that cannot succeed.
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
console.log(`1. first visit        -> ${page.url()}`);

// The setup form labels its inputs rather than giving them ids.
await page.getByLabel('Your name').fill('Shayan Arfeen');
await page.getByLabel('Email').fill('admin@alliancerisk.com');
await page.getByLabel('Password').fill('a-long-enough-passphrase');
await page.click('button[type=submit]');
await page.waitForTimeout(4000);
console.log(`2. after setup        -> ${page.url()}`);

// 2. Sign in.
if (page.url().includes('/login')) {
  await page.fill('#email', 'admin@alliancerisk.com');
  await page.fill('#password', 'a-long-enough-passphrase');
  await Promise.all([
    page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 60_000 }),
    page.click('button[type=submit]'),
  ]);
}
console.log(`3. after sign-in      -> ${page.url()}`);

// 3. The session must survive an ordinary navigation.
await page.goto(`${BASE}/executive?month=2026-03&division=ARG_TOTAL`, { waitUntil: 'domcontentloaded' });
console.log(`4. executive          -> ${page.url()}`);
const bounced = page.url().includes('/login');
console.log(`   ${bounced ? 'BOUNCED TO LOGIN  <-- the bug' : 'stayed signed in'}`);

const body = await page.locator('main').innerText().catch(() => '');
console.log(`   demonstration banner present: ${body.includes('Demonstration data')}`);
console.log(`   first tile reads: ${(body.match(/Revenue Run Rate[\s\S]{0,120}/) ?? ['(not found)'])[0].replace(/\n+/g, ' | ').slice(0, 150)}`);

// 4. Admin, where the sources are connected.
await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
console.log(`5. admin              -> ${page.url()}`);
await page.screenshot({ path: 'screenshots/live-admin.png' });

const hubspot = page.getByRole('link', { name: /Sign in with HubSpot/ });
console.log(`   HubSpot sign-in button present: ${(await hubspot.count()) > 0}`);

await browser.close();

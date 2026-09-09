/**
 * Proves a session survives a second serverless instance.
 *
 * Two `next start` processes, each with its own in-memory database, is what
 * Vercel actually runs in demo mode: separate seeds, separate user ids, separate
 * sessions tables. Cookies are scoped by host and not by port, so signing in on
 * one and navigating to the other is the same journey a user makes when their
 * next request is routed to a different instance.
 *
 * That journey is what sent them back to the login page, over and over.
 *
 * Usage: start two servers with DEMO_MODE=1 on :3000 and :3001, then run this.
 */
import { chromium } from 'playwright';

const A = 'http://localhost:3000';
const B = 'http://localhost:3001';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox'],
});
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await context.newPage();
page.setDefaultTimeout(180_000);
page.setDefaultNavigationTimeout(180_000);

// --- sign in on instance A ------------------------------------------------
await page.goto(`${A}/login`, { waitUntil: 'domcontentloaded' });
await page.fill('#email', 'cfo@westportfinancial.com');
await page.fill('#password', 'westport2026');
await Promise.all([page.waitForURL('**/executive**', { timeout: 60_000 }), page.click('button[type=submit]')]);
console.log(`signed in on A  -> ${page.url()}`);

// --- confirm the two instances really are different databases -------------
const idA = await page.evaluate(() => document.cookie);
void idA;

// --- now visit instance B with the same cookie ----------------------------
await page.goto(`${B}/executive?month=2026-03&division=ARG_TOTAL`, { waitUntil: 'domcontentloaded' });
const landedOn = page.url();
const bounced = landedOn.includes('/login');
console.log(`visited B       -> ${landedOn}`);
console.log(bounced ? '  RESULT: bounced back to the login page  <-- the reported bug' : '  RESULT: still signed in');

// --- and the Sign in with HubSpot button on the other instance ------------
await page.goto(`${B}/admin`, { waitUntil: 'domcontentloaded' });
const onAdmin = page.url();
console.log(`visited B/admin -> ${onAdmin}`);

const hubspot = page.getByRole('link', { name: /Sign in with HubSpot/ });
if (await hubspot.count()) {
  await hubspot.click();
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(2000);
  const after = page.url();
  const toLogin = after.includes('/login');
  console.log(`clicked HubSpot -> ${after.slice(0, 120)}`);
  if (toLogin) console.log('  RESULT: bounced to login  <-- the reported bug');
  else {
    const err = new URL(after).searchParams.get('connect_error');
    console.log(err ? `  RESULT: refused with a reason: ${err.slice(0, 160)}` : '  RESULT: proceeded to the provider');
  }
} else {
  console.log('  (no HubSpot sign-in button rendered — Composio not configured here)');
}

await browser.close();

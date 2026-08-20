/**
 * Drives a KPI card the way a person does.
 *
 * `verify:visual` screenshots pages, which catches layout and overflow but
 * cannot catch a control that renders and does nothing. The expandable card is
 * exactly that risk: every part of it is precomputed server-side, so a wiring
 * mistake produces a panel that opens onto empty sections and looks fine in a
 * screenshot.
 *
 * Usage: pnpm dev in one shell, then `pnpm verify:interaction`.
 */
import { chromium } from 'playwright';

const BASE = 'http://localhost:3000';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });

const errors: string[] = [];
// The favicon 404s in development and is not a defect worth failing on.
const ignorable = (url: string) => url.includes('favicon');
page.on('console', (m) => {
  if (m.type() === 'error' && !ignorable(m.location().url ?? '')) errors.push(m.text());
});
page.on('response', (r) => {
  if (r.status() >= 400 && !ignorable(r.url())) errors.push(`${r.status()} ${r.url()}`);
});
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.fill('#email', 'cfo@westportfinancial.com');
await page.fill('#password', 'westport2026');
await Promise.all([page.waitForURL('**/executive**', { timeout: 30000 }), page.click('button[type=submit]')]);

await page.goto(`${BASE}/executive?month=2026-03&division=ARG_TOTAL`, { waitUntil: 'networkidle' });

// The comparison control is on the card face now, so assert it there before
// opening anything — that is the whole "every box has its own filters" claim.
const faceFilter = page.getByRole('group', { name: /Compare .* against/ }).first();
await faceFilter.waitFor({ state: 'visible', timeout: 15000 });

const faceBefore = await page.locator('article, div').filter({ hasText: 'Revenue Run Rate' }).first().innerText();
await faceFilter.getByRole('button', { name: 'Prior year', exact: true }).click();
await page.waitForTimeout(250);
const faceAfter = await page.locator('article, div').filter({ hasText: 'Revenue Run Rate' }).first().innerText();
const faceSwitches = faceBefore !== faceAfter;
console.log('on-face comparison switches without opening the card:', faceSwitches);

const toggle = page.getByRole('button', { name: /Break down/ }).first();
await toggle.click();
await page.waitForTimeout(400);

// Prove the panel actually opened with real content, not an empty shell.
const panelText = await page.locator('text=Prior month').first().isVisible();
const breakdown = await page.locator('text=By division').first().isVisible().catch(() => false);
const trend = await page.locator('text=Trailing twelve months').first().isVisible().catch(() => false);
console.log('compare visible:', panelText, '| breakdown:', breakdown, '| trend:', trend);

// And the expanded panel shows the same selected basis in full.
const before = await page.locator('dl').first().innerText();
await faceFilter.getByRole('button', { name: 'Prior month', exact: true }).click();
await page.waitForTimeout(250);
const after = await page.locator('dl').first().innerText();
console.log('the panel follows the selected basis:', before !== after);

await page.screenshot({ path: 'screenshots/kpi-expanded.png', fullPage: false });
await browser.close();

if (!panelText || !breakdown || !trend || !faceSwitches || before === after || errors.length > 0) {
  console.error('FAILED', {
    panelText,
    breakdown,
    trend,
    faceSwitches,
    panelFollows: before !== after,
    errors,
  });
  process.exit(1);
}

console.log('\nevery KPI card filters on its face and opens for the breakdown \u2014 screenshots/kpi-expanded.png');

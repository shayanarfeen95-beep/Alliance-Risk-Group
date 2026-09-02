/**
 * Drives the assistant in a real browser against a running app.
 *
 * A smoke test rather than a unit test, and the only thing that proves the whole
 * chain: session, semantic layer, tool surface, the OpenRouter transport, the
 * streamed SSE response and the panel that renders it. Unit tests cover each
 * piece; none of them would have caught the em dash in an HTTP header that broke
 * every turn before the request was even sent.
 *
 * Usage: `pnpm start` in one shell, then `pnpm verify:agent`.
 * Ask something else with `Q="..." pnpm verify:agent`.
 */
import { chromium } from 'playwright';

const BASE = 'http://localhost:3000';
const QUESTION = process.env.Q ?? 'What was LITS gross margin in March 2026, and how does it compare to budget?';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox'],
});
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, colorScheme: 'dark', deviceScaleFactor: 2 });
const page = await context.newPage();

page.on('console', (m) => { if (m.type() === 'error') console.log('  [console error]', m.text().slice(0, 200)); });

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.fill('#email', 'cfo@westportfinancial.com');
await page.fill('#password', 'westport2026');
await Promise.all([page.waitForURL('**/executive**', { timeout: 30_000 }), page.click('button[type=submit]')]);

await page.goto(`${BASE}/executive?month=2026-03&division=ARG_TOTAL`, { waitUntil: 'networkidle' });
const launcher = page.getByRole('button', { name: /Ask the data/ });
if (await launcher.isVisible().catch(() => false)) await launcher.click();

await page.fill('textarea', QUESTION);
await page.keyboard.press('Enter');
console.log(`asked: ${QUESTION}\n`);

// Wait for the composer to become idle again (the stop button reverts to send).
const started = Date.now();
let lastLen = 0;
for (let i = 0; i < 120; i++) {
  await page.waitForTimeout(1000);
  const stopping = await page.getByRole('button', { name: 'Stop' }).count();
  const text = await page.locator('aside').innerText();
  if (text.length !== lastLen) lastLen = text.length;
  if (stopping === 0 && i > 2) break;
}
console.log(`turn finished in ${Math.round((Date.now() - started) / 1000)}s\n`);

const panel = await page.locator('aside').innerText();
console.log('--- PANEL ---');
console.log(panel);
console.log('--- END ---');

await page.screenshot({ path: 'screenshots/agent-live.png' });
await browser.close();

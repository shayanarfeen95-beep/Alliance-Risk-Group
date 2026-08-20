/**
 * Opens the assistant panel and checks it presents as a working agent.
 *
 * The complaint this exists for was that the panel read as a questionnaire —
 * four canned questions and an explainer. That is a rendering property, so it
 * is worth asserting: the capabilities are listed as things it does, the real
 * connection state is shown, and clicking an example loads it into the input
 * rather than firing it blind.
 */
import { chromium } from 'playwright';

const BASE = process.env.VISUAL_BASE_URL ?? 'http://localhost:3000';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });

const errors: string[] = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.fill('#email', 'cfo@westportfinancial.com');
await page.fill('#password', 'westport2026');
await Promise.all([
  page.waitForURL('**/executive**', { timeout: 30000 }),
  page.click('button[type=submit]'),
]);

await page.goto(`${BASE}/executive?month=2026-03&division=ARG_TOTAL`, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /Ask the data/ }).click();

// Wait for the connection state to arrive rather than guessing at a delay.
// The sources block renders only once /api/agent/status resolves, and a fixed
// timeout raced it — which is a flaky check, not a flaky panel.
await page.getByText('Connected sources').waitFor({ state: 'visible', timeout: 15000 });

const checks = {
  headline: await page.getByText('Give it something to do.').isVisible(),
  sources: await page.getByText('Connected sources').isVisible(),
  capability: await page.getByText('Answer with a figure you can check').isVisible(),
  explain: await page.getByText('Explain a movement').isVisible(),
  // Import is conditional on a connected source. Nothing is connected in the
  // seeded instance, so it must be absent — offering it would be a promise the
  // panel cannot keep.
  importHidden: !(await page.getByText('Import fresh data').isVisible().catch(() => false)),
};

// Clicking an example should stage it for editing, not fire it.
await page.getByText('Why did Claims lose money in March?').click();
await page.waitForTimeout(250);
const staged = await page.locator('textarea').inputValue();

await page.screenshot({ path: 'screenshots/assistant.png' });
await browser.close();

const staging = staged.includes('Claims');
console.log({ ...checks, staging, errors: errors.length });

if (Object.values(checks).some((value) => !value) || !staging || errors.length > 0) {
  console.error('FAILED', { checks, staged, errors });
  process.exit(1);
}
console.log('\nthe assistant panel presents as an agent — screenshots/assistant.png');

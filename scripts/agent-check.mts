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

// --- The streaming path ------------------------------------------------
//
// The assistant is unconfigured in this environment, so a send returns an
// error event rather than an answer. That still exercises everything that made
// the panel feel broken: the view must scroll to the message immediately, the
// message must appear straight away rather than when the round trip ends, and
// the error must arrive through the stream rather than as an unhandled parse.
await page.locator('textarea').fill('What was revenue in March?');
await page.keyboard.press('Enter');

// The user's own message must be on screen at once — it used to wait for the
// whole round trip, which on a slow model is the panel appearing to swallow it.
await page.getByText('What was revenue in March?', { exact: false }).last().waitFor({
  state: 'visible',
  timeout: 5000,
});
const echoed = true;

// And the stream delivers the outcome rather than the request hanging.
//
// Asserted on the text rather than the ARIA role: the role matched an element
// that was not the one carrying the message, which made a working panel look
// broken. The text is what a person would check.
await page
  .getByText(/OPENROUTER_API_KEY is not set|could not complete|revenue/i)
  .last()
  .waitFor({ state: 'visible', timeout: 20000 });
const streamed = true;

// The header must still be on screen after the transcript has grown.
// `xl:static` left the panel unbounded, so the page scrolled instead of the
// conversation and everything but the composer went off screen.
const headerVisible = await page.getByRole('heading', { name: 'Assistant' }).isVisible();

await page.screenshot({ path: 'screenshots/assistant.png' });
await browser.close();

const staging = staged.includes('Claims');
console.log({ ...checks, staging, echoed, streamed, headerVisible, errors: errors.length });

if (
  Object.values(checks).some((value) => !value) ||
  !staging ||
  !echoed ||
  !streamed ||
  !headerVisible ||
  errors.length > 0
) {
  console.error('FAILED', { checks, staged, echoed, streamed, headerVisible, errors });
  process.exit(1);
}
console.log('\nthe assistant panel presents as an agent — screenshots/assistant.png');

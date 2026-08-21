/**
 * Drives the real app in a browser and screenshots every dashboard.
 *
 * The palette validator checks colour, not layout — this is how label
 * collisions, overflow and broken geometry get caught. Both themes are captured
 * because dark mode is a selected palette, not an automatic inversion.
 *
 * Usage: pnpm dev in one shell, then `pnpm verify:visual`.
 */
import { chromium, type Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const SANDBOX_CHROMIUM = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const BASE = process.env.VISUAL_BASE_URL ?? 'http://localhost:3000';
const OUT = 'screenshots';

const ONLY = process.env.VISUAL_ONLY?.split(',').map((s) => s.trim());

const ALL_PAGES: Array<{ name: string; path: string }> = [
  { name: 'executive', path: '/executive?month=2026-03&division=ARG_TOTAL' },
  { name: 'finance', path: '/finance?month=2026-03&division=ARG_TOTAL' },
  { name: 'finance-division', path: '/finance?month=2026-03&division=CLAIMS' },
  { name: 'sales', path: '/sales?month=2026-03&division=ARG_TOTAL' },
  { name: 'pipeline', path: '/pipeline?month=2026-03&division=ARG_TOTAL' },
  { name: 'marketing', path: '/marketing?month=2026-03&division=ARG_TOTAL' },
  { name: 'forecast', path: '/forecast?month=2026-04&division=ARG_TOTAL' },
  { name: 'forecast-accuracy', path: '/forecast/accuracy?month=2026-03&division=ARG_TOTAL' },
  { name: 'kpi-dictionary', path: '/kpi-dictionary' },
  { name: 'admin', path: '/admin' },
];

const PAGES = ONLY ? ALL_PAGES.filter((p) => ONLY.includes(p.name)) : ALL_PAGES;

async function login(page: Page) {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.fill('#email', process.env.VISUAL_USER ?? 'cfo@westportfinancial.com');
  await page.fill('#password', process.env.VISUAL_PASSWORD ?? 'westport2026');
  await Promise.all([
    page.waitForURL('**/executive**', { timeout: 30_000 }),
    page.click('button[type=submit]'),
  ]);
}

async function main() {
  await mkdir(OUT, { recursive: true });

  // The sandbox ships a Chromium build that does not match the pinned
  // Playwright revision, so point at the installed binary rather than
  // downloading one.
  const browser = await chromium.launch({
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_PATH ||
      (existsSync(SANDBOX_CHROMIUM) ? SANDBOX_CHROMIUM : undefined),
  });

  const failures: string[] = [];

  for (const theme of ['light', 'dark'] as const) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: 2,
      colorScheme: theme,
    });
    const page = await context.newPage();

    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(String(error)));

    await login(page);
    await page.addInitScript((value) => localStorage.setItem('arg-theme', value), theme);

    for (const target of PAGES) {
      const before = consoleErrors.length;
      const response = await page.goto(`${BASE}${target.path}`, { waitUntil: 'networkidle' });
      await page.evaluate(
        (value) => document.documentElement.setAttribute('data-theme', value),
        theme,
      );
      // Let Recharts finish its responsive measurement pass.
      await page.waitForTimeout(700);

      const status = response?.status() ?? 0;
      if (status >= 400) failures.push(`${target.name} (${theme}) returned HTTP ${status}`);

      // The page body must never scroll horizontally; wide blocks scroll inside
      // their own container.
      const overflows = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1,
      );
      if (overflows) failures.push(`${target.name} (${theme}) scrolls horizontally at 1440px`);

      const newErrors = consoleErrors.slice(before);
      if (newErrors.length) {
        failures.push(`${target.name} (${theme}) console: ${newErrors[0]}`);
      }

      await page.screenshot({
        path: `${OUT}/${target.name}-${theme}.png`,
        fullPage: true,
      });
      console.log(`  captured ${target.name} (${theme}) — HTTP ${status}`);
    }

    await context.close();
  }

  await browser.close();

  if (failures.length) {
    console.error('\nvisual check found problems:');
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    process.exit(1);
  }
  console.log(`\nall pages rendered cleanly in both themes → ${OUT}/`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

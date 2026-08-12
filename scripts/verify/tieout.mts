/**
 * Reads the running warehouse and compares every figure against the numbers
 * transcribed directly from §13.1 of the PDF.
 */
import { getDb } from '@/lib/db/client';
import { openSemanticSession, resolveKpi } from '@/lib/semantic/resolve';
import * as t from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

// Transcribed from the PDF text, not from the app's own constants.
const PDF_MARCH: Record<string, [number, number, number, number, number]> = {
  SHRC:      [195_519, 124_068,  71_451,  45_252,  26_198],
  CLAIMS:    [102_963,  66_939,  36_025,  61_741, -25_717],
  TP:        [ 42_999,  28_807,  14_192,  18_764,  -4_572],
  LITS:      [203_363,  79_444, 123_918,  27_133,  96_786],
  ARG_TOTAL: [544_844, 299_258, 245_586, 152_890,  92_696],
};

const PDF_YTD: Record<string, [number, number, number, number]> = {
  SHRC:      [591_421, 238_456,  80_750, 2_365_685],
  CLAIMS:    [335_254, 113_256, -62_114, 1_341_016],
  TP:        [136_472,  52_747,      40,   545_889],
  LITS:      [347_087, 133_030,  43_521, 1_388_349],
  ARG_TOTAL: [1_410_235, 537_490, 62_197, 5_640_939],
};

const db = await getDb();
const [u] = await db.select().from(t.users).where(eq(t.users.email, 'cfo@westportfinancial.com'));
const user = { id: u!.id, email: u!.email, name: u!.name, role: 'CFO' as const, canViewConsolidated: true, divisionCodes: [] as string[] };
const s = await openSemanticSession(db, user, '2026-03-01');

const money = (n: number) => (n < 0 ? `(${Math.abs(n).toLocaleString()})` : n.toLocaleString());
let failures = 0;
const check = (label: string, actual: number, expected: number, tol = 1) => {
  const diff = Math.abs(actual - expected);
  const ok = diff <= tol;
  if (!ok) failures++;
  console.log(
    `  ${ok ? '✓' : '✗'} ${label.padEnd(34)} app ${money(Math.round(actual)).padStart(11)}   pdf ${money(expected).padStart(11)}${ok ? '' : `   DIFF ${diff.toFixed(0)}`}`,
  );
};

console.log('\n§13.1 MONTHLY — March 2026 (revenue / COGS / gross profit / OpEx / net profit)\n');
for (const [div, [rev, cogs, gp, opex, np]] of Object.entries(PDF_MARCH)) {
  check(`${div} revenue`,      resolveKpi(s, 'revenue', div).value!.toNumber(), rev);
  check(`${div} COGS`,         resolveKpi(s, 'cogs', div).value!.toNumber(), cogs);
  check(`${div} gross profit`, resolveKpi(s, 'gross_profit', div).value!.toNumber(), gp);
  check(`${div} OpEx`,         resolveKpi(s, 'opex', div).value!.toNumber(), opex);
  check(`${div} net profit`,   resolveKpi(s, 'net_profit', div).value!.toNumber(), np);
  console.log('');
}

console.log('§13.1 YTD through March 2026 (YTD revenue / YTD GP / YTD NP / revenue run rate)\n');
for (const [div, [rev, gp, np, rr]] of Object.entries(PDF_YTD)) {
  const ytd = (id: string) => {
    let total = 0;
    for (const m of s.period.ytdMonths) total += resolveKpi(s, id, div, { month: m }).value!.toNumber();
    return total;
  };
  check(`${div} YTD revenue`,      ytd('revenue'), rev);
  check(`${div} YTD gross profit`, ytd('gross_profit'), gp);
  check(`${div} YTD net profit`,   ytd('net_profit'), np);
  check(`${div} revenue run rate`, resolveKpi(s, 'revenue_run_rate', div).value!.toNumber(), rr, 4);
  console.log('');
}

console.log('THE TWO WRONG ANSWERS THE SPEC WARNS ABOUT\n');
const shrcGp = resolveKpi(s, 'gross_profit', 'SHRC').value!.toNumber();
console.log(`  ${Math.abs(shrcGp - 71_451) <= 1 ? '✓' : '✗'} SHRC gross profit is ${money(Math.round(shrcGp))}, not 38,407 (payroll memo double-count)`);
const rr = resolveKpi(s, 'revenue_run_rate', 'ARG_TOTAL').value!.toNumber();
const wrong = resolveKpi(s, 'revenue', 'ARG_TOTAL').value!.toNumber() * 12;
console.log(`  ${Math.abs(rr - 5_640_939) <= 4 ? '✓' : '✗'} ARG Total run rate is ${money(Math.round(rr))}, not ${money(Math.round(wrong))} (single-month × 12)`);

console.log(`\n${failures === 0 ? 'ALL FIGURES MATCH THE PDF' : `${failures} FIGURE(S) DID NOT MATCH`}\n`);

import type { Metadata } from 'next';
import Link from 'next/link';
import Decimal from 'decimal.js';
import { Lock, ShieldCheck, TriangleAlert } from 'lucide-react';
import { CONSOLIDATED_CODE } from '@/lib/semantic/resolve';
import { loadFinance } from '@/lib/dashboards/finance';
import { preferredBudgetScenario } from '@/lib/semantic/registry';
import { Headline } from '@/components/finance/headline';
import { loadDashboardContext, type SearchParams } from '@/lib/dashboards/context';
import { buildDivisionColorMap } from '@/lib/charts/colors';
import { formatMonth } from '@/lib/semantic/periods';
import { formatNumber, formatSignedNumber } from '@/lib/format';
import { resolveKpi } from '@/lib/semantic/resolve';
import { sumPlOverMonths } from '@/lib/semantic/facts';
import { budgetedRevenue, forecastGateStatus, listScenarios } from '@/lib/forecast/service';
import { suggestAssumptions } from '@/lib/forecast/engine';
import { can } from '@/lib/auth/scope';
import { AssumptionGrid, type DivisionContext } from '@/components/forecast/assumption-grid';
import { LockControls } from '@/components/forecast/lock-controls';
import { Card, CardHeader, Chip, DataTable, SectionTitle, Td, Th } from '@/components/ui/primitives';

export const metadata: Metadata = { title: 'Forecast' };
export const dynamic = 'force-dynamic';

export default async function ForecastPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const context = await loadDashboardContext(await searchParams);
  const { session, user } = context;
  const { period } = session;
  const colors = buildDivisionColorMap(session.bundle.divisions);

  const divisionCodes = session.bundle.divisions.map((d) => d.divisionCode);
  const [budgets, scenarios, gate] = await Promise.all([
    budgetedRevenue(period.month, divisionCodes),
    listScenarios(period.month),
    forecastGateStatus(period.month),
  ]);

  const num = (result: { value: { toNumber(): number } | null }) =>
    result.value ? result.value.toNumber() : null;

  const divisions: DivisionContext[] = session.bundle.divisions.map((division) => {
    const trailing = sumPlOverMonths(
      session.bundle,
      period.trailingThreeMonths,
      [division.divisionCode],
    );

    return {
      divisionCode: division.divisionCode,
      divisionName: division.divisionName,
      color: colors[division.divisionCode] ?? 'var(--series-1)',
      budgetedRevenue: Number(budgets[division.divisionCode] ?? 0),
      priorMonth: {
        revenue: num(resolveKpi(session, 'revenue', division.divisionCode, { month: period.priorMonth })),
        grossProfit: num(resolveKpi(session, 'gross_profit', division.divisionCode, { month: period.priorMonth })),
        netProfit: num(resolveKpi(session, 'net_profit', division.divisionCode, { month: period.priorMonth })),
      },
      priorYear: {
        revenue: num(resolveKpi(session, 'revenue', division.divisionCode, { month: period.priorYearMonth })),
        grossProfit: num(resolveKpi(session, 'gross_profit', division.divisionCode, { month: period.priorYearMonth })),
        netProfit: num(resolveKpi(session, 'net_profit', division.divisionCode, { month: period.priorYearMonth })),
      },
      // A starting point rather than a blank form: the suggestion comes from
      // budget, prior year and trailing actuals, and the user adjusts it.
      suggested: suggestAssumptions({
        budgetedRevenue: new Decimal(budgets[division.divisionCode] ?? 0),
        trailingRevenue: trailing.revenue,
        trailingCogs: trailing.cogs,
        trailingPayrollDirect: trailing.payrollDirect,
        trailingOpex: trailing.opex,
        trailingPayrollExpense: trailing.payrollExpense,
        monthsInTrailing: period.trailingThreeMonths.length,
      }),
    };
  });

  const canLock = can(user, 'LOCK_FORECAST');

  // The division chosen at the top: ARG Total shows every division, a single
  // division narrows the scenarios, the outlook and the tiles to it.
  const focus = context.divisionCode;
  const inScope = (code: string) => focus === CONSOLIDATED_CODE || code === focus;
  const scopeLabel =
    focus === CONSOLIDATED_CODE
      ? 'ARG Total'
      : (session.bundle.divisions.find((d) => d.divisionCode === focus)?.divisionName ?? focus);
  const scoped = divisions.filter((d) => inScope(d.divisionCode));
  const sumOf = (pick: (d: DivisionContext) => number | null) =>
    scoped.every((d) => pick(d) === null) ? null : scoped.reduce((total, d) => total + (pick(d) ?? 0), 0);

  const budgetScenario = preferredBudgetScenario(session.bundle);
  const budgetName =
    session.bundle.scenarios.get(budgetScenario)?.description ??
    session.bundle.scenarios.get(budgetScenario)?.name ??
    'the budget';
  const budgetBase = sumOf((d) => d.budgetedRevenue);
  const priorMonthRevenue = sumOf((d) => d.priorMonth.revenue);
  const priorYearRevenue = sumOf((d) => d.priorYear.revenue);
  const official = scenarios.find((scenario) => scenario.isOfficial);

  // The rest of the year, from the same model the Finance page uses.
  const outlook = loadFinance(session, focus, colors);
  const outlookRows = outlook.lines.filter((line) => ['revenue', 'gross_profit', 'net_profit'].includes(line.id));

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[19px] font-semibold tracking-tight">Forecast</h1>
          <p className="mt-1 max-w-2xl text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
            Forecast {formatMonth(period.month)} for {scopeLabel}: set assumptions against the budget,
            save scenarios, then lock the official one. Below that, where the year lands.
          </p>
          <ol className="mt-2.5 flex flex-wrap items-center gap-2 text-[11.5px] text-[var(--text-secondary)]">
            {['Set assumptions', 'Save a scenario', 'Lock the official forecast', 'Score it against actuals'].map((step, index) => (
              <li key={step} className="inline-flex items-center gap-1.5">
                <span
                  className="inline-flex h-5 w-5 items-center justify-center rounded-full text-[10.5px] font-semibold"
                  style={{ background: 'var(--surface-2)', color: 'var(--text-primary)' }}
                >
                  {index + 1}
                </span>
                {step}
                {index < 3 ? <span aria-hidden className="text-[var(--text-muted)]">→</span> : null}
              </li>
            ))}
          </ol>
        </div>
        <Link
          href={`/forecast/accuracy?month=${period.month.slice(0, 7)}&division=${context.divisionCode}`}
          className="text-[12px] underline-offset-2 hover:underline"
          style={{ color: 'var(--series-1)' }}
        >
          Forecast vs. actual →
        </Link>
      </header>

      <Headline
        tiles={[
          {
            label: 'Budgeted revenue',
            value: formatNumber(budgetBase, 'currency'),
            context: budgetBase ? `Base: ${budgetName}` : 'No budget loaded for this month',
            tone: 'neutral',
            hint: 'The revenue budget each forecast scales from (Revenue % of budget).',
          },
          {
            label: `Revenue ${formatMonth(period.priorMonth).split(' ')[0]}`,
            value: formatNumber(priorMonthRevenue, 'currency'),
            context: 'Last month, actual',
            tone: 'neutral',
          },
          {
            label: 'Same month last year',
            value: formatNumber(priorYearRevenue, 'currency'),
            context: formatMonth(period.priorYearMonth),
            tone: 'neutral',
          },
          {
            label: 'Scenarios saved',
            value: String(scenarios.length),
            context: official ? `Official: ${official.scenarioName}` : 'None locked yet',
            tone: official ? 'good' : 'neutral',
          },
          {
            label: 'Full-year revenue outlook',
            value: formatNumber(outlookRows[0]?.fullYear.outlook ?? null, 'currency'),
            context:
              outlookRows[0]?.fullYear.outlook != null && outlookRows[0]?.fullYear.budget != null
                ? `${formatSignedNumber(outlookRows[0].fullYear.outlook - outlookRows[0].fullYear.budget, 'currency')} vs full-year budget`
                : 'Needs actuals and a budget',
            tone:
              outlookRows[0]?.fullYear.outlook != null && outlookRows[0]?.fullYear.budget != null
                ? outlookRows[0].fullYear.outlook >= outlookRows[0].fullYear.budget
                  ? 'good'
                  : 'bad'
                : 'neutral',
            href: '#outlook',
          },
          {
            label: 'Full-year net profit outlook',
            value: formatNumber(outlookRows[2]?.fullYear.outlook ?? null, 'currency'),
            context:
              outlookRows[2]?.fullYear.outlook != null && outlookRows[2]?.fullYear.budget != null
                ? `${formatSignedNumber(outlookRows[2].fullYear.outlook - outlookRows[2].fullYear.budget, 'currency')} vs full-year budget`
                : 'Needs actuals and a budget',
            tone:
              outlookRows[2]?.fullYear.outlook != null && outlookRows[2]?.fullYear.budget != null
                ? outlookRows[2].fullYear.outlook >= outlookRows[2].fullYear.budget
                  ? 'good'
                  : 'bad'
                : 'neutral',
            href: '#outlook',
          },
        ]}
      />

      {/* §10.3 — the gate on entering a month's actuals. */}
      <div
        className="flex flex-wrap items-center gap-3 rounded-[var(--radius)] border px-4 py-3"
        style={{
          borderColor: 'var(--border)',
          background: gate.locked || gate.waived ? 'var(--status-good-wash)' : 'var(--status-warning-wash)',
        }}
      >
        {gate.locked ? (
          <>
            <ShieldCheck size={15} aria-hidden style={{ color: 'var(--status-good)' }} />
            <p className="text-[12px]">
              A forecast is locked for {formatMonth(period.month)}. Actuals for this month may be
              entered.
            </p>
          </>
        ) : gate.waived ? (
          <>
            <TriangleAlert size={15} aria-hidden style={{ color: 'var(--status-warning)' }} />
            <p className="text-[12px]">
              No locked forecast — the lock was explicitly waived. Reason on record:{' '}
              <em>{gate.waiverReason}</em>
            </p>
          </>
        ) : (
          <>
            <Lock size={15} aria-hidden style={{ color: 'var(--status-warning)' }} />
            <p className="text-[12px]">
              No forecast is locked for {formatMonth(period.month)}. Entry of this month&rsquo;s
              actuals is blocked until one is locked, or the lock is explicitly waived with a
              reason.
            </p>
          </>
        )}
      </div>

      <SectionTitle hint="Recalculates as you type — sanity-check an assumption before you save it, not after">
        Build a scenario
      </SectionTitle>
      <AssumptionGrid
        key={focus}
        month={period.month}
        divisions={divisions}
        canLock={canLock}
        initialFocus={focus === CONSOLIDATED_CODE ? 'ALL' : focus}
      />

      {/* §10.2 — scenarios side by side. */}
      <SectionTitle hint="Exactly one scenario per month is promoted to the official locked forecast">
        Saved scenarios
      </SectionTitle>
      {scenarios.length === 0 ? (
        <Card>
          <p className="text-[12px] text-[var(--text-muted)]">
            No scenarios saved for {formatMonth(period.month)} yet. Build one above — base, upside,
            downside, or anything else — and save it.
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {scenarios.map((scenario) => {
            const rows = scenario.rows.filter((row) => inScope(row.divisionCode));
            const totals = rows.reduce(
              (sum, row) => ({
                revenue: sum.revenue + row.projection.revenue.toNumber(),
                grossProfit: sum.grossProfit + row.projection.grossProfit.toNumber(),
                netProfit: sum.netProfit + row.projection.netProfit.toNumber(),
              }),
              { revenue: 0, grossProfit: 0, netProfit: 0 },
            );

            return (
              <Card key={scenario.id}>
                <CardHeader
                  title={scenario.scenarioName}
                  subtitle={
                    scenario.isLocked
                      ? `Locked ${new Date(scenario.lockedAt!).toLocaleString()} by ${scenario.lockedByName ?? 'unknown'}${
                          scenario.correctionReason
                            ? ` — correction: ${scenario.correctionReason}`
                            : ''
                        }`
                      : `Draft, saved ${new Date(scenario.createdAt).toLocaleString()}`
                  }
                  action={
                    <div className="flex items-center gap-2">
                      {scenario.isOfficial ? (
                        <Chip tone="good" icon={<ShieldCheck size={12} aria-hidden />}>
                          Official
                        </Chip>
                      ) : null}
                      {scenario.isLocked ? (
                        <Chip tone="neutral" icon={<Lock size={12} aria-hidden />} title="Immutable — enforced in the database, not just the interface.">
                          Locked
                        </Chip>
                      ) : canLock ? (
                        <LockControls
                          versionId={scenario.id}
                          requiresReason={scenarios.some((s) => s.isOfficial)}
                        />
                      ) : null}
                    </div>
                  }
                />
                <DataTable>
                  <thead>
                    <tr>
                      <Th align="left">Division</Th>
                      <Th>Rev % of budget</Th>
                      <Th>COGS %</Th>
                      <Th>OpEx $</Th>
                      <Th>Revenue</Th>
                      <Th>Gross profit</Th>
                      <Th>Net profit</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.divisionCode}>
                        <Td align="left" numeric={false}>
                          {row.divisionCode}
                        </Td>
                        <Td muted>{formatNumber(row.assumptions.revenuePctOfBudget, 'percent')}</Td>
                        <Td muted>{formatNumber(row.assumptions.cogsPct, 'percent')}</Td>
                        <Td muted>{formatNumber(row.assumptions.opexAmt, 'currency')}</Td>
                        <Td>{formatNumber(row.projection.revenue.toNumber(), 'currency')}</Td>
                        <Td>{formatNumber(row.projection.grossProfit.toNumber(), 'currency')}</Td>
                        <Td>{formatNumber(row.projection.netProfit.toNumber(), 'currency')}</Td>
                      </tr>
                    ))}
                    <tr>
                      <Td align="left" numeric={false} style={{ fontWeight: 600 }}>
                        {focus === CONSOLIDATED_CODE ? 'ARG Total' : `${scopeLabel} total`}
                      </Td>
                      <Td muted>—</Td>
                      <Td muted>—</Td>
                      <Td muted>—</Td>
                      <Td style={{ fontWeight: 600 }}>{formatNumber(totals.revenue, 'currency')}</Td>
                      <Td style={{ fontWeight: 600 }}>{formatNumber(totals.grossProfit, 'currency')}</Td>
                      <Td style={{ fontWeight: 600 }}>{formatNumber(totals.netProfit, 'currency')}</Td>
                    </tr>
                  </tbody>
                </DataTable>
              </Card>
            );
          })}
        </div>
      )}

      <section id="outlook" className="scroll-mt-32">
        <Card>
          <CardHeader
            title={`Where ${period.fiscalYear} lands — ${scopeLabel}`}
            subtitle={outlook.budget.outlookSource}
          />
          <DataTable>
            <thead>
              <tr>
                <Th align="left">Line</Th>
                <Th>YTD actual</Th>
                <Th>YTD budget</Th>
                <Th>Full-year budget</Th>
                <Th title={outlook.budget.outlookSource}>Full-year outlook</Th>
                <Th title="Outlook − full-year budget">Outlook vs budget</Th>
              </tr>
            </thead>
            <tbody>
              {outlookRows.map((line) => {
                const gap =
                  line.fullYear.outlook !== null && line.fullYear.budget !== null
                    ? line.fullYear.outlook - line.fullYear.budget
                    : null;
                return (
                  <tr key={line.id}>
                    <Td align="left" numeric={false} style={{ fontWeight: line.isSubtotal ? 600 : 400 }}>
                      {line.label}
                    </Td>
                    <Td>{formatNumber(line.ytd.actual, 'currency')}</Td>
                    <Td muted>{formatNumber(line.ytd.budget, 'currency')}</Td>
                    <Td muted>{formatNumber(line.fullYear.budget, 'currency')}</Td>
                    <Td style={{ fontWeight: 600 }}>{formatNumber(line.fullYear.outlook, 'currency')}</Td>
                    <Td style={{ color: gap === null ? undefined : gap >= 0 ? 'var(--delta-good)' : 'var(--delta-bad)' }}>
                      {formatSignedNumber(gap, 'currency')}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
          <p className="mt-3 text-[11px] leading-relaxed text-[var(--text-muted)]">
            A QuickBooks budget named “Forecast”, or a Google Sheets tab called Forecast, replaces the
            budget for the months it covers — load the latest reforecast there and it flows into this
            outlook and the Finance page on the next pull.
          </p>
        </Card>
      </section>

      <p className="text-[11px] leading-relaxed text-[var(--text-muted)]">
        Locking writes an immutable, timestamped, attributed version with all five lines populated.
        A locked version can never be edited or deleted — a correction creates a new version and
        both stay visible with a reason on the record. Immutability is enforced by the database, not
        only by this interface.
      </p>
    </div>
  );
}

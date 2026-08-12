import type { Metadata } from 'next';
import Link from 'next/link';
import Decimal from 'decimal.js';
import { Lock, ShieldCheck, TriangleAlert } from 'lucide-react';
import { loadDashboardContext, type SearchParams } from '@/lib/dashboards/context';
import { buildDivisionColorMap } from '@/lib/charts/colors';
import { formatMonth } from '@/lib/semantic/periods';
import { formatNumber } from '@/lib/format';
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

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[19px] font-semibold tracking-tight">Forecast</h1>
          <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">
            {formatMonth(period.month)} · assumptions in, projected P&amp;L out
          </p>
        </div>
        <Link
          href={`/forecast/accuracy?month=${period.month.slice(0, 7)}&division=${context.divisionCode}`}
          className="text-[12px] underline-offset-2 hover:underline"
          style={{ color: 'var(--series-1)' }}
        >
          Forecast vs. actual →
        </Link>
      </header>

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
      <AssumptionGrid month={period.month} divisions={divisions} canLock={canLock} />

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
            const totals = scenario.rows.reduce(
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
                    {scenario.rows.map((row) => (
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
                        ARG Total
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

      <p className="text-[11px] leading-relaxed text-[var(--text-muted)]">
        Locking writes an immutable, timestamped, attributed version with all five lines populated.
        A locked version can never be edited or deleted — a correction creates a new version and
        both stay visible with a reason on the record. Immutability is enforced by the database, not
        only by this interface.
      </p>
    </div>
  );
}

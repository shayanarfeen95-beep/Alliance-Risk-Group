'use client';

/**
 * §10.1 — the assumption grid.
 *
 * "Show each division's forecast side by side with its budget, prior year same
 * month, and prior month — so the user can sanity-check an assumption as they
 * type it, not after they save."
 *
 * So the projection recalculates on every keystroke, locally. Nothing round-trips
 * to the server until the user chooses to save.
 *
 * §10 also warns this is "the deliverable ARG's team will touch most often, and
 * the one most likely to be judged on feel rather than correctness."
 */
import { useActionState, useMemo, useState } from 'react';
import { CircleAlert, CircleCheck, LoaderCircle, RotateCcw, Save } from 'lucide-react';
import { formatNumber, formatSignedNumber, sentimentColorVar, sentimentOf } from '@/lib/format';
import { saveScenarioAction, type ForecastActionState } from '@/app/(app)/forecast/actions';

export interface DivisionContext {
  divisionCode: string;
  divisionName: string;
  color: string;
  budgetedRevenue: number;
  priorMonth: { revenue: number | null; grossProfit: number | null; netProfit: number | null };
  priorYear: { revenue: number | null; grossProfit: number | null; netProfit: number | null };
  suggested: Assumptions;
}

export interface Assumptions {
  revenuePctOfBudget: number;
  payrollDirectPct: number;
  cogsPct: number;
  payrollExpenseAmt: number;
  opexAmt: number;
}

interface Projection {
  revenue: number;
  payrollDirect: number;
  cogs: number;
  grossProfit: number;
  payrollExpense: number;
  opex: number;
  netProfit: number;
}

/** Mirrors lib/forecast/engine.ts project(). Kept identical on purpose. */
function project(budgetedRevenue: number, a: Assumptions): Projection {
  const revenue = budgetedRevenue * a.revenuePctOfBudget;
  const cogs = revenue * a.cogsPct;
  const grossProfit = revenue - cogs;
  return {
    revenue,
    payrollDirect: revenue * a.payrollDirectPct,
    cogs,
    grossProfit,
    payrollExpense: a.payrollExpenseAmt,
    opex: a.opexAmt,
    netProfit: grossProfit - a.opexAmt,
  };
}

export function AssumptionGrid({
  month,
  divisions,
  canLock,
}: {
  month: string;
  divisions: DivisionContext[];
  canLock: boolean;
}) {
  const [assumptions, setAssumptions] = useState<Record<string, Assumptions>>(() =>
    Object.fromEntries(divisions.map((d) => [d.divisionCode, { ...d.suggested }])),
  );
  const [scenarioName, setScenarioName] = useState('Base');
  const [state, formAction, pending] = useActionState<ForecastActionState, FormData>(
    saveScenarioAction,
    {},
  );

  const projections = useMemo(
    () =>
      Object.fromEntries(
        divisions.map((d) => [
          d.divisionCode,
          project(d.budgetedRevenue, assumptions[d.divisionCode]!),
        ]),
      ),
    [assumptions, divisions],
  );

  // ARG Total is the sum of the four, never an independently entered figure.
  const total = useMemo<Projection>(() => {
    return divisions.reduce<Projection>(
      (sum, d) => {
        const p = projections[d.divisionCode]!;
        return {
          revenue: sum.revenue + p.revenue,
          payrollDirect: sum.payrollDirect + p.payrollDirect,
          cogs: sum.cogs + p.cogs,
          grossProfit: sum.grossProfit + p.grossProfit,
          payrollExpense: sum.payrollExpense + p.payrollExpense,
          opex: sum.opex + p.opex,
          netProfit: sum.netProfit + p.netProfit,
        };
      },
      { revenue: 0, payrollDirect: 0, cogs: 0, grossProfit: 0, payrollExpense: 0, opex: 0, netProfit: 0 },
    );
  }, [divisions, projections]);

  function set(divisionCode: string, field: keyof Assumptions, value: number) {
    setAssumptions((current) => ({
      ...current,
      [divisionCode]: { ...current[divisionCode]!, [field]: value },
    }));
  }

  function reset() {
    setAssumptions(Object.fromEntries(divisions.map((d) => [d.divisionCode, { ...d.suggested }])));
  }

  return (
    <div className="space-y-4">
      {divisions.map((division) => {
        const a = assumptions[division.divisionCode]!;
        const p = projections[division.divisionCode]!;

        return (
          <section
            key={division.divisionCode}
            className="rounded-[var(--radius-lg)] border p-4"
            style={{
              background: 'var(--surface-1)',
              borderColor: 'var(--border)',
              boxShadow: 'var(--shadow-card)',
            }}
          >
            <div className="mb-3 flex items-center gap-2">
              <span
                aria-hidden
                className="h-2.5 w-2.5 rounded-[2px]"
                style={{ background: division.color }}
              />
              <h3 className="text-[13px] font-semibold tracking-tight">{division.divisionName}</h3>
              <span className="text-[11px] text-[var(--text-muted)]">
                budgeted revenue {formatNumber(division.budgetedRevenue, 'currency')}
              </span>
            </div>

            <div className="grid gap-4 lg:grid-cols-[minmax(0,340px)_1fr]">
              {/* The five inputs. */}
              <div className="space-y-2.5">
                <PercentInput
                  label="Revenue % of budget"
                  value={a.revenuePctOfBudget}
                  onChange={(v) => set(division.divisionCode, 'revenuePctOfBudget', v)}
                />
                <PercentInput
                  label="COGS %"
                  hint="of forecast revenue"
                  value={a.cogsPct}
                  onChange={(v) => set(division.divisionCode, 'cogsPct', v)}
                />
                <PercentInput
                  label="Payroll — Direct %"
                  hint="memo line, of forecast revenue"
                  value={a.payrollDirectPct}
                  onChange={(v) => set(division.divisionCode, 'payrollDirectPct', v)}
                />
                <DollarInput
                  label="OpEx $"
                  value={a.opexAmt}
                  onChange={(v) => set(division.divisionCode, 'opexAmt', v)}
                />
                <DollarInput
                  label="Payroll Expense $"
                  hint="memo line"
                  value={a.payrollExpenseAmt}
                  onChange={(v) => set(division.divisionCode, 'payrollExpenseAmt', v)}
                />
              </div>

              {/* The projection, side by side with budget, PM and PY. */}
              <div className="scroll-x">
                <table className="w-full min-w-max border-collapse text-[12px]">
                  <thead>
                    <tr>
                      <th className="border-b px-2 py-1.5 text-left text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--text-muted)]" style={{ borderColor: 'var(--border)' }}>
                        Line
                      </th>
                      <th className="border-b px-2 py-1.5 text-right text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--text-muted)]" style={{ borderColor: 'var(--border)' }}>
                        Forecast
                      </th>
                      <th className="border-b px-2 py-1.5 text-right text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--text-muted)]" style={{ borderColor: 'var(--border)' }}>
                        Prior month
                      </th>
                      <th className="border-b px-2 py-1.5 text-right text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--text-muted)]" style={{ borderColor: 'var(--border)' }}>
                        Prior year
                      </th>
                      <th className="border-b px-2 py-1.5 text-right text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--text-muted)]" style={{ borderColor: 'var(--border)' }}>
                        vs PM
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <ProjectionRow label="Revenue" forecast={p.revenue} pm={division.priorMonth.revenue} py={division.priorYear.revenue} higherIsBetter />
                    <ProjectionRow label="Payroll — Direct" forecast={p.payrollDirect} pm={null} py={null} memo higherIsBetter={false} />
                    <ProjectionRow label="COGS" forecast={p.cogs} pm={null} py={null} higherIsBetter={false} />
                    <ProjectionRow label="Gross Profit" forecast={p.grossProfit} pm={division.priorMonth.grossProfit} py={division.priorYear.grossProfit} subtotal higherIsBetter />
                    <ProjectionRow label="Payroll Expense" forecast={p.payrollExpense} pm={null} py={null} memo higherIsBetter={false} />
                    <ProjectionRow label="OpEx" forecast={p.opex} pm={null} py={null} higherIsBetter={false} />
                    <ProjectionRow label="Net Profit" forecast={p.netProfit} pm={division.priorMonth.netProfit} py={division.priorYear.netProfit} subtotal higherIsBetter />
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        );
      })}

      {/* ARG Total — computed, never entered. */}
      <section
        className="rounded-[var(--radius-lg)] border p-4"
        style={{ background: 'var(--surface-2)', borderColor: 'var(--border-strong)' }}
      >
        <h3 className="mb-3 text-[13px] font-semibold tracking-tight">
          ARG Total
          <span className="ml-2 text-[11px] font-normal text-[var(--text-muted)]">
            the sum of the four divisions — never entered directly
          </span>
        </h3>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
          <Figure label="Revenue" value={total.revenue} />
          <Figure label="COGS" value={total.cogs} />
          <Figure label="Gross Profit" value={total.grossProfit} />
          <Figure label="Net Profit" value={total.netProfit} />
        </dl>
      </section>

      {/* Save */}
      <form action={formAction} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="month" value={month} />
        <input type="hidden" name="assumptions" value={JSON.stringify(assumptions)} />
        <input
          type="hidden"
          name="budgets"
          value={JSON.stringify(
            Object.fromEntries(divisions.map((d) => [d.divisionCode, String(d.budgetedRevenue)])),
          )}
        />
        <input
          name="scenarioName"
          value={scenarioName}
          onChange={(event) => setScenarioName(event.target.value)}
          placeholder="Scenario name"
          className="h-8 rounded-[var(--radius)] border px-2.5 text-[12px] outline-none"
          style={{ background: 'var(--surface-1)', borderColor: 'var(--border-strong)' }}
        />
        <button
          type="submit"
          disabled={pending}
          className="flex h-8 items-center gap-1.5 rounded-[var(--radius)] px-3 text-[12px] font-medium disabled:opacity-50"
          style={{ background: 'var(--text-primary)', color: 'var(--text-inverse)' }}
        >
          {pending ? <LoaderCircle size={13} className="animate-spin" aria-hidden /> : <Save size={13} aria-hidden />}
          Save scenario
        </button>
        <button
          type="button"
          onClick={reset}
          className="flex h-8 items-center gap-1.5 rounded-[var(--radius)] border px-3 text-[12px]"
          style={{ borderColor: 'var(--border-strong)', color: 'var(--text-secondary)' }}
        >
          <RotateCcw size={13} aria-hidden />
          Reset to suggested
        </button>

        {state.error ? (
          <span className="flex items-center gap-1.5 text-[11.5px]" style={{ color: 'var(--delta-bad)' }}>
            <CircleAlert size={13} aria-hidden />
            {state.error}
          </span>
        ) : null}
        {state.ok ? (
          <span className="flex items-center gap-1.5 text-[11.5px]" style={{ color: 'var(--delta-good)' }}>
            <CircleCheck size={13} aria-hidden />
            {state.message}
          </span>
        ) : null}
      </form>

      {!canLock ? (
        <p className="text-[11px] text-[var(--text-muted)]">
          You can build and save scenarios. Locking a forecast — which writes the immutable record
          ARG is held to — requires the CFO or an administrator.
        </p>
      ) : null}
    </div>
  );
}

function PercentInput({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3">
      <span className="text-[11.5px] text-[var(--text-secondary)]">
        {label}
        {hint ? <span className="ml-1 text-[var(--text-muted)]">({hint})</span> : null}
      </span>
      <span className="flex items-center gap-1">
        <input
          type="number"
          step="0.1"
          value={Number((value * 100).toFixed(2))}
          onChange={(event) => onChange(Number(event.target.value) / 100)}
          className="tnum h-7 w-20 rounded-[var(--radius-sm)] border px-2 text-right text-[12px] outline-none"
          style={{ background: 'var(--surface-1)', borderColor: 'var(--border-strong)' }}
        />
        <span className="text-[11px] text-[var(--text-muted)]">%</span>
      </span>
    </label>
  );
}

function DollarInput({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3">
      <span className="text-[11.5px] text-[var(--text-secondary)]">
        {label}
        {hint ? <span className="ml-1 text-[var(--text-muted)]">({hint})</span> : null}
      </span>
      <span className="flex items-center gap-1">
        <span className="text-[11px] text-[var(--text-muted)]">$</span>
        <input
          type="number"
          step="100"
          value={Number(value.toFixed(2))}
          onChange={(event) => onChange(Number(event.target.value))}
          className="tnum h-7 w-28 rounded-[var(--radius-sm)] border px-2 text-right text-[12px] outline-none"
          style={{ background: 'var(--surface-1)', borderColor: 'var(--border-strong)' }}
        />
      </span>
    </label>
  );
}

function ProjectionRow({
  label,
  forecast,
  pm,
  py,
  memo,
  subtotal,
  higherIsBetter,
}: {
  label: string;
  forecast: number;
  pm: number | null;
  py: number | null;
  memo?: boolean;
  subtotal?: boolean;
  higherIsBetter: boolean;
}) {
  const delta = pm === null ? null : forecast - pm;
  return (
    <tr>
      <td
        className="border-b px-2 py-1.5"
        style={{
          borderColor: 'var(--border)',
          color: memo ? 'var(--text-muted)' : 'var(--text-primary)',
          fontWeight: subtotal ? 600 : 400,
          paddingLeft: memo ? 18 : undefined,
        }}
      >
        {label}
        {memo ? <span className="ml-1.5 text-[9.5px] uppercase">memo</span> : null}
      </td>
      <td
        className="tnum border-b px-2 py-1.5 text-right"
        style={{ borderColor: 'var(--border)', fontWeight: subtotal ? 600 : 400 }}
      >
        {formatNumber(forecast, 'currency')}
      </td>
      <td className="tnum border-b px-2 py-1.5 text-right text-[var(--text-muted)]" style={{ borderColor: 'var(--border)' }}>
        {formatNumber(pm, 'currency')}
      </td>
      <td className="tnum border-b px-2 py-1.5 text-right text-[var(--text-muted)]" style={{ borderColor: 'var(--border)' }}>
        {formatNumber(py, 'currency')}
      </td>
      <td
        className="tnum border-b px-2 py-1.5 text-right"
        style={{ borderColor: 'var(--border)', color: sentimentColorVar(sentimentOf(delta, higherIsBetter)) }}
      >
        {formatSignedNumber(delta, 'currency')}
      </td>
    </tr>
  );
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-[11px] text-[var(--text-muted)]">{label}</dt>
      <dd className="tnum text-[15px] font-semibold">{formatNumber(value, 'currency')}</dd>
    </div>
  );
}

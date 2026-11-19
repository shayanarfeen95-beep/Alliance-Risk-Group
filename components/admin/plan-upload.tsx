'use client';

/**
 * Upload a budget or a forecast — the 2027 budget, until the SharePoint file is
 * connected. Excel or CSV, in the template's layout or the Sheets budget's.
 */
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { Download, Upload } from 'lucide-react';
import { Card, CardHeader } from '@/components/ui/primitives';
import { uploadPlanAction } from '@/app/(app)/admin/budget-actions';

export interface LoadedPlan {
  code: string;
  name: string;
  description: string | null;
  firstMonth: string;
  lastMonth: string;
}

export function PlanUpload({ plans, canEdit, nextYear }: { plans: LoadedPlan[]; canEdit: boolean; nextYear: number }) {
  const [state, action] = useActionState(uploadPlanAction, null);
  return (
    <Card>
      <CardHeader
        title="Budget and forecast upload"
        subtitle="Load the annual budget or a reforecast from Excel or CSV; Finance, Executive and the KPI tiles check actuals against it"
      />
      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <form action={action} className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-3 text-[12px]">
            <label className="inline-flex items-center gap-1.5">
              <input type="radio" name="kind" value="budget" defaultChecked /> Budget
            </label>
            <label className="inline-flex items-center gap-1.5">
              <input type="radio" name="kind" value="forecast" /> Forecast (reforecast for the rest of the year)
            </label>
          </div>
          <input
            type="file"
            name="file"
            accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
            disabled={!canEdit}
            className="text-[12px] file:mr-3 file:rounded-[6px] file:border file:px-2.5 file:py-1 file:text-[12px]"
          />
          <Submit disabled={!canEdit} />
          {!canEdit ? (
            <p className="text-[11px] text-[var(--text-muted)]">Only an administrator or the CFO can upload a plan.</p>
          ) : null}
          {state?.error ? (
            <p className="text-[11.5px]" style={{ color: 'var(--status-critical)' }}>{state.error}</p>
          ) : null}
          {state?.ok ? (
            <p className="text-[11.5px]" style={{ color: 'var(--status-good)' }}>{state.ok}</p>
          ) : null}
        </form>

        <div className="space-y-2 text-[11.5px] leading-relaxed text-[var(--text-secondary)]">
          <p>
            <strong>Layout.</strong> One row per division per month with Year, Month, Division, Revenue, COGS and OpEx
            columns — or the layout of the Google Sheets budget. Division is the QuickBooks division code or name.
            Uploading a revised file replaces the months it covers.
          </p>
          <a
            href={`/api/budget-template?year=${nextYear}`}
            className="inline-flex items-center gap-1.5 rounded-[6px] border px-2.5 py-1 text-[11.5px] font-medium"
            style={{ borderColor: 'var(--border)' }}
          >
            <Download size={12} aria-hidden /> Download the {nextYear} template
          </a>
          <p>
            <strong>Check-ins.</strong> An uploaded budget becomes the budget for its year: the Finance budget columns,
            attainment, variance and the full-year outlook read it as soon as months of that year have actuals.
          </p>
        </div>
      </div>

      <div className="mt-4">
        <p className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--text-muted)]">Loaded plans</p>
        {plans.length === 0 ? (
          <p className="text-[12px] text-[var(--text-muted)]">None yet.</p>
        ) : (
          <ul className="space-y-1 text-[12px]">
            {plans.map((plan) => (
              <li key={plan.code}>
                <span className="font-medium">{plan.name}</span> · {plan.firstMonth.slice(0, 7)} to {plan.lastMonth.slice(0, 7)}
                {plan.description ? <span className="text-[var(--text-muted)]"> · {plan.description}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function Submit({ disabled }: { disabled?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      className="inline-flex w-fit items-center gap-1.5 rounded-[6px] px-3 py-1.5 text-[12px] font-semibold disabled:opacity-40"
      style={{ background: 'var(--text-primary)', color: 'var(--text-inverse)' }}
    >
      <Upload size={13} aria-hidden /> {pending ? 'Loading…' : 'Upload'}
    </button>
  );
}

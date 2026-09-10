'use client';

/**
 * Building a view without writing code.
 *
 * The dashboards answer the questions the build anticipated. This is for the
 * ones it did not — and the design constraint is that somebody who is not a
 * developer has to be able to reach an answer without being able to construct an
 * invalid one. So every input is a choice from what the data actually contains:
 * the owner list is the owners on real deals, the sources are the sources really
 * recorded. There is no free-text field that can silently match nothing.
 */
import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { CircleAlert, Plus, X } from 'lucide-react';
import { createViewAction } from '@/app/(app)/views/actions';

export interface ViewBuilderProps {
  month: string;
  /** The values present in the data, each with how many deals carry it. */
  fields: {
    stages: Array<{ value: string; deals: number }>;
    owners: Array<{ value: string; deals: number }>;
    sources: Array<{ value: string; deals: number }>;
  };
  kpis: Array<{ id: string; name: string }>;
}

export function ViewBuilder(props: ViewBuilderProps) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<'pipeline' | 'metric'>('pipeline');
  const [state, action] = useActionState(createViewAction, null);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-[5px] px-3 py-1.5 text-[11.5px] font-medium"
        style={{ background: 'var(--text-primary)', color: 'var(--text-inverse)' }}
      >
        <Plus size={12} aria-hidden />
        Build a view
      </button>
    );
  }

  return (
    <form
      action={action}
      className="w-full rounded-[var(--radius)] border p-4"
      style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[13px] font-semibold">Build a view</p>
          <p className="mt-0.5 text-[11.5px] text-[var(--text-muted)]">
            Saved as a specification, not a snapshot — it re-reads the warehouse every time it is
            opened, so it can never show a figure the dashboards have since restated.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-[5px] border p-1"
          style={{ borderColor: 'var(--border)' }}
          aria-label="Close"
        >
          <X size={12} aria-hidden />
        </button>
      </div>

      <input type="hidden" name="month" value={props.month} />
      <input type="hidden" name="kind" value={kind} />

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <input
            name="name"
            required
            maxLength={120}
            placeholder="Closed-won by lead source"
            className="h-8 w-full rounded-[5px] border px-2 text-[12px] outline-none"
            style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}
          />
        </Field>
        <Field label="Description" hint="Why it exists. Optional.">
          <input
            name="description"
            maxLength={200}
            className="h-8 w-full rounded-[5px] border px-2 text-[12px] outline-none"
            style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}
          />
        </Field>
      </div>

      <div className="mt-4 flex gap-1.5">
        {(['pipeline', 'metric'] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setKind(option)}
            className="rounded-[5px] border px-2.5 py-1 text-[11.5px] font-medium"
            style={{
              borderColor: kind === option ? 'var(--text-primary)' : 'var(--border)',
              background: kind === option ? 'var(--surface-2)' : 'transparent',
            }}
          >
            {option === 'pipeline' ? 'Deals and pipeline' : 'A defined metric'}
          </button>
        ))}
      </div>

      {kind === 'pipeline' ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <Field label="Group by" hint="What the bars are">
            <Select name="groupBy" options={['stage', 'owner', 'source', 'pipeline', 'month']} />
          </Field>
          <Field label="Measure">
            <Select name="measure" options={['amount', 'count']} labels={{ amount: 'Deal value', count: 'Number of deals' }} />
          </Field>
          <Field label="Chart">
            <Select
              name="form"
              options={['horizontalBar', 'bar', 'line']}
              labels={{ horizontalBar: 'Horizontal bars', bar: 'Vertical bars', line: 'Line' }}
            />
          </Field>
          <Field label="Deal status">
            <Select
              name="status"
              options={['all', 'open', 'won', 'lost', 'closed']}
              labels={{ all: 'All deals', open: 'Open only', won: 'Closed-won', lost: 'Closed-lost', closed: 'All closed' }}
            />
          </Field>
          <Field label="Date counted on">
            <Select
              name="dateField"
              options={['closedate', 'createdate']}
              labels={{ closedate: 'Close date', createdate: 'Create date' }}
            />
          </Field>
          <Field label="Months back">
            <Select name="trailingMonths" options={['3', '6', '12', '24']} defaultValue="12" />
          </Field>

          <MultiSelect label="Owners" name="owners" values={props.fields.owners} />
          <MultiSelect label="Lead sources" name="sources" values={props.fields.sources} />
          <MultiSelect label="Stages" name="stages" values={props.fields.stages} />
        </div>
      ) : (
        <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <Field label="Metrics" hint="Pick up to four measured in the same unit">
            <select
              name="kpis"
              multiple
              size={6}
              required
              className="w-full rounded-[5px] border px-2 py-1 text-[11.5px] outline-none"
              style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}
            >
              {props.kpis.map((kpi) => (
                <option key={kpi.id} value={kpi.id}>
                  {kpi.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Across">
            <Select name="dimension" options={['month', 'division']} />
          </Field>
          <Field label="Chart">
            <Select name="metricForm" options={['line', 'bar', 'stackedBar', 'area']} defaultValue="line" />
          </Field>
          <Field label="Months back">
            <Select name="trailingMonths" options={['3', '6', '12', '24']} defaultValue="12" />
          </Field>
        </div>
      )}

      {state?.error && (
        <p
          className="mt-3 flex items-start gap-2 text-[11.5px] leading-relaxed"
          style={{ color: 'var(--status-critical)' }}
        >
          <CircleAlert size={13} className="mt-px shrink-0" aria-hidden />
          {state.error}
        </p>
      )}

      <div className="mt-4 flex items-center gap-2">
        <Submit />
        <p className="text-[10.5px] text-[var(--text-muted)]">
          The view is rendered once before it is saved — if it cannot resolve, it is refused here
          rather than appearing broken later.
        </p>
      </div>
    </form>
  );
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-[5px] px-3 py-1.5 text-[11.5px] font-medium disabled:opacity-50"
      style={{ background: 'var(--text-primary)', color: 'var(--text-inverse)' }}
    >
      {pending ? 'Saving…' : 'Save view'}
    </button>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-[11px] font-medium text-[var(--text-secondary)]">{label}</span>
      {hint && <span className="ml-1.5 text-[10.5px] text-[var(--text-muted)]">{hint}</span>}
      <div className="mt-1">{children}</div>
    </label>
  );
}

function Select({
  name,
  options,
  labels,
  defaultValue,
}: {
  name: string;
  options: string[];
  labels?: Record<string, string>;
  defaultValue?: string;
}) {
  return (
    <select
      name={name}
      defaultValue={defaultValue}
      className="h-8 w-full rounded-[5px] border px-2 text-[12px] outline-none"
      style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}
    >
      {options.map((option) => (
        <option key={option} value={option}>
          {labels?.[option] ?? option}
        </option>
      ))}
    </select>
  );
}

/**
 * Filter values, taken from the data.
 *
 * Each option carries how many deals hold it, because "Not recorded · 132" is
 * the difference between a filter somebody picks deliberately and one they pick
 * by accident and then read as zero.
 */
function MultiSelect({
  label,
  name,
  values,
}: {
  label: string;
  name: string;
  values: Array<{ value: string; deals: number }>;
}) {
  if (values.length === 0) return null;

  return (
    <Field label={label} hint="None selected means all">
      <select
        name={name}
        multiple
        size={5}
        className="w-full rounded-[5px] border px-2 py-1 text-[11.5px] outline-none"
        style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}
      >
        {values.map((entry) => (
          <option key={entry.value} value={entry.value}>
            {entry.value} · {entry.deals}
          </option>
        ))}
      </select>
    </Field>
  );
}

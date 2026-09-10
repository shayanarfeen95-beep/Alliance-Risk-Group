/**
 * What each QuickBooks class means.
 *
 * This panel exists because the alternative was a warehouse that never loaded.
 * Conform refuses a month containing a class it cannot place — rightly, since
 * putting it on the wrong division moves revenue between two P&Ls with nothing
 * on screen saying so — but until now there was nowhere to say what a class was,
 * so "refuses" meant "nothing ever loads".
 *
 * The third option is the one that matters. Not every class is a division: an
 * allocation bucket, an unclassified catch-all, a class kept for something other
 * than divisional reporting. Saying so out loud lets the month load and puts the
 * consequence on the record, rather than leaving somebody to guess a division
 * for a bucket that has none.
 */
'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { CircleAlert, CircleCheck, MinusCircle } from 'lucide-react';
import { Card, CardHeader, DataTable, Td, Th } from '@/components/ui/primitives';
import { decideClassAction } from '@/app/(app)/admin/class-actions';
import type { ClassMapRow } from '@/lib/etl/class-map';

export function ClassMapping({
  rows,
  divisions,
  canEdit,
}: {
  rows: ClassMapRow[];
  divisions: Array<{ divisionCode: string; divisionName: string }>;
  canEdit: boolean;
}) {
  if (rows.length === 0) return null;

  const unmapped = rows.filter((row) => row.decision === 'UNMAPPED');

  return (
    <Card>
      <CardHeader
        title="Class mapping"
        subtitle="Which division each QuickBooks class belongs to — or that it belongs to none"
      />

      {unmapped.length > 0 && (
        <p
          className="mb-3 flex items-start gap-2 text-[11.5px] leading-relaxed"
          style={{ color: 'var(--status-warning)' }}
        >
          <CircleAlert size={13} className="mt-px shrink-0" aria-hidden />
          {unmapped.length} class{unmapped.length === 1 ? '' : 'es'} {unmapped.length === 1 ? 'has' : 'have'}{' '}
          no decision, and every month containing {unmapped.length === 1 ? 'it' : 'them'} is refused
          rather than loaded against a guess. Decide {unmapped.length === 1 ? 'it' : 'them'} below,
          then pull QuickBooks again.
        </p>
      )}

      <DataTable>
        <thead>
          <tr>
            <Th align="left">Class</Th>
            <Th align="left">Belongs to</Th>
            <Th align="left">State</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.classKey}>
              <Td align="left" numeric={false}>
                {row.className}
                {row.classId && (
                  <span className="ml-1.5 text-[10px] text-[var(--text-muted)]">{row.classId}</span>
                )}
                {row.blockingMonths.length > 0 && (
                  <span
                    className="mt-0.5 block text-[10px]"
                    style={{ color: 'var(--status-warning)' }}
                  >
                    Blocking {row.blockingMonths.join(', ')}
                  </span>
                )}
              </Td>
              <Td align="left" numeric={false}>
                {canEdit ? (
                  <ClassDecisionForm row={row} divisions={divisions} />
                ) : (
                  <span className="text-[11.5px]">
                    {row.decision === 'EXCLUDED' ? 'Not a division' : (row.divisionCode ?? '—')}
                  </span>
                )}
              </Td>
              <Td align="left" numeric={false}>
                <State decision={row.decision} />
              </Td>
            </tr>
          ))}
        </tbody>
      </DataTable>

      <p className="mt-3 text-[10.5px] leading-relaxed text-[var(--text-muted)]">
        A class marked <strong>not a division</strong> is left out of every divisional figure and
        out of ARG Total — which is what an allocation or unclassified bucket should do, and is why
        it is a decision somebody makes rather than a default. Every change here is recorded against
        the person who made it, because it changes what the divisional P&amp;Ls say.
      </p>
    </Card>
  );
}


/**
 * One class, one decision, and the outcome said in place.
 *
 * Per row rather than one form for the table: a mapping that is rejected has to
 * say so beside the class it was rejected for. A single shared message would
 * leave the operator matching an error to a row by memory.
 */
function ClassDecisionForm({
  row,
  divisions,
}: {
  row: ClassMapRow;
  divisions: Array<{ divisionCode: string; divisionName: string }>;
}) {
  const [state, action] = useActionState(decideClassAction, null);

  return (
    <form action={action} className="space-y-1">
      <div className="flex items-center gap-1.5">
        <input type="hidden" name="classKey" value={row.classKey} />
        <select
          name="divisionCode"
          defaultValue={row.decision === 'EXCLUDED' ? '__excluded__' : (row.divisionCode ?? '')}
          className="h-7 rounded-[5px] border px-1.5 text-[11px] outline-none"
          style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}
        >
          <option value="">Undecided</option>
          {divisions.map((division) => (
            <option key={division.divisionCode} value={division.divisionCode}>
              {division.divisionName}
            </option>
          ))}
          <option value="__excluded__">Not a division — leave it out</option>
        </select>
        <SaveButton />
      </div>

      {state?.error && (
        <p className="text-[10px] leading-snug" style={{ color: 'var(--status-critical)' }}>
          {state.error}
        </p>
      )}
      {state?.ok && (
        <p className="text-[10px]" style={{ color: 'var(--status-good)' }}>
          {state.ok}
        </p>
      )}
    </form>
  );
}

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-[5px] border px-2 py-0.5 text-[10.5px] font-medium disabled:opacity-50"
      style={{ borderColor: 'var(--border)' }}
    >
      {pending ? 'Saving…' : 'Save'}
    </button>
  );
}

function State({ decision }: { decision: ClassMapRow['decision'] }) {
  if (decision === 'MAPPED') {
    return (
      <span className="flex items-center gap-1 text-[11px]">
        <CircleCheck size={11} style={{ color: 'var(--status-good)' }} aria-hidden />
        Mapped
      </span>
    );
  }
  if (decision === 'EXCLUDED') {
    return (
      <span className="flex items-center gap-1 text-[11px] text-[var(--text-muted)]">
        <MinusCircle size={11} aria-hidden />
        Excluded
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-[11px]" style={{ color: 'var(--status-warning)' }}>
      <CircleAlert size={11} aria-hidden />
      Undecided
    </span>
  );
}

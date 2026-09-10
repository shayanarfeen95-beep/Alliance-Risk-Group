'use client';

/**
 * What is in the warehouse, and why anything missing is missing.
 *
 * "Nothing on the dashboard works" was never one fault. It was three, and no
 * screen could tell them apart: nothing was fetched, something was fetched and
 * refused, or it loaded into months the view is not on. All three look like an
 * empty dashboard. This panel names which one, per entity, so the next action is
 * obvious instead of being a guess.
 */
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { CircleAlert, CircleCheck, CircleSlash, Clock, Database, Loader2 } from 'lucide-react';
import { Card, CardHeader, DataTable, Td, Th } from '@/components/ui/primitives';
import { reclaimStorageAction } from '@/app/(app)/admin/class-actions';
import type { DataHealth, EntityHealth, HealthState } from '@/lib/etl/health';

export function DataHealthPanel({ health, canManage }: { health: DataHealth; canManage: boolean }) {
  // Counted on rows present, not on connection state: an entity holding two
  // thousand rows "has data" whether or not its source is signed in right now,
  // and a summary saying otherwise contradicts the table under it.
  const withData = health.entities.filter((entity) => entity.rows > 0);
  const blocked = health.entities.filter((entity) => entity.state === 'BLOCKED');
  const disconnected = health.entities.filter((entity) => entity.state === 'NOT_CONNECTED');

  return (
    <Card>
      <CardHeader
        title="Data health"
        subtitle="Every entity, what it has loaded, and what is stopping the rest"
      />

      <div className="mb-3 flex flex-wrap gap-4 text-[11.5px]">
        <span className="text-[var(--text-secondary)]">
          <strong>{withData.length}</strong> of {health.entities.length} entities hold data
        </span>
        <span className="text-[var(--text-secondary)]">
          <strong>{health.monthsWithData.length}</strong> month
          {health.monthsWithData.length === 1 ? '' : 's'} carry figures
          {health.monthsWithData.length > 0 && (
            <span className="text-[var(--text-muted)]">
              {' '}
              · newest {health.monthsWithData[0]?.slice(0, 7)}
            </span>
          )}
        </span>
        {blocked.length > 0 && (
          <span style={{ color: 'var(--status-critical)' }}>
            <strong>{blocked.length}</strong> blocked
          </span>
        )}
        {disconnected.length > 0 && (
          <span className="text-[var(--text-muted)]">
            <strong>{disconnected.length}</strong> waiting on a sign-in
          </span>
        )}
      </div>

      {health.unmappedClasses.length > 0 && (
        <p
          className="mb-3 flex items-start gap-2 text-[11.5px] leading-relaxed"
          style={{ color: 'var(--status-warning)' }}
        >
          <CircleAlert size={13} className="mt-px shrink-0" aria-hidden />
          QuickBooks months are being refused because these classes have no decision:{' '}
          <strong>{health.unmappedClasses.join(', ')}</strong>. Decide them in Class mapping below,
          then pull again.
        </p>
      )}

      <DataTable>
        <thead>
          <tr>
            <Th align="left">Entity</Th>
            <Th>Rows</Th>
            <Th align="left">Last synced</Th>
            <Th align="left">State</Th>
          </tr>
        </thead>
        <tbody>
          {health.entities.map((entity) => (
            <tr key={`${entity.source}:${entity.entity}`}>
              <Td align="left" numeric={false}>
                <span className="text-[var(--text-secondary)]">{entity.sourceLabel}</span>{' '}
                {entity.entityLabel}
                <span className="mt-0.5 block text-[10px] leading-snug text-[var(--text-muted)]">
                  {entity.detail}
                </span>
              </Td>
              <Td>{entity.rows === 0 ? '—' : entity.rows.toLocaleString()}</Td>
              <Td align="left" numeric={false}>
                <span className="text-[11px] text-[var(--text-muted)]">
                  {entity.lastSyncedAt
                    ? entity.lastSyncedAt.toISOString().slice(0, 16).replace('T', ' ')
                    : 'never'}
                </span>
              </Td>
              <Td align="left" numeric={false}>
                <StateChip state={entity.state} />
              </Td>
            </tr>
          ))}
        </tbody>
      </DataTable>

      {/* --- Storage ------------------------------------------------------- */}
      <div className="mt-4 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
        <p className="flex items-center gap-1.5 text-[11.5px] font-medium">
          <Database size={12} aria-hidden />
          {health.storedPayloads.toLocaleString()} stored source payloads
        </p>
        <p className="mt-1 max-w-2xl text-[10.5px] leading-relaxed text-[var(--text-muted)]">
          Pulls no longer keep a copy of every record — only the owner list, which the salesperson
          lookup reads. Everything else went straight to storage and was never read again, which is
          what filled the database when a large import ran twice.
        </p>
        {canManage && <ReclaimButton />}
      </div>
    </Card>
  );
}

function ReclaimButton() {
  const [state, action] = useActionState(reclaimStorageAction, null);

  return (
    <form action={action} className="mt-2">
      <Submit />
      {state?.error && (
        <p className="mt-1 text-[10.5px]" style={{ color: 'var(--status-critical)' }}>
          {state.error}
        </p>
      )}
      {state?.ok && (
        <p className="mt-1 text-[10.5px]" style={{ color: 'var(--status-good)' }}>
          {state.ok}
        </p>
      )}
    </form>
  );
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="flex items-center gap-1.5 rounded-[5px] border px-2.5 py-1 text-[11px] font-medium disabled:opacity-50"
      style={{ borderColor: 'var(--border)' }}
    >
      {pending && <Loader2 size={11} className="animate-spin" aria-hidden />}
      {pending ? 'Reclaiming…' : 'Reclaim unread storage'}
    </button>
  );
}

function StateChip({ state }: { state: HealthState }) {
  const spec: Record<HealthState, { label: string; color: string; Icon: typeof CircleCheck }> = {
    LOADED: { label: 'Loaded', color: 'var(--status-good)', Icon: CircleCheck },
    BLOCKED: { label: 'Blocked', color: 'var(--status-critical)', Icon: CircleAlert },
    NEVER_PULLED: { label: 'Never pulled', color: 'var(--text-muted)', Icon: Clock },
    NOT_CONNECTED: { label: 'Not connected', color: 'var(--text-muted)', Icon: CircleSlash },
    EMPTY: { label: 'Nothing yet', color: 'var(--status-warning)', Icon: CircleAlert },
  };
  const { label, color, Icon } = spec[state];

  return (
    <span className="flex items-center gap-1 text-[11px]" style={{ color }}>
      <Icon size={11} aria-hidden />
      {label}
    </span>
  );
}

export type { EntityHealth };

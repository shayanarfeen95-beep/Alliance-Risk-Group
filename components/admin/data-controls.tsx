'use client';

/**
 * Pulling data, and deciding whose data it is.
 *
 * These two controls sit together because they are the two halves of the same
 * question — "am I looking at ARG's numbers yet?" — and separating them is how
 * somebody ends up on a live-labelled dashboard with nothing loaded, or on a
 * fully loaded dashboard still reading the seed.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  CircleAlert,
  CircleCheck,
  Database,
  Loader2,
  RefreshCw,
} from 'lucide-react';

interface SyncOutcome {
  source: string;
  entity: string;
  ok: boolean;
  rowsWritten: number;
  notes?: string[];
  error?: string;
}

interface SyncResponse {
  ok: boolean;
  error?: string;
  window?: string;
  rowsWritten?: number;
  outcomes?: SyncOutcome[];
  failedCount?: number;
  reconciliation?: string;
}

export interface DataControlsProps {
  connectedSources: Array<{ source: string; label: string; connected: boolean; entities: number }>;
  loadedRowCount: number;
  canManage: boolean;
}

export function DataControls(props: DataControlsProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | 'sync'>(null);
  const [result, setResult] = useState<SyncResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const connected = props.connectedSources.filter((source) => source.connected);

  async function sync(sources?: string[]) {
    setBusy('sync');
    setError(null);
    setResult(null);
    try {
      const response = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sources, months: 3 }),
      });
      const payload = (await response.json()) as SyncResponse;
      if (!payload.ok) setError(payload.error ?? 'The sync did not complete.');
      else {
        setResult(payload);
        router.refresh();
      }
    } catch {
      setError('The request did not complete.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      {/* --- What the dashboards are reading ---------------------------------- */}
      <div
        className="flex flex-wrap items-start gap-3 rounded-[var(--radius)] border p-4"
        style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}
      >
        <Database size={14} className="mt-0.5 shrink-0" aria-hidden />
        <div className="min-w-0 max-w-2xl">
          <p className="text-[13px] font-semibold">Live data</p>
          <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--text-secondary)]">
            Every figure on every dashboard was loaded from QuickBooks, HubSpot or Google Sheets —{' '}
            {props.loadedRowCount.toLocaleString()} row
            {props.loadedRowCount === 1 ? '' : 's'} so far. There is no demonstration dataset and no
            way to switch to one: a month nothing has loaded reads as unavailable rather than as a
            figure.
          </p>
          {props.loadedRowCount === 0 && (
            <p
              className="mt-2 flex items-start gap-1.5 text-[11.5px] leading-relaxed"
              style={{ color: 'var(--status-warning)' }}
            >
              <CircleAlert size={13} className="mt-px shrink-0" aria-hidden />
              Nothing has been loaded yet, so the dashboards will read as unavailable throughout.
              Sign a source in below, then press Pull.
            </p>
          )}
        </div>
      </div>

      {/* --- Pulling --------------------------------------------------------- */}
      <div className="rounded-[var(--radius)] border p-4" style={{ borderColor: 'var(--border)' }}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <p className="text-[13px] font-semibold">Pull the latest data</p>
            <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--text-muted)]">
              Fetches the last three months from every connected source and writes it into the
              warehouse — QuickBooks into the profit and loss and balance sheet, HubSpot into deals,
              contacts and meetings, Sheets into budget and headcount. Closed months are left
              untouched. The reconciliation controls run immediately afterwards.
            </p>
          </div>

          {props.canManage && (
            <button
              type="button"
              onClick={() => sync()}
              disabled={busy !== null || connected.length === 0}
              title={connected.length === 0 ? 'No source is connected yet.' : undefined}
              className="flex shrink-0 items-center gap-1.5 rounded-[5px] px-3 py-1.5 text-[11.5px] font-medium disabled:opacity-40"
              style={{ background: 'var(--text-primary)', color: 'var(--text-inverse)' }}
            >
              {busy === 'sync' ? (
                <Loader2 size={12} className="animate-spin" aria-hidden />
              ) : (
                <RefreshCw size={12} aria-hidden />
              )}
              {busy === 'sync' ? 'Pulling…' : 'Pull everything'}
            </button>
          )}
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {props.connectedSources.map((source) => (
            <button
              key={source.source}
              type="button"
              onClick={() => sync([source.source])}
              disabled={!props.canManage || busy !== null || !source.connected}
              className="flex items-center gap-1.5 rounded-[5px] border px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-[var(--surface-2)] disabled:opacity-40"
              style={{ borderColor: 'var(--border)' }}
              title={source.connected ? undefined : `${source.label} is not signed in.`}
            >
              <RefreshCw size={11} aria-hidden />
              {source.label}
              <span className="text-[var(--text-muted)]">
                {source.connected ? `${source.entities}` : 'not connected'}
              </span>
            </button>
          ))}
        </div>

        {error && (
          <p
            className="mt-3 flex items-start gap-2 text-[11.5px] leading-relaxed"
            style={{ color: 'var(--status-critical)' }}
          >
            <CircleAlert size={13} className="mt-px shrink-0" aria-hidden />
            {error}
          </p>
        )}

        {result && (
          <div className="mt-3 space-y-2 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
            <p className="flex items-center gap-2 text-[12px] font-medium">
              {result.failedCount ? (
                <CircleAlert size={13} style={{ color: 'var(--status-warning)' }} aria-hidden />
              ) : (
                <CircleCheck size={13} style={{ color: 'var(--status-good)' }} aria-hidden />
              )}
              {result.rowsWritten?.toLocaleString()} row
              {result.rowsWritten === 1 ? '' : 's'} written for {result.window}
            </p>
            <p className="text-[11px] text-[var(--text-secondary)]">{result.reconciliation}</p>

            <ul className="space-y-1">
              {result.outcomes?.map((outcome, index) => (
                <li key={index} className="text-[11px] leading-relaxed">
                  <span className="text-[var(--text-secondary)]">
                    {outcome.source} · {outcome.entity.replace(/_/g, ' ')}
                  </span>{' '}
                  {outcome.ok ? (
                    <span className="text-[var(--text-muted)]">
                      {outcome.rowsWritten.toLocaleString()} rows
                    </span>
                  ) : (
                    <span style={{ color: 'var(--status-critical)' }}>{outcome.error}</span>
                  )}
                  {outcome.notes?.map((note, noteIndex) => (
                    <span key={noteIndex} className="block pl-3 text-[10.5px] text-[var(--text-muted)]">
                      {note}
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

    </div>
  );
}

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
  FlaskConical,
  Loader2,
  RefreshCw,
  Trash2,
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
  mode: 'DEMONSTRATION' | 'LIVE';
  connectedSources: Array<{ source: string; label: string; connected: boolean; entities: number }>;
  seedFootprint: { plRows: number; glRows: number; dealRows: number; budgetRows: number };
  loadedRowCount: number;
  canManage: boolean;
}

export function DataControls(props: DataControlsProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | 'sync' | 'mode' | 'purge'>(null);
  const [result, setResult] = useState<SyncResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingPurge, setConfirmingPurge] = useState(false);

  const connected = props.connectedSources.filter((source) => source.connected);
  const live = props.mode === 'LIVE';

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

  async function switchMode(mode: 'DEMONSTRATION' | 'LIVE') {
    setBusy('mode');
    setError(null);
    try {
      const response = await fetch('/api/data-mode', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const payload = (await response.json()) as { ok: boolean; error?: string };
      if (!payload.ok) setError(payload.error ?? 'The mode could not be changed.');
      else router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function purge() {
    setBusy('purge');
    setError(null);
    try {
      const response = await fetch('/api/data-mode', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ purgeSeed: true }),
      });
      const payload = (await response.json()) as { ok: boolean; error?: string };
      if (!payload.ok) setError(payload.error ?? 'The seeded data could not be removed.');
      else {
        setConfirmingPurge(false);
        router.refresh();
      }
    } finally {
      setBusy(null);
    }
  }

  const seedRows =
    props.seedFootprint.plRows +
    props.seedFootprint.glRows +
    props.seedFootprint.dealRows +
    props.seedFootprint.budgetRows;

  return (
    <div className="space-y-4">
      {/* --- Which figures are being shown ---------------------------------- */}
      <div
        className="flex flex-wrap items-start justify-between gap-4 rounded-[var(--radius)] border p-4"
        style={{
          borderColor: live ? 'var(--status-good)' : 'var(--status-warning)',
          background: live ? 'var(--status-good-wash)' : 'var(--status-warning-wash)',
        }}
      >
        <div className="min-w-0 max-w-2xl">
          <p className="flex items-center gap-2 text-[13px] font-semibold">
            {live ? <Database size={14} aria-hidden /> : <FlaskConical size={14} aria-hidden />}
            {live ? 'Live data' : 'Demonstration data'}
          </p>
          <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--text-secondary)]">
            {live ? (
              <>
                Every seeded row is excluded from every view. The dashboards show only what
                QuickBooks, HubSpot and Google Sheets have loaded — {props.loadedRowCount.toLocaleString()}{' '}
                row{props.loadedRowCount === 1 ? '' : 's'} so far. A month nothing has loaded reads
                as unavailable rather than as a figure.
              </>
            ) : (
              <>
                The dashboards are showing the seeded dataset, which is fabricated to exercise every
                view before a source is connected. Switch to live and only data loaded from your own
                systems is shown.
              </>
            )}
          </p>
          {live && props.loadedRowCount === 0 && (
            <p
              className="mt-2 flex items-start gap-1.5 text-[11.5px] leading-relaxed"
              style={{ color: 'var(--status-critical)' }}
            >
              <CircleAlert size={13} className="mt-px shrink-0" aria-hidden />
              Live is on and nothing has been loaded yet, so every dashboard will read as
              unavailable. Sign a source in and press Pull.
            </p>
          )}
        </div>

        {props.canManage && (
          <button
            type="button"
            onClick={() => switchMode(live ? 'DEMONSTRATION' : 'LIVE')}
            disabled={busy !== null}
            className="flex shrink-0 items-center gap-1.5 rounded-[5px] px-3 py-1.5 text-[11.5px] font-medium disabled:opacity-50"
            style={{ background: 'var(--text-primary)', color: 'var(--text-inverse)' }}
          >
            {busy === 'mode' && <Loader2 size={12} className="animate-spin" aria-hidden />}
            {live ? 'Show demonstration data' : 'Switch to live data'}
          </button>
        )}
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

      {/* --- Removing the seed for good -------------------------------------- */}
      {props.canManage && seedRows > 0 && (
        <div className="rounded-[var(--radius)] border p-4" style={{ borderColor: 'var(--border)' }}>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-2xl">
              <p className="text-[13px] font-semibold">Delete the seeded dataset</p>
              <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--text-muted)]">
                {seedRows.toLocaleString()} seeded rows are still stored — hidden in live mode, but
                present. Deleting them cannot be undone, and it is the difference between the
                demonstration data being <em>hidden</em> and being <em>gone</em>. Nothing loaded
                from a source is touched.
              </p>
            </div>

            {confirmingPurge ? (
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  onClick={purge}
                  disabled={busy !== null}
                  className="flex items-center gap-1.5 rounded-[5px] px-3 py-1.5 text-[11.5px] font-medium text-white disabled:opacity-50"
                  style={{ background: 'var(--status-critical)' }}
                >
                  {busy === 'purge' && <Loader2 size={12} className="animate-spin" aria-hidden />}
                  Delete permanently
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingPurge(false)}
                  className="rounded-[5px] px-2.5 py-1.5 text-[11.5px] text-[var(--text-muted)]"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmingPurge(true)}
                className="flex shrink-0 items-center gap-1.5 rounded-[5px] border px-3 py-1.5 text-[11.5px] font-medium transition-colors hover:bg-[var(--surface-2)]"
                style={{ borderColor: 'var(--border)' }}
              >
                <Trash2 size={12} aria-hidden />
                Delete seeded data
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

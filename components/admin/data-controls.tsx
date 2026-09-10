'use client';

/**
 * Pulling data, and watching it arrive.
 *
 * A pull is not one request any more. Fourteen entities of live QuickBooks,
 * HubSpot and Sheets data cannot be fetched inside a single serverless
 * invocation — the attempt died at the platform timeout, and what reached the
 * browser was a gateway error with no JSON in it, which is why this panel used
 * to say nothing more useful than "The request did not complete."
 *
 * So the browser drives the pull instead: ask what the work is, then run one
 * short request per slice until each entity says it is finished. The operator
 * watches rows land source by source rather than staring at a spinner, and an
 * interrupted pull keeps everything it had already written.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  CircleAlert,
  CircleCheck,
  Database,
  Loader2,
  RefreshCw,
} from 'lucide-react';

interface SyncStep {
  source: string;
  sourceLabel: string;
  entity: string;
  label: string;
}

interface SliceOutcome {
  source: string;
  entity: string;
  ok: boolean;
  done: boolean;
  loadRunId: string;
  recordsRead: number;
  rowsWritten: number;
  slices: number;
  notes?: string[];
  error?: string;
}

type StepState = 'waiting' | 'running' | 'done' | 'failed';

interface StepProgress extends SyncStep {
  state: StepState;
  rowsWritten: number;
  recordsRead: number;
  notes: string[];
  error?: string;
}

export interface DataControlsProps {
  connectedSources: Array<{ source: string; label: string; connected: boolean; entities: number }>;
  loadedRowCount: number;
  canManage: boolean;
}

/**
 * A slice may fail on a transient network hiccup rather than on anything wrong
 * with the data. Retrying the same slice is safe — it resumes from the cursor
 * the last successful slice committed — so a blip costs seconds rather than the
 * whole pull.
 */
const SLICE_RETRIES = 2;

/** Guards against a connector that keeps claiming there is more to fetch. */
const MAX_SLICES_PER_ENTITY = 200;

export function DataControls(props: DataControlsProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<StepProgress[]>([]);
  const [window_, setWindow] = useState<string | null>(null);
  // Whether the month range means anything for what was pulled. It does for
  // QuickBooks, which is fetched a report per month; it does not for HubSpot,
  // which is fetched by object.
  const [windowApplies, setWindowApplies] = useState(false);
  const [reconciliation, setReconciliation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);

  // A pull that is still running when the panel unmounts must stop driving, or
  // it keeps posting slices at a page nobody is looking at.
  useEffect(() => () => {
    cancelled.current = true;
  }, []);

  const post = useCallback(async (body: Record<string, unknown>) => {
    const response = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok && response.status >= 500) {
      throw new Error(`The server returned ${response.status} while pulling.`);
    }

    return (await response.json()) as Record<string, unknown>;
  }, []);

  const connected = props.connectedSources.filter((source) => source.connected);

  async function sync(sources?: string[], fullRefresh = false) {
    cancelled.current = false;
    setBusy(true);
    setError(null);
    setReconciliation(null);
    setSteps([]);
    setWindow(null);

    try {
      // --- What is there to pull? ----------------------------------------
      const planned = (await post({ mode: 'plan', sources, fullRefresh })) as {
        ok: boolean;
        error?: string;
        window?: string;
        windowStart?: string;
        windowEnd?: string;
        windowApplies?: boolean;
        steps?: SyncStep[];
      };

      if (!planned.ok || !planned.steps?.length) {
        setError(planned.error ?? 'There was nothing to pull.');
        return;
      }

      setWindow(planned.window ?? null);
      setWindowApplies(Boolean(planned.windowApplies));
      const progress: StepProgress[] = planned.steps.map((step) => ({
        ...step,
        state: 'waiting',
        rowsWritten: 0,
        recordsRead: 0,
        notes: [],
      }));
      setSteps(progress);

      // --- Pull it, one bounded slice at a time ---------------------------
      for (let index = 0; index < progress.length; index++) {
        if (cancelled.current) return;

        const step = progress[index]!;
        step.state = 'running';
        setSteps([...progress]);

        let loadRunId: string | null = null;
        let sliceCount = 0;

        for (;;) {
          if (cancelled.current) return;

          let outcome: SliceOutcome | null = null;
          let lastError = 'The slice did not complete.';

          for (let attempt = 0; attempt <= SLICE_RETRIES; attempt++) {
            if (attempt > 0) await pause(2 ** attempt * 500);
            try {
              const response = (await post({
                mode: 'slice',
                source: step.source,
                entity: step.entity,
                windowStart: planned.windowStart,
                windowEnd: planned.windowEnd,
                loadRunId,
                fullRefresh,
              })) as { ok: boolean; error?: string; outcome?: SliceOutcome };

              if (response.ok && response.outcome) {
                outcome = response.outcome;
                break;
              }
              lastError = response.error ?? lastError;
            } catch (err) {
              lastError = err instanceof Error ? err.message : lastError;
            }
          }

          if (!outcome) {
            step.state = 'failed';
            step.error = lastError;
            setSteps([...progress]);
            break;
          }

          step.rowsWritten += outcome.rowsWritten;
          step.recordsRead += outcome.recordsRead;
          if (outcome.notes?.length) step.notes = outcome.notes;

          if (!outcome.ok) {
            step.state = 'failed';
            step.error = outcome.error ?? 'The source rejected the request.';
            setSteps([...progress]);
            break;
          }

          setSteps([...progress]);

          if (outcome.done) {
            step.state = 'done';
            setSteps([...progress]);
            break;
          }

          loadRunId = outcome.loadRunId;
          sliceCount += 1;
          if (sliceCount >= MAX_SLICES_PER_ENTITY) {
            step.state = 'failed';
            step.error =
              'The source kept returning more data than a single pull can take. What arrived is ' +
              'saved; pull this source again to continue.';
            setSteps([...progress]);
            break;
          }
        }

        // Each finished entity is already committed, so the dashboards behind
        // this page can show it without waiting for the rest.
        router.refresh();
      }

      // --- Then the controls, once ----------------------------------------
      if (cancelled.current) return;
      const finalized = (await post({ mode: 'finalize' })) as {
        ok: boolean;
        reconciliation?: string;
        error?: string;
      };
      setReconciliation(finalized.reconciliation ?? finalized.error ?? null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The pull stopped unexpectedly.');
    } finally {
      if (!cancelled.current) setBusy(false);
    }
  }

  const totalRows = steps.reduce((sum, step) => sum + step.rowsWritten, 0);
  const finishedSteps = steps.filter((step) => step.state === 'done' || step.state === 'failed');
  const failedSteps = steps.filter((step) => step.state === 'failed');

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
              Fetches <strong>only what has changed</strong> since the last successful pull, so a
              refresh reads the hundred records that moved rather than the sixty thousand that did
              not. QuickBooks is read a month at a time, ending at the current month and reaching
              twelve months back; HubSpot and Sheets are not read by month at all — HubSpot pulls
              the whole portal. QuickBooks goes into the profit and loss and balance sheet, HubSpot
              into deals, contacts and meetings, Sheets into budget and headcount. Each entity is saved as it
              lands, so the dashboards update while the pull is still running. Closed months are
              left untouched. The reconciliation controls run at the end.
            </p>
          </div>

          {props.canManage && (
            <button
              type="button"
              onClick={() => sync()}
              disabled={busy || connected.length === 0}
              title={connected.length === 0 ? 'No source is connected yet.' : undefined}
              className="flex shrink-0 items-center gap-1.5 rounded-[5px] px-3 py-1.5 text-[11.5px] font-medium disabled:opacity-40"
              style={{ background: 'var(--text-primary)', color: 'var(--text-inverse)' }}
            >
              {busy ? (
                <Loader2 size={12} className="animate-spin" aria-hidden />
              ) : (
                <RefreshCw size={12} aria-hidden />
              )}
              {busy ? 'Pulling…' : 'Pull everything'}
            </button>
          )}
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {props.connectedSources.map((source) => (
            <button
              key={source.source}
              type="button"
              onClick={() => sync([source.source])}
              disabled={!props.canManage || busy || !source.connected}
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

        {props.canManage && (
          <div className="mt-3 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
            <button
              type="button"
              onClick={() => sync(undefined, true)}
              disabled={busy || connected.length === 0}
              className="text-[11px] font-medium underline underline-offset-2 disabled:opacity-40"
              style={{ color: 'var(--text-muted)' }}
            >
              Re-import everything from scratch
            </button>
            <p className="mt-1 max-w-2xl text-[10.5px] leading-relaxed text-[var(--text-muted)]">
              Ignores what has already been pulled and reads each source from the beginning. Needed
              only when the warehouse and the source have genuinely diverged — a mapping changed, or
              records were edited in a way the provider does not stamp as a change. It reads
              everything, so it takes as long as the first pull did.
            </p>
          </div>
        )}

        {error && (
          <p
            className="mt-3 flex items-start gap-2 text-[11.5px] leading-relaxed"
            style={{ color: 'var(--status-critical)' }}
          >
            <CircleAlert size={13} className="mt-px shrink-0" aria-hidden />
            {error}
          </p>
        )}

        {steps.length > 0 && (
          <div className="mt-3 space-y-2 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
            <p className="flex items-center gap-2 text-[12px] font-medium">
              {busy ? (
                <Loader2 size={13} className="animate-spin" aria-hidden />
              ) : failedSteps.length ? (
                <CircleAlert size={13} style={{ color: 'var(--status-warning)' }} aria-hidden />
              ) : (
                <CircleCheck size={13} style={{ color: 'var(--status-good)' }} aria-hidden />
              )}
              {totalRows.toLocaleString()} row{totalRows === 1 ? '' : 's'} written ·{' '}
              {finishedSteps.length} of {steps.length}
            </p>

            <p className="text-[10.5px] leading-relaxed text-[var(--text-muted)]">
              {windowApplies ? (
                <>
                  QuickBooks was fetched a report per month for{' '}
                  <strong>{window_}</strong> — that range is a real limit on the accounting data.
                  HubSpot is fetched by object and is <strong>not</strong> limited to those months:
                  it pulls the whole portal, or everything changed since the last pull.
                </>
              ) : (
                <>
                  HubSpot and Sheets are not fetched by month. HubSpot pulls the whole portal, or
                  everything changed since the last pull — the reporting month does not limit it.
                </>
              )}
            </p>

            {reconciliation && (
              <p className="text-[11px] text-[var(--text-secondary)]">{reconciliation}</p>
            )}

            <ul className="space-y-1">
              {steps.map((step) => (
                <li key={`${step.source}:${step.entity}`} className="text-[11px] leading-relaxed">
                  <span className="inline-flex items-center gap-1.5">
                    <StepIcon state={step.state} />
                    <span className="text-[var(--text-secondary)]">
                      {step.sourceLabel} · {step.label}
                    </span>
                  </span>{' '}
                  {step.state === 'failed' ? (
                    <span style={{ color: 'var(--status-critical)' }}>{step.error}</span>
                  ) : step.state === 'waiting' ? (
                    <span className="text-[var(--text-muted)]">queued</span>
                  ) : (
                    <span className="text-[var(--text-muted)]">
                      {step.rowsWritten.toLocaleString()} row{step.rowsWritten === 1 ? '' : 's'}
                      {step.state === 'running' ? ' so far…' : ''}
                    </span>
                  )}
                  {step.notes.map((note, noteIndex) => (
                    <span
                      key={noteIndex}
                      className="block pl-5 text-[10.5px] text-[var(--text-muted)]"
                    >
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

function StepIcon({ state }: { state: StepState }) {
  if (state === 'running') return <Loader2 size={11} className="animate-spin" aria-hidden />;
  if (state === 'done')
    return <CircleCheck size={11} style={{ color: 'var(--status-good)' }} aria-hidden />;
  if (state === 'failed')
    return <CircleAlert size={11} style={{ color: 'var(--status-critical)' }} aria-hidden />;
  return (
    <span
      className="inline-block size-[7px] rounded-full"
      style={{ background: 'var(--border)' }}
      aria-hidden
    />
  );
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

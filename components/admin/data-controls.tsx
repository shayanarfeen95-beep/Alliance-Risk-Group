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
import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
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

/**
 * The pull's progress lives outside the component, for the life of the tab.
 *
 * It used to live in component state, and the component cancelled its pull when
 * it unmounted. The Admin sections are separate pages, so opening Connections to
 * paste a spreadsheet link unmounted this panel and silently stopped a pull at
 * "11 of 14" — the last three HubSpot entities and the reconciliation never ran.
 * Held here, a pull keeps going while you look at another section, and coming
 * back shows it where it is.
 */
interface PullState {
  busy: boolean;
  steps: StepProgress[];
  window: string | null;
  // Whether the month range means anything for what was pulled. It does for
  // QuickBooks, which is fetched a report per month; it does not for HubSpot,
  // which is fetched by object.
  windowApplies: boolean;
  reconciliation: string | null;
  error: string | null;
}

const IDLE: PullState = {
  busy: false,
  steps: [],
  window: null,
  windowApplies: false,
  reconciliation: null,
  error: null,
};
let pullState: PullState = IDLE;
const pullListeners = new Set<() => void>();

function setPull(patch: Partial<PullState>) {
  pullState = { ...pullState, ...patch };
  for (const listener of pullListeners) listener();
}
function subscribePull(listener: () => void) {
  pullListeners.add(listener);
  return () => {
    pullListeners.delete(listener);
  };
}
const readPull = () => pullState;
const readIdle = () => IDLE;

const setBusy = (busy: boolean) => setPull({ busy });
const setSteps = (steps: StepProgress[]) => setPull({ steps });
const setWindow = (window: string | null) => setPull({ window });
const setWindowApplies = (windowApplies: boolean) => setPull({ windowApplies });
const setReconciliation = (reconciliation: string | null) => setPull({ reconciliation });
const setError = (error: string | null) => setPull({ error });

/** For the Admin header: is a pull running, and how far has it got? */
export function usePullProgress(): { busy: boolean; finished: number; total: number } {
  const state = useSyncExternalStore(subscribePull, readPull, readIdle);
  return {
    busy: state.busy,
    finished: state.steps.filter((step) => step.state === 'done' || step.state === 'failed').length,
    total: state.steps.length,
  };
}

export function DataControls(props: DataControlsProps) {
  const router = useRouter();
  const pull = useSyncExternalStore(subscribePull, readPull, readIdle);
  const { busy, steps, windowApplies, reconciliation, error } = pull;
  const window_ = pull.window;

  /**
   * How far the next pull reaches.
   *
   * "Last 12 months" answers the routine refresh and nothing else. Comparing
   * 2024 against 2025, re-pulling a single month somebody restated, or reaching
   * further back than a year all need a start and an end — and needing a
   * redeploy for that is why months of books sat unfetched.
   */
  const [rangeMode, setRangeMode] = useState<'trailing' | 'year' | 'custom'>('trailing');
  const [trailingMonths, setTrailingMonths] = useState(24);
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [fromMonth, setFromMonth] = useState(() => currentMonth(-11));
  const [toMonth, setToMonth] = useState(() => currentMonth(0));
  // Never set by unmounting any more (see PullState): a pull runs to the end.
  const cancelled = useRef(false);

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

  /** The window the plan step is asked for, in the shape the route expects. */
  function requestedWindow(): Record<string, unknown> {
    switch (rangeMode) {
      case 'year':
        return { windowStart: `${year}-01`, windowEnd: `${year}-12` };
      case 'custom':
        return { windowStart: fromMonth, windowEnd: toMonth };
      case 'trailing':
      default:
        return { months: trailingMonths };
    }
  }

  async function sync(sources?: string[], fullRefresh = false) {
    if (pullState.busy) return;
    cancelled.current = false;
    setBusy(true);
    setError(null);
    setReconciliation(null);
    setSteps([]);
    setWindow(null);

    try {
      // --- What is there to pull? ----------------------------------------
      const planned = (await post({
        mode: 'plan',
        sources,
        fullRefresh,
        ...requestedWindow(),
      })) as {
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
          if (outcome.notes?.length) step.notes = [...step.notes, ...outcome.notes];

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
            <p className="text-[13px] font-semibold">Pull what is new or changed</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11.5px] leading-relaxed text-[var(--text-muted)]">
              <li>
                <strong>QuickBooks</strong>, month by month in the range below: months not yet loaded,
                the latest three (books still open), and any month QuickBooks&apos; change log shows was
                edited since the last check. Months already loaded and unchanged are not fetched or
                re-imported.
              </li>
              <li>
                <strong>Google Sheets</strong> and QuickBooks lists (accounts, classes, budgets, aging):
                read, compared with what was last imported, and imported only if different.
              </li>
              <li>
                <strong>HubSpot</strong>: only records modified since the last pull.
              </li>
            </ul>
            <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
              The nightly refresh does the same. Every run is written to the pull log below — what was
              new, what changed, what was left alone. The data checks run at the end.
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
              {busy ? 'Pulling…' : 'Pull new & changed'}
            </button>
          )}
        </div>

        {props.canManage && (
          <div
            className="mt-3 rounded-[5px] border p-3"
            style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}
          >
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <span className="text-[11.5px] font-medium">Months to pull</span>

              <div className="flex flex-wrap gap-1">
                {(
                  [
                    ['trailing', 'Recent'],
                    ['year', 'A year'],
                    ['custom', 'Custom range'],
                  ] as const
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setRangeMode(mode)}
                    disabled={busy}
                    className="rounded-[4px] border px-2 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-40"
                    style={{
                      borderColor: rangeMode === mode ? 'var(--text-primary)' : 'var(--border)',
                      background: rangeMode === mode ? 'var(--text-primary)' : 'transparent',
                      color: rangeMode === mode ? 'var(--text-inverse)' : 'var(--text-secondary)',
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {rangeMode === 'trailing' && (
                <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
                  Last
                  <select
                    value={trailingMonths}
                    onChange={(event) => setTrailingMonths(Number(event.target.value))}
                    disabled={busy}
                    className="rounded-[4px] border px-1.5 py-0.5 text-[11px]"
                    style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}
                  >
                    {[3, 6, 12, 18, 24, 36].map((count) => (
                      <option key={count} value={count}>
                        {count}
                      </option>
                    ))}
                  </select>
                  months, ending this month
                </label>
              )}

              {rangeMode === 'year' && (
                <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
                  Calendar year
                  <select
                    value={year}
                    onChange={(event) => setYear(Number(event.target.value))}
                    disabled={busy}
                    className="rounded-[4px] border px-1.5 py-0.5 text-[11px]"
                    style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}
                  >
                    {Array.from({ length: 8 }, (_, index) => new Date().getFullYear() - index).map(
                      (option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ),
                    )}
                  </select>
                  (January to December)
                </label>
              )}

              {rangeMode === 'custom' && (
                <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
                  From
                  <input
                    type="month"
                    value={fromMonth}
                    max={toMonth}
                    onChange={(event) => setFromMonth(event.target.value)}
                    disabled={busy}
                    className="rounded-[4px] border px-1.5 py-0.5 text-[11px]"
                    style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}
                  />
                  to
                  <input
                    type="month"
                    value={toMonth}
                    min={fromMonth}
                    onChange={(event) => setToMonth(event.target.value)}
                    disabled={busy}
                    className="rounded-[4px] border px-1.5 py-0.5 text-[11px]"
                    style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}
                  />
                  <span className="text-[var(--text-muted)]">
                    inclusive, up to 36 months in one run
                  </span>
                </div>
              )}
            </div>

            {/* The same caveat the window label carries, said where the choice is
                made rather than after the pull has already run. */}
            <p className="mt-2 text-[10.5px] leading-relaxed text-[var(--text-muted)]">
              This limits <strong>QuickBooks</strong>, which is fetched one report per month.
              HubSpot is fetched by object and filtered on modification time, and Sheets reads whole
              tabs, so neither is narrowed by these months.
            </p>
          </div>
        )}

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
              Fetches and imports every month and record in the range again, changed or not. Rarely
              needed: a change to the importer or to the class mapping already triggers a re-import of
              what it affects. Use it if QuickBooks was edited in a way its change log does not show —
              payroll, for example — in a month more than three months back.
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
                      {step.state === 'done' &&
                      step.rowsWritten === 0 &&
                      step.notes.some((note) => /unchanged|nothing to fetch|not re-imported/i.test(note))
                        ? 'up to date — nothing re-imported'
                        : `${step.rowsWritten.toLocaleString()} row${step.rowsWritten === 1 ? '' : 's'}${
                            step.state === 'running' ? ' so far…' : ''
                          }`}
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

/** A YYYY-MM string, offset from the current month. */
function currentMonth(delta: number): string {
  const now = new Date();
  const shifted = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + delta, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
}

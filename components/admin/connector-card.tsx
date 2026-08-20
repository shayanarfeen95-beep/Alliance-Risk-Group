'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  CircleCheck,
  Key,
  Link2,
  Loader2,
  Plug,
  RefreshCw,
  TriangleAlert,
  Unplug,
} from 'lucide-react';

/**
 * One source connection.
 *
 * The state shown here is the state the overnight refresh will actually use, so
 * it is deliberately specific: which company is linked, how it was authorised,
 * when the token expires. "Connected" on its own invites the reader to assume
 * the right company is connected, and the whole point of the connectors is that
 * ARG's figures come from ARG's books.
 */

export interface ConnectorCardProps {
  sourceSystem: string;
  label: string;
  entities: Array<{ entity: string; label: string; cadence: string }>;
  credential: {
    connected: boolean;
    origin: 'database' | 'environment' | null;
    authMethod: string | null;
    accountLabel: string | null;
    accountId: string | null;
    scopes: string | null;
    expiresAt: string | null;
    lastRefreshedAt: string | null;
    lastError: string | null;
    connectedAt: string | null;
  };
  oauthAvailable: boolean;
  oauthBlockedReason: string | null;
  canManage: boolean;
  composioAvailable: boolean;
  viaComposio: boolean;
}

export function ConnectorCard(props: ConnectorCardProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string[] | null>(null);
  const [sync, setSync] = useState<SyncReport | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [composioPending, setComposioPending] = useState<string | null>(null);
  const [showManual, setShowManual] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});

  const { credential: c, sourceSystem } = props;
  const supportsManual = sourceSystem === 'HUBSPOT' || sourceSystem === 'SHEETS';

  async function submitManual() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/connect/${sourceSystem.toLowerCase()}/manual`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(fields),
      });
      const payload = await response.json();
      if (!payload.ok) {
        setError(payload.error ?? 'The credential was rejected.');
        return;
      }
      // Connected, but with an optional scope refused. The connection is real,
      // so this is not an error — but the dependent metrics will read as
      // unavailable and the reason belongs on screen now, not at 3am.
      setNotice(Array.isArray(payload.warnings) && payload.warnings.length > 0 ? payload.warnings : null);
      setShowManual(false);
      setFields({});
      router.refresh();
    } catch {
      setError('The request did not complete.');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Runs a real refresh and reports what each entity did.
   *
   * Deliberately not a spinner that ends in "Synced". Half the useful outcomes
   * of a first sync are partial — deals loaded, meetings refused for a scope,
   * three closed months left alone — and a single green tick would hide every
   * one of them.
   *
   * A backfill is walked backwards in six-month windows rather than requested
   * as one long call. Each request finishes well inside the platform's function
   * timeout, so a slow QuickBooks cannot leave a run stranded half way with
   * nobody able to say what was written.
   */
  async function runSync(monthsBack: number) {
    setBusy(true);
    setError(null);
    setSync(null);

    const merged: SyncReport = {
      ok: true,
      label: props.label,
      window: '',
      rowsWritten: 0,
      entities: [],
    };

    try {
      const chunks = windowsBack(monthsBack, 6);

      for (const [index, chunk] of chunks.entries()) {
        setProgress(chunks.length > 1 ? `${index + 1} of ${chunks.length}` : null);

        const response = await fetch(`/api/connect/${sourceSystem.toLowerCase()}/sync`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(chunk),
        });
        const payload = (await response.json()) as SyncReport & { error?: string };

        if (payload.error && !payload.entities) {
          setError(payload.error);
          return;
        }

        merged.ok &&= payload.ok;
        merged.rowsWritten += payload.rowsWritten;
        merged.entities = mergeEntities(merged.entities, payload.entities ?? []);
        merged.window = merged.window
          ? `${chunk.fromMonth} → ${merged.window.split(' → ')[1]}`
          : payload.window;
        setSync({ ...merged });

        // One failing window means the next one fails the same way. Walking
        // through eleven more to collect eleven identical errors wastes the
        // reader's time and the provider's rate limit.
        if (!payload.ok && payload.entities?.some((entity) => /not connected|401|403/.test(entity.error ?? ''))) {
          break;
        }
      }

      router.refresh();
    } catch {
      setError('The sync request did not complete.');
    } finally {
      setProgress(null);
      setBusy(false);
    }
  }

  /**
   * Composio hosts the authorisation, so this opens their window and then waits
   * to be told it finished.
   *
   * The connection is stored only once Composio reports it ACTIVE. Composio
   * hands back an id the moment the flow starts, and saving that would mark the
   * source connected while the user was still on Intuit's consent screen — or
   * after they closed it without approving.
   */
  async function connectViaComposio() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/connect/${sourceSystem.toLowerCase()}/composio`, {
        method: 'POST',
      });
      const payload = await response.json();
      if (!payload.ok) {
        setError(payload.error ?? 'Composio could not start a connection.');
        return;
      }
      setComposioPending(payload.connectionId);
      window.open(payload.redirectUrl, '_blank', 'noopener,noreferrer');
    } catch {
      setError('The request did not complete.');
    } finally {
      setBusy(false);
    }
  }

  async function finishComposio() {
    if (!composioPending) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/connect/${sourceSystem.toLowerCase()}/composio`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ connectionId: composioPending }),
      });
      const payload = await response.json();
      if (!payload.ok) {
        setError(payload.error ?? 'Composio could not confirm the connection.');
        return;
      }
      setComposioPending(null);
      router.refresh();
    } catch {
      setError('The request did not complete.');
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/connect/${sourceSystem.toLowerCase()}/disconnect`, {
        method: 'POST',
      });
      const payload = await response.json();
      if (!payload.ok) setError(payload.error ?? 'Could not disconnect.');
      else router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="flex flex-col rounded-[var(--radius)] border p-4"
      style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[13.5px] font-semibold">{props.label}</h3>
          {c.connected && c.accountLabel && (
            <p className="mt-0.5 truncate text-[11.5px] text-[var(--text-secondary)]">
              {c.accountLabel}
            </p>
          )}
        </div>
        <StatusChip connected={c.connected} hasError={Boolean(c.lastError)} />
      </div>

      <ul className="mt-3 space-y-1">
        {props.entities.map((entity) => (
          <li key={entity.entity} className="text-[11.5px] text-[var(--text-secondary)]">
            {entity.label}{' '}
            <span className="text-[10.5px] text-[var(--text-muted)]">
              {entity.cadence.toLowerCase().replace('_', ' ')}
            </span>
          </li>
        ))}
      </ul>

      {c.connected && (
        <dl className="mt-3 space-y-1 border-t pt-3 text-[11px]" style={{ borderColor: 'var(--border)' }}>
          <Row label="Authorised" value={describeAuth(c.authMethod, c.origin)} />
          {c.accountId && <Row label="Account" value={c.accountId} mono />}
          {c.expiresAt && <Row label="Token expires" value={new Date(c.expiresAt).toLocaleString()} />}
          {c.connectedAt && (
            <Row label="Connected" value={new Date(c.connectedAt).toLocaleDateString()} />
          )}
        </dl>
      )}

      {/* A source that failed since it was connected still shows as connected —
          the credential is intact. Saying only "connected" would be misleading. */}
      {c.lastError && (
        <p className="mt-3 text-[11px] leading-relaxed text-[var(--status-critical)]">
          Last attempt failed: {c.lastError}
        </p>
      )}

      {!c.connected && props.oauthBlockedReason && (
        <p className="mt-3 text-[11px] leading-relaxed text-[var(--text-muted)]">
          {props.oauthBlockedReason}
        </p>
      )}

      {error && (
        <p className="mt-3 text-[11px] leading-relaxed text-[var(--status-critical)]">{error}</p>
      )}

      {notice && (
        <ul className="mt-3 space-y-1">
          {notice.map((line) => (
            <li key={line} className="text-[11px] leading-relaxed" style={{ color: 'var(--status-warning)' }}>
              Connected, with a limit: {line}
            </li>
          ))}
        </ul>
      )}

      {showManual && (
        <div className="mt-3 space-y-2">
          {sourceSystem === 'HUBSPOT' ? (
            <>
              <Field
                label="Private app token"
                placeholder="pat-na1-… or the newer base64 token"
                value={fields.accessToken ?? ''}
                onChange={(v) => setFields((f) => ({ ...f, accessToken: v }))}
              />
              <p className="text-[10.5px] leading-relaxed text-[var(--text-muted)]">
                HubSpot → Settings → Integrations → Private Apps → your app → Auth. The app needs{' '}
                <code className="font-[var(--font-mono)]">crm.objects.deals.read</code> and{' '}
                <code className="font-[var(--font-mono)]">crm.objects.contacts.read</code> at
                minimum; <code className="font-[var(--font-mono)]">crm.objects.owners.read</code> and{' '}
                <code className="font-[var(--font-mono)]">crm.objects.meetings.read</code> add the
                salesperson filter and Meetings Completed. Each scope is checked against HubSpot
                before anything is saved, and a missing one is named.
              </p>
            </>
          ) : (
            <>
              <Field
                label="Spreadsheet ID"
                placeholder="1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms"
                value={fields.spreadsheetId ?? ''}
                onChange={(v) => setFields((f) => ({ ...f, spreadsheetId: v }))}
              />
              <Field
                label="Service account JSON"
                placeholder='{"type":"service_account", …}'
                multiline
                value={fields.serviceAccountJson ?? ''}
                onChange={(v) => setFields((f) => ({ ...f, serviceAccountJson: v }))}
              />
              <p className="text-[10.5px] leading-relaxed text-[var(--text-muted)]">
                Share the spreadsheet with the service account&rsquo;s email address (Viewer is
                enough). The credential is verified by actually reading the sheet before it is
                saved.
              </p>
            </>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={submitManual}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-[5px] border px-2.5 py-1 text-[11px] font-medium disabled:opacity-50"
              style={{ borderColor: 'var(--border)' }}
            >
              {busy && <Loader2 size={12} className="animate-spin" aria-hidden />}
              {busy ? 'Verifying…' : 'Save and verify'}
            </button>
            <button
              type="button"
              onClick={() => setShowManual(false)}
              className="rounded-[5px] px-2.5 py-1 text-[11px] text-[var(--text-muted)]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {composioPending && (
        <div
          className="mt-3 rounded-[var(--radius)] border p-2.5"
          style={{ borderColor: 'var(--border)', background: 'var(--status-warning-wash)' }}
        >
          <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            Composio opened an authorisation window. Approve access there, then confirm here —
            nothing is stored until Composio reports the connection active.
          </p>
          <button
            type="button"
            onClick={finishComposio}
            disabled={busy}
            className="mt-2 flex items-center gap-1.5 rounded-[5px] border px-2.5 py-1 text-[11px] font-medium disabled:opacity-50"
            style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}
          >
            {busy && <Loader2 size={12} className="animate-spin" aria-hidden />}
            I have finished authorising
          </button>
        </div>
      )}

      {props.viaComposio && c.connected && (
        <p className="mt-3 text-[10.5px] leading-relaxed text-[var(--text-muted)]">
          Connected through Composio. This code only ever calls read operations, but the
          connection Composio holds is write-capable — a direct connection scoped to read-only
          is the stronger guarantee where you have the choice.
        </p>
      )}

      {sync && <SyncSummary report={sync} />}

      {props.canManage && !showManual && (
        <div className="mt-auto flex flex-wrap gap-2 pt-3">
          {c.connected ? (
            <>
            <button
              type="button"
              onClick={() => runSync(3)}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-[5px] border px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-[var(--surface-2)] disabled:opacity-40"
              style={{ borderColor: 'var(--border)' }}
            >
              {busy ? (
                <Loader2 size={12} className="animate-spin" aria-hidden />
              ) : (
                <RefreshCw size={12} aria-hidden />
              )}
              {busy ? `Syncing…${progress ? ` ${progress}` : ''}` : 'Sync now'}
            </button>
            <button
              type="button"
              onClick={() => runSync(13)}
              disabled={busy}
              title="Thirteen months, so every month of this year has a prior-year comparison."
              className="rounded-[5px] border px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-[var(--surface-2)] disabled:opacity-40"
              style={{ borderColor: 'var(--border)' }}
            >
              Backfill 13 months
            </button>
            <button
              type="button"
              onClick={disconnect}
              disabled={busy || c.origin === 'environment'}
              title={
                c.origin === 'environment'
                  ? 'This source is configured by environment variables; remove them to disconnect.'
                  : undefined
              }
              className="flex items-center gap-1.5 rounded-[5px] border px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-[var(--surface-2)] disabled:opacity-40"
              style={{ borderColor: 'var(--border)' }}
            >
              <Unplug size={12} aria-hidden />
              Disconnect
            </button>
            </>
          ) : (
            <>
              {props.oauthAvailable && (
                <a
                  href={`/api/connect/${sourceSystem.toLowerCase()}/start`}
                  className="flex items-center gap-1.5 rounded-[5px] border px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-[var(--surface-2)]"
                  style={{ borderColor: 'var(--border)' }}
                >
                  <Link2 size={12} aria-hidden />
                  Connect {props.label}
                </a>
              )}
              {props.composioAvailable && (
                <button
                  type="button"
                  onClick={connectViaComposio}
                  disabled={busy}
                  className="flex items-center gap-1.5 rounded-[5px] border px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-[var(--surface-2)] disabled:opacity-50"
                  style={{ borderColor: 'var(--border)' }}
                >
                  <Plug size={12} aria-hidden />
                  Connect with Composio
                </button>
              )}
              {supportsManual && (
                <button
                  type="button"
                  onClick={() => setShowManual(true)}
                  className="flex items-center gap-1.5 rounded-[5px] border px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-[var(--surface-2)]"
                  style={{ borderColor: 'var(--border)' }}
                >
                  <Key size={12} aria-hidden />
                  {sourceSystem === 'HUBSPOT' ? 'Use a private-app token' : 'Use a service account'}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function describeAuth(method: string | null, origin: string | null): string {
  const how =
    method === 'OAUTH'
      ? 'OAuth'
      : method === 'TOKEN'
        ? 'private-app token'
        : method === 'SERVICE_ACCOUNT'
          ? 'service account'
          : 'unknown';
  return origin === 'environment' ? `${how} (from environment)` : how;
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="shrink-0 text-[var(--text-muted)]">{label}</dt>
      <dd className={`truncate text-right ${mono ? 'font-[var(--font-mono)]' : ''}`}>{value}</dd>
    </div>
  );
}

function StatusChip({ connected, hasError }: { connected: boolean; hasError: boolean }) {
  const [Icon, text, color] = connected
    ? hasError
      ? [TriangleAlert, 'Needs attention', 'var(--status-warning)']
      : [CircleCheck, 'Connected', 'var(--status-good)']
    : [Plug, 'Not connected', 'var(--text-muted)'];

  return (
    <span
      className="flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10.5px] font-medium"
      style={{ borderColor: 'var(--border)', color }}
    >
      <Icon size={11} aria-hidden />
      {text}
    </span>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  multiline,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
}) {
  const shared = {
    value,
    placeholder,
    onChange: (e: { target: { value: string } }) => onChange(e.target.value),
    className:
      'w-full rounded-[5px] border px-2 py-1.5 text-[11.5px] font-[var(--font-mono)] outline-none focus:border-[var(--border-strong)]',
    style: { borderColor: 'var(--border)', background: 'var(--surface-2)' },
  };

  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-[var(--text-secondary)]">{label}</span>
      {multiline ? <textarea rows={4} {...shared} /> : <input type="password" {...shared} />}
    </label>
  );
}

interface SyncReport {
  ok: boolean;
  label: string;
  window: string;
  rowsWritten: number;
  entities: Array<{
    entity: string;
    ok: boolean;
    rowsRead: number;
    rowsWritten: number;
    tables: string[];
    warnings: string[];
    skippedClosedMonths: string[];
    error: string | null;
    recon: { passed: number; failed: number } | null;
  }>;
}

/**
 * What the sync did, entity by entity.
 *
 * A blocked entity shows its whole reason, including the remedy, because the
 * reasons a load stops are all of the form "somebody needs to map something"
 * and the person reading this is usually the person who can.
 */
function SyncSummary({ report }: { report: SyncReport }) {
  return (
    <div className="mt-3 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
      <p className="text-[11px] font-medium">
        {report.window} · {report.rowsWritten.toLocaleString()} row
        {report.rowsWritten === 1 ? '' : 's'} written
      </p>
      <ul className="mt-1.5 space-y-1.5">
        {report.entities.map((entity) => (
          <li key={entity.entity} className="text-[11px] leading-relaxed">
            <span
              className="font-medium"
              style={{ color: entity.ok ? 'var(--text-primary)' : 'var(--status-critical)' }}
            >
              {entity.entity.replace(/_/g, ' ')}
            </span>{' '}
            <span className="text-[var(--text-secondary)]">
              {entity.ok
                ? `${entity.rowsRead} read, ${entity.rowsWritten} written`
                : 'stopped'}
            </span>
            {entity.recon && entity.recon.failed > 0 && (
              <span style={{ color: 'var(--status-critical)' }}>
                {' '}
                · {entity.recon.failed} control{entity.recon.failed === 1 ? '' : 's'} failing
              </span>
            )}
            {entity.error && (
              <p className="mt-0.5 whitespace-pre-wrap text-[10.5px]" style={{ color: 'var(--status-critical)' }}>
                {entity.error}
              </p>
            )}
            {entity.warnings.map((warning) => (
              <p key={warning} className="mt-0.5 text-[10.5px] text-[var(--text-muted)]">
                {warning}
              </p>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Consecutive windows covering `monthsBack` months, newest first.
 *
 * Newest first on purpose: the current month is the one somebody is waiting to
 * see, and a backfill that starts thirteen months ago shows nothing useful
 * until it is nearly finished.
 */
function windowsBack(monthsBack: number, size: number): Array<{ fromMonth: string; toMonth: string }> {
  const label = (date: Date) =>
    `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;

  const now = new Date();
  const windows: Array<{ fromMonth: string; toMonth: string }> = [];

  for (let offset = 0; offset < monthsBack; offset += size) {
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
    const span = Math.min(size, monthsBack - offset);
    const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - (span - 1), 1));
    windows.push({ fromMonth: label(start), toMonth: label(end) });
  }

  return windows;
}

/** Accumulates per-entity totals across the windows of one backfill. */
function mergeEntities(
  existing: SyncReport['entities'],
  incoming: SyncReport['entities'],
): SyncReport['entities'] {
  const byEntity = new Map(existing.map((entity) => [entity.entity, { ...entity }]));

  for (const entity of incoming) {
    const current = byEntity.get(entity.entity);
    if (!current) {
      byEntity.set(entity.entity, { ...entity });
      continue;
    }
    current.ok &&= entity.ok;
    current.rowsRead += entity.rowsRead;
    current.rowsWritten += entity.rowsWritten;
    current.tables = [...new Set([...current.tables, ...entity.tables])];
    current.warnings = [...new Set([...current.warnings, ...entity.warnings])];
    current.skippedClosedMonths = [
      ...new Set([...current.skippedClosedMonths, ...entity.skippedClosedMonths]),
    ];
    // Keep the first error rather than the last: it is the one nearest the
    // month somebody is actually looking at.
    current.error ??= entity.error;
    if (entity.recon) {
      current.recon = {
        passed: (current.recon?.passed ?? 0) + entity.recon.passed,
        failed: (current.recon?.failed ?? 0) + entity.recon.failed,
      };
    }
    byEntity.set(entity.entity, current);
  }

  return [...byEntity.values()];
}

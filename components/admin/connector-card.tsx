'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  CircleCheck,
  DownloadCloud,
  Key,
  Link2,
  Loader2,
  Plug,
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
}

export function ConnectorCard(props: ConnectorCardProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
      if (payload.warning) {
        // Connected, but something about the credential will bite later.
        setWarning(payload.warning);
      }
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
   * Pulls one entity now.
   *
   * Ingestion used to run only through the assistant, so a deployment without
   * an ANTHROPIC_API_KEY could connect a source and never read from it. The
   * click is the confirmation; the server runs the same landing, conform and
   * reconciliation the assistant's confirm path does.
   */
  async function syncNow(entity: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/connect/${sourceSystem.toLowerCase()}/sync`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entity }),
      });
      const payload = await response.json();
      if (!payload.ok) setError(payload.error ?? 'The pull did not complete.');
      else {
        setNotice(payload.message);
        router.refresh();
      }
    } catch {
      setError('The pull did not complete. Nothing was written.');
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
          <li
            key={entity.entity}
            className="flex items-center justify-between gap-2 text-[11.5px] text-[var(--text-secondary)]"
          >
            <span className="min-w-0 truncate">
              {entity.label}{' '}
              <span className="text-[10.5px] text-[var(--text-muted)]">
                {entity.cadence.toLowerCase().replace('_', ' ')}
              </span>
            </span>

            {/* Pulling is a button, not a conversation: the assistant is
                optional and importing data is not. */}
            {c.connected && props.canManage ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => syncNow(entity.entity)}
                title={`Pull ${entity.label} for the last three months`}
                className="flex shrink-0 items-center gap-1 rounded-[5px] border px-1.5 py-0.5 text-[10.5px] transition-colors hover:bg-[var(--surface-2)] disabled:opacity-40"
                style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
              >
                {busy ? (
                  <Loader2 size={10} className="animate-spin" aria-hidden />
                ) : (
                  <DownloadCloud size={10} aria-hidden />
                )}
                Pull
              </button>
            ) : null}
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
        <p className="mt-3 text-[11px] leading-relaxed" style={{ color: 'var(--status-good)' }}>
          {notice}
        </p>
      )}

      {/* Connected, with something that will matter later — a token that
          expires, a scope that was not granted. */}
      {warning && (
        <p
          className="mt-3 rounded-[var(--radius-sm)] px-2.5 py-2 text-[11px] leading-relaxed"
          style={{ background: 'var(--status-warning-wash)', color: 'var(--text-secondary)' }}
        >
          {warning}
        </p>
      )}

      {showManual && (
        <div className="mt-3 space-y-2">
          {sourceSystem === 'HUBSPOT' ? (
            <Field
              label="Private app token"
              placeholder="pat-na1-…"
              value={fields.accessToken ?? ''}
              onChange={(v) => setFields((f) => ({ ...f, accessToken: v }))}
            />
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

      {props.canManage && !showManual && (
        <div className="mt-auto flex flex-wrap gap-2 pt-3">
          {c.connected ? (
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

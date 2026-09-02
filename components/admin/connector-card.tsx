'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CircleCheck, Key, Link2, Loader2, Plug, TriangleAlert, Unplug } from 'lucide-react';

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
  connectVia: 'composio' | 'oauth' | null;
  signInLabel: string;
  supportsManual: boolean;
  needsSpreadsheet: boolean;
  canManage: boolean;
}

export function ConnectorCard(props: ConnectorCardProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showManual, setShowManual] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});

  const { credential: c, sourceSystem } = props;
  const supportsManual = props.supportsManual;

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
      setShowManual(false);
      setFields({});
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
        <StatusChip
          connected={c.connected}
          hasError={Boolean(c.lastError)}
          incomplete={props.needsSpreadsheet}
        />
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

      {!c.connected && props.connectVia === 'composio' && (
        <p className="mt-3 text-[11px] leading-relaxed text-[var(--text-muted)]">
          Sign in with the account that owns the data. No developer app, token or key file — the
          authorisation is held by Composio and this system never sees a credential.
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

      {props.needsSpreadsheet && (
        <div className="mt-3 space-y-2">
          <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">
            Signed in. Google grants access to an account rather than to a document, so name the
            spreadsheet that holds the budget — paste its link from the address bar.
          </p>
          <Field
            label="Spreadsheet link"
            placeholder="https://docs.google.com/spreadsheets/d/…"
            reveal
            value={fields.spreadsheetId ?? ''}
            onChange={(v) => setFields((f) => ({ ...f, spreadsheetId: v }))}
          />
          <button
            type="button"
            onClick={submitManual}
            disabled={busy || !fields.spreadsheetId?.trim()}
            className="flex items-center gap-1.5 rounded-[5px] px-3 py-1.5 text-[11.5px] font-medium disabled:opacity-40"
            style={{ background: 'var(--text-primary)', color: 'var(--text-inverse)' }}
          >
            {busy && <Loader2 size={12} className="animate-spin" aria-hidden />}
            {busy ? 'Checking the sheet…' : 'Use this spreadsheet'}
          </button>
        </div>
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
                  className="flex items-center gap-1.5 rounded-[5px] px-3 py-1.5 text-[11.5px] font-medium transition-opacity hover:opacity-90"
                  style={{
                    background: 'var(--text-primary)',
                    color: 'var(--text-inverse)',
                  }}
                >
                  <Link2 size={12} aria-hidden />
                  {props.signInLabel}
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
    method === 'COMPOSIO'
      ? 'sign-in via Composio'
      : method === 'OAUTH'
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

function StatusChip({
  connected,
  hasError,
  incomplete,
}: {
  connected: boolean;
  hasError: boolean;
  incomplete: boolean;
}) {
  const [Icon, text, color] = connected
    ? hasError
      ? [TriangleAlert, 'Needs attention', 'var(--status-warning)']
      : incomplete
        ? [TriangleAlert, 'Signed in', 'var(--status-warning)']
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
  reveal,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
  /** A document link is not a credential; masking it only hides typos. */
  reveal?: boolean;
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
      {multiline ? (
        <textarea rows={4} {...shared} />
      ) : (
        <input type={reveal ? 'text' : 'password'} {...shared} />
      )}
    </label>
  );
}

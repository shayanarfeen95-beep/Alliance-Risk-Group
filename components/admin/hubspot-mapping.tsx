'use client';

/**
 * The HubSpot division mapper.
 *
 * Open item 2 made operable. Everything on this screen is either a value HubSpot
 * actually holds or a division ARG actually has — nothing here invites anyone to
 * type what they believe the data contains. A value with no mapping is shown as
 * unattributed with its deal count beside it, because that count is the decision
 * being made: mapping is worth doing when it moves four hundred deals, and is
 * noise when it moves one.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CircleCheck, LoaderCircle, TriangleAlert } from 'lucide-react';

export interface HubspotMappingProps {
  rule: string;
  isConfirmed: boolean;
  property: string | null;
  values: Record<string, string>;
  observed: Array<{ value: string; deals: number; mappedTo: string | null }>;
  sampledDeals: number;
  lastLandedAt: string | null;
  divisions: Array<{ divisionCode: string; divisionName: string }>;
  rules: Array<{ id: string; label: string; hint: string }>;
  canManage: boolean;
}

export function HubspotMapping(props: HubspotMappingProps) {
  const router = useRouter();
  const [rule, setRule] = useState(props.rule);
  const [property, setProperty] = useState(props.property ?? '');
  const [isConfirmed, setIsConfirmed] = useState(props.isConfirmed);
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = { ...props.values };
    for (const row of props.observed) {
      if (row.mappedTo) initial[row.value.toLowerCase()] = row.mappedTo;
    }
    return initial;
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const unattributed = props.observed
    .filter((row) => !values[row.value.toLowerCase()])
    .reduce((sum, row) => sum + row.deals, 0);

  async function save() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch('/api/mapping/hubspot', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rule, property, values, isConfirmed }),
      });
      const payload = (await response.json()) as
        | { ok: true; applied: string }
        | { ok: false; error: string };

      if (!payload.ok) setError(payload.error);
      else {
        setMessage(payload.applied);
        router.refresh();
      }
    } catch {
      setError('The mapping could not be saved. Nothing was changed.');
    } finally {
      setBusy(false);
    }
  }

  const activeRule = props.rules.find((candidate) => candidate.id === rule);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-[var(--text-secondary)]">
            A deal belongs to a division by
          </span>
          <select
            value={rule}
            disabled={!props.canManage || busy}
            onChange={(event) => setRule(event.target.value)}
            className="h-8 w-full rounded-[var(--radius-sm)] border px-2 text-[12px] outline-none disabled:opacity-60"
            style={{
              background: 'var(--surface-1)',
              borderColor: 'var(--border-strong)',
              color: 'var(--text-primary)',
            }}
          >
            {props.rules.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.label}
              </option>
            ))}
          </select>
          {activeRule ? (
            <span className="mt-1 block text-[10.5px] leading-snug text-[var(--text-muted)]">
              {activeRule.hint}
            </span>
          ) : null}
        </label>

        {rule === 'deal_property' ? (
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-[var(--text-secondary)]">
              HubSpot property name
            </span>
            <input
              value={property}
              disabled={!props.canManage || busy}
              onChange={(event) => setProperty(event.target.value)}
              placeholder="division"
              className="h-8 w-full rounded-[var(--radius-sm)] border px-2 text-[12px] outline-none disabled:opacity-60"
              style={{
                background: 'var(--surface-1)',
                borderColor: 'var(--border-strong)',
                color: 'var(--text-primary)',
              }}
            />
            <span className="mt-1 block text-[10.5px] leading-snug text-[var(--text-muted)]">
              The internal name, as HubSpot stores it — not the label shown in the UI. It is added
              to the properties requested on the next pull.
            </span>
          </label>
        ) : null}
      </div>

      {rule === 'none' ? (
        <p
          className="rounded-[var(--radius)] px-3 py-2.5 text-[11.5px] leading-relaxed"
          style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }}
        >
          Sales and marketing metrics will report at ARG Total only. The division rows say so on the
          face of the dashboard rather than showing zero. This is a real answer to open item 2 — an
          invented attribution rule moves revenue between divisional P&amp;Ls and is invisible at ARG
          Total.
        </p>
      ) : (
        <div>
          <p className="mb-2 text-[11.5px] leading-relaxed text-[var(--text-secondary)]">
            {props.observed.length === 0 ? (
              <>
                No HubSpot deals are landed yet, so there are no values to map. Connect HubSpot and
                pull deals; every value the pull contains appears here with its deal count.
              </>
            ) : (
              <>
                Values found in {props.sampledDeals.toLocaleString('en-US')} landed deal
                {props.sampledDeals === 1 ? '' : 's'}
                {props.lastLandedAt
                  ? `, most recent ${new Date(props.lastLandedAt).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}`
                  : ''}
                . A value left unmapped stays unattributed — it is never guessed into a division.
              </>
            )}
          </p>

          {props.observed.length > 0 ? (
            <div className="scroll-x">
              <table className="w-full min-w-max border-collapse text-[12px]">
                <thead>
                  <tr>
                    <th
                      className="border-b px-3 py-2 text-left text-[10.5px] font-semibold uppercase tracking-[0.06em]"
                      style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
                    >
                      HubSpot value
                    </th>
                    <th
                      className="border-b px-3 py-2 text-right text-[10.5px] font-semibold uppercase tracking-[0.06em]"
                      style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
                    >
                      Deals
                    </th>
                    <th
                      className="border-b px-3 py-2 text-left text-[10.5px] font-semibold uppercase tracking-[0.06em]"
                      style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
                    >
                      ARG division
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {props.observed.map((row) => {
                    const key = row.value.toLowerCase();
                    const selected = values[key] ?? '';
                    return (
                      <tr key={row.value}>
                        <td className="border-b px-3 py-1.5" style={{ borderColor: 'var(--border)' }}>
                          {row.value}
                        </td>
                        <td
                          className="tnum border-b px-3 py-1.5 text-right"
                          style={{ borderColor: 'var(--border)' }}
                        >
                          {row.deals.toLocaleString('en-US')}
                        </td>
                        <td className="border-b px-3 py-1.5" style={{ borderColor: 'var(--border)' }}>
                          <select
                            value={selected}
                            disabled={!props.canManage || busy}
                            onChange={(event) =>
                              setValues((current) => {
                                const next = { ...current };
                                if (event.target.value) next[key] = event.target.value;
                                else delete next[key];
                                return next;
                              })
                            }
                            className="h-7 rounded-[5px] border px-1.5 text-[11.5px] outline-none disabled:opacity-60"
                            style={{
                              background: 'var(--surface-1)',
                              borderColor: selected ? 'var(--border)' : 'var(--status-warning)',
                              color: 'var(--text-primary)',
                            }}
                          >
                            <option value="">Unattributed</option>
                            {props.divisions.map((division) => (
                              <option key={division.divisionCode} value={division.divisionCode}>
                                {division.divisionName} ({division.divisionCode})
                              </option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}

          {unattributed > 0 ? (
            <p
              className="mt-3 flex items-start gap-2 rounded-[var(--radius)] px-3 py-2 text-[11.5px] leading-relaxed"
              style={{ background: 'var(--status-warning-wash)', color: 'var(--text-secondary)' }}
            >
              <TriangleAlert
                size={13}
                className="mt-px shrink-0"
                style={{ color: 'var(--status-warning)' }}
                aria-hidden
              />
              {unattributed.toLocaleString('en-US')} deal{unattributed === 1 ? '' : 's'} would stay
              unattributed. They still count at ARG Total; they are simply absent from every
              division row.
            </p>
          ) : null}
        </div>
      )}

      <label className="flex items-start gap-2 text-[11.5px] leading-relaxed text-[var(--text-secondary)]">
        <input
          type="checkbox"
          checked={isConfirmed}
          disabled={!props.canManage || busy}
          onChange={(event) => setIsConfirmed(event.target.checked)}
          className="mt-0.5"
        />
        <span>
          <strong className="font-medium text-[var(--text-primary)]">
            Westport has confirmed this rule.
          </strong>{' '}
          Until this is ticked, every sales and marketing metric reports at ARG Total only —
          divisional figures are withheld rather than computed on an unconfirmed rule.
        </span>
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={!props.canManage || busy}
          className="inline-flex items-center gap-2 rounded-[var(--radius-sm)] px-3 py-1.5 text-[12px] font-medium disabled:opacity-50"
          style={{ background: 'var(--text-primary)', color: 'var(--text-inverse)' }}
        >
          {busy ? <LoaderCircle size={13} className="animate-spin" aria-hidden /> : null}
          Save and re-apply to landed deals
        </button>

        {!props.canManage ? (
          <span className="text-[11px] text-[var(--text-muted)]">
            Read-only — an administrator or the CFO changes this.
          </span>
        ) : null}
      </div>

      {message ? (
        <p
          className="flex items-start gap-2 text-[11.5px] leading-relaxed"
          style={{ color: 'var(--status-good)' }}
        >
          <CircleCheck size={13} className="mt-px shrink-0" aria-hidden />
          {message}
        </p>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="flex items-start gap-2 text-[11.5px] leading-relaxed"
          style={{ color: 'var(--delta-bad)' }}
        >
          <TriangleAlert size={13} className="mt-px shrink-0" aria-hidden />
          {error}
        </p>
      ) : null}
    </div>
  );
}

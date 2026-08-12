import type { Metadata } from 'next';
import { desc, sql } from 'drizzle-orm';
import { CircleAlert, CircleCheck, CircleHelp, Plug, Unplug } from 'lucide-react';
import { getDb } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import { getSessionUser } from '@/lib/auth/session';
import { redirect } from 'next/navigation';
import { connectorStatuses } from '@/lib/connectors';
import { Card, CardHeader, Chip, DataTable, SectionTitle, Td, Th } from '@/components/ui/primitives';

export const metadata: Metadata = { title: 'Admin' };
export const dynamic = 'force-dynamic';

/**
 * The open items and controls that would otherwise live in someone's head.
 *
 * §14.3 lists seven items that are Westport decisions rather than developer
 * guesses. They live here as data, visible, rather than being silently assumed
 * somewhere in the code.
 */
export default async function AdminPage() {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  const db = await getDb();

  const [config, recentRuns, reconSummary, failingChecks, auditTrail] = await Promise.all([
    db.select().from(t.appConfig).orderBy(t.appConfig.key),
    db.select().from(t.loadRun).orderBy(desc(t.loadRun.startedAt)).limit(10),
    db
      .select({
        checkId: t.reconResult.checkId,
        passed: sql<number>`count(*) filter (where status = 'PASS')::int`,
        failed: sql<number>`count(*) filter (where status = 'FAIL')::int`,
      })
      .from(t.reconResult)
      .where(sql`ran_at = (select max(ran_at) from recon_result)`)
      .groupBy(t.reconResult.checkId),
    db
      .select()
      .from(t.reconResult)
      .where(sql`status = 'FAIL' and ran_at = (select max(ran_at) from recon_result)`)
      .limit(25),
    db.select().from(t.auditEvent).orderBy(desc(t.auditEvent.createdAt)).limit(15),
  ]);

  const connectors = connectorStatuses();

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[19px] font-semibold tracking-tight">Admin</h1>
        <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">
          Connections, controls, open decisions and the audit trail
        </p>
      </header>

      {/* --- Connectors --------------------------------------------------- */}
      <section>
        <SectionTitle hint="Sources are read-only — no connector exposes a write operation">
          Source connections
        </SectionTitle>
        <div className="grid gap-3 lg:grid-cols-3">
          {connectors.map((connector) => (
            <Card key={connector.sourceSystem}>
              <CardHeader
                title={connector.label}
                action={
                  connector.isConfigured ? (
                    <Chip tone="good" icon={<Plug size={12} aria-hidden />}>
                      Connected
                    </Chip>
                  ) : (
                    <Chip
                      tone="warning"
                      icon={<Unplug size={12} aria-hidden />}
                      title="No credentials in the environment. The connector reports as not connected rather than returning empty data — an empty result and a missing connection must never look the same."
                    >
                      Not configured
                    </Chip>
                  )
                }
              />
              <ul className="space-y-1.5">
                {connector.entities.map((entity) => (
                  <li key={entity.entity} className="text-[11.5px] leading-snug">
                    <span className="font-medium">{entity.label}</span>
                    <span className="ml-1.5 text-[var(--text-muted)]">
                      {entity.cadence.toLowerCase().replace('_', ' ')}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      </section>

      {/* --- Open items --------------------------------------------------- */}
      <section>
        <SectionTitle hint="Westport decisions, carried as data rather than assumed in code">
          Open items and configuration
        </SectionTitle>
        <Card>
          <DataTable>
            <thead>
              <tr>
                <Th align="left">Key</Th>
                <Th align="left">Value</Th>
                <Th align="left">Status</Th>
                <Th align="left">Notes</Th>
              </tr>
            </thead>
            <tbody>
              {config.map((row) => (
                <tr key={row.key}>
                  <Td align="left" numeric={false}>
                    <code className="text-[11px]">{row.key}</code>
                  </Td>
                  <Td align="left" numeric={false} muted>
                    <code className="text-[11px]">{row.value || '—'}</code>
                  </Td>
                  <Td align="left" numeric={false}>
                    {row.isConfirmed ? (
                      <Chip tone="good" icon={<CircleCheck size={12} aria-hidden />}>
                        Confirmed
                      </Chip>
                    ) : (
                      <Chip tone="warning" icon={<CircleHelp size={12} aria-hidden />}>
                        Awaiting decision
                      </Chip>
                    )}
                  </Td>
                  <Td align="left" numeric={false} muted className="!whitespace-normal">
                    <span className="block max-w-xl text-[11px] leading-relaxed">
                      {row.description}
                    </span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </Card>
      </section>

      {/* --- Reconciliation ----------------------------------------------- */}
      <section id="reconciliation">
        <SectionTitle hint="Standing controls that run on every refresh, not one-time validations">
          Reconciliation
        </SectionTitle>
        <div className="grid gap-3 lg:grid-cols-2">
          <Card>
            <CardHeader title="Latest run" />
            <DataTable>
              <thead>
                <tr>
                  <Th align="left">Check</Th>
                  <Th>Pass</Th>
                  <Th>Fail</Th>
                </tr>
              </thead>
              <tbody>
                {reconSummary.map((row) => (
                  <tr key={row.checkId}>
                    <Td align="left" numeric={false}>
                      <code className="text-[11px]">{row.checkId}</code>
                    </Td>
                    <Td>{row.passed}</Td>
                    <Td
                      style={{ color: row.failed > 0 ? 'var(--delta-bad)' : undefined, fontWeight: row.failed > 0 ? 600 : 400 }}
                    >
                      {row.failed}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          </Card>

          <Card>
            <CardHeader
              title="Failing checks"
              subtitle="Any variance over $1 needs an explanation. Rounding and timing are valid; “unknown” is not."
            />
            {failingChecks.length === 0 ? (
              <p className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--status-good)' }}>
                <CircleCheck size={14} aria-hidden />
                Nothing failing on the most recent run.
              </p>
            ) : (
              <ul className="space-y-2">
                {failingChecks.map((row) => (
                  <li key={row.id} className="flex items-start gap-2">
                    <CircleAlert
                      size={13}
                      className="mt-0.5 shrink-0"
                      style={{ color: 'var(--status-critical)' }}
                      aria-hidden
                    />
                    <div>
                      <p className="text-[12px] font-medium">
                        {row.checkName}
                        {row.divisionCode ? ` — ${row.divisionCode}` : ''}
                        {row.periodMonth ? ` (${row.periodMonth.slice(0, 7)})` : ''}
                      </p>
                      <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">
                        {row.detail}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </section>

      {/* --- Load history -------------------------------------------------- */}
      <section>
        <SectionTitle hint="Every load is timestamped, reproducible and reversible">
          Recent loads
        </SectionTitle>
        <Card>
          <DataTable>
            <thead>
              <tr>
                <Th align="left">Source</Th>
                <Th align="left">Entity</Th>
                <Th align="left">Window</Th>
                <Th align="left">Status</Th>
                <Th>Rows written</Th>
                <Th align="left">Finished</Th>
              </tr>
            </thead>
            <tbody>
              {recentRuns.map((run) => (
                <tr key={run.id}>
                  <Td align="left" numeric={false}>
                    {run.sourceSystem}
                  </Td>
                  <Td align="left" numeric={false} muted>
                    {run.entity}
                  </Td>
                  <Td align="left" numeric={false} muted>
                    {run.windowStart ? `${run.windowStart.slice(0, 7)} → ${run.windowEnd?.slice(0, 7)}` : '—'}
                  </Td>
                  <Td align="left" numeric={false}>
                    {run.status}
                  </Td>
                  <Td>{run.rowsWritten.toLocaleString()}</Td>
                  <Td align="left" muted>
                    {run.finishedAt ? new Date(run.finishedAt).toLocaleString() : '—'}
                  </Td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </Card>
      </section>

      {/* --- Audit trail --------------------------------------------------- */}
      <section>
        <SectionTitle hint="Locks, waivers, ingestion and sign-ins">Audit trail</SectionTitle>
        <Card>
          <DataTable>
            <thead>
              <tr>
                <Th align="left">When</Th>
                <Th align="left">Action</Th>
                <Th align="left">Entity</Th>
              </tr>
            </thead>
            <tbody>
              {auditTrail.map((event) => (
                <tr key={event.id}>
                  <Td align="left" muted>
                    {new Date(event.createdAt).toLocaleString()}
                  </Td>
                  <Td align="left" numeric={false}>
                    {event.action}
                  </Td>
                  <Td align="left" numeric={false} muted>
                    {event.entity ?? '—'}
                  </Td>
                </tr>
              ))}
            </tbody>
          </DataTable>
          {auditTrail.length === 0 ? (
            <p className="pt-2 text-[12px] text-[var(--text-muted)]">No events recorded yet.</p>
          ) : null}
        </Card>
      </section>
    </div>
  );
}

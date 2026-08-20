import type { Metadata } from 'next';
import { desc, eq, sql } from 'drizzle-orm';
import { CircleAlert, CircleCheck, CircleHelp, Download } from 'lucide-react';
import { ConnectorCard } from '@/components/admin/connector-card';
import { UserManager } from '@/components/admin/user-manager';
import { AssistantCard } from '@/components/admin/assistant-card';
import {
  can,
  capabilitiesOf,
  capabilityMatrix,
  CAPABILITY_LABELS,
  ROLE_ORDER,
} from '@/lib/auth/scope';
import { getDb } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import { getSessionUser } from '@/lib/auth/session';
import { redirect } from 'next/navigation';
import { connectorStatuses } from '@/lib/connectors';
import { describeProvider } from '@/lib/ai/provider';
import { Card, CardHeader, Chip, DataTable, SectionTitle, Td, Th } from '@/components/ui/primitives';

export const metadata: Metadata = { title: 'Admin' };
export const dynamic = 'force-dynamic';

/** Role names as an administrator should read them, not as the enum spells them. */
const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Admin',
  CFO: 'CFO',
  EXECUTIVE: 'Executive',
  DIVISION_MANAGER: 'Division mgr',
  VIEWER: 'Viewer',
};

/**
 * The open items and controls that would otherwise live in someone's head.
 *
 * §14.3 lists seven items that are Westport decisions rather than developer
 * guesses. They live here as data, visible, rather than being silently assumed
 * somewhere in the code.
 */
export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const connectError = typeof query.connect_error === 'string' ? query.connect_error : null;
  const justConnected = typeof query.connected === 'string' ? query.connected : null;

  const user = await getSessionUser();
  if (!user) redirect('/login');

  const db = await getDb();

  const [config, recentRuns, reconSummary, failingChecks, auditTrail, userRows, accessRows, divisionRows] = await Promise.all([
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
    db.select().from(t.users).orderBy(t.users.name),
    db.select().from(t.userDivisionAccess),
    db.select().from(t.dimDivision).where(eq(t.dimDivision.isActive, true)).orderBy(t.dimDivision.sortOrder),
  ]);

  // Live sessions per person, so an administrator can end them without having
  // to deactivate the account — the two are different decisions.
  const sessionCounts = await db
    .select({
      userId: t.sessions.userId,
      count: sql<number>`count(*) filter (where expires_at > now())::int`,
    })
    .from(t.sessions)
    .groupBy(t.sessions.userId);

  const managedUsers = userRows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role as string,
    canViewConsolidated: row.canViewConsolidated,
    divisions: accessRows.filter((a) => a.userId === row.id).map((a) => a.divisionCode),
    isActive: row.isActive,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    // Generated from the same table the enforcement reads, so this cannot
    // describe a permission the system does not apply.
    capabilities: capabilitiesOf(row.role as Parameters<typeof capabilitiesOf>[0]).map(
      (capability) => CAPABILITY_LABELS[capability].label,
    ),
    activeSessions: sessionCounts.find((entry) => entry.userId === row.id)?.count ?? 0,
  }));

  const connectors = await connectorStatuses();

  // A half-configured assistant throws rather than guessing a model. Admin is
  // exactly where that should be readable, so the throw becomes the message.
  let assistant;
  try {
    assistant = describeProvider();
  } catch (error) {
    assistant = {
      configured: false,
      provider: null,
      model: null,
      detail: error instanceof Error ? error.message : 'The assistant is misconfigured.',
    };
  }

  // The pack is anchored on the configured reporting month rather than today's
  // date: exporting an unclosed month by accident is the sort of thing that
  // makes it into a board deck.
  const packMonth = (
    config.find((row) => row.key === 'DEFAULT_REPORTING_MONTH')?.value ?? ''
  ).slice(0, 7);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[19px] font-semibold tracking-tight">Admin</h1>
        <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">
          Connections, controls, open decisions and the audit trail
        </p>
      </header>

      {/* --- Audit pack ---------------------------------------------------- */}
      <section>
        <SectionTitle hint="Everything a reviewer needs to check a figure without this app">
          Audit pack
        </SectionTitle>
        <Card padded>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-xl text-[12px] leading-relaxed text-[var(--text-muted)]">
              A zip containing every metric as the dashboards resolved it, the definition and
              formula behind each one, the underlying profit-and-loss rows, the reconciliation
              controls run fresh at export, the provenance of every load, the forecast lock history,
              and the full assistant log including refusals. It contains what you can see and
              nothing more.
            </p>
            <a
              href={`/api/export/audit-pack?month=${packMonth}`}
              className="flex shrink-0 items-center gap-1.5 rounded-[5px] border px-3 py-1.5 text-[12px] font-medium transition-colors hover:bg-[var(--surface-2)]"
              style={{ borderColor: 'var(--border)' }}
            >
              <Download size={13} aria-hidden />
              Download {packMonth} pack
            </a>
          </div>
        </Card>
      </section>

      {/* --- Connectors --------------------------------------------------- */}
      <section>
        <SectionTitle hint="Read-only by construction — no connector exposes a write operation">
          Source connections
        </SectionTitle>

        {/* The result of a connect attempt arrives as a query parameter, because
            the OAuth callback is a redirect and has nowhere else to put it. */}
        {connectError && (
          <div
            className="mb-3 flex items-start gap-2 rounded-[var(--radius)] border p-3 text-[11.5px] leading-relaxed"
            style={{ borderColor: 'var(--border)', background: 'var(--status-critical-wash)' }}
          >
            <CircleAlert size={13} className="mt-0.5 shrink-0" style={{ color: 'var(--status-critical)' }} aria-hidden />
            <span>{connectError}</span>
          </div>
        )}
        {justConnected && (
          <div
            className="mb-3 flex items-start gap-2 rounded-[var(--radius)] border p-3 text-[11.5px] leading-relaxed"
            style={{ borderColor: 'var(--border)', background: 'var(--status-good-wash)' }}
          >
            <CircleCheck size={13} className="mt-0.5 shrink-0" style={{ color: 'var(--status-good)' }} aria-hidden />
            <span>
              {justConnected} is connected. Ask the assistant to pull a month, or wait for the
              overnight refresh — nothing is written until you confirm it.
            </span>
          </div>
        )}

        <div className="grid gap-3 lg:grid-cols-3">
          {connectors.map((connector) => (
            <ConnectorCard
              key={connector.sourceSystem}
              sourceSystem={connector.sourceSystem}
              label={connector.label}
              entities={connector.entities}
              credential={connector.credential}
              oauthAvailable={connector.oauthAvailable}
              oauthBlockedReason={connector.oauthBlockedReason}
              canManage={can(user, 'EDIT_MAPPINGS')}
            />
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

      {/* --- Assistant ------------------------------------------------------ */}
      <section>
        <SectionTitle hint="Which model answers, and whether it can call tools at all">
          Assistant
        </SectionTitle>
        <div className="grid gap-3 lg:grid-cols-2">
          <AssistantCard {...assistant} canManage={can(user, 'EDIT_MAPPINGS')} />
        </div>
      </section>

      {/* --- People and access ---------------------------------------------- */}
      {can(user, 'MANAGE_USERS') && (
        <section>
          <SectionTitle hint="Roles decide what someone can do; divisions decide what they can see">
            People and access
          </SectionTitle>
          <Card padded>
            <UserManager
              users={managedUsers}
              divisions={divisionRows.map((d) => ({
                divisionCode: d.divisionCode,
                divisionName: d.divisionName,
              }))}
              currentUserId={user.id}
            />
          </Card>

          {/*
            What each role grants, generated from the capability table the
            enforcement itself reads.

            An administrator choosing between "CFO" and "Executive" is making a
            security decision, and the role name is not a description of it.
            Every hand-written permissions page eventually describes permissions
            the system stopped applying; this one cannot, because there is no
            second list to keep in step.
          */}
          <Card className="mt-4">
            <CardHeader
              title="What each role can do"
              subtitle="Generated from the permission table the system enforces — not a description of it"
            />
            <DataTable>
              <thead>
                <tr>
                  <Th align="left">Capability</Th>
                  {ROLE_ORDER.map((role) => (
                    <Th key={role} align="center">
                      {ROLE_LABELS[role]}
                    </Th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {capabilityMatrix().map((row) => (
                  <tr key={row.capability}>
                    <Td align="left" numeric={false}>
                      <div className="font-medium">{row.label}</div>
                      <div className="text-[11px] text-[var(--text-muted)]">{row.detail}</div>
                    </Td>
                    {ROLE_ORDER.map((role) => (
                      <Td key={role} align="center" numeric={false}>
                        {row.roles[role] ? (
                          <CircleCheck
                            size={13}
                            aria-label="granted"
                            style={{ color: 'var(--status-good)' }}
                          />
                        ) : (
                          <span aria-label="not granted" className="text-[var(--text-muted)]">
                            —
                          </span>
                        )}
                      </Td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </DataTable>
            <p className="mt-3 text-[10.5px] leading-relaxed text-[var(--text-muted)]">
              Roles decide what someone can <em>do</em>. Divisions decide what they can{' '}
              <em>see</em>, and that is applied when facts are loaded — a person outside a division
              never has its rows fetched, so no view, export or assistant answer can disclose one.
            </p>
          </Card>
        </section>
      )}

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

import type { Metadata } from 'next';
import { desc, eq, sql } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { CircleAlert, CircleCheck, CircleHelp, Download } from 'lucide-react';
import { ConnectorCard } from '@/components/admin/connector-card';
import { DataControls } from '@/components/admin/data-controls';
import { PullIndicator } from '@/components/admin/pull-indicator';
import { UserManager } from '@/components/admin/user-manager';
import { ClassMapping } from '@/components/admin/class-mapping';
import { DataHealthPanel } from '@/components/admin/data-health';
import {
  AdminTabBar,
  AttentionItem,
  AUDIT_NAMES,
  CHECK_NAMES,
  ENTITY_NAMES,
  SETTING_NAMES,
  SOURCE_NAMES,
  StatusCard,
  StatusPill,
  ago,
  type AdminTab,
  type StatusTone,
} from '@/components/admin/admin-ui';
import { Card, CardHeader, DataTable, Td, Th } from '@/components/ui/primitives';
import { can } from '@/lib/auth/scope';
import { getSessionUser } from '@/lib/auth/session';
import { getDb } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import { connectorStatuses } from '@/lib/connectors';
import { seedLoadRunIds } from '@/lib/data-mode';
import { syncableSources } from '@/lib/etl/ingest';
import { listClassMap } from '@/lib/etl/class-map';
import { loadDataHealth } from '@/lib/etl/health';
import { formatMonth } from '@/lib/semantic/periods';

export const metadata: Metadata = { title: 'Admin' };
export const dynamic = 'force-dynamic';

/**
 * Admin: connections, data, controls, people and settings.
 *
 * It used to be ten sections in one long scroll with no statement of whether
 * anything was wrong. It now opens on an overview — four status cards and a
 * list of exactly what needs doing, each with the one place to fix it — and
 * everything else sits in tabs whose badges say where attention is needed. The
 * tab is in the URL, so a refresh keeps it and a link can point straight at it.
 *
 * The components that do the work (connecting, pulling, class mapping, people)
 * are unchanged; this is how they are found.
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
  const seedRuns = await seedLoadRunIds(db);
  const notSeed = seedRuns.length
    ? sql`${t.loadRun.id} <> all(${sql.raw(`ARRAY[${seedRuns.map((id) => `'${id}'`).join(',')}]::uuid[]`)})`
    : sql`true`;

  const [config, recentRuns, reconSummary, failingChecks, auditTrail, userRows, accessRows, divisionRows, classMap, dataHealth, lastGood, loadedRows] =
    await Promise.all([
      db.select().from(t.appConfig).orderBy(t.appConfig.key),
      db.select().from(t.loadRun).where(notSeed).orderBy(desc(t.loadRun.startedAt)).limit(60),
      db
        .select({
          checkId: t.reconResult.checkId,
          passed: sql<number>`count(*) filter (where status = 'PASS')::int`,
          failed: sql<number>`count(*) filter (where status = 'FAIL')::int`,
          ranAt: sql<Date>`max(ran_at)`,
        })
        .from(t.reconResult)
        .where(sql`ran_at = (select max(ran_at) from recon_result)`)
        .groupBy(t.reconResult.checkId),
      db
        .select()
        .from(t.reconResult)
        .where(sql`status = 'FAIL' and ran_at = (select max(ran_at) from recon_result)`)
        .limit(50),
      db.select().from(t.auditEvent).orderBy(desc(t.auditEvent.createdAt)).limit(50),
      db.select().from(t.users).orderBy(t.users.name),
      db.select().from(t.userDivisionAccess),
      db.select().from(t.dimDivision).where(eq(t.dimDivision.isActive, true)).orderBy(t.dimDivision.sortOrder),
      listClassMap(db),
      loadDataHealth(db),
      db
        .select({ finishedAt: t.loadRun.finishedAt, sourceSystem: t.loadRun.sourceSystem })
        .from(t.loadRun)
        .where(sql`${t.loadRun.status} = 'SUCCEEDED' and ${notSeed}`)
        .orderBy(sql`${t.loadRun.finishedAt} desc nulls last`)
        .limit(1),
      db
        .select({ total: sql<number>`coalesce(sum(rows_written), 0)::int` })
        .from(t.loadRun)
        .where(sql`${t.loadRun.status} = 'SUCCEEDED' and ${notSeed}`),
    ]);

  const connectors = await connectorStatuses();
  const sources = await syncableSources();
  const composioReady = connectors.some((connector) => connector.connectVia === 'composio');
  const canManageData = can(user, 'RUN_INGESTION');
  const canManageUsers = can(user, 'MANAGE_USERS');

  // --- Status -------------------------------------------------------------
  const connectedCount = connectors.filter((c) => c.isConfigured).length;
  const lastPull = lastGood[0]?.finishedAt ?? null;
  const hoursSincePull = lastPull ? (Date.now() - lastPull.getTime()) / 3_600_000 : null;
  const freshness: StatusTone =
    hoursSincePull === null ? 'critical' : hoursSincePull <= 36 ? 'good' : hoursSincePull <= 96 ? 'warning' : 'critical';
  const checksTotal = reconSummary.reduce((sum, row) => sum + row.passed + row.failed, 0);
  const checksFailed = reconSummary.reduce((sum, row) => sum + row.failed, 0);
  const awaiting = config.filter((row) => !row.isConfirmed);
  const unmapped = classMap.filter((row) => row.decision === 'UNMAPPED');
  const blocked = dataHealth.entities.filter((entity) => entity.state === 'BLOCKED');

  const tabs: AdminTab[] = [
    { id: 'overview', label: 'Overview' },
    {
      id: 'connections',
      label: 'Connections',
      badge: `${connectedCount}/${connectors.length}`,
      badgeTone: connectedCount === connectors.length ? 'good' : 'warning',
    },
    {
      id: 'data',
      label: 'Data & pulls',
      badge: blocked.length ? String(blocked.length) : undefined,
      badgeTone: 'critical',
    },
    {
      id: 'checks',
      label: 'Data checks',
      badge: checksTotal ? (checksFailed ? String(checksFailed) : '✓') : undefined,
      badgeTone: checksFailed ? 'critical' : 'good',
    },
    ...(classMap.length
      ? [{ id: 'mapping', label: 'Class mapping', badge: unmapped.length ? String(unmapped.length) : undefined, badgeTone: 'warning' as const }]
      : []),
    ...(canManageUsers ? [{ id: 'people', label: 'People & access', badge: String(userRows.length) }] : []),
    { id: 'settings', label: 'Settings', badge: awaiting.length ? String(awaiting.length) : undefined, badgeTone: 'warning' },
    { id: 'audit', label: 'Audit trail' },
  ];

  const requested = typeof query.tab === 'string' ? query.tab : null;
  const tab =
    requested && tabs.some((candidate) => candidate.id === requested)
      ? requested
      : connectError || justConnected
        ? 'connections'
        : 'overview';

  // The audit pack defaults to the last completed month, not a seeded setting.
  const now = new Date();
  const lastComplete = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);

  // --- What needs doing ---------------------------------------------------
  const attention: Array<{ tone: StatusTone; title: string; detail: string; href: string; action: string }> = [];
  for (const connector of connectors.filter((c) => !c.isConfigured)) {
    attention.push({
      tone: 'warning',
      title: `${connector.label} is not connected`,
      detail: `Nothing from ${connector.label} reaches the dashboards until it is connected.`,
      href: '/admin?tab=connections',
      action: 'Connect',
    });
  }
  if (unmapped.length) {
    attention.push({
      tone: 'critical',
      title: `${unmapped.length} QuickBooks class${unmapped.length === 1 ? '' : 'es'} not assigned to a division`,
      detail: `${unmapped.map((row) => row.className).slice(0, 5).join(', ')}${unmapped.length > 5 ? '…' : ''}. A month containing an unassigned class is refused rather than loaded wrong.`,
      href: '/admin?tab=mapping',
      action: 'Assign',
    });
  }
  for (const entity of blocked.slice(0, 4)) {
    attention.push({
      tone: 'critical',
      title: `${entity.sourceLabel} · ${entity.entityLabel} did not load`,
      detail: entity.detail,
      href: '/admin?tab=data',
      action: 'See why',
    });
  }
  if (checksFailed) {
    attention.push({
      tone: 'critical',
      title: `${checksFailed} data check${checksFailed === 1 ? '' : 's'} failing`,
      detail: failingChecks
        .slice(0, 2)
        .map((row) => `${row.checkName}${row.periodMonth ? ` (${formatMonth(row.periodMonth)})` : ''}`)
        .join('; '),
      href: '/admin?tab=checks',
      action: 'Review',
    });
  }
  if (freshness !== 'good' && connectedCount > 0) {
    attention.push({
      tone: freshness,
      title: lastPull ? `Data last refreshed ${ago(lastPull)}` : 'No data has been pulled yet',
      detail: 'Run a pull so the dashboards reflect what is in QuickBooks, HubSpot and Sheets today.',
      href: '/admin?tab=data',
      action: 'Pull now',
    });
  }
  if (awaiting.length) {
    attention.push({
      tone: 'warning',
      title: `${awaiting.length} setting${awaiting.length === 1 ? '' : 's'} awaiting a decision`,
      detail: awaiting.map((row) => SETTING_NAMES[row.key] ?? row.key).slice(0, 3).join('; '),
      href: '/admin?tab=settings',
      action: 'Decide',
    });
  }

  const managedUsers = userRows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role as string,
    canViewConsolidated: row.canViewConsolidated,
    divisions: accessRows.filter((a) => a.userId === row.id).map((a) => a.divisionCode),
    isActive: row.isActive,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
  }));

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[19px] font-semibold tracking-tight">Admin</h1>
          <p className="mt-1 max-w-2xl text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
            Connect the sources, pull the data, check it reconciles, and decide who sees what.
          </p>
        </div>
        <form action="/api/export/audit-pack" className="flex items-center gap-2">
          <label className="sr-only" htmlFor="pack-month">
            Audit pack month
          </label>
          <input
            id="pack-month"
            type="month"
            name="month"
            defaultValue={lastComplete}
            className="h-8 rounded-[var(--radius)] border px-2 text-[12px]"
            style={{ background: 'var(--surface-1)', borderColor: 'var(--border-strong)' }}
          />
          <button
            type="submit"
            className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius)] border px-3 text-[12px] font-medium hover:bg-[var(--surface-2)]"
            style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-1)' }}
            title="Every metric as the dashboards resolved it, the definitions, the P&L rows, the checks run fresh, load provenance, forecast locks and the assistant log — scoped to what you can see"
          >
            <Download size={13} aria-hidden />
            Audit pack
          </button>
        </form>
      </header>

      <AdminTabBar tabs={tabs} active={tab} />
      <PullIndicator onDataTab={tab === 'data'} />

      {connectError ? (
        <Banner tone="critical">{connectError}</Banner>
      ) : null}
      {justConnected ? (
        <Banner tone="good">
          {justConnected} is connected. Pull its data from <a className="underline" href="/admin?tab=data">Data &amp; pulls</a> — nothing is written until you confirm it.
        </Banner>
      ) : null}

      {/* --- Overview ------------------------------------------------------ */}
      {tab === 'overview' ? (
        <div className="space-y-5">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatusCard
              label="Connections"
              value={`${connectedCount} of ${connectors.length}`}
              context={connectors.map((c) => `${c.label} ${c.isConfigured ? '✓' : '—'}`).join(' · ')}
              tone={connectedCount === connectors.length ? 'good' : connectedCount ? 'warning' : 'critical'}
              href="/admin?tab=connections"
              action="Manage connections"
            />
            <StatusCard
              label="Last successful pull"
              value={ago(lastPull)}
              context={lastPull ? `${lastPull.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · ${(loadedRows[0]?.total ?? 0).toLocaleString()} rows loaded in total` : 'Nothing has been pulled from a source yet.'}
              tone={freshness}
              href="/admin?tab=data"
              action="Pull data"
            />
            <StatusCard
              label="Data checks"
              value={checksTotal ? (checksFailed ? `${checksFailed} failing` : 'All pass') : 'Not run'}
              context={checksTotal ? `${checksTotal.toLocaleString()} checks on the latest run — P&L ties to QuickBooks, balance sheet balances, nothing unmapped.` : 'Checks run automatically after every pull.'}
              tone={checksTotal ? (checksFailed ? 'critical' : 'good') : 'neutral'}
              href="/admin?tab=checks"
              action="See the checks"
            />
            <StatusCard
              label="Open decisions"
              value={awaiting.length ? String(awaiting.length) : 'None'}
              context={awaiting.length ? 'Settings that change what the dashboards compute are waiting on a decision.' : 'Every setting has been confirmed.'}
              tone={awaiting.length ? 'warning' : 'good'}
              href="/admin?tab=settings"
              action="Review settings"
            />
          </div>

          <Card padded={false}>
            <div className="border-b px-4 py-3" style={{ borderColor: 'var(--border)' }}>
              <h2 className="text-[13px] font-semibold tracking-tight">What needs doing</h2>
            </div>
            {attention.length ? (
              <ul>
                {attention.map((item, index) => (
                  <AttentionItem key={index} {...item} />
                ))}
              </ul>
            ) : (
              <p className="flex items-center gap-2 px-4 py-4 text-[12.5px]" style={{ color: 'var(--status-good)' }}>
                <CircleCheck size={15} aria-hidden />
                Everything is connected, current and reconciled. Nothing needs doing.
              </p>
            )}
          </Card>

          <Card>
            <CardHeader title="Recent activity" subtitle="The latest pulls from each source" />
            <LoadTable runs={recentRuns.slice(0, 6)} />
          </Card>
        </div>
      ) : null}

      {/* --- Connections --------------------------------------------------- */}
      {tab === 'connections' ? (
        <div className="space-y-3">
          <p className="max-w-3xl text-[12px] leading-relaxed text-[var(--text-secondary)]">
            {composioReady
              ? 'Sign in with the account that owns the data. There is no developer app, token or key file to manage — Composio holds the authorisation, and this system never receives a password or token. Every connection is read-only: nothing here can change QuickBooks, HubSpot or your spreadsheet.'
              : 'Set COMPOSIO_API_KEY in the environment to sign in to all three sources with one click. Without it, each source needs its own developer app or pasted credential. Every connection is read-only.'}
          </p>
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
                connectVia={connector.connectVia}
                signInLabel={connector.signInLabel}
                supportsManual={connector.supportsManual}
                needsSpreadsheet={connector.needsSpreadsheet}
                needsCompanyId={connector.needsCompanyId}
                canManage={can(user, 'EDIT_MAPPINGS')}
              />
            ))}
          </div>
        </div>
      ) : null}

      {/* --- Data & pulls -------------------------------------------------- */}
      {tab === 'data' ? (
        <div className="space-y-5">
          <DataControls connectedSources={sources} loadedRowCount={loadedRows[0]?.total ?? 0} canManage={canManageData} />
          <section id="data-health" className="scroll-mt-24 space-y-3">
            <div>
              <h2 className="text-[13px] font-semibold tracking-tight">What is loaded</h2>
              <p className="text-[11.5px] text-[var(--text-muted)]">
                Start here when a dashboard looks empty — each source and entity says whether it loaded, and if not, why.
              </p>
            </div>
            <DataHealthPanel health={dataHealth} canManage={canManageData} />
          </section>
          <Card>
            <CardHeader title="Pull log" subtitle="Every pull, newest first: what was fetched, what was new or changed and imported, and what was already up to date and left alone. Open “What happened” on any row." />
            <LoadTable runs={recentRuns} />
          </Card>
        </div>
      ) : null}

      {/* --- Data checks --------------------------------------------------- */}
      {tab === 'checks' ? (
        <div className="space-y-4">
          <p className="max-w-3xl text-[12px] leading-relaxed text-[var(--text-secondary)]">
            These run automatically after every pull. A failing check means a figure on a dashboard may not match
            QuickBooks — the dashboards say so in the header until it is resolved. Any difference over $1 needs an
            explanation: rounding and timing are valid reasons; “unknown” is not.
          </p>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {reconSummary.length === 0 ? (
              <Card>
                <p className="text-[12px] text-[var(--text-muted)]">No checks have run yet. They run after the first pull.</p>
              </Card>
            ) : (
              reconSummary
                .sort((a, b) => b.failed - a.failed)
                .map((row) => {
                  const meta = CHECK_NAMES[row.checkId] ?? { name: row.checkId, means: '' };
                  const total = row.passed + row.failed;
                  return (
                    <Card key={row.checkId}>
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h3 className="text-[13px] font-semibold tracking-tight">{meta.name}</h3>
                          <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--text-secondary)]">{meta.means}</p>
                        </div>
                        {row.failed ? (
                          <StatusPill tone="critical">
                            <CircleAlert size={11} aria-hidden /> {row.failed} failing
                          </StatusPill>
                        ) : (
                          <StatusPill tone="good">
                            <CircleCheck size={11} aria-hidden /> Pass
                          </StatusPill>
                        )}
                      </div>
                      <div className="mt-3 h-1.5 overflow-hidden rounded-full" style={{ background: 'var(--surface-2)' }} aria-hidden>
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${total ? (row.passed / total) * 100 : 0}%`,
                            background: row.failed ? 'var(--status-warning)' : 'var(--status-good)',
                          }}
                        />
                      </div>
                      <p className="mt-1.5 text-[11px] text-[var(--text-muted)]">
                        {row.passed.toLocaleString()} of {total.toLocaleString()} pass
                      </p>
                    </Card>
                  );
                })
            )}
          </div>
          {failingChecks.length ? (
            <Card padded={false}>
              <div className="border-b px-4 py-3" style={{ borderColor: 'var(--border)' }}>
                <h2 className="text-[13px] font-semibold tracking-tight">Failing on the latest run</h2>
              </div>
              <ul>
                {failingChecks.map((row) => (
                  <li key={row.id} className="flex items-start gap-3 border-b px-4 py-3 last:border-b-0" style={{ borderColor: 'var(--border)' }}>
                    <CircleAlert size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--status-critical)' }} aria-hidden />
                    <div>
                      <p className="text-[12.5px] font-medium">
                        {row.checkName}
                        {row.divisionCode ? ` — ${row.divisionCode}` : ''}
                        {row.periodMonth ? ` · ${formatMonth(row.periodMonth)}` : ''}
                      </p>
                      <p className="mt-0.5 text-[11.5px] leading-relaxed text-[var(--text-secondary)]">{row.detail}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
      ) : null}

      {/* --- Class mapping ------------------------------------------------- */}
      {tab === 'mapping' ? (
        <div className="space-y-3">
          <p className="max-w-3xl text-[12px] leading-relaxed text-[var(--text-secondary)]">
            QuickBooks separates divisions with classes. Each class must be assigned to a division, or marked as not a
            division (an allocation bucket such as Z Alloc, or Not Specified). A month containing an unassigned class is
            refused rather than loaded against the wrong division.
          </p>
          <ClassMapping
            rows={classMap}
            divisions={divisionRows.map((division) => ({ divisionCode: division.divisionCode, divisionName: division.divisionName }))}
            canEdit={can(user, 'EDIT_MAPPINGS')}
          />
        </div>
      ) : null}

      {/* --- People -------------------------------------------------------- */}
      {tab === 'people' && canManageUsers ? (
        <Card padded>
          <CardHeader title="People and access" subtitle="A role decides what someone can do; divisions decide what they can see." />
          <UserManager
            users={managedUsers}
            divisions={divisionRows.map((d) => ({ divisionCode: d.divisionCode, divisionName: d.divisionName }))}
            currentUserId={user.id}
          />
        </Card>
      ) : null}

      {/* --- Settings ------------------------------------------------------ */}
      {tab === 'settings' ? (
        <div className="space-y-3">
          <p className="max-w-3xl text-[12px] leading-relaxed text-[var(--text-secondary)]">
            Decisions that change what the dashboards compute. They are kept as data rather than buried in code, so
            every one is visible, and each says whether it has been confirmed.
          </p>
          <div className="grid gap-3 lg:grid-cols-2">
            {config
              .sort((a, b) => Number(a.isConfirmed) - Number(b.isConfirmed))
              .map((row) => (
                <Card key={row.key}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="text-[13px] font-semibold tracking-tight">{SETTING_NAMES[row.key] ?? row.key}</h3>
                      <code className="text-[10.5px] text-[var(--text-muted)]">{row.key}</code>
                    </div>
                    {row.isConfirmed ? (
                      <StatusPill tone="good">
                        <CircleCheck size={11} aria-hidden /> Confirmed
                      </StatusPill>
                    ) : (
                      <StatusPill tone="warning">
                        <CircleHelp size={11} aria-hidden /> Awaiting decision
                      </StatusPill>
                    )}
                  </div>
                  <p className="mt-2.5 rounded-[var(--radius)] px-2.5 py-1.5 font-mono text-[12px]" style={{ background: 'var(--surface-2)' }}>
                    {row.value || 'not set'}
                  </p>
                  {row.description ? (
                    <p className="mt-2.5 text-[11.5px] leading-relaxed text-[var(--text-secondary)]">{row.description}</p>
                  ) : null}
                  {row.updatedAt ? (
                    <p className="mt-2 text-[10.5px] text-[var(--text-muted)]">Last changed {ago(new Date(row.updatedAt))}</p>
                  ) : null}
                </Card>
              ))}
          </div>
        </div>
      ) : null}

      {/* --- Audit trail --------------------------------------------------- */}
      {tab === 'audit' ? (
        <Card>
          <CardHeader title="Audit trail" subtitle="Sign-ins, connections, pulls, exports, forecast locks and changes to access — the latest 50." />
          <DataTable maxHeight={600}>
            <thead>
              <tr>
                <Th align="left">When</Th>
                <Th align="left">What happened</Th>
                <Th align="left">By</Th>
                <Th align="left">Detail</Th>
              </tr>
            </thead>
            <tbody>
              {auditTrail.map((event) => (
                <tr key={event.id}>
                  <Td align="left" muted>
                    {new Date(event.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                  </Td>
                  <Td align="left" numeric={false}>
                    {AUDIT_NAMES[event.action] ?? event.action}
                  </Td>
                  <Td align="left" numeric={false} muted>
                    {userRows.find((u) => u.id === event.userId)?.name ?? '—'}
                  </Td>
                  <Td align="left" numeric={false} muted>
                    {[event.entity, event.entityId].filter(Boolean).join(' · ') || '—'}
                  </Td>
                </tr>
              ))}
            </tbody>
          </DataTable>
          {auditTrail.length === 0 ? <p className="pt-2 text-[12px] text-[var(--text-muted)]">No events recorded yet.</p> : null}
        </Card>
      ) : null}
    </div>
  );
}

function Banner({ tone, children }: { tone: 'good' | 'critical'; children: React.ReactNode }) {
  return (
    <div
      className="flex items-start gap-2 rounded-[var(--radius)] border p-3 text-[12px] leading-relaxed"
      style={{ borderColor: 'var(--border)', background: tone === 'good' ? 'var(--status-good-wash)' : 'var(--status-critical-wash)' }}
    >
      {tone === 'good' ? (
        <CircleCheck size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--status-good)' }} aria-hidden />
      ) : (
        <CircleAlert size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--status-critical)' }} aria-hidden />
      )}
      <span>{children}</span>
    </div>
  );
}

type LoadRunRow = typeof t.loadRun.$inferSelect;

/** The run's own account of itself: which months were new, changed or left alone. */
function notesOf(run: LoadRunRow): string[] {
  const plan = (run.plan ?? {}) as { notes?: unknown };
  return Array.isArray(plan.notes) ? (plan.notes.filter((note) => typeof note === 'string') as string[]) : [];
}

/** Succeeded without importing anything, because nothing had changed. */
function upToDate(run: LoadRunRow): boolean {
  return run.status === 'SUCCEEDED' && run.rowsWritten === 0 && notesOf(run).some((note) => /unchanged|nothing to fetch|not re-imported/i.test(note));
}

/** Pulls with a status you can read at a glance, and the reason for any that failed. */
function LoadTable({ runs }: { runs: LoadRunRow[] }) {
  if (!runs.length) {
    return <p className="text-[12px] text-[var(--text-muted)]">No pulls yet. Connect a source, then pull from Data &amp; pulls.</p>;
  }
  const toneOf = (status: string): StatusTone =>
    status === 'SUCCEEDED' ? 'good' : status === 'FAILED' ? 'critical' : status === 'ROLLED_BACK' ? 'neutral' : 'warning';
  const label = (status: string) =>
    ({ SUCCEEDED: 'Loaded', FAILED: 'Failed', RUNNING: 'Running', PREVIEW: 'Awaiting confirm', PENDING: 'Queued', ROLLED_BACK: 'Rolled back' })[status] ?? status;

  return (
    <DataTable dense>
      <thead>
        <tr>
          <Th align="left">Source</Th>
          <Th align="left">What</Th>
          <Th align="left">Months</Th>
          <Th align="left">Status</Th>
          <Th>Rows</Th>
          <Th align="left">When</Th>
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => (
          <tr key={run.id}>
            <Td align="left" numeric={false}>
              {SOURCE_NAMES[run.sourceSystem] ?? run.sourceSystem}
            </Td>
            <Td align="left" numeric={false}>
              {ENTITY_NAMES[run.entity] ?? run.entity}
            </Td>
            <Td align="left" numeric={false} muted>
              {run.windowStart ? `${run.windowStart.slice(0, 7)} → ${run.windowEnd?.slice(0, 7)}` : '—'}
            </Td>
            <Td align="left" numeric={false} className="!whitespace-normal">
              {upToDate(run) ? (
                <StatusPill tone="neutral">No changes</StatusPill>
              ) : (
                <StatusPill tone={toneOf(run.status)}>{label(run.status)}</StatusPill>
              )}
              {notesOf(run).length ? (
                <details className="mt-1 max-w-lg text-[11px] text-[var(--text-secondary)]">
                  <summary className="cursor-pointer text-[var(--text-muted)]">What happened</summary>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4 leading-relaxed">
                    {notesOf(run).map((note, index) => (
                      <li key={index}>{note}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
              {run.status === 'FAILED' && run.errorMessage ? (
                <details className="mt-1 max-w-md text-[11px] text-[var(--text-secondary)]">
                  <summary className="cursor-pointer text-[var(--text-muted)]">Why</summary>
                  <p className="mt-1 leading-relaxed">{run.errorMessage.slice(0, 600)}</p>
                </details>
              ) : null}
            </Td>
            <Td>{run.rowsWritten.toLocaleString()}</Td>
            <Td align="left" muted>
              {ago(run.finishedAt ?? run.startedAt)}
            </Td>
          </tr>
        ))}
      </tbody>
    </DataTable>
  );
}

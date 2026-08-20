import { Suspense } from 'react';
import { TriangleAlert } from 'lucide-react';
import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/auth/session';
import { getDb, isDemoMode } from '@/lib/db/client';
import { canSeeConsolidated, scopeDivisions } from '@/lib/auth/scope';
import { loadShellData } from '@/lib/dashboards/shell';
import { GlobalControls } from '@/components/shell/global-controls';
import { Sidebar } from '@/components/shell/sidebar';
import { AgentPanel } from '@/components/agent/agent-panel';
import { dimDivision } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  const db = await getDb();
  const allDivisions = (
    await db
      .select({ divisionCode: dimDivision.divisionCode })
      .from(dimDivision)
      .where(eq(dimDivision.isActive, true))
      .orderBy(dimDivision.sortOrder)
  ).map((row) => row.divisionCode);

  const visible = scopeDivisions(user, allDivisions);
  const shell = await loadShellData(visible, canSeeConsolidated(user, allDivisions));

  return (
    <div className="flex min-h-dvh">
      <Suspense fallback={<div className="w-[208px] shrink-0" />}>
        <Sidebar userName={user.name} userRole={user.role} />
      </Suspense>

      <div className="flex min-w-0 flex-1 flex-col">
        <Suspense fallback={<div className="h-[49px] border-b" style={{ borderColor: 'var(--border)' }} />}>
          <GlobalControls shell={shell} />
        </Suspense>

        {/* A demo instance says so, on every page. The figures are the spec's
            published ones and the controls are real, but the warehouse is
            in-memory and resets — and a reader who assumed otherwise would
            reasonably treat this as ARG's live reporting. */}
        {isDemoMode() && (
          <div
            className="flex items-center gap-2 border-b px-6 py-2 text-[11.5px]"
            style={{
              borderColor: 'var(--border)',
              background: 'var(--status-warning-wash)',
              color: 'var(--text-secondary)',
            }}
          >
            <TriangleAlert size={13} className="shrink-0" style={{ color: 'var(--status-warning)' }} aria-hidden />
            <span>
              <strong className="font-semibold">Demonstration instance.</strong> The warehouse is
              seeded in memory from the build spec&rsquo;s published figures and resets when the
              instance recycles. QuickBooks, HubSpot and Sheets are not connected, and sessions end
              on every deploy because there is no shared database to hold them. Set{' '}
              <code className="font-[var(--font-mono)]">DATABASE_URL</code> and{' '}
              <code className="font-[var(--font-mono)]">AUTH_SECRET</code> to make this a real
              deployment.
            </span>
          </div>
        )}
        {/* Bottom padding clears the floating assistant launcher. */}
        <main className="min-w-0 flex-1 px-6 pb-24 pt-5">{children}</main>
      </div>

      {/*
        §11 / client direction: the agent is present on every page rather than
        living in its own tab, so a request never has to restate the month,
        division or dashboard the user is already looking at.
      */}
      <Suspense fallback={null}>
        <AgentPanel />
      </Suspense>
    </div>
  );
}

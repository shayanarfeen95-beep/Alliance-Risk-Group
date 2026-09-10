import type { Metadata } from 'next';
import { getDb } from '@/lib/db/client';
import { loadDashboardContext, type SearchParams } from '@/lib/dashboards/context';
import { listViews } from '@/lib/views/store';
import { executeSavedView, ViewSpecError } from '@/lib/views/spec';
import { KPI_REGISTRY } from '@/lib/semantic/registry';
import { ChartCard } from '@/components/charts/chart-card';
import { ViewBuilder } from '@/components/dashboard/view-builder';
import { Card, CardHeader, EmptyState, Unavailable } from '@/components/ui/primitives';
import { deleteViewAction } from './actions';
import { Sparkles, Trash2 } from 'lucide-react';

export const metadata: Metadata = { title: 'Views' };
export const dynamic = 'force-dynamic';

/**
 * Views somebody built, and views the assistant built when asked to.
 *
 * The two are the same object. A chart the assistant saved is stored as the same
 * spec, validated by the same schema, and resolved by the same executor as one
 * built from the form — so there is no such thing as an "AI chart" that might
 * carry a number the dashboards would disagree with. The only difference is a
 * label saying which route it came in by, because that is worth knowing.
 */
export default async function ViewsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const context = await loadDashboardContext(await searchParams);
  const db = await getDb();
  const views = await listViews(db, context.user);

  const deals = context.session.bundle.deals;
  const tally = (pick: (deal: (typeof deals)[number]) => string) => {
    const counts = new Map<string, number>();
    for (const deal of deals) counts.set(pick(deal), (counts.get(pick(deal)) ?? 0) + 1);
    return [...counts.entries()]
      .map(([value, count]) => ({ value, deals: count }))
      .sort((a, b) => b.deals - a.deals);
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <h1 className="text-[19px] font-semibold tracking-tight">Views</h1>
          <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
            Questions the dashboards do not already answer — built here from filters, or by asking
            the assistant to build and keep one. A view stores a specification rather than a
            snapshot, so it re-reads the warehouse every time it is opened and shows each person
            only the divisions they are entitled to.
          </p>
        </div>
        <ViewBuilder
          month={context.session.period.month}
          fields={{
            stages: tally((deal) => deal.dealstage ?? 'Not recorded'),
            owners: tally((deal) => deal.ownerName ?? 'Unassigned'),
            sources: tally((deal) => deal.sourceLabel ?? 'Not recorded'),
          }}
          kpis={KPI_REGISTRY.map((kpi) => ({ id: kpi.id, name: kpi.name }))}
        />
      </header>

      {views.length === 0 ? (
        <EmptyState
          title="No views yet"
          detail="Press “Build a view” to make one from filters, or ask the assistant — “chart closed-won by lead source for the last six months and save it” — and it will appear here."
        />
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {views.map((view) => (
            <ViewCard key={view.id} view={view} session={context.session} />
          ))}
        </div>
      )}
    </div>
  );
}

function ViewCard({
  view,
  session,
}: {
  view: Awaited<ReturnType<typeof listViews>>[number];
  session: Awaited<ReturnType<typeof loadDashboardContext>>['session'];
}) {
  let chart;
  let failure: string | null = null;

  try {
    chart = executeSavedView(session, view.spec).chart;
  } catch (error) {
    // A view whose metric was renamed, or whose division this reader cannot
    // see, says so in place. It is not removed: the spec is still there to be
    // repaired, and a card that silently disappears teaches nobody anything.
    failure =
      error instanceof ViewSpecError
        ? error.message
        : error instanceof Error
          ? error.message
          : 'This view could not be resolved.';
  }

  return (
    <div className="relative">
      {chart ? (
        <ChartCard {...chart} />
      ) : (
        <Card>
          <CardHeader title={view.name} subtitle={view.description ?? undefined} />
          <Unavailable reason="VIEW_CANNOT_RESOLVE" detail={failure ?? 'Unknown error.'} />
        </Card>
      )}

      <div className="mt-1.5 flex items-center gap-2 px-1">
        {view.createdByAgent && (
          <span className="flex items-center gap-1 text-[10.5px] text-[var(--text-muted)]">
            <Sparkles size={10} aria-hidden />
            Built by the assistant
          </span>
        )}
        {view.description && (
          <span className="truncate text-[10.5px] text-[var(--text-muted)]">{view.description}</span>
        )}
        <form action={deleteViewAction} className="ml-auto">
          <input type="hidden" name="id" value={view.id} />
          <button
            type="submit"
            className="flex items-center gap-1 rounded-[5px] border px-1.5 py-0.5 text-[10.5px] text-[var(--text-muted)]"
            style={{ borderColor: 'var(--border)' }}
          >
            <Trash2 size={10} aria-hidden />
            Remove
          </button>
        </form>
      </div>
    </div>
  );
}

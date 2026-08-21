import { Sparkles } from 'lucide-react';
import { getDb } from '@/lib/db/client';
import { listBoxes } from '@/lib/ai/boxes';
import { executeViewSpec, ViewSpecError } from '@/lib/ai/viewspec';
import { buildKpiTile } from '@/lib/dashboards/tiles';
import { CONSOLIDATED_CODE } from '@/lib/semantic/resolve';
import type { DashboardContext, PinnablePageName } from '@/lib/dashboards/context';
import { KpiTile } from './kpi-tile';
import { BoxFilter } from './box-filter';
import { RemoveBox } from './remove-box';
import { ChartCard } from '@/components/charts/chart-card';
import { SectionTitle } from '@/components/ui/primitives';

/**
 * Boxes the assistant built for this reader, on this dashboard.
 *
 * They render through the same components and the same resolver as the built-in
 * boxes, and they carry the same per-box filter. A box somebody asked for in
 * conversation is not a lesser object than one that shipped with the app — it is
 * the same object, specified a different way.
 */
export async function PinnedBoxes({
  page,
  context,
}: {
  page: PinnablePageName;
  context: DashboardContext;
}) {
  const db = await getDb();
  const boxes = await listBoxes(db, context.user, page);
  if (boxes.length === 0) return null;

  return (
    <section>
      <SectionTitle hint="Built by the assistant, saved to this dashboard, and removable">
        Your boxes
      </SectionTitle>

      <div className="grid gap-3 lg:grid-cols-2">
        {boxes.map((box) => {
          const scope = context.boxScope(`pin_${box.id.replace(/-/g, '')}`);

          if (box.spec.kind === 'tile') {
            // A box pinned to a division keeps that division unless its own
            // filter says otherwise; the filter always wins, because it is the
            // control the reader just touched.
            const divisionCode = scope.divisionOverridden
              ? scope.divisionCode
              : (box.spec.division ?? scope.divisionCode);

            const tile = buildKpiTile(
              { ...scope, divisionCode },
              box.spec.metric,
              box.spec.hint ?? '',
            );

            return (
              <div key={box.id} className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <KpiTile
                    {...tile}
                    name={box.title}
                    box={{
                      ...tile.box!,
                      divisionOverridden: divisionCode !== context.divisionCode,
                      overrideLabel:
                        divisionCode !== context.divisionCode || scope.monthOverridden
                          ? scope.overrideLabel ?? labelFor(context, divisionCode)
                          : null,
                    }}
                    boxOptions={context.boxFilterOptions}
                  />
                </div>
                <RemoveBox boxId={box.id} title={box.title} />
              </div>
            );
          }

          // Charts: the stored spec, re-executed. A division override on the box
          // narrows the spec rather than replacing it.
          let chart;
          try {
            chart = executeViewSpec(scope.session, {
              ...box.spec.view,
              title: box.title,
              ...(scope.divisionOverridden && scope.divisionCode !== CONSOLIDATED_CODE
                ? { divisions: [scope.divisionCode] }
                : {}),
            }).chart;
          } catch (error) {
            return (
              <div
                key={box.id}
                className="rounded-[var(--radius-lg)] border p-4 text-[11.5px] leading-relaxed"
                style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
              >
                <p className="mb-1 flex items-center gap-1.5 font-medium text-[var(--text-secondary)]">
                  <Sparkles size={12} aria-hidden />
                  {box.title}
                </p>
                {/* A saved box whose spec no longer resolves says why, rather
                    than rendering an empty chart. */}
                {error instanceof ViewSpecError ? error.message : 'This box could not be rendered.'}
                <div className="mt-2">
                  <RemoveBox boxId={box.id} title={box.title} />
                </div>
              </div>
            );
          }

          return (
            <div key={box.id} className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <ChartCard
                  {...chart}
                  filter={<BoxFilter state={toState(scope)} options={context.boxFilterOptions} />}
                />
              </div>
              <RemoveBox boxId={box.id} title={box.title} />
            </div>
          );
        })}
      </div>
    </section>
  );
}

function labelFor(context: DashboardContext, divisionCode: string): string {
  if (divisionCode === CONSOLIDATED_CODE) return 'ARG Total';
  return (
    context.boxFilterOptions.divisions.find((d) => d.divisionCode === divisionCode)?.divisionName ??
    divisionCode
  );
}

function toState(scope: ReturnType<DashboardContext['boxScope']>) {
  return {
    boxId: scope.boxId,
    divisionCode: scope.divisionCode,
    month: scope.month,
    divisionOverridden: scope.divisionOverridden,
    monthOverridden: scope.monthOverridden,
    overrideLabel: scope.overrideLabel,
  };
}

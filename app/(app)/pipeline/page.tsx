import type { Metadata } from 'next';
import { and, gte, lte } from 'drizzle-orm';
import { KanbanSquare } from 'lucide-react';
import { loadDashboardContext, type SearchParams } from '@/lib/dashboards/context';
import { loadPipeline } from '@/lib/dashboards/pipeline';
import { monthBounds, formatMonth } from '@/lib/semantic/periods';
import { getDb } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import { formatNumber } from '@/lib/format';
import { KpiTile } from '@/components/dashboard/kpi-tile';
import { BoxFilter } from '@/components/dashboard/box-filter';
import { PinnedBoxes } from '@/components/dashboard/pinned-boxes';
import { PipelineBoard } from '@/components/dashboard/pipeline-board';
import { OwnerFilter } from '@/components/dashboard/owner-filter';
import { Card, CardHeader, DataTable, SectionTitle, Td, Th, Unavailable } from '@/components/ui/primitives';

export const metadata: Metadata = { title: 'Pipeline' };
export const dynamic = 'force-dynamic';

/**
 * The leadership pipeline — what ARG reads in HubSpot, read here.
 *
 * The 13 Aug next-steps list asks for the HubSpot Leadership Dashboard to be
 * built in this app. This is that view: the board first, because that is the
 * question ("where is everything, and what is stuck"), then who owns it, then
 * what actually moved in the window.
 *
 * Every figure still resolves through the semantic layer, so the tiles here and
 * the tiles on Sales are the same numbers by construction rather than by two
 * pieces of code agreeing.
 */
export default async function PipelinePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const context = await loadDashboardContext(await searchParams);
  const { session, divisionCode, range, owners, ownerName } = context;
  const boxOptions = context.boxFilterOptions;

  // Stage history for the window, plus a year back so "days in stage" is
  // knowable for deals that entered their stage before the range began.
  const db = await getDb();
  const historyFrom = new Date(`${range.from}T00:00:00Z`);
  historyFrom.setUTCFullYear(historyFrom.getUTCFullYear() - 1);
  const historyTo = monthBounds(range.to).endExclusive;

  const stageEntries = await db
    .select({
      dealId: t.factDealStageHistory.dealId,
      stage: t.factDealStageHistory.stage,
      enteredAt: t.factDealStageHistory.enteredAt,
    })
    .from(t.factDealStageHistory)
    .where(
      and(
        gte(t.factDealStageHistory.enteredAt, historyFrom),
        lte(t.factDealStageHistory.enteredAt, historyTo),
      ),
    );

  const model = loadPipeline(session, divisionCode, {
    range,
    ownerName,
    boxScope: context.boxScope,
    stageEntries,
  });

  const divisionLabel =
    divisionCode === 'ARG_TOTAL'
      ? 'ARG Total'
      : (session.bundle.divisions.find((d) => d.divisionCode === divisionCode)?.divisionName ??
        divisionCode);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[19px] font-semibold tracking-tight">Pipeline</h1>
        <p className="mt-1 max-w-2xl text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
          Where every open deal is, what it is worth weighted, and what has been sitting too long.
        </p>
        <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">
          {divisionLabel} · {formatMonth(session.period.month)} · sourced from HubSpot
        </p>
      </header>

      {model.unavailable ? (
        <Unavailable reason="NOT_AVAILABLE_BY_DIVISION" detail={model.unavailable} />
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        {model.tiles.map((tile) => (
          <KpiTile key={tile.box?.boxId ?? tile.name} {...tile} boxOptions={boxOptions} />
        ))}
      </div>

      {/* --- The board -------------------------------------------------- */}
      <Card>
        <CardHeader
          title="Open pipeline by stage"
          subtitle={
            model.totals.weighted !== null
              ? `${model.totals.open} open deals · ${formatNumber(
                  model.totals.openValue,
                  'currency',
                )} at face value · ${formatNumber(
                  model.totals.weighted,
                  'currency',
                )} weighted by stage probability. Plan against the weighted figure.`
              : `${model.totals.open} open deals · ${formatNumber(
                  model.totals.openValue,
                  'currency',
                )} at face value. No agreed stage probabilities, so nothing is weighted here rather than weighting on a guess.`
          }
          action={<BoxFilter state={model.boxes.board} options={boxOptions} />}
        />

        {model.totals.unattributed > 0 ? (
          <p
            className="mb-3 rounded-[var(--radius-sm)] px-2.5 py-2 text-[11px] leading-relaxed"
            style={{ background: 'var(--status-warning-wash)', color: 'var(--text-secondary)' }}
          >
            {model.totals.unattributed} open deal{model.totals.unattributed === 1 ? '' : 's'} carry
            no division. They count at ARG Total and are absent from every division row — map the
            values in Admin → HubSpot division mapping to place them.
          </p>
        ) : null}

        <PipelineBoard stages={model.stages} />
      </Card>

      {/* --- Who owns it ------------------------------------------------ */}
      <section>
        <SectionTitle hint="Open pipeline by owner, with closed results over the selected range">
          By salesperson
        </SectionTitle>
        <Card>
          <CardHeader
            title="Owners"
            subtitle={`Open deals as of the reporting date; won and lost within ${model.scopeLabel}. Win rate uses deals closed — won plus lost — as its denominator.`}
            action={
              <div className="flex items-center gap-2">
                <OwnerFilter owners={owners} selected={ownerName} />
                <BoxFilter state={model.boxes.owners} options={boxOptions} fields={['division']} />
              </div>
            }
          />
          {model.owners.length === 0 ? (
            <p className="text-[12px] text-[var(--text-muted)]">No deals in scope.</p>
          ) : (
            <DataTable>
              <thead>
                <tr>
                  <Th align="left">Salesperson</Th>
                  <Th>Open</Th>
                  <Th>Open value</Th>
                  <Th>Weighted</Th>
                  <Th>Won</Th>
                  <Th>Value won</Th>
                  <Th>Lost</Th>
                  <Th>Win rate</Th>
                </tr>
              </thead>
              <tbody>
                {model.owners.map((row) => (
                  <tr key={row.owner}>
                    <Td align="left" numeric={false}>
                      {row.owner}
                    </Td>
                    <Td>{row.open}</Td>
                    <Td>{formatNumber(row.openValue, 'currency')}</Td>
                    <Td muted>{row.weighted === null ? '—' : formatNumber(row.weighted, 'currency')}</Td>
                    <Td>{row.won}</Td>
                    <Td>{formatNumber(row.wonValue, 'currency')}</Td>
                    <Td muted>{row.lost}</Td>
                    <Td muted>
                      {row.winRate === null ? '—' : `${Math.round(row.winRate * 100)}%`}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
        </Card>
      </section>

      {/* --- What moved -------------------------------------------------- */}
      <Card>
        <CardHeader
          title={`Stage movement in ${model.scopeLabel}`}
          subtitle="Deals that ENTERED each stage in the window, from stage history rather than their current stage. A deal that entered Proposal in January and closed in March is counted at Proposal in January."
          action={<BoxFilter state={model.boxes.movement} options={boxOptions} fields={['division']} />}
        />
        {model.movement.length === 0 ? (
          <p className="flex items-start gap-2 text-[12px] leading-relaxed text-[var(--text-muted)]">
            <KanbanSquare size={13} className="mt-0.5 shrink-0" aria-hidden />
            No stage history landed for this window. Pull HubSpot deals — stage history comes with
            them — and this fills in.
          </p>
        ) : (
          <DataTable>
            <thead>
              <tr>
                <Th align="left">Stage</Th>
                <Th>Deals entered</Th>
                <Th>Value entered</Th>
              </tr>
            </thead>
            <tbody>
              {model.movement.map((row) => (
                <tr key={row.stage}>
                  <Td align="left" numeric={false}>
                    {row.label}
                  </Td>
                  <Td>{formatNumber(row.entered, 'count')}</Td>
                  <Td>{formatNumber(row.value, 'currency')}</Td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </Card>

      <PinnedBoxes page="pipeline" context={context} />
    </div>
  );
}

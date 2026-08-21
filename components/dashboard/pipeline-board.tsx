import { Clock, TriangleAlert } from 'lucide-react';
import { formatNumber } from '@/lib/format';
import type { PipelineStage } from '@/lib/dashboards/pipeline';

/**
 * The board.
 *
 * One column per stage, in stage order, scrolling sideways the way a pipeline
 * actually does. Each column states four things before any deal card is read:
 * how many, how much, what that is worth weighted, and how long deals have
 * typically been sitting there.
 *
 * The last one is the reason this view exists. A column of large numbers looks
 * healthy; a column of large numbers where the median age is 80 days is a
 * quarter that is not going to close.
 */
export function PipelineBoard({ stages }: { stages: PipelineStage[] }) {
  if (stages.length === 0) {
    return (
      <p className="text-[12px] text-[var(--text-muted)]">
        No open deals in scope. Closed deals are on the Sales dashboard.
      </p>
    );
  }

  return (
    <div className="scroll-x -mx-1 px-1 pb-2">
      <div className="flex min-w-max gap-3">
        {stages.map((stage) => (
          <section
            key={stage.id}
            className="flex w-[248px] shrink-0 flex-col rounded-[var(--radius)] border"
            style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}
            aria-label={`${stage.label}: ${stage.count} deals`}
          >
            <header
              className="border-b px-3 py-2.5"
              style={{ borderColor: 'var(--border)' }}
            >
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="truncate text-[12px] font-semibold">{stage.label}</h3>
                <span className="tnum shrink-0 text-[11px] text-[var(--text-muted)]">
                  {stage.count}
                </span>
              </div>

              <p className="tnum mt-1 text-[14px] font-semibold leading-none">
                {formatNumber(stage.value, 'currency')}
              </p>

              <p className="mt-1 text-[10.5px] leading-snug text-[var(--text-muted)]">
                {stage.weightedValue !== null ? (
                  <>
                    {formatNumber(stage.weightedValue, 'currency')} weighted at{' '}
                    {Math.round((stage.probability ?? 0) * 100)}%
                  </>
                ) : (
                  <>Unweighted — this stage carries no agreed probability</>
                )}
              </p>

              {stage.medianDaysInStage !== null ? (
                <p className="mt-1 flex items-center gap-1 text-[10.5px] text-[var(--text-muted)]">
                  <Clock size={10} aria-hidden />
                  {stage.medianDaysInStage} days here, typically
                </p>
              ) : null}
            </header>

            <ul className="flex-1 space-y-2 overflow-y-auto p-2" style={{ maxHeight: 420 }}>
              {stage.deals.map((deal) => (
                <li
                  key={deal.dealId}
                  className="rounded-[var(--radius-sm)] border p-2.5"
                  style={{
                    background: 'var(--surface-1)',
                    borderColor: deal.isStalled ? 'var(--status-warning)' : 'var(--border)',
                  }}
                >
                  <p className="truncate text-[11.5px] font-medium">{deal.name}</p>
                  <p className="tnum mt-0.5 text-[12px] font-semibold">
                    {formatNumber(deal.amount, 'currency')}
                  </p>

                  <p className="mt-1 truncate text-[10.5px] text-[var(--text-muted)]">
                    {deal.owner}
                    {deal.divisionCode ? ` · ${deal.divisionCode}` : ' · unattributed'}
                  </p>

                  <p className="mt-1 flex items-center gap-1 text-[10px] text-[var(--text-muted)]">
                    {deal.isStalled ? (
                      <TriangleAlert
                        size={10}
                        aria-hidden
                        style={{ color: 'var(--status-warning)' }}
                      />
                    ) : (
                      <Clock size={10} aria-hidden />
                    )}
                    {deal.daysInStage === null
                      ? 'no stage history'
                      : `${deal.daysInStage}d in stage`}
                    {deal.closedate ? ` · closes ${deal.closedate}` : ''}
                  </p>
                </li>
              ))}

              {stage.count > stage.deals.length ? (
                <li className="px-1 py-1 text-[10.5px] text-[var(--text-muted)]">
                  + {stage.count - stage.deals.length} more, largest first
                </li>
              ) : null}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

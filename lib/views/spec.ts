import 'server-only';
import { z } from 'zod';
import Decimal from 'decimal.js';
import { CONSOLIDATED_CODE, type SemanticSession } from '@/lib/semantic/resolve';
import { monthBounds, formatMonthShort, addMonths, monthRange } from '@/lib/semantic/periods';
import { SERIES_SLOTS } from '@/lib/charts/colors';
import {
  ViewSpecSchema,
  executeViewSpec,
  ViewSpecError,
  type ExecutedView,
} from '@/lib/ai/viewspec';
import type { ChartCardProps } from '@/components/charts/chart-card';

/**
 * Views a person or the assistant builds and keeps.
 *
 * There are two kinds, because ARG asks two shapes of question and one spec
 * cannot serve both:
 *
 *   **metric** — a KPI over months or divisions. This already existed as the
 *   agent's chart spec; it resolves through `resolveKpi`, so it inherits every
 *   definition the dashboards use and cannot state a number differently from
 *   them.
 *
 *   **pipeline** — deal records, grouped and filtered. "Closed-won by lead
 *   source", "open pipeline by stage for one rep". These cannot go through
 *   `resolveKpi`, because what is being asked for is not a metric with a
 *   definition — it is a cut of the deal table. So it is counted here, from the
 *   same records the HubSpot dashboard counts, with the filters printed on the
 *   face of the chart.
 *
 * A spec is stored; a result never is. Every view re-resolves when it is opened,
 * so it cannot preserve a figure that has since been restated, and it shows each
 * reader only what their own entitlements allow.
 */

export const PipelineViewSchema = z
  .object({
    kind: z.literal('pipeline'),
    title: z.string().min(1).max(120),
    subtitle: z.string().max(200).optional(),
    form: z.enum(['bar', 'horizontalBar', 'stackedBar', 'line', 'table']),
    /** What the bars are. */
    groupBy: z.enum(['stage', 'owner', 'source', 'pipeline', 'month']),
    /** What is being measured. */
    measure: z.enum(['amount', 'count']),
    /** Which deals count at all. */
    filters: z
      .object({
        status: z.enum(['all', 'open', 'won', 'lost', 'closed']).optional(),
        stages: z.array(z.string()).max(20).optional(),
        owners: z.array(z.string()).max(30).optional(),
        sources: z.array(z.string()).max(30).optional(),
        pipelines: z.array(z.string()).max(10).optional(),
        divisions: z.array(z.string()).max(8).optional(),
        minAmount: z.number().nonnegative().optional(),
        dateField: z.enum(['closedate', 'createdate']).optional(),
        trailingMonths: z.number().int().min(1).max(39).optional(),
      })
      .strict()
      .optional(),
    note: z.string().max(400).optional(),
  })
  .strict();

export type PipelineView = z.infer<typeof PipelineViewSchema>;

/** A metric chart, tagged so both kinds can live in one column. */
export const MetricViewSchema = ViewSpecSchema.extend({ kind: z.literal('metric') });

export const SavedViewSpecSchema = z.discriminatedUnion('kind', [
  MetricViewSchema,
  PipelineViewSchema,
]);

export type SavedViewSpec = z.infer<typeof SavedViewSpecSchema>;

export { ViewSpecError };
export type { ExecutedView };

const UNASSIGNED = 'Unassigned';
const UNRECORDED = 'Not recorded';

/**
 * Validates and executes a saved view.
 *
 * Rejections are loud on purpose. A view whose metric was renamed, or whose
 * division the reader is not entitled to, has to say so rather than quietly
 * rendering a smaller number.
 */
export function executeSavedView(session: SemanticSession, raw: unknown): ExecutedView {
  const parsed = SavedViewSpecSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ViewSpecError(
      `The view specification was rejected: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'spec'}: ${issue.message}`)
        .join('; ')}`,
    );
  }

  if (parsed.data.kind === 'metric') {
    const { kind: _kind, ...metric } = parsed.data;
    return executeViewSpec(session, metric);
  }

  return executePipelineView(session, parsed.data);
}

function executePipelineView(session: SemanticSession, spec: PipelineView): ExecutedView {
  const { bundle } = session;
  const filters = spec.filters ?? {};

  // Entitlements first, on the same rule as everywhere else: a view can never
  // show a division its reader cannot see, however it was written and whoever
  // shared it.
  const visible = session.visibleDivisions;
  const requested = filters.divisions?.filter((code) => code !== CONSOLIDATED_CODE);
  if (requested?.length) {
    const forbidden = requested.filter((code) => !visible.includes(code));
    if (forbidden.length) {
      throw new ViewSpecError(
        `Not entitled to ${forbidden.join(', ')}. This user can see: ${visible.join(', ') || 'no divisions'}.`,
      );
    }
  }
  const divisions = new Set(requested?.length ? requested : visible);

  const dateField = filters.dateField ?? 'closedate';
  const months = filters.trailingMonths ?? 12;
  const from = monthBounds(addMonths(session.period.month, -(months - 1))).start;
  const to = monthBounds(session.period.month).endExclusive;

  const deals = bundle.deals.filter((deal) => {
    if (deal.divisionCode !== null && !divisions.has(deal.divisionCode)) return false;

    const status = filters.status ?? 'all';
    if (status === 'open' && deal.isClosed) return false;
    if (status === 'won' && !deal.isClosedWon) return false;
    if (status === 'lost' && !(deal.isClosed && !deal.isClosedWon)) return false;
    if (status === 'closed' && !deal.isClosed) return false;

    if (filters.stages?.length && !filters.stages.includes(deal.dealstage ?? '')) return false;
    if (filters.owners?.length && !filters.owners.includes(deal.ownerName ?? UNASSIGNED)) {
      return false;
    }
    if (filters.sources?.length && !filters.sources.includes(deal.sourceLabel ?? UNRECORDED)) {
      return false;
    }
    if (filters.pipelines?.length && !filters.pipelines.includes(deal.pipeline ?? '')) return false;
    if (filters.minAmount !== undefined && deal.amount.lessThan(filters.minAmount)) return false;

    // An open deal has no close date, so a range on closedate would empty the
    // view the moment anybody narrowed the dates — open pipeline would vanish
    // from a chart of open pipeline. Open deals are in range by definition;
    // everything else has to fall inside it.
    const date = dateField === 'closedate' ? deal.closedate : deal.createdate;
    if (date === null) return dateField === 'closedate' && !deal.isClosed;
    return date >= from && date < to;
  });

  const keyOf = (deal: (typeof deals)[number]): string => {
    switch (spec.groupBy) {
      case 'stage':
        return deal.dealstage ?? UNRECORDED;
      case 'owner':
        return deal.ownerName ?? UNASSIGNED;
      case 'source':
        return deal.sourceLabel ?? UNRECORDED;
      case 'pipeline':
        return deal.pipeline ?? UNRECORDED;
      case 'month': {
        const date = dateField === 'closedate' ? deal.closedate : deal.createdate;
        if (!date) return UNRECORDED;
        return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-01`;
      }
    }
  };

  const totals = new Map<string, Decimal>();
  for (const deal of deals) {
    const key = keyOf(deal);
    const add = spec.measure === 'amount' ? deal.amount : new Decimal(1);
    totals.set(key, (totals.get(key) ?? new Decimal(0)).plus(add));
  }

  // A month axis runs in time order and keeps its empty months — a gap in
  // bookings is information, and dropping it draws a continuous line across a
  // month nothing closed in. Every other axis is ranked, largest first.
  const rows =
    spec.groupBy === 'month'
      ? monthRange(addMonths(session.period.month, -(months - 1)), session.period.month).map(
          (month) => ({
            key: month,
            label: formatMonthShort(month),
            value: totals.get(month) ?? new Decimal(0),
          }),
        )
      : [...totals.entries()]
          .map(([key, value]) => ({ key, label: key, value }))
          .sort((a, b) => b.value.comparedTo(a.value) || a.label.localeCompare(b.label));

  const valueFormat = spec.measure === 'amount' ? ('currency' as const) : ('count' as const);
  const note = spec.note ?? describeFilters(spec, months, dateField);

  const chart: ChartCardProps = {
    title: spec.title,
    subtitle: spec.subtitle,
    series: [
      { id: 'value', label: spec.measure === 'amount' ? 'Amount' : 'Deals', color: SERIES_SLOTS[0]! },
    ],
    data: rows.map((row) => ({ x: row.key, xLabel: row.label, value: row.value.toNumber() })),
    form: spec.form === 'table' ? 'bar' : spec.form,
    valueFormat,
    height: spec.form === 'horizontalBar' ? Math.max(220, rows.length * 34 + 40) : 280,
    note,
  };

  const total = rows.reduce((sum, row) => sum.plus(row.value), new Decimal(0));
  const populated = rows.filter((row) => !row.value.isZero()).length;

  return {
    chart,
    summary:
      `${spec.title}: ${deals.length} deal${deals.length === 1 ? '' : 's'} across ${populated} ` +
      `${spec.groupBy} group${populated === 1 ? '' : 's'}, totalling ` +
      (spec.measure === 'amount' ? `$${total.toFixed(0)}` : `${total.toFixed(0)} deals`),
  };
}

/**
 * The filters, in words, under the chart.
 *
 * A filtered chart that does not say what it filtered will be read as the whole
 * picture. This is the line that stops "closed-won by source" being taken for
 * all pipeline by source.
 */
export function describeFilters(
  spec: PipelineView,
  months: number,
  dateField: 'closedate' | 'createdate',
): string {
  const filters = spec.filters ?? {};
  const status = filters.status ?? 'all';

  const parts: string[] = [
    status === 'all'
      ? 'All deals'
      : status === 'open'
        ? 'Open deals'
        : status === 'won'
          ? 'Closed-won deals'
          : status === 'lost'
            ? 'Closed-lost deals'
            : 'Closed deals',
    `by ${dateField === 'closedate' ? 'close' : 'create'} date, last ${months} month${months === 1 ? '' : 's'}`,
  ];

  if (filters.owners?.length) parts.push(`owned by ${filters.owners.join(', ')}`);
  if (filters.sources?.length) parts.push(`sourced from ${filters.sources.join(', ')}`);
  if (filters.stages?.length) parts.push(`in stage ${filters.stages.join(', ')}`);
  if (filters.pipelines?.length) parts.push(`in pipeline ${filters.pipelines.join(', ')}`);
  if (filters.minAmount) parts.push(`at least $${filters.minAmount.toLocaleString()}`);

  return `${parts.join(' · ')}. Grouped by ${spec.groupBy}, measured by ${spec.measure}.`;
}

/** The JSON schema the model is given for building a pipeline view. */
export function pipelineViewJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'title', 'form', 'groupBy', 'measure'],
    properties: {
      kind: { const: 'pipeline', description: 'Always "pipeline" for a deal-based view.' },
      title: { type: 'string', description: 'What the view is called.' },
      subtitle: { type: 'string' },
      form: { type: 'string', enum: ['bar', 'horizontalBar', 'stackedBar', 'line', 'table'] },
      groupBy: {
        type: 'string',
        enum: ['stage', 'owner', 'source', 'pipeline', 'month'],
        description:
          'What the bars are. Use horizontalBar when grouping by source, owner or stage — those labels are words and will not fit side by side on an x axis.',
      },
      measure: { type: 'string', enum: ['amount', 'count'] },
      filters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['all', 'open', 'won', 'lost', 'closed'] },
          stages: { type: 'array', items: { type: 'string' } },
          owners: {
            type: 'array',
            items: { type: 'string' },
            description: 'Salesperson names exactly as they appear on deals.',
          },
          sources: { type: 'array', items: { type: 'string' } },
          pipelines: { type: 'array', items: { type: 'string' } },
          divisions: { type: 'array', items: { type: 'string' } },
          minAmount: { type: 'number' },
          dateField: { type: 'string', enum: ['closedate', 'createdate'] },
          trailingMonths: { type: 'integer', minimum: 1, maximum: 39 },
        },
      },
      note: { type: 'string' },
    },
  };
}

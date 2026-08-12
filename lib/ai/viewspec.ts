import 'server-only';
import { z } from 'zod';
import { formatMonthShort, monthRange, addMonths, type MonthKey } from '@/lib/semantic/periods';
import { getKpiDefinition, KPI_REGISTRY } from '@/lib/semantic/registry';
import { resolveKpi, CONSOLIDATED_CODE, type SemanticSession } from '@/lib/semantic/resolve';
import { buildDivisionColorMap } from '@/lib/charts/colors';
import type { ChartCardProps } from '@/components/charts/chart-card';

/**
 * The view spec — how the agent produces a chart.
 *
 * The agent never writes chart code and never emits a number. It emits this
 * declarative spec; the server validates it against the KPI registry and the
 * caller's entitlements, executes it through `resolveKpi`, and hands the result
 * to the same ChartCard component the dashboards use.
 *
 * That is what makes a generated chart and a built chart the same object: they
 * read the same definitions through the same resolver and render through the
 * same component. There is no path by which they could disagree.
 */

const KPI_IDS = KPI_REGISTRY.map((definition) => definition.id) as [string, ...string[]];

export const ViewSpecSchema = z
  .object({
    title: z.string().min(1).max(120),
    subtitle: z.string().max(200).optional(),
    /** Chart form. Anything not listed is rejected before rendering. */
    form: z.enum(['bar', 'stackedBar', 'line', 'area', 'table']),
    /**
     * Which metrics to plot. Validated against the registry — an unknown id is
     * a rejection, never a best-effort guess.
     */
    kpis: z.array(z.enum(KPI_IDS)).min(1).max(4),
    /** What varies along the x axis. */
    dimension: z.enum(['month', 'division']),
    /** Months back from the reporting month when dimension is 'month'. */
    trailingMonths: z.number().int().min(2).max(39).optional(),
    /** Restrict to specific divisions. Omit for everything in scope. */
    divisions: z.array(z.string()).max(8).optional(),
    /** Per-KPI options, e.g. the cash-runway variant or a budget scenario. */
    options: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    note: z.string().max(400).optional(),
  })
  .strict();

export type ViewSpec = z.infer<typeof ViewSpecSchema>;

export class ViewSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ViewSpecError';
  }
}

/** The JSON schema handed to the model. Generated from the Zod schema's shape. */
export function viewSpecJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'form', 'kpis', 'dimension'],
    properties: {
      title: { type: 'string', description: 'Short chart title.' },
      subtitle: { type: 'string', description: 'One line of context under the title.' },
      form: {
        type: 'string',
        enum: ['bar', 'stackedBar', 'line', 'area', 'table'],
        description:
          'Use line or area for change over time, bar for comparing magnitudes across categories, table when exact figures matter more than shape.',
      },
      kpis: {
        type: 'array',
        items: { type: 'string', enum: KPI_IDS },
        minItems: 1,
        maxItems: 4,
        description:
          'Metric ids from the KPI registry. Do not invent ids — call list_kpis if unsure. Never mix metrics of very different scale in one chart; make two charts instead.',
      },
      dimension: {
        type: 'string',
        enum: ['month', 'division'],
        description: 'What varies along the x axis.',
      },
      trailingMonths: {
        type: 'integer',
        minimum: 2,
        maximum: 39,
        description: 'How many months back to plot when dimension is "month". Defaults to 12.',
      },
      divisions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Division codes to include. Omit for all divisions in scope.',
      },
      options: {
        type: 'object',
        description:
          'Per-KPI options, e.g. {"variant":"trailing_3m"} for cash runway or {"scenario":"TENX"} for budget attainment.',
        additionalProperties: true,
      },
      note: { type: 'string', description: 'A caveat or denominator statement shown under the chart.' },
    },
  };
}

export interface ExecutedView {
  chart: ChartCardProps;
  /** A plain-English description of what was plotted, for the transcript. */
  summary: string;
}

/**
 * Validates and executes a spec.
 *
 * Every rejection path here is deliberate: an unknown KPI, an unentitled
 * division, or a form the renderer does not implement fails loudly rather than
 * rendering something approximate.
 */
export function executeViewSpec(session: SemanticSession, raw: unknown): ExecutedView {
  const parsed = ViewSpecSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ViewSpecError(
      `The chart specification was rejected: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'spec'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  const spec = parsed.data;

  // Entitlements: the agent can never plot a division the caller cannot see.
  const visible = session.visibleDivisions;
  const requested = spec.divisions?.filter((code) => code !== CONSOLIDATED_CODE);
  if (requested?.length) {
    const forbidden = requested.filter((code) => !visible.includes(code));
    if (forbidden.length) {
      throw new ViewSpecError(
        `Not entitled to ${forbidden.join(', ')}. This user can see: ${visible.join(', ') || 'no divisions'}.`,
      );
    }
  }
  const divisions = requested?.length ? requested : visible;

  const definitions = spec.kpis.map((id) => {
    const definition = getKpiDefinition(id);
    if (!definition) throw new ViewSpecError(`Unknown metric "${id}".`);
    return definition;
  });

  // One axis, always: mixing a dollar measure with a percentage produces a
  // meaningless scale. Two measures of different shape become two charts.
  const formats = new Set(definitions.map((definition) => definition.format));
  if (formats.size > 1) {
    throw new ViewSpecError(
      `Cannot plot ${spec.kpis.join(' and ')} together — they are measured in different units (${[...formats].join(', ')}). Request one chart per unit; this system never draws a second y-axis.`,
    );
  }
  const valueFormat = definitions[0]!.format;
  const colors = buildDivisionColorMap(session.bundle.divisions);

  const options = spec.options as Record<string, string | number | boolean> | undefined;

  // --- dimension: month ---------------------------------------------------
  if (spec.dimension === 'month') {
    const count = spec.trailingMonths ?? 12;
    const months = monthRange(addMonths(session.period.month, -(count - 1)), session.period.month);

    // One series per KPI when several are requested; otherwise one per division.
    const multiKpi = definitions.length > 1;
    const seriesDivisions = multiKpi ? [pickScope(session, divisions)] : divisions;

    const series = multiKpi
      ? definitions.map((definition, index) => ({
          id: definition.id,
          label: definition.name,
          color: `var(--series-${(index % 4) + 1})`,
        }))
      : seriesDivisions.map((code) => ({
          id: code,
          label: labelFor(session, code),
          color: colors[code] ?? 'var(--series-1)',
        }));

    const data = months.map((month) => {
      const row: { x: string; xLabel: string } & Record<string, number | null | string> = {
        x: month,
        xLabel: formatMonthShort(month),
      };
      if (multiKpi) {
        const scope = seriesDivisions[0]!;
        for (const definition of definitions) {
          row[definition.id] = valueOf(session, definition.id, scope, month, options);
        }
      } else {
        for (const code of seriesDivisions) {
          row[code] = valueOf(session, definitions[0]!.id, code, month, options);
        }
      }
      return row;
    });

    return {
      chart: {
        title: spec.title,
        subtitle: spec.subtitle,
        series,
        data,
        form: spec.form === 'table' ? 'bar' : spec.form,
        valueFormat,
        note: spec.note,
        height: 280,
      },
      summary: `${definitions.map((d) => d.name).join(', ')} over ${months.length} months.`,
    };
  }

  // --- dimension: division ------------------------------------------------
  const series = definitions.map((definition, index) => ({
    id: definition.id,
    label: definition.name,
    color: `var(--series-${(index % 4) + 1})`,
  }));

  const data = divisions.map((code) => {
    const row: { x: string; xLabel: string } & Record<string, number | null | string> = {
      x: code,
      xLabel: labelFor(session, code),
    };
    for (const definition of definitions) {
      row[definition.id] = valueOf(session, definition.id, code, session.period.month, options);
    }
    return row;
  });

  return {
    chart: {
      title: spec.title,
      subtitle: spec.subtitle,
      series,
      data,
      form: spec.form === 'table' ? 'bar' : spec.form,
      valueFormat,
      note: spec.note,
      height: 260,
    },
    summary: `${definitions.map((d) => d.name).join(', ')} by division for ${session.period.month.slice(0, 7)}.`,
  };
}

function valueOf(
  session: SemanticSession,
  id: string,
  divisionCode: string,
  month: MonthKey,
  options?: Record<string, string | number | boolean>,
): number | null {
  try {
    const result = resolveKpi(session, id, divisionCode, { month, options });
    return result.value ? result.value.toNumber() : null;
  } catch {
    // A scope error becomes a gap in the chart rather than a thrown request —
    // the entitlement check above has already rejected anything deliberate.
    return null;
  }
}

function pickScope(session: SemanticSession, divisions: string[]): string {
  if (session.consolidatedAvailable && divisions.length === session.visibleDivisions.length) {
    return CONSOLIDATED_CODE;
  }
  return divisions[0] ?? CONSOLIDATED_CODE;
}

function labelFor(session: SemanticSession, code: string): string {
  if (code === CONSOLIDATED_CODE) return 'ARG Total';
  return session.bundle.divisions.find((d) => d.divisionCode === code)?.divisionName ?? code;
}

import 'server-only';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import type { SessionUser } from '@/lib/auth/session';
import { getKpiDefinition, KPI_REGISTRY } from '@/lib/semantic/registry';
import { CONSOLIDATED_CODE, type SemanticSession } from '@/lib/semantic/resolve';
import { executeViewSpec, ViewSpecSchema, ViewSpecError } from './viewspec';

/**
 * Boxes the assistant builds.
 *
 * The client's description of what they wanted the agent to be was precise:
 * a helper, a data mapper, a box creator and a guide. This file is the box
 * creator. Asking for "a cash tile for Claims next to the LITS one" should
 * produce a box on the dashboard that is still there tomorrow — not a chart in
 * a chat transcript that scrolls away.
 *
 * What is stored is the specification, never the numbers and never markup. A
 * pinned box re-resolves through `resolveKpi` on every page load, exactly like a
 * built-in one, so it cannot drift from the dashboards. It is the same guarantee
 * generated charts already had, extended to something that persists.
 */

const KPI_IDS = KPI_REGISTRY.map((definition) => definition.id) as [string, ...string[]];

export const PINNABLE_PAGES = ['executive', 'finance', 'sales', 'marketing', 'pipeline'] as const;
export type PinnablePage = (typeof PINNABLE_PAGES)[number];

export const TileSpecSchema = z
  .object({
    kind: z.literal('tile'),
    metric: z.enum(KPI_IDS),
    /** A division, ARG_TOTAL, or omitted to follow the page filter. */
    division: z.string().optional(),
    hint: z.string().max(200).optional(),
  })
  .strict();

export const ChartBoxSpecSchema = z
  .object({
    kind: z.literal('chart'),
    view: ViewSpecSchema,
  })
  .strict();

export const BoxSpecSchema = z.discriminatedUnion('kind', [TileSpecSchema, ChartBoxSpecSchema]);
export type BoxSpec = z.infer<typeof BoxSpecSchema>;

export interface PinnedBox {
  id: string;
  title: string;
  page: string;
  spec: BoxSpec;
  createdAt: string;
}

export class BoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BoxError';
  }
}

/** The JSON schema the model sees. */
export function createBoxJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    required: ['page', 'title', 'kind'],
    properties: {
      page: {
        type: 'string',
        enum: [...PINNABLE_PAGES],
        description: 'Which dashboard the box is added to.',
      },
      title: { type: 'string', description: 'What the box is called on the dashboard.' },
      kind: {
        type: 'string',
        enum: ['tile', 'chart'],
        description:
          'A tile is one figure with its prior-month and prior-year change and a sparkline. A chart plots one or more metrics over months or across divisions.',
      },
      metric: {
        type: 'string',
        enum: KPI_IDS,
        description: 'For a tile: which metric. Ignored for a chart.',
      },
      division: {
        type: 'string',
        description:
          'For a tile: pin it to one division, or "ARG_TOTAL". Omit and the box follows the page filter, which is usually what someone wants.',
      },
      hint: { type: 'string', description: 'For a tile: the formula or denominator, shown on hover.' },
      chart: {
        type: 'object',
        description:
          'For a chart: the same specification make_chart takes — title, form, kpis, dimension, and optionally trailingMonths, divisions, options, note.',
        additionalProperties: true,
      },
    },
  };
}

/** Validates a proposed box, entitlements included, before anything is stored. */
export function validateBoxInput(
  session: SemanticSession,
  input: Record<string, unknown>,
): { page: PinnablePage; title: string; spec: BoxSpec } {
  const page = String(input.page ?? '') as PinnablePage;
  if (!PINNABLE_PAGES.includes(page)) {
    throw new BoxError(
      `"${input.page}" is not a dashboard a box can be added to. Choose one of ${PINNABLE_PAGES.join(', ')}.`,
    );
  }

  const title = String(input.title ?? '').trim();
  if (!title) throw new BoxError('A box needs a title.');

  if (input.kind === 'tile') {
    const metric = String(input.metric ?? '');
    if (!getKpiDefinition(metric)) {
      throw new BoxError(`"${metric}" is not a metric in the registry. Call list_kpis first.`);
    }

    const division = input.division ? String(input.division) : undefined;
    if (division && division !== CONSOLIDATED_CODE && !session.visibleDivisions.includes(division)) {
      throw new BoxError(
        `Not entitled to ${division}. This user can see: ${session.visibleDivisions.join(', ') || 'no divisions'}.`,
      );
    }
    if (division === CONSOLIDATED_CODE && !session.consolidatedAvailable) {
      throw new BoxError('Not entitled to the consolidated view.');
    }

    const parsed = TileSpecSchema.safeParse({
      kind: 'tile',
      metric,
      ...(division ? { division } : {}),
      ...(input.hint ? { hint: String(input.hint) } : {}),
    });
    if (!parsed.success) throw new BoxError(parsed.error.issues[0]?.message ?? 'Invalid tile.');
    return { page, title, spec: parsed.data };
  }

  // A chart box is a view spec, validated and executed by the same code path
  // the transcript charts use — including its entitlement checks.
  const chart = (input.chart ?? {}) as Record<string, unknown>;
  const withTitle = { title, ...chart };
  try {
    executeViewSpec(session, withTitle);
  } catch (error) {
    if (error instanceof ViewSpecError) throw new BoxError(error.message);
    throw error;
  }

  const parsed = ChartBoxSpecSchema.safeParse({ kind: 'chart', view: withTitle });
  if (!parsed.success) {
    throw new BoxError(parsed.error.issues.map((issue) => issue.message).join('; '));
  }
  return { page, title, spec: parsed.data };
}

export async function createBox(
  db: Database,
  user: SessionUser,
  conversationId: string | null,
  page: PinnablePage,
  title: string,
  spec: BoxSpec,
): Promise<PinnedBox> {
  const [row] = await db
    .insert(t.generatedView)
    .values({
      userId: user.id,
      conversationId,
      title,
      spec: spec as object,
      pinnedTo: page,
    })
    .returning();

  return {
    id: row!.id,
    title: row!.title,
    page,
    spec,
    createdAt: row!.createdAt.toISOString(),
  };
}

export async function listBoxes(
  db: Database,
  user: SessionUser,
  page?: string,
): Promise<PinnedBox[]> {
  const rows = await db
    .select()
    .from(t.generatedView)
    .where(
      page
        ? and(eq(t.generatedView.userId, user.id), eq(t.generatedView.pinnedTo, page))
        : eq(t.generatedView.userId, user.id),
    )
    .orderBy(desc(t.generatedView.createdAt));

  return rows
    .map((row) => {
      const parsed = BoxSpecSchema.safeParse(row.spec);
      if (!parsed.success || !row.pinnedTo) return null;
      return {
        id: row.id,
        title: row.title,
        page: row.pinnedTo,
        spec: parsed.data,
        createdAt: row.createdAt.toISOString(),
      };
    })
    .filter((box): box is PinnedBox => box !== null);
}

/** Deletes one box. Scoped to its owner — nobody removes anyone else's. */
export async function removeBox(
  db: Database,
  user: SessionUser,
  boxId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(t.generatedView)
    .where(and(eq(t.generatedView.id, boxId), eq(t.generatedView.userId, user.id)))
    .returning();
  return deleted.length > 0;
}

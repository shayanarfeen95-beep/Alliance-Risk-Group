import 'server-only';
import { asc, eq } from 'drizzle-orm';
import type { Database } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import type { SessionUser } from '@/lib/auth/session';

/**
 * Deciding what a QuickBooks class means.
 *
 * The decision belongs to whoever knows the business, not to whoever wrote the
 * seed file — so it is data, made here, recorded with a name against it.
 */

export type ClassDecision = 'UNMAPPED' | 'MAPPED' | 'EXCLUDED';

export interface ClassMapRow {
  classKey: string;
  classId: string | null;
  className: string;
  divisionCode: string | null;
  decision: ClassDecision;
  decidedAt: Date | null;
}

export async function listClassMap(db: Database): Promise<ClassMapRow[]> {
  const rows = await db.select().from(t.dimClassMap).orderBy(asc(t.dimClassMap.className));
  return rows.map((row) => ({
    classKey: row.classKey,
    classId: row.classId,
    className: row.className,
    divisionCode: row.divisionCode,
    decision: row.decision as ClassDecision,
    decidedAt: row.decidedAt,
  }));
}

export async function decideClass(
  db: Database,
  user: SessionUser,
  input: { classKey: string; divisionCode: string | null },
): Promise<void> {
  const [existing] = await db
    .select()
    .from(t.dimClassMap)
    .where(eq(t.dimClassMap.classKey, input.classKey))
    .limit(1);

  if (!existing) throw new Error('That class is not one QuickBooks has reported.');

  // An empty division is the explicit "this is not a division" answer, which is
  // a decision in its own right — an allocation bucket or an unclassified
  // catch-all is a real thing to have, and the alternative to recording it is a
  // month that never loads.
  const excluded = !input.divisionCode;

  if (!excluded) {
    const [division] = await db
      .select()
      .from(t.dimDivision)
      .where(eq(t.dimDivision.divisionCode, input.divisionCode!))
      .limit(1);
    if (!division) throw new Error(`No division called ${input.divisionCode}.`);
  }

  await db
    .update(t.dimClassMap)
    .set({
      divisionCode: excluded ? null : input.divisionCode,
      decision: excluded ? 'EXCLUDED' : 'MAPPED',
      decidedByUserId: user.id,
      decidedAt: new Date(),
    })
    .where(eq(t.dimClassMap.classKey, input.classKey));

  // Mapping a class changes what every divisional P&L says. That is exactly the
  // kind of change an auditor asks who made, and when.
  await db.insert(t.auditEvent).values({
    userId: user.id,
    action: excluded ? 'CLASS_EXCLUDED' : 'CLASS_MAPPED',
    entity: 'dim_class_map',
    entityId: input.classKey,
    detail: {
      className: existing.className,
      from: { decision: existing.decision, divisionCode: existing.divisionCode },
      to: { decision: excluded ? 'EXCLUDED' : 'MAPPED', divisionCode: input.divisionCode },
    },
  });
}

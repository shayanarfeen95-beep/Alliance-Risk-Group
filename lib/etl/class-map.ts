import 'server-only';
import { asc, eq, sql } from 'drizzle-orm';
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
  /** Months this class is currently keeping out of the warehouse. */
  blockingMonths: string[];
}

export async function listClassMap(db: Database): Promise<ClassMapRow[]> {
  const rows = await db.select().from(t.dimClassMap).orderBy(asc(t.dimClassMap.className));

  // Which months each undecided class is currently keeping out. Read from the
  // failed runs that named it, so the screen shows the consequence of the
  // decision rather than asking for it in the abstract.
  const failures = await db
    .select({ windowStart: t.loadRun.windowStart, error: t.loadRun.errorMessage })
    .from(t.loadRun)
    .where(sql`${t.loadRun.status} = 'FAILED' and ${t.loadRun.errorMessage} is not null`)
    .orderBy(sql`${t.loadRun.startedAt} desc`)
    .limit(50);

  return rows.map((row) => ({
    classKey: row.classKey,
    classId: row.classId,
    className: row.className,
    divisionCode: row.divisionCode,
    decision: row.decision as ClassDecision,
    decidedAt: row.decidedAt,
    blockingMonths:
      row.decision !== 'UNMAPPED'
        ? []
        : [
            ...new Set(
              failures
                .filter((failure) =>
                  (failure.error ?? '').toLowerCase().includes(row.className.toLowerCase()),
                )
                .map((failure) => (failure.windowStart ?? '').slice(0, 7))
                .filter(Boolean),
            ),
          ],
  }));
}

export async function decideClass(
  db: Database,
  user: SessionUser,
  input: { classKey: string; divisionCode: string | null },
): Promise<void> {
  // Found by key or by display name, because a class can have been noticed
  // under either — a report column carries a title, the class list an id.
  const { findClassRow } = await import('./conform');
  const found = await findClassRow(db, input.classKey);
  if (!found) {
    throw new Error(
      `No class called "${input.classKey}" has been reported by QuickBooks. Pull the class list ` +
        `again, or check the name.`,
    );
  }

  const [existing] = await db
    .select()
    .from(t.dimClassMap)
    .where(eq(t.dimClassMap.classKey, found.classKey))
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
    .where(eq(t.dimClassMap.classKey, existing.classKey));

  // Mapping a class changes what every divisional P&L says. That is exactly the
  // kind of change an auditor asks who made, and when.
  await db.insert(t.auditEvent).values({
    userId: user.id,
    action: excluded ? 'CLASS_EXCLUDED' : 'CLASS_MAPPED',
    entity: 'dim_class_map',
    entityId: existing.classKey,
    detail: {
      className: existing.className,
      from: { decision: existing.decision, divisionCode: existing.divisionCode },
      to: { decision: excluded ? 'EXCLUDED' : 'MAPPED', divisionCode: input.divisionCode },
    },
  });
}

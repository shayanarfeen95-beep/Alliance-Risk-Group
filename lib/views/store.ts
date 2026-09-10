import 'server-only';
import { desc, eq, and, or, isNull } from 'drizzle-orm';
import type { Database } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import type { SessionUser } from '@/lib/auth/session';
import { SavedViewSpecSchema, type SavedViewSpec } from './spec';

/**
 * Reading and writing saved views.
 *
 * Specs are validated on the way IN and again on the way OUT. Validating twice
 * is not belt-and-braces: a view saved last month may name a metric that has
 * since been renamed or a form the renderer no longer implements, and the
 * difference between "this view is stale, here is why" and a page that throws
 * is whether anything checked before rendering.
 */

export interface SavedViewRecord {
  id: string;
  name: string;
  description: string | null;
  spec: SavedViewSpec;
  createdByAgent: boolean;
  createdByUserId: string | null;
  pinnedTo: string | null;
  createdAt: Date;
}

export async function listViews(
  db: Database,
  user: SessionUser,
  options: { pinnedTo?: string } = {},
): Promise<SavedViewRecord[]> {
  // A private view belongs to whoever built it. Everything else is visible to
  // anybody who can open the page — safely, because a spec holds no data and
  // re-resolves against the reader's own entitlements.
  const rows = await db
    .select()
    .from(t.savedView)
    .where(
      and(
        or(eq(t.savedView.isShared, true), eq(t.savedView.createdByUserId, user.id)),
        options.pinnedTo === undefined
          ? undefined
          : options.pinnedTo === null
            ? isNull(t.savedView.pinnedTo)
            : eq(t.savedView.pinnedTo, options.pinnedTo),
      ),
    )
    .orderBy(t.savedView.sortOrder, desc(t.savedView.createdAt));

  return rows.flatMap((row) => {
    const parsed = SavedViewSpecSchema.safeParse(row.spec);
    // A row whose spec no longer parses is skipped rather than crashing the
    // page. It stays in the table so it can be repaired rather than vanishing.
    if (!parsed.success) return [];
    return [
      {
        id: row.id,
        name: row.name,
        description: row.description,
        spec: parsed.data,
        createdByAgent: row.createdByAgent,
        createdByUserId: row.createdByUserId,
        pinnedTo: row.pinnedTo,
        createdAt: row.createdAt,
      },
    ];
  });
}

export async function saveView(
  db: Database,
  user: SessionUser,
  input: {
    name: string;
    description?: string | null;
    spec: unknown;
    isShared?: boolean;
    pinnedTo?: string | null;
    byAgent?: boolean;
  },
): Promise<SavedViewRecord> {
  const parsed = SavedViewSpecSchema.safeParse(input.spec);
  if (!parsed.success) {
    throw new Error(
      `That view cannot be saved: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'spec'}: ${issue.message}`)
        .join('; ')}`,
    );
  }

  const name = input.name.trim();
  if (!name) throw new Error('A view needs a name.');

  const [row] = await db
    .insert(t.savedView)
    .values({
      name,
      description: input.description?.trim() || null,
      spec: parsed.data as object,
      createdByUserId: user.id,
      createdByAgent: input.byAgent ?? false,
      isShared: input.isShared ?? true,
      pinnedTo: input.pinnedTo ?? null,
    })
    .returning();

  // Building a view is a change to what the business looks at, so it is
  // attributable like every other change here.
  await db.insert(t.auditEvent).values({
    userId: user.id,
    action: input.byAgent ? 'VIEW_CREATED_BY_AGENT' : 'VIEW_CREATED',
    entity: 'saved_view',
    entityId: row!.id,
    detail: { name, spec: parsed.data },
  });

  return {
    id: row!.id,
    name: row!.name,
    description: row!.description,
    spec: parsed.data,
    createdByAgent: row!.createdByAgent,
    createdByUserId: row!.createdByUserId,
    pinnedTo: row!.pinnedTo,
    createdAt: row!.createdAt,
  };
}

export async function deleteView(
  db: Database,
  user: SessionUser,
  id: string,
): Promise<void> {
  const [row] = await db.select().from(t.savedView).where(eq(t.savedView.id, id)).limit(1);
  if (!row) throw new Error('That view no longer exists.');

  // Anyone may delete a view they built; only an administrator or the CFO may
  // remove one somebody else built and the team may be relying on.
  const owns = row.createdByUserId === user.id;
  if (!owns && user.role !== 'ADMIN' && user.role !== 'CFO') {
    throw new Error('Only the person who built this view, an administrator or the CFO can delete it.');
  }

  await db.delete(t.savedView).where(eq(t.savedView.id, id));
  await db.insert(t.auditEvent).values({
    userId: user.id,
    action: 'VIEW_DELETED',
    entity: 'saved_view',
    entityId: id,
    detail: { name: row.name },
  });
}

import { getDb } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import { sql } from 'drizzle-orm';
const db = await getDb();
const rows = await db
  .select({ name: t.factDeal.ownerName, count: sql<number>`count(*)::int` })
  .from(t.factDeal)
  .groupBy(t.factDeal.ownerName);
for (const r of rows) console.log(`  ${r.name ?? 'unassigned'} — ${r.count} deals`);

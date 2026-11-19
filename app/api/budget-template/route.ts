/**
 * A ready-to-fill budget template: one row per division per month, with
 * Revenue, COGS and OpEx across — the layout the upload reads.
 */
import { eq } from 'drizzle-orm';
import { getSessionUser } from '@/lib/auth/session';
import { getDb } from '@/lib/db/client';
import * as t from '@/lib/db/schema';

export const dynamic = 'force-dynamic';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export async function GET(request: Request) {
  const user = await getSessionUser();
  if (!user) return new Response('Sign in first.', { status: 401 });
  const requested = Number(new URL(request.url).searchParams.get('year'));
  const year = Number.isInteger(requested) && requested > 2000 ? requested : new Date().getUTCFullYear() + 1;

  const db = await getDb();
  const divisions = await db
    .select({ name: t.dimDivision.divisionName, code: t.dimDivision.divisionCode })
    .from(t.dimDivision)
    .where(eq(t.dimDivision.isActive, true))
    .orderBy(t.dimDivision.sortOrder);

  const lines = ['Year,Month,Division,Revenue,COGS,OpEx'];
  for (const division of divisions) {
    for (const month of MONTHS) lines.push(`${year},${month},${division.code},,,`);
  }
  return new Response(lines.join('\r\n') + '\r\n', {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="ARG-budget-${year}-template.csv"`,
    },
  });
}

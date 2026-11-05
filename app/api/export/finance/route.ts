import { getSessionUser } from '@/lib/auth/session';
import { getDb } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import { buildDivisionColorMap } from '@/lib/charts/colors';
import { loadFinance } from '@/lib/dashboards/finance';
import { financeCsv } from '@/lib/export/finance-csv';
import { CONSOLIDATED_CODE, openSemanticSession } from '@/lib/semantic/resolve';

export const dynamic = 'force-dynamic';

/**
 * Downloads the Finance P&L for a month and division as CSV.
 *
 * Scoped exactly like the page: the facts are loaded for what this user may
 * see, so a division manager's download cannot contain another division. The
 * export is recorded, as every copy of the figures is.
 */
export async function GET(request: Request) {
  const user = await getSessionUser();
  if (!user) return new Response('Your session has expired.', { status: 401 });

  const params = new URL(request.url).searchParams;
  const requested = params.get('month') ?? '';
  const month = /^\d{4}-\d{2}$/.test(requested) ? `${requested}-01` : /^\d{4}-\d{2}-01$/.test(requested) ? requested : null;
  if (!month) return new Response('A reporting month is required, as YYYY-MM.', { status: 400 });

  const db = await getDb();
  const session = await openSemanticSession(db, user, month);

  const asked = params.get('division') ?? CONSOLIDATED_CODE;
  const division =
    asked === CONSOLIDATED_CODE
      ? session.consolidatedAvailable
        ? CONSOLIDATED_CODE
        : null
      : session.visibleDivisions.includes(asked)
        ? asked
        : null;
  if (!division) return new Response('You are not entitled to that division.', { status: 403 });

  const model = loadFinance(session, division, buildDivisionColorMap(session.bundle.divisions));
  const csv = financeCsv(model);

  await db.insert(t.auditEvent).values({
    userId: user.id,
    action: 'FINANCE_EXPORTED',
    entity: 'finance_csv',
    entityId: `${month}|${division}`,
    detail: { bytes: csv.length },
  });

  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="arg-finance-${division.toLowerCase()}-${month.slice(0, 7)}.csv"`,
      'cache-control': 'no-store',
    },
  });
}

import { getSessionUser } from '@/lib/auth/session';
import { getDb } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import { buildAuditPack } from '@/lib/export/audit-pack';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * Downloads the audit pack for a month.
 *
 * Any signed-in user may export, and the pack contains exactly what that user
 * can see — the same entitlements that scope the dashboards scope the export,
 * because they are applied when the facts are loaded rather than when they are
 * displayed. The export itself is recorded: who took a copy of the figures and
 * when is part of the audit trail.
 */
export async function GET(request: Request) {
  const user = await getSessionUser();
  if (!user) {
    return new Response('Your session has expired.', { status: 401 });
  }

  const requested = new URL(request.url).searchParams.get('month');
  const month = /^\d{4}-\d{2}$/.test(requested ?? '')
    ? `${requested}-01`
    : /^\d{4}-\d{2}-01$/.test(requested ?? '')
      ? requested!
      : null;

  if (!month) {
    return new Response('A reporting month is required, as YYYY-MM.', { status: 400 });
  }

  const db = await getDb();
  const pack = await buildAuditPack(db, user, { month });

  await db.insert(t.auditEvent).values({
    userId: user.id,
    action: 'AUDIT_PACK_EXPORTED',
    entity: 'audit_pack',
    entityId: month,
    detail: { fileCount: pack.fileCount, bytes: pack.bytes.byteLength },
  });

  return new Response(pack.bytes as unknown as BodyInit, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${pack.filename}"`,
      'content-length': String(pack.bytes.byteLength),
      // The pack is a point-in-time artefact; a cached copy would misrepresent
      // the reconciliation status it reports.
      'cache-control': 'no-store',
    },
  });
}

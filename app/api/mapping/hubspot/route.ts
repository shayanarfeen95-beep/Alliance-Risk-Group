import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/scope';
import { getDb } from '@/lib/db/client';
import {
  saveHubspotMapping,
  type AttributionRule,
  ATTRIBUTION_RULES,
} from '@/lib/connectors/hubspot-mapping';
import { reconformLandedHubspot, describeConform } from '@/lib/etl/hubspot';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Saves the HubSpot division mapping, and re-applies it to everything landed.
 *
 * Re-applying is the point. A mapping that only affects future loads leaves the
 * warehouse in two states at once — deals pulled before the correction attributed
 * one way, deals after it another — and no one can tell by looking. Conform runs
 * from the raw landing, so the correction reaches every deal HubSpot has ever
 * sent without touching the API.
 */
export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Your session has expired.' }, { status: 401 });
  }
  if (!can(user, 'EDIT_MAPPINGS')) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'Only an administrator or the CFO can change the division mapping. It restates every divisional sales figure, so it is deliberately not a viewer-level control.',
      },
      { status: 403 },
    );
  }

  let body: {
    rule?: string;
    property?: string | null;
    values?: Record<string, string>;
    isConfirmed?: boolean;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed request.' }, { status: 400 });
  }

  const rule = body.rule as AttributionRule;
  if (!ATTRIBUTION_RULES.some((candidate) => candidate.id === rule)) {
    return NextResponse.json(
      { ok: false, error: `"${body.rule}" is not an attribution rule.` },
      { status: 400 },
    );
  }

  if (rule === 'deal_property' && !(body.property ?? '').trim()) {
    return NextResponse.json({
      ok: false,
      error:
        'Attributing by deal property needs the property name — the one on the HubSpot deal that carries the division.',
    });
  }

  const db = await getDb();

  const mapping = await saveHubspotMapping(db, user, {
    rule,
    property: body.property ?? null,
    values: body.values ?? {},
    isConfirmed: body.isConfirmed ?? false,
  });

  // Re-attribute what is already landed. Nothing to re-attribute is the normal
  // case before the first pull, and says so rather than looking like a failure.
  const conformed = await reconformLandedHubspot(db, 'deals');

  return NextResponse.json({
    ok: true,
    mapping,
    applied:
      conformed.written === 0
        ? 'Saved. No HubSpot deals have been landed yet, so there was nothing to re-attribute — the mapping applies to the next pull.'
        : `Saved. ${describeConform(conformed)}`,
    unattributed: conformed.unattributed,
  });
}

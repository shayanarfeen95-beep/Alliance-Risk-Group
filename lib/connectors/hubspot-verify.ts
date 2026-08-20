/**
 * Does this token actually work, and for what?
 *
 * The first version of this asked `/account-info/v3/details`, which needs the
 * `oauth` scope. A private app built for deals and contacts does not have that
 * scope — it is not in the CRM list anybody would pick — so HubSpot answered
 * 403 and a working token was reported as rejected. The check has to probe the
 * endpoints the connector will really call, and nothing else.
 *
 * It also reports scope by scope rather than pass/fail. "HubSpot rejected that
 * token" sends somebody to regenerate a token that was never the problem; the
 * fix is nearly always one unchecked box on the private app's scope list, and
 * this says which box.
 */
const API = 'https://api.hubapi.com';

/** Probe -> the scope a 403 on it implicates. */
const PROBES = [
  {
    key: 'deals',
    path: '/crm/v3/objects/deals?limit=1&properties=dealname',
    scope: 'crm.objects.deals.read',
    required: true,
    feeds: 'Dollars Booked, Pipeline Value, Booking Rate, Average Close Time',
  },
  {
    key: 'contacts',
    path: '/crm/v3/objects/contacts?limit=1&properties=lifecyclestage',
    scope: 'crm.objects.contacts.read',
    required: true,
    feeds: 'New Leads, Cost per Lead, Lead-to-Customer Rate',
  },
  {
    key: 'meetings',
    path: '/crm/v3/objects/meetings?limit=1&properties=hs_meeting_title',
    scope: 'crm.objects.meetings.read',
    required: false,
    feeds: 'Meetings Completed',
  },
  {
    key: 'owners',
    path: '/crm/v3/owners?limit=1',
    scope: 'crm.objects.owners.read',
    required: false,
    feeds: 'the salesperson filter and the owner leaderboard',
  },
] as const;

export type HubspotProbeKey = (typeof PROBES)[number]['key'];

export interface HubspotScopeReport {
  key: HubspotProbeKey;
  scope: string;
  granted: boolean;
  required: boolean;
  feeds: string;
}

export type HubspotTokenCheck =
  | {
      ok: true;
      portalId: string | null;
      label: string;
      scopes: HubspotScopeReport[];
      /** Present but degraded: optional scopes that were refused. */
      warnings: string[];
    }
  | { ok: false; error: string };

async function probe(
  token: string,
  path: string,
): Promise<{ status: number; body: string } | { status: -1; body: string }> {
  try {
    const response = await fetch(`${API}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    return { status: response.status, body: await response.text() };
  } catch (error) {
    return { status: -1, body: error instanceof Error ? error.message : 'network error' };
  }
}

/**
 * Verifies a private-app or OAuth access token against the endpoints this
 * connector reads.
 *
 * A 401 is fatal and means the token itself is wrong — revoked, mistyped, or
 * from a different HubSpot account. A 403 is not fatal: it means the token is
 * genuine and one scope is unchecked, which is a different conversation and
 * gets a different sentence.
 */
export async function verifyHubspotToken(token: string): Promise<HubspotTokenCheck> {
  const scopes: HubspotScopeReport[] = [];

  for (const spec of PROBES) {
    const result = await probe(token, spec.path);

    if (result.status === -1) {
      return {
        ok: false,
        error: `HubSpot could not be reached (${result.body}). Nothing was saved — this is a network problem, not a bad token.`,
      };
    }

    if (result.status === 401) {
      return {
        ok: false,
        error:
          'HubSpot says this token is not valid (HTTP 401). That means the token itself — not its ' +
          'scopes. Check you copied the whole value from Private Apps → your app → Auth, that it ' +
          'has not been rotated since, and that it belongs to the right HubSpot account.',
      };
    }

    if (result.status === 429) {
      return {
        ok: false,
        error:
          'HubSpot rate-limited the check (HTTP 429). The token may be perfectly good — wait a ' +
          'minute and try again. Nothing was saved.',
      };
    }

    // 403 means authenticated but not scoped. Anything else unexpected is
    // treated as not-granted too, and the body is surfaced rather than hidden.
    const granted = result.status >= 200 && result.status < 300;

    if (!granted && result.status !== 403) {
      return {
        ok: false,
        error: `HubSpot returned HTTP ${result.status} for ${spec.path.split('?')[0]}: ${result.body.slice(0, 200)}`,
      };
    }

    scopes.push({
      key: spec.key,
      scope: spec.scope,
      granted,
      required: spec.required,
      feeds: spec.feeds,
    });
  }

  const missingRequired = scopes.filter((s) => s.required && !s.granted);
  if (missingRequired.length > 0) {
    return {
      ok: false,
      error:
        `The token is valid, but the private app is missing ${missingRequired.length === 1 ? 'a scope' : 'scopes'}: ` +
        missingRequired.map((s) => s.scope).join(', ') +
        '. Add it in HubSpot under Private Apps → your app → Scopes, then paste the token again. ' +
        `Without it, ${missingRequired.map((s) => s.feeds).join('; ')} cannot be computed, so the ` +
        'connection is refused rather than saved half-working.',
    };
  }

  const account = await fetchPortalDetails(token);
  const warnings = scopes
    .filter((s) => !s.required && !s.granted)
    .map((s) => `${s.scope} is not granted, so ${s.feeds} will read as unavailable.`);

  return {
    ok: true,
    portalId: account?.portalId ?? null,
    label: account?.label ?? 'HubSpot private app',
    scopes,
    warnings,
  };
}

/**
 * The portal id, if the token happens to carry the `oauth` scope.
 *
 * Best effort on purpose. Knowing the portal number makes the admin screen say
 * which HubSpot account is connected rather than just "connected", which is
 * worth having — but it is a label, and a label must never be what fails a
 * connection.
 */
export async function fetchPortalDetails(
  token: string,
): Promise<{ portalId: string; label: string } | null> {
  const result = await probe(token, '/account-info/v3/details');
  if (result.status < 200 || result.status >= 300) return null;

  try {
    const body = JSON.parse(result.body) as { portalId?: number; uiDomain?: string };
    if (!body.portalId) return null;
    return {
      portalId: String(body.portalId),
      label: body.uiDomain
        ? `Portal ${body.portalId} · ${body.uiDomain}`
        : `Portal ${body.portalId}`,
    };
  } catch {
    return null;
  }
}

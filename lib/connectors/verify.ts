import 'server-only';

/**
 * Does this credential actually work?
 *
 * The previous check asked HubSpot `/account-info/v3/details` and treated any
 * non-200 as "HubSpot rejected that token". That endpoint needs the
 * `account-info.security.read` scope, which nobody ticks when they create a
 * private app for deals and contacts — so a perfectly good token was refused,
 * and the message blamed the token. This is the bug behind "I'm adding my
 * HubSpot token and it gives me an error".
 *
 * Two rules here, and they apply to every source:
 *
 *   1. **Verify against the endpoint the connector actually reads.** If the
 *      credential can fetch a deal, it can do this system's job, whatever else
 *      it cannot do. A check stricter than the work is a false negative
 *      generator.
 *   2. **Report what the provider said.** 401 means the token is wrong or
 *      expired; 403 means it is real but under-scoped; 429 means try again in a
 *      minute. Those are three different jobs for whoever is holding the
 *      screen, and collapsing them into one sentence turns a two-minute fix
 *      into an afternoon.
 */

export interface CredentialCheck {
  ok: boolean;
  /** Provider-side identity — portal id, realm id, spreadsheet id. */
  accountId?: string;
  /** Human-readable target, shown on the connector card. */
  label?: string;
  /** Operator-facing diagnosis when ok is false. Never contains the token. */
  error?: string;
  /** Shown even on success — an expiring token, a missing optional scope. */
  warning?: string;
  /** What the provider returned, for the runbook. */
  status?: number;
}

/** HubSpot private-app tokens look like `pat-na1-…`. */
const PRIVATE_APP_PREFIX = 'pat-';

/**
 * The shape of an OAuth access token, which people paste by mistake.
 *
 * HubSpot's OAuth access tokens are base64 and begin `Ci`. They are valid for
 * about thirty minutes, so pasting one produces a connection that works during
 * testing and is dead before the first overnight refresh — the worst kind of
 * failure, because it looks like success.
 */
function looksLikeOAuthAccessToken(token: string): boolean {
  return !token.startsWith(PRIVATE_APP_PREFIX) && /^Ci[A-Za-z0-9+/_-]{40,}={0,2}$/.test(token);
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string; category?: string; Fault?: unknown };
    if (typeof body.message === 'string' && body.message) return body.message;
    return JSON.stringify(body).slice(0, 300);
  } catch {
    return (await response.text().catch(() => '')).slice(0, 300) || 'no response body';
  }
}

/**
 * Verifies a HubSpot token by reading one deal — exactly what the connector does.
 */
export async function verifyHubspotToken(token: string): Promise<CredentialCheck> {
  const trimmed = token.trim();
  if (!trimmed) return { ok: false, error: 'A private-app token is required.' };

  const warnings: string[] = [];
  if (looksLikeOAuthAccessToken(trimmed)) {
    warnings.push(
      'That looks like an OAuth access token rather than a private-app token. HubSpot expires those after about 30 minutes, so the connection would go dead within the hour. A private-app token starts with "pat-" and does not expire — create one under Settings → Integrations → Private Apps.',
    );
  }

  let response: Response;
  try {
    response = await fetch('https://api.hubapi.com/crm/v3/objects/deals?limit=1', {
      headers: { authorization: `Bearer ${trimmed}`, accept: 'application/json' },
    });
  } catch (error) {
    return {
      ok: false,
      error: `Could not reach HubSpot at all: ${
        error instanceof Error ? error.message : 'network error'
      }. Nothing was saved.`,
    };
  }

  if (!response.ok) {
    const detail = await readError(response);

    if (response.status === 401) {
      return {
        ok: false,
        status: 401,
        error: `HubSpot rejected the token (401 ${detail}). ${
          looksLikeOAuthAccessToken(trimmed)
            ? 'It looks like an OAuth access token, and those expire after about 30 minutes — paste a private-app token, which starts with "pat-".'
            : 'Check it was copied whole, with no leading or trailing spaces.'
        } Nothing was saved.`,
      };
    }

    if (response.status === 403) {
      return {
        ok: false,
        status: 403,
        error: `The token is valid but the private app is missing a scope. HubSpot said: "${detail}". Add crm.objects.deals.read, crm.objects.contacts.read and, for meetings, crm.objects.meetings.read (sales-email-read is not needed). Nothing was saved.`,
      };
    }

    if (response.status === 429) {
      return {
        ok: false,
        status: 429,
        error:
          'HubSpot is rate-limiting this portal right now (429). The token may well be fine — wait a minute and connect again. Nothing was saved.',
      };
    }

    return {
      ok: false,
      status: response.status,
      error: `HubSpot returned ${response.status}: ${detail}. Nothing was saved.`,
    };
  }

  // The deals read succeeded, so the credential can do this system's job. The
  // portal label is a nicety: fetch it, and carry on without it if the app was
  // not granted account-info.
  let accountId = 'unknown';
  let label = 'HubSpot portal';

  try {
    const info = await fetch('https://api.hubapi.com/account-info/v3/details', {
      headers: { authorization: `Bearer ${trimmed}`, accept: 'application/json' },
    });
    if (info.ok) {
      const body = (await info.json()) as { portalId?: number; uiDomain?: string };
      if (body.portalId) {
        accountId = String(body.portalId);
        label = body.uiDomain
          ? `Portal ${body.portalId} · ${body.uiDomain}`
          : `Portal ${body.portalId}`;
      }
    } else {
      warnings.push(
        'Connected. The portal name is not shown because the app lacks the optional account-info.security.read scope — nothing else is affected.',
      );
    }
  } catch {
    // A failed nicety is not a failed connection.
  }

  return {
    ok: true,
    status: 200,
    accountId,
    label,
    ...(warnings.length ? { warning: warnings.join(' ') } : {}),
  };
}

/**
 * Verifies a QuickBooks connection by reading the company itself.
 *
 * `CompanyInfo` is the cheapest authenticated read Intuit offers and needs no
 * scope beyond the one the OAuth flow already required, so a failure here is a
 * real failure rather than a permissions quirk.
 */
export async function verifyQboToken(
  accessToken: string,
  realmId: string,
  environment: 'sandbox' | 'production' = 'production',
): Promise<CredentialCheck> {
  const host =
    environment === 'sandbox'
      ? 'https://sandbox-quickbooks.api.intuit.com'
      : 'https://quickbooks.api.intuit.com';

  let response: Response;
  try {
    response = await fetch(`${host}/v3/company/${realmId}/companyinfo/${realmId}?minorversion=70`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    });
  } catch (error) {
    return {
      ok: false,
      error: `Could not reach QuickBooks: ${
        error instanceof Error ? error.message : 'network error'
      }.`,
    };
  }

  if (!response.ok) {
    const detail = await readError(response);
    if (response.status === 401) {
      return {
        ok: false,
        status: 401,
        error: `QuickBooks rejected the access token (401 ${detail}). Intuit's access tokens last an hour and the refresh token rotates on every use — reconnect from Admin rather than pasting one by hand.`,
      };
    }
    if (response.status === 403) {
      return {
        ok: false,
        status: 403,
        error: `QuickBooks refused the request (403 ${detail}). Usually the app is connected to a different company than the realm id given, or the subscription does not include API access.`,
      };
    }
    return { ok: false, status: response.status, error: `QuickBooks returned ${response.status}: ${detail}.` };
  }

  try {
    const body = (await response.json()) as {
      CompanyInfo?: { CompanyName?: string; LegalName?: string };
    };
    const name = body.CompanyInfo?.CompanyName ?? body.CompanyInfo?.LegalName ?? null;
    return {
      ok: true,
      status: 200,
      accountId: realmId,
      label: name ? `${name} · realm ${realmId}` : `Realm ${realmId}`,
    };
  } catch {
    return { ok: true, status: 200, accountId: realmId, label: `Realm ${realmId}` };
  }
}

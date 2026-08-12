import { SignJWT, importPKCS8 } from 'jose';

/**
 * Google service-account authentication.
 *
 * Extracted from the Sheets connector so the Connect flow can verify a pasted
 * key before storing it. Verifying at connect time rather than at first refresh
 * is the whole point: sharing the spreadsheet with the service-account address
 * is a separate manual step in the Google UI that is very easy to forget, and
 * forgetting it produces a 403 during an overnight run instead of while somebody
 * is looking at the screen.
 */

export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Exchanges a service-account key for an access token. */
export async function signJwtAssertion(
  clientEmail: string,
  privateKeyPem: string,
  scope: string = SHEETS_SCOPE,
): Promise<string> {
  const privateKey = await importPKCS8(privateKeyPem.replace(/\\n/g, '\n'), 'RS256');
  const now = Math.floor(Date.now() / 1000);

  const assertion = await new SignJWT({ scope })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(clientEmail)
    .setAudience(GOOGLE_TOKEN_URL)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Google token exchange failed (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }

  return (JSON.parse(text) as { access_token: string }).access_token;
}

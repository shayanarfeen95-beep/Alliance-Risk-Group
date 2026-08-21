import 'server-only';
import { hasCredentialKey } from '@/lib/crypto/secrets';
import { OAUTH_PROVIDERS } from './oauth';

/**
 * What this deployment still needs before a source can be connected.
 *
 * The failure this prevents: somebody opens Admin, pastes a HubSpot token, and
 * is told after the fact that CREDENTIAL_KEY is not set. The environment could
 * have said so before they went and made the token. Everything here is derived
 * from the environment at request time, and no value is ever returned — only
 * whether it is present.
 */

export interface Requirement {
  /** The environment variable, named exactly as it must be set. */
  name: string;
  present: boolean;
  /** Why this system needs it. */
  purpose: string;
  /** How to produce a value. */
  howTo: string;
  /** Blocking, or merely nice to have. */
  severity: 'required' | 'optional';
}

export interface SourceReadiness {
  sourceSystem: string;
  label: string;
  /** Can a credential be stored and used at all right now? */
  ready: boolean;
  /** One sentence for whoever is holding the screen. */
  summary: string;
  requirements: Requirement[];
  /** The route that works today given what is set. */
  recommendedPath: string;
}

const CREDENTIAL_KEY: Requirement = {
  name: 'CREDENTIAL_KEY',
  present: false,
  purpose:
    'Encrypts every source credential before it reaches the database. Without it, connecting any source is refused rather than storing a token unprotected.',
  howTo: 'openssl rand -base64 32',
  severity: 'required',
};

function credentialKeyRequirement(): Requirement {
  return { ...CREDENTIAL_KEY, present: hasCredentialKey() };
}

function envRequirement(
  name: string,
  purpose: string,
  howTo: string,
  severity: Requirement['severity'] = 'required',
): Requirement {
  return { name, present: Boolean(process.env[name]), purpose, howTo, severity };
}

export function sourceReadiness(): SourceReadiness[] {
  const key = credentialKeyRequirement();
  const qbo = OAUTH_PROVIDERS.QBO!;
  const hubspot = OAUTH_PROVIDERS.HUBSPOT!;

  const hubspotRequirements: Requirement[] = [
    key,
    envRequirement(
      hubspot.clientIdEnv,
      'Only needed for one-click OAuth. A private-app token needs neither this nor the secret.',
      'HubSpot → Settings → Integrations → Private Apps (token), or create a public app for OAuth.',
      'optional',
    ),
    envRequirement(
      hubspot.clientSecretEnv,
      'Pairs with the client id for OAuth. Not needed for a private-app token.',
      'Same HubSpot app screen as the client id.',
      'optional',
    ),
  ];

  const qboRequirements: Requirement[] = [
    key,
    envRequirement(
      qbo.clientIdEnv,
      'Identifies ARG’s Intuit app during the QuickBooks authorisation round trip. There is no paste-a-token path for QuickBooks — Intuit access tokens last an hour.',
      'Intuit developer portal → your app → Keys & credentials → Production.',
    ),
    envRequirement(
      qbo.clientSecretEnv,
      'Signs the token exchange with Intuit.',
      'Same Intuit screen as the client id.',
    ),
  ];

  const sheetsRequirements: Requirement[] = [key];

  return [
    {
      sourceSystem: 'QBO',
      label: 'QuickBooks Online',
      ready: qboRequirements.every((r) => r.severity !== 'required' || r.present),
      summary: qboRequirements.every((r) => r.severity !== 'required' || r.present)
        ? 'Ready. Click Connect and authorise at Intuit; the realm id and the rotating refresh token are captured for you.'
        : 'Not ready. QuickBooks has no pasted-token path — its access tokens last an hour — so the Intuit app credentials must be set before Connect can work.',
      requirements: qboRequirements,
      recommendedPath: 'OAuth round trip from Admin → Connect',
    },
    {
      sourceSystem: 'HUBSPOT',
      label: 'HubSpot',
      ready: key.present,
      summary: key.present
        ? 'Ready. Paste a private-app token — it is verified by reading one deal before anything is stored.'
        : 'Not ready. Set CREDENTIAL_KEY first; until then a pasted token is refused rather than stored unencrypted.',
      requirements: hubspotRequirements,
      recommendedPath:
        'Private-app token (simplest for a single portal). Scopes: crm.objects.deals.read, crm.objects.contacts.read, crm.objects.meetings.read.',
    },
    {
      sourceSystem: 'SHEETS',
      label: 'Google Sheets',
      ready: key.present,
      summary: key.present
        ? 'Ready. Paste the service-account key file and share the spreadsheet with that account as Viewer.'
        : 'Not ready. Set CREDENTIAL_KEY first — the service-account private key is not stored unencrypted.',
      requirements: sheetsRequirements,
      recommendedPath:
        'Service account with Viewer access on the workbook, so the connection survives the person who made it leaving.',
    },
  ];
}

/** True when nothing at all can be connected — the one blocking case. */
export function credentialStoreReady(): boolean {
  return hasCredentialKey();
}

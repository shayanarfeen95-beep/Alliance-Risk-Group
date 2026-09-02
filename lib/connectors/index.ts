/**
 * Connector registry.
 *
 * The agent's ingestion tools enumerate sources through here, so adding a source
 * makes it available to the scheduled refresh, the admin UI and the agent at the
 * same time — there is no separate list to keep in sync.
 */
import { hubspotConnector } from './hubspot';
import { qboConnector } from './qbo';
import { sheetsConnector } from './sheets';
import type { SourceConnector, SourceSystemCode } from './types';
import { credentialSummary, isConnected, type CredentialSummary } from './credentials';
import { getProvider, isProviderConfigured } from './oauth';
import { COMPOSIO_TOOLKITS, isComposioConfigured, isComposioSource } from './composio';
import { hasCredentialKey } from '@/lib/crypto/secrets';

export const CONNECTORS: SourceConnector[] = [qboConnector, hubspotConnector, sheetsConnector];

export function getConnector(sourceSystem: SourceSystemCode): SourceConnector {
  const connector = CONNECTORS.find((c) => c.sourceSystem === sourceSystem);
  if (!connector) throw new Error(`No connector registered for ${sourceSystem}.`);
  return connector;
}

export interface ConnectorStatus {
  sourceSystem: SourceSystemCode;
  label: string;
  isConfigured: boolean;
  entities: ReturnType<SourceConnector['entities']>;
  credential: CredentialSummary;
  /** True when a sign-in can actually start — through Composio or an own app. */
  oauthAvailable: boolean;
  /** Set when sign-in cannot start, explaining precisely what is missing. */
  oauthBlockedReason: string | null;
  /**
   * How this source signs in.
   *
   * `composio` is the path that asks the user for nothing but their provider
   * password. When it is available the credential-pasting forms are not offered
   * at all: showing someone a service-account key field next to a working
   * sign-in button invites them to do the hard thing for no reason.
   */
  connectVia: 'composio' | 'oauth' | null;
  /** The wording on the button — "Sign in with QuickBooks", not "Connect". */
  signInLabel: string;
  /** True when a pasted token or key file is still worth offering. */
  supportsManual: boolean;
  /**
   * Set when a source is authorised but not yet usable. Google grants access to
   * an account, not to a document: a signed-in Sheets connection still has to be
   * told which spreadsheet holds the budget.
   */
  needsSpreadsheet: boolean;
}

/**
 * The real connection state of every source.
 *
 * Asynchronous because credentials live in the database now, not only in the
 * environment: a source is connected when somebody clicked Connect, and that
 * cannot be answered by reading `process.env`.
 */
export async function connectorStatuses(): Promise<ConnectorStatus[]> {
  return Promise.all(
    CONNECTORS.map(async (c) => {
      const credential = await credentialSummary(c.sourceSystem);
      const provider = getProvider(c.sourceSystem);

      const viaComposio = isComposioConfigured() && isComposioSource(c.sourceSystem);

      let oauthBlockedReason: string | null = null;
      if (!viaComposio) {
        if (!provider) {
          oauthBlockedReason =
            'Set COMPOSIO_API_KEY to sign in with one click. It is the only variable this needs.';
        } else if (!isProviderConfigured(provider)) {
          oauthBlockedReason =
            'Set COMPOSIO_API_KEY to sign in with one click, or register your own app and set ' +
            `${provider.clientIdEnv} and ${provider.clientSecretEnv}.`;
        } else if (!hasCredentialKey()) {
          oauthBlockedReason =
            'Set CREDENTIAL_KEY so the token can be stored encrypted — or set COMPOSIO_API_KEY, ' +
            'which needs no key because no token is held here.';
        }
      }

      const connectVia = viaComposio
        ? ('composio' as const)
        : provider && oauthBlockedReason === null
          ? ('oauth' as const)
          : null;

      return {
        sourceSystem: c.sourceSystem,
        label: c.label,
        isConfigured: credential.connected,
        entities: c.entities(),
        credential,
        oauthAvailable: connectVia !== null,
        oauthBlockedReason,
        connectVia,
        signInLabel: isComposioSource(c.sourceSystem)
          ? COMPOSIO_TOOLKITS[c.sourceSystem].signIn
          : `Connect ${c.label}`,
        // Pasting a token is a fallback for a deployment without Composio, not a
        // step anybody should be walked through when the button works.
        supportsManual:
          !viaComposio && (c.sourceSystem === 'HUBSPOT' || c.sourceSystem === 'SHEETS'),
        needsSpreadsheet:
          c.sourceSystem === 'SHEETS' &&
          credential.connected &&
          credential.authMethod === 'COMPOSIO' &&
          !(await c.isConfigured()),
      };
    }),
  );
}

export * from './types';
export { isConnected, credentialSummary } from './credentials';
export { qboConnector, hubspotConnector, sheetsConnector };

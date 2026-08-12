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
  /** True when an OAuth app is registered, so Connect can actually start. */
  oauthAvailable: boolean;
  /** Set when OAuth cannot start, explaining precisely what is missing. */
  oauthBlockedReason: string | null;
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

      let oauthBlockedReason: string | null = null;
      if (provider && !isProviderConfigured(provider)) {
        oauthBlockedReason = `Set ${provider.clientIdEnv} and ${provider.clientSecretEnv} to enable one-click connect.`;
      } else if (provider && !hasCredentialKey()) {
        oauthBlockedReason = 'Set CREDENTIAL_KEY so the token can be stored encrypted.';
      }

      return {
        sourceSystem: c.sourceSystem,
        label: c.label,
        isConfigured: credential.connected,
        entities: c.entities(),
        credential,
        oauthAvailable: Boolean(provider) && oauthBlockedReason === null,
        oauthBlockedReason,
      };
    }),
  );
}

export * from './types';
export { isConnected, credentialSummary } from './credentials';
export { qboConnector, hubspotConnector, sheetsConnector };

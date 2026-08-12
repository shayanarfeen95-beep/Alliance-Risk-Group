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
}

export function connectorStatuses(): ConnectorStatus[] {
  return CONNECTORS.map((c) => ({
    sourceSystem: c.sourceSystem,
    label: c.label,
    isConfigured: c.isConfigured(),
    entities: c.entities(),
  }));
}

export * from './types';
export { qboConnector, hubspotConnector, sheetsConnector };

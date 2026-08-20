import 'server-only';
import { eq } from 'drizzle-orm';
import * as t from '@/lib/db/schema';
import { withDatabase, type Database } from '@/lib/db/client';
import { resolveConnector } from '@/lib/connectors';
import { markCredentialError } from '@/lib/connectors/credentials';
import {
  ConnectorNotConfiguredError,
  ConnectorRequestError,
  type FetchWindow,
  type SourceSystemCode,
} from '@/lib/connectors/types';
import { persistFindings, runAllChecks } from '@/lib/recon/checks';
import { conformBatch, ConformBlockedError, type ConformOutcome } from './conform';

/**
 * One load, start to finish: fetch, land, conform, reconcile.
 *
 * Everything that pulls data runs through here — the agent's confirmed
 * extraction, the Sync button in Admin, the overnight refresh. Not for tidiness:
 * a second ingestion path is a second place for the closed-month rule, the
 * unmapped-account stop and the reconciliation controls to be *almost* right,
 * and the difference would only ever show up as two figures for the same month.
 *
 * The order matters. Raw lands before conform, so a conform that fails can be
 * replayed from the database instead of the provider — which matters when the
 * provider is rate-limited and the pull took four minutes. Reconciliation runs
 * after conform, so its verdict is about the data now in the warehouse.
 */

export interface SyncRequest {
  sourceSystem: SourceSystemCode;
  entity: string;
  window: FetchWindow;
  requestedByUserId?: string | null;
  agentConversationId?: string | null;
  /** Reuses a run already created as a PREVIEW rather than opening a second one. */
  existingLoadRunId?: string;
}

export interface SyncResult {
  ok: boolean;
  loadRunId: string;
  rowsRead: number;
  rowsWritten: number;
  tables: string[];
  warnings: string[];
  skippedClosedMonths: string[];
  /** Set when the load stopped. Written to the run and shown to the caller. */
  error: string | null;
  recon: { passed: number; failed: number } | null;
}

export async function runSync(db: Database, request: SyncRequest): Promise<SyncResult> {
  // Bind the database for the whole run. Connectors read their credentials
  // several layers down — inside `fetch`, which takes an entity and a window —
  // and without this they would consult the process singleton while this
  // function writes here. In production they are the same object; where they
  // are not, a load would check one database for its token and write its facts
  // to another, and report success either way.
  return withDatabase(db, () => runSyncInner(db, request));
}

async function runSyncInner(db: Database, request: SyncRequest): Promise<SyncResult> {
  // Resolved rather than looked up: a source connected through Composio is
  // fetched through Composio. Both produce the same RawBatch, so everything
  // after this line is identical either way.
  const connector = await resolveConnector(request.sourceSystem);

  const loadRunId = request.existingLoadRunId ?? (await openRun(db, request));

  const fail = async (message: string): Promise<SyncResult> => {
    await db
      .update(t.loadRun)
      .set({ status: 'FAILED', errorMessage: message.slice(0, 4000), finishedAt: new Date() })
      .where(eq(t.loadRun.id, loadRunId));
    return {
      ok: false,
      loadRunId,
      rowsRead: 0,
      rowsWritten: 0,
      tables: [],
      warnings: [],
      skippedClosedMonths: [],
      error: message,
      recon: null,
    };
  };

  if (!(await connector.isConfigured())) {
    return fail(
      `${connector.label} is not connected — it has no credentials configured, so nothing was ` +
        'pulled and nothing was written. Connect it in Admin → Source connections first.',
    );
  }

  await db
    .update(t.loadRun)
    .set({ status: 'RUNNING', confirmedAt: new Date() })
    .where(eq(t.loadRun.id, loadRunId));

  // --- Fetch -------------------------------------------------------------
  let batch;
  try {
    batch = await connector.fetch(request.entity, request.window);
  } catch (error) {
    const message = describe(error, connector.label);
    // A provider that refused us is a fact about the credential, and the admin
    // screen is where somebody will look for it.
    if (error instanceof ConnectorRequestError || error instanceof ConnectorNotConfiguredError) {
      await markCredentialError(request.sourceSystem, message, db);
    }
    return fail(message);
  }

  // --- Land --------------------------------------------------------------
  for (let index = 0; index < batch.records.length; index += 200) {
    await db.insert(t.rawPayload).values(
      batch.records.slice(index, index + 200).map((record) => ({
        loadRunId,
        sourceSystem: batch.sourceSystem,
        entity: record.entity,
        payload: record.payload as object,
        fetchedAt: batch.fetchedAt,
      })),
    );
  }

  await db
    .update(t.loadRun)
    .set({ rowsRead: batch.records.length })
    .where(eq(t.loadRun.id, loadRunId));

  // --- Conform -----------------------------------------------------------
  let outcome: ConformOutcome;
  try {
    outcome = await conformBatch(db, loadRunId, batch);
  } catch (error) {
    if (error instanceof ConformBlockedError) {
      // Not a failure of the connection — a decision nobody has made yet. The
      // raw payloads stay, so fixing the mapping and replaying costs nothing.
      await db
        .update(t.loadRun)
        .set({
          status: 'FAILED',
          errorMessage: error.message.slice(0, 4000),
          finishedAt: new Date(),
          plan: { blockers: error.blockers },
        })
        .where(eq(t.loadRun.id, loadRunId));

      return {
        ok: false,
        loadRunId,
        rowsRead: batch.records.length,
        rowsWritten: 0,
        tables: [],
        warnings: [],
        skippedClosedMonths: [],
        error: error.message,
        recon: null,
      };
    }
    return fail(describe(error, connector.label));
  }

  await db
    .update(t.loadRun)
    .set({
      status: 'SUCCEEDED',
      rowsRead: batch.records.length,
      rowsWritten: outcome.rowsWritten,
      finishedAt: new Date(),
    })
    .where(eq(t.loadRun.id, loadRunId));

  // --- Reconcile ---------------------------------------------------------
  // §2 Rule 1: the controls run on every refresh, not by hand at go-live. A
  // load that succeeded and a load that succeeded and ties out are different
  // states, and only one of them is worth acting on.
  let recon: { passed: number; failed: number } | null = null;
  try {
    const summary = await runAllChecks(db, {
      fromMonth: request.window.start,
      toMonth: request.window.end,
    });
    await persistFindings(db, summary.findings, loadRunId);
    recon = { passed: summary.passed, failed: summary.failed };
  } catch {
    // A reconciliation that cannot run does not un-write the data. It is
    // reported as absent rather than as a pass, which is the one thing it must
    // never be mistaken for.
    recon = null;
  }

  return {
    ok: true,
    loadRunId,
    rowsRead: batch.records.length,
    rowsWritten: outcome.rowsWritten,
    tables: outcome.tables,
    warnings: outcome.warnings,
    skippedClosedMonths: outcome.skippedClosedMonths,
    error: null,
    recon,
  };
}

async function openRun(db: Database, request: SyncRequest): Promise<string> {
  const [run] = await db
    .insert(t.loadRun)
    .values({
      sourceSystem: request.sourceSystem,
      entity: request.entity,
      windowStart: request.window.start,
      windowEnd: request.window.end,
      status: 'PENDING',
      requestedByUserId: request.requestedByUserId ?? null,
      agentConversationId: request.agentConversationId ?? null,
    })
    .returning();
  return run!.id;
}

/**
 * A provider error a person can act on.
 *
 * "HTTP 403" tells somebody there is a problem. Naming the likely cause tells
 * them where to go, and for these three providers the cause is nearly always
 * the same short list.
 */
function describe(error: unknown, label: string): string {
  if (error instanceof ConnectorNotConfiguredError) {
    return `${label} is not connected. Add its credentials in Admin → Source connections.`;
  }

  if (error instanceof ConnectorRequestError) {
    if (error.status === 401) {
      return `${label} rejected the credential (401). The token was revoked, rotated, or belongs to a different account. Reconnect it in Admin.`;
    }
    if (error.status === 403) {
      return `${label} refused the request (403). The connection is authenticated but is missing a scope for this data. Check the app's scopes, then reconnect.`;
    }
    if (error.status === 429) {
      return `${label} rate-limited this pull (429) and it did not complete. Nothing was conformed. Try a narrower window.`;
    }
    return error.message;
  }

  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Whole-source refresh
// ---------------------------------------------------------------------------

/**
 * The order entities are pulled in, per source.
 *
 * Reference data first, and not as a matter of taste. A P&L load stops on an
 * account it has never seen, so pulling the chart of accounts afterwards means
 * the first sync always fails and the second one works — which reads as a flaky
 * connector rather than as the deliberate stop it is. Owners before deals for
 * the same reason: deals loaded first would carry ids where names belong.
 *
 * Anything not named here is pulled after, in the order the connector declares
 * it, so adding an entity to a connector does not silently exclude it.
 */
const REFRESH_ORDER: Record<string, string[]> = {
  QBO: ['accounts', 'classes', 'profit_and_loss', 'balance_sheet'],
  HUBSPOT: ['owners', 'deals', 'contacts', 'meetings'],
  SHEETS: ['monthly_budget', 'tenx_budget', 'headcount'],
};

export interface SourceSyncResult {
  sourceSystem: SourceSystemCode;
  entities: Array<SyncResult & { entity: string }>;
  ok: boolean;
  rowsWritten: number;
}

export async function syncSource(
  db: Database,
  sourceSystem: SourceSystemCode,
  window: FetchWindow,
  options: { requestedByUserId?: string | null; entities?: string[] } = {},
): Promise<SourceSyncResult> {
  const connector = await resolveConnector(sourceSystem);
  const available = connector.entities().map((entity) => entity.entity);

  const requested = options.entities?.filter((entity) => available.includes(entity));
  const ordered =
    requested && requested.length > 0
      ? requested
      : [
          ...(REFRESH_ORDER[sourceSystem] ?? []).filter((entity) => available.includes(entity)),
          ...available.filter((entity) => !(REFRESH_ORDER[sourceSystem] ?? []).includes(entity)),
        ];

  const entities: Array<SyncResult & { entity: string }> = [];

  for (const entity of ordered) {
    const result = await runSync(db, {
      sourceSystem,
      entity,
      window,
      requestedByUserId: options.requestedByUserId ?? null,
    });
    entities.push({ ...result, entity });

    // A credential failure will fail every remaining entity in the same way,
    // and eight identical errors are harder to read than one. A conform that
    // was blocked is different — the next entity may well be fine, and the
    // point is to collect the whole list of things to fix in one pass.
    if (!result.ok && /not connected|401|403/.test(result.error ?? '')) break;
  }

  return {
    sourceSystem,
    entities,
    ok: entities.every((entity) => entity.ok),
    rowsWritten: entities.reduce((sum, entity) => sum + entity.rowsWritten, 0),
  };
}

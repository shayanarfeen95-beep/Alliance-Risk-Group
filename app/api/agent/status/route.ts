import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/scope';
import { connectorStatuses } from '@/lib/connectors';
import { describeProvider } from '@/lib/ai/provider';

export const dynamic = 'force-dynamic';

/**
 * What the assistant can do right now, for the panel to state plainly.
 *
 * The panel used to open on four example questions, which read as a
 * questionnaire — a thing that asks you to pick from a list rather than a thing
 * you give work to. Worse, "pull the latest month from QuickBooks" sat there as
 * a suggestion whether or not QuickBooks was connected, so the one capability
 * people most wanted to see was also the one most likely to fail on first try.
 *
 * Stating the real connection state instead means the panel can offer importing
 * when it will work and say what is missing when it will not.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Your session has expired.' }, { status: 401 });
  }

  let assistant;
  try {
    assistant = describeProvider();
  } catch (error) {
    assistant = {
      configured: false,
      provider: null,
      model: null,
      detail: error instanceof Error ? error.message : 'The assistant is misconfigured.',
    };
  }

  const sources = (await connectorStatuses()).map((connector) => ({
    source: connector.sourceSystem,
    label: connector.label,
    connected: connector.isConfigured,
    account: connector.credential.accountLabel,
  }));

  return NextResponse.json({
    ok: true,
    assistant: {
      configured: assistant.configured,
      provider: assistant.provider,
      model: assistant.model,
      detail: assistant.detail,
    },
    sources,
    // Ingestion is the capability the panel offers conditionally; everything
    // else it can do is available to any signed-in reader.
    canImport: can(user, 'RUN_INGESTION'),
  });
}

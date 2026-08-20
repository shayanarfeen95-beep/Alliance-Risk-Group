import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/scope';
import { describeProvider, verifyOpenRouterModel } from '@/lib/ai/provider';

export const dynamic = 'force-dynamic';

/**
 * Checks the configured model against OpenRouter's live catalogue.
 *
 * Worth an explicit control rather than a startup log, because the failure it
 * catches is the quietest one this system can have. A model without tool
 * calling does not error — it reads the question, has no way to look anything
 * up, and answers from its own weights. The reply is fluent, correctly shaped,
 * and every figure in it is invented.
 */
export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Your session has expired.' }, { status: 401 });
  }
  if (!can(user, 'EDIT_MAPPINGS')) {
    return NextResponse.json(
      { ok: false, error: 'Only an administrator or the CFO can check the assistant.' },
      { status: 403 },
    );
  }

  let body: { model?: string } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    // An empty body means "check whatever is configured".
  }

  let described;
  try {
    described = describeProvider();
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'The assistant is misconfigured.',
    });
  }

  const model = body.model?.trim() || described.model;

  if (!model) {
    return NextResponse.json({
      ok: false,
      error:
        'No model is configured. Set OPENROUTER_MODEL, or name one here to check it before you ' +
        'commit to it.',
    });
  }

  // Anthropic publishes no equivalent catalogue endpoint, and its models all
  // support tool calling, so there is nothing to check.
  if (described.provider === 'Anthropic') {
    return NextResponse.json({
      ok: true,
      provider: described.provider,
      model,
      detail: 'Anthropic is configured. Its models support tool calling.',
    });
  }

  const check = await verifyOpenRouterModel(model);

  return NextResponse.json({
    ok: check.ok,
    provider: 'OpenRouter',
    model: check.model,
    supportsTools: check.supportsTools,
    contextLength: check.contextLength,
    isFree: check.isFree,
    detail: check.detail,
    error: check.ok ? undefined : check.detail,
  });
}

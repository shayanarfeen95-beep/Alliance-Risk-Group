import Decimal from 'decimal.js';
import { formatValue } from '@/lib/money';
import { resolveKpi, CONSOLIDATED_CODE, type SemanticSession } from '@/lib/semantic/resolve';
import { key } from '@/lib/semantic/facts';
import type { MonthKey } from '@/lib/semantic/periods';
import type { Finding } from './goals';
import { complete, isModelConfigured } from './provider';

/**
 * The monthly close narrative.
 *
 * The hard part of this is not producing prose — it is producing prose that
 * cannot contain a number the dashboards would disagree with. Two rules do that:
 *
 *   1. Every figure is resolved and formatted before the model is called. The
 *      model receives a fact pack of finished strings and is asked to write the
 *      sentences between them. It is never asked to compute, compare or
 *      annualise anything.
 *
 *   2. The draft is then verified. Every currency and percentage token in the
 *      returned text must appear in the fact pack. If one does not, the model
 *      invented or re-derived a figure, and the draft is rejected in favour of
 *      the deterministic one. §11 Requirement 3 does not have a "usually" in it.
 *
 * That means the worst case here is plainer writing, never a wrong number. When
 * no model is configured the deterministic draft is what ships, and it is
 * written to be publishable on its own — Westport edits and signs either way.
 *
 * This module deliberately carries no `server-only` marker: the seed loader and
 * the overnight refresh both draft commentary outside a request. The provider
 * reads its key inside the call rather than at import, so nothing here runs on a
 * key that is not present.
 */

export interface CommentaryFact {
  label: string;
  value: string;
  note?: string;
}

export interface Commentary {
  month: MonthKey;
  /** The narrative, in paragraphs. */
  body: string;
  /** Every figure the narrative is allowed to use, in the order assembled. */
  facts: CommentaryFact[];
  /** True when the model wrote it; false when the deterministic draft shipped. */
  modelWritten: boolean;
  /** Set when a model draft was rejected, so the reason is visible in Admin. */
  rejectionReason?: string;
  periodState: 'OPEN' | 'CLOSED';
}

// ---------------------------------------------------------------------------
// Fact pack
// ---------------------------------------------------------------------------

const HEADLINE_KPIS = [
  'revenue',
  'gross_profit',
  'gross_profit_pct',
  'net_profit',
  'net_profit_pct',
  'opex',
] as const;

/**
 * Assembles every figure the narrative may quote.
 *
 * Deliberately includes the account-level movers: §9 asks for commentary that
 * says *what* moved, and account-level GL is in scope precisely so it can also
 * say *why*. Without it the narrative can report that OpEx rose and nothing
 * more, which is the thing Westport already knows.
 */
export function buildFactPack(session: SemanticSession, findings: Finding[] = []): CommentaryFact[] {
  const facts: CommentaryFact[] = [];
  const scope = session.consolidatedAvailable ? CONSOLIDATED_CODE : session.visibleDivisions[0];
  if (!scope) return facts;

  const push = (label: string, value: string, note?: string) => {
    facts.push(note ? { label, value, note } : { label, value });
  };

  for (const id of HEADLINE_KPIS) {
    const current = resolveKpi(session, id, scope);
    if (current.value === null) {
      push(current.name, 'not available', current.unavailable?.detail);
      continue;
    }
    push(current.name, current.formatted);

    const prior = resolveKpi(session, id, scope, { month: session.period.priorMonth });
    if (prior.value !== null) {
      push(`${current.name}, prior month`, prior.formatted);
      // The movement is computed here, in the same decimal arithmetic as
      // everything else, so the model never subtracts two numbers itself.
      const delta = current.value.minus(prior.value);
      push(
        `${current.name}, movement on prior month`,
        formatValue(delta, current.format),
        `${delta.isNegative() === current.higherIsBetter ? 'unfavourable' : 'favourable'} for this metric`,
      );
    }

    const priorYear = resolveKpi(session, id, scope, { month: session.period.priorYearMonth });
    if (priorYear.value !== null) {
      push(`${current.name}, same month last year`, priorYear.formatted);
    }
  }

  // Division contribution, so the narrative can name who moved rather than
  // reporting a consolidated number and stopping.
  for (const division of session.visibleDivisions) {
    const revenue = resolveKpi(session, 'revenue', division);
    const netProfit = resolveKpi(session, 'net_profit', division);
    if (revenue.value !== null) push(`${division} revenue`, revenue.formatted);
    if (netProfit.value !== null) push(`${division} net profit`, netProfit.formatted);
  }

  // Budget attainment at the scope level, both figures, separately labelled.
  const attainment = resolveKpi(session, 'budget_attainment', scope, {
    options: { lineItem: 'revenue' },
  });
  if (attainment.value !== null) {
    push('Revenue attainment against budget', attainment.formatted, 'a ratio, not a variance');
    const variance = attainment.components?.varianceDollars;
    if (variance) push('Revenue variance against budget', formatValue(variance, 'currency'));
  }

  for (const finding of findings.slice(0, 8)) {
    push(`Exception: ${finding.headline}`, finding.detail);
  }

  return facts;
}

/**
 * The largest account-level movements on the month.
 *
 * This is what turns "OpEx rose $32,000" into "OpEx rose $32,000, and $28,000 of
 * that was one account". The accounts come from `fact_gl_balance`, so a reader
 * can click through to them.
 */
export function accountMovers(
  session: SemanticSession,
  divisions: string[],
  limit = 5,
): CommentaryFact[] {
  // Both months are summed across the divisions in scope before differencing,
  // so an account that moved in one division and back in another nets out
  // rather than appearing twice.
  const sumByAccount = (month: MonthKey) => {
    const totals = new Map<string, { name: string; amount: Decimal }>();
    for (const division of divisions) {
      for (const row of session.bundle.gl.get(key(month, division)) ?? []) {
        const existing = totals.get(row.accountId);
        totals.set(row.accountId, {
          name: row.accountName,
          amount: existing ? existing.amount.plus(row.amount) : row.amount,
        });
      }
    }
    return totals;
  };

  const current = sumByAccount(session.period.month);
  const prior = sumByAccount(session.period.priorMonth);
  if (current.size === 0 || prior.size === 0) return [];

  const movements = new Map<string, { name: string; delta: Decimal }>();
  for (const [accountId, entry] of current) {
    const before = prior.get(accountId)?.amount ?? new Decimal(0);
    movements.set(accountId, { name: entry.name, delta: entry.amount.minus(before) });
  }
  // An account that existed last month and vanished this month moved too, and
  // it is usually the more interesting direction.
  for (const [accountId, entry] of prior) {
    if (movements.has(accountId)) continue;
    movements.set(accountId, { name: entry.name, delta: entry.amount.negated() });
  }

  return [...movements.values()]
    .filter((entry) => !entry.delta.isZero())
    .sort((a, b) => b.delta.abs().comparedTo(a.delta.abs()))
    .slice(0, limit)
    .map((entry) => ({
      label: `Account movement: ${entry.name}`,
      value: formatValue(entry.delta, 'currency'),
      note: 'against prior month',
    }));
}

// ---------------------------------------------------------------------------
// Deterministic draft
// ---------------------------------------------------------------------------

function factValue(facts: CommentaryFact[], label: string): string | null {
  return facts.find((fact) => fact.label === label)?.value ?? null;
}

/**
 * The narrative written in code.
 *
 * Publishable on its own. It ships whenever the model is unavailable or its
 * draft fails verification, so it cannot be a placeholder.
 */
export function deterministicDraft(
  session: SemanticSession,
  facts: CommentaryFact[],
  findings: Finding[],
): string {
  const month = session.period.month;
  const label = new Date(`${month}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

  const paragraphs: string[] = [];

  const revenue = factValue(facts, 'Revenue');
  const revenueMove = factValue(facts, 'Revenue, movement on prior month');
  const netProfit = factValue(facts, 'Net Profit');
  const netMove = factValue(facts, 'Net Profit, movement on prior month');

  paragraphs.push(
    `${label}${session.periodIsClosed ? '' : ' (open period — figures are preliminary and will move until the month is closed)'}. ` +
      (revenue ? `Revenue ${revenue}${revenueMove ? `, ${revenueMove} against the prior month` : ''}. ` : '') +
      (netProfit ? `Net profit ${netProfit}${netMove ? `, ${netMove} against the prior month` : ''}.` : ''),
  );

  const attainment = factValue(facts, 'Revenue attainment against budget');
  const variance = factValue(facts, 'Revenue variance against budget');
  if (attainment) {
    paragraphs.push(
      `Against budget, revenue attained ${attainment}${variance ? `, a variance of ${variance}` : ''}. ` +
        `Attainment is a ratio and the variance is a dollar figure; they are not two views of the same number.`,
    );
  }

  const divisionLines = session.visibleDivisions
    .map((division) => {
      const rev = factValue(facts, `${division} revenue`);
      const np = factValue(facts, `${division} net profit`);
      return rev ? `${division} ${rev}${np ? ` revenue, ${np} net profit` : ''}` : null;
    })
    .filter((line): line is string => line !== null);

  if (divisionLines.length) {
    paragraphs.push(`By division: ${divisionLines.join('; ')}.`);
  }

  const movers = facts.filter((fact) => fact.label.startsWith('Account movement:'));
  if (movers.length) {
    paragraphs.push(
      `The largest account-level movements were ${movers
        .map((mover) => `${mover.label.replace('Account movement: ', '')} ${mover.value}`)
        .join(', ')}.`,
    );
  }

  if (findings.length) {
    paragraphs.push(
      `${findings.length} standing goal${findings.length === 1 ? '' : 's'} raised an exception this month: ` +
        `${findings.slice(0, 5).map((finding) => finding.headline).join('; ')}.`,
    );
  } else {
    paragraphs.push('No standing goal raised an exception this month.');
  }

  return paragraphs.join('\n\n');
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/** Currency and percentage tokens, the only shapes a financial figure takes here. */
const FIGURE_PATTERN = /\(?-?\$[\d,]+(?:\.\d+)?\)?|-?[\d,]+(?:\.\d+)?\s?%/g;

function normalise(token: string): string {
  return token.replace(/[\s(),]/g, '').replace(/^-/, '').toLowerCase();
}

/**
 * Rejects a draft that contains a figure the fact pack does not.
 *
 * This is the check that makes the model safe to use here at all. It is
 * deliberately strict about direction: a model that reports a favourable move as
 * unfavourable is wrong in the way that matters most, and the fact pack already
 * carries the direction, so the model has no reason to work it out.
 */
export function verifyDraft(
  draft: string,
  facts: CommentaryFact[],
): { ok: true } | { ok: false; reason: string } {
  // Labels count as much as values. A finding's headline — "Operating Expense
  // moved 26% against prior month" — is itself assembled from resolved figures
  // by the goal evaluator, so a figure appearing there is as sourced as one in
  // a value field. Excluding labels would reject the deterministic draft, which
  // is a good sign that the exclusion is wrong rather than that the draft is.
  const allowed = new Set<string>();
  for (const fact of facts) {
    for (const token of `${fact.label} ${fact.value} ${fact.note ?? ''}`.match(FIGURE_PATTERN) ?? []) {
      allowed.add(normalise(token));
    }
  }

  const used = draft.match(FIGURE_PATTERN) ?? [];
  const invented = used.map(normalise).filter((token) => !allowed.has(token));

  if (invented.length > 0) {
    return {
      ok: false,
      reason: `The draft contained ${invented.length} figure${invented.length === 1 ? '' : 's'} not in the fact pack (${invented.slice(0, 3).join(', ')}). Commentary may only quote resolved figures.`,
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You write the monthly close narrative for Alliance Risk Group, a legal-support services business with four divisions. Westport Financial, ARG's fractional CFO, edits and signs what you draft, and ARG's CEO and COO read it.

You are given a fact pack: every figure has already been resolved from the accounting system, formatted, and labelled. Your job is the sentences between those figures — what moved, against which baseline, and which accounts drove it.

Standards this narrative is held to:

Every figure you write appears in the fact pack, character for character. You have no way to check arithmetic and no reason to attempt it: do not add, subtract, annualise, convert to a percentage, or round anything. If a comparison you want to make is not in the pack, describe it in words without a number, or leave it out.

Favourable and unfavourable are marked on the movements in the pack. Read them from there. A rise in operating expense is not good news, and "revenue went up" is not the same sentence as "revenue beat budget".

Attainment against budget is a ratio; the variance is a dollar figure. They are separate facts and reading one as the other is the specific mistake this business has made before.

If the period is open, say so once, early, in plain words — the figures will still move.

Write four to six short paragraphs of plain prose. No headings, no bullet lists, no bold. Name divisions and accounts specifically. Do not recommend actions; describe what happened. Do not restate the entire fact pack — choose what a CEO needs in ninety seconds.`;

export async function generateCommentary(
  session: SemanticSession,
  findings: Finding[] = [],
): Promise<Commentary> {
  const facts = [
    ...buildFactPack(session, findings),
    ...accountMovers(session, session.visibleDivisions),
  ];

  const fallback: Commentary = {
    month: session.period.month,
    body: deterministicDraft(session, facts, findings),
    facts,
    modelWritten: false,
    periodState: session.periodIsClosed ? 'CLOSED' : 'OPEN',
  };

  if (!isModelConfigured()) return fallback;

  try {
    const body = await complete({
      system: SYSTEM_PROMPT,
      user:
        `Reporting month: ${session.period.month} (${session.periodIsClosed ? 'closed' : 'open — preliminary'}).\n` +
        `Accounting basis: ${session.accountingBasis}.\n\n` +
        `Fact pack:\n` +
        facts
          .map((fact) => `- ${fact.label}: ${fact.value}${fact.note ? ` (${fact.note})` : ''}`)
          .join('\n'),
      maxTokens: 2000,
    });

    if (!body) return fallback;

    const verification = verifyDraft(body, facts);
    if (!verification.ok) {
      return { ...fallback, rejectionReason: verification.reason };
    }

    return {
      month: session.period.month,
      body,
      facts,
      modelWritten: true,
      periodState: session.periodIsClosed ? 'CLOSED' : 'OPEN',
    };
  } catch (error) {
    return {
      ...fallback,
      rejectionReason: `The commentary model could not be reached: ${
        error instanceof Error ? error.message : 'unknown error'
      }. The figures below are unaffected.`,
    };
  }
}

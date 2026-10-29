import 'server-only';
import type { SemanticSession } from '@/lib/semantic/resolve';
import type { DealRecord, DealStageRecord } from '@/lib/semantic/facts';
import { hasOption } from '@/lib/connectors/hubspot-fields';

/**
 * What the HubSpot Leadership dashboard is about: one line of business.
 *
 * Westport, October 2026: "Everything on this Leadership dashboard should only
 * be for our background screening side of the business. Filter with the
 * property Line of Business and the value of Background Checks. For the Deal
 * property, all the deals are from the Sales Pipeline deals, but also, ONLY
 * deals with a Line of Business of Background Checks."
 *
 * So every panel on the page reads the same narrowed set of deals — applied
 * once, here, to a copy of the session — rather than each panel filtering in
 * its own way. A tile and the chart beside it cannot then disagree about which
 * deals they counted.
 *
 * The values below are Westport's words. They are matched against HubSpot's
 * labels, never against internal ids.
 */
export const LEADERSHIP_SCOPE = {
  lineOfBusiness: process.env.HUBSPOT_LEADERSHIP_LINE_OF_BUSINESS?.trim() || 'Background Checks',
  pipeline: process.env.HUBSPOT_LEADERSHIP_PIPELINE?.trim() || 'Sales Pipeline',
  /** "Deals created by month … Created by is none of Sarah Roy." */
  excludedCreators: ['Sarah Roy'],
  /** "SQLs/month … Lead Source is any of Website, SHRM RFQ, Webinar, or Trade Show/Conference." */
  sqlLeadSources: ['Website', 'SHRM RFQ', 'Webinar', 'Trade Show/Conference'],
  /**
   * "Total pipeline by month (minus closed lost) … Deal stage is any of
   * Compliance Review, Qualified Discovery, Solution Alignment, Contracting,
   * Proposal, or Closed won/Onboarding (Sales Pipeline)."
   */
  openPipelineStages: [
    'Compliance Review',
    'Qualified Discovery',
    'Solution Alignment',
    'Contracting',
    'Proposal',
    'Closed won/Onboarding',
  ],
  /** "Average Deal Size by Month — 2026 ICP … Amount is greater than 10,000." */
  icpMinimumAmount: 10_000,
} as const;

export interface LeadershipScope {
  /** The session with only in-scope deals, for every panel on the page. */
  session: SemanticSession;
  /** In-scope deals, the same array the session holds. */
  deals: DealRecord[];
  /** Stages of the scoped pipeline, in HubSpot's order. */
  stages: DealStageRecord[];
  /** Stage id → label, across every pipeline. */
  stageLabel: (stageId: string | null) => string;
  /** "Background Checks · Sales Pipeline", as narrowed in fact. */
  label: string;
  /** What could not be narrowed, said plainly. Empty when fully scoped. */
  gaps: string[];
  /** Deals in HubSpot before narrowing, for the "n of m" line. */
  totalDeals: number;
  /** Whether the Line of Business narrowing actually applied. */
  narrowedByLineOfBusiness: boolean;
}

/** Compared ignoring case and punctuation, the way "is any of" compares. */
export function sameName(a: string | null | undefined, b: string): boolean {
  return hasOption(a ?? null, b);
}

export function scopeLeadership(session: SemanticSession): LeadershipScope {
  const { bundle } = session;
  const gaps: string[] = [];

  const labelById = new Map(bundle.dealStages.map((stage) => [stage.stageId, stage.label]));
  const stageLabel = (stageId: string | null): string =>
    stageId ? (labelById.get(stageId) ?? stageId) : 'Not recorded';

  // --- The pipeline ---------------------------------------------------------
  const pipelineStages = bundle.dealStages.filter((stage) =>
    sameName(stage.pipelineLabel, LEADERSHIP_SCOPE.pipeline),
  );
  const pipelineIds = new Set(pipelineStages.map((stage) => stage.pipelineId));
  const pipelineKnown = pipelineIds.size > 0;
  if (!pipelineKnown) {
    gaps.push(
      bundle.dealStages.length === 0
        ? `Deal stages have not loaded, so deals cannot be narrowed to the ${LEADERSHIP_SCOPE.pipeline} — every pipeline is included until they do.`
        : `No HubSpot pipeline is named “${LEADERSHIP_SCOPE.pipeline}”, so every pipeline is included.`,
    );
  }

  // --- The line of business -------------------------------------------------
  const lobKnown = bundle.deals.some((deal) => deal.lineOfBusiness !== null);
  if (!lobKnown && bundle.deals.length > 0) {
    gaps.push(
      `No deal carries a Line of Business yet, so this page cannot be narrowed to ${LEADERSHIP_SCOPE.lineOfBusiness} and includes every line of business. It fills in on the next HubSpot pull, which reads every deal again to fetch the field.`,
    );
  }

  const inScope = (deal: DealRecord): boolean => {
    if (pipelineKnown && (!deal.pipeline || !pipelineIds.has(deal.pipeline))) return false;
    if (lobKnown && !hasOption(deal.lineOfBusiness, LEADERSHIP_SCOPE.lineOfBusiness)) return false;
    return true;
  };

  const deals = bundle.deals.filter(inScope);
  const ids = new Set(deals.map((deal) => deal.dealId));

  const scoped: SemanticSession = {
    ...session,
    bundle: {
      ...bundle,
      deals,
      stageEntries: bundle.stageEntries.filter((entry) => ids.has(entry.dealId)),
      proposalEntries: bundle.proposalEntries.filter((entry) => ids.has(entry.dealId)),
      meetings: bundle.meetings.filter(
        (meeting) => meeting.associatedDealId !== null && ids.has(meeting.associatedDealId),
      ),
    },
  };

  const parts = [
    lobKnown ? LEADERSHIP_SCOPE.lineOfBusiness : 'Every line of business',
    pipelineKnown ? LEADERSHIP_SCOPE.pipeline : 'every pipeline',
  ];

  return {
    session: scoped,
    deals,
    stages: [...pipelineStages].sort((a, b) => a.displayOrder - b.displayOrder),
    stageLabel,
    label: parts.join(' · '),
    gaps,
    totalDeals: bundle.deals.length,
    narrowedByLineOfBusiness: lobKnown,
  };
}

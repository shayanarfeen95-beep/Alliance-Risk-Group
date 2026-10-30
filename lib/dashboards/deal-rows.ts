import type { DealRecord } from '@/lib/semantic/facts';

/**
 * A deal as a person reads it: names, not ids.
 *
 * What a drill-down lists when somebody clicks a bar — the reason the review
 * can be read here instead of in HubSpot. Shared by every chart, so a deal
 * reads the same wherever it is opened from.
 */
export interface DealRow {
  id: string;
  name: string;
  company: string | null;
  /** The deal owner: who closed it, for a won deal. */
  owner: string;
  amount: number;
  stage: string;
  status: 'Won' | 'Lost' | 'Open';
  created: string | null;
  closed: string | null;
  /** Date Compliance Review Completed. */
  reviewed: string | null;
  source: string;
  lineOfBusiness: string | null;
  createdBy: string | null;
}

const day = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : null);

export function toDealRow(
  deal: DealRecord,
  stageLabel: (stageId: string | null) => string,
  companyName: (companyId: string | null) => string | null,
): DealRow {
  return {
    id: deal.dealId,
    name: deal.dealName ?? `Deal ${deal.dealId}`,
    company: companyName(deal.companyId),
    owner: deal.ownerName ?? 'Unassigned',
    amount: deal.amount.toNumber(),
    stage: stageLabel(deal.dealstage),
    status: deal.isClosedWon ? 'Won' : deal.isClosed ? 'Lost' : 'Open',
    created: day(deal.createdate),
    closed: deal.isClosed ? day(deal.closedate) : null,
    reviewed: day(deal.complianceReviewCompletedAt),
    source: deal.sourceLabel ?? 'Not recorded',
    lineOfBusiness: deal.lineOfBusiness,
    createdBy: deal.createdByName,
  };
}

/** Company id → name, from the companies loaded with the bundle. */
export function companyNames(
  companies: Array<{ companyId: string; name: string | null }>,
): (companyId: string | null) => string | null {
  const byId = new Map(companies.map((company) => [company.companyId, company.name]));
  return (companyId) => (companyId ? (byId.get(companyId) ?? null) : null);
}

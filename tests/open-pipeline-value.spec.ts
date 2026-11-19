/**
 * The Leadership page's Pipeline Value, on Westport's November 2026 definition.
 *
 * "Deal stage is any of Qualified Discovery, Proposal, Solution Alignment,
 * Contracting, or Compliance Review (Sales Pipeline) AND Line of Business is
 * any of Background Checks … get rid of the trailing 12 months and leave it
 * open to any deal that meets the above qualifications, no matter when the
 * create date is."
 *
 * HubSpot's filter showed 226 deals where the page showed 229: the page had
 * counted every deal not yet closed, including deals parked in stages outside
 * those five. These tests pin the five, the open create date, and that a past
 * month reads the stage a deal was in at the time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Decimal from 'decimal.js';
import { getKpiDefinition, OPEN_PIPELINE_STAGES } from '@/lib/semantic/registry';
import { buildPeriodContext } from '@/lib/semantic/periods';
import type { FactBundle } from '@/lib/semantic/facts';

const stages = [
  ['qd', 'Qualified Discovery', false, false],
  ['prop', 'Proposal', false, false],
  ['sa', 'Solution Alignment', false, false],
  ['con', 'Contracting', false, false],
  ['cr', 'Compliance Review', false, false],
  ['nurture', 'Nurture', false, false],
  ['won', 'Closed won/Onboarding', true, true],
  ['lost', 'Closed lost', true, false],
] as const;

function deal(id: string, amount: number, stage: string, created: string, closed?: string) {
  const isClosed = stage === 'won' || stage === 'lost';
  return {
    dealId: id,
    divisionCode: null,
    dealName: id,
    amount: new Decimal(amount),
    dealstage: stage,
    pipeline: 'default',
    isClosedWon: stage === 'won',
    isClosed,
    createdate: new Date(created),
    closedate: closed ? new Date(closed) : null,
    enteredProposalAt: null,
    ownerId: null,
    ownerName: null,
    sourceLabel: null,
    dealType: null,
    lineOfBusiness: 'Background Checks',
    complianceReviewCompletedAt: null,
    createdByName: null,
    companyId: null,
  };
}

const bundle = {
  deals: [
    // Created years ago and still in Proposal: counts — there is no create-date limit.
    deal('old', 100_000, 'prop', '2023-02-01T00:00:00Z'),
    deal('qd', 20_000, 'qd', '2026-06-01T00:00:00Z'),
    // Open, but in a stage that is not one of the five: left out.
    deal('parked', 400_000, 'nurture', '2026-01-10T00:00:00Z'),
    // In Contracting at the end of September, won in October.
    deal('wonOct', 50_000, 'won', '2026-08-01T00:00:00Z', '2026-10-05T00:00:00Z'),
    // Created in October: not in September's pipeline.
    deal('newOct', 7_000, 'cr', '2026-10-15T00:00:00Z'),
    deal('lostAug', 9_000, 'lost', '2026-05-01T00:00:00Z', '2026-08-20T00:00:00Z'),
  ],
  stageEntries: [
    { dealId: 'old', stage: 'qd', divisionCode: null, enteredAt: new Date('2023-02-01T00:00:00Z') },
    { dealId: 'old', stage: 'prop', divisionCode: null, enteredAt: new Date('2026-10-02T00:00:00Z') },
    { dealId: 'qd', stage: 'qd', divisionCode: null, enteredAt: new Date('2026-06-01T00:00:00Z') },
    { dealId: 'parked', stage: 'nurture', divisionCode: null, enteredAt: new Date('2026-01-10T00:00:00Z') },
    { dealId: 'wonOct', stage: 'con', divisionCode: null, enteredAt: new Date('2026-09-10T00:00:00Z') },
    { dealId: 'wonOct', stage: 'won', divisionCode: null, enteredAt: new Date('2026-10-05T00:00:00Z') },
    { dealId: 'newOct', stage: 'cr', divisionCode: null, enteredAt: new Date('2026-10-15T00:00:00Z') },
    { dealId: 'lostAug', stage: 'lost', divisionCode: null, enteredAt: new Date('2026-08-20T00:00:00Z') },
  ],
  dealStages: stages.map(([stageId, label, isClosed, isWon], index) => ({
    stageId,
    label,
    pipelineId: 'default',
    pipelineLabel: 'Sales Pipeline',
    displayOrder: index,
    isClosed,
    isWon,
  })),
  contacts: [],
  meetings: [],
  config: new Map(),
  loadedSources: new Set(['HUBSPOT']),
} as unknown as FactBundle;

const definition = getKpiDefinition('open_pipeline_value')!;
const at = (month: string) =>
  definition.compute({ period: buildPeriodContext(month as never), bundle, divisions: [], isConsolidated: true });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-05T12:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('Pipeline Value on the Leadership page', () => {
  it('is the five open stages Westport named', () => {
    expect([...OPEN_PIPELINE_STAGES]).toEqual([
      'Qualified Discovery',
      'Proposal',
      'Solution Alignment',
      'Contracting',
      'Compliance Review',
    ]);
  });

  it('this month: every deal in one of the five today, whenever it was created', () => {
    const result = at('2026-11-01');
    // old 100,000 + qd 20,000 + newOct 7,000. Not the parked deal, not the won or lost.
    expect(result.value!.toNumber()).toBe(127_000);
    expect(result.citations[0]).toMatchObject({ label: 'Deals in an open stage', value: '3' });
  });

  it('a past month: the stage each deal was in when that month ended', () => {
    const result = at('2026-09-01');
    // old was in Qualified Discovery, wonOct in Contracting; newOct did not exist yet.
    expect(result.value!.toNumber()).toBe(170_000);
  });

  it('is not the old "anything not closed" figure', () => {
    const old = getKpiDefinition('pipeline_value')!.compute({
      period: buildPeriodContext('2026-11-01' as never),
      bundle,
      divisions: [],
      isConsolidated: true,
    });
    // The old figure also counted the deal parked outside the five stages.
    expect(old.value!.toNumber()).toBe(527_000);
  });
});

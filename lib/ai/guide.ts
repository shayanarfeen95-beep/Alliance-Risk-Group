import 'server-only';
import { eq } from 'drizzle-orm';
import type { Database } from '@/lib/db/client';
import * as t from '@/lib/db/schema';
import type { SessionUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/scope';
import { connectorStatuses } from '@/lib/connectors';
import { loadHubspotMapping } from '@/lib/connectors/hubspot-mapping';
import { listBoxes } from './boxes';

/**
 * What the assistant knows about the app itself.
 *
 * ARG's leadership asked for a guide, and a guide that recites a feature list is
 * useless — the useful answer to "how do I compare two divisions?" is the two
 * clicks that do it, and the useful answer to "why is this metric blank?" is the
 * decision it is waiting on and who makes it.
 *
 * So this returns the map plus the live state: what is connected, what is
 * unconfirmed, what this particular reader may do, and which boxes they have
 * already built. The model turns that into a sentence; it never has to guess at
 * how the app works, because guessing is how an assistant tells somebody to
 * click a button that does not exist.
 */

interface PageGuide {
  page: string;
  href: string;
  answers: string;
  keyControls: string[];
}

const PAGES: PageGuide[] = [
  {
    page: 'Executive',
    href: '/executive',
    answers:
      'How the business did this month and what needs attention: eight headline tiles, the exceptions panel, division contribution, YTD against plan, and the signed close commentary.',
    keyControls: [
      'Eight tiles, each with its own division and month filter',
      'Exceptions panel — failing controls and standing-goal findings',
      'Close commentary, drafted from resolved figures and signed by Westport',
    ],
  },
  {
    page: 'Finance',
    href: '/finance',
    answers:
      'The full P&L, the ratio and change blocks, YTD against budget, the 10X plan, the balance sheet with its own balance check, A/R and A/P aging, and a rolling fifteen-month revenue trend.',
    keyControls: [
      'Every block carries its own division and month filter',
      'Payroll rows are memo lines — components of COGS and OpEx, never deducted twice',
      'The balance check is a real assertion: equity is loaded, not plugged',
    ],
  },
  {
    page: 'Sales',
    href: '/sales',
    answers:
      'What was booked, what is in the pipeline, and who closed it — sourced from HubSpot, with a deal-level table behind the tiles.',
    keyControls: [
      'Salesperson filter on the deals card and the leaderboard',
      'The date range scopes dated events; the reporting month anchors the KPIs',
      'Booking Rate states its denominator: deals closed, won plus lost',
    ],
  },
  {
    page: 'Pipeline',
    href: '/pipeline',
    answers:
      'Where every open HubSpot deal is, what it is worth weighted by stage probability, which deals have sat too long, who owns them, and what entered each stage in the window.',
    keyControls: [
      'A board by stage — the HubSpot leadership view, inside this app',
      'Weighted value beside face value; a stage with no agreed probability says "unweighted" rather than guessing',
      'Days in stage from stage history, so a stalled deal is visible rather than implied',
    ],
  },
  {
    page: 'Marketing',
    href: '/marketing',
    answers:
      'What marketing spend produced: leads by source, cost per lead, conversion, and spend against closed-won revenue.',
    keyControls: [
      'Cost per lead is apportioned by lead share and says so',
      'CPL and CAC use deliberately different account sets, both configuration',
    ],
  },
  {
    page: 'Forecast',
    href: '/forecast',
    answers:
      'Projections, scenarios, and the locked versions. A locked forecast cannot be edited — a database trigger refuses the write, not a UI check.',
    keyControls: ['Assumption grid', 'Lock and waiver controls', 'Accuracy scoring against actuals'],
  },
  {
    page: 'KPI dictionary',
    href: '/kpi-dictionary',
    answers:
      'Every metric this system defines, with its formula and source. Generated from the code, so it cannot go stale.',
    keyControls: ['Search by name', 'The published formula for every figure on every dashboard'],
  },
  {
    page: 'Admin',
    href: '/admin',
    answers:
      'Source connections, the HubSpot division mapping, the open items ARG still has to decide, the reconciliation controls, users and access, and the audit pack.',
    keyControls: [
      'Connect QuickBooks, HubSpot or Sheets',
      'HubSpot division mapping — which field decides a deal’s division and what each value means',
      'Download the audit pack for a month',
    ],
  },
];

export interface Guide {
  pages: PageGuide[];
  filters: string[];
  assistantCan: string[];
  liveState: Record<string, unknown>;
  youMay: string[];
}

export async function buildGuide(db: Database, user: SessionUser): Promise<Guide> {
  const connectors = await connectorStatuses();
  const mapping = await loadHubspotMapping(db);
  const boxes = await listBoxes(db, user);

  const unconfirmed = await db
    .select({ key: t.appConfig.key, description: t.appConfig.description })
    .from(t.appConfig)
    .where(eq(t.appConfig.isConfirmed, false));

  return {
    pages: PAGES,
    filters: [
      'The bar at the top sets the reporting month and division for the whole page, plus a date range that scopes dated lists like deals and meetings.',
      'Every tile, chart and table also has its own filter — the small control in its top-right corner. Setting it moves that box alone, and the box then says what it is scoped to and clears in one click.',
      'All of it lives in the URL, so any arrangement of filters is a link that can be sent to somebody else.',
    ],
    assistantCan: [
      'Answer with figures resolved through the same definitions the dashboards use, each one cited.',
      'Build a box — a tile or a chart — and save it to a dashboard, where it stays until removed.',
      'Propose the HubSpot division mapping, showing which values are unmapped and how many deals each covers. Applying it takes a click.',
      'Propose pulling data from QuickBooks, HubSpot or Sheets. Nothing is written until confirmed.',
      'Open a dashboard at a specific month, division or filter.',
    ],
    liveState: {
      sources: connectors.map((connector) => ({
        source: connector.label,
        connected: connector.isConfigured,
        blocked: connector.oauthBlockedReason,
      })),
      hubspotMapping: {
        rule: mapping.rule,
        confirmed: mapping.isConfirmed,
        property: mapping.property,
        mappedValues: Object.keys(mapping.values).length,
        consequence:
          mapping.rule === 'none' || !mapping.isConfirmed
            ? 'Sales and marketing metrics report at ARG Total only until a rule is set and confirmed.'
            : 'Sales and marketing metrics break down by division.',
      },
      pinnedBoxes: boxes.map((box) => ({ id: box.id, title: box.title, page: box.page })),
      unconfirmedDecisions: unconfirmed.map((row) => ({
        key: row.key,
        note: row.description,
      })),
    },
    youMay: [
      can(user, 'RUN_INGESTION') ? 'run ingestion' : null,
      can(user, 'EDIT_MAPPINGS') ? 'change source connections and mappings' : null,
      can(user, 'CLOSE_PERIOD') ? 'close a period' : null,
      can(user, 'LOCK_FORECAST') ? 'lock a forecast' : null,
      can(user, 'SIGN_COMMENTARY') ? 'sign the monthly commentary' : null,
      can(user, 'MANAGE_USERS') ? 'manage users and access' : null,
    ].filter((value): value is string => value !== null),
  };
}

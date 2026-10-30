import type { Metadata } from 'next';
import { Suspense } from 'react';
import { KPI_REGISTRY, isSpecKpi } from '@/lib/semantic/registry';
import { resolveKpi, CONSOLIDATED_CODE } from '@/lib/semantic/resolve';
import { loadDashboardContext, type SearchParams } from '@/lib/dashboards/context';
import { formatMonth } from '@/lib/semantic/periods';
import { KpiExplorer, type KpiItem } from '@/components/kpi/kpi-explorer';

export const metadata: Metadata = { title: 'KPI dictionary' };
export const dynamic = 'force-dynamic';

/**
 * §12 Sprint 3: "Publish the KPI dictionary: name, definition, formula, source,
 * owner, refresh cadence — generated from the semantic layer, not maintained
 * separately, so it can never go stale."
 *
 * Still generated from the registry at request time. What changed is that each
 * definition now carries its own current figure — resolved through the same
 * `resolveKpi` the dashboards use, for the month and division chosen at the top —
 * so a reader sees what a metric means and what it says today in one place.
 */
const CATEGORIES: Array<{ key: string; label: string; blurb: string }> = [
  { key: 'base', label: 'Profit & loss', blurb: 'The P&L lines and ratios every dashboard reads, from QuickBooks.' },
  { key: 'finance', label: 'Finance', blurb: 'Cash, working capital, run rates and budget attainment, from QuickBooks and the budget.' },
  { key: 'sales', label: 'Sales', blurb: 'Bookings, pipeline and activity, from HubSpot.' },
  { key: 'marketing', label: 'Marketing', blurb: 'HubSpot leads against QuickBooks spend, on the agreed account sets.' },
  { key: 'operations', label: 'Operations', blurb: 'Phase 1 limited — most operational metrics depend on systems not yet integrated.' },
];

function sourceKey(source: string): KpiItem['sourceKey'] {
  const s = source.toLowerCase();
  const qbo = s.includes('quickbooks');
  const hub = s.includes('hubspot');
  const sheets = s.includes('sheets') || s.includes('budget');
  if ((qbo && hub) || (qbo && sheets) || (hub && sheets)) return 'mixed';
  if (qbo) return 'quickbooks';
  if (hub) return 'hubspot';
  if (sheets) return 'sheets';
  return 'other';
}

export default async function KpiDictionaryPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const context = await loadDashboardContext(await searchParams);
  const { session, divisionCode } = context;
  const categoryLabel = new Map(CATEGORIES.map((c) => [c.key, c.label]));

  const items: KpiItem[] = KPI_REGISTRY.map((kpi) => {
    let current: KpiItem['current'] = { value: null, unavailable: null, preliminary: false };
    let href = `/finance?month=${session.period.month.slice(0, 7)}&division=${divisionCode}`;
    try {
      const result = resolveKpi(session, kpi.id, divisionCode);
      href = result.verifyHref;
      current = result.unavailable
        ? { value: null, unavailable: result.unavailable.detail, preliminary: false }
        : { value: result.formatted, unavailable: null, preliminary: result.periodState === 'OPEN' };
    } catch (error) {
      current = { value: null, unavailable: error instanceof Error ? error.message : 'Not available.', preliminary: false };
    }

    return {
      id: kpi.id,
      name: kpi.name,
      category: kpi.category,
      categoryLabel: categoryLabel.get(kpi.category) ?? kpi.category,
      definition: kpi.definition,
      formula: kpi.formula,
      source: kpi.sourceSystem,
      sourceKey: sourceKey(kpi.sourceSystem),
      refresh: kpi.refreshCadence,
      higherIsBetter: kpi.higherIsBetter,
      isSpec: isSpecKpi(kpi.id),
      workbookLabel: kpi.workbookLabel,
      notes: kpi.notes,
      specReference: kpi.specReference,
      current,
      href,
    };
  });

  const specCount = items.filter((item) => item.isSpec).length;
  const scopeLabel = `${divisionCode === CONSOLIDATED_CODE ? 'ARG Total' : (session.bundle.divisions.find((d) => d.divisionCode === divisionCode)?.divisionName ?? divisionCode)}, ${formatMonth(session.period.month)}`;

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-[19px] font-semibold tracking-tight">KPI dictionary</h1>
        <p className="mt-1 max-w-3xl text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
          Every metric in the system: what it measures, the exact formula, where the data comes from,
          and what it reads right now for {scopeLabel}. {specCount} are the KPIs named in the build
          specification. Every dashboard, export and assistant answer uses these exact definitions —
          this page is generated from them, so it cannot drift.
        </p>
      </header>
      <Suspense>
        <KpiExplorer items={items} categories={CATEGORIES} scopeLabel={scopeLabel} />
      </Suspense>
    </div>
  );
}

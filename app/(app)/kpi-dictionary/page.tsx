import type { Metadata } from 'next';
import { KPI_REGISTRY, isSpecKpi } from '@/lib/semantic/registry';
import { Card, DataTable, SectionTitle, Td, Th } from '@/components/ui/primitives';

export const metadata: Metadata = { title: 'KPI dictionary' };

/**
 * §12 Sprint 3: "Publish the KPI dictionary: name, definition, formula, source,
 * owner, refresh cadence — generated from the semantic layer, not maintained
 * separately, so it can never go stale."
 *
 * This page reads the registry at request time. There is no second copy of any
 * definition anywhere, which is why the published dictionary and the computed
 * figures cannot drift apart.
 */
const CATEGORY_ORDER: Array<{ key: string; title: string; blurb: string }> = [
  {
    key: 'finance',
    title: 'Finance',
    blurb: 'Sourced from QuickBooks Online. Eight named KPIs plus the two annualised run rates the Excel was missing.',
  },
  {
    key: 'sales',
    title: 'Sales',
    blurb: 'Sourced from HubSpot. Nine KPIs.',
  },
  {
    key: 'marketing',
    title: 'Marketing',
    blurb: 'HubSpot leads against QuickBooks spend. Five KPIs, gated on the agreed account sets.',
  },
  {
    key: 'operations',
    title: 'Operations',
    blurb: 'Phase 1 limited. The broader operational library depends on TrackOps, ServeManager, Tazworks and iSolved, which are assessed but not integrated.',
  },
  {
    key: 'base',
    title: 'Base measures',
    blurb: 'The P&L lines and ratios every dashboard reads. Not among the 24, but defined here for the same reason.',
  },
];

export default function KpiDictionaryPage() {
  const specCount = KPI_REGISTRY.filter((k) => isSpecKpi(k.id)).length;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[19px] font-semibold tracking-tight">KPI dictionary</h1>
        <p className="mt-0.5 max-w-3xl text-[12px] leading-relaxed text-[var(--text-muted)]">
          Generated from the semantic layer at request time, not maintained separately — so it
          cannot go stale. {specCount} of these are the KPIs named in the build specification; the
          rest are the base measures they are built from. Every dashboard, export and assistant
          answer resolves through these exact definitions.
        </p>
      </header>

      {CATEGORY_ORDER.map((category) => {
        const items = KPI_REGISTRY.filter((k) => k.category === category.key);
        if (items.length === 0) return null;

        return (
          <section key={category.key}>
            <SectionTitle hint={category.blurb}>{category.title}</SectionTitle>
            <div className="space-y-3">
              {items.map((kpi) => (
                <Card key={kpi.id}>
                  <div className="mb-2 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                    <h3 className="text-[13.5px] font-semibold tracking-tight">{kpi.name}</h3>
                    <code className="rounded px-1.5 py-0.5 text-[10.5px]" style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}>
                      {kpi.id}
                    </code>
                    {isSpecKpi(kpi.id) ? (
                      <span
                        className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                        style={{ background: 'var(--series-1-wash)', color: 'var(--series-1)' }}
                      >
                        Specification KPI
                      </span>
                    ) : null}
                    <span
                      className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                      style={{
                        background: kpi.higherIsBetter ? 'var(--status-good-wash)' : 'var(--surface-2)',
                        color: kpi.higherIsBetter ? 'var(--status-good)' : 'var(--text-secondary)',
                      }}
                      title="Drives every conditional format, delta arrow and line of assistant commentary. Set once, inherited everywhere."
                    >
                      {kpi.higherIsBetter ? 'Higher is better' : 'Lower is better'}
                    </span>
                  </div>

                  <p className="mb-3 text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
                    {kpi.definition}
                  </p>

                  <DataTable>
                    <tbody>
                      <DefinitionRow label="Formula">
                        <code className="text-[11.5px]">{kpi.formula}</code>
                      </DefinitionRow>
                      <DefinitionRow label="Source">{kpi.sourceSystem}</DefinitionRow>
                      <DefinitionRow label="Refresh">{kpi.refreshCadence}</DefinitionRow>
                      <DefinitionRow label="Owner">Westport Financial</DefinitionRow>
                      <DefinitionRow label="Specification">{kpi.specReference}</DefinitionRow>
                      {/* The name ARG has used for two years. Where this build
                          renamed a metric — three of the workbook's labels
                          describe the wrong thing — the old name is published
                          alongside so it stays findable. */}
                      {kpi.workbookLabel ? (
                        <DefinitionRow label="In the workbook">{kpi.workbookLabel}</DefinitionRow>
                      ) : null}
                      {kpi.notes ? <DefinitionRow label="Notes">{kpi.notes}</DefinitionRow> : null}
                    </tbody>
                  </DataTable>
                </Card>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function DefinitionRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <tr>
      <Th align="left" className="w-[120px] align-top">
        {label}
      </Th>
      <Td align="left" numeric={false} className="!whitespace-normal">
        <span className="text-[12px] leading-relaxed">{children}</span>
      </Td>
    </tr>
  );
}

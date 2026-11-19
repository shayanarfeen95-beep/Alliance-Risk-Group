import Link from 'next/link';
import { Card, CardHeader } from '@/components/ui/primitives';

/**
 * One place that says what the dashboard is connected to and where things are.
 *
 * Alpyne Dashboard Checkpoint, 5 November 2026: "Chris proposed centralized
 * documentation of connected services, logins, and files." No secret is shown
 * here — only what each system is for, how it refreshes, and where to fix it.
 */
const SYSTEMS: Array<{ name: string; status: 'Connected' | 'Pending' | 'Optional'; what: string; refresh: string; manage: string }> = [
  {
    name: 'QuickBooks Online',
    status: 'Connected',
    what:
      'P&L and balance sheet by class (division), budgets, accounts and classes, open invoices and bills (aging), customers, invoices and credit memos (Account billing), Income by Customer (Revenue mix), and the books-closed date.',
    refresh: 'Every morning, and whenever someone presses Pull in Admin → Data & pulls. Months up to QuickBooks’ closing date are frozen as closed.',
    manage: 'Admin → Connections (sign in again if it disconnects) · Admin → Class mapping for new classes.',
  },
  {
    name: 'HubSpot',
    status: 'Connected',
    what:
      'Deals (stage, amount, owner, Line of Business, Date Compliance Review Completed, Estimated Close Date, created by), stage history, pipelines, owners (archived ones marked inactive), contacts (lifecycle, lead source), meetings, companies.',
    refresh: 'Every morning, and on Pull. After the first full read, only what changed is fetched.',
    manage: 'Admin → Connections · Admin → Account matching to tie HubSpot accounts to QuickBooks customers.',
  },
  {
    name: 'Google Sheets',
    status: 'Optional',
    what: 'The 10X growth plan, the monthly budget workbook, a reforecast and headcount, when their sheets are connected.',
    refresh: 'On Pull.',
    manage: 'Admin → Connections → Google Sheets.',
  },
  {
    name: 'SharePoint (budget and 10X plan files)',
    status: 'Pending',
    what:
      'The revised annual budget, the 10X plan and the 2027 budget, read from the specific Excel files Westport designates — not the whole folder.',
    refresh: 'Will follow the same daily refresh once connected.',
    manage:
      'Waiting on Westport (Chris, Mario, Scott) for the file location and access. Until then, upload a budget or forecast in Admin → Budget upload.',
  },
  {
    name: 'AI assistant',
    status: 'Connected',
    what:
      'Answers questions from the same definitions as the dashboards. Every dollar figure and count it states is checked against the data it read; chats are kept in Chat history.',
    refresh: 'Reads the data as it stands at the moment of the question.',
    manage: 'The model and key are set in the deployment’s environment settings.',
  },
];

const DOCUMENTS: Array<{ name: string; where: string; href?: string }> = [
  { name: 'Operating manual', where: 'Shared with Westport as a PDF; describes every page and figure.' },
  { name: 'Budget upload template', where: 'Admin → Budget upload → Download the template.', href: '/admin?tab=plans' },
  { name: 'KPI dictionary', where: 'Every metric, its definition, formula and source.', href: '/kpi-dictionary' },
  { name: 'Audit trail', where: 'Every pull, upload, mapping decision and sign-in.', href: '/admin?tab=audit' },
  { name: 'Data checks', where: 'Whether each month ties to QuickBooks.', href: '/admin?tab=checks' },
];

export function SystemsReference() {
  const tone = (status: string) =>
    status === 'Connected' ? 'var(--status-good)' : status === 'Pending' ? 'var(--status-serious)' : 'var(--text-muted)';
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Connected systems" subtitle="What each source provides, how it refreshes, and where to fix it" />
        <div className="grid gap-3 lg:grid-cols-2">
          {SYSTEMS.map((system) => (
            <div key={system.name} className="rounded-[8px] border p-3" style={{ borderColor: 'var(--border)' }}>
              <div className="flex items-center justify-between gap-2">
                <p className="text-[13px] font-semibold">{system.name}</p>
                <span className="text-[11px] font-medium" style={{ color: tone(system.status) }}>{system.status}</span>
              </div>
              <dl className="mt-2 space-y-1.5 text-[11.5px] leading-relaxed text-[var(--text-secondary)]">
                <div><dt className="inline font-semibold text-[var(--text-primary)]">Provides: </dt><dd className="inline">{system.what}</dd></div>
                <div><dt className="inline font-semibold text-[var(--text-primary)]">Refresh: </dt><dd className="inline">{system.refresh}</dd></div>
                <div><dt className="inline font-semibold text-[var(--text-primary)]">Manage: </dt><dd className="inline">{system.manage}</dd></div>
              </dl>
            </div>
          ))}
        </div>
      </Card>
      <Card>
        <CardHeader title="Documents and references" subtitle="Where the supporting material lives" />
        <ul className="space-y-1.5 text-[12px]">
          {DOCUMENTS.map((doc) => (
            <li key={doc.name}>
              {doc.href ? (
                <Link href={doc.href} className="font-medium underline underline-offset-2">{doc.name}</Link>
              ) : (
                <span className="font-medium">{doc.name}</span>
              )}
              <span className="text-[var(--text-secondary)]"> — {doc.where}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[11px] text-[var(--text-muted)]">
          Sign-ins: each person signs in with their own email; access and divisions are set in Admin → People &amp;
          access. Passwords and keys are never shown in the app.
        </p>
      </Card>
    </div>
  );
}

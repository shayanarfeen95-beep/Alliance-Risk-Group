import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getDb, isDemoMode } from '@/lib/db/client';
import { isUninitialised } from '@/lib/db/bootstrap';
import { SetupForm } from './setup-form';

export const metadata: Metadata = { title: 'Set up' };
export const dynamic = 'force-dynamic';

/**
 * First run.
 *
 * A freshly provisioned database has a schema and no accounts, which is a
 * locked door with no key. This screen is the key, and it exists only while
 * that is true — once an administrator exists it redirects to the sign-in page,
 * because an always-available account-creation screen on a financial system is
 * a hole rather than a convenience.
 */
export default async function SetupPage() {
  const db = await getDb();

  // Demo mode seeds its own accounts, so there is nothing to set up.
  if (isDemoMode() || !(await isUninitialised(db))) redirect('/login');

  return (
    <main className="mx-auto flex min-h-dvh max-w-[560px] flex-col justify-center px-6 py-12">
      <div className="mb-6">
        <h1 className="text-[20px] font-semibold tracking-tight">Set up Alliance Risk Group</h1>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
          The database is connected and its schema is applied. Create the first administrator —
          this account can see every division and connect the source systems.
        </p>
      </div>

      <SetupForm />

      <p className="mt-6 text-[11px] leading-relaxed text-[var(--text-muted)]">
        This screen disappears once an administrator exists. Everyone else is added from Admin,
        with the divisions they are entitled to see.
      </p>
    </main>
  );
}

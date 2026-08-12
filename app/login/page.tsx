import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { isDemoMode } from '@/lib/db/client';
import { getSessionUser } from '@/lib/auth/session';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage() {
  if (await getSessionUser()) redirect('/executive');

  // A provisioned-but-empty database has no account to sign in with. Send the
  // first visitor to setup rather than to a form that cannot succeed.
  if (!isDemoMode()) {
    const { isUninitialised } = await import('@/lib/db/bootstrap');
    const { getDb } = await import('@/lib/db/client');
    if (await isUninitialised(await getDb())) redirect('/setup');
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <div className="mb-6 flex items-center gap-2.5">
            <div
              aria-hidden
              className="h-7 w-7 rounded-md"
              style={{
                background: 'linear-gradient(135deg, var(--series-1), var(--series-3))',
              }}
            />
            <span className="text-[15px] font-semibold tracking-tight">Alliance Risk Group</span>
          </div>
          <h1 className="text-[22px] font-semibold tracking-tight">Sign in</h1>
          <p className="mt-1.5 text-[13px] text-[var(--text-secondary)]">
            Financial reporting, forecasting and analysis.
          </p>
        </div>

        <LoginForm />

        <p className="mt-8 border-t border-[var(--border)] pt-4 text-[11px] leading-relaxed text-[var(--text-muted)]">
          Prepared by Westport Financial — fractional CFO of record. Figures are reported on the
          accrual basis. Access is scoped by division.
        </p>
      </div>
    </main>
  );
}

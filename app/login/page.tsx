import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/auth/session';
import { LoginForm } from './login-form';
import { ConfigurationNeeded } from '@/components/shell/configuration-needed';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const next = safeNext(typeof query.next === 'string' ? query.next : null);

  if (await getSessionUser()) redirect(next ?? '/executive');

  // A provisioned-but-empty database has no account to sign in with. Send the
  // first visitor to setup rather than to a form that cannot succeed.
  //
  // A database that cannot be reached is a different thing again, and it used to
  // surface as a bare 500 with a digest — nothing anybody could act on. It now
  // says which variable to look at.
  let unreachable = false;
  try {
    const { isUninitialised } = await import('@/lib/db/bootstrap');
    const { getDb } = await import('@/lib/db/client');
    if (await isUninitialised(await getDb())) redirect('/setup');
  } catch (error) {
    // `redirect` throws by design; only a genuine failure gets the screen.
    if (error && typeof error === 'object' && 'digest' in error) throw error;
    unreachable = true;
  }

  if (unreachable) return <ConfigurationNeeded unreachable />;

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

        <LoginForm next={next} />

        <p className="mt-8 border-t border-[var(--border)] pt-4 text-[11px] leading-relaxed text-[var(--text-muted)]">
          Prepared by Westport Financial
        </p>
      </div>
    </main>
  );
}

/**
 * Where to go after signing in.
 *
 * Only a path on this site is accepted. A `next` that can name another origin is
 * an open redirect: the sign-in page is exactly where somebody would send a link
 * to make a phishing destination look like it came from us. Protocol-relative
 * URLs (`//evil.example`) are the case that slips through a naive check, so the
 * test is for a single leading slash rather than for the absence of a scheme.
 */
function safeNext(value: string | null): string | null {
  if (!value) return null;
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  return value;
}

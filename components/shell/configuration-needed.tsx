/**
 * What a deployment shows when it has nowhere to keep anything.
 *
 * This used to be impossible to reach, because a deployment with no database
 * quietly started an in-memory one and seeded it. That was worse than an error
 * screen in every way that mattered: sessions were written to whichever instance
 * served the request and vanished on the next, so signing in returned you to the
 * login page indefinitely, and nothing anywhere said why.
 *
 * A screen naming the one missing variable is a better answer than an
 * application that appears to work.
 */
export function ConfigurationNeeded({
  unreachable,
  missing = [],
}: { unreachable?: boolean; missing?: string[] } = {}) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-6 py-12">
      <div className="w-full max-w-lg">
        <div className="mb-6 flex items-center gap-2.5">
          <div
            aria-hidden
            className="h-7 w-7 rounded-md"
            style={{ background: 'linear-gradient(135deg, var(--series-1), var(--series-3))' }}
          />
          <span className="text-[15px] font-semibold tracking-tight">Alliance Risk Group</span>
        </div>

        <h1 className="text-[20px] font-semibold tracking-tight">
          {unreachable
            ? 'The database could not be reached'
            : missing.length > 1
              ? 'Two things left to configure'
              : 'One thing left to configure'}
        </h1>

        <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-secondary)]">
          {!unreachable && missing.length > 0 && !missing.includes('DATABASE_URL') ? (
            <>
              This deployment is missing{' '}
              <code className="font-[var(--font-mono)]">{missing.join(', ')}</code>. Signing in
              cannot work without it: the session cookie is signed with that key, and every instance
              has to use the same one.
            </>
          ) : unreachable ? (
            // Two genuinely different failures. Telling somebody DATABASE_URL is
            // set when it is not sends them auditing a variable that does not
            // exist — the same wasted hunt a misleading message about a missing
            // signing key already cost this deployment once.
            process.env.DATABASE_URL ? (
              <>
                <code className="font-[var(--font-mono)]">DATABASE_URL</code> is set, but connecting
                to it failed. The usual causes are a paused Neon project, a rotated password, or the
                direct connection string being used where the pooled one is needed.
              </>
            ) : (
              <>
                No <code className="font-[var(--font-mono)]">DATABASE_URL</code> is set, so this is
                running on the embedded database — and that failed to open. Usually a second copy of
                the app is already holding it, or <code className="font-[var(--font-mono)]">.pgdata</code>{' '}
                was left locked by a process that did not shut down. Stop the other copy, or delete{' '}
                <code className="font-[var(--font-mono)]">.pgdata</code> and re-seed.
              </>
            )
          ) : (
            <>
              This deployment has no database. Sign-ins, the authorisations for QuickBooks, HubSpot
              and Google Sheets, and every figure loaded from them are kept in Postgres, and none of
              it survives without one.
            </>
          )}
        </p>

        <div
          className="mt-5 rounded-[var(--radius)] border p-4"
          style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}
        >
          <p className="text-[12px] font-medium">
            {missing.length && !missing.includes('DATABASE_URL')
              ? 'Set this in Vercel, then redeploy'
              : 'Set one environment variable'}
          </p>
          <pre
            className="mt-2 overflow-x-auto rounded-[var(--radius-sm)] px-3 py-2 text-[11.5px]"
            style={{ background: 'var(--surface-2)' }}
          >
            <code className="font-[var(--font-mono)]">
              {missing.length && !missing.includes('DATABASE_URL')
                ? missing.map((name) => `${name}=…`).join('\n')
                : 'DATABASE_URL=postgres://…-pooler…neon.tech/neondb?sslmode=require'}
            </code>
          </pre>
          <p className="mt-2.5 text-[11.5px] leading-relaxed text-[var(--text-muted)]">
            Neon&rsquo;s free tier is enough. Use the <strong>pooled</strong> connection string —
            the one containing <code className="font-[var(--font-mono)]">-pooler</code> — because
            this application sets <code className="font-[var(--font-mono)]">prepare:false</code>,
            which is what pgbouncer in transaction mode requires.
          </p>
          <p className="mt-2 text-[11.5px] leading-relaxed text-[var(--text-muted)]">
            Set <code className="font-[var(--font-mono)]">AUTH_SECRET</code> at the same time
            (<code className="font-[var(--font-mono)]">openssl rand -base64 48</code>). Every
            instance has to sign sessions with the same key.
          </p>
        </div>

        <p className="mt-5 text-[11.5px] leading-relaxed text-[var(--text-muted)]">
          The schema applies itself on the first request afterwards, and the first visit then offers
          a screen to create the administrator account. Nothing is seeded: every figure that appears
          will have come from a source you connected.
        </p>
      </div>
    </main>
  );
}

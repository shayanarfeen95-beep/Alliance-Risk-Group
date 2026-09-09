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
export function ConfigurationNeeded({ unreachable }: { unreachable?: boolean } = {}) {
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
          {unreachable ? 'The database could not be reached' : 'One thing left to configure'}
        </h1>

        <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-secondary)]">
          {unreachable ? (
            <>
              <code className="font-[var(--font-mono)]">DATABASE_URL</code> is set, but connecting to
              it failed. The usual causes are a paused Neon project, a rotated password, or the
              direct connection string being used where the pooled one is needed.
            </>
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
          <p className="text-[12px] font-medium">Set one environment variable</p>
          <pre
            className="mt-2 overflow-x-auto rounded-[var(--radius-sm)] px-3 py-2 text-[11.5px]"
            style={{ background: 'var(--surface-2)' }}
          >
            <code className="font-[var(--font-mono)]">
              DATABASE_URL=postgres://…-pooler…neon.tech/neondb?sslmode=require
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

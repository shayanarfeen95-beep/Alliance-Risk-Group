import { CircleAlert, CircleCheck, CircleHelp } from 'lucide-react';
import type { SourceReadiness } from '@/lib/connectors/readiness';

/**
 * What is still missing, said before anyone tries.
 *
 * Every row is derived from the environment at request time and reports only
 * whether a variable is set — never its value. That is deliberate: this screen
 * is visible to anyone with Admin, and a panel that prints secrets to prove
 * they exist is a worse problem than the one it solves.
 */
export function ConnectionReadiness({ readiness }: { readiness: SourceReadiness[] }) {
  const blocked = readiness.filter((source) => !source.ready);

  return (
    <div className="space-y-3">
      {blocked.length > 0 ? (
        <p
          className="flex items-start gap-2 rounded-[var(--radius)] px-3 py-2.5 text-[11.5px] leading-relaxed"
          style={{ background: 'var(--status-warning-wash)', color: 'var(--text-secondary)' }}
        >
          <CircleAlert
            size={13}
            className="mt-px shrink-0"
            style={{ color: 'var(--status-warning)' }}
            aria-hidden
          />
          <span>
            <strong className="font-medium text-[var(--text-primary)]">
              {blocked.length === readiness.length
                ? 'No source can be connected yet.'
                : `${blocked.length} of ${readiness.length} sources cannot be connected yet.`}
            </strong>{' '}
            The variables below are read from this deployment&rsquo;s environment. Set them in
            Vercel → Project → Settings → Environment Variables, redeploy, and this panel turns
            green.
          </span>
        </p>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-3">
        {readiness.map((source) => (
          <div
            key={source.sourceSystem}
            className="rounded-[var(--radius)] border p-3"
            style={{
              borderColor: source.ready ? 'var(--border)' : 'var(--status-warning)',
              background: 'var(--surface-1)',
            }}
          >
            <div className="mb-1.5 flex items-center gap-1.5">
              {source.ready ? (
                <CircleCheck size={13} style={{ color: 'var(--status-good)' }} aria-hidden />
              ) : (
                <CircleAlert size={13} style={{ color: 'var(--status-warning)' }} aria-hidden />
              )}
              <h3 className="text-[12.5px] font-semibold">{source.label}</h3>
            </div>

            <p className="mb-2 text-[11px] leading-relaxed text-[var(--text-secondary)]">
              {source.summary}
            </p>

            <ul className="space-y-1">
              {source.requirements.map((requirement) => (
                <li key={requirement.name} className="flex items-start gap-1.5 text-[10.5px]">
                  {requirement.present ? (
                    <CircleCheck
                      size={11}
                      className="mt-0.5 shrink-0"
                      style={{ color: 'var(--status-good)' }}
                      aria-hidden
                    />
                  ) : requirement.severity === 'required' ? (
                    <CircleAlert
                      size={11}
                      className="mt-0.5 shrink-0"
                      style={{ color: 'var(--status-warning)' }}
                      aria-hidden
                    />
                  ) : (
                    <CircleHelp
                      size={11}
                      className="mt-0.5 shrink-0"
                      style={{ color: 'var(--text-muted)' }}
                      aria-hidden
                    />
                  )}
                  <span className="min-w-0">
                    <code className="font-[var(--font-mono)] text-[10px] text-[var(--text-primary)]">
                      {requirement.name}
                    </code>
                    {requirement.severity === 'optional' ? (
                      <span className="ml-1 text-[var(--text-muted)]">(optional)</span>
                    ) : null}
                    <span className="block text-[var(--text-muted)]">{requirement.purpose}</span>
                    {!requirement.present ? (
                      <span className="block text-[var(--text-secondary)]">{requirement.howTo}</span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>

            <p className="mt-2 border-t pt-2 text-[10.5px] leading-relaxed text-[var(--text-muted)]" style={{ borderColor: 'var(--border)' }}>
              {source.recommendedPath}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

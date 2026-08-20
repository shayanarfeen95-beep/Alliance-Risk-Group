'use client';

import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';
import { GitBranch } from 'lucide-react';

/**
 * The HubSpot pipeline selector.
 *
 * A portal with one pipeline does not need this control, and showing a
 * single-option dropdown implies a choice that does not exist — so it renders
 * nothing until there are two.
 */
export function PipelineFilter({
  pipelines,
  selected,
}: {
  pipelines: string[];
  selected: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  if (pipelines.length < 2) return null;

  return (
    <div className="flex items-center gap-1.5">
      <GitBranch size={12} className="shrink-0 text-[var(--text-muted)]" aria-hidden />
      <label className="sr-only" htmlFor="pipeline-filter">
        Pipeline
      </label>
      <select
        id="pipeline-filter"
        value={selected ?? ''}
        disabled={pending}
        onChange={(event) => {
          const params = new URLSearchParams(searchParams.toString());
          if (event.target.value) params.set('pipeline', event.target.value);
          else params.delete('pipeline');
          startTransition(() => router.push(`${pathname}?${params.toString()}`));
        }}
        className="h-7 rounded-[5px] border px-2 text-[11.5px] outline-none"
        style={{
          background: 'var(--surface-1)',
          borderColor: 'var(--border)',
          color: 'var(--text-primary)',
        }}
      >
        <option value="">All pipelines</option>
        {pipelines.map((pipeline) => (
          <option key={pipeline} value={pipeline}>
            {pipeline === 'default' ? 'Sales Pipeline' : pipeline}
          </option>
        ))}
      </select>
    </div>
  );
}

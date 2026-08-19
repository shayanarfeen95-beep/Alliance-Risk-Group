'use client';

import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';
import { User } from 'lucide-react';

/**
 * The salesperson filter ARG's leadership asked for.
 *
 * Sits on the Deals card rather than in the global bar, because it only applies
 * to one view. A global control that silently does nothing on four of six pages
 * is how a filter bar stops meaning anything.
 */
export function OwnerFilter({ owners, selected }: { owners: string[]; selected: string | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  if (owners.length === 0) return null;

  return (
    <div className="flex items-center gap-1.5">
      <User size={12} className="shrink-0 text-[var(--text-muted)]" aria-hidden />
      <label className="sr-only" htmlFor="owner-filter">
        Salesperson
      </label>
      <select
        id="owner-filter"
        value={selected ?? ''}
        disabled={pending}
        onChange={(event) => {
          const params = new URLSearchParams(searchParams.toString());
          if (event.target.value) params.set('owner', event.target.value);
          else params.delete('owner');
          startTransition(() => router.push(`${pathname}?${params.toString()}`));
        }}
        className="h-7 rounded-[5px] border px-2 text-[11.5px] outline-none"
        style={{
          background: 'var(--surface-1)',
          borderColor: 'var(--border)',
          color: 'var(--text-primary)',
        }}
      >
        <option value="">All salespeople</option>
        {owners.map((owner) => (
          <option key={owner} value={owner}>
            {owner}
          </option>
        ))}
      </select>
    </div>
  );
}

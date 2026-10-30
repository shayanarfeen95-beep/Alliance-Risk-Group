'use client';

/**
 * A pull keeps running while you look at another Admin section; this says so,
 * and takes you back to it.
 */
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { usePullProgress } from './data-controls';

export function PullIndicator({ onDataTab }: { onDataTab: boolean }) {
  const { busy, finished, total } = usePullProgress();
  if (!busy || onDataTab) return null;
  return (
    <Link
      href="/admin?tab=data"
      className="flex items-center gap-2 rounded-[var(--radius)] border px-3 py-2 text-[12px]"
      style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}
    >
      <Loader2 size={13} className="animate-spin" aria-hidden />
      <span>
        A pull is running — {finished} of {total} done. It carries on while you work here.
      </span>
      <span className="ml-auto font-medium" style={{ color: 'var(--series-1)' }}>
        Watch it
      </span>
    </Link>
  );
}

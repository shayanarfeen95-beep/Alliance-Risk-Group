'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LoaderCircle, Trash2 } from 'lucide-react';

/**
 * Removes a box the assistant built.
 *
 * No confirmation dialog: the box is a saved specification, it belongs to the
 * person clicking, and rebuilding it is one sentence to the assistant. A modal
 * here would protect nothing.
 */
export function RemoveBox({ boxId, title }: { boxId: string; title: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function remove() {
    setBusy(true);
    try {
      const response = await fetch(`/api/boxes/${boxId}`, { method: 'DELETE' });
      if (response.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={remove}
      disabled={busy}
      title={`Remove "${title}" from this dashboard`}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)] transition-colors hover:bg-[var(--surface-2)] disabled:opacity-40"
      style={{ color: 'var(--text-muted)' }}
    >
      {busy ? (
        <LoaderCircle size={12} className="animate-spin" aria-hidden />
      ) : (
        <Trash2 size={12} aria-hidden />
      )}
      <span className="sr-only">Remove {title}</span>
    </button>
  );
}

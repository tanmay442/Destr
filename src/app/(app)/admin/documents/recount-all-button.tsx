'use client';

import { useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { recountAllChunksAction } from '../actions';

export function RecountAllButton() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const params = useSearchParams();
  return (
    <>
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          setError(null);
          const res = await recountAllChunksAction();
          if (res.error) {
            setError(res.error);
            return;
          }
          const next = new URLSearchParams(params.toString());
          if (typeof res.documents === 'number') {
            next.set('recountedDocs', String(res.documents));
          }
          if (typeof res.total === 'number') {
            next.set('recountedTotal', String(res.total));
          }
          router.push(`/admin/documents?${next.toString()}`);
        })
      }
      className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--foreground)] transition-colors hover:bg-[var(--surface-elevated)] disabled:opacity-50"
      data-testid="documents-recount-all"
    >
      {pending ? 'Recounting…' : 'Recount all chunks'}
    </button>
    {error && (
      <p className="text-sm text-red-500" role="alert" data-testid="recount-error">
        {error}
      </p>
    )}
    </>
  );
}

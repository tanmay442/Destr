'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

const POLL_INTERVAL_MS = 3000;

/** Refreshes the documents list on an interval while any document is
 *  `queued` or `ingesting`, so the admin UI reflects the async
 *  ingest progress without a manual reload. Stops polling once all
 *  documents have settled (`done` / `failed`). No-op when there is
 *  nothing pending. */
export function IngestStatusPoller({ hasPending }: { hasPending: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!hasPending) return;
    const id = setInterval(() => {
      router.refresh();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [hasPending, router]);
  return null;
}

'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

const POLL_INTERVAL_MS = 3000;

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

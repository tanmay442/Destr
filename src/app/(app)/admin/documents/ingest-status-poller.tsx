'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

const POLL_INTERVAL_MS = 3000;

export function IngestStatusPoller({ hasPending }: { hasPending: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!hasPending) return;
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (id === null) id = setInterval(() => router.refresh(), POLL_INTERVAL_MS);
    };
    const stop = () => {
      if (id !== null) {
        clearInterval(id);
        id = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') stop();
      else start();
    };
    if (document.visibilityState === 'hidden') stop();
    else start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [hasPending, router]);
  return null;
}

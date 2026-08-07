'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

const INITIAL_POLL_MS = 1000;
const MAX_POLL_MS = 5000;

type StatusPayload = { pending: number };

export function IngestStatusPoller({ hasPending }: { hasPending: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!hasPending) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight: boolean = false;
    let delayMs = INITIAL_POLL_MS;
    let lastPending: boolean = hasPending;

    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const schedule = () => {
      if (!active) return;
      clearTimer();
      timer = setTimeout(() => {
        void run();
      }, delayMs);
    };

    const run = async () => {
      if (!active || inFlight) return;
      inFlight = true;
      try {
        const res = await fetch('/api/admin/documents/status', { cache: 'no-store' });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as StatusPayload;
        const pendingNow = data.pending > 0;
        if (pendingNow !== lastPending) {
          lastPending = pendingNow;
          router.refresh();
        }
        if (pendingNow) {
          delayMs = Math.min(MAX_POLL_MS, delayMs * 1.5);
        }
      } catch {
        delayMs = Math.min(MAX_POLL_MS, delayMs * 2);
      } finally {
        inFlight = false;
        schedule();
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        active = false;
        clearTimer();
      } else {
        active = true;
        schedule();
      }
    };

    schedule();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      active = false;
      clearTimer();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [hasPending, router]);
  return null;
}

'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/sonner';

export interface SettingsChange {
  key: string;
  old: unknown;
  new: unknown;
}

function setDeep(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const p = parts[i]!;
    if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

export function SettingsRevertButton({ changes }: { changes: SettingsChange[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const revert = async () => {
    setBusy(true);
    try {
      const current = await fetch('/api/admin/settings');
      if (!current.ok) throw new Error('Failed to load current settings');
      const { version } = (await current.json()) as { version: number };
      const patch: Record<string, unknown> = {};
      for (const c of changes) setDeep(patch, c.key, c.old);
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patch, expectedVersion: version }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.ok) {
        toast.success('Settings reverted');
        router.refresh();
      } else {
        toast.error(data.error ?? `Revert failed (${res.status})`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Revert failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={busy || changes.length === 0}
      onClick={revert}
      data-testid="settings-revert"
    >
      Revert
    </Button>
  );
}

'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/sonner';

const VERDICTS = [
  { value: 'good', label: 'Good', tone: 'text-success' },
  { value: 'bad', label: 'Bad', tone: 'text-destructive' },
  { value: 'docs_missing', label: 'Docs Missing', tone: 'text-warning' },
] as const;

type Verdict = (typeof VERDICTS)[number]['value'];

/** One row's Good / Bad / Docs Missing controls; POSTs to /api/admin/quality [§C4]. */
export function ReviewButtons({ turnId }: { turnId: string }) {
  const [submitted, setSubmitted] = useState<Verdict | null>(null);
  const [note, setNote] = useState('');
  const [pending, startTransition] = useTransition();

  const submit = (verdict: Verdict) => {
    startTransition(async () => {
      try {
        const res = await fetch('/api/admin/quality', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ turnId, verdict, ...(note.trim() ? { note: note.trim() } : {}) }),
        });
        if (!res.ok) {
          toast.error('Could not save review');
          return;
        }
        setSubmitted(verdict);
        toast.success(`Reviewed as ${VERDICTS.find((v) => v.value === verdict)?.label}`);
      } catch {
        toast.error('Could not save review');
      }
    });
  };

  if (submitted) {
    return (
      <span className="text-xs text-muted-foreground" data-testid={`quality-reviewed-${turnId}`}>
        {VERDICTS.find((v) => v.value === submitted)?.label} ✓
      </span>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex gap-1">
        {VERDICTS.map((v) => (
          <Button
            key={v.value}
            variant="outline"
            size="xs"
            disabled={pending}
            className={v.tone}
            data-testid={`quality-verdict-${v.value}-${turnId}`}
            onClick={() => submit(v.value)}
          >
            {v.label}
          </Button>
        ))}
      </div>
      <Input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Note (optional)"
        maxLength={2000}
        className="h-7 w-48 text-xs"
        data-testid={`quality-note-${turnId}`}
      />
      {note.length > 0 ? (
        <span className="text-[11px] text-muted-foreground tabular-nums" data-testid={`quality-note-count-${turnId}`}>
          {note.length}/2000
        </span>
      ) : null}
    </div>
  );
}

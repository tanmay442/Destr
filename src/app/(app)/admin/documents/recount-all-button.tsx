'use client';

import { useTransition } from 'react';
import { Calculator } from 'lucide-react';
import { recountAllChunksAction } from '../actions';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/sonner';

export function RecountAllButton() {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const res = await recountAllChunksAction();
          if (res.error) {
            toast.error(res.error);
            return;
          }
          toast.success(
            `Recounted ${res.documents ?? 0} document${res.documents === 1 ? '' : 's'} — ${(res.total ?? 0).toLocaleString()} total chunks`,
          );
        })
      }
      data-testid="documents-recount-all"
    >
      <Calculator data-icon="inline-start" />
      {pending ? 'Recounting…' : 'Recount'}
    </Button>
  );
}

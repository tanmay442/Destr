'use client';

import { useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Calculator } from 'lucide-react';
import { recountAllChunksAction } from '../actions';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/sonner';

export function RecountAllButton() {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const params = useSearchParams();
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
      data-testid="documents-recount-all"
    >
      <Calculator data-icon="inline-start" />
      {pending ? 'Recounting…' : 'Recount'}
    </Button>
  );
}

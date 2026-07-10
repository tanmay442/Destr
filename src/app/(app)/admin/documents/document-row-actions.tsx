'use client';

import Link from 'next/link';
import { useTransition } from 'react';
import {
  deleteDocumentAction,
  restoreDocumentAction,
  hardDeleteDocumentAction,
  recountChunksAction,
} from '../actions';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/sonner';

const btn =
  'text-muted-foreground hover:bg-surface-elevated hover:text-foreground';

export function DocumentRowActions({
  id,
  fileName,
  hasBlob,
  isDeleted,
}: {
  id: number;
  fileName: string;
  hasBlob: boolean;
  isDeleted: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [recountPending, startRecount] = useTransition();
  const [hardDeletePending, startHardDelete] = useTransition();
  return (
    <div className="flex flex-wrap items-center gap-1">
      {hasBlob && !isDeleted ? (
        <>
          <Button
            asChild
            variant="outline"
            size="xs"
            className={btn}
            data-testid={`documents-preview-${id}`}
          >
            <Link href={`/admin/documents/${id}/preview`}>Preview</Link>
          </Button>
          <Button
            asChild
            variant="outline"
            size="xs"
            className={btn}
            data-testid={`documents-download-${id}`}
          >
            <a href={`/api/admin/documents/${id}/download`}>Download</a>
          </Button>
        </>
      ) : null}
      {isDeleted ? (
        <Button
          variant="outline"
          size="xs"
          className="border-success/40 text-success hover:bg-success/10"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const res = await restoreDocumentAction(id);
              if (res.error) toast.error(res.error);
              else toast.success('Document restored');
            })
          }
          data-testid={`documents-restore-${id}`}
        >
          {pending ? 'Restoring…' : 'Restore'}
        </Button>
      ) : (
        <Button
          variant="outline"
          size="xs"
          className={btn}
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const res = await deleteDocumentAction(id);
              if (res.error) toast.error(res.error);
              else toast.success('Document deleted');
            })
          }
          data-testid={`documents-delete-${id}`}
        >
          {pending ? 'Deleting…' : 'Delete'}
        </Button>
      )}
      {isDeleted ? (
        <Button
          variant="outline"
          size="xs"
          className="border-destructive/40 text-destructive hover:bg-destructive/10"
          disabled={hardDeletePending}
          onClick={() =>
            startHardDelete(async () => {
              const res = await hardDeleteDocumentAction(id);
              if (res.error) toast.error(res.error);
              else toast.success('Document permanently removed');
            })
          }
          data-testid={`documents-hard-delete-${id}`}
        >
          {hardDeletePending ? 'Removing…' : 'Hard delete'}
        </Button>
      ) : null}
      <Button
        variant="outline"
        size="xs"
        className={btn}
        disabled={recountPending}
        onClick={() =>
          startRecount(async () => {
            const res = await recountChunksAction(id);
            if (res.error) toast.error(res.error);
            else if (typeof res.count === 'number')
              toast.success(`Recount: ${res.count} chunks`);
          })
        }
        data-testid={`documents-recount-${id}`}
      >
        {recountPending ? 'Recounting…' : 'Recount chunks'}
      </Button>
      <span className="sr-only">{fileName}</span>
    </div>
  );
}

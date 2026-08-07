'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { MoreHorizontal } from 'lucide-react';
import {
  deleteDocumentAction,
  restoreDocumentAction,
  hardDeleteDocumentAction,
  recountChunksAction,
} from '../actions';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/sonner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';

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
  const [hardDeleteOpen, setHardDeleteOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Actions for ${fileName}`}
          data-testid={`documents-actions-${id}`}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {hasBlob && !isDeleted ? (
          <>
            <DropdownMenuItem asChild>
              <Link
                href={`/admin/documents/${id}/preview`}
                data-testid={`documents-preview-${id}`}
              >
                Preview
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <a
                href={`/api/admin/documents/${id}/download`}
                data-testid={`documents-download-${id}`}
              >
                Download
              </a>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
        {isDeleted ? (
          <DropdownMenuItem
            disabled={pending}
            onSelect={() =>
              startTransition(async () => {
                const res = await restoreDocumentAction(id);
                if (res.error) toast.error(res.error);
                else toast.success('Document restored');
              })
            }
            data-testid={`documents-restore-${id}`}
          >
            {pending ? 'Restoring…' : 'Restore'}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            disabled={pending}
            onSelect={() =>
              startTransition(async () => {
                const res = await deleteDocumentAction(id);
                if (res.error) toast.error(res.error);
                else toast.success('Document deleted');
              })
            }
            data-testid={`documents-delete-${id}`}
            className="text-muted-foreground focus:text-foreground"
          >
            {pending ? 'Deleting…' : 'Delete'}
          </DropdownMenuItem>
        )}
        {isDeleted ? (
          <DropdownMenuItem
            disabled={hardDeletePending}
            onSelect={() => {
              setConfirmText('');
              setHardDeleteOpen(true);
            }}
            className="text-destructive focus:text-destructive"
            data-testid={`documents-hard-delete-${id}`}
          >
            Hard delete
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          disabled={recountPending}
          onSelect={() =>
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
        </DropdownMenuItem>
        <span className="sr-only">{fileName}</span>
      </DropdownMenuContent>
      <Dialog open={hardDeleteOpen} onOpenChange={setHardDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Permanently delete document?</DialogTitle>
            <DialogDescription>
              This permanently removes the document and its chunks. Type the file
              name to confirm.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`hard-delete-confirm-${id}`}>File name</Label>
            <Input
              id={`hard-delete-confirm-${id}`}
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={fileName}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setHardDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={confirmText !== fileName || hardDeletePending}
              onClick={() =>
                startHardDelete(async () => {
                  const res = await hardDeleteDocumentAction(id);
                  setHardDeleteOpen(false);
                  setConfirmText('');
                  if (res.error) toast.error(res.error);
                  else toast.success('Document permanently removed');
                })
              }
            >
              {hardDeletePending ? 'Removing…' : 'Permanently delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DropdownMenu>
  );
}

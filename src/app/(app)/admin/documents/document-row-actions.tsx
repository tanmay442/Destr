'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import {
  deleteDocumentAction,
  restoreDocumentAction,
  hardDeleteDocumentAction,
  recountChunksAction,
} from '../actions';

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
  const [error, setError] = useState<string | null>(null);
  const [recountPending, startRecount] = useTransition();
  const [recountCount, setRecountCount] = useState<number | null>(null);
  const [recountError, setRecountError] = useState<string | null>(null);
  const [hardDeletePending, startHardDelete] = useTransition();
  const btn =
    'rounded-xl border border-border px-2 py-1 text-xs text-foreground-muted transition-colors hover:bg-surface-elevated hover:text-foreground disabled:opacity-50';
  return (
    <div className="flex flex-wrap items-center gap-1">
      {hasBlob && !isDeleted ? (
        <>
          <Link
            href={`/admin/documents/${id}/preview`}
            className={btn}
            data-testid={`documents-preview-${id}`}
          >
            Preview
          </Link>
          <a
            href={`/api/admin/documents/${id}/download`}
            className={btn}
            data-testid={`documents-download-${id}`}
          >
            Download
          </a>
        </>
      ) : null}
      {isDeleted ? (
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              setError(null);
              const res = await restoreDocumentAction(id);
              if (res.error) setError(res.error);
            })
          }
          className="rounded-xl border border-success/40 px-2 py-1 text-xs text-success transition-colors hover:bg-success/10 disabled:opacity-50"
          data-testid={`documents-restore-${id}`}
        >
          {pending ? 'Restoring…' : 'Restore'}
        </button>
      ) : (
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              setError(null);
              const res = await deleteDocumentAction(id);
              if (res.error) setError(res.error);
            })
          }
          className={btn}
          data-testid={`documents-delete-${id}`}
        >
          {pending ? 'Deleting…' : 'Delete'}
        </button>
      )}
      {isDeleted ? (
        <button
          type="button"
          disabled={hardDeletePending}
          onClick={() =>
            startHardDelete(async () => {
              setError(null);
              const res = await hardDeleteDocumentAction(id);
              if (res.error) setError(res.error);
            })
          }
          className="rounded-xl border border-danger/40 px-2 py-1 text-xs text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
          data-testid={`documents-hard-delete-${id}`}
        >
          {hardDeletePending ? 'Removing…' : 'Hard delete'}
        </button>
      ) : null}
      <button
        type="button"
        disabled={recountPending}
        onClick={() =>
          startRecount(async () => {
            setRecountError(null);
            const res = await recountChunksAction(id);
            if (res.error) {
              setRecountError(res.error);
            } else if (typeof res.count === 'number') {
              setRecountCount(res.count);
            }
          })
        }
        className={btn}
        data-testid={`documents-recount-${id}`}
      >
        {recountPending ? 'Recounting…' : 'Recount chunks'}
      </button>
      {recountCount !== null ? (
        <span
          className="text-xs text-success"
          data-testid={`documents-recount-result-${id}`}
        >
          → {recountCount}
        </span>
      ) : null}
      {recountError ? (
        <span
          className="text-xs text-danger"
          role="alert"
          data-testid={`documents-recount-error-${id}`}
        >
          {recountError}
        </span>
      ) : null}
      {error ? (
        <span className="text-xs text-danger" role="alert">
          {error}
        </span>
      ) : null}
      <span className="sr-only">{fileName}</span>
    </div>
  );
}

'use client';

import { useState, useTransition } from 'react';
import { useSession } from '@clerk/nextjs';
import { setRoleAction } from '../actions';

export function UserRowActions({
  clerkUserId,
  role,
}: {
  clerkUserId: string;
  role: 'admin' | 'user';
}) {
  const { session } = useSession();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            setMessage(null);
            const next: 'admin' | 'user' = role === 'admin' ? 'user' : 'admin';
            const res = await setRoleAction(clerkUserId, next);
            if (res.error) setError(res.error);
            else {
              await session?.reload();
              setMessage(`Role set to ${next}`);
            }
          })
        }
        className="rounded-xl border border-border px-2 py-1 text-xs text-foreground-muted transition-colors hover:bg-surface-elevated hover:text-foreground disabled:opacity-50"
        data-testid={`users-toggle-role-${clerkUserId}`}
      >
        {pending ? '…' : role === 'admin' ? 'Demote' : 'Promote'}
      </button>
      {error ? (
        <span className="text-xs text-danger" role="alert">
          {error}
        </span>
      ) : null}
      {message ? (
        <span className="text-xs text-success" role="status">
          {message}
        </span>
      ) : null}
    </div>
  );
}

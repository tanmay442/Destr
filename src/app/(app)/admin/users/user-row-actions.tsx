'use client';

import { useTransition } from 'react';
import { useSession } from '@clerk/nextjs';
import { setRoleAction } from '../actions';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/sonner';

const btn =
  'text-muted-foreground hover:bg-surface-elevated hover:text-foreground';

export function UserRowActions({
  clerkUserId,
  role,
}: {
  clerkUserId: string;
  role: 'admin' | 'user';
}) {
  const { session } = useSession();
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Button
        variant="outline"
        size="xs"
        className={btn}
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const next: 'admin' | 'user' = role === 'admin' ? 'user' : 'admin';
            const res = await setRoleAction(clerkUserId, next);
            if (res.error) toast.error(res.error);
            else {
              await session?.reload();
              toast.success(`Role set to ${next}`);
            }
          })
        }
        data-testid={`users-toggle-role-${clerkUserId}`}
      >
        {pending ? '…' : role === 'admin' ? 'Demote' : 'Promote'}
      </Button>
    </div>
  );
}

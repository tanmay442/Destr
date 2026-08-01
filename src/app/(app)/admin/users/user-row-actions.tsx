'use client';

import { useTransition } from 'react';
import { useSession } from '@clerk/nextjs';
import { ShieldCheck, ShieldOff } from 'lucide-react';
import { setRoleAction } from '../actions';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/sonner';

export function UserRowActions({
  clerkUserId,
  role,
}: {
  clerkUserId: string;
  role: 'admin' | 'user';
}) {
  const { session } = useSession();
  const [pending, startTransition] = useTransition();
  const isAdmin = role === 'admin';
  return (
    <Button
      variant="outline"
      size="xs"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const next: 'admin' | 'user' = isAdmin ? 'user' : 'admin';
          const res = await setRoleAction(clerkUserId, next);
          if (res.error) {
            toast.error(res.error);
            return;
          }
          await session?.reload();
          toast.success(`Role set to ${next}`);
        })
      }
      data-testid={`users-toggle-role-${clerkUserId}`}
      className="text-muted-foreground hover:text-foreground"
    >
      {isAdmin ? <ShieldOff data-icon="inline-start" /> : <ShieldCheck data-icon="inline-start" />}
      {pending ? '…' : isAdmin ? 'Demote' : 'Promote'}
    </Button>
  );
}

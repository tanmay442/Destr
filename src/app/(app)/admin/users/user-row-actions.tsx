'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from '@clerk/nextjs';
import { ShieldCheck, ShieldOff } from 'lucide-react';
import { setRoleAction } from '../actions';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export function UserRowActions({
  clerkUserId,
  role,
}: {
  clerkUserId: string;
  role: 'admin' | 'user';
}) {
  const { session } = useSession();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const isAdmin = role === 'admin';
  const isSelf = session?.user.id === clerkUserId;

  const toggleRole = async () => {
    const next: 'admin' | 'user' = isAdmin ? 'user' : 'admin';
    const res = await setRoleAction(clerkUserId, next);
    setConfirmOpen(false);
    if (res.error) {
      toast.error(res.error);
      return;
    }
    await session?.reload();
    toast.success(`Role set to ${next}`);
    if (next === 'user' && isSelf) {
      router.replace('/');
    }
  };

  return (
    <>
      <Button
        variant="outline"
        size="xs"
        disabled={pending}
        onClick={() => {
          if (isSelf && isAdmin) setConfirmOpen(true);
          else startTransition(() => void toggleRole());
        }}
        data-testid={`users-toggle-role-${clerkUserId}`}
        className="text-muted-foreground hover:text-foreground"
      >
        {isAdmin ? <ShieldOff data-icon="inline-start" /> : <ShieldCheck data-icon="inline-start" />}
        {pending ? '…' : isAdmin ? 'Demote' : 'Promote'}
      </Button>
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove your admin access?</DialogTitle>
            <DialogDescription>
              You are about to demote yourself to a regular user. You will lose
              access to the admin console immediately.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => startTransition(() => void toggleRole())}
            >
              {pending ? 'Demoting…' : 'Demote myself'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

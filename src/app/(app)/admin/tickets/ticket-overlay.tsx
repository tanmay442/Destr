'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { XIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { TicketDrawer, type UserOption } from './ticket-drawer';

export interface TicketRow {
  ticketId: string;
  userId: string;
  name: string;
  email: string;
  issue: string;
  status: string;
  assignedTo: string | null;
  notes: string | null;
}

export function TicketOverlay({
  tickets,
  userOptions,
}: {
  tickets: TicketRow[];
  userOptions: UserOption[];
}) {
  const router = useRouter();
  const params = useSearchParams();
  const activeId = params.get('ticket');

  function close() {
    const next = new URLSearchParams(params.toString());
    next.delete('ticket');
    const qs = next.toString();
    router.push(`/admin/tickets${qs ? `?${qs}` : ''}`);
  }

  function clearFilters() {
    const next = new URLSearchParams(params.toString());
    next.delete('status');
    next.delete('assignee');
    next.delete('q');
    const qs = next.toString();
    router.push(`/admin/tickets${qs ? `?${qs}` : ''}`);
  }

  const ticket = activeId
    ? tickets.find((t) => t.ticketId === activeId) ?? null
    : null;

  return (
    <Sheet
      open={!!activeId}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <SheetContent
        side="right"
        showCloseButton={false}
        data-testid="ticket-overlay"
        className={cn(
          'flex h-full w-full flex-col gap-0 border-l border-border-subtle bg-card p-0 shadow-2xl',
          'sm:max-w-md',
        )}
      >
        <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
          <SheetTitle className="text-sm font-semibold tracking-tight text-foreground">
            {ticket ? `Ticket ${ticket.ticketId}` : activeId}
          </SheetTitle>
          <SheetDescription className="sr-only">
            Ticket details and actions
          </SheetDescription>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Close ticket"
            onClick={close}
            data-testid="ticket-overlay-close"
            className="text-muted-foreground hover:bg-surface-elevated hover:text-foreground"
          >
            <XIcon />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {ticket ? (
            <TicketDrawer
              key={ticket.ticketId}
              ticketId={ticket.ticketId}
              name={ticket.name}
              email={ticket.email}
              issue={ticket.issue}
              status={ticket.status}
              assignedTo={ticket.assignedTo}
              notes={ticket.notes}
              userOptions={userOptions}
            />
          ) : (
            <div
              className="flex flex-col gap-3 rounded-lg border border-border-subtle bg-surface-elevated p-4 text-sm text-muted-foreground"
              data-testid="ticket-overlay-not-in-view"
            >
              <p>
                Ticket <strong className="text-foreground">{activeId}</strong> is not in the
                current filtered view. Clear the filter to see it here.
              </p>
              <Button type="button" size="sm" onClick={clearFilters} className="self-start">
                Clear filter
              </Button>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

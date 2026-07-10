'use client';

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useRouter, useSearchParams } from 'next/navigation';
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

  const closeRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!activeId) return;
    function close() {
      const next = new URLSearchParams(params.toString());
      next.delete('ticket');
      const qs = next.toString();
      router.push(`/admin/tickets${qs ? `?${qs}` : ''}`);
    }
    closeRef.current = close;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    window.addEventListener('keydown', onKey);

    const prev = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';

    return () => {
      window.removeEventListener('keydown', onKey);
      document.documentElement.style.overflow = prev;
    };
  }, [activeId, params, router]);

  const overlayRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (activeId) overlayRef.current?.focus();
  }, [activeId]);

  if (!activeId) return null;
  if (typeof document === 'undefined') return null;

  const ticket = tickets.find((t) => t.ticketId === activeId) ?? null;

  function close() {
    const next = new URLSearchParams(params.toString());
    next.delete('ticket');
    const qs = next.toString();
    router.push(`/admin/tickets${qs ? `?${qs}` : ''}`);
  }

  return createPortal(
    <div
      ref={overlayRef}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex justify-end"
      data-testid="ticket-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={ticket ? `Ticket ${ticket.ticketId}` : 'Ticket not in current view'}
    >
      <button
        type="button"
        aria-label="Close ticket"
        onClick={close}
        className="absolute inset-0 cursor-default bg-black/60 backdrop-blur-sm"
        data-testid="ticket-overlay-backdrop"
      />
      <div className="relative flex h-full w-full max-w-md flex-col border-l border-border bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
          <span className="text-sm font-semibold tracking-tight">
            {ticket ? `Ticket ${ticket.ticketId}` : activeId}
          </span>
          <button
            type="button"
            aria-label="Close ticket"
            onClick={close}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-foreground-muted transition-colors hover:bg-surface-elevated hover:text-foreground"
            data-testid="ticket-overlay-close"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-4 w-4"
              aria-hidden
            >
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="6" y1="18" x2="18" y2="6" />
            </svg>
          </button>
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
              className="flex flex-col gap-3 rounded-xl border border-border bg-surface-elevated p-4 text-sm text-foreground-muted"
              data-testid="ticket-overlay-not-in-view"
            >
              <span>
                Ticket <strong className="text-foreground">{activeId}</strong> is
                not in the current filtered view. Clear the filter to see it here.
              </span>
              <button
                type="button"
                onClick={close}
                className="self-start rounded-xl bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground hover:bg-accent-hover"
              >
                Clear filter
              </button>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

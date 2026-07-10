'use client';

import { useState, useTransition } from 'react';
import { updateTicketAction } from '../actions';
import { VALID_TRANSITIONS, type TicketStatus } from '@app/application/admin/tickets';

export interface UserOption {
  clerkUserId: string;
  email: string;
  name: string | null;
}

export function TicketDrawer({
  ticketId,
  name,
  email,
  issue,
  status,
  assignedTo,
  notes,
  userOptions,
}: {
  ticketId: string;
  name: string;
  email: string;
  issue: string;
  status: string;
  assignedTo: string | null;
  notes: string | null;
  userOptions: UserOption[];
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [currentStatus, setCurrentStatus] = useState(status);
  const [currentAssignee, setCurrentAssignee] = useState(assignedTo ?? '');
  return (
    <div
      className="flex flex-col gap-3 rounded-xl border border-border bg-surface-elevated p-4 text-sm"
      data-testid={`ticket-drawer-body-${ticketId}`}
    >
      <div>
        <span className="text-xs font-medium uppercase tracking-wide text-foreground-muted">
          Name
        </span>
        <div className="mt-0.5 text-foreground">{name}</div>
      </div>
      <div>
        <span className="text-xs font-medium uppercase tracking-wide text-foreground-muted">
          Email
        </span>
        <div className="mt-0.5 text-foreground">{email}</div>
      </div>
      <div>
        <span className="text-xs font-medium uppercase tracking-wide text-foreground-muted">
          Issue
        </span>
        <div className="mt-0.5 whitespace-pre-wrap text-foreground">
          {issue}
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs font-medium uppercase tracking-wide text-foreground-muted">
            Status
          </span>
          <select
            value={currentStatus}
            onChange={(e) => setCurrentStatus(e.target.value)}
            className="rounded-xl border border-border bg-background px-2 py-1.5 text-sm text-foreground"
            data-testid={`ticket-status-${ticketId}`}
          >
            <option value={currentStatus}>{currentStatus}</option>
            {VALID_TRANSITIONS[currentStatus as TicketStatus]?.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs font-medium uppercase tracking-wide text-foreground-muted">
            Assignee
          </span>
          <select
            value={currentAssignee}
            onChange={(e) => setCurrentAssignee(e.target.value)}
            className="rounded-xl border border-border bg-background px-2 py-1.5 text-sm text-foreground"
            data-testid={`ticket-assignee-${ticketId}`}
          >
            <option value="">—</option>
            {userOptions.map((u) => (
              <option key={u.clerkUserId} value={u.clerkUserId}>
                {u.name ?? u.email}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              setError(null);
              const res = await updateTicketAction(ticketId, {
                status: currentStatus as 'created' | 'in_progress' | 'closed',
                assignedTo: currentAssignee || null,
              });
              if (res.error) setError(res.error);
            })
          }
          className="rounded-xl bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent-hover disabled:opacity-50"
          data-testid={`ticket-save-${ticketId}`}
        >
          {pending ? 'Saving…' : 'Save'}
        </button>
      </div>
      <div className="flex flex-col gap-1">
        <label
          htmlFor={`ticket-note-${ticketId}`}
          className="text-xs font-medium uppercase tracking-wide text-foreground-muted"
        >
          Add note
        </label>
        <textarea
          id={`ticket-note-${ticketId}`}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          className="rounded-xl border border-border bg-background p-2 text-sm text-foreground"
          data-testid={`ticket-note-${ticketId}`}
        />
        <button
          type="button"
          disabled={pending || note.trim().length === 0}
          onClick={() =>
            startTransition(async () => {
              setError(null);
              const res = await updateTicketAction(ticketId, { note });
              if (res.error) {
                setError(res.error);
              } else {
                setNote('');
              }
            })
          }
          className="self-start rounded-xl border border-border px-3 py-1.5 text-sm text-foreground-muted transition-colors hover:bg-surface hover:text-foreground disabled:opacity-50"
          data-testid={`ticket-add-note-${ticketId}`}
        >
          {pending ? 'Posting…' : 'Post note'}
        </button>
      </div>
      {notes ? (
        <div
          className="rounded-xl border border-border bg-background p-3 text-sm"
          data-testid={`ticket-notes-${ticketId}`}
        >
          <span className="mt-1 text-xs font-medium uppercase tracking-wide text-foreground-muted">
            Notes
          </span>
          <div className="mt-1 whitespace-pre-wrap text-foreground">
            {notes}
          </div>
        </div>
      ) : null}
      {error ? (
        <div
          className="rounded-xl border border-danger/40 bg-danger/10 p-3 text-sm text-danger"
          role="alert"
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}

'use client';

import { useState, useTransition } from 'react';
import { updateTicketAction } from '../actions';
import { VALID_TRANSITIONS, type TicketStatus } from '@app/application/admin/tickets';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Alert } from '@/components/ui/alert';

export interface UserOption {
  clerkUserId: string;
  email: string;
  name: string | null;
}

const UNASSIGNED = '__unassigned__';

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
    <Card
      data-testid={`ticket-drawer-body-${ticketId}`}
      className="flex flex-col gap-3 rounded-xl border border bg-surface-elevated p-4 text-sm"
    >
      <div>
        <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Name
        </Label>
        <div className="mt-0.5 text-foreground">{name}</div>
      </div>
      <div>
        <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Email
        </Label>
        <div className="mt-0.5 text-foreground">{email}</div>
      </div>
      <div>
        <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Issue
        </Label>
        <div className="mt-0.5 whitespace-pre-wrap text-foreground">{issue}</div>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-1 flex-col gap-1">
          <Label
            htmlFor={`ticket-status-${ticketId}`}
            className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
          >
            Status
          </Label>
          <Select value={currentStatus} onValueChange={setCurrentStatus}>
            <SelectTrigger
              id={`ticket-status-${ticketId}`}
              data-testid={`ticket-status-${ticketId}`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={currentStatus}>{currentStatus}</SelectItem>
              {VALID_TRANSITIONS[currentStatus as TicketStatus]?.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-1 flex-col gap-1">
          <Label
            htmlFor={`ticket-assignee-${ticketId}`}
            className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
          >
            Assignee
          </Label>
          <Select
            value={currentAssignee}
            onValueChange={(v) =>
              setCurrentAssignee(v === UNASSIGNED ? '' : v)
            }
          >
            <SelectTrigger
              id={`ticket-assignee-${ticketId}`}
              data-testid={`ticket-assignee-${ticketId}`}
            >
              <SelectValue placeholder="—" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNASSIGNED}>—</SelectItem>
              {userOptions.map((u) => (
                <SelectItem key={u.clerkUserId} value={u.clerkUserId}>
                  {u.name ?? u.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
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
          data-testid={`ticket-save-${ticketId}`}
        >
          {pending ? 'Saving…' : 'Save'}
        </Button>
      </div>
      <div className="flex flex-col gap-1">
        <Label
          htmlFor={`ticket-note-${ticketId}`}
          className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
        >
          Add note
        </Label>
        <Textarea
          id={`ticket-note-${ticketId}`}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          data-testid={`ticket-note-${ticketId}`}
          className="rounded-xl border border bg-background p-2 text-sm text-foreground"
        />
        <Button
          type="button"
          variant="outline"
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
          data-testid={`ticket-add-note-${ticketId}`}
          className="self-start text-muted-foreground"
        >
          {pending ? 'Posting…' : 'Post note'}
        </Button>
      </div>
      {notes ? (
        <div
          className="rounded-xl border border bg-background p-3 text-sm"
          data-testid={`ticket-notes-${ticketId}`}
        >
          <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Notes
          </Label>
          <div className="mt-1 whitespace-pre-wrap text-foreground">{notes}</div>
        </div>
      ) : null}
      {error ? (
        <Alert
          variant="destructive"
          className="border-destructive/40 bg-destructive/10 p-3 text-destructive"
        >
          {error}
        </Alert>
      ) : null}
    </Card>
  );
}

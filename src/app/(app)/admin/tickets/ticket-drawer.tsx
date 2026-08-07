'use client';

import { useState, useTransition } from 'react';
import { Save, MessageSquarePlus } from 'lucide-react';
import { updateTicketAction } from '../actions';
import { VALID_TRANSITIONS, type TicketStatus } from '@app/application/admin/tickets';
import { sanitizeText } from '@/lib/sanitize';
import { statusBadgeClass } from '@/components/admin/admin-helpers';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';

export interface UserOption {
  clerkUserId: string;
  email: string;
  name: string | null;
}

const UNASSIGNED = '__unassigned__';

function formatStatus(s: string): string {
  return s.replace('_', ' ');
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
  const [prevAssignee, setPrevAssignee] = useState(assignedTo ?? '');
  const cleanNote = sanitizeText(note);

  if ((assignedTo ?? '') !== prevAssignee) {
    setPrevAssignee(assignedTo ?? '');
    setCurrentAssignee(assignedTo ?? '');
  }
  return (
    <div
      data-testid={`ticket-drawer-body-${ticketId}`}
      className="flex flex-col gap-4"
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Name
          </span>
          <span className="text-sm text-foreground">{name}</span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Email
          </span>
          <span className="text-sm text-foreground">{email}</span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Issue
          </span>
          <p className="whitespace-pre-wrap text-sm text-foreground">{issue}</p>
        </div>
      </div>

      <Separator />

      <div className="flex flex-col gap-3">
        <h4 className="text-xs font-medium text-foreground">Status &amp; assignment</h4>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label
              htmlFor={`ticket-status-${ticketId}`}
              className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground"
            >
              Status
            </Label>
            {currentStatus === 'closed' ? (
              <span
                className={`inline-flex w-fit items-center rounded-full border px-2.5 py-1 text-xs font-medium ${statusBadgeClass('closed')}`}
                data-testid={`ticket-status-static-${ticketId}`}
              >
                Closed
              </span>
            ) : (
              <Select value={currentStatus} onValueChange={setCurrentStatus}>
                <SelectTrigger
                  id={`ticket-status-${ticketId}`}
                  data-testid={`ticket-status-${ticketId}`}
                  className="w-full"
                >
                  <SelectValue placeholder={currentStatus} />
                </SelectTrigger>
                <SelectContent>
                  {VALID_TRANSITIONS[currentStatus as TicketStatus]?.map((s) => (
                    <SelectItem key={s} value={s}>
                      {formatStatus(s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label
              htmlFor={`ticket-assignee-${ticketId}`}
              className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground"
            >
              Assignee
            </Label>
            <Select
              value={currentAssignee}
              onValueChange={(v) => setCurrentAssignee(v === UNASSIGNED ? '' : v)}
            >
              <SelectTrigger
                id={`ticket-assignee-${ticketId}`}
                data-testid={`ticket-assignee-${ticketId}`}
                className="w-full"
              >
                <SelectValue placeholder="Unassigned" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
                {userOptions.map((u) => (
                  <SelectItem key={u.clerkUserId} value={u.clerkUserId}>
                    {u.name ?? u.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              setError(null);
              const res = await updateTicketAction(ticketId, {
                ...(currentStatus !== 'closed'
                  ? { status: currentStatus as 'created' | 'in_progress' }
                  : {}),
                assignedTo: currentAssignee || null,
              });
              if (res.error) setError(res.error);
            })
          }
          data-testid={`ticket-save-${ticketId}`}
          className="self-start"
        >
          <Save data-icon="inline-start" />
          {pending ? 'Saving…' : 'Save changes'}
        </Button>
      </div>

      <Separator />

      <div className="flex flex-col gap-2">
        <Label
          htmlFor={`ticket-note-${ticketId}`}
          className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground"
        >
          Add note
        </Label>
        <Textarea
          id={`ticket-note-${ticketId}`}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          placeholder="Internal note for the team…"
          data-testid={`ticket-note-${ticketId}`}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending || cleanNote.length === 0}
          onClick={() =>
            startTransition(async () => {
              setError(null);
              const res = await updateTicketAction(ticketId, { note: cleanNote });
              if (res.error) {
                setError(res.error);
              } else {
                setNote('');
              }
            })
          }
          data-testid={`ticket-add-note-${ticketId}`}
          className="self-start"
        >
          <MessageSquarePlus data-icon="inline-start" />
          {pending ? 'Posting…' : 'Post note'}
        </Button>
      </div>

      {notes ? (
        <div
          className="rounded-lg border border-border-subtle bg-surface-sunken p-3"
          data-testid={`ticket-notes-${ticketId}`}
        >
          <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Notes
          </span>
          <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{notes}</p>
        </div>
      ) : null}

      {error ? (
        <Alert variant="destructive">
          <AlertDescription className="text-xs">{error}</AlertDescription>
        </Alert>
      ) : null}

      <span className="sr-only">
        Current status: <span className={statusBadgeClass(currentStatus)}>{formatStatus(currentStatus)}</span>
      </span>
    </div>
  );
}

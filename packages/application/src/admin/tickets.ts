import {
  err,
  ok,
  type Result,
  ExternalServiceError,
  NotFoundError,
  ConflictError,
  ForbiddenError,
  sanitizeText,
} from '@app/domain';
import type { TicketRepository, AuditLog, TicketRow, UserRepository, TransactionRunner } from '@app/domain';
import { randomUUID } from 'node:crypto';
import { MAX_TICKET_NOTES_LENGTH, MAX_LIST_LIMIT } from '@app/domain';
import { requireAdminActor } from './authz';
import { safeAudit } from '../audit-reliability';
import { sanitizePagination } from '../service-result';
import { capCodePoints } from '../text';

export const TICKET_STATUSES = ['created', 'in_progress', 'closed'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export function isTicketStatus(value: string): value is TicketStatus {
  return (TICKET_STATUSES as readonly string[]).includes(value);
}

export const VALID_TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  created: ['in_progress', 'closed'],
  in_progress: ['closed', 'created'],
  closed: [],
};

const MAX_TICKET_ISSUE_LENGTH = 4000;
const MAX_TICKET_NAME_LENGTH = 100;
const MAX_TICKET_EMAIL_LENGTH = 254;
const MAX_TICKET_UPDATE_ATTEMPTS = 3;

export function sanitizeTicketNote(input: string): string {
  return sanitizeText(input);
}

/** Keep the tail of `value` up to `max` Unicode code points, never splitting surrogate pairs. */
export function tailCodePoints(value: string, max: number): string {
  const chars = [...value];
  return chars.length > max ? chars.slice(-max).join('') : value;
}

export async function listTickets(
  input: {
    status?: TicketStatus | undefined;
    assignee?: string | null | undefined;
    search?: string | undefined;
    limit?: number;
    offset?: number;
    actorId: string;
  },
  deps: { tickets: TicketRepository; users: UserRepository },
): Promise<Result<{ tickets: TicketRow[]; total: number }>> {
  const authz = await requireAdminActor(input.actorId, deps);
  if (!authz.ok) return authz;
  try {
    const { limit, offset } = sanitizePagination(input.limit, input.offset, MAX_LIST_LIMIT);
    const r = await deps.tickets.list({
      status: input.status,
      assignee: input.assignee,
      search: input.search,
      limit,
      offset,
    });
    return ok({ tickets: r.rows, total: r.total });
  } catch (e) {
    return err(new ExternalServiceError('Failed to list tickets', e));
  }
}

export interface UpdateTicketInput {
  ticketId: string;
  status?: TicketStatus | undefined;
  assignedTo?: string | null | undefined;
  note?: string | undefined;
  actorId: string;
}

export async function updateTicket(
  input: UpdateTicketInput,
  deps: { tickets: TicketRepository; audit: AuditLog; users: UserRepository; runner?: TransactionRunner },
): Promise<Result<TicketRow>> {
  const run = async (
    tickets: TicketRepository,
    audit: AuditLog,
    attempt: number,
  ): Promise<Result<TicketRow>> => {
    const existing = await (tickets.findByTicketIdForUpdate?.(input.ticketId) ?? tickets.findByTicketId(input.ticketId));
    if (!existing) return err(new NotFoundError('Ticket not found'));
    if (
      input.status &&
      input.status !== existing.status &&
      isTicketStatus(existing.status) &&
      !VALID_TRANSITIONS[existing.status].includes(input.status)
    ) {
      return err(new ConflictError('Invalid status transition'));
    }
    const patch: Partial<Pick<TicketRow, 'status' | 'assignedTo' | 'notes'>> = {};
    if (input.status) patch.status = input.status;
    if (input.assignedTo !== undefined) patch.assignedTo = input.assignedTo;
    const note = input.note ? sanitizeTicketNote(input.note) : undefined;
    if (note) {
      const appended = existing.notes ? existing.notes + '\n' + note : note;
      patch.notes = tailCodePoints(appended, MAX_TICKET_NOTES_LENGTH);
    }
    const updated = await tickets.update(input.ticketId, patch);
    if (!updated) return err(new NotFoundError('Ticket not found'));
    if (patch.notes !== undefined && patch.notes !== null) {
      const fresh = await tickets.findByTicketId(input.ticketId);
      if (fresh && !(fresh.notes ?? '').startsWith(patch.notes)) {
        if (attempt >= MAX_TICKET_UPDATE_ATTEMPTS) {
          return err(new ConflictError('Ticket was updated concurrently; please retry'));
        }
        return run(tickets, audit, attempt + 1);
      }
    }
    const auditActions: Array<'assign' | 'status_change' | 'note'> = [];
    if (input.status && input.status !== existing.status) auditActions.push('status_change');
    if (input.assignedTo !== undefined) auditActions.push('assign');
    if (note) auditActions.push('note');
    // Audit writes use the transaction-scoped audit repo (ctx.audit) so they commit/rollback atomically with the ticket update.
    for (const action of auditActions) {
      const event = { action, ticketId: input.ticketId, actorId: input.actorId };
      await audit.logTicketEvent(event);
    }
    return ok(updated);
  };
  try {
    const assignee =
      input.assignedTo ? await deps.users.findByClerkId(input.assignedTo) : undefined;
    if (input.assignedTo && !assignee) return err(new NotFoundError('Assignee not found'));
    if (assignee && assignee.role !== 'admin') {
      return err(new ForbiddenError('Only admins can be assigned tickets'));
    }
    return deps.runner
      ? deps.runner.run((ctx) => run(ctx.tickets, ctx.audit, 0))
      : run(deps.tickets, deps.audit, 0); // no runner: audit outside tx is best-effort
  } catch (e) {
    return err(new ExternalServiceError('Failed to update ticket', e));
  }
}

export interface CreateTicketInput {
  userId: string;
  name: string;
  email: string;
  issue: string;
}

export async function createTicket(
  input: CreateTicketInput,
  deps: { tickets: TicketRepository; audit: AuditLog },
): Promise<Result<{ ticketId: string; status: 'created' }>> {
  const MAX_CREATE_ATTEMPTS = 5;
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt++) {
    const ticketId = `TKT-${randomUUID().slice(0, 12)}`;
    try {
      const row = await deps.tickets.insert({
        ticketId,
        userId: input.userId,
        name: capCodePoints(input.name, MAX_TICKET_NAME_LENGTH),
        email: capCodePoints(input.email, MAX_TICKET_EMAIL_LENGTH),
        issue: capCodePoints(input.issue, MAX_TICKET_ISSUE_LENGTH),
      });
      const event = { action: 'create' as const, ticketId: row.ticketId, actorId: input.userId };
      void safeAudit(
        () => deps.audit.logTicketEvent(event),
        (payload, error) => deps.audit.recordDeadLetter({ kind: 'ticket', payload, error }),
        event,
        'ticket',
      );
      return ok({ ticketId: row.ticketId, status: 'created' as const });
    } catch (e) {
      lastErr = e;
    }
  }
  return err(new ExternalServiceError('Failed to create ticket', lastErr));
}

import {
  err,
  ok,
  type Result,
  ExternalServiceError,
  NotFoundError,
  ConflictError,
  ForbiddenError,
  ValidationError,
  sanitizeText,
} from '@app/domain';
import type {
  TicketRepository,
  AuditLog,
  TicketRow,
  UserRepository,
  TransactionRunner,
  CursorPageInfo,
  ListCursorCodec,
} from '@app/domain';
import { randomUUID } from 'node:crypto';
import {
  MAX_LIST_LIMIT,
  MAX_TICKET_NOTES_LENGTH,
  TICKET_ID_HEX_LENGTH,
  TICKET_ID_PREFIX,
} from '@app/domain';
import { requireAdminActor } from './authz';
import { safeAudit } from '../audit-reliability';
import { decodeCursorAtBoundary, sanitizePagination, wrapServiceCall } from '../service-result';
import { capCodePoints } from '../text';
import { createListCursorContext } from '@app/domain';

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
export const MAX_TICKET_CREATE_ATTEMPTS = 5;
const TICKET_ID_UNIQUE_CONSTRAINT = 'tickets_ticket_id_unique';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Drizzle may wrap a node-postgres/Neon error in `cause`. Retry only the
 * unique violation for the ticket identifier itself; retrying every database
 * error can amplify outages and can duplicate non-idempotent writes.
 */
function isTicketIdCollision(error: unknown): boolean {
  const seen = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!isRecord(current)) return false;
    if (seen.has(current)) return false;
    seen.add(current);
    if (current.code === '23505' && current.constraint === TICKET_ID_UNIQUE_CONSTRAINT) return true;
    current = current.cause;
  }
  return false;
}

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
    cursor?: unknown;
    before?: unknown;
    actorId: string;
  },
  deps: { tickets: TicketRepository; users: UserRepository; cursorCodec?: ListCursorCodec | undefined },
): Promise<Result<{ tickets: TicketRow[]; total: number } & CursorPageInfo>> {
  const authz = await requireAdminActor(input.actorId, deps);
  if (!authz.ok) return authz;
  return wrapServiceCall(async () => {
    const search = input.search?.trim() || undefined;
    const cursorContext = deps.cursorCodec
      ? createListCursorContext('tickets', {
          status: input.status ?? null,
          assignee: input.assignee ?? null,
          search: search ?? null,
        })
      : undefined;
    const cursor = decodeCursorAtBoundary(input.cursor, 'tickets', deps.cursorCodec, cursorContext);
    const before = decodeCursorAtBoundary(input.before, 'tickets', deps.cursorCodec, cursorContext);
    if (cursor !== undefined && before !== undefined) {
      throw new ValidationError('Only one pagination cursor may be provided');
    }
    const { limit, offset } = sanitizePagination(input.limit, input.offset, MAX_LIST_LIMIT);
    const result = await deps.tickets.list({
      status: input.status,
      assignee: input.assignee,
      search,
      limit,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(before !== undefined ? { before } : {}),
      ...(cursor === undefined && before === undefined ? { offset } : {}),
      ...(deps.cursorCodec !== undefined && cursorContext !== undefined
        ? { cursorCodec: deps.cursorCodec, cursorContext }
        : {}),
    });
    return ok({
      tickets: result.rows,
      total: result.total,
      nextCursor: result.nextCursor ?? null,
      previousCursor: result.previousCursor ?? null,
    });
  }, 'Failed to list tickets');
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
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_TICKET_CREATE_ATTEMPTS; attempt++) {
    const ticketId = `${TICKET_ID_PREFIX}${randomUUID().replaceAll('-', '').slice(0, TICKET_ID_HEX_LENGTH)}`;
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
      if (!isTicketIdCollision(e)) {
        return err(new ExternalServiceError('Failed to create ticket', e));
      }
      lastErr = e;
    }
  }
  return err(new ExternalServiceError('Failed to create ticket', lastErr));
}

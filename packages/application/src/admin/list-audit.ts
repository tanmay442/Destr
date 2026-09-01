import { ok, ValidationError, type Result } from '@app/domain';
import type {
  AuditLog,
  AuditEventRecord,
  AuditKind,
  UserRepository,
  CursorPageInfo,
  ListCursorCodec,
} from '@app/domain';
import { MAX_AUDIT_LIMIT } from '@app/domain';
import { requireAdminActor } from './authz';
import { decodeCursorAtBoundary, sanitizePagination, wrapServiceCall } from '../service-result';
import { createListCursorContext } from '@app/domain';

export async function listAudit(
  input: {
    kind?: AuditKind | undefined;
    action?: string | undefined;
    actor?: string | undefined;
    from?: Date | undefined;
    to?: Date | undefined;
    documentId?: number | undefined;
    ticketId?: string | undefined;
    limit?: number;
    offset?: number;
    cursor?: unknown;
    before?: unknown;
    actorId: string;
  },
  deps: { audit: AuditLog; users: UserRepository; cursorCodec?: ListCursorCodec | undefined },
): Promise<Result<{ events: AuditEventRecord[]; total: number } & CursorPageInfo>> {
  const authz = await requireAdminActor(input.actorId, deps);
  if (!authz.ok) return authz;
  return wrapServiceCall(async () => {
    const action = input.action?.trim() || undefined;
    const actor = input.actor?.trim() || undefined;
    const ticketId = input.ticketId?.trim() || undefined;
    const cursorContext = deps.cursorCodec
      ? createListCursorContext('audit', {
          kind: input.kind ?? null,
          action: action ?? null,
          actorId: actor ?? null,
          from: input.from ?? null,
          to: input.to ?? null,
          documentId: input.documentId ?? null,
          ticketId: ticketId ?? null,
        })
      : undefined;
    const cursor = decodeCursorAtBoundary(input.cursor, 'audit', deps.cursorCodec, cursorContext);
    const before = decodeCursorAtBoundary(input.before, 'audit', deps.cursorCodec, cursorContext);
    if (cursor !== undefined && before !== undefined) {
      throw new ValidationError('Only one pagination cursor may be provided');
    }
    const { limit, offset } = sanitizePagination(input.limit, input.offset, MAX_AUDIT_LIMIT, 50);
    const result = await deps.audit.list({
      kind: input.kind,
      action,
      actorId: actor,
      from: input.from,
      to: input.to,
      documentId: input.documentId,
      ticketId,
      limit,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(before !== undefined ? { before } : {}),
      ...(cursor === undefined && before === undefined ? { offset } : {}),
      ...(deps.cursorCodec !== undefined && cursorContext !== undefined
        ? { cursorCodec: deps.cursorCodec, cursorContext }
        : {}),
    });
    return ok({
      events: result.events,
      total: result.total,
      nextCursor: result.nextCursor ?? null,
      previousCursor: result.previousCursor ?? null,
    });
  }, 'Failed to list audit events');
}

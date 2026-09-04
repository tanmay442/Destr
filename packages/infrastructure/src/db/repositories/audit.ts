import { asc, desc, eq, gt, lt, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { db } from '../client';
import { auditDeadLetter, auditEvents, users } from '../schema';
import type { AuditEventInput, AuditEventRecord, AuditKind, AuditListFilter, AuditLog } from '@app/domain';
import { MAX_AUDIT_LIMIT, MAX_LEGACY_LIST_OFFSET, ValidationError } from '@app/domain';
import { toSafeDatabaseId } from '../safe-id';
import type { Client } from './shared';
import { encodeRepositoryCursor, requiredAnd, requiredOr, whereAnd } from './shared';

export const auditRepo = {
  async logEvent(input: AuditEventInput, client: Client = db): Promise<void> {
    await client.insert(auditEvents).values({
      kind: input.kind,
      action: input.action,
      actorId: input.actorId,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      details: input.details ?? {},
    });
  },
  async logDocumentEvent(
    input: { action: 'upload' | 'replace' | 'delete' | 'restore'; documentId: number; actorId: string },
    client: Client = db,
  ): Promise<void> {
    await auditRepo.logEvent(
      { kind: 'document', action: input.action, actorId: input.actorId, targetType: 'document', targetId: String(input.documentId) },
      client,
    );
  },
  async logTicketEvent(
    input: { action: 'create' | 'assign' | 'status_change' | 'note' | 'impersonation' | 'role_change'; ticketId: string; actorId: string },
    client: Client = db,
  ): Promise<void> {
    await auditRepo.logEvent(
      { kind: 'ticket', action: input.action, actorId: input.actorId, targetType: 'ticket', targetId: input.ticketId },
      client,
    );
  },
  async logUserEvent(
    input: { targetUserId: string; actorId: string; fromRole: 'admin' | 'user'; toRole: 'admin' | 'user' },
    client: Client = db,
  ): Promise<void> {
    await auditRepo.logEvent(
      {
        kind: 'user',
        action: 'role_change',
        actorId: input.actorId,
        targetType: 'user',
        targetId: input.targetUserId,
        details: { fromRole: input.fromRole, toRole: input.toRole },
      },
      client,
    );
  },
  async list(input: AuditListFilter, client: Client = db): Promise<{
    events: AuditEventRecord[];
    total: number;
    nextCursor: string | null;
    previousCursor: string | null;
  }> {
    if (input.kind !== undefined && !['document', 'ticket', 'user', 'settings'].includes(input.kind)) {
      throw new ValidationError(`Invalid audit kind: ${input.kind}`);
    }
    if (input.kind === 'document' && input.ticketId !== undefined) {
      throw new ValidationError('Cannot filter by both kind=document and ticketId');
    }
    if (input.kind === 'ticket' && input.documentId !== undefined) {
      throw new ValidationError('Cannot filter by both kind=ticket and documentId');
    }
    if (input.documentId !== undefined && input.kind !== undefined && input.kind !== 'document') {
      throw new ValidationError('Cannot filter by documentId with kind different from document');
    }
    if (input.cursor !== undefined && input.before !== undefined) {
      throw new ValidationError('Only one pagination cursor may be provided');
    }
    const filterParts: SQL[] = [];
    if (input.kind) filterParts.push(eq(auditEvents.kind, input.kind));
    if (input.action) filterParts.push(eq(auditEvents.action, input.action));
    if (input.actorId) filterParts.push(eq(auditEvents.actorId, input.actorId));
    if (input.from) filterParts.push(sql`${auditEvents.at} >= ${input.from}`);
    if (input.to) filterParts.push(sql`${auditEvents.at} <= ${input.to}`);
    if (input.documentId !== undefined) {
      filterParts.push(eq(auditEvents.kind, 'document'), eq(auditEvents.targetId, String(input.documentId)));
    }
    if (input.ticketId !== undefined) {
      filterParts.push(eq(auditEvents.kind, 'ticket'), eq(auditEvents.targetId, input.ticketId));
    }
    const filter = whereAnd(filterParts);
    const pageParts = [...filterParts];
    const isBackward = input.before !== undefined;
    const position = input.cursor ?? input.before;
    if (position !== undefined) {
      pageParts.push(
        isBackward
          ? requiredOr(
              gt(auditEvents.at, position.sortAt),
              requiredAnd(eq(auditEvents.at, position.sortAt), gt(auditEvents.id, position.id)),
            )
          : requiredOr(
              lt(auditEvents.at, position.sortAt),
              requiredAnd(eq(auditEvents.at, position.sortAt), lt(auditEvents.id, position.id)),
            ),
      );
    }
    const pageFilter = whereAnd(pageParts);
    const limit = Math.min(Math.max(input.limit, 1), MAX_AUDIT_LIMIT);
    const query = client
      .select({
        id: auditEvents.id,
        kind: auditEvents.kind,
        action: auditEvents.action,
        actorId: auditEvents.actorId,
        actorName: users.name,
        targetType: auditEvents.targetType,
        targetId: auditEvents.targetId,
        details: auditEvents.details,
        at: auditEvents.at,
      })
      .from(auditEvents)
      .leftJoin(users, eq(users.clerkUserId, auditEvents.actorId))
      .where(pageFilter)
      .orderBy(
        ...(isBackward
          ? [asc(auditEvents.at), asc(auditEvents.id)]
          : [desc(auditEvents.at), desc(auditEvents.id)]),
      )
      .limit(limit + 1);
    const queriedRows = !isBackward && input.cursor === undefined && input.offset !== undefined
      ? await query.offset(Math.min(Math.max(input.offset, 0), MAX_LEGACY_LIST_OFFSET))
      : await query;
    const orderedRows = isBackward ? [...queriedRows].reverse() : queriedRows;
    const hasExtra = queriedRows.length > limit;
    const pageRows = isBackward ? orderedRows.slice(-limit) : orderedRows.slice(0, limit);
    const total = position?.total ?? (await client
      .select({ count: sql<number>`count(*)::int` })
      .from(auditEvents)
      .where(filter))[0]?.count ?? 0;
    const events = pageRows.map((row) => ({
      id: toSafeDatabaseId(row.id, 'audit_events.id'),
      kind: row.kind as AuditKind,
      action: row.action,
      actorId: row.actorId,
      actorName: row.actorName ?? null,
      targetType: row.targetType ?? null,
      targetId: row.targetId ?? null,
      details: (row.details ?? {}) as Record<string, unknown>,
      at: row.at instanceof Date ? row.at : new Date(row.at),
    }));
    const firstEvent = events[0];
    const lastEvent = events[events.length - 1];
    const hasNext = isBackward ? events.length > 0 : hasExtra;
    const hasPrevious = isBackward
      ? hasExtra
      : (input.cursor !== undefined || (input.offset ?? 0) > 0) && events.length > 0;
    return {
      events,
      total,
      nextCursor: hasNext && lastEvent
        ? encodeRepositoryCursor(
            { kind: 'audit', sortAt: lastEvent.at, id: lastEvent.id, total },
            input.cursorCodec,
            input.cursorContext,
          )
        : null,
      previousCursor: hasPrevious && firstEvent
        ? encodeRepositoryCursor(
            { kind: 'audit', sortAt: firstEvent.at, id: firstEvent.id, total },
            input.cursorCodec,
            input.cursorContext,
          )
        : null,
    };
  },
  async recordDeadLetter(
    input: { kind: AuditKind; payload: unknown; error: string },
    client: Client = db,
  ): Promise<void> {
    await client.insert(auditDeadLetter).values({
      kind: input.kind,
      payload: input.payload,
      error: input.error,
    });
  },
};

export function createAuditRepo(client: Client = db): AuditLog {
  return {
    logEvent: (input) => auditRepo.logEvent(input, client),
    logDocumentEvent: (input) => auditRepo.logDocumentEvent(input, client),
    logTicketEvent: (input) => auditRepo.logTicketEvent(input, client),
    logUserEvent: (input) => auditRepo.logUserEvent(input, client),
    list: (input) => auditRepo.list(input, client),
    recordDeadLetter: (input) =>
      auditRepo.recordDeadLetter(
        { kind: input.kind as AuditKind, payload: input.payload, error: input.error },
        client,
      ),
  };
}

import { err, ok, type Result, ExternalServiceError } from '@app/domain';
import type { AuditLog, UserRepository } from '@app/domain';
import { MAX_AUDIT_LIMIT } from '../../../../config/constants';
import { requireAdminActor } from './authz';

export async function listAudit(
  input: { documentId?: number; ticketId?: string; limit?: number; offset?: number; actorId: string },
  deps: { audit: AuditLog; users: UserRepository },
): Promise<Result<{ events: Array<{ id: number; kind: 'document' | 'ticket'; documentId: number | null; ticketId: string | null; actorId: string; actorName: string | null; action: string; at: Date }>; total: number }>> {
  const authz = await requireAdminActor(input.actorId, deps);
  if (!authz.ok) return authz;
  try {
    const limit = Math.min(Math.max(Math.floor(input.limit ?? 50), 1), MAX_AUDIT_LIMIT);
    const offset = Math.max(Math.floor(input.offset ?? 0), 0);
    const r = await deps.audit.list({
      documentId: input.documentId,
      ticketId: input.ticketId,
      limit,
      offset,
    });
    return ok(r);
  } catch (e) {
    return err(new ExternalServiceError('Failed to list audit events', e));
  }
}

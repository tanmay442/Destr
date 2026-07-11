import { type Result, serviceResult } from '../service-result';
import type { AuditLog } from '@app/domain';

export async function logDocumentEvent(
  input: { action: 'upload' | 'replace' | 'delete' | 'restore'; documentId: number; actorId: string },
  deps: { audit: AuditLog },
): Promise<Result<void>> {
  return serviceResult(() => deps.audit.logDocumentEvent(input), 'Failed to log document event');
}

export async function logTicketEvent(
  input: {
    action: 'create' | 'assign' | 'status_change' | 'note' | 'impersonation' | 'role_change';
    ticketId: string;
    actorId: string;
  },
  deps: { audit: AuditLog },
): Promise<Result<void>> {
  return serviceResult(() => deps.audit.logTicketEvent(input), 'Failed to log ticket event');
}

export async function logUserRoleChange(
  input: { clerkUserId: string; actorId: string; fromRole: 'admin' | 'user'; toRole: 'admin' | 'user' },
  deps: { audit: AuditLog },
): Promise<Result<void>> {
  return serviceResult(
    () => deps.audit.logUserEvent({ targetUserId: input.clerkUserId, actorId: input.actorId, fromRole: input.fromRole, toRole: input.toRole }),
    'Failed to log role change',
  );
}

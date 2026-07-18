import { err, ok, type Result, NotFoundError, ValidationError, ForbiddenError, ExternalServiceError } from '@app/domain';
import type { UserRepository } from '@app/domain';
import type { AuditLog } from '@app/domain';
import { MAX_LIST_LIMIT } from '../../../../config/constants';
import { sanitizePagination } from '../service-result';
import { logUserRoleChange } from './audit';
import { safeAudit } from '../audit-reliability';

export async function listUsers(
  input: { search?: string; limit?: number; offset?: number },
  deps: { users: UserRepository },
): Promise<Result<{ users: Array<{ clerkUserId: string; email: string; name: string | null; role: string; lastSeenAt: Date | null; createdAt: Date }>; total: number }>> {
  try {
    const { limit, offset } = sanitizePagination(input.limit, input.offset, MAX_LIST_LIMIT);
    const r = await deps.users.list({ search: input.search, limit, offset });
    return ok({ users: r.rows, total: r.total });
  } catch (e) {
    return err(new ExternalServiceError('Failed to list users', e));
  }
}

export async function setUserRole(
  input: { clerkUserId: string; role: 'admin' | 'user'; actorId: string },
  deps: { users: UserRepository; audit: AuditLog },
): Promise<Result<{ user: { clerkUserId: string; role: string } }>> {
  if (input.role !== 'admin' && input.role !== 'user') {
    return err(new ValidationError(`Invalid role: ${input.role}`));
  }
  if (input.actorId === input.clerkUserId) {
    return err(new ForbiddenError('Cannot change your own role'));
  }
  try {
    const actor = await deps.users.findByClerkId(input.actorId);
    if (!actor || actor.role !== 'admin') {
      return err(new ForbiddenError('Only admins can change user roles'));
    }
    const target = await deps.users.findByClerkId(input.clerkUserId);
    if (!target) return err(new NotFoundError(`User not found: ${input.clerkUserId}`));
    const row = await deps.users.setRole(input.clerkUserId, input.role);
    if (!row) return err(new NotFoundError(`User not found: ${input.clerkUserId}`));
    void deps.users.syncClerkRole(input.clerkUserId, input.role).catch((err) => {
      console.error(`Failed to sync Clerk role for ${input.clerkUserId}:`, err);
    });
    const event = { clerkUserId: input.clerkUserId, actorId: input.actorId, fromRole: target.role, toRole: input.role };
    void safeAudit(
      () => logUserRoleChange(event, { audit: deps.audit }).then((r) => {
        if (!r.ok) throw r.error;
      }),
      (payload, error) => deps.audit.recordDeadLetter({ kind: 'user', payload, error }),
      event,
      'user',
    );
    return ok({ user: { clerkUserId: row.clerkUserId, role: row.role } });
  } catch (e) {
    return err(new ExternalServiceError('Failed to set user role', e));
  }
}

export async function getUserByClerkId(
  clerkUserId: string,
  deps: { users: UserRepository },
): Promise<Result<{ user: { clerkUserId: string; email: string; name: string | null; role: string } | null }>> {
  try {
    const u = await deps.users.findByClerkId(clerkUserId);
    return ok({ user: u ? { clerkUserId: u.clerkUserId, email: u.email, name: u.name, role: u.role } : null });
  } catch (e) {
    return err(new ExternalServiceError('Failed to get user', e));
  }
}

export async function touchLastSeen(
  clerkUserId: string,
  deps: { users: UserRepository },
): Promise<Result<void>> {
  try {
    await deps.users.touchLastSeen(clerkUserId);
    return ok(undefined);
  } catch (e) {
    return err(new ExternalServiceError('Failed to update last seen', e));
  }
}

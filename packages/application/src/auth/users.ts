import { err, ok, type Result, NotFoundError, ValidationError, ForbiddenError, ExternalServiceError, logger } from '@app/domain';
import type { UserRepository, TransactionRunner, CursorPageInfo } from '@app/domain';
import type { AuditLog } from '@app/domain';
import { MAX_LIST_LIMIT } from '@app/domain';
import { decodeCursorAtBoundary, sanitizePagination, wrapServiceCall } from '../service-result';
import { logUserRoleChange } from './audit';
import { safeAudit } from '../audit-reliability';

export async function listUsers(
  input: { search?: string | undefined; limit?: number; offset?: number; cursor?: unknown; before?: unknown },
  deps: { users: UserRepository },
): Promise<Result<{ users: Array<{ clerkUserId: string; email: string; name: string | null; role: string; lastSeenAt: Date | null; createdAt: Date }>; total: number } & CursorPageInfo>> {
  return wrapServiceCall(async () => {
    const cursor = decodeCursorAtBoundary(input.cursor, 'users');
    const before = decodeCursorAtBoundary(input.before, 'users');
    if (cursor !== undefined && before !== undefined) {
      throw new ValidationError('Only one pagination cursor may be provided');
    }
    const { limit, offset } = sanitizePagination(input.limit, input.offset, MAX_LIST_LIMIT);
    const result = await deps.users.list({
      search: input.search,
      limit,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(before !== undefined ? { before } : {}),
      ...(cursor === undefined && before === undefined ? { offset } : {}),
    });
    return ok({
      users: result.rows,
      total: result.total,
      nextCursor: result.nextCursor ?? null,
      previousCursor: result.previousCursor ?? null,
    });
  }, 'Failed to list users');
}

export async function setUserRole(
  input: { clerkUserId: string; role: 'admin' | 'user'; actorId: string },
  deps: { users: UserRepository; audit: AuditLog; syncClerkRole: (clerkUserId: string, role: 'admin' | 'user') => Promise<void>; runner: TransactionRunner },
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

    type Outcome =
      | { kind: 'ok'; user: { clerkUserId: string; role: string } }
      | { kind: 'last_admin' }
      | { kind: 'not_found' };
    const outcome = await deps.runner.run<Outcome>(async (ctx) => {
      if (target.role === 'admin' && input.role === 'user') {
        const adminCount = await ctx.users.countAdminsForUpdate();
        if (adminCount <= 1) {
          return { kind: 'last_admin' };
        }
      }
      const row = await ctx.users.setRole(input.clerkUserId, input.role);
      if (!row) return { kind: 'not_found' };
      return { kind: 'ok', user: { clerkUserId: row.clerkUserId, role: row.role } };
    });
    if (outcome.kind === 'last_admin') {
      return err(new ForbiddenError('Cannot demote the last admin'));
    }
    if (outcome.kind === 'not_found') {
      return err(new NotFoundError(`User not found: ${input.clerkUserId}`));
    }

    // Clerk sync is outside the TX that serialized concurrent demotes via countAdminsForUpdate; rollback is best-effort with version check where available.
    try {
      await deps.syncClerkRole(input.clerkUserId, input.role);
    } catch (e) {
      let rollbackOk = false;
      try {
        rollbackOk = deps.users.setRoleIfCurrent
          ? await deps.users.setRoleIfCurrent(input.clerkUserId, input.role, target.role)
          : (await deps.users.setRole(input.clerkUserId, target.role)) !== null;
      } catch (rollbackErr) {
        logger.error('setUserRole: Clerk sync failed and DB rollback also failed', {
          clerkUserId: input.clerkUserId,
          requestedRole: input.role,
          syncError: e,
          rollbackError: rollbackErr,
        });
      }
      if (rollbackOk) {
        logger.error('setUserRole: Clerk sync failed; DB role rolled back', {
          clerkUserId: input.clerkUserId,
          requestedRole: input.role,
          error: e,
        });
      }
      const rollbackEvent = rollbackOk
        ? {
            clerkUserId: input.clerkUserId,
            actorId: input.actorId,
            fromRole: input.role,
            toRole: target.role,
          }
        : {
            clerkUserId: input.clerkUserId,
            actorId: input.actorId,
            fromRole: target.role,
            toRole: input.role,
          };
      void safeAudit(
        () => logUserRoleChange(rollbackEvent, { audit: deps.audit }).then((r) => {
          if (!r.ok) throw r.error;
        }),
        (payload, error) => deps.audit.recordDeadLetter({ kind: 'user', payload, error }),
        rollbackEvent,
        'user',
      );
      if (!rollbackOk) {
        return err(new ExternalServiceError('Failed to sync Clerk role and rollback failed', e));
      }
      return err(new ExternalServiceError('Failed to sync Clerk role', e));
    }
    const event = { clerkUserId: input.clerkUserId, actorId: input.actorId, fromRole: target.role, toRole: input.role };
    void safeAudit(
      () => logUserRoleChange(event, { audit: deps.audit }).then((r) => {
        if (!r.ok) throw r.error;
      }),
      (payload, error) => deps.audit.recordDeadLetter({ kind: 'user', payload, error }),
      event,
      'user',
    );
    return ok({ user: outcome.user });
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

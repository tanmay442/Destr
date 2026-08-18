import { describe, it, expect, vi, afterEach } from 'vitest';
import { ForbiddenError, ExternalServiceError, logger } from '@app/domain';
import type { TransactionContext } from '@app/domain';
import { setUserRole } from '../users';
import type { UserRepository, AuditLog } from '@app/domain';

afterEach(() => {
  vi.restoreAllMocks();
});

function makeDeps(overrides?: {
  users?: Partial<UserRepository>;
  audit?: Partial<AuditLog>;
  syncClerkRole?: (clerkUserId: string, role: 'admin' | 'user') => Promise<void>;
}) {
  const logTicketEvent = vi.fn().mockResolvedValue(undefined);
  const users = {
    upsertFromClerk: vi.fn(),
    findByClerkId: vi.fn().mockResolvedValue({ clerkUserId: 'actor_1', role: 'admin' }),
    setRole: vi.fn().mockResolvedValue({ clerkUserId: 'user_1', role: 'admin' }),
    touchLastSeen: vi.fn(),
    list: vi.fn(),
    countAll: vi.fn(),
    countAdmins: vi.fn().mockResolvedValue(2),
    countAdminsForUpdate: vi.fn().mockResolvedValue(2),
    syncClerkRole: vi.fn().mockResolvedValue(undefined),
    ...overrides?.users,
  } as UserRepository;
  return {
    users,
    runner: {
      run: async <T>(fn: (ctx: TransactionContext) => Promise<T>): Promise<T> =>
        fn({ users } as TransactionContext),
    },
    syncClerkRole: overrides?.syncClerkRole ?? vi.fn().mockResolvedValue(undefined),
    audit: {
      logDocumentEvent: vi.fn(),
      logTicketEvent,
      logUserEvent: vi.fn(),
      list: vi.fn(),
      recordDeadLetter: vi.fn().mockResolvedValue(undefined),
      ...overrides?.audit,
    } as AuditLog,
  };
}

describe('setUserRole', () => {
  it('logs a role_change user audit event', async () => {
    const logUserEvent = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ audit: { logUserEvent } });
    const result = await setUserRole(
      { clerkUserId: 'user_1', role: 'admin', actorId: 'actor_1' },
      deps as Parameters<typeof setUserRole>[1],
    );
    expect(result.ok).toBe(true);
    expect(logUserEvent).toHaveBeenCalledWith({
      targetUserId: 'user_1',
      actorId: 'actor_1',
      fromRole: 'admin',
      toRole: 'admin',
    });
  });

  it('returns ValidationError for invalid role', async () => {
    const deps = makeDeps();
    const result = await setUserRole(
      { clerkUserId: 'user_1', role: 'superadmin' as 'admin', actorId: 'actor_1' },
      deps as Parameters<typeof setUserRole>[1],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/Invalid role/);
    }
  });

  it('returns NotFoundError when user does not exist', async () => {
    const deps = makeDeps({
      users: { setRole: vi.fn().mockResolvedValue(null) },
    });
    const result = await setUserRole(
      { clerkUserId: 'nonexistent', role: 'admin', actorId: 'actor_1' },
      deps as Parameters<typeof setUserRole>[1],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/User not found/);
    }
  });

  it('rejects changing your own role', async () => {
    const deps = makeDeps();
    const result = await setUserRole(
      { clerkUserId: 'user_1', role: 'user', actorId: 'user_1' },
      deps as Parameters<typeof setUserRole>[1],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ForbiddenError);
    }
  });

  it('rejects when actor is not an admin', async () => {
    const deps = makeDeps({
      users: { findByClerkId: vi.fn().mockResolvedValue({ clerkUserId: 'actor_2', role: 'user' }) },
    });
    const result = await setUserRole(
      { clerkUserId: 'user_1', role: 'admin', actorId: 'actor_2' },
      deps as Parameters<typeof setUserRole>[1],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ForbiddenError);
    }
  });

  it('rejects demoting the last admin', async () => {
    const deps = makeDeps({
      users: {
        countAdminsForUpdate: vi.fn().mockResolvedValue(1),
        findByClerkId: vi.fn().mockResolvedValue({ clerkUserId: 'admin_1', role: 'admin' }),
      },
    });
    const result = await setUserRole(
      { clerkUserId: 'admin_1', role: 'user', actorId: 'actor_1' },
      deps as Parameters<typeof setUserRole>[1],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ForbiddenError);
    }
  });

  it('persists the role before syncing Clerk and reverts on sync failure', async () => {
    const setRole = vi.fn().mockResolvedValue({ clerkUserId: 'user_1', role: 'admin' });
    const syncClerkRole = vi.fn().mockRejectedValue(new Error('Clerk down'));
    const deps = makeDeps({ users: { setRole }, syncClerkRole });
    const result = await setUserRole(
      { clerkUserId: 'user_1', role: 'admin', actorId: 'actor_1' },
      deps as Parameters<typeof setUserRole>[1],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ExternalServiceError);
    }
    expect(syncClerkRole).toHaveBeenCalledWith('user_1', 'admin');
    expect(setRole).toHaveBeenLastCalledWith('user_1', 'admin');
  });

  it('runs the last-admin check inside the same transaction as the update', async () => {
    const setRole = vi.fn().mockResolvedValue({ clerkUserId: 'admin_1', role: 'user' });
    const countAdminsForUpdate = vi.fn().mockResolvedValue(2);
    const deps = makeDeps({
      users: {
        countAdminsForUpdate,
        setRole,
        findByClerkId: vi.fn().mockResolvedValue({ clerkUserId: 'admin_1', role: 'admin' }),
      },
    });
    const result = await setUserRole(
      { clerkUserId: 'admin_1', role: 'user', actorId: 'actor_1' },
      deps as Parameters<typeof setUserRole>[1],
    );
    expect(result.ok).toBe(true);
    expect(countAdminsForUpdate).toHaveBeenCalled();
    expect(setRole).toHaveBeenCalledWith('admin_1', 'user');
  });

  it('audits the rollback and logs when Clerk sync fails', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const logUserEvent = vi.fn().mockResolvedValue(undefined);
    const setRole = vi.fn().mockResolvedValue({ clerkUserId: 'user_1', role: 'admin' });
    const syncClerkRole = vi.fn().mockRejectedValue(new Error('Clerk down'));
    const deps = makeDeps({
      users: {
        setRole,
        findByClerkId: vi.fn((id: string) =>
          Promise.resolve({ clerkUserId: id, role: id === 'user_1' ? 'user' : 'admin' } as never),
        ),
      },
      syncClerkRole,
      audit: { logUserEvent },
    });
    const result = await setUserRole(
      { clerkUserId: 'user_1', role: 'admin', actorId: 'actor_1' },
      deps as Parameters<typeof setUserRole>[1],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ExternalServiceError);
      expect(result.error.message).toMatch(/Failed to sync Clerk role/);
    }
    expect(setRole).toHaveBeenLastCalledWith('user_1', 'user');
    expect(logUserEvent).toHaveBeenCalledWith({
      targetUserId: 'user_1',
      actorId: 'actor_1',
      fromRole: 'admin',
      toRole: 'user',
    });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]![0]).toMatch(/rolled back/i);
  });

  it('logs and audits the committed change when the DB rollback also fails', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const logUserEvent = vi.fn().mockResolvedValue(undefined);
    const setRole = vi
      .fn()
      .mockResolvedValueOnce({ clerkUserId: 'user_1', role: 'admin' })
      .mockRejectedValueOnce(new Error('rollback DB down'));
    const syncClerkRole = vi.fn().mockRejectedValue(new Error('Clerk down'));
    const deps = makeDeps({
      users: {
        setRole,
        findByClerkId: vi.fn((id: string) =>
          Promise.resolve({ clerkUserId: id, role: id === 'user_1' ? 'user' : 'admin' } as never),
        ),
      },
      syncClerkRole,
      audit: { logUserEvent },
    });
    const result = await setUserRole(
      { clerkUserId: 'user_1', role: 'admin', actorId: 'actor_1' },
      deps as Parameters<typeof setUserRole>[1],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/rollback failed/i);
    }
    expect(logUserEvent).toHaveBeenCalledWith({
      targetUserId: 'user_1',
      actorId: 'actor_1',
      fromRole: 'user',
      toRole: 'admin',
    });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]![0]).toMatch(/rollback also failed/i);
    expect(errorSpy.mock.calls[0]![1]).toEqual(
      expect.objectContaining({ requestedRole: 'admin' }),
    );
  });
});

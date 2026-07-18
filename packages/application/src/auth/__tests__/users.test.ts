import { describe, it, expect, vi } from 'vitest';
import { ForbiddenError } from '@app/domain';
import { setUserRole } from '../users';
import type { UserRepository, AuditLog } from '@app/domain';

function makeDeps(overrides?: {
  users?: Partial<UserRepository>;
  audit?: Partial<AuditLog>;
}) {
  const logTicketEvent = vi.fn().mockResolvedValue(undefined);
  return {
    users: {
      upsertFromClerk: vi.fn(),
      findByClerkId: vi.fn().mockResolvedValue({ clerkUserId: 'actor_1', role: 'admin' }),
      setRole: vi.fn().mockResolvedValue({ clerkUserId: 'user_1', role: 'admin' }),
      touchLastSeen: vi.fn(),
      list: vi.fn(),
      countAll: vi.fn(),
      syncClerkRole: vi.fn().mockResolvedValue(undefined),
      ...overrides?.users,
    } as UserRepository,
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
});

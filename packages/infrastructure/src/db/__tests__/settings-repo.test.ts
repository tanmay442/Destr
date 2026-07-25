import { describe, it, expect, beforeEach } from 'vitest';
import { createSettingsRepo } from '../settings-repo';
import { db } from '../client';
import { appSettings } from '../schema';
import { eq } from 'drizzle-orm';

async function dbReachable(): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
  try {
    await db.execute('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

const connected = await dbReachable();
const suite = connected ? describe : describe.skip;

suite('settings-repo optimistic concurrency', () => {
  const repo = createSettingsRepo(db);

  beforeEach(async () => {
    await db
      .update(appSettings)
      .set({ overrides: {}, version: 0, updatedBy: null })
      .where(eq(appSettings.id, 1));
  });

  it('seeds a single row on first read and reports version 0', async () => {
    const { overrides, version } = await repo.getOverrides();
    expect(version).toBe(0);
    expect(overrides).toEqual({});
  });

  it('increments version on a save with the expected version', async () => {
    const saved = await repo.saveOverrides({
      patch: { retrievalMode: 'normal' },
      actorId: 'tester',
      expectedVersion: 0,
    });
    expect(saved).toEqual({ version: 1 });
    const { overrides, version } = await repo.getOverrides();
    expect(version).toBe(1);
    expect(overrides.retrievalMode).toBe('normal');
  });

  it('returns a conflict when the expected version is stale', async () => {
    await repo.saveOverrides({
      patch: { retrievalMode: 'normal' },
      actorId: 'tester',
      expectedVersion: 0,
    });
    const stale = await repo.saveOverrides({
      patch: { retrievalMode: 'agentic' },
      actorId: 'tester',
      expectedVersion: 0,
    });
    expect(stale).toEqual({ conflict: true });
  });

  it('continues from the latest version after a conflict', async () => {
    await repo.saveOverrides({
      patch: { retrievalMode: 'normal' },
      actorId: 'tester',
      expectedVersion: 0,
    });
    const next = await repo.saveOverrides({
      patch: { retrievalMode: 'agentic' },
      actorId: 'tester',
      expectedVersion: 1,
    });
    expect(next).toEqual({ version: 2 });
  });
});

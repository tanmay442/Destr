import { describe, it, expect } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { ConflictError } from '@app/domain';
import { ChatHistoryRepository } from '../chat-history-repo';
import { users, chatConversations, chatMessages } from '../schema';
import { db } from '../client';

const CONV_A = 'a0000000-0000-4000-8000-000000000001';
const CONV_B = 'b0000000-0000-4000-8000-000000000002';

function turn(userMessageId: string) {
  return {
    userMessage: { id: userMessageId, role: 'user', parts: [{ type: 'text', text: 'q' }] },
    assistantMessage: {
      id: `assistant-${userMessageId}`,
      role: 'assistant',
      parts: [{ type: 'text', text: 'a' }],
      metadata: { citations: [], guardrail: { outOfDomain: false, offerTicket: false } },
    },
  };
}

async function dbReachable(): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
  try {
    await db.execute(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  }
}

const connected = await dbReachable();
const suite = connected ? describe : describe.skip;

const ROLLBACK = new Error('ROLLBACK');

async function withRollback(fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<void>) {
  try {
    await db.transaction(async (tx) => {
      await fn(tx);
      throw ROLLBACK;
    });
  } catch (e) {
    expect(e).toBe(ROLLBACK);
  }
}

const OWNER = 'hist-owner';

suite('ChatHistoryRepository.appendTurn', () => {
  it('upserts keyed by the client-supplied id and keeps message_count exact on double-fire', async () => {
    await withRollback(async (tx) => {
      await tx.insert(users).values({ clerkUserId: OWNER, email: 'hist-owner2@test.local' });
      const repo = new ChatHistoryRepository(tx);
      const t1 = crypto.randomUUID();
      await repo.appendTurn({ conversationId: CONV_A, userId: OWNER, turnId: t1, title: 'T', ...turn('m1') });
      await repo.appendTurn({ conversationId: CONV_A, userId: OWNER, turnId: t1, title: 'T', ...turn('m1') });
      const conv = (await tx.select().from(chatConversations))[0];
      expect(conv?.messageCount).toBe(2);
      const msgs = await tx.select().from(chatMessages);
      expect(msgs).toHaveLength(2);
    });
  });

  it('no-ops when the client-supplied id belongs to another user', async () => {
    await withRollback(async (tx) => {
      await tx.insert(users).values([
        { clerkUserId: OWNER, email: 'hist-owner3@test.local' },
        { clerkUserId: 'hist-other', email: 'hist-other@test.local' },
      ]);
      const repo = new ChatHistoryRepository(tx);
      await repo.appendTurn({
        conversationId: CONV_B, userId: 'hist-other', turnId: crypto.randomUUID(), title: 'x', ...turn('m1'),
      });
      await expect(repo.appendTurn({
        conversationId: CONV_B, userId: OWNER, turnId: crypto.randomUUID(), title: 'y', ...turn('m9'),
      })).rejects.toMatchObject({ code: 'forbidden', status: 403 });
      const msgs = await tx.select().from(chatMessages);
      expect(msgs).toHaveLength(2);
      const conv = (await tx.select().from(chatConversations))[0];
      expect(conv?.userId).toBe('hist-other');
      expect(conv?.messageCount).toBe(2);
    });
  });

  it('replaces the previous pair on retry and keeps counts correct', async () => {
    await withRollback(async (tx) => {
      await tx.insert(users).values({ clerkUserId: OWNER, email: 'hist-owner4@test.local' });
      const repo = new ChatHistoryRepository(tx);
      const firstTurn = crypto.randomUUID();
      await repo.appendTurn({ conversationId: CONV_A, userId: OWNER, turnId: firstTurn, title: 'T', ...turn('m1') });
      await repo.appendTurn({
        conversationId: CONV_A, userId: OWNER, turnId: crypto.randomUUID(), retryOfMessageId: 'm1',
        ...turn('m1'),
      });
      const conv = (await tx.select().from(chatConversations))[0];
      expect(conv?.messageCount).toBe(2);
      const msgs = await tx.select().from(chatMessages).orderBy(chatMessages.id);
      expect(msgs).toHaveLength(2);
      const storedUser = msgs[0]?.content as { id: string };
      const storedAssistant = msgs[1]?.content as { id: string };
      expect(storedUser.id).toBe('m1');
      expect(storedAssistant.id).toBe('assistant-m1');
    });
  });

  it('deletes exactly the adjacent pair on a tail retry (H4)', async () => {
    await withRollback(async (tx) => {
      await tx.insert(users).values({ clerkUserId: OWNER, email: 'hist-owner7@test.local' });
      const repo = new ChatHistoryRepository(tx);
      await repo.appendTurn({ conversationId: CONV_A, userId: OWNER, turnId: crypto.randomUUID(), title: 'T', ...turn('m1') });
      await repo.appendTurn({ conversationId: CONV_A, userId: OWNER, turnId: crypto.randomUUID(), title: 'T', ...turn('m2') });
      await repo.appendTurn({
        conversationId: CONV_A, userId: OWNER, turnId: crypto.randomUUID(), retryOfMessageId: 'm2',
        ...turn('m2'),
      });
      const msgs = await tx.select().from(chatMessages).orderBy(chatMessages.id);
      expect(msgs).toHaveLength(4);
      const ids = msgs.map((m) => (m.content as { id: string }).id);
      expect(ids).toEqual(['m1', 'assistant-m1', 'm2', 'assistant-m2']);
      const conv = (await tx.select().from(chatConversations))[0];
      expect(conv?.messageCount).toBe(4);
    });
  });

  it('appends without deleting anything for a non-tail retry (H4)', async () => {
    await withRollback(async (tx) => {
      await tx.insert(users).values({ clerkUserId: OWNER, email: 'hist-owner8@test.local' });
      const repo = new ChatHistoryRepository(tx);
      await repo.appendTurn({ conversationId: CONV_A, userId: OWNER, turnId: crypto.randomUUID(), title: 'T', ...turn('m1') });
      await repo.appendTurn({ conversationId: CONV_A, userId: OWNER, turnId: crypto.randomUUID(), title: 'T', ...turn('m2') });
      await repo.appendTurn({
        conversationId: CONV_A, userId: OWNER, turnId: crypto.randomUUID(), retryOfMessageId: 'm1',
        ...turn('m1'),
      });
      const msgs = await tx.select().from(chatMessages).orderBy(chatMessages.id);
      expect(msgs).toHaveLength(6);
      const conv = (await tx.select().from(chatConversations))[0];
      expect(conv?.messageCount).toBe(6);
    });
  });

  it('ignores a retry whose target message id matches nothing (T7)', async () => {
    await withRollback(async (tx) => {
      await tx.insert(users).values({ clerkUserId: OWNER, email: 'hist-owner9@test.local' });
      const repo = new ChatHistoryRepository(tx);
      await repo.appendTurn({ conversationId: CONV_A, userId: OWNER, turnId: crypto.randomUUID(), title: 'T', ...turn('m1') });
      await repo.appendTurn({
        conversationId: CONV_A, userId: OWNER, turnId: crypto.randomUUID(), retryOfMessageId: 'missing-id',
        ...turn('m2'),
      });
      const msgs = await tx.select().from(chatMessages).orderBy(chatMessages.id);
      expect(msgs).toHaveLength(4);
      const conv = (await tx.select().from(chatConversations))[0];
      expect(conv?.messageCount).toBe(4);
    });
  });

  it('keeps message_count stable when a retry reuses an existing turn id (H4)', async () => {
    await withRollback(async (tx) => {
      await tx.insert(users).values({ clerkUserId: OWNER, email: 'hist-owner10@test.local' });
      const repo = new ChatHistoryRepository(tx);
      const reusedTurnId = crypto.randomUUID();
      await repo.appendTurn({ conversationId: CONV_A, userId: OWNER, turnId: reusedTurnId, title: 'T', ...turn('m1') });
      await repo.appendTurn({
        conversationId: CONV_A, userId: OWNER, turnId: reusedTurnId, retryOfMessageId: 'm1',
        ...turn('m1'),
      });
      const msgs = await tx.select().from(chatMessages).orderBy(chatMessages.id);
      expect(msgs).toHaveLength(2);
      const conv = (await tx.select().from(chatConversations))[0];
      expect(conv?.messageCount).toBe(2);
    });
  });
});

suite('ChatHistoryRepository storage caps (H1/M3)', () => {
  const CAP_OWNER = 'hist-cap';
  const CONV_D = 'd0000000-0000-4000-8000-00000000000e';
  const CONV_E = 'e0000000-0000-4000-8000-00000000000e';

  function seedConversationValues(count: number) {
    return Array.from({ length: count }, (_, i) => ({
      id: `f${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`,
      userId: CAP_OWNER,
      title: `c${i}`,
    }));
  }

  it('allows the 512th conversation and blocks the 513th on the client-keyed path', async () => {
    await withRollback(async (tx) => {
      await tx.insert(users).values({ clerkUserId: CAP_OWNER, email: 'hist-cap@test.local' });
      await tx.insert(chatConversations).values(seedConversationValues(511));
      const repo = new ChatHistoryRepository(tx);
      await repo.appendTurn({ conversationId: CONV_D, userId: CAP_OWNER, turnId: crypto.randomUUID(), title: 'T', ...turn('m1') });
      expect(await repo.countConversations(CAP_OWNER)).toBe(512);
      await expect(
        repo.appendTurn({ conversationId: CONV_E, userId: CAP_OWNER, turnId: crypto.randomUUID(), title: 'T', ...turn('m2') }),
      ).rejects.toBeInstanceOf(ConflictError);
      expect(await repo.countConversations(CAP_OWNER)).toBe(512);
    });
  });

  it('blocks appends when the stored message cap cannot fit both turn messages', async () => {
    await withRollback(async (tx) => {
      await tx.insert(users).values({ clerkUserId: CAP_OWNER, email: 'hist-cap2@test.local' });
      await tx
        .insert(chatConversations)
        .values({ id: CONV_A, userId: CAP_OWNER, title: 'full' });
      await tx.insert(chatMessages).values(
        Array.from({ length: 498 }, (_, i) => ({
          conversationId: CONV_A,
          turnId: null,
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: { id: `seed-${i}`, role: 'user', parts: [{ type: 'text', text: 'q' }] },
        })),
      );
      const repo = new ChatHistoryRepository(tx);
      await repo.appendTurn({ conversationId: CONV_A, userId: CAP_OWNER, turnId: crypto.randomUUID(), title: 'T', ...turn('m1') });
      const rows = await tx.select().from(chatMessages).where(eq(chatMessages.conversationId, CONV_A));
      expect(rows).toHaveLength(500);
      await expect(
        repo.appendTurn({ conversationId: CONV_A, userId: CAP_OWNER, turnId: crypto.randomUUID(), title: 'T', ...turn('m2') }),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });
});

suite('ChatHistoryRepository concurrent replaces (XM1)', () => {
  const CONV_C = 'c0000000-0000-4000-8000-000000000003';
  const CONC_OWNER = 'hist-conc';

  it('serializes two simultaneous retries without losing rows or drifting counts', async () => {
    await db.insert(users).values({ clerkUserId: CONC_OWNER, email: 'hist-conc@test.local' });
    try {
      const repo = new ChatHistoryRepository(db);
      await repo.appendTurn({ conversationId: CONV_C, userId: CONC_OWNER, turnId: crypto.randomUUID(), title: 'T', ...turn('m1') });
      await Promise.all([
        repo.appendTurn({ conversationId: CONV_C, userId: CONC_OWNER, turnId: crypto.randomUUID(), retryOfMessageId: 'm1', ...turn('m1') }),
        repo.appendTurn({ conversationId: CONV_C, userId: CONC_OWNER, turnId: crypto.randomUUID(), retryOfMessageId: 'm1', ...turn('m1') }),
      ]);
      const msgs = await db.select().from(chatMessages).where(eq(chatMessages.conversationId, CONV_C));
      expect(msgs).toHaveLength(2);
      const [conv] = await db
        .select()
        .from(chatConversations)
        .where(and(eq(chatConversations.id, CONV_C), eq(chatConversations.userId, CONC_OWNER)));
      expect(conv?.messageCount).toBe(2);
    } finally {
      await db.delete(chatMessages).where(eq(chatMessages.conversationId, CONV_C));
      await db.delete(chatConversations).where(eq(chatConversations.id, CONV_C));
      await db.delete(users).where(eq(users.clerkUserId, CONC_OWNER));
    }
  });
});

suite('ChatHistoryRepository reads and deletes', () => {
  it('lists newest-first with ownership, returns ascending latest messages, renames and deletes', async () => {
    await withRollback(async (tx) => {
      await tx.insert(users).values([
        { clerkUserId: OWNER, email: 'hist-owner5@test.local' },
        { clerkUserId: 'hist-other2', email: 'hist-other2@test.local' },
      ]);
      const repo = new ChatHistoryRepository(tx);
      await repo.appendTurn({ conversationId: CONV_A, userId: OWNER, turnId: crypto.randomUUID(), title: 'A', ...turn('m1') });
      await tx
        .update(chatConversations)
        .set({ updatedAt: new Date(Date.now() - 60_000) })
        .where(sql`id = ${CONV_A}`);
      await repo.appendTurn({ conversationId: CONV_B, userId: OWNER, turnId: crypto.randomUUID(), title: 'B', ...turn('m2') });

      const list = await repo.listConversations(OWNER, { limit: 10, offset: 0 });
      expect(list.map((c) => c.id)).toEqual([CONV_B, CONV_A]);
      expect(await repo.listConversations('hist-nobody', { limit: 10, offset: 0 })).toEqual([]);
      expect(await repo.countConversations(OWNER)).toBe(2);

      const loaded = await repo.getConversation(OWNER, CONV_A);
      expect(loaded?.conversation.title).toBe('A');
      expect(loaded?.messages.map((m) => m.role)).toEqual(['user', 'assistant']);

      expect(await repo.getConversation('hist-other2', CONV_A)).toBeNull();

      expect(await repo.renameConversation(OWNER, CONV_A, 'Renamed')).toBe(true);
      const renamed = await repo.getConversation(OWNER, CONV_A);
      expect(renamed?.conversation.title).toBe('Renamed');
      expect(await repo.renameConversation('hist-other2', CONV_A, 'nope')).toBe(false);

      expect(await repo.deleteConversation(OWNER, CONV_A)).toBe(true);
      expect(await repo.deleteConversation(OWNER, CONV_A)).toBe(false);
      const orphans = await tx.select().from(chatMessages).where(sql`conversation_id = ${CONV_A}`);
      expect(orphans).toEqual([]);

      const purged = await repo.purgeUserData(OWNER);
      expect(purged.deletedConversations).toBe(1);
      expect(purged.deletedMessages).toBeGreaterThanOrEqual(2);
      expect(await repo.countConversations(OWNER)).toBe(0);
    });
  });

  it('purges only conversations older than the cutoff', async () => {
    await withRollback(async (tx) => {
      await tx.insert(users).values({ clerkUserId: OWNER, email: 'hist-owner6@test.local' });
      const repo = new ChatHistoryRepository(tx);
      await repo.appendTurn({ conversationId: CONV_A, userId: OWNER, turnId: crypto.randomUUID(), title: 'old', ...turn('m1') });
      await tx
        .update(chatConversations)
        .set({ updatedAt: new Date(Date.now() - 10 * 86_400_000) })
        .where(sql`id = ${CONV_A}`);
      await repo.appendTurn({ conversationId: CONV_B, userId: OWNER, turnId: crypto.randomUUID(), title: 'new', ...turn('m2') });

      const result = await repo.purgeOlderThan(new Date(Date.now() - 5 * 86_400_000));
      expect(result.deletedConversations).toBe(1);
      const remaining = await repo.listConversations(OWNER, { limit: 10, offset: 0 });
      expect(remaining.map((c) => c.id)).toEqual([CONV_B]);
    });
  });
});

import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
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
  it('creates the conversation lazily on a null id and auto-fills the title', async () => {
    await withRollback(async (tx) => {
      await tx.insert(users).values({ clerkUserId: OWNER, email: 'hist-owner@test.local' });
      const repo = new ChatHistoryRepository(tx);
      const { conversationId } = await repo.appendTurn({
        conversationId: null,
        userId: OWNER,
        turnId: crypto.randomUUID(),
        title: 'First question',
        ...turn('m1'),
      });
      expect(conversationId).toMatch(/^[0-9a-f-]{36}$/);
      const row = (await tx.select().from(chatConversations))[0];
      expect(row?.title).toBe('First question');
      expect(row?.messageCount).toBe(2);
      expect(row?.userId).toBe(OWNER);
    });
  });

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
      const result = await repo.appendTurn({
        conversationId: CONV_B, userId: OWNER, turnId: crypto.randomUUID(), title: 'y', ...turn('m9'),
      });
      expect(result.conversationId).toBe(CONV_B);
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

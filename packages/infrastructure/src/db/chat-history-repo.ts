import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { db } from './client';
import { chatConversations, chatMessages } from './schema';
import type {
  AppendChatTurnInput,
  ChatHistoryRepo,
  ConversationSummary,
  StoredChatMessage,
} from '@app/domain';
import { MAX_RESUME_MESSAGES } from '@app/domain';

type Client = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export class ChatHistoryRepository implements ChatHistoryRepo {
  constructor(private readonly client: Client = db) {}

  async appendTurn(input: AppendChatTurnInput): Promise<{ conversationId: string }> {
    return this.client.transaction(async (tx) => {
      let conversationId = input.conversationId;

      if (conversationId === null) {
        const created = await tx
          .insert(chatConversations)
          .values({ userId: input.userId, title: input.title ?? '' })
          .returning({ id: chatConversations.id });
        if (!created[0]) throw new Error('chat history: conversation insert returned no row');
        conversationId = created[0].id;
      } else {
        const inserted = await tx
          .insert(chatConversations)
          .values({ id: conversationId, userId: input.userId, title: input.title ?? '' })
          .onConflictDoNothing({ target: chatConversations.id })
          .returning({ id: chatConversations.id });
        if (inserted.length === 0) {
          const [owner] = await tx
            .select({ userId: chatConversations.userId })
            .from(chatConversations)
            .where(eq(chatConversations.id, conversationId))
            .limit(1);
          if (!owner || owner.userId !== input.userId) return { conversationId };
        }
      }

      let removedByReplace = 0;
      if (input.retryOfMessageId !== undefined) {
        await tx
          .select({ id: chatConversations.id })
          .from(chatConversations)
          .where(eq(chatConversations.id, conversationId))
          .for('update');

        const [existingTurn] = await tx
          .select({ id: chatMessages.id })
          .from(chatMessages)
          .where(and(eq(chatMessages.conversationId, conversationId), eq(chatMessages.turnId, input.turnId)))
          .limit(1);
        if (existingTurn) return { conversationId };

        const [prevUser] = await tx
          .select({ id: chatMessages.id })
          .from(chatMessages)
          .where(
            and(
              eq(chatMessages.conversationId, conversationId),
              eq(chatMessages.role, 'user'),
              sql`${chatMessages.content} ->> 'id' = ${input.retryOfMessageId}`,
            ),
          )
          .orderBy(desc(chatMessages.id))
          .limit(1);

        let tail = true;
        if (prevUser) {
          const [laterUser] = await tx
            .select({ id: chatMessages.id })
            .from(chatMessages)
            .where(
              and(
                eq(chatMessages.conversationId, conversationId),
                eq(chatMessages.role, 'user'),
                sql`${chatMessages.id} > ${prevUser.id}`,
              ),
            )
            .limit(1);
          tail = !laterUser;
        }

        if (prevUser && tail) {
          const [nextAssistant] = await tx
            .select({ id: chatMessages.id })
            .from(chatMessages)
            .where(
              and(
                eq(chatMessages.conversationId, conversationId),
                eq(chatMessages.role, 'assistant'),
                sql`${chatMessages.id} > ${prevUser.id}`,
              ),
            )
            .orderBy(chatMessages.id)
            .limit(1);

          const droppedUser = await tx
            .delete(chatMessages)
            .where(eq(chatMessages.id, prevUser.id))
            .returning({ id: chatMessages.id });
          removedByReplace += droppedUser.length;
          if (nextAssistant) {
            const droppedAssistant = await tx
              .delete(chatMessages)
              .where(eq(chatMessages.id, nextAssistant.id))
              .returning({ id: chatMessages.id });
            removedByReplace += droppedAssistant.length;
          }
        }
      }

      const insertedRows = await tx
        .insert(chatMessages)
        .values([
          { conversationId, turnId: input.turnId, role: 'user', content: input.userMessage },
          { conversationId, turnId: input.turnId, role: 'assistant', content: input.assistantMessage },
        ])
        .onConflictDoNothing({
          target: [chatMessages.conversationId, chatMessages.turnId, chatMessages.role],
        })
        .returning({ id: chatMessages.id });

      const delta = insertedRows.length - removedByReplace;
      if (delta !== 0 || insertedRows.length > 0) {
        await tx
          .update(chatConversations)
          .set({
            messageCount:
              delta === 0 ? sql`${chatConversations.messageCount}` : sql`${chatConversations.messageCount} + ${delta}`,
            updatedAt: sql`now()`,
          })
          .where(eq(chatConversations.id, conversationId));
      }

      return { conversationId };
    });
  }

  async listConversations(userId: string, opts: { limit: number; offset: number }): Promise<ConversationSummary[]> {
    const rows = await this.client
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.userId, userId))
      .orderBy(desc(chatConversations.updatedAt))
      .limit(opts.limit)
      .offset(opts.offset);
    return rows.map(toSummary);
  }

  async getConversation(
    userId: string,
    conversationId: string,
  ): Promise<{ conversation: ConversationSummary; messages: StoredChatMessage[] } | null> {
    const [conversation] = await this.client
      .select()
      .from(chatConversations)
      .where(and(eq(chatConversations.id, conversationId), eq(chatConversations.userId, userId)))
      .limit(1);
    if (!conversation) return null;
    const latest = await this.client
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, conversationId))
      .orderBy(desc(chatMessages.id))
      .limit(MAX_RESUME_MESSAGES);
    return {
      conversation: toSummary(conversation),
      messages: latest.reverse().map((row) => ({
        id: row.id,
        turnId: row.turnId,
        role: row.role as StoredChatMessage['role'],
        content: row.content,
        createdAt: row.createdAt,
      })),
    };
  }

  async renameConversation(userId: string, conversationId: string, title: string): Promise<boolean> {
    const updated = await this.client
      .update(chatConversations)
      .set({ title })
      .where(and(eq(chatConversations.id, conversationId), eq(chatConversations.userId, userId)))
      .returning({ id: chatConversations.id });
    return updated.length > 0;
  }

  async deleteConversation(userId: string, conversationId: string): Promise<boolean> {
    const deleted = await this.client
      .delete(chatConversations)
      .where(and(eq(chatConversations.id, conversationId), eq(chatConversations.userId, userId)))
      .returning({ id: chatConversations.id });
    return deleted.length > 0;
  }

  async countConversations(userId: string): Promise<number> {
    const [row] = await this.client
      .select({ total: sql<number>`count(*)::int` })
      .from(chatConversations)
      .where(eq(chatConversations.userId, userId));
    return Number(row?.total ?? 0);
  }

  async purgeOlderThan(cutoff: Date): Promise<{ deletedConversations: number; deletedMessages: number }> {
    return this.purgeWhere(sql`${chatConversations.updatedAt} <= ${cutoff}`);
  }

  async purgeUserData(userId: string): Promise<{ deletedConversations: number; deletedMessages: number }> {
    return this.purgeWhere(eq(chatConversations.userId, userId));
  }

  private async purgeWhere(
    condition: SQL,
  ): Promise<{ deletedConversations: number; deletedMessages: number }> {
    const [countRow] = await this.client
      .select({ total: sql<number>`count(*)::int` })
      .from(chatMessages)
      .innerJoin(chatConversations, eq(chatMessages.conversationId, chatConversations.id))
      .where(condition);
    const deleted = await this.client
      .delete(chatConversations)
      .where(condition)
      .returning({ id: chatConversations.id });
    return { deletedConversations: deleted.length, deletedMessages: Number(countRow?.total ?? 0) };
  }
}

type ConversationRow = typeof chatConversations.$inferSelect;

function toSummary(row: ConversationRow): ConversationSummary {
  return {
    id: row.id,
    title: row.title,
    messageCount: row.messageCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createChatHistoryRepo(client: Client = db): ChatHistoryRepo {
  return new ChatHistoryRepository(client);
}

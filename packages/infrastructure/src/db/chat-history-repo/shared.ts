import { eq, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { db } from '../client';
import { chatConversations, chatMessages } from '../schema';
import type { ConversationSummary } from '@app/domain';

export type Client = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export const PURGE_BATCH_SIZE = 2_000;

export function messageKeyPredicate(
  rows: Array<{ conversationId: string; id: number }>,
): SQL {
  return sql`(${chatMessages.conversationId}, ${chatMessages.id}) IN (${sql.join(
    rows.map((row) => sql`(${row.conversationId}, ${row.id})`),
    sql`, `,
  )})`;
}

export async function countOwnerConversations(client: Client, userId: string): Promise<number> {
  const [row] = await client
    .select({ total: sql<number>`count(*)::int` })
    .from(chatConversations)
    .where(eq(chatConversations.userId, userId));
  return Number(row?.total ?? 0);
}

export type ConversationRow = typeof chatConversations.$inferSelect;

export function toSummary(row: ConversationRow): ConversationSummary {
  return {
    id: row.id,
    title: row.title,
    messageCount: row.messageCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

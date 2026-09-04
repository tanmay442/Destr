import { and, gte, lte } from 'drizzle-orm';
import { db } from '../client';
import { chatEvents, type NewChatEvent } from '../schema';
import type { ChatEvent, ChatEventInput, ChatEventRange, TurnToTicketBucket } from '@app/domain';
import { toSafeDatabaseId } from '../safe-id';

export type Client = typeof db;

export const MAX_BUFFER = 100;
export const FLUSH_INTERVAL_MS = 5_000;
export const PURGE_BATCH_SIZE = 2_000;

export const TURN_BUCKET_LABELS = ['1', '2', '3', '4', '5+'] as const;

export const EMPTY_TURNS_BUCKETS: TurnToTicketBucket[] = TURN_BUCKET_LABELS.map((label) => ({
  label,
  turns: Number(label === '5+' ? 5 : label),
  count: 0,
}));

export function bucketForTurns(turns: number): number {
  if (turns <= 1) return 0;
  if (turns >= 5) return 4;
  return turns - 1;
}

export function buildTurnBuckets(firstTurns: number[]): TurnToTicketBucket[] {
  const counts = [0, 0, 0, 0, 0];
  for (const t of firstTurns) {
    if (!Number.isFinite(t) || t < 1) continue;
    counts[bucketForTurns(Math.floor(t))]! += 1;
  }
  return TURN_BUCKET_LABELS.map((label, i) => ({
    label,
    turns: Number(label === '5+' ? 5 : label),
    count: counts[i]!,
  }));
}

export function toRow(event: ChatEventInput): NewChatEvent {
  return {
    turnId: event.turnId ?? null,
    userId: event.userId,
    query: event.query,
    mode: event.mode,
    retrieveMs: event.retrieveMs ?? null,
    generateMs: event.generateMs ?? null,
    totalMs: event.totalMs ?? null,
    hitCount: event.hitCount ?? null,
    maxSimilarity: event.maxSimilarity ?? null,
    outOfDomain: event.outOfDomain ?? false,
    hallucinationBlocked: event.hallucinationBlocked ?? false,
    cacheHit: event.cacheHit ?? false,
    ticketCreated: event.ticketCreated ?? false,
    citationCount: event.citationCount ?? null,
    tokensIn: event.tokensIn ?? null,
    tokensOut: event.tokensOut ?? null,
    meta: event.meta ?? {},
  };
}

export function rangeWhere(range?: ChatEventRange) {
  const parts = [];
  if (range?.from) parts.push(gte(chatEvents.createdAt, range.from));
  if (range?.to) parts.push(lte(chatEvents.createdAt, range.to));
  return parts.length ? and(...parts) : undefined;
}

/** UTC-midnight start of the trailing `days` window (inclusive), matching the daily rollups. */
export function sinceStartUtc(days: number): Date {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - (Math.max(days, 1) - 1));
  return since;
}

export function toChatEvent(row: typeof chatEvents.$inferSelect): ChatEvent {
  return {
    id: toSafeDatabaseId(row.id, 'chat_events.id'),
    turnId: row.turnId,
    userId: row.userId,
    query: row.query,
    mode: row.mode as ChatEvent['mode'],
    retrieveMs: row.retrieveMs,
    generateMs: row.generateMs,
    totalMs: row.totalMs,
    hitCount: row.hitCount,
    maxSimilarity: row.maxSimilarity,
    outOfDomain: row.outOfDomain,
    hallucinationBlocked: row.hallucinationBlocked,
    cacheHit: row.cacheHit,
    ticketCreated: row.ticketCreated,
    citationCount: row.citationCount,
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    meta: (row.meta ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt,
  };
}

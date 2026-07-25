import { createChatEventsRepo } from '@app/infrastructure/db';

export function parsePurgeArgs(argv: string[]): { days: number } {
  let days = 90;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--days=')) days = Number(a.slice('--days='.length));
    else if (a === '--days') days = Number(argv[++i]);
  }
  if (!Number.isFinite(days) || days < 0) days = 90;
  return { days };
}

export async function runPurgeChatEvents({ days }: { days: number }): Promise<{ deletedCount: number }> {
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const result = await createChatEventsRepo().purgeOlderThan(cutoff);
  console.log(`Purged ${result.deletedCount} chat_events older than ${days} days (before ${cutoff.toISOString()}).`);
  return result;
}

import { createChatEventsRepo, db, sql } from '@app/infrastructure/db';
import { askYesNo, makeRl } from '../prompts/index';

export interface PurgeParseResult {
  days: number;
  yes: boolean;
  dryRun: boolean;
  allowSubDay: boolean;
}

function parseDaysValue(value: string | undefined): number {
  if (value === undefined || value === '' || value.startsWith('--')) {
    throw new Error('Missing value for --days');
  }
  const days = Number(value);
  if (!Number.isFinite(days)) {
    throw new Error(`Invalid --days value: ${value}`);
  }
  return days;
}

export function parsePurgeArgs(argv: string[]): PurgeParseResult {
  let days = 90;
  let yes = false;
  let dryRun = false;
  let allowSubDay = false;

  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i]!;
    if (argument.startsWith('--days=')) {
      days = parseDaysValue(argument.slice('--days='.length));
    } else if (argument === '--days') {
      days = parseDaysValue(argv[++i]);
    } else if (argument === '--yes' || argument === '-y') {
      yes = true;
    } else if (argument === '--dry-run') {
      dryRun = true;
    } else if (argument === '--allow-sub-day' || argument === '--force') {
      allowSubDay = true;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  return { days, yes, dryRun, allowSubDay };
}

export interface PurgeOptions {
  days: number;
  yes?: boolean;
  dryRun?: boolean;
  allowSubDay?: boolean;
  confirmFn?: () => Promise<boolean>;
}

export async function runPurgeChatEvents({
  days,
  yes = false,
  dryRun = false,
  allowSubDay = false,
  confirmFn,
}: PurgeOptions): Promise<{ deletedCount: number; dryRun?: boolean; cancelled?: boolean }> {
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(`Invalid --days value: must be a number greater than 0 (got ${days}).`);
  }
  if (days < 1 && !allowSubDay) {
    throw new Error(`Purge retention window must be >= 1 day (got ${days}). Pass --allow-sub-day or --force to override.`);
  }

  const cutoff = new Date(Date.now() - days * 86_400_000);
  const repo = createChatEventsRepo();

  if (dryRun) {
    const res = await db.execute(sql`
      SELECT count(*)::int AS count FROM chat_events WHERE created_at <= ${cutoff}
    `);
    const rows = (res as unknown as { rows: Array<{ count: number }> }).rows ?? [];
    const count = Number(rows[0]?.count ?? 0);
    console.log(`[dry-run] Would purge ${count} chat_events older than ${days} days (before ${cutoff.toISOString()}).`);
    return { deletedCount: count, dryRun: true };
  }

  if (!yes) {
    let confirmed = false;
    if (confirmFn) {
      confirmed = await confirmFn();
    } else {
      if (!process.stdin.isTTY) {
        throw new Error(
          'Refusing to purge chat_events without confirmation. Pass --yes to proceed in non-interactive mode.',
        );
      }
      const rl = makeRl();
      confirmed = await askYesNo(
        rl,
        `Are you sure you want to purge chat_events older than ${days} days (before ${cutoff.toISOString()})?`,
        false,
      );
      rl.close();
    }

    if (!confirmed) {
      console.log('Purge cancelled.');
      return { deletedCount: 0, cancelled: true };
    }
  }

  const result = await repo.purgeOlderThan(cutoff);
  await repo.refreshDailyStats();
  console.log(`Purged ${result.deletedCount} chat_events older than ${days} days (before ${cutoff.toISOString()}) and refreshed daily stats.`);
  return { deletedCount: result.deletedCount, dryRun: false };
}

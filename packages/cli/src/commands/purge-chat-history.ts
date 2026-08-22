import { appConfigSchema } from '@app/domain';
import { createChatHistoryRepo, createAuditRepo, createSettingsRepo, db, sql } from '@app/infrastructure/db';
import { askYesNo, makeRl } from '../prompts/index';

export interface PurgeHistoryParseResult {
  days: number | null;
  yes: boolean;
  dryRun: boolean;
  allowSubDay: boolean;
}

export function parsePurgeHistoryArgs(argv: string[]): PurgeHistoryParseResult {
  let days: number | null = null;
  let yes = false;
  let dryRun = false;
  let allowSubDay = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--days=')) {
      days = Number(a.slice('--days='.length));
    } else if (a === '--days') {
      days = Number(argv[++i]);
    } else if (a === '--yes' || a === '-y') {
      yes = true;
    } else if (a === '--dry-run') {
      dryRun = true;
    } else if (a === '--allow-sub-day' || a === '--force') {
      allowSubDay = true;
    } else {
      throw new Error(`Unknown option: ${a}`);
    }
  }

  return { days, yes, dryRun, allowSubDay };
}

export interface PurgeHistoryOptions {
  days: number | null;
  yes?: boolean;
  dryRun?: boolean;
  allowSubDay?: boolean;
  confirmFn?: () => Promise<boolean>;
  actorId?: string;
}

export async function runPurgeChatHistory({
  days,
  yes = false,
  dryRun = false,
  allowSubDay = false,
  confirmFn,
  actorId = 'cli',
}: PurgeHistoryOptions): Promise<{
  deletedConversations: number;
  deletedMessages: number;
  resolvedDays: number;
  dryRun?: boolean;
  cancelled?: boolean;
}> {
  let resolvedDays = days;
  if (resolvedDays === null) {
    const overrides = await createSettingsRepo().getOverrides();
    const cfg = appConfigSchema.parse(overrides.overrides ?? {});
    if (cfg.chatHistoryRetentionDays === 0) {
      throw new Error(
        'The chat-history auto-delete window is Off (0). Pass --days=N explicitly to run a one-off purge.',
      );
    }
    resolvedDays = cfg.chatHistoryRetentionDays;
  }

  if (!Number.isFinite(resolvedDays) || resolvedDays <= 0) {
    throw new Error(`Invalid --days value: must be a number greater than 0 (got ${resolvedDays}).`);
  }
  if (resolvedDays < 1 && !allowSubDay) {
    throw new Error(`Purge retention window must be >= 1 day (got ${resolvedDays}). Pass --allow-sub-day or --force to override.`);
  }

  const cutoff = new Date(Date.now() - resolvedDays * 86_400_000);
  const repo = createChatHistoryRepo();

  if (dryRun) {
    const res = await db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM chat_conversations WHERE updated_at <= ${cutoff}) AS conversations,
        (SELECT count(*)::int FROM chat_messages m JOIN chat_conversations c ON c.id = m.conversation_id WHERE c.updated_at <= ${cutoff}) AS messages
    `);
    const rows = (res as unknown as { rows: Array<{ conversations: number; messages: number }> }).rows ?? [];
    const row = rows[0];
    console.log(
      `[dry-run] Would purge ${Number(row?.conversations ?? 0)} conversations and ${Number(row?.messages ?? 0)} messages older than ${resolvedDays} days (before ${cutoff.toISOString()}).`,
    );
    return {
      deletedConversations: Number(row?.conversations ?? 0),
      deletedMessages: Number(row?.messages ?? 0),
      resolvedDays,
      dryRun: true,
    };
  }

  if (!yes) {
    let confirmed = false;
    if (confirmFn) {
      confirmed = await confirmFn();
    } else {
      if (!process.stdin.isTTY) {
        throw new Error(
          'Refusing to purge chat history without confirmation. Pass --yes to proceed in non-interactive mode.',
        );
      }
      const rl = makeRl();
      confirmed = await askYesNo(
        rl,
        `Are you sure you want to purge saved chats not active for ${resolvedDays} days (before ${cutoff.toISOString()})?`,
        false,
      );
      rl.close();
    }

    if (!confirmed) {
      console.log('Purge cancelled.');
      return { deletedConversations: 0, deletedMessages: 0, resolvedDays, cancelled: true };
    }
  }

  const result = await repo.purgeOlderThan(cutoff);
  const audit = createAuditRepo(db);
  const auditEvent = {
    kind: 'chat' as const,
    action: 'history_purged',
    actorId,
    targetType: 'chat_history',
    details: {
      days: resolvedDays,
      cutoff: cutoff.toISOString(),
      deletedConversations: result.deletedConversations,
      deletedMessages: result.deletedMessages,
    },
  };
  try {
    await audit.logEvent(auditEvent);
  } catch (auditError) {
    const message = auditError instanceof Error ? auditError.message : String(auditError);
    try {
      await audit.recordDeadLetter({ kind: 'chat', payload: auditEvent, error: message });
      console.warn(`[audit] failed to record history_purged event; saved a dead-letter entry instead (${message}).`);
    } catch {
      throw new Error(
        'Chat history was purged but no durable audit record could be written (logEvent and dead-letter both failed).',
      );
    }
  }

  console.log(
    `Purged ${result.deletedConversations} conversations (${result.deletedMessages} messages) last active before ${cutoff.toISOString()}.`,
  );
  return {
    deletedConversations: result.deletedConversations,
    deletedMessages: result.deletedMessages,
    resolvedDays,
    dryRun: false,
  };
}

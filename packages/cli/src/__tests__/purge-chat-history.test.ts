import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parsePurgeHistoryArgs, runPurgeChatHistory } from '../commands/purge-chat-history';

const purgeOlderThan = vi.fn().mockResolvedValue({ deletedConversations: 3, deletedMessages: 6 });
const getOverrides = vi.fn().mockResolvedValue({ overrides: {}, version: 0 });
const logEvent = vi.fn().mockResolvedValue(undefined);

vi.mock('@app/infrastructure/db', () => ({
  db: {
    execute: vi.fn().mockResolvedValue({ rows: [{ conversations: 5, messages: 11 }] }),
  },
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings.join('?'), values }),
    { raw: (s: string) => s },
  ),
  chatConversations: { updatedAt: 'updated_at', id: 'id' },
  createChatHistoryRepo: vi.fn().mockReturnValue({
    purgeOlderThan,
  }),
  createSettingsRepo: vi.fn().mockReturnValue({
    getOverrides,
  }),
  createAuditRepo: vi.fn().mockReturnValue({
    logEvent,
    recordDeadLetter: vi.fn().mockResolvedValue(undefined),
  }),
}));

describe('parsePurgeHistoryArgs', () => {
  it('parses --days, --yes, --dry-run, --allow-sub-day', () => {
    const res = parsePurgeHistoryArgs(['--days=30', '--yes', '--dry-run']);
    expect(res).toEqual({ days: 30, yes: true, dryRun: true, allowSubDay: false });
  });

  it('leaves days null when the flag is absent (use configured window)', () => {
    const res = parsePurgeHistoryArgs(['-y', '--force']);
    expect(res).toEqual({ days: null, yes: true, dryRun: false, allowSubDay: true });
  });
});

describe('runPurgeChatHistory', () => {
  beforeEach(() => {
    purgeOlderThan.mockClear();
    logEvent.mockClear();
    getOverrides.mockClear();
    getOverrides.mockResolvedValue({ overrides: {}, version: 0 });
  });

  it('resolves days from the configured window when --days is omitted', async () => {
    getOverrides.mockResolvedValue({ overrides: { chatHistoryRetentionDays: 30 }, version: 1 });
    const res = await runPurgeChatHistory({ days: null, yes: true });
    expect(res.resolvedDays).toBe(30);
    expect(res.deletedConversations).toBe(3);
    expect(logEvent).toHaveBeenCalledTimes(1);
    const event = logEvent.mock.calls[0]![0] as Record<string, unknown>;
    expect(event.kind).toBe('chat');
    expect(event.action).toBe('history_purged');
    expect((event.details as Record<string, unknown>).deletedMessages).toBe(6);
  });

  it('refuses to run while the window is Off unless --days is explicit', async () => {
    getOverrides.mockResolvedValue({ overrides: { chatHistoryRetentionDays: 0 }, version: 1 });
    await expect(runPurgeChatHistory({ days: null, yes: true })).rejects.toThrow(/Off/);
    const res = await runPurgeChatHistory({ days: 7, yes: true });
    expect(res.resolvedDays).toBe(7);
  });

  it('defaults to 120 days when no override is stored', async () => {
    const res = await runPurgeChatHistory({ days: null, yes: true });
    expect(res.resolvedDays).toBe(120);
  });

  it('rejects days < 1 unless allowSubDay is set', async () => {
    await expect(runPurgeChatHistory({ days: 0 })).rejects.toThrow(/must be >= 1 day/);
    const res = await runPurgeChatHistory({ days: 0, allowSubDay: true, yes: true });
    expect(res.deletedConversations).toBe(3);
  });

  it('runs dry-run without purging or confirmation', async () => {
    const res = await runPurgeChatHistory({ days: 30, dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(res.deletedConversations).toBe(5);
    expect(res.deletedMessages).toBe(11);
    expect(purgeOlderThan).not.toHaveBeenCalled();
  });

  it('handles cancelled confirmation when yes is false', async () => {
    const res = await runPurgeChatHistory({ days: 30, confirmFn: async () => false });
    expect(res.cancelled).toBe(true);
    expect(purgeOlderThan).not.toHaveBeenCalled();
  });

  it('requires --yes when running non-interactively', async () => {
    const prev = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      await expect(runPurgeChatHistory({ days: 30 })).rejects.toThrow(/--yes/);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: prev, configurable: true });
    }
  });
});

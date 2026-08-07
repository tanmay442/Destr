import { describe, it, expect, vi } from 'vitest';
import { parsePurgeArgs, runPurgeChatEvents } from '../commands/purge-chat-events';

vi.mock('@app/infrastructure/db', () => ({
  db: {
    execute: vi.fn().mockResolvedValue({ rows: [{ count: 42 }] }),
  },
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings.join('?'), values }),
    { raw: (s: string) => s },
  ),
  chatEvents: {
    createdAt: 'created_at',
  },
  createChatEventsRepo: vi.fn().mockReturnValue({
    purgeOlderThan: vi.fn().mockResolvedValue({ deletedCount: 15 }),
    refreshDailyStats: vi.fn().mockResolvedValue(undefined),
  }),
}));

describe('parsePurgeArgs', () => {
  it('parses --days, --yes, --dry-run, --allow-sub-day', () => {
    const res = parsePurgeArgs(['--days=30', '--yes', '--dry-run']);
    expect(res).toEqual({
      days: 30,
      yes: true,
      dryRun: true,
      allowSubDay: false,
    });
  });

  it('handles positional and alias flags', () => {
    const res = parsePurgeArgs(['--days', '0', '-y', '--force']);
    expect(res).toEqual({
      days: 0,
      yes: true,
      dryRun: false,
      allowSubDay: true,
    });
  });
});

describe('runPurgeChatEvents', () => {
  it('rejects days < 1 unless allowSubDay is set', async () => {
    await expect(runPurgeChatEvents({ days: 0 })).rejects.toThrow(/must be >= 1 day/);
    const res = await runPurgeChatEvents({ days: 0, allowSubDay: true, yes: true });
    expect(res.deletedCount).toBe(15);
  });

  it('runs dry-run without purging or confirmation', async () => {
    const res = await runPurgeChatEvents({ days: 30, dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(res.deletedCount).toBe(42);
  });

  it('handles cancelled confirmation when yes is false', async () => {
    const res = await runPurgeChatEvents({
      days: 30,
      yes: false,
      confirmFn: async () => false,
    });
    expect(res.cancelled).toBe(true);
    expect(res.deletedCount).toBe(0);
  });

  it('executes purge and refreshes matview when confirmed', async () => {
    const res = await runPurgeChatEvents({
      days: 30,
      yes: true,
    });
    expect(res.deletedCount).toBe(15);
    expect(res.dryRun).toBe(false);
  });

  it('requires --yes when running non-interactively', async () => {
    const prev = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      await expect(runPurgeChatEvents({ days: 30 })).rejects.toThrow(/--yes/);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: prev, configurable: true });
    }
  });
});

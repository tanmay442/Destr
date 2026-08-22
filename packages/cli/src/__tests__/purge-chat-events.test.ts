import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parsePurgeArgs, runPurgeChatEvents } from '../commands/purge-chat-events';

const { purgeOlderThan } = vi.hoisted(() => ({
  purgeOlderThan: vi.fn().mockResolvedValue({ deletedCount: 15 }),
}));

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
    purgeOlderThan,
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
  beforeEach(() => {
    purgeOlderThan.mockClear();
    purgeOlderThan.mockResolvedValue({ deletedCount: 15 });
  });

  it('rejects days < 1 unless allowSubDay is set (and only for 0 < days < 1)', async () => {
    await expect(runPurgeChatEvents({ days: 0 })).rejects.toThrow(/greater than 0/);
    await expect(runPurgeChatEvents({ days: 0.5 })).rejects.toThrow(/must be >= 1 day/);
    await expect(runPurgeChatEvents({ days: 0, allowSubDay: true, yes: true })).rejects.toThrow(/greater than 0/);
    expect(purgeOlderThan).not.toHaveBeenCalled();
    const res = await runPurgeChatEvents({ days: 0.5, allowSubDay: true, yes: true });
    expect(res.deletedCount).toBe(15);
  });

  it('rejects negative days unconditionally, before any purge or confirmation', async () => {
    await expect(runPurgeChatEvents({ days: -5 })).rejects.toThrow(/greater than 0/);
    await expect(runPurgeChatEvents({ days: -5, allowSubDay: true, yes: true })).rejects.toThrow(/greater than 0/);
    const confirm = vi.fn(async () => true);
    await expect(runPurgeChatEvents({ days: -5, allowSubDay: true, confirmFn: confirm })).rejects.toThrow(
      /greater than 0/,
    );
    expect(purgeOlderThan).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('rejects non-numeric days values', async () => {
    await expect(runPurgeChatEvents({ days: Number.NaN, yes: true })).rejects.toThrow(/greater than 0/);
    expect(purgeOlderThan).not.toHaveBeenCalled();
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

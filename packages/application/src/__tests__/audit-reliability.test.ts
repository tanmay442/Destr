import { describe, it, expect, vi } from 'vitest';
import { safeAudit } from '../audit-reliability';

describe('safeAudit', () => {
  it('awaits and returns on a successful write', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const recordDeadLetter = vi.fn().mockResolvedValue(undefined);
    await safeAudit(write, recordDeadLetter, { a: 1 }, 'ticket');
    expect(write).toHaveBeenCalledOnce();
    expect(recordDeadLetter).not.toHaveBeenCalled();
  });

  it('records a dead-letter (never throws) when the write fails', async () => {
    const write = vi.fn().mockRejectedValue(new Error('db down'));
    const recordDeadLetter = vi.fn().mockResolvedValue(undefined);
    const payload = { ticketId: 'TKT-1' };
    await expect(
      safeAudit(write, recordDeadLetter, payload, 'ticket'),
    ).resolves.toBeUndefined();
    expect(recordDeadLetter).toHaveBeenCalledWith(payload, 'db down');
  });

  it('swallows a dead-letter failure so the request is never blocked', async () => {
    const write = vi.fn().mockRejectedValue(new Error('db down'));
    const recordDeadLetter = vi.fn().mockRejectedValue(new Error('dlq down'));
    await expect(
      safeAudit(write, recordDeadLetter, { x: 1 }, 'user'),
    ).resolves.toBeUndefined();
    expect(recordDeadLetter).toHaveBeenCalledOnce();
  });
});

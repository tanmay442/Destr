import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { purgeEventsMock, purgeHistoryMock, runtimeConfigMock } = vi.hoisted(() => ({
  purgeEventsMock: vi.fn(),
  purgeHistoryMock: vi.fn(),
  runtimeConfigMock: vi.fn(),
}));

vi.mock('@/composition', () => ({
  getComposition: () => ({
    chatEventBatcher: { purgeOlderThan: purgeEventsMock },
    chatHistoryRepo: { purgeOlderThan: purgeHistoryMock },
  }),
}));

vi.mock('@/lib/config/runtime', () => ({
  getRuntimeConfig: runtimeConfigMock,
}));

import { GET } from './route';

const oldCronSecret = process.env.CRON_SECRET;
const oldEventRetention = process.env.CHAT_EVENT_RETENTION_DAYS;
const oldEventsRetention = process.env.CHAT_EVENTS_RETENTION_DAYS;

function request(secret?: string): Request {
  return new Request('http://localhost/api/admin/purge/cron', {
    ...(secret === undefined ? {} : { headers: { authorization: `Bearer ${secret}` } }),
  });
}

beforeEach(() => {
  process.env.CRON_SECRET = 'cron-secret';
  delete process.env.CHAT_EVENT_RETENTION_DAYS;
  delete process.env.CHAT_EVENTS_RETENTION_DAYS;
  purgeEventsMock.mockReset().mockResolvedValue({ deletedCount: 7 });
  purgeHistoryMock.mockReset().mockResolvedValue({ deletedConversations: 3, deletedMessages: 9 });
  runtimeConfigMock.mockReset().mockResolvedValue({ chatHistoryRetentionDays: 120 });
});

afterEach(() => {
  if (oldCronSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = oldCronSecret;
  if (oldEventRetention === undefined) delete process.env.CHAT_EVENT_RETENTION_DAYS;
  else process.env.CHAT_EVENT_RETENTION_DAYS = oldEventRetention;
  if (oldEventsRetention === undefined) delete process.env.CHAT_EVENTS_RETENTION_DAYS;
  else process.env.CHAT_EVENTS_RETENTION_DAYS = oldEventsRetention;
});

describe('GET /api/admin/purge/cron', () => {
  it('rejects a missing or invalid cron secret before loading dependencies', async () => {
    expect((await GET(request())).status).toBe(401);
    expect((await GET(request('wrong'))).status).toBe(401);
    expect(runtimeConfigMock).not.toHaveBeenCalled();
    expect(purgeEventsMock).not.toHaveBeenCalled();
  });

  it('purges chat events and history using their retention periods', async () => {
    process.env.CHAT_EVENT_RETENTION_DAYS = '45';

    const response = await GET(request('cron-secret'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      chatHistory: { retentionDays: 120, deletedConversations: 3, deletedMessages: 9 },
      chatEvents: { retentionDays: 45, deletedCount: 7 },
    });
    expect(purgeEventsMock).toHaveBeenCalledOnce();
    expect(purgeHistoryMock).toHaveBeenCalledOnce();
    expect(purgeEventsMock.mock.calls[0]?.[0]).toBeInstanceOf(Date);
    expect(purgeHistoryMock.mock.calls[0]?.[0]).toBeInstanceOf(Date);
  });

  it('keeps chat history when retention is disabled', async () => {
    runtimeConfigMock.mockResolvedValue({ chatHistoryRetentionDays: 0 });

    const response = await GET(request('cron-secret'));

    expect(response.status).toBe(200);
    expect(purgeHistoryMock).not.toHaveBeenCalled();
    expect((await response.json()).chatHistory).toEqual({
      retentionDays: 0,
      deletedConversations: 0,
      deletedMessages: 0,
    });
  });

  it('returns 503 when a purge fails', async () => {
    purgeEventsMock.mockRejectedValue(new Error('database unavailable'));

    const response = await GET(request('cron-secret'));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'Internal error',
      code: 'internal_error',
    });
  });
});

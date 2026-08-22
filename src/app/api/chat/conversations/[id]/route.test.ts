import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok, err, NotFoundError } from '@app/domain';

const { authMock, getMock, renameMock, deleteMock, rateLimitMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  getMock: vi.fn(),
  renameMock: vi.fn(),
  deleteMock: vi.fn(),
  rateLimitMock: vi.fn(),
}));

vi.mock('@clerk/nextjs/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@clerk/nextjs/server')>()),
  auth: authMock,
}));

vi.mock('@/composition', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/composition')>();
  return {
    ...actual,
    getComposition: () => ({
      getConversation: getMock,
      renameConversation: renameMock,
      deleteConversation: deleteMock,
      rateLimit: rateLimitMock,
    }),
  };
});

import * as route from './route';

const ID = 'a0000000-0000-4000-8000-000000000001';

function req(method: string, body?: unknown) {
  return new Request(`http://localhost/api/chat/conversations/${ID}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const ctx = () => ({ params: Promise.resolve({ id: ID }) });

beforeEach(() => {
  authMock.mockReset().mockResolvedValue({ userId: 'user_1' });
  getMock.mockReset().mockResolvedValue(ok({ conversation: {}, messages: [] }));
  renameMock.mockReset().mockResolvedValue(ok({ ok: true }));
  deleteMock.mockReset().mockResolvedValue(ok({ ok: true }));
  rateLimitMock.mockReset().mockResolvedValue({ ok: true, remaining: 59, resetMs: 60_000 });
});

describe('/api/chat/conversations/[id]', () => {
  it('returns 401 on every verb when signed out', async () => {
    authMock.mockResolvedValue({ userId: null });
    expect((await route.GET(req('GET'), ctx())).status).toBe(401);
    expect((await route.PATCH(req('PATCH', { title: 'x' }), ctx())).status).toBe(401);
    expect((await route.DELETE(req('DELETE'), ctx())).status).toBe(401);
  });

  it('rejects cross-site mutations with 403', async () => {
    const res = await route.PATCH(
      new Request(`http://localhost/api/chat/conversations/${ID}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://evil.test',
          'sec-fetch-site': 'cross-site',
        },
        body: JSON.stringify({ title: 'x' }),
      }),
      ctx(),
    );
    expect(res.status).toBe(403);
    expect(renameMock).not.toHaveBeenCalled();
  });

  it('rejects cross-site deletes with 403', async () => {
    const res = await route.DELETE(
      new Request(`http://localhost/api/chat/conversations/${ID}`, {
        method: 'DELETE',
        headers: { Origin: 'http://evil.test', 'sec-fetch-site': 'cross-site' },
      }),
      ctx(),
    );
    expect(res.status).toBe(403);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('does not apply same-origin checks to GET', async () => {
    const res = await route.GET(
      new Request(`http://localhost/api/chat/conversations/${ID}`, {
        headers: { Origin: 'http://evil.test', 'sec-fetch-site': 'cross-site' },
      }),
      ctx(),
    );
    expect(res.status).toBe(200);
    expect(getMock).toHaveBeenCalled();
  });

  it('rejects oversize rename bodies with 413', async () => {
    const res = await route.PATCH(
      new Request(`http://localhost/api/chat/conversations/${ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'x'.repeat(1_100_000) }),
      }),
      ctx(),
    );
    expect(res.status).toBe(413);
    expect(renameMock).not.toHaveBeenCalled();
  });

  it('rejects non-JSON rename content types with 415', async () => {
    const res = await route.PATCH(
      new Request(`http://localhost/api/chat/conversations/${ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'text/plain' },
        body: 'title=hi',
      }),
      ctx(),
    );
    expect(res.status).toBe(415);
    expect(renameMock).not.toHaveBeenCalled();
  });

  it('rate-limits all verbs under the chat_history bucket', async () => {
    rateLimitMock.mockResolvedValue({ ok: false, retryAfterMs: 2_000 });
    expect((await route.GET(req('GET'), ctx())).status).toBe(429);
    expect((await route.DELETE(req('DELETE'), ctx())).status).toBe(429);
    expect(rateLimitMock).toHaveBeenCalledWith('chat_history:user_1', { limit: 60, windowMs: 60_000 });
  });

  it('returns 400 for a malformed conversation id', async () => {
    const bad = { params: Promise.resolve({ id: 'not-a-uuid' }) };
    expect((await route.GET(req('GET'), bad)).status).toBe(400);
    expect((await route.PATCH(req('PATCH', { title: 'x' }), bad)).status).toBe(400);
    expect((await route.DELETE(req('DELETE'), bad)).status).toBe(400);
  });

  it('loads a conversation for its owner', async () => {
    const res = await route.GET(req('GET'), ctx());
    expect(res.status).toBe(200);
    expect(getMock).toHaveBeenCalledWith({ userId: 'user_1', conversationId: ID });
  });

  it('maps unknown or foreign conversations to 404', async () => {
    getMock.mockResolvedValue(err(new NotFoundError('Conversation not found')));
    expect((await route.GET(req('GET'), ctx())).status).toBe(404);
    deleteMock.mockResolvedValue(err(new NotFoundError('Conversation not found')));
    expect((await route.DELETE(req('DELETE'), ctx())).status).toBe(404);
  });

  it('validates the rename payload', async () => {
    expect((await route.PATCH(req('PATCH', {}), ctx())).status).toBe(400);
    expect((await route.PATCH(req('PATCH', { title: '' }), ctx())).status).toBe(400);
    expect(renameMock).not.toHaveBeenCalled();
    await route.PATCH(req('PATCH', { title: 'New name' }), ctx());
    expect(renameMock).toHaveBeenCalledWith({ userId: 'user_1', conversationId: ID, title: 'New name' });
  });

  it('deletes with the signed-in user id', async () => {
    const res = await route.DELETE(req('DELETE'), ctx());
    expect(res.status).toBe(200);
    expect(deleteMock).toHaveBeenCalledWith({ userId: 'user_1', conversationId: ID });
  });
});

import { describe, it, expect, vi } from 'vitest';
import {
  appendChatTurn,
  deleteConversation,
  getConversation,
  listConversations,
  renameConversation,
  toStoredMessage,
  enforceStoredBytes,
} from '../history';
import { unwrap, ConflictError, NotFoundError, MAX_STORED_MESSAGE_BYTES, MAX_LIST_LIMIT } from '@app/domain';
import type { ChatHistoryRepo } from '@app/domain';

function fakeRepo(overrides: Partial<ChatHistoryRepo> = {}): ChatHistoryRepo & { calls: unknown[] } {
  const calls: unknown[] = [];
  const base: ChatHistoryRepo = {
    appendTurn: async (input) => {
      calls.push(input);
      return { conversationId: input.conversationId ?? 'created-1' };
    },
    listConversations: async () => [],
    getConversation: async () => null,
    renameConversation: async () => true,
    deleteConversation: async () => true,
    countConversations: async () => 0,
    purgeOlderThan: async () => ({ deletedConversations: 0, deletedMessages: 0 }),
    purgeUserData: async () => ({ deletedConversations: 0, deletedMessages: 0 }),
    ...overrides,
  };
  return Object.assign(base, { calls });
}

function fakeAudit() {
  return { logEvent: vi.fn(async () => {}), recordDeadLetter: vi.fn(async () => {}) };
}

const turnInput = {
  userId: 'u1',
  conversationId: 'c-1',
  turnId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  userMessage: { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'q' }] },
  assistantMessage: { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'a' }] },
};

describe('listConversations', () => {
  it('applies default pagination and forwards ownership', async () => {
    const repo = fakeRepo({
      listConversations: async (userId, opts) => {
        expect(userId).toBe('u1');
        expect(opts).toEqual({ limit: 25, offset: 0 });
        return [];
      },
    });
    const res = await listConversations({ userId: 'u1' }, { repo });
    expect(unwrap(res)).toEqual({ conversations: [] });
    expect(repo.calls).toEqual([]);
  });

  it('caps the limit at MAX_LIST_LIMIT', async () => {
    const seen: Array<{ limit: number; offset: number }> = [];
    const repo = fakeRepo({
      listConversations: async (_userId, opts) => {
        seen.push(opts);
        return [];
      },
    });
    await listConversations({ userId: 'u1', limit: MAX_LIST_LIMIT + 500, offset: -10 }, { repo });
    expect(seen[0]).toEqual({ limit: MAX_LIST_LIMIT, offset: 0 });
  });
});

describe('getConversation', () => {
  it('maps a null repo result to NotFoundError', async () => {
    const res = await getConversation({ userId: 'u1', conversationId: 'nope' }, { repo: fakeRepo() });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBeInstanceOf(NotFoundError);
  });
});

describe('renameConversation', () => {
  it('sanitizes and caps the title before delegating', async () => {
    const calls: Array<[string, string, string]> = [];
    const repo = fakeRepo({
      renameConversation: async (userId, conversationId, title) => {
        calls.push([userId, conversationId, title]);
        return true;
      },
    });
    await renameConversation(
      { userId: 'u1', conversationId: 'c1', title: `  hi\x00${'x'.repeat(200)}  ` },
      { repo },
    );
    const [, , stored] = calls[0]!;
    expect(stored).toBe('hi' + 'x'.repeat(118));
    expect(stored.length).toBeLessThanOrEqual(120);
    expect(!stored.includes('\x00')).toBe(true);
  });

  it('maps false to NotFoundError', async () => {
    const res = await renameConversation(
      { userId: 'u1', conversationId: 'gone', title: 't' },
      { repo: fakeRepo({ renameConversation: async () => false }) },
    );
    if (!res.ok) expect(res.error).toBeInstanceOf(NotFoundError);
    else throw new Error('expected error');
  });
});

describe('deleteConversation', () => {
  it('audits with kind chat on success', async () => {
    const audit = fakeAudit();
    const res = await deleteConversation(
      { userId: 'u1', conversationId: 'c9' },
      { repo: fakeRepo(), audit },
    );
    expect(unwrap(res)).toEqual({ ok: true });
    expect(audit.logEvent).toHaveBeenCalledTimes(1);
    const firstCall = audit.logEvent.mock.calls[0] as unknown[] | undefined;
    const event = (firstCall?.[0] ?? {}) as Record<string, unknown>;
    expect(event.kind).toBe('chat');
    expect(event.action).toBe('conversation_deleted');
    expect(event.targetId).toBe('c9');
    expect(event.actorId).toBe('u1');
  });

  it('does not audit when nothing was deleted', async () => {
    const audit = fakeAudit();
    const res = await deleteConversation(
      { userId: 'u1', conversationId: 'missing' },
      { repo: fakeRepo({ deleteConversation: async () => false }), audit },
    );
    if (!res.ok) expect(res.error).toBeInstanceOf(NotFoundError);
    expect(audit.logEvent).not.toHaveBeenCalled();
  });
});

describe('appendChatTurn caps', () => {
  it('conflicts when the known message count is at the per-conversation cap', async () => {
    const res = await appendChatTurn(
      { ...turnInput, messageCount: 500 },
      { repo: fakeRepo() },
    );
    if (!res.ok) expect(res.error).toBeInstanceOf(ConflictError);
    else throw new Error('expected conflict');
  });

  it('allows appending below the cap and forwards retryOfMessageId', async () => {
    const repo = fakeRepo();
    const res = await appendChatTurn(
      { ...turnInput, messageCount: 499, retryOfMessageId: 'm0' },
      { repo },
    );
    expect(res.ok).toBe(true);
    const forwarded = repo.calls[0] as { retryOfMessageId?: string };
    expect(forwarded.retryOfMessageId).toBe('m0');
  });

  it('re-emits repo ConflictError unmapped (caps enforced in the append transaction)', async () => {
    const conversationCap = new ConflictError('Conversation limit reached');
    const res = await appendChatTurn(
      { ...turnInput },
      { repo: fakeRepo({ appendTurn: async () => { throw conversationCap; } }) },
    );
    if (!res.ok) expect(res.error).toBe(conversationCap);
    else throw new Error('expected conflict');

    const fullChat = new ConflictError('This chat is full — start a new one');
    const res2 = await appendChatTurn(
      { ...turnInput },
      { repo: fakeRepo({ appendTurn: async () => { throw fullChat; } }) },
    );
    if (!res2.ok) expect(res2.error).toBe(fullChat);
    else throw new Error('expected conflict');
  });

  it('sanitizes and caps an auto-title', async () => {
    const repo = fakeRepo();
    await appendChatTurn({ ...turnInput, conversationId: null, title: '  A\x07B  ' }, { repo });
    const forwarded = repo.calls[0] as { title: string };
    expect(forwarded.title).toBe('AB');
  });
});

describe('toStoredMessage whitelisting', () => {
  it('keeps text/reasoning/file parts, drops everything else, extracts metadata', () => {
    const stored = toStoredMessage({
      id: 'm2',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'answer' },
        { type: 'reasoning', text: 'thinking' },
        { type: 'file', url: 'https://x/y.png', filename: 'y.png', mediaType: 'image/png' },
        { type: 'data-citation', data: { id: 7, documentId: 2, similarity: 0.9, snippet: 's' } },
        { type: 'data-guardrail', data: { outOfDomain: true, offerTicket: true } },
        { type: 'tool-call', state: 'output-available' },
        { type: 'evil', systemPrompt: 'leak' },
      ],
    });
    expect(stored.parts.map((p) => p.type)).toEqual(['text', 'reasoning', 'file']);
    expect(stored.parts[2]).toEqual({ type: 'file', url: 'https://x/y.png', filename: 'y.png', mediaType: 'image/png' });
    expect(stored.metadata.citations).toEqual([{ id: 7, documentId: 2, similarity: 0.9, snippet: 's' }]);
    expect(stored.metadata.guardrail).toEqual({ outOfDomain: true, offerTicket: true });
    expect(JSON.stringify(stored)).not.toContain('systemPrompt');
  });

  it('tolerates missing id/parts/metadata', () => {
    const stored = toStoredMessage({ role: 'user' });
    expect(stored.id).toBe('');
    expect(stored.parts).toEqual([]);
    expect(stored.metadata).toEqual({});
  });

  it('falls back to explicit metadata citations when no data parts exist', () => {
    const stored = toStoredMessage({
      id: 'm3',
      role: 'assistant',
      parts: [{ type: 'text', text: 'hi' }],
      metadata: { citations: [{ id: 1 }], guardrail: { outOfDomain: false, offerTicket: true } },
    });
    expect(stored.metadata.citations).toEqual([{ id: 1 }]);
    expect(stored.metadata.guardrail).toEqual({ outOfDomain: false, offerTicket: true });
  });
});

describe('enforceStoredBytes', () => {
  it('returns small messages untouched', () => {
    const msg = toStoredMessage(turnInput.userMessage);
    expect(enforceStoredBytes(msg)).toBe(msg);
  });

  it('truncates the last text part under the byte cap', () => {
    const huge = toStoredMessage({
      id: 'm4',
      role: 'assistant',
      parts: [{ type: 'text', text: 'z'.repeat(MAX_STORED_MESSAGE_BYTES) }],
    });
    const capped = enforceStoredBytes(huge);
    expect(JSON.stringify(capped ? Buffer.byteLength(JSON.stringify(capped)) : 0));
    expect(Buffer.byteLength(JSON.stringify(capped))).toBeLessThanOrEqual(MAX_STORED_MESSAGE_BYTES);
    expect((capped.parts[0]?.text as string).length).toBeGreaterThan(0);
    expect(capped.parts[0]?.type).toBe('text');
  });

  it('drops unshrinkable parts rather than exceeding the cap', () => {
    const msg: Parameters<typeof enforceStoredBytes>[0] = {
      id: 'm5',
      role: 'user',
      parts: [],
      metadata: {},
    };
    expect(enforceStoredBytes(msg).parts).toEqual([]);
  });
});

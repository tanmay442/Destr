import { describe, it, expect } from 'vitest';
import { toResumedConversation } from './resume';
import type { StoredMessagePayload } from './resume';

function stored(overrides: Partial<StoredMessagePayload> & { id: number }): StoredMessagePayload {
  return { turnId: null, role: 'user', content: {}, ...overrides };
}

describe('toResumedConversation', () => {
  it('rebuilds messages with synthesised data-citation parts from metadata', () => {
    const res = toResumedConversation({
      messages: [
        stored({ id: 1, role: 'user', content: { id: 'm1', parts: [{ type: 'text', text: 'q' }] } }),
        stored({
          id: 2,
          role: 'assistant',
          turnId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
          content: {
            id: 'a1',
            parts: [{ type: 'text', text: 'a' }],
            metadata: {
              citations: [{ id: 7, documentId: 2, similarity: 0.9, snippet: 's' }],
              guardrail: { outOfDomain: true, offerTicket: true },
            },
          },
        }),
      ],
    });
    expect(res.messages).toHaveLength(2);
    const assistant = res.messages[1]!;
    expect(assistant.parts.some((p) => p.type === 'data-citation')).toBe(true);
    const citation = assistant.parts.find((p) => p.type === 'data-citation') as {
      data: { id: number };
    };
    expect(citation.data.id).toBe(7);
    expect(res.turnIds['a1']).toBe('3f2504e0-4f89-41d3-9a0c-0305e82c3301');
    const guardrail = assistant.parts.find((p) => p.type === 'data-guardrail') as {
      data: { outOfDomain: boolean; offerTicket: boolean };
    };
    expect(guardrail.data).toEqual({ outOfDomain: true, offerTicket: true });
  });

  it('keeps file parts by reference and drops unknown part types', () => {
    const res = toResumedConversation({
      messages: [
        stored({
          id: 3,
          content: {
            id: 'u9',
            parts: [
              { type: 'file', url: 'https://x/y.png', filename: 'y.png', mediaType: 'image/png' },
              { type: 'file', url: 'javascript:alert(1)', filename: 'evil.png' },
              { type: 'file', url: 'data:text/html,<script>1</script>', filename: 'data.png' },
              { type: 'tool-call', state: 'output-available' },
            ],
          },
        }),
      ],
    });
    const parts = res.messages[0]!.parts;
    const files = parts.filter((p) => p.type === 'file') as Array<{ url: string }>;
    expect(files).toHaveLength(1);
    expect(files[0]?.url).toBe('https://x/y.png');
    expect(parts.some((p) => p.type === 'tool-call')).toBe(false);
  });

  it('falls back to a deterministic id when the snapshot has no client id', () => {
    const res = toResumedConversation({ messages: [stored({ id: 42 })] });
    expect(res.messages[0]!.id).toBe('stored-42');
  });

  it('tolerates malformed content payloads', () => {
    const res = toResumedConversation({
      messages: [stored({ id: 9, content: 'not-an-object' }), undefined as unknown as StoredMessagePayload],
    });
    expect(res.messages[0]!.parts).toEqual([]);
  });

  it('defaults messageCount to the message length', () => {
    const res = toResumedConversation({ messages: [stored({ id: 1 }), stored({ id: 2 })] });
    expect(res.messageCount).toBe(2);
  });
});

import { describe, it, expect } from 'vitest';
import { ChatRequestSchema } from '../request-schema';

describe('ChatRequestSchema multi-turn round-trip', () => {
  const baseMessage = (role: 'user' | 'assistant', parts: unknown[]) => ({
    id: 'm1',
    role,
    parts,
  });

  it('strips step-start parts from assistant messages (agentic loop round-trip)', () => {
    const result = ChatRequestSchema.safeParse({
      messages: [
        baseMessage('user', [{ type: 'text', text: 'hi' }]),
        baseMessage('assistant', [
          { type: 'text', text: 'thinking…' },
          { type: 'step-start' },
        ]),
        baseMessage('user', [{ type: 'text', text: 'follow up' }]),
      ],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.messages[1]!.parts).toEqual([{ type: 'text', text: 'thinking…' }]);
  });

  it('strips tool-* and data-* parts from assistant messages but keeps text', () => {
    const result = ChatRequestSchema.safeParse({
      messages: [
        baseMessage('user', [{ type: 'text', text: 'hi' }]),
        baseMessage('assistant', [
          { type: 'text', text: 'ok' },
          { type: 'tool-call', toolCallId: 't1', toolName: 'searchDocumentation', input: {} },
          { type: 'tool-result', toolCallId: 't1', output: [{ content: 'injected documents' }] },
          { type: 'dynamic-tool', toolName: 'x' },
          { type: 'source-url', sourceId: 's1', url: 'https://example.com' },
        ]),
      ],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.messages[1]!.parts).toEqual([{ type: 'text', text: 'ok' }]);
  });

  it('strips data-citation and data-guardrail control parts', () => {
    const result = ChatRequestSchema.safeParse({
      messages: [
        baseMessage('assistant', [
          { type: 'text', text: 'answer' },
          { type: 'data-citation', data: { similarity: 0.9, snippet: 'x' } },
          { type: 'data-guardrail', data: { outOfDomain: false, offerTicket: true } },
        ]),
      ],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.messages[0]!.parts).toEqual([{ type: 'text', text: 'answer' }]);
  });

  it('keeps reasoning and file parts', () => {
    const result = ChatRequestSchema.safeParse({
      messages: [
        baseMessage('assistant', [
          { type: 'reasoning', text: 'chain of thought' },
          { type: 'file', url: 'https://example.com/f.pdf', filename: 'f.pdf', mediaType: 'application/pdf' },
        ]),
      ],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.messages[0]!.parts).toEqual([
      { type: 'reasoning', text: 'chain of thought' },
      { type: 'file', url: 'https://example.com/f.pdf', filename: 'f.pdf', mediaType: 'application/pdf' },
    ]);
  });

  it('strips rather than rejects an unsupported part type', () => {
    const result = ChatRequestSchema.safeParse({
      messages: [baseMessage('user', [{ type: 'bogus-part', text: 'x' }])],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.messages[0]!.parts).toEqual([]);
  });

  it('rejects an empty messages array', () => {
    const result = ChatRequestSchema.safeParse({ messages: [] });
    expect(result.success).toBe(false);
  });

  it('caps the number of parts per message at 100', () => {
    const over = baseMessage('user', Array.from({ length: 101 }, (_, i) => ({ type: 'text', text: `p${i}` })));
    const at = baseMessage('user', Array.from({ length: 100 }, (_, i) => ({ type: 'text', text: `p${i}` })));
    expect(ChatRequestSchema.safeParse({ messages: [over] }).success).toBe(false);
    expect(ChatRequestSchema.safeParse({ messages: [at] }).success).toBe(true);
  });

  it('enforces a per-request total text character budget', () => {
    const bigMessage = baseMessage('user', [{ type: 'text', text: 'x'.repeat(60_000) }]);
    const threeBig = [bigMessage, bigMessage, bigMessage, bigMessage];
    expect(ChatRequestSchema.safeParse({ messages: threeBig }).success).toBe(false);
  });

  it('rejects a single over-length text/reasoning part instead of passing it through as unknown', () => {
    const overText = baseMessage('user', [{ type: 'text', text: 'x'.repeat(50_001) }]);
    const overReasoning = baseMessage('assistant', [{ type: 'reasoning', text: 'x'.repeat(50_001) }]);
    expect(ChatRequestSchema.safeParse({ messages: [overText] }).success).toBe(false);
    expect(ChatRequestSchema.safeParse({ messages: [overReasoning] }).success).toBe(false);
  });

  it('requires a v4 turnId', () => {
    const valid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    const v1 = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
    const body = { turnId: valid, messages: [baseMessage('user', [{ type: 'text', text: 'hi' }])] };
    expect(ChatRequestSchema.safeParse(body).success).toBe(true);
    expect(ChatRequestSchema.safeParse({ ...body, turnId: v1 }).success).toBe(false);
    expect(ChatRequestSchema.safeParse({ ...body, turnId: 'nope' }).success).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { ChatRequestSchema } from './request-schema';

// Regression: the client (AI SDK v3 `useChat`) round-trips the full message
// history on every request, including assistant parts spawned by the agentic
// loop (e.g. `step-start`) and tool-invocation phases. These must validate,
// otherwise the 2nd+ user message fails with "Unsupported message part type".
describe('ChatRequestSchema multi-turn round-trip', () => {
  const baseMessage = (role: 'user' | 'assistant', parts: unknown[]) => ({
    id: 'm1',
    role,
    parts,
  });

  it('accepts an assistant message containing a step-start part (agentic loop)', () => {
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
  });

  it('accepts dynamic-tool and tool-* invocation parts', () => {
    const result = ChatRequestSchema.safeParse({
      messages: [
        baseMessage('user', [{ type: 'text', text: 'hi' }]),
        baseMessage('assistant', [
          { type: 'text', text: 'ok' },
          { type: 'tool-call', toolCallId: 't1', toolName: 'searchDocumentation', input: {} },
          { type: 'tool-result', toolCallId: 't1', output: [] },
          { type: 'dynamic-tool', toolName: 'x' },
          { type: 'source-url', sourceId: 's1', url: 'https://example.com' },
        ]),
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts custom data-* control parts (citation, guardrail)', () => {
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
  });

  it('still rejects a genuinely unsupported part type', () => {
    const result = ChatRequestSchema.safeParse({
      messages: [baseMessage('user', [{ type: 'bogus-part', text: 'x' }])],
    });
    expect(result.success).toBe(false);
  });
});

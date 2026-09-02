import { describe, expect, it } from 'vitest';
import type { ChatInputMessage } from '../message-types';
import { canonicalTurnRequest, turnRequestFingerprint } from '../turn-fingerprint';

function message(overrides: Partial<ChatInputMessage> = {}): ChatInputMessage {
  return {
    id: 'transport-id-a',
    role: 'user',
    parts: [{ type: 'text', text: 'hello' }],
    ...overrides,
  };
}

describe('turn request fingerprint v2', () => {
  it('ignores transport-only message IDs', () => {
    const first = turnRequestFingerprint({ messages: [message({ id: 'one' })] });
    const regenerated = turnRequestFingerprint({ messages: [message({ id: 'two' })] });
    expect(regenerated).toBe(first);
  });

  it('changes for semantic request fields', () => {
    const base = { messages: [message()] };
    const fingerprint = turnRequestFingerprint(base);
    expect(turnRequestFingerprint({ messages: [message({ parts: [{ type: 'text', text: 'changed' }] })] }))
      .not.toBe(fingerprint);
    expect(turnRequestFingerprint({ messages: [message({ role: 'assistant' })] })).not.toBe(fingerprint);
    expect(turnRequestFingerprint({ ...base, conversationId: 'conversation-b' })).not.toBe(fingerprint);
    expect(turnRequestFingerprint({ ...base, retry: true })).not.toBe(fingerprint);
    expect(turnRequestFingerprint({ ...base, semanticContext: 'mode=agentic' })).not.toBe(fingerprint);
  });

  it('includes canonical model-visible file fields', () => {
    const fileMessage = message({
      parts: [{
        type: 'file',
        url: 'https://example.com/a.pdf',
        filename: 'a.pdf',
        mediaType: 'application/pdf',
      }],
    });
    const original = turnRequestFingerprint({ messages: [fileMessage] });
    expect(turnRequestFingerprint({
      messages: [{
        ...fileMessage,
        parts: [{
          type: 'file',
          url: 'https://example.com/b.pdf',
          filename: 'a.pdf',
          mediaType: 'application/pdf',
        }],
      }],
    })).not.toBe(original);
  });

  it('uses deterministic key ordering independent of input object insertion order', () => {
    const regular = message();
    const reordered: ChatInputMessage = {
      parts: [{ text: 'hello', type: 'text' }],
      role: 'user',
      id: 'different',
    };
    expect(canonicalTurnRequest({ messages: [reordered] })).toEqual(canonicalTurnRequest({ messages: [regular] }));
    expect(turnRequestFingerprint({ messages: [reordered] })).toBe(turnRequestFingerprint({ messages: [regular] }));
  });
});

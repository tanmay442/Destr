import { describe, expect, it } from 'vitest';
import {
  COMPACTION_VERSION,
  HISTORY_SHAPE_VERSION,
  HISTORY_TOKEN_ESTIMATOR_VERSION,
  compactHistoryForModel,
  estimateMessageTokens,
  estimateTextTokens,
  resolveCurrentRequestId,
  type HistoryCompactionOptions,
} from '../history-compaction';
import { toChatUIMessages, type ChatInputMessage, type ChatUIMessage } from '../message-types';

function inputMessage(id: string, role: 'user' | 'assistant', text: string): ChatInputMessage {
  return { id, role, parts: [{ type: 'text', text }] };
}

function tenMessages(): ChatUIMessage[] {
  return toChatUIMessages(
    Array.from({ length: 10 }, (_, index) =>
      inputMessage(`m${index}`, index % 2 === 0 ? 'user' : 'assistant', 'x'.repeat(40)),
    ),
  );
}

function optionsFixture(overrides: Partial<HistoryCompactionOptions> = {}): HistoryCompactionOptions {
  return {
    maxInputTokens: 55,
    recentMessagesToKeep: 4,
    currentRequestId: null,
    approvalContextIds: [],
    constraintMessageIds: [],
    ...overrides,
  };
}

describe('estimateTextTokens', () => {
  it('is deterministic and accounts ceil(chars/4)', () => {
    expect(estimateTextTokens('')).toBe(0);
    expect(estimateTextTokens('abcd')).toBe(1);
    expect(estimateTextTokens('abcde')).toBe(2);
    expect(estimateTextTokens('x'.repeat(40))).toBe(10);
  });
});

describe('compactHistoryForModel', () => {
  it('leaves history unchanged within budget with before/after counts and version', () => {
    const messages = tenMessages();
    const { messages: kept, result } = compactHistoryForModel(messages, optionsFixture({ maxInputTokens: 10_000 }));
    expect(result.outcome).toBe('unchanged');
    expect(result.compactionVersion).toBe(COMPACTION_VERSION);
    expect(result.historyShapeVersion).toBe(HISTORY_SHAPE_VERSION);
    expect(result.tokenEstimatorVersion).toBe(HISTORY_TOKEN_ESTIMATOR_VERSION);
    expect(result.beforeTokens).toBe(100);
    expect(result.afterTokens).toBe(100);
    expect(result.droppedMessageIds).toEqual([]);
    expect(kept.map((message) => message.id)).toEqual(messages.map((message) => message.id));
  });

  it('drops the oldest unprotected messages first and preserves the current request', () => {
    const messages = tenMessages();
    const { messages: kept, result } = compactHistoryForModel(messages, optionsFixture());
    // Protected: current request m8 (last user) + recent window m6..m9 = 40 tokens.
    // Remaining 15 keeps newest unprotected m5 (10), drops m0..m4.
    expect(result.outcome).toBe('compacted');
    expect(result.beforeTokens).toBe(100);
    expect(result.afterTokens).toBe(50);
    expect(kept.map((message) => message.id)).toEqual(['m5', 'm6', 'm7', 'm8', 'm9']);
    expect(result.droppedMessageIds).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
    expect(result.preservedCurrentRequestId).toBe('m8');
    expect(kept.map((message) => message.id)).toContain('m8');
  });

  it('preserves approval context and caller-marked constraints', () => {
    const messages = tenMessages();
    const { messages: kept, result } = compactHistoryForModel(
      messages,
      optionsFixture({ maxInputTokens: 75, approvalContextIds: ['m1'], constraintMessageIds: ['m2'] }),
    );
    expect(result.outcome).toBe('compacted');
    expect(result.outcome).toBe('compacted');
    expect(result.preservedApprovalContextIds).toEqual(['m1']);
    expect(kept.map((message) => message.id)).toContain('m1');
    expect(kept.map((message) => message.id)).toContain('m2');
    expect(kept.map((message) => message.id)).toContain('m8');
    expect(result.afterTokens).toBeLessThanOrEqual(75);
  });

  it('honors an explicit current request id', () => {
    const messages = tenMessages();
    const { messages: kept, result } = compactHistoryForModel(
      messages,
      optionsFixture({ currentRequestId: 'm0', maxInputTokens: 50 }),
    );
    expect(result.preservedCurrentRequestId).toBe('m0');
    expect(kept.map((message) => message.id)).toContain('m0');
    expect(result.afterTokens).toBeLessThanOrEqual(50);
  });

  it('is deterministic across runs', () => {
    const messages = tenMessages();
    const first = compactHistoryForModel(messages, optionsFixture());
    const second = compactHistoryForModel(messages, optionsFixture());
    expect(second.result).toEqual(first.result);
    expect(second.messages.map((message) => message.id)).toEqual(first.messages.map((message) => message.id));
  });

  it('keeps only input messages in input order (no invented prefix content)', () => {
    const messages = tenMessages();
    const { messages: kept, result } = compactHistoryForModel(messages, optionsFixture());
    const inputIds = new Set(messages.map((message) => message.id));
    for (const id of result.keptMessageIds) expect(inputIds.has(id)).toBe(true);
    expect(kept.map((message) => message.id)).toEqual(result.keptMessageIds);
    const positions = kept.map((message) => messages.findIndex((candidate) => candidate.id === message.id));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('returns a typed over_budget outcome when protected content alone exceeds the budget', () => {
    const messages = tenMessages();
    const { messages: kept, result } = compactHistoryForModel(messages, optionsFixture({ maxInputTokens: 15 }));
    expect(result.outcome).toBe('over_budget');
    expect(kept.map((message) => message.id)).toContain('m8');
    expect(result.keptMessageIds).toContain('m8');
    expect(result.afterTokens).toBeGreaterThan(15);
  });

  it('handles empty history', () => {
    const { messages: kept, result } = compactHistoryForModel([], optionsFixture());
    expect(result.outcome).toBe('unchanged');
    expect(result.beforeTokens).toBe(0);
    expect(result.afterTokens).toBe(0);
    expect(kept).toEqual([]);
    expect(result.preservedCurrentRequestId).toBeNull();
  });

  it('accounts file metadata deterministically', () => {
    const messages = toChatUIMessages([
      inputMessage('old', 'assistant', 'old'),
      {
        id: 'file',
        role: 'user',
        parts: [{
          type: 'file',
          url: `https://example.com/${'x'.repeat(200)}.pdf`,
          filename: 'document.pdf',
          mediaType: 'application/pdf',
        }],
      },
      inputMessage('latest', 'user', 'new'),
    ]);
    const fileMessage = messages.find((message) => message.id === 'file');
    expect(fileMessage).toBeDefined();
    expect(estimateMessageTokens(fileMessage!)).toBeGreaterThan(estimateMessageTokens(messages[2]!));
    const { result } = compactHistoryForModel(messages, { maxInputTokens: 10_000 });
    expect(result.afterTokens).toBe(result.beforeTokens);
  });
});

describe('resolveCurrentRequestId', () => {
  it('prefers the explicit id and falls back to the last user message', () => {
    const messages = tenMessages();
    expect(resolveCurrentRequestId(messages, 'm2')).toBe('m2');
    expect(resolveCurrentRequestId(messages, 'absent')).toBe('m8');
    expect(resolveCurrentRequestId(messages, null)).toBe('m8');
    expect(resolveCurrentRequestId([], null)).toBeNull();
  });
});

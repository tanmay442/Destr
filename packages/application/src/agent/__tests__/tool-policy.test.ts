import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type {
  AgentToolContext,
  AgentToolDefinition,
  EvidenceChunk,
  ToolExecuteCall,
} from '../tool-contract';
import { createDefaultBudget, createInMemoryTraceWriter } from '../tool-contract';
import { InMemoryToolApprovalPolicy } from '../tool-approval';
import {
  createPolicyCounts,
  sanitizeToolError,
  ToolPolicyError,
  wrapToolWithPolicy,
} from '../tool-policy-pipeline';

const inputSchema = z.object({
  query: z.string().min(1),
});

const outputSchema = z.object({
  answer: z.string(),
});

type TestInput = z.infer<typeof inputSchema>;
type TestOutput = z.infer<typeof outputSchema>;

function makeDefinition(overrides?: {
  readonly timeoutMs?: number;
  readonly maxCallsPerTurn?: number;
}): AgentToolDefinition<TestInput, TestOutput> {
  return {
    name: 'probeTool',
    description: 'Minimal probe tool for policy wrapper tests.',
    inputSchema,
    outputSchema,
    inputExamples: [{ query: 'example' }],
    guidance: {
      useWhen: ['testing'],
      doNotUseWhen: ['production'],
      resultSemantics: ['returns an answer string'],
    },
    policy: {
      effect: 'read',
      idempotent: true,
      requiresApproval: false,
      maxCallsPerTurn: overrides?.maxCallsPerTurn ?? 10,
      timeoutMs: overrides?.timeoutMs ?? 1000,
    },
    create: () => {
      throw new Error('Probe definition create() is unused in these tests.');
    },
  };
}

function makeContext(overrides?: {
  readonly signal?: AbortSignal;
  readonly maxTotalToolCalls?: number;
  readonly deadlineInMs?: number;
}): { readonly context: AgentToolContext; readonly abort: () => void } {
  const controller = new AbortController();
  const context: AgentToolContext = {
    actor: { userId: 'user-1' },
    turnId: 'turn-1',
    signal: overrides?.signal ?? controller.signal,
    budget: createDefaultBudget({
      maxTotalToolCalls: overrides?.maxTotalToolCalls ?? 10,
      deadlineInMs: overrides?.deadlineInMs ?? 50_000,
    }),
    evidence: {
      get seenChunkKeys(): ReadonlySet<string> {
        return new Set<string>();
      },
      addEvidence(chunks: readonly EvidenceChunk[]): readonly EvidenceChunk[] {
        return chunks;
      },
    },
    trace: createInMemoryTraceWriter(),
    approvals: new InMemoryToolApprovalPolicy({
      explicitTicketRequest: false,
      userId: 'user-1',
      turnId: 'turn-1',
    }),
  };
  return { context, abort: () => controller.abort() };
}

function makeCall(signal: AbortSignal, callId: string): ToolExecuteCall {
  return { callId, signal };
}

function freshCallSignal(): { readonly signal: AbortSignal; readonly abort: () => void } {
  const controller = new AbortController();
  return { signal: controller.signal, abort: () => controller.abort() };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function kindOf(error: unknown): string | null {
  return error instanceof ToolPolicyError ? error.kind : null;
}

describe('tool policy wrappers', () => {
  it('rejects bad input with input_validation without calling inner', async () => {
    const { context } = makeContext();
    let innerCalls = 0;
    const wrapped = wrapToolWithPolicy({
      definition: makeDefinition(),
      context,
      counts: createPolicyCounts(),
      inner: async (parsed: TestInput): Promise<TestOutput> => {
        innerCalls += 1;
        return { answer: parsed.query };
      },
    });
    const badInput: unknown = { query: 123 };
    const { signal } = freshCallSignal();

    const caught: unknown = await wrapped(badInput, makeCall(signal, 'call-input')).then(
      () => null,
      (error: unknown) => error,
    );

    expect(caught).toBeInstanceOf(ToolPolicyError);
    expect(kindOf(caught)).toBe('input_validation');
    expect(innerCalls).toBe(0);
  });

  it('rejects malformed inner result with output_validation', async () => {
    const { context } = makeContext();
    const wrapped = wrapToolWithPolicy({
      definition: makeDefinition(),
      context,
      counts: createPolicyCounts(),
      inner: async (): Promise<TestOutput> => {
        const malformed: unknown = { wrong: 1 };
        return malformed as unknown as TestOutput;
      },
    });
    const { signal } = freshCallSignal();

    const caught: unknown = await wrapped({ query: 'hello' }, makeCall(signal, 'call-output')).then(
      () => null,
      (error: unknown) => error,
    );

    expect(caught).toBeInstanceOf(ToolPolicyError);
    expect(kindOf(caught)).toBe('output_validation');
  });

  it('enforces per-tool timeout', async () => {
    const { context } = makeContext();
    const wrapped = wrapToolWithPolicy({
      definition: makeDefinition({ timeoutMs: 20 }),
      context,
      counts: createPolicyCounts(),
      inner: async (): Promise<TestOutput> => {
        await sleep(200);
        return { answer: 'late' };
      },
    });
    const { signal } = freshCallSignal();

    const caught: unknown = await wrapped({ query: 'hello' }, makeCall(signal, 'call-timeout')).then(
      () => null,
      (error: unknown) => error,
    );

    expect(caught).toBeInstanceOf(ToolPolicyError);
    expect(kindOf(caught)).toBe('timeout');
  });

  it('yields cancelled when the caller aborts before the call', async () => {
    const caller = new AbortController();
    caller.abort();
    const { context } = makeContext({ signal: caller.signal });
    let innerCalls = 0;
    const wrapped = wrapToolWithPolicy({
      definition: makeDefinition(),
      context,
      counts: createPolicyCounts(),
      inner: async (): Promise<TestOutput> => {
        innerCalls += 1;
        return { answer: 'ok' };
      },
    });
    const { signal } = freshCallSignal();

    const caught: unknown = await wrapped({ query: 'hello' }, makeCall(signal, 'call-pre-abort')).then(
      () => null,
      (error: unknown) => error,
    );

    expect(caught).toBeInstanceOf(ToolPolicyError);
    expect(kindOf(caught)).toBe('cancelled');
    expect(innerCalls).toBe(0);
  });

  it('yields cancelled and propagates abort to inner when aborted mid-flight', async () => {
    const caller = new AbortController();
    const { context } = makeContext({ signal: caller.signal });
    let observedSignal: AbortSignal | null = null;
    const wrapped = wrapToolWithPolicy({
      definition: makeDefinition({ timeoutMs: 5000 }),
      context,
      counts: createPolicyCounts(),
      inner: async (_parsed: TestInput, call: ToolExecuteCall): Promise<TestOutput> => {
        observedSignal = call.signal;
        await sleep(500);
        return { answer: 'late' };
      },
    });
    const { signal } = freshCallSignal();

    const pending = wrapped({ query: 'hello' }, makeCall(signal, 'call-mid-abort'));
    await sleep(10);
    caller.abort();
    const caught: unknown = await pending.then(
      () => null,
      (error: unknown) => error,
    );

    expect(caught).toBeInstanceOf(ToolPolicyError);
    expect(kindOf(caught)).toBe('cancelled');
    const seen: unknown = observedSignal;
    expect(seen instanceof AbortSignal && seen.aborted).toBe(true);
  });

  it('enforces per-tool maxCallsPerTurn with budget_exceeded on the 2nd call', async () => {
    const { context } = makeContext();
    const wrapped = wrapToolWithPolicy({
      definition: makeDefinition({ maxCallsPerTurn: 1 }),
      context,
      counts: createPolicyCounts(),
      inner: async (parsed: TestInput): Promise<TestOutput> => ({ answer: parsed.query }),
    });

    const first = freshCallSignal();
    await expect(wrapped({ query: 'one' }, makeCall(first.signal, 'call-per-tool-1'))).resolves.toEqual({
      answer: 'one',
    });

    const second = freshCallSignal();
    const caught: unknown = await wrapped({ query: 'two' }, makeCall(second.signal, 'call-per-tool-2')).then(
      () => null,
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(ToolPolicyError);
    expect(kindOf(caught)).toBe('budget_exceeded');
  });

  it('enforces the total call budget with budget_exceeded', async () => {
    const { context } = makeContext({ maxTotalToolCalls: 1 });
    const wrapped = wrapToolWithPolicy({
      definition: makeDefinition({ maxCallsPerTurn: 10 }),
      context,
      counts: createPolicyCounts(),
      inner: async (parsed: TestInput): Promise<TestOutput> => ({ answer: parsed.query }),
    });

    const first = freshCallSignal();
    await expect(wrapped({ query: 'one' }, makeCall(first.signal, 'call-total-1'))).resolves.toEqual({
      answer: 'one',
    });

    const second = freshCallSignal();
    const caught: unknown = await wrapped({ query: 'two' }, makeCall(second.signal, 'call-total-2')).then(
      () => null,
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(ToolPolicyError);
    expect(kindOf(caught)).toBe('budget_exceeded');
  });

  it('writes start plus terminal trace events with sanitized true and no raw input text', async () => {
    const { context } = makeContext();
    const wrapped = wrapToolWithPolicy({
      definition: makeDefinition(),
      context,
      counts: createPolicyCounts(),
      inner: async (parsed: TestInput): Promise<TestOutput> => ({ answer: parsed.query }),
    });
    const secret = 'super-secret-query-xyz-9247';
    const { signal } = freshCallSignal();

    await wrapped({ query: secret }, makeCall(signal, 'call-trace-1'));

    const events = context.trace.events;
    expect(events).toHaveLength(2);
    expect(events[0]?.phase).toBe('start');
    expect(events[1]?.phase).toBe('success');
    for (const event of events) {
      expect(event.sanitized).toBe(true);
      expect(event.toolName).toBe('probeTool');
      expect(event.callId).toBe('call-trace-1');
    }
    expect(events[0]?.durationMs).toBeNull();
    expect(typeof events[1]?.durationMs).toBe('number');
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  it('sanitizeToolError strips control characters', () => {
    const result = sanitizeToolError(new Error('alpha\nbeta\tgamma\0delta'));
    expect(result.kind).toBe('failed');
    expect(/[\u0000-\u001f\u007f]/.test(result.message)).toBe(false);
    expect(result.message).toContain('alpha');
    expect(result.message).toContain('delta');
  });

  it('sanitizeToolError caps message length', () => {
    const result = sanitizeToolError(new Error('x'.repeat(1000)));
    expect(result.kind).toBe('failed');
    expect(result.message.length).toBeLessThanOrEqual(500);
  });

  it('sanitizeToolError never leaks Error cause details beyond the safe message', () => {
    const withCause = new ToolPolicyError('failed', 'safe outer message', {
      cause: new Error('super-secret-cause-payload-5813'),
    });
    const fromPolicy = sanitizeToolError(withCause);
    expect(fromPolicy.kind).toBe('failed');
    expect(fromPolicy.message).toBe('safe outer message');
    expect(fromPolicy.message).not.toContain('super-secret-cause-payload-5813');

    const outerWithCause = new Error('safe outer only', {
      cause: new Error('hidden-inner-secret-4429'),
    });
    const fromError = sanitizeToolError(outerWithCause);
    expect(fromError.kind).toBe('failed');
    expect(fromError.message).toContain('safe outer only');
    expect(fromError.message).not.toContain('hidden-inner-secret-4429');
  });
});

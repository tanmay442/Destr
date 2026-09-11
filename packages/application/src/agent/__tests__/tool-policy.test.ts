import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type {
  AgentToolContext,
  AgentToolDefinition,
  EvidenceChunk,
  ToolExecuteCall,
} from '../tool-contract';
import { createInMemoryTraceWriter } from '../tool-contract';
import { createAgentRunBudget } from '../agent-budget';
import {
  createApprovalPolicyForTurn,
  InMemoryToolApprovalPolicy,
  isExplicitTicketRequestText,
} from '../tool-approval';
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
  readonly name?: string;
  readonly effect?: 'read' | 'write';
  readonly requiresApproval?: boolean;
}): AgentToolDefinition<TestInput, TestOutput> {
  return {
    name: overrides?.name ?? 'probeTool',
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
      effect: overrides?.effect ?? 'read',
      idempotent: overrides?.effect !== 'write',
      requiresApproval: overrides?.requiresApproval ?? false,
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
  readonly maxCallsByTool?: Readonly<Record<string, number>>;
  readonly deadlineInMs?: number;
  readonly approvals?: AgentToolContext['approvals'];
}): { readonly context: AgentToolContext; readonly abort: () => void } {
  const controller = new AbortController();
  const context: AgentToolContext = {
    actor: { userId: 'user-1' },
    turnId: 'turn-1',
    signal: overrides?.signal ?? controller.signal,
    budget: createAgentRunBudget({
      nowMs: Date.now(),
      deadlineInMs: overrides?.deadlineInMs ?? 50_000,
      finalizeReserveMs: 0,
      overrides: {
        maxTotalToolCalls: overrides?.maxTotalToolCalls ?? 10,
        ...(overrides?.maxCallsByTool !== undefined ? { maxCallsByTool: overrides.maxCallsByTool } : {}),
      },
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
    approvals: overrides?.approvals ?? new InMemoryToolApprovalPolicy({
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

  it('aborts the underlying operation when the policy timeout wins', async () => {
    const { context } = makeContext();
    let observedSignal: AbortSignal | undefined;
    const wrapped = wrapToolWithPolicy({
      definition: makeDefinition({ timeoutMs: 20 }),
      context,
      counts: createPolicyCounts(),
      inner: async (_parsed: TestInput, call: ToolExecuteCall): Promise<TestOutput> => {
        observedSignal = call.signal;
        return await new Promise<TestOutput>((_resolve, reject) => {
          call.signal.addEventListener('abort', () => reject(call.signal.reason), { once: true });
        });
      },
    });
    const { signal } = freshCallSignal();

    await expect(wrapped({ query: 'timeout-abort' }, makeCall(signal, 'call-timeout-abort'))).rejects.toMatchObject({
      kind: 'timeout',
    });
    expect(observedSignal?.aborted).toBe(true);
    expect(context.trace.events.filter((event) => event.phase !== 'start')).toHaveLength(1);
  });

  it('reconciles an already-started write result after timeout instead of reporting a retryable false failure', async () => {
    const { context } = makeContext();
    let observedAborted = false;
    const wrapped = wrapToolWithPolicy({
      definition: makeDefinition({ timeoutMs: 10, effect: 'write', requiresApproval: false }),
      context,
      counts: createPolicyCounts(),
      inner: async (_parsed, call): Promise<TestOutput> => {
        await sleep(25);
        observedAborted = call.signal.aborted;
        return { answer: 'committed' };
      },
    });

    await expect(wrapped(
      { query: 'write' },
      makeCall(new AbortController().signal, 'call-write-reconcile'),
    )).resolves.toEqual({ answer: 'committed' });
    expect(observedAborted).toBe(true);
    expect(context.trace.events.filter((event) => event.phase !== 'start')).toHaveLength(1);
    expect(context.trace.events.at(-1)?.phase).toBe('success');
  });

  it('returns a write that completes before timeout as success', async () => {
    const { context } = makeContext();
    const wrapped = wrapToolWithPolicy({
      definition: makeDefinition({ timeoutMs: 1000, effect: 'write', requiresApproval: false }),
      context,
      counts: createPolicyCounts(),
      inner: async (): Promise<TestOutput> => ({ answer: 'fast-commit' }),
    });
    await expect(
      wrapped({ query: 'fast' }, makeCall(new AbortController().signal, 'call-write-fast')),
    ).resolves.toEqual({ answer: 'fast-commit' });
    expect(context.trace.events.filter((e) => e.phase !== 'start')).toHaveLength(1);
    expect(context.trace.events.at(-1)?.phase).toBe('success');
  });

  it('does not invoke a write when aborted before it begins', async () => {
    const caller = new AbortController();
    caller.abort();
    const { context } = makeContext({ signal: caller.signal });
    let innerCalls = 0;
    const wrapped = wrapToolWithPolicy({
      definition: makeDefinition({ timeoutMs: 1000, effect: 'write', requiresApproval: false }),
      context,
      counts: createPolicyCounts(),
      inner: async (): Promise<TestOutput> => {
        innerCalls += 1;
        return { answer: 'never' };
      },
    });
    const caught = await wrapped({ query: 'x' }, makeCall(new AbortController().signal, 'call-write-preabort')).then(
      () => null,
      (e: unknown) => e,
    );
    expect(kindOf(caught)).toBe('cancelled');
    expect(innerCalls).toBe(0);
    expect(context.trace.events.filter((e) => e.phase !== 'start')).toHaveLength(1);
  });

  it('reports timeout when a write honors abort instead of masking the deadline', async () => {
    const { context } = makeContext();
    const wrapped = wrapToolWithPolicy({
      definition: makeDefinition({ timeoutMs: 10, effect: 'write', requiresApproval: false }),
      context,
      counts: createPolicyCounts(),
      inner: async (_parsed, call): Promise<TestOutput> => {
        await new Promise<never>((_, reject) => {
          call.signal.addEventListener('abort', () => reject(call.signal.reason), { once: true });
        });
        return { answer: 'unreached' };
      },
    });
    const caught = await wrapped({ query: 'honor' }, makeCall(new AbortController().signal, 'call-write-honor')).then(
      () => null,
      (e: unknown) => e,
    );
    expect(kindOf(caught)).toBe('timeout');
    expect(context.trace.events.filter((e) => e.phase !== 'start')).toHaveLength(1);
    expect(context.trace.events.at(-1)?.phase).toBe('timeout');
  });

  it('bounds reconciliation when a write never settles and invokes it exactly once', async () => {
    const { context } = makeContext({ deadlineInMs: 200 });
    let innerCalls = 0;
    const wrapped = wrapToolWithPolicy({
      definition: makeDefinition({ timeoutMs: 10, effect: 'write', requiresApproval: false, maxCallsPerTurn: 1 }),
      context,
      counts: createPolicyCounts(),
      inner: async (): Promise<TestOutput> => {
        innerCalls += 1;
        await new Promise<never>(() => undefined);
        return { answer: 'unreached' };
      },
    });
    const started = Date.now();
    const caught = await wrapped({ query: 'hang' }, makeCall(new AbortController().signal, 'call-write-hang')).then(
      () => null,
      (e: unknown) => e,
    );
    const elapsed = Date.now() - started;
    expect(kindOf(caught)).toBe('outcome_unknown');
    expect(innerCalls).toBe(1);
    expect(elapsed).toBeLessThan(10_000);
    const terminals = context.trace.events.filter((e) => e.phase !== 'start');
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.phase).toBe('error');
    await expect(
      wrapped({ query: 'retry' }, makeCall(new AbortController().signal, 'call-write-retry')),
    ).rejects.toMatchObject({ kind: 'budget_exceeded' });
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
    expect(context.trace.events.filter((event) => event.phase !== 'start')).toHaveLength(1);
  });

  it('propagates per-call cancellation to the underlying operation', async () => {
    const caller = new AbortController();
    const call = new AbortController();
    const { context } = makeContext({ signal: caller.signal });
    let observedSignal: AbortSignal | undefined;
    const wrapped = wrapToolWithPolicy({
      definition: makeDefinition({ timeoutMs: 5000 }),
      context,
      counts: createPolicyCounts(),
      inner: async (_parsed: TestInput, innerCall: ToolExecuteCall): Promise<TestOutput> => {
        observedSignal = innerCall.signal;
        return await new Promise<TestOutput>((_resolve, reject) => {
          innerCall.signal.addEventListener('abort', () => reject(innerCall.signal.reason), { once: true });
        });
      },
    });

    const pending = wrapped({ query: 'call-abort' }, makeCall(call.signal, 'call-abort'));
    await sleep(10);
    call.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
    expect(observedSignal?.aborted).toBe(true);
    expect(context.trace.events.filter((event) => event.phase !== 'start')).toHaveLength(1);
  });

  it('does not let negative or informational ticket text authorize a write', async () => {
    const negative = [
      'I do not want to open a ticket.',
      'Please do not open a ticket.',
      'What does "open a ticket" mean?',
      'The docs say to open a ticket.',
    ];
    for (const text of negative) expect(isExplicitTicketRequestText(text)).toBe(false);

    const { context } = makeContext({
      approvals: createApprovalPolicyForTurn({
        lastUserText: 'I do not want to open a ticket.',
        userId: 'user-1',
        turnId: 'turn-1',
      }),
    });
    const wrapped = wrapToolWithPolicy({
      definition: makeDefinition({ name: 'createKnowledgeTicket', effect: 'write', requiresApproval: true }),
      context,
      counts: createPolicyCounts(),
      inner: async (): Promise<TestOutput> => ({ answer: 'must not run' }),
    });

    await expect(wrapped({ query: 'ticket body' }, makeCall(new AbortController().signal, 'call-negative'))).rejects.toMatchObject({
      kind: 'denied',
    });
  });

  it('recognizes direct unambiguous ticket requests including contractions', () => {
    for (const text of [
      'Please open a ticket.',
      "I'd like you to create a knowledge ticket.",
      'How do I reset my password? Please open a ticket.',
    ]) {
      expect(isExplicitTicketRequestText(text)).toBe(true);
    }
  });

  it('scopes explicit intent to tool, actor, turn, and the first exact argument set', async () => {
    const approvals = new InMemoryToolApprovalPolicy({
      explicitTicketRequest: true,
      userId: 'user-1',
      turnId: 'turn-1',
    });
    const { context } = makeContext({ approvals, maxCallsByTool: { createKnowledgeTicket: 10 } });
    const definition = makeDefinition({ name: 'createKnowledgeTicket', effect: 'write', requiresApproval: true });
    const counts = createPolicyCounts();
    const wrapped = wrapToolWithPolicy({
      definition,
      context,
      counts,
      inner: async (parsed): Promise<TestOutput> => ({ answer: parsed.query }),
    });

    await expect(wrapped({ query: 'first' }, makeCall(new AbortController().signal, 'call-explicit-1'))).resolves.toEqual({
      answer: 'first',
    });
    await expect(wrapped({ query: 'changed' }, makeCall(new AbortController().signal, 'call-explicit-2'))).rejects.toMatchObject({
      kind: 'denied',
    });

    const wrongToolContext = makeContext({ approvals: new InMemoryToolApprovalPolicy({
      explicitTicketRequest: true,
      userId: 'user-1',
      turnId: 'turn-1',
    }) }).context;
    const wrongTool = wrapToolWithPolicy({
      definition: makeDefinition({ name: 'otherWrite', effect: 'write', requiresApproval: true }),
      context: wrongToolContext,
      counts: createPolicyCounts(),
      inner: async (): Promise<TestOutput> => ({ answer: 'must not run' }),
    });
    await expect(wrongTool({ query: 'first' }, makeCall(new AbortController().signal, 'call-explicit-other'))).rejects.toMatchObject({
      kind: 'denied',
    });

    const mismatchedActor = makeContext({ approvals: new InMemoryToolApprovalPolicy({
      explicitTicketRequest: true,
      userId: 'user-2',
      turnId: 'turn-1',
    }) });
    const actorBound = wrapToolWithPolicy({
      definition,
      context: mismatchedActor.context,
      counts: createPolicyCounts(),
      inner: async (): Promise<TestOutput> => ({ answer: 'must not run' }),
    });
    await expect(actorBound({ query: 'first' }, makeCall(new AbortController().signal, 'call-explicit-actor'))).rejects.toMatchObject({
      kind: 'denied',
    });
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

  it('sanitizeToolError preserves the bounded unknown-write outcome without exposing causes', () => {
    const result = sanitizeToolError(new ToolPolicyError(
      'outcome_unknown',
      'Ticket outcome is unknown; do not retry this request.',
      { cause: new Error('secret database detail') },
    ));
    expect(result).toEqual({
      kind: 'outcome_unknown',
      message: 'Ticket outcome is unknown; do not retry this request.',
    });
    expect(result.message).not.toContain('secret database detail');
  });

  it('sanitizeToolError returns a generic message for unexpected errors', () => {
    const result = sanitizeToolError(new Error('alpha\nbeta\tgamma\0delta'));
    expect(result.kind).toBe('failed');
    expect(/[\u0000-\u001f\u007f]/.test(result.message)).toBe(false);
    expect(result.message).toBe('Tool execution failed.');
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
    expect(fromPolicy.message).toBe('Tool execution failed.');
    expect(fromPolicy.message).not.toContain('super-secret-cause-payload-5813');

    const outerWithCause = new Error('safe outer only', {
      cause: new Error('hidden-inner-secret-4429'),
    });
    const fromError = sanitizeToolError(outerWithCause);
    expect(fromError.kind).toBe('failed');
    expect(fromError.message).toBe('Tool execution failed.');
    expect(fromError.message).not.toContain('hidden-inner-secret-4429');
  });

  it('does not expose unexpected provider error text through the policy wrapper', async () => {
    const { context } = makeContext();
    const wrapped = wrapToolWithPolicy({
      definition: makeDefinition(),
      context,
      counts: createPolicyCounts(),
      inner: async (): Promise<TestOutput> => {
        throw new Error('database password=super-secret-123');
      },
    });

    const caught = await wrapped({ query: 'error' }, makeCall(new AbortController().signal, 'call-safe-error')).catch(
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(ToolPolicyError);
    expect((caught as ToolPolicyError).message).toBe('Tool execution failed.');
    expect(JSON.stringify(caught)).not.toContain('super-secret-123');
  });

  it('safely handles late promise rejection after timeout without unhandled rejection', async () => {
    const { context } = makeContext();
    let lateReject: ((error: unknown) => void) | undefined;
    const wrapped = wrapToolWithPolicy({
      definition: makeDefinition({ timeoutMs: 10 }),
      context,
      counts: createPolicyCounts(),
      inner: async () => {
        return await new Promise<TestOutput>((_resolve, reject) => {
          lateReject = reject;
        });
      },
    });
    await expect(
      wrapped({ query: 'late' }, makeCall(new AbortController().signal, 'call-late')),
    ).rejects.toMatchObject({ kind: 'timeout' });
    expect(lateReject).toBeDefined();
    expect(() => lateReject?.(new Error('late failure after race'))).not.toThrow();
  });
});

/**
 * Deterministic harness tests for the project-owned support agent loop.
 *
 * All tests drive createSupportAgent().run end to end with a scripted model
 * backend and stub tools (no retrieval dependencies). Real DefaultToolCatalog
 * plus InMemoryToolApprovalPolicy provide the policy behavior.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgentRunBudget, type AgentRunBudget } from '../agent-budget';
import { DEFAULT_TOOL_CAPABILITIES } from '../model-tool-capabilities';
import { asUntypedTool, DefaultToolCatalog } from '../tool-catalog';
import {
  createInMemoryTraceWriter,
  type AgentToolDefinition,
  type EvidenceChunk,
} from '../tool-contract';
import { InMemoryToolApprovalPolicy } from '../tool-approval';
import { createSupportAgent, type SupportAgentInput, type SupportAgentRun } from '../support-agent';
import { createScriptedBackend, type ScriptedStep } from '../scripted-model';

const USER_ID = 'user-test';
const TURN_ID = 'turn-test';
const SEARCH_NAME = 'searchDocumentation';
const TICKET_NAME = 'createKnowledgeTicket';

const searchInputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(10).optional(),
});
type SearchStubInput = z.infer<typeof searchInputSchema>;

const searchSetSchema = z.object({
  kind: z.enum(['results', 'no_match', 'error']),
  ticketEligible: z.boolean(),
  coverage: z.enum(['sufficient', 'partial', 'none']),
  executedQueries: z.array(z.string()),
});
// Production SearchToolResult carries evidence counters top-level (see
// rag/search/search-contract.ts), never per set.
const searchOutputSchema = z.object({
  sets: z.array(searchSetSchema),
  uniqueEvidenceAdded: z.number().int().min(0),
  evidenceTokensAdded: z.number().int().min(0),
});
type SearchStubOutput = z.infer<typeof searchOutputSchema>;

const ticketInputSchema = z.object({
  question: z.string().min(1),
  attempted: z.array(z.string()),
  documentationSearched: z.array(z.string()),
});
const ticketOutputSchema = z.object({
  ticketId: z.string().nullable(),
  status: z.enum(['created', 'error', 'denied']),
  message: z.string().max(500).optional(),
});
type TicketStubOutput = z.infer<typeof ticketOutputSchema>;

function resultsSet(overrides?: {
  coverage?: 'sufficient' | 'partial' | 'none';
  executedQueries?: string[];
  uniqueEvidenceAdded?: number;
  evidenceTokensAdded?: number;
}): SearchStubOutput {
  const {
    uniqueEvidenceAdded = 2,
    evidenceTokensAdded = 100,
    ...setOverrides
  } = overrides ?? {};
  return {
    sets: [
      {
        kind: 'results',
        ticketEligible: false,
        coverage: 'sufficient',
        executedQueries: ['planner query'],
        ...setOverrides,
      },
    ],
    uniqueEvidenceAdded,
    evidenceTokensAdded,
  };
}

function noMatchSet(ticketEligible: boolean): SearchStubOutput {
  return {
    sets: [
      {
        kind: 'no_match',
        ticketEligible,
        coverage: 'none',
        executedQueries: ['planner query'],
      },
    ],
    uniqueEvidenceAdded: 0,
    evidenceTokensAdded: 0,
  };
}

function errorSet(): SearchStubOutput {
  return {
    sets: [
      {
        kind: 'error',
        ticketEligible: false,
        coverage: 'none',
        executedQueries: [],
      },
    ],
    uniqueEvidenceAdded: 0,
    evidenceTokensAdded: 0,
  };
}

function stubSearchTool(
  queue: SearchStubOutput[],
  seenArgs: unknown[],
): AgentToolDefinition<SearchStubInput, SearchStubOutput> {
  return {
    name: SEARCH_NAME,
    description: 'Stub documentation search.',
    inputSchema: searchInputSchema,
    outputSchema: searchOutputSchema,
    inputExamples: [{ query: 'example' }],
    guidance: {
      useWhen: ['testing'],
      doNotUseWhen: ['production'],
      resultSemantics: ['stub result'],
    },
    policy: {
      effect: 'read',
      idempotent: true,
      requiresApproval: false,
      maxCallsPerTurn: 10,
      timeoutMs: 5000,
    },
    create: () => async (input) => {
      seenArgs.push(input);
      const next = queue.shift();
      if (next === undefined) throw new Error('search stub exhausted');
      return next;
    },
  };
}

function stubTicketTool(
  queue: TicketStubOutput[],
  seenArgs: unknown[],
): AgentToolDefinition<z.infer<typeof ticketInputSchema>, TicketStubOutput> {
  return {
    name: TICKET_NAME,
    description: 'Stub knowledge ticket.',
    inputSchema: ticketInputSchema,
    outputSchema: ticketOutputSchema,
    inputExamples: [
      { question: 'example', attempted: [], documentationSearched: [] },
    ],
    guidance: {
      useWhen: ['testing'],
      doNotUseWhen: ['production'],
      resultSemantics: ['stub result'],
    },
    policy: {
      effect: 'write',
      idempotent: false,
      requiresApproval: true,
      maxCallsPerTurn: 10,
      timeoutMs: 5000,
    },
    create: () => async (input) => {
      seenArgs.push(input);
      const next = queue.shift();
      if (next === undefined) throw new Error('ticket stub exhausted');
      return next;
    },
  };
}

type BudgetOverrides = Partial<Omit<AgentRunBudget, 'deadlineAt' | 'finalizeReserveMs'>>;

function setup(input: {
  readonly steps: readonly ScriptedStep[];
  readonly userText: string;
  readonly explicitTicketRequest?: boolean;
  readonly budgetOverrides?: BudgetOverrides;
  readonly searchResults?: SearchStubOutput[];
  readonly ticketResults?: TicketStubOutput[];
  readonly signal?: AbortSignal;
}): {
  readonly agentInput: SupportAgentInput;
  readonly backend: ReturnType<typeof createScriptedBackend>;
  readonly searchArgs: unknown[];
  readonly ticketArgs: unknown[];
} {
  const searchArgs: unknown[] = [];
  const ticketArgs: unknown[] = [];
  const catalog = new DefaultToolCatalog([
    asUntypedTool(stubSearchTool(input.searchResults ?? [], searchArgs)),
    asUntypedTool(stubTicketTool(input.ticketResults ?? [], ticketArgs)),
  ]);
  const backend = createScriptedBackend(input.steps);
  const nowMs = Date.now();
  const budget = createAgentRunBudget({
    nowMs,
    deadlineInMs: 60_000,
    finalizeReserveMs: 0,
    ...(input.budgetOverrides !== undefined ? { overrides: input.budgetOverrides } : {}),
  });
  const agentInput: SupportAgentInput = {
    runId: 'run-test',
    actor: { userId: USER_ID },
    turnId: TURN_ID,
    userText: input.userText,
    history: [],
    systemPrompt: 'You are a support agent.',
    signal: input.signal ?? new AbortController().signal,
    budget,
    capabilities: DEFAULT_TOOL_CAPABILITIES,
    enabledTools: new Set([SEARCH_NAME, TICKET_NAME]),
    catalog,
    toolContext: {
      actor: { userId: USER_ID },
      turnId: TURN_ID,
      evidence: {
        seenChunkKeys: new Set<string>(),
        addEvidence: (chunks: readonly EvidenceChunk[]) => chunks,
      },
      trace: createInMemoryTraceWriter(),
      approvals: new InMemoryToolApprovalPolicy({
        explicitTicketRequest: input.explicitTicketRequest ?? false,
        userId: USER_ID,
        turnId: TURN_ID,
      }),
    },
    backend,
    nowMs,
  };
  return { agentInput, backend, searchArgs, ticketArgs };
}

function expectConsistentSummary(run: SupportAgentRun): void {
  expect(run.summary.runId).toBe(run.runId);
  expect(run.summary.stopReason).toEqual(run.stopReason);
  expect(run.summary.traceVersion).toBe('agent-trace-v1');
  const stepNumbers = new Set(run.stepTelemetry.map((row) => row.stepNumber));
  expect(run.summary.totalModelSteps).toBe(stepNumbers.size);
  const calls = run.stepTelemetry.filter((row) => row.toolName !== null).length;
  expect(run.summary.totalToolCalls).toBe(calls);
}

describe('support-agent harness', () => {
  it('1: no-tool greeting stops without tool calls', async () => {
    const { agentInput, backend } = setup({
      steps: [{ text: 'Hi there! How can I help?' }],
      userText: 'Hello!',
    });
    const run = await createSupportAgent().run(agentInput);
    expect(run.stopReason).toEqual({ kind: 'no_tool_requested' });
    expect(run.text).toBe('Hi there! How can I help?');
    expect(run.summary.totalModelSteps).toBe(1);
    expect(run.summary.totalToolCalls).toBe(0);
    expect(backend.calls[0]?.activeTools).toEqual([]);
    expect(backend.calls[0]?.toolChoice).toBe('none');
    expectConsistentSummary(run);
  });

  it('2: required documentation search runs once then completes', async () => {
    const { agentInput, backend, searchArgs } = setup({
      steps: [
        { toolCalls: [{ toolName: SEARCH_NAME, args: { query: 'refund policy' } }] },
        { text: 'Refunds are issued within 30 days.' },
      ],
      userText: 'What is the refund policy?',
      searchResults: [resultsSet()],
    });
    const run = await createSupportAgent().run(agentInput);
    expect(run.stopReason).toEqual({ kind: 'completed' });
    expect(searchArgs).toEqual([{ query: 'refund policy' }]);
    expect(run.summary.searchCalls).toBe(1);
    expect(run.summary.callsByTool).toEqual({ [SEARCH_NAME]: 1 });
    expect(backend.calls[0]?.activeTools).toContain(SEARCH_NAME);
    expect(backend.calls[0]?.activeTools).not.toContain(TICKET_NAME);
    expect(backend.calls[1]?.activeTools).not.toContain(SEARCH_NAME);
    expectConsistentSummary(run);
  });

  it('3: clarification answer makes no search calls', async () => {
    const { agentInput, searchArgs } = setup({
      steps: [{ text: 'Which product are you asking about?' }],
      userText: 'My thing is broken, help me fix it.',
    });
    const run = await createSupportAgent().run(agentInput);
    expect(run.stopReason).toEqual({ kind: 'no_tool_requested' });
    expect(searchArgs).toEqual([]);
    expect(run.summary.searchCalls).toBe(0);
    expectConsistentSummary(run);
  });

  it('4: search reformulation retries with distinct args after no-match', async () => {
    const { agentInput, searchArgs } = setup({
      steps: [
        { toolCalls: [{ toolName: SEARCH_NAME, args: { query: 'sso' } }] },
        { toolCalls: [{ toolName: SEARCH_NAME, args: { query: 'single sign-on setup guide' } }] },
        { text: 'Here is the SSO setup.' },
      ],
      userText: 'Do you support SSO?',
      searchResults: [noMatchSet(false), resultsSet()],
    });
    const run = await createSupportAgent().run(agentInput);
    expect(run.stopReason).toEqual({ kind: 'completed' });
    expect(searchArgs).toEqual([
      { query: 'sso' },
      { query: 'single sign-on setup guide' },
    ]);
    expect(run.summary.searchCalls).toBe(2);
    expectConsistentSummary(run);
  });

  it('5: search error hides the ticket tool and completes without escalation', async () => {
    const { agentInput, backend, ticketArgs } = setup({
      steps: [
        { toolCalls: [{ toolName: SEARCH_NAME, args: { query: 'leave policy' } }] },
        { text: 'I could not reach the docs, please try again later.' },
      ],
      userText: 'What is the leave policy?',
      searchResults: [errorSet()],
    });
    const run = await createSupportAgent().run(agentInput);
    expect(run.stopReason).toEqual({ kind: 'completed' });
    expect(ticketArgs).toEqual([]);
    expect(run.ticketCreated).toBe(false);
    expect(backend.calls[1]?.activeTools).not.toContain(TICKET_NAME);
    expectConsistentSummary(run);
  });

  it('6: eligible no-match plus explicit request escalates to a ticket', async () => {
    const { agentInput, backend, ticketArgs } = setup({
      steps: [
        { toolCalls: [{ toolName: SEARCH_NAME, args: { query: 'sso gaps' } }] },
        {
          toolCalls: [
            {
              toolName: TICKET_NAME,
              args: { question: 'SSO gaps', attempted: [], documentationSearched: ['sso gaps'] },
            },
          ],
        },
        { text: 'Ticket filed.' },
      ],
      userText: 'I checked the docs. Please open a ticket about SSO gaps.',
      explicitTicketRequest: true,
      searchResults: [noMatchSet(true)],
      ticketResults: [{ ticketId: 'ticket-1', status: 'created' }],
    });
    const run = await createSupportAgent().run(agentInput);
    expect(run.stopReason).toEqual({ kind: 'completed' });
    expect(run.ticketCreated).toBe(true);
    expect(run.ticketId).toBe('ticket-1');
    expect(ticketArgs).toEqual([
      { question: 'SSO gaps', attempted: [], documentationSearched: ['sso gaps'] },
    ]);
    expect(backend.calls[1]?.activeTools).toContain(TICKET_NAME);
    expectConsistentSummary(run);
  });

  it('7: explicit ticket request exposes the ticket on step 1', async () => {
    const { agentInput, backend, ticketArgs } = setup({
      steps: [
        {
          toolCalls: [
            {
              toolName: TICKET_NAME,
              args: { question: 'billing dispute', attempted: [], documentationSearched: [] },
            },
          ],
        },
        { text: 'Done.' },
      ],
      userText: 'Please open a ticket about billing.',
      explicitTicketRequest: true,
      ticketResults: [{ ticketId: 'ticket-7', status: 'created' }],
    });
    const run = await createSupportAgent().run(agentInput);
    expect(backend.calls[0]?.activeTools).toContain(TICKET_NAME);
    expect(ticketArgs).toHaveLength(1);
    expect(run.ticketCreated).toBe(true);
    expect(run.ticketId).toBe('ticket-7');
    expect(run.stopReason).toEqual({ kind: 'completed' });
    expectConsistentSummary(run);
  });

  it('8: non-explicit ticket call is hidden and has no side effect', async () => {
    const { agentInput, backend, ticketArgs } = setup({
      steps: [{ toolCalls: [{ toolName: TICKET_NAME, args: { question: 'hours' } }] }],
      userText: 'What are your support hours?',
      explicitTicketRequest: false,
    });
    const run = await createSupportAgent().run(agentInput);
    expect(backend.calls[0]?.activeTools).not.toContain(TICKET_NAME);
    expect(ticketArgs).toEqual([]);
    expect(run.ticketCreated).toBe(false);
    expect(run.stopReason).toEqual({ kind: 'no_tool_requested' });
    expectConsistentSummary(run);
  });

  it('9: second ticket call is denied without a second side effect', async () => {
    const { agentInput, ticketArgs } = setup({
      steps: [
        {
          toolCalls: [
            {
              toolName: TICKET_NAME,
              args: { question: 'outage', attempted: [], documentationSearched: [] },
            },
          ],
        },
        {
          toolCalls: [
            {
              toolName: TICKET_NAME,
              args: { question: 'outage details', attempted: [], documentationSearched: [] },
            },
          ],
        },
        { text: 'Your ticket is filed; the repeat was blocked.' },
      ],
      userText: 'Please open a ticket about the outage.',
      explicitTicketRequest: true,
      budgetOverrides: { maxCallsByTool: { [SEARCH_NAME]: 4, [TICKET_NAME]: 2 } },
      ticketResults: [{ ticketId: 'ticket-9', status: 'created' }],
    });
    const run = await createSupportAgent().run(agentInput);
    expect(run.ticketCreated).toBe(true);
    expect(run.ticketId).toBe('ticket-9');
    expect(ticketArgs).toHaveLength(1);
    expect(run.stopReason).toEqual({ kind: 'completed' });
    expect(run.summary.callsByTool).toEqual({ [TICKET_NAME]: 1 });
    expectConsistentSummary(run);
  });

  it('10: duplicate tool call stops the run', async () => {
    const { agentInput, searchArgs } = setup({
      steps: [
        { toolCalls: [{ toolName: SEARCH_NAME, args: { query: 'same' } }] },
        { toolCalls: [{ toolName: SEARCH_NAME, args: { query: 'same' } }] },
      ],
      userText: 'Tell me about pricing.',
      searchResults: [resultsSet({ coverage: 'partial', uniqueEvidenceAdded: 0, evidenceTokensAdded: 0 })],
    });
    const run = await createSupportAgent().run(agentInput);
    expect(run.stopReason.kind).toBe('duplicate_tool_call');
    expect(searchArgs).toHaveLength(1);
    expect(run.summary.searchCalls).toBe(1);
    expectConsistentSummary(run);
  });

  it('11: model-step limit stops perpetual tool calls', async () => {
    const { agentInput } = setup({
      steps: [
        { toolCalls: [{ toolName: SEARCH_NAME, args: { query: 'first' } }] },
        { toolCalls: [{ toolName: SEARCH_NAME, args: { query: 'second' } }] },
      ],
      userText: 'Tell me everything.',
      budgetOverrides: { maxModelSteps: 1 },
      searchResults: [resultsSet()],
    });
    const run = await createSupportAgent().run(agentInput);
    expect(run.stopReason).toEqual({ kind: 'max_model_steps', used: 1, limit: 1 });
    expectConsistentSummary(run);
  });

  it('12: total-tool-call limit stops mid-step', async () => {
    const { agentInput, searchArgs } = setup({
      steps: [
        {
          toolCalls: [
            { toolName: SEARCH_NAME, args: { query: 'alpha' } },
            { toolName: SEARCH_NAME, args: { query: 'beta' } },
          ],
        },
      ],
      userText: 'Compare alpha and beta.',
      budgetOverrides: { maxTotalToolCalls: 1 },
      searchResults: [resultsSet()],
    });
    const run = await createSupportAgent().run(agentInput);
    expect(run.stopReason).toEqual({ kind: 'max_total_tool_calls', used: 1, limit: 1 });
    expect(searchArgs).toEqual([{ query: 'alpha' }]);
    expect(run.summary.totalToolCalls).toBe(1);
    expectConsistentSummary(run);
  });

  it('13: per-tool-call limit stops excess search calls', async () => {
    const { agentInput, searchArgs } = setup({
      steps: [
        { toolCalls: [{ toolName: SEARCH_NAME, args: { query: 'one' } }] },
        { toolCalls: [{ toolName: SEARCH_NAME, args: { query: 'two' } }] },
      ],
      userText: 'Tell me about one and two.',
      budgetOverrides: { maxCallsByTool: { [SEARCH_NAME]: 1 } },
      searchResults: [resultsSet({ coverage: 'partial', uniqueEvidenceAdded: 0, evidenceTokensAdded: 0 })],
    });
    const run = await createSupportAgent().run(agentInput);
    expect(run.stopReason).toEqual({
      kind: 'max_calls_for_tool',
      toolName: SEARCH_NAME,
      used: 1,
      limit: 1,
    });
    expect(searchArgs).toEqual([{ query: 'one' }]);
    expectConsistentSummary(run);
  });

  it('14: search-call limit stops excess searches', async () => {
    const { agentInput, searchArgs } = setup({
      steps: [
        { toolCalls: [{ toolName: SEARCH_NAME, args: { query: 'one' } }] },
        { toolCalls: [{ toolName: SEARCH_NAME, args: { query: 'two' } }] },
      ],
      userText: 'Tell me about one and two.',
      budgetOverrides: { maxSearchCalls: 1 },
      searchResults: [resultsSet({ coverage: 'partial', uniqueEvidenceAdded: 0, evidenceTokensAdded: 0 })],
    });
    const run = await createSupportAgent().run(agentInput);
    expect(run.stopReason).toEqual({ kind: 'max_search_calls', used: 1, limit: 1 });
    expect(searchArgs).toEqual([{ query: 'one' }]);
    expectConsistentSummary(run);
  });

  it('15: backend timeout stops the run', async () => {
    const { agentInput, backend } = setup({
      steps: [{ error: 'timeout' }],
      userText: 'What is the refund policy?',
    });
    const run = await createSupportAgent().run(agentInput);
    expect(run.stopReason.kind).toBe('timeout');
    expect(backend.calls).toHaveLength(1);
    expectConsistentSummary(run);
  });

  it('16: pre-aborted signal cancels with zero steps', async () => {
    const controller = new AbortController();
    controller.abort();
    const { agentInput, backend } = setup({
      steps: [{ text: 'never reached' }],
      userText: 'Hello?',
      signal: controller.signal,
    });
    const run = await createSupportAgent().run(agentInput);
    expect(run.stopReason).toEqual({ kind: 'cancelled' });
    expect(run.state.steps).toEqual([]);
    expect(run.summary.totalModelSteps).toBe(0);
    expect(backend.calls).toEqual([]);
    expectConsistentSummary(run);
  });
});

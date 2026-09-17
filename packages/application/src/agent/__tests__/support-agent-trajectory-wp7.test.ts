import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgentRunBudget, type AgentRunBudget } from '../agent-budget';
import {
  DEFAULT_TOOL_CAPABILITIES,
  EMULATED_EXAMPLE_CAPABILITIES,
} from '../model-tool-capabilities';
import { asUntypedTool, DefaultToolCatalog } from '../tool-catalog';
import {
  createInMemoryTraceWriter,
  type AgentToolDefinition,
  type EvidenceChunk,
} from '../tool-contract';
import { InMemoryToolApprovalPolicy } from '../tool-approval';
import { createSupportAgent, type SupportAgentInput } from '../support-agent';
import { createScriptedBackend, type ScriptedStep } from '../scripted-model';

const USER_ID = 'user-wp7';
const TURN_ID = 'turn-wp7';
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
const searchOutputSchema = z.object({
  sets: z.array(searchSetSchema),
  plansUsed: z.number().int().min(0),
  physicalRetrievalsUsed: z.number().int().min(0),
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

function resultsOutput(overrides?: Partial<SearchStubOutput>): SearchStubOutput {
  return {
    sets: [
      {
        kind: 'results',
        ticketEligible: false,
        coverage: 'sufficient',
        executedQueries: ['q1'],
      },
    ],
    plansUsed: 1,
    physicalRetrievalsUsed: 2,
    uniqueEvidenceAdded: 2,
    evidenceTokensAdded: 120,
    ...overrides,
  };
}

function stubSearchTool(
  queue: Array<SearchStubOutput | { readonly throwKind: string }>,
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
      if ('throwKind' in next) throw { kind: next.throwKind };
      return next;
    },
  };
}

function stubTicketTool(
  queue: Array<TicketStubOutput | { readonly throwKind: string }>,
  seenArgs: unknown[],
): AgentToolDefinition<z.infer<typeof ticketInputSchema>, TicketStubOutput> {
  return {
    name: TICKET_NAME,
    description: 'Stub knowledge ticket.',
    inputSchema: ticketInputSchema,
    outputSchema: ticketOutputSchema,
    inputExamples: [{ question: 'example', attempted: [], documentationSearched: [] }],
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
      if ('throwKind' in next) throw { kind: next.throwKind };
      return next;
    },
  };
}

type BudgetOverrides = Partial<Omit<AgentRunBudget, 'deadlineAt' | 'finalizeReserveMs'>>;

function setup(input: {
  readonly steps: readonly ScriptedStep[];
  readonly userText: string;
  readonly history?: SupportAgentInput['history'];
  readonly explicitTicketRequest?: boolean;
  readonly budgetOverrides?: BudgetOverrides;
  readonly searchResults?: Array<SearchStubOutput | { readonly throwKind: string }>;
  readonly ticketResults?: Array<TicketStubOutput | { readonly throwKind: string }>;
  readonly signal?: AbortSignal;
  readonly capabilities?: SupportAgentInput['capabilities'];
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
    runId: 'run-wp7',
    actor: { userId: USER_ID },
    turnId: TURN_ID,
    userText: input.userText,
    history: input.history ?? [],
    systemPrompt: 'You are a support agent.',
    signal: input.signal ?? new AbortController().signal,
    budget,
    capabilities: input.capabilities ?? DEFAULT_TOOL_CAPABILITIES,
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

describe('support-agent wp7 trajectories', () => {
  it('rate-limited ticket write stops approval-interrupted with no side effect', async () => {
    const { agentInput, backend, ticketArgs } = setup({
      steps: [
        {
          toolCalls: [
            {
              toolName: TICKET_NAME,
              args: { question: 'File a ticket please', attempted: [], documentationSearched: [] },
            },
          ],
        },
      ],
      userText: 'Please file a ticket about refunds.',
      explicitTicketRequest: true,
      ticketResults: [
        {
          ticketId: null,
          status: 'denied',
          message: 'Rate limited: ticket quota exceeded; approval denied for this turn.',
        },
      ],
    });
    const run = await createSupportAgent().run(agentInput);
    expect(backend.calls[0]?.activeTools).toContain(TICKET_NAME);
    expect(ticketArgs).toEqual([
      { question: 'File a ticket please', attempted: [], documentationSearched: [] },
    ]);
    expect(run.stopReason).toEqual({
      kind: 'approval_interrupted',
      toolName: TICKET_NAME,
      callId: expect.any(String),
    });
    expect(run.ticketCreated).toBe(false);
    expect(run.ticketId).toBeNull();
    expect(run.summary.totalToolCalls).toBe(1);
    expect(run.state.events.some((event) => event.type === 'approval_interrupted')).toBe(true);
  });

  it('exceeding search plans stops with exact usage provenance', async () => {
    const { agentInput, backend, searchArgs } = setup({
      steps: [
        {
          toolCalls: [{ toolName: SEARCH_NAME, args: { query: 'refund policy' } }],
        },
      ],
      userText: 'What is the refund policy?',
      budgetOverrides: { maxSearchPlans: 1 },
      searchResults: [resultsOutput({ plansUsed: 2 })],
    });
    const run = await createSupportAgent().run(agentInput);
    expect(backend.calls[0]?.activeTools).toContain(SEARCH_NAME);
    expect(searchArgs).toEqual([{ query: 'refund policy' }]);
    expect(run.stopReason).toEqual({ kind: 'max_search_plans', used: 2, limit: 1 });
    expect(run.summary.searchPlans).toBe(2);
    expect(run.summary.searchCalls).toBe(1);
    expect(run.summary.physicalRetrievals).toBe(2);
  });

  it('exceeding physical retrievals stops with per-call provenance', async () => {
    const { agentInput } = setup({
      steps: [
        {
          toolCalls: [{ toolName: SEARCH_NAME, args: { query: 'claim portal' } }],
        },
      ],
      userText: 'How do I submit a claim?',
      budgetOverrides: { maxPhysicalRetrievals: 1 },
      searchResults: [resultsOutput({ physicalRetrievalsUsed: 3 })],
    });
    const run = await createSupportAgent().run(agentInput);
    expect(run.stopReason).toEqual({ kind: 'max_physical_retrievals', used: 3, limit: 1 });
    expect(run.summary.physicalRetrievals).toBe(3);
  });

  it('exceeding unique-evidence and token quotas stops deterministically', async () => {
    const chunkSetup = setup({
      steps: [
        {
          toolCalls: [{ toolName: SEARCH_NAME, args: { query: 'dental coverage' } }],
        },
      ],
      userText: 'What does the dental plan cover?',
      budgetOverrides: { maxUniqueEvidenceChunks: 1 },
      searchResults: [resultsOutput({ uniqueEvidenceAdded: 4, evidenceTokensAdded: 50 })],
    });
    const chunkRun = await createSupportAgent().run(chunkSetup.agentInput);
    expect(chunkRun.stopReason).toEqual({
      kind: 'max_unique_evidence_chunks',
      used: 4,
      limit: 1,
    });
    expect(chunkRun.summary.uniqueEvidenceChunks).toBe(4);

    const tokenSetup = setup({
      steps: [
        {
          toolCalls: [{ toolName: SEARCH_NAME, args: { query: 'dress policy' } }],
        },
      ],
      userText: 'What is the dress policy?',
      budgetOverrides: { maxEvidenceTokens: 10 },
      searchResults: [resultsOutput({ uniqueEvidenceAdded: 1, evidenceTokensAdded: 400 })],
    });
    const tokenRun = await createSupportAgent().run(tokenSetup.agentInput);
    expect(tokenRun.stopReason).toEqual({ kind: 'max_evidence_tokens', used: 400, limit: 10 });
    expect(tokenRun.summary.evidenceTokens).toBe(400);
  });

  it('mid-run model abort cancels with executed calls preserved', async () => {
    const { agentInput } = setup({
      steps: [
        {
          text: '',
          toolCalls: [{ toolName: SEARCH_NAME, args: { query: 'password reset' } }],
        },
        { error: 'abort' },
      ],
      userText: 'How do I reset my password?',
      searchResults: [resultsOutput()],
    });
    const run = await createSupportAgent().run(agentInput);
    expect(run.stopReason).toEqual({ kind: 'cancelled' });
    expect(run.summary.searchCalls).toBe(1);
    expect(run.summary.totalModelSteps).toBe(1);
  });

  it('pronoun follow-up forwards ordered history and executes search', async () => {
    const { agentInput, backend, searchArgs } = setup({
      steps: [
        {
          toolCalls: [{ toolName: SEARCH_NAME, args: { query: 'password reset time' } }],
        },
        { text: 'It takes seven minutes.' },
      ],
      userText: 'How long does it take?',
      history: [
        { role: 'user', text: 'How do I reset my password?' },
        { role: 'assistant', text: 'Open settings and choose reset.' },
      ],
      searchResults: [resultsOutput()],
    });
    const run = await createSupportAgent().run(agentInput);
    const firstMessages = backend.calls[0]?.messages ?? [];
    expect(firstMessages.map((message) => message.text)).toEqual([
      'How do I reset my password?',
      'Open settings and choose reset.',
      'How long does it take?',
    ]);
    expect(searchArgs).toEqual([{ query: 'password reset time' }]);
    const secondMessages = backend.calls[1]?.messages ?? [];
    expect(secondMessages.some((message) => message.text.includes(SEARCH_NAME))).toBe(true);
    expect(run.stopReason).toEqual({ kind: 'completed' });
    expect(run.text).toBe('It takes seven minutes.');
  });

  it('emulated-example capabilities keep the same visible tools and choice', async () => {
    const { agentInput, backend, searchArgs } = setup({
      steps: [
        {
          toolCalls: [{ toolName: SEARCH_NAME, args: { query: 'refund policy' } }],
        },
        { text: 'Refunds process within thirty days.' },
      ],
      userText: 'What is the refund policy?',
      capabilities: EMULATED_EXAMPLE_CAPABILITIES,
      searchResults: [resultsOutput()],
    });
    const run = await createSupportAgent().run(agentInput);
    expect(backend.calls[0]?.activeTools).toContain(SEARCH_NAME);
    expect(searchArgs).toEqual([{ query: 'refund policy' }]);
    expect(run.stopReason).toEqual({ kind: 'completed' });
    expect(run.summary.searchCalls).toBe(1);
    expect(run.summary.uniqueEvidenceChunks).toBe(2);
    expect(run.summary.evidenceTokens).toBe(120);
  });

  it('successful search trajectory releases candidate text with full provenance', async () => {
    const { agentInput, backend, searchArgs } = setup({
      steps: [
        {
          toolCalls: [{ toolName: SEARCH_NAME, args: { query: 'claim deadline', limit: 3 } }],
        },
        { text: 'The claim deadline is thirty days.' },
      ],
      userText: 'What is the claim deadline?',
      searchResults: [resultsOutput({ plansUsed: 1, physicalRetrievalsUsed: 2 })],
    });
    const run = await createSupportAgent().run(agentInput);
    expect(backend.calls).toHaveLength(2);
    expect(searchArgs).toEqual([{ query: 'claim deadline', limit: 3 }]);
    const secondMessages = backend.calls[1]?.messages ?? [];
    expect(secondMessages.some((message) => message.text.includes('Tool searchDocumentation returned'))).toBe(true);
    expect(run.stopReason).toEqual({ kind: 'completed' });
    expect(run.text).toBe('The claim deadline is thirty days.');
    expect(run.summary.totalModelSteps).toBe(2);
    expect(run.summary.totalToolCalls).toBe(1);
    expect(run.summary.callsByTool).toEqual({ [SEARCH_NAME]: 1 });
    expect(run.summary.searchPlans).toBe(1);
    const stepRows = run.stepTelemetry.filter((row) => row.toolName === SEARCH_NAME);
    expect(stepRows).toHaveLength(1);
    expect(stepRows[0]?.physicalRetrievals).toBe(2);
    expect(stepRows[0]?.evidenceAdded).toBe(2);
    expect(run.state.events.map((event) => event.type)).toEqual([
      'run_started',
      'step_started',
      'tool_called',
      'tool_finished',
      'step_finished',
      'step_started',
      'step_finished',
      'run_completed',
    ]);
  });
});

/**
 * WP-5 gap coverage for the project-owned support agent loop.
 *
 * Local stub builders + setup idiom mirror support-agent-harness.test.ts
 * (copied, not imported). All runs use fixed ids and scripted backends.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgentRunBudget, type AgentRunBudget } from '../agent-budget';
import {
  DEFAULT_TOOL_CAPABILITIES,
  EMULATED_EXAMPLE_CAPABILITIES,
  type ModelToolCapabilities,
} from '../model-tool-capabilities';
import { asUntypedTool, DefaultToolCatalog } from '../tool-catalog';
import {
  createInMemoryTraceWriter,
  type AgentToolDefinition,
  type EvidenceChunk,
  type ToolApprovalPolicy,
} from '../tool-contract';
import { InMemoryToolApprovalPolicy, normalizeToolArgs } from '../tool-approval';
import { createSupportAgent, type SupportAgentInput } from '../support-agent';
import type { AgentModelMessage } from '../model-backend';
import { createScriptedBackend, type ScriptedStep } from '../scripted-model';
import {
  readSupportAgentFlag,
  SUPPORT_AGENT_DEFAULT,
  SUPPORT_AGENT_FLAG_OWNER,
  SUPPORT_AGENT_REMOVAL,
  SUPPORT_AGENT_ROLLBACK,
} from '../agent-flags';

const USER_ID = 'user-wp5';
const TURN_ID = 'turn-wp5';
const RUN_ID = 'run-wp5';
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

function noMatchOutput(): SearchStubOutput {
  return {
    sets: [{
      kind: 'no_match',
      ticketEligible: true,
      coverage: 'none',
      executedQueries: ['no match query'],
    }],
    plansUsed: 1,
    physicalRetrievalsUsed: 1,
    uniqueEvidenceAdded: 0,
    evidenceTokensAdded: 0,
  };
}

function resultsOutput(overrides?: {
  coverage?: 'sufficient' | 'partial' | 'none';
  executedQueries?: string[];
  plansUsed?: number;
  physicalRetrievalsUsed?: number;
  uniqueEvidenceAdded?: number;
  evidenceTokensAdded?: number;
}): SearchStubOutput {
  return {
    sets: [
      {
        kind: 'results',
        ticketEligible: false,
        coverage: overrides?.coverage ?? 'sufficient',
        executedQueries: overrides?.executedQueries ?? ['planner query'],
      },
    ],
    plansUsed: overrides?.plansUsed ?? 0,
    physicalRetrievalsUsed: overrides?.physicalRetrievalsUsed ?? 0,
    uniqueEvidenceAdded: overrides?.uniqueEvidenceAdded ?? 2,
    evidenceTokensAdded: overrides?.evidenceTokensAdded ?? 100,
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
      return next;
    },
  };
}

type BudgetOverrides = Partial<Omit<AgentRunBudget, 'deadlineAt' | 'finalizeReserveMs'>>;

function setup(input: {
  readonly steps: readonly ScriptedStep[];
  readonly userText: string;
  readonly history?: readonly AgentModelMessage[];
  readonly currentMessage?: AgentModelMessage;
  readonly approvals?: ToolApprovalPolicy;
  readonly approvalToken?: string;
  readonly capabilities?: ModelToolCapabilities;
  readonly enabledTools?: ReadonlySet<string>;
  readonly budgetOverrides?: BudgetOverrides;
  readonly searchResults?: SearchStubOutput[];
  readonly ticketResults?: TicketStubOutput[];
  readonly explicitTicketRequest?: boolean;
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
    runId: RUN_ID,
    actor: { userId: USER_ID },
    turnId: TURN_ID,
    userText: input.userText,
    history: input.history ?? [],
    ...(input.currentMessage !== undefined ? { currentMessage: input.currentMessage } : {}),
    systemPrompt: 'You are a support agent.',
    signal: new AbortController().signal,
    budget,
    capabilities: input.capabilities ?? DEFAULT_TOOL_CAPABILITIES,
    enabledTools: input.enabledTools ?? new Set([SEARCH_NAME, TICKET_NAME]),
    catalog,
    toolContext: {
      actor: { userId: USER_ID },
      turnId: TURN_ID,
      evidence: {
        seenChunkKeys: new Set<string>(),
        addEvidence: (chunks: readonly EvidenceChunk[]) => chunks,
      },
      trace: createInMemoryTraceWriter(),
      approvals: input.approvals ?? new InMemoryToolApprovalPolicy({
        explicitTicketRequest: input.explicitTicketRequest ?? false,
        userId: USER_ID,
        turnId: TURN_ID,
      }),
    },
    ...(input.approvalToken !== undefined ? { approvalToken: input.approvalToken } : {}),
    backend,
    nowMs,
  };
  return { agentInput, backend, searchArgs, ticketArgs };
}

function searchThenAnswer(): readonly ScriptedStep[] {
  return [
    { toolCalls: [{ toolName: SEARCH_NAME, args: { query: 'sso setup' } }] },
    { text: 'Here is the SSO setup guide.' },
  ];
}

describe('support-agent wp5 gaps', () => {
  it('1a: multi-turn context preserves ordered user and assistant history', async () => {
    const { agentInput, backend } = setup({
      steps: searchThenAnswer(),
      userText: 'What about it for SSO?',
      history: [
        { role: 'user', text: 'How do I reset my password?' },
        { role: 'assistant', text: 'Use settings.' },
      ],
      searchResults: [resultsOutput({ coverage: 'partial', uniqueEvidenceAdded: 0, evidenceTokensAdded: 0 })],
    });
    const run = await createSupportAgent().run(agentInput);
    expect(run.stopReason).toEqual({ kind: 'completed' });
    expect(backend.calls[0]?.messages.map((message) => ({ role: message.role, text: message.text }))).toEqual([
      { role: 'user', text: 'How do I reset my password?' },
      { role: 'assistant', text: 'Use settings.' },
      { role: 'user', text: 'What about it for SSO?' },
    ]);
  });

  it('1b: fresh question carries no prior-context prefix', async () => {
    const { agentInput, backend } = setup({
      steps: [{ text: 'Open settings to reset your password.' }],
      userText: 'How do I reset my password?',
      history: [],
    });
    const run = await createSupportAgent().run(agentInput);
    expect(run.text).toBe('Open settings to reset your password.');
    const messages = backend.calls[0]?.messages ?? [];
    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) {
      expect(message.text.startsWith('Prior context')).toBe(false);
    }
  });

  it('1c: current file parts survive the neutral model seam', async () => {
    const { agentInput, backend } = setup({
      steps: [{ text: 'I can review the attachment.' }],
      userText: 'Please review this file.',
      currentMessage: {
        role: 'user',
        text: 'Please review this file.',
        parts: [
          { type: 'text', text: 'Please review this file.' },
          { type: 'file', url: 'https://files.example.test/guide.pdf', mediaType: 'application/pdf', filename: 'guide.pdf' },
        ],
      },
    });
    await createSupportAgent().run(agentInput);
    expect(backend.calls[0]?.messages.at(-1)?.parts).toContainEqual({
      type: 'file',
      url: 'https://files.example.test/guide.pdf',
      mediaType: 'application/pdf',
      filename: 'guide.pdf',
    });
  });

  it('2: capability variants use exact physical retrieval usage', async () => {
    const variants: ReadonlyArray<{
      readonly name: string;
      readonly capabilities: ModelToolCapabilities;
      readonly expectedRetrievals: number;
    }> = [
      { name: 'default', capabilities: DEFAULT_TOOL_CAPABILITIES, expectedRetrievals: 2 },
      { name: 'emulated', capabilities: EMULATED_EXAMPLE_CAPABILITIES, expectedRetrievals: 2 },
      {
        name: 'serial',
        capabilities: { ...DEFAULT_TOOL_CAPABILITIES, parallelCalls: false },
        expectedRetrievals: 1,
      },
    ];
    for (const variant of variants) {
      const { agentInput } = setup({
        steps: searchThenAnswer(),
        userText: 'Where is the SSO setup guide?',
        capabilities: variant.capabilities,
        searchResults: [resultsOutput({
          coverage: 'partial',
          physicalRetrievalsUsed: variant.capabilities.parallelCalls ? 2 : 1,
          uniqueEvidenceAdded: 0,
          evidenceTokensAdded: 0,
        })],
      });
      const run = await createSupportAgent().run(agentInput);
      expect(run.stopReason).toEqual({ kind: 'completed' });
      expect(run.summary.searchCalls).toBe(1);
      expect(run.summary.physicalRetrievals).toBe(variant.expectedRetrievals);
    }
  });

  it('3: flag reader defaults and constants stay honest', () => {
    expect(readSupportAgentFlag({ get: () => undefined })).toEqual({
      enabled: true,
      source: 'default',
    });
    for (const raw of ['0', 'false']) {
      expect(readSupportAgentFlag({ get: () => raw })).toEqual({
        enabled: false,
        source: 'env',
      });
    }
    for (const raw of ['1', 'true']) {
      expect(readSupportAgentFlag({ get: () => raw })).toEqual({
        enabled: true,
        source: 'env',
      });
    }
    expect(SUPPORT_AGENT_FLAG_OWNER.length).toBeGreaterThan(0);
    expect(SUPPORT_AGENT_DEFAULT.length).toBeGreaterThan(0);
    expect(SUPPORT_AGENT_ROLLBACK.length).toBeGreaterThan(0);
    expect(SUPPORT_AGENT_REMOVAL.length).toBeGreaterThan(0);
    expect(SUPPORT_AGENT_ROLLBACK).toContain('SUPPORT_AGENT_ENABLED=0');
    expect(SUPPORT_AGENT_REMOVAL.toLowerCase()).toContain('remov');
  });

  it('4: evidence counters read top-level production shape and hide search next step', async () => {
    const { agentInput, backend } = setup({
      steps: searchThenAnswer(),
      userText: 'Where is the password policy?',
      searchResults: [
        {
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
          evidenceTokensAdded: 100,
        },
      ],
    });
    const run = await createSupportAgent().run(agentInput);
    expect(run.stopReason).toEqual({ kind: 'completed' });
    expect(run.summary.searchPlans).toBe(1);
    expect(run.summary.physicalRetrievals).toBe(2);
    expect(run.summary.uniqueEvidenceChunks).toBe(2);
    expect(run.summary.evidenceTokens).toBe(100);
    expect(backend.calls[1]?.activeTools).not.toContain(SEARCH_NAME);
  });

  it('5: rollback turn configuration completes with zero side effects', async () => {
    const { agentInput, searchArgs, ticketArgs } = setup({
      steps: [{ text: 'Refunds are issued within 30 days.' }],
      userText: 'What is the refund policy?',
      enabledTools: new Set<string>(),
      budgetOverrides: { maxModelSteps: 1 },
    });
    const run = await createSupportAgent().run(agentInput);
    expect(searchArgs).toEqual([]);
    expect(ticketArgs).toEqual([]);
    expect(run.summary.totalToolCalls).toBe(0);
    expect(run.ticketCreated).toBe(false);
    expect(['no_tool_requested', 'completed']).toContain(run.stopReason.kind);
  });

  it('6: clarification answer passes text through with zero searches', async () => {
    const { agentInput, searchArgs } = setup({
      steps: [{ text: 'Which product does this concern?' }],
      userText: 'What does the documentation say about refunds?',
    });
    const run = await createSupportAgent().run(agentInput);
    expect(searchArgs).toEqual([]);
    expect(run.summary.searchCalls).toBe(0);
    expect(run.text).toBe('Which product does this concern?');
    expect(['completed', 'no_tool_requested']).toContain(run.stopReason.kind);
  });

  it('7: cumulative input and output token ceilings stop the run before release', async () => {
    const inputLimited = setup({
      steps: [{ text: 'partial input answer', inputTokens: 6, outputTokens: 1 }],
      userText: 'Explain the policy.',
      budgetOverrides: { maxInputTokens: 5 },
    });
    const inputRun = await createSupportAgent().run(inputLimited.agentInput);
    expect(inputRun.stopReason).toEqual({ kind: 'max_input_tokens', used: 6, limit: 5 });
    expect(inputRun.text).toBe('');
    expect(inputRun.summary.inputTokensUsed).toBe(6);

    const outputLimited = setup({
      steps: [{ text: 'partial output answer', inputTokens: 1, outputTokens: 6 }],
      userText: 'Explain the policy.',
      budgetOverrides: { maxOutputTokens: 5 },
    });
    const outputRun = await createSupportAgent().run(outputLimited.agentInput);
    expect(outputRun.stopReason).toEqual({ kind: 'max_output_tokens', used: 6, limit: 5 });
    expect(outputRun.text).toBe('');
    expect(outputRun.summary.outputTokensUsed).toBe(6);
  });

  it('8: every non-success model finish reason stops before releasing an answer', async () => {
    for (const finishReason of ['length', 'content_filter', 'error', 'other'] as const) {
      const { agentInput } = setup({
        steps: [{ text: 'unsafe or truncated text', finishReason }],
        userText: 'Explain the policy.',
      });
      const run = await createSupportAgent().run(agentInput);
      expect(run.stopReason).toEqual({
        kind:
          finishReason === 'length'
            ? 'model_length'
            : finishReason === 'content_filter'
              ? 'model_content_filter'
              : finishReason === 'error'
                ? 'model_error'
                : 'model_other',
      });
      expect(run.text).toBe('');
    }
  });

  it('9: a scoped approval token resumes a denied write without model-supplied credentials', async () => {
    const ticketArgs = {
      question: 'The documentation is missing the SSO setup steps.',
      attempted: ['searched SSO setup'],
      documentationSearched: ['SSO setup'],
    };
    const approvals = new InMemoryToolApprovalPolicy({
      explicitTicketRequest: false,
      userId: USER_ID,
      turnId: TURN_ID,
    });
    const approval = approvals.issueApproval({
      toolName: TICKET_NAME,
      normalizedArgs: normalizeToolArgs(ticketArgs),
      userId: USER_ID,
      turnId: TURN_ID,
      ttlMs: 60_000,
      nowMs: Date.now(),
    });
    const { agentInput, ticketArgs: seenTicketArgs } = setup({
      steps: [
        { toolCalls: [{ toolName: SEARCH_NAME, args: { query: 'sso setup' } }] },
        { toolCalls: [{ toolName: TICKET_NAME, args: ticketArgs }] },
        { text: 'I opened a knowledge ticket.' },
      ],
      userText: 'I still need help with this documentation gap.',
      approvals,
      approvalToken: approval.token,
      searchResults: [noMatchOutput()],
      ticketResults: [{ ticketId: 'TKT-approved', status: 'created' }],
    });
    const run = await createSupportAgent().run(agentInput);
    expect(run.ticketCreated).toBe(true);
    expect(run.ticketId).toBe('TKT-approved');
    expect(seenTicketArgs).toEqual([ticketArgs]);
  });
});

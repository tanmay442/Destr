import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgentRunBudget } from '../../agent-budget';
import { DEFAULT_TOOL_CAPABILITIES } from '../../model-tool-capabilities';
import { asUntypedTool, DefaultToolCatalog } from '../../tool-catalog';
import {
  createInMemoryTraceWriter,
  type AgentToolDefinition,
  type EvidenceChunk,
} from '../../tool-contract';
import { InMemoryToolApprovalPolicy } from '../../tool-approval';
import { createSupportAgent, type SupportAgentInput } from '../../support-agent';
import { createScriptedBackend, type ScriptedStep } from '../../scripted-model';
import {
  assertExactlyOneTerminal,
  EVENT_VERSION,
  mapAgentStopToTerminal,
  validateEventOrdering,
} from '../agent-event';
import { createInMemoryTraceWriter as createEventWriter } from '../trace-writer';
import { redactEvent } from '../redaction';

const USER_ID = 'user-terminal';
const TURN_ID = 'turn-terminal';
const SEARCH_NAME = 'searchDocumentation';
const TICKET_NAME = 'createKnowledgeTicket';

const searchOutputSchema = z.object({
  sets: z.array(
    z.object({
      kind: z.enum(['results', 'no_match', 'error']),
      ticketEligible: z.boolean(),
      coverage: z.enum(['sufficient', 'partial', 'none']),
      executedQueries: z.array(z.string()),
    }),
  ),
  plansUsed: z.number().int().min(0),
  physicalRetrievalsUsed: z.number().int().min(0),
  uniqueEvidenceAdded: z.number().int().min(0),
  evidenceTokensAdded: z.number().int().min(0),
});
type SearchStubOutput = z.infer<typeof searchOutputSchema>;

const ticketOutputSchema = z.object({
  ticketId: z.string().nullable(),
  status: z.enum(['created', 'error', 'denied']),
  message: z.string().max(500).optional(),
});

function setup(input: {
  readonly steps: readonly ScriptedStep[];
  readonly userText: string;
  readonly runId: string;
  readonly searchResults?: SearchStubOutput[];
  readonly explicitTicketRequest?: boolean;
}): { readonly agentInput: SupportAgentInput; readonly events: ReturnType<typeof createEventWriter> } {
  const events = createEventWriter();
  const searchQueue = [...(input.searchResults ?? [])];
  const searchDef: AgentToolDefinition<{ query: string }, SearchStubOutput> = {
    name: SEARCH_NAME,
    description: 'Stub search.',
    inputSchema: z.object({ query: z.string().min(1) }),
    outputSchema: searchOutputSchema,
    inputExamples: [{ query: 'example' }],
    guidance: { useWhen: ['testing'], doNotUseWhen: ['production'], resultSemantics: ['stub'] },
    policy: { effect: 'read', idempotent: true, requiresApproval: false, maxCallsPerTurn: 10, timeoutMs: 5000 },
    create: () => async () => {
      const next = searchQueue.shift();
      if (next === undefined) throw new Error('search stub exhausted');
      return next;
    },
  };
  const ticketDef: AgentToolDefinition<{ question: string }, z.infer<typeof ticketOutputSchema>> = {
    name: TICKET_NAME,
    description: 'Stub ticket.',
    inputSchema: z.object({ question: z.string().min(1) }),
    outputSchema: ticketOutputSchema,
    inputExamples: [{ question: 'example' }],
    guidance: { useWhen: ['testing'], doNotUseWhen: ['production'], resultSemantics: ['stub'] },
    policy: { effect: 'write', idempotent: false, requiresApproval: true, maxCallsPerTurn: 10, timeoutMs: 5000 },
    create: () => async () => ({ ticketId: null, status: 'denied' as const, message: 'Approval denied for this turn.' }),
  };
  const nowMs = Date.now();
  const agentInput: SupportAgentInput = {
    runId: input.runId,
    actor: { userId: USER_ID },
    turnId: TURN_ID,
    userText: input.userText,
    history: [],
    systemPrompt: 'You are a support agent.',
    signal: new AbortController().signal,
    budget: createAgentRunBudget({ nowMs, deadlineInMs: 60_000, finalizeReserveMs: 0 }),
    capabilities: DEFAULT_TOOL_CAPABILITIES,
    enabledTools: new Set([SEARCH_NAME, TICKET_NAME]),
    catalog: new DefaultToolCatalog([asUntypedTool(searchDef), asUntypedTool(ticketDef)]),
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
    backend: createScriptedBackend(input.steps),
    nowMs,
    eventTrace: events,
    eventContext: { traceId: `trace-${input.runId}`, configurationFingerprint: 'test-config-v1' },
  };
  return { agentInput, events };
}

function resultsOutput(): SearchStubOutput {
  const sets: SearchStubOutput['sets'] = [{ kind: 'results', ticketEligible: false, coverage: 'sufficient', executedQueries: ['q1'] }];
  return {
    sets,
    plansUsed: 1,
    physicalRetrievalsUsed: 2,
    uniqueEvidenceAdded: 1,
    evidenceTokensAdded: 60,
  };
}

describe('support-agent typed terminal emission', () => {
  it('maps every stop to the documented terminal vocabulary', () => {
    expect(mapAgentStopToTerminal({ kind: 'completed' })).toBe('answered_qualified');
    expect(mapAgentStopToTerminal({ kind: 'no_tool_requested' })).toBe('answered_qualified');
    expect(mapAgentStopToTerminal({ kind: 'approval_interrupted', toolName: 't', callId: 'c' })).toBe('approval_required');
    expect(mapAgentStopToTerminal({ kind: 'cancelled' })).toBe('cancelled_by_user');
    expect(mapAgentStopToTerminal({ kind: 'deadline_exceeded', nowMs: 2, deadlineAt: 1 })).toBe('deadline_exhausted');
    expect(mapAgentStopToTerminal({ kind: 'timeout', timeoutMs: 1 })).toBe('dependency_error');
    expect(mapAgentStopToTerminal({ kind: 'model_error' })).toBe('dependency_error');
    expect(mapAgentStopToTerminal({ kind: 'max_total_tool_calls', used: 1, limit: 1 })).toBe('answered_qualified');
    expect(mapAgentStopToTerminal({ kind: 'duplicate_tool_call', toolName: 't', normalizedArgs: 'a' })).toBe('answered_qualified');
  });

  it.each([
    {
      name: 'greeting',
      userText: 'Hello!',
      steps: [{ text: 'Hi there.' }],
      searchResults: [] as SearchStubOutput[],
      expectedTerminal: 'answered_qualified',
    },
    {
      name: 'completed search',
      userText: 'What is the refund policy?',
      steps: [
        { toolCalls: [{ toolName: SEARCH_NAME, args: { query: 'refund policy' } }] },
        { text: 'Refunds within thirty days.' },
      ],
      searchResults: [resultsOutput()],
      expectedTerminal: 'answered_qualified',
    },
    {
      name: 'denied ticket',
      userText: 'Please file a ticket about the outage.',
      steps: [{ toolCalls: [{ toolName: TICKET_NAME, args: { question: 'outage' } }] }],
      searchResults: [] as SearchStubOutput[],
      expectedTerminal: 'approval_required',
    },
    {
      name: 'duplicate stop',
      userText: 'Tell me about refunds.',
      steps: [
        { toolCalls: [{ toolName: SEARCH_NAME, args: { query: 'same' } }] },
        { toolCalls: [{ toolName: SEARCH_NAME, args: { query: 'same' } }] },
      ],
      searchResults: [
        {
          sets: [{ kind: 'results', ticketEligible: false, coverage: 'partial', executedQueries: ['q1'] }],
          plansUsed: 1,
          physicalRetrievalsUsed: 2,
          uniqueEvidenceAdded: 0,
          evidenceTokensAdded: 0,
        } as SearchStubOutput,
      ],
      expectedTerminal: 'answered_qualified',
    },
  ] as Array<{ name: string; userText: string; steps: ScriptedStep[]; searchResults: SearchStubOutput[]; expectedTerminal: string }>)('$name emits exactly one terminal event', async ({ userText, steps, searchResults, expectedTerminal }) => {
    const runId = `run-terminal-${userText.length}`;
    const { agentInput, events } = setup({
      steps: steps as unknown as ScriptedStep[],
      userText,
      runId,
      searchResults,
      explicitTicketRequest: userText.includes('ticket'),
    });
    const run = await createSupportAgent().run(agentInput);
    const terminal = assertExactlyOneTerminal(events.events);
    expect(terminal.terminalState).toBe(expectedTerminal);
    expect(terminal.stopReasonCode).toBe(run.stopReason.kind);
    expect(terminal.turnId).toBe(TURN_ID);
    expect(terminal.traceId).toBe(`trace-${runId}`);
    expect(terminal.eventVersion).toBe(EVENT_VERSION);
    expect(terminal.toolCatalogVersion).toBe('tool-catalog-v1');
    validateEventOrdering(events.events);
    for (const event of events.events) {
      const redacted = redactEvent(event);
      expect(JSON.stringify(redacted)).not.toContain(userText);
    }
  });

  it('emits step and tool lifecycle events with bounded attributes', async () => {
    const { agentInput, events } = setup({
      steps: [
        { toolCalls: [{ toolName: SEARCH_NAME, args: { query: 'refund policy' } }] },
        { text: 'Done.' },
      ],
      userText: 'What is the refund policy?',
      runId: 'run-terminal-lifecycle',
      searchResults: [resultsOutput()],
    });
    await createSupportAgent().run(agentInput);
    const types = events.events.map((event) => event.eventType);
    expect(types).toEqual([
      'turn.started',
      'model.step.started',
      'tool.started',
      'tool.terminal',
      'model.step.completed',
      'model.step.started',
      'model.step.completed',
      'turn.terminal',
    ]);
    const toolTerminal = events.events.find((event) => event.eventType === 'tool.terminal');
    expect(toolTerminal).toMatchObject({ toolName: SEARCH_NAME, resultKind: 'success' });
  });

  it('pre-aborted run emits started before its exactly-one terminal', async () => {
    const events = createEventWriter();
    const { agentInput } = setup({
      steps: [{ text: 'Hi.' }],
      userText: 'Hello!',
      runId: 'run-terminal-preabort',
      searchResults: [] as SearchStubOutput[],
    });
    const controller = new AbortController();
    controller.abort();
    const run = await createSupportAgent().run({ ...agentInput, signal: controller.signal, eventTrace: events });
    expect(run.stopReason.kind).toBe('cancelled');
    const terminal = assertExactlyOneTerminal(events.events);
    expect(terminal.terminalState).toBe('cancelled_by_user');
    validateEventOrdering(events.events);
    expect(events.events[0]?.eventType).toBe('turn.started');
  });

  it('unexpected backend failure still closes the turn before rethrowing', async () => {
    const { agentInput, events } = setup({
      steps: [{ error: 'fail' }],
      userText: 'What is the refund policy?',
      runId: 'run-terminal-throw',
      searchResults: [resultsOutput()],
    });
    await expect(createSupportAgent().run(agentInput)).rejects.toThrow('scripted failure');
    const terminal = assertExactlyOneTerminal(events.events);
    expect(terminal.terminalState).toBe('dependency_error');
    expect(terminal.stopReasonCode).toBe('model_error');
    validateEventOrdering(events.events);
  });

  it('emits nothing when no sink is attached (backward compatible)', async () => {
    const { agentInput } = setup({
      steps: [{ text: 'Hi.' }],
      userText: 'Hello!',
      runId: 'run-terminal-absent',
      searchResults: [] as SearchStubOutput[],
    });
    const { eventTrace: _eventTrace, ...withoutTrace } = agentInput;
    void _eventTrace;
    const run = await createSupportAgent().run(withoutTrace);
    expect(run.stopReason.kind).toBe('no_tool_requested');
  });
});

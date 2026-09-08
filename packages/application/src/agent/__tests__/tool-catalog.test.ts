import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ok } from '@app/domain';
import type { AppConfig } from '@app/domain/app-config';
import {
  createDefaultBudget,
  createInMemoryTraceWriter,
  type AgentToolContext,
  type AgentToolDefinition,
} from '../tool-contract';
import {
  DEFAULT_TOOL_CAPABILITIES,
  EMULATED_EXAMPLE_CAPABILITIES,
} from '../model-tool-capabilities';
import { TOOL_CATALOG_VERSION, asUntypedTool, createToolCatalog } from '../tool-catalog';
import {
  SEARCH_TOOL_NAME,
  createSearchDocumentationTool,
} from '../tools/search-documentation';
import {
  TICKET_TOOL_NAME,
  createKnowledgeTicketTool,
} from '../tools/create-knowledge-ticket';

const TEST_TOOL_NAME = 'testOnlyReadTool';
const TEST_TOOL_DESCRIPTION = 'Test-only read tool for catalog composition.';

const testInputSchema = z.object({ echo: z.string() });
const testOutputSchema = z.object({ echoed: z.string() });

function makeTestOnlyTool(name = TEST_TOOL_NAME): AgentToolDefinition<{ echo: string }, { echoed: string }> {
  return {
    name,
    description: TEST_TOOL_DESCRIPTION,
    inputSchema: testInputSchema,
    outputSchema: testOutputSchema,
    inputExamples: [{ echo: 'alpha' }, { echo: 'beta' }, { echo: 'gamma' }],
    guidance: {
      useWhen: ['verifying catalog composition in tests'],
      doNotUseWhen: ['production turns'],
      resultSemantics: ['echoes the input string'],
    },
    policy: {
      effect: 'read',
      idempotent: true,
      requiresApproval: false,
      maxCallsPerTurn: 5,
      timeoutMs: 1000,
    },
    create: () => async (input) => ({ echoed: input.echo }),
  };
}

function makeContext(): AgentToolContext {
  return {
    actor: { userId: 'user_test' },
    turnId: 'turn_test',
    signal: new AbortController().signal,
    budget: createDefaultBudget({ maxTotalToolCalls: 10 }),
    evidence: {
      seenChunkKeys: new Set<string>(),
      addEvidence: (chunks) => chunks,
    },
    trace: createInMemoryTraceWriter(),
    approvals: {
      isExplicitlyRequested: () => false,
      isApproved: () => false,
      issueApproval: () => ({ token: 'token_test', expiresAt: 0 }),
    },
  };
}

function makeSearchDefinition() {
  return createSearchDocumentationTool({
    searchChunks: async () => {
      throw new Error('searchChunks unused in catalog test');
    },
    agenticSearch: async () => {
      throw new Error('agenticSearch unused in catalog test');
    },
    cfg: {} as AppConfig,
    effectiveMode: 'normal',
  });
}

function makeTicketDefinition() {
  return createKnowledgeTicketTool({
    createTicket: async () => ok({ ticketId: 'TKT-test', status: 'created' as const }),
    userResolver: async () => ({}),
    rateLimit: {
      check: async () => ({ ok: true as const, remaining: 1, resetMs: 60_000 }),
    },
  });
}

describe('ToolCatalog depth (WP-3)', () => {
  it('throws on duplicate tool registration', () => {
    expect(() => createToolCatalog([asUntypedTool(makeTestOnlyTool()), asUntypedTool(makeTestOnlyTool())])).toThrow(
      `duplicate tool name "${TEST_TOOL_NAME}"`,
    );
  });

  it('ignores unknown names in enabledTools', () => {
    const catalog = createToolCatalog([asUntypedTool(makeTestOnlyTool())]);
    const built = catalog.buildForRun({
      context: makeContext(),
      capabilities: DEFAULT_TOOL_CAPABILITIES,
      enabledTools: new Set([TEST_TOOL_NAME, 'doesNotExist']),
    });
    expect(built.tools.has(TEST_TOOL_NAME)).toBe(true);
    expect(built.tools.has('doesNotExist')).toBe(false);
    expect(built.tools.size).toBe(1);
  });

  it('omits disabled tools from the built set', () => {
    const catalog = createToolCatalog([asUntypedTool(makeSearchDefinition()), asUntypedTool(makeTicketDefinition())]);
    const built = catalog.buildForRun({
      context: makeContext(),
      capabilities: DEFAULT_TOOL_CAPABILITIES,
      enabledTools: new Set([SEARCH_TOOL_NAME]),
    });
    expect(built.tools.has(SEARCH_TOOL_NAME)).toBe(true);
    expect(built.tools.has(TICKET_TOOL_NAME)).toBe(false);
  });

  it('emits compact guidance headings for enabled tools only', () => {
    const catalog = createToolCatalog([asUntypedTool(makeSearchDefinition()), asUntypedTool(makeTicketDefinition())]);
    const built = catalog.buildForRun({
      context: makeContext(),
      capabilities: DEFAULT_TOOL_CAPABILITIES,
      enabledTools: new Set([SEARCH_TOOL_NAME]),
    });
    expect(built.guidanceBlock).toContain(`## ${SEARCH_TOOL_NAME}`);
    expect(built.guidanceBlock).not.toContain(`## ${TICKET_TOOL_NAME}`);
  });

  it('keeps descriptions unchanged under native input-example capabilities', () => {
    const catalog = createToolCatalog([asUntypedTool(makeTestOnlyTool())]);
    const built = catalog.buildForRun({
      context: makeContext(),
      capabilities: DEFAULT_TOOL_CAPABILITIES,
      enabledTools: new Set([TEST_TOOL_NAME]),
    });
    const tool = built.tools.get(TEST_TOOL_NAME);
    expect(tool?.description).toBe(TEST_TOOL_DESCRIPTION);
    expect(tool?.inputSchema).toBe(testInputSchema);
    expect(tool?.outputSchema).toBe(testOutputSchema);
    expect(tool?.inputExamples).toEqual([
      { input: { echo: 'alpha' } },
      { input: { echo: 'beta' } },
      { input: { echo: 'gamma' } },
    ]);
    expect(tool?.strict).toBe(true);
  });

  it('appends at most 2 input examples under emulated capabilities', () => {
    const catalog = createToolCatalog([asUntypedTool(makeTestOnlyTool())]);
    const built = catalog.buildForRun({
      context: makeContext(),
      capabilities: { ...EMULATED_EXAMPLE_CAPABILITIES, strictSchemas: 'emulated' },
      enabledTools: new Set([TEST_TOOL_NAME]),
    });
    const description = built.tools.get(TEST_TOOL_NAME)?.description ?? '';
    expect(description).toContain('Input examples:');
    expect(description).toContain('alpha');
    expect(description).toContain('beta');
    expect(description).not.toContain('gamma');
    expect(built.tools.get(TEST_TOOL_NAME)?.inputExamples).toBeUndefined();
    expect(built.tools.get(TEST_TOOL_NAME)?.strict).toBe(false);
  });

  it('leaves descriptions unchanged under unsupported input-example capabilities', () => {
    const catalog = createToolCatalog([asUntypedTool(makeTestOnlyTool())]);
    const built = catalog.buildForRun({
      context: makeContext(),
      capabilities: { ...DEFAULT_TOOL_CAPABILITIES, inputExamples: 'unsupported', strictSchemas: 'unsupported' },
      enabledTools: new Set([TEST_TOOL_NAME]),
    });
    const tool = built.tools.get(TEST_TOOL_NAME);
    expect(tool?.description).toBe(TEST_TOOL_DESCRIPTION);
    expect(tool?.inputExamples).toBeUndefined();
    expect(tool?.strict).toBeUndefined();
  });

  it('registers a test-only read tool alongside real definitions and executes it', async () => {
    const search = makeSearchDefinition();
    const ticket = makeTicketDefinition();
    const testOnly = makeTestOnlyTool();
    const catalog = createToolCatalog([asUntypedTool(search), asUntypedTool(ticket), asUntypedTool(testOnly)]);
    const built = catalog.buildForRun({
      context: makeContext(),
      capabilities: DEFAULT_TOOL_CAPABILITIES,
      enabledTools: new Set([SEARCH_TOOL_NAME, TICKET_TOOL_NAME, TEST_TOOL_NAME]),
    });
    expect(built.tools.has(SEARCH_TOOL_NAME)).toBe(true);
    expect(built.tools.has(TICKET_TOOL_NAME)).toBe(true);
    const testBuilt = built.tools.get(TEST_TOOL_NAME);
    expect(testBuilt?.policyEffect).toBe('read');
    const output = await testBuilt?.execute(
      { echo: 'hello' },
      { callId: 'call_test', signal: new AbortController().signal },
    );
    expect(output).toEqual({ echoed: 'hello' });
    expect(built.guidanceBlock).toContain(`## ${TEST_TOOL_NAME}`);
  });

  it('reports catalog version tool-catalog-v1', () => {
    const catalog = createToolCatalog([asUntypedTool(makeTestOnlyTool())]);
    const built = catalog.buildForRun({
      context: makeContext(),
      capabilities: DEFAULT_TOOL_CAPABILITIES,
      enabledTools: new Set([TEST_TOOL_NAME]),
    });
    expect(TOOL_CATALOG_VERSION).toBe('tool-catalog-v1');
    expect(built.catalogVersion).toBe('tool-catalog-v1');
  });
});

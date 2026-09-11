/**
 * Project-owned support agent loop.
 *
 * Owns: model selection is delegated to the injected AgentModelBackend,
 * instructions (systemPrompt), prepared per-step active-tool selection, stop
 * enforcement, step tracing (AgentEvent), and the final candidate output.
 *
 * Key policy decisions (deterministic, no model calls for policy):
 * - The injected bounded history and current message are passed to each model
 *   step, including validated file metadata.
 * - Greeting heuristic: bare chit-chat (hi/hello/thanks/...) with no ticket
 *   intent exposes zero tools, so toolChoice is 'none'.
 * - Ticket visibility: createKnowledgeTicket is hidden once created, and
 *   hidden until either an explicit ticket request or a ticket-eligible
 *   no_match has been observed. Ticket-only restriction (toolChoice pinned
 *   to the ticket tool) applies only when the ticket is visible but search
 *   is unavailable (budget-exhausted), which keeps "search first, then
 *   escalate" flows working.
 * - Search visibility: searchDocumentation is hidden once maxSearchCalls is
 *   reached or evidence is sufficient (a sufficient-coverage set plus at
 *   least one evidence chunk, past step 1).
 * - Search usage comes from the compat adapter's exact orchestrator or
 *   retrieval diagnostics, including plans, physical retrievals, and evidence.
 * - Schema repair: at most ONE retry per tool call, with the same args and
 *   no mutation. A second input_validation failure is recorded as a tool
 *   error and the loop continues (no invented repair).
 * - Tool calls naming a tool outside the current active set (unknown or
 *   policy-hidden) are ignored, never executed and never fatal. Budget
 *   ceilings are still enforced for known tools even when hidden, so a
 *   model cannot dodge max_search_calls via a hidden tool.
 * - Calls are validated and executed one at a time, so a ceiling sees the
 *   calls already executed in the same step. An exceeding call stops the
 *   run WITHOUT being executed; earlier calls in the step stand.
 * - Unexpected backend errors (anything other than AbortError/TimeoutError)
 *   propagate to the caller: agent-state has no failure event this loop may
 *   produce, so the integrator sets failed status. No lying stop event is
 *   appended on that path.
 */
import type { ModelToolCapabilities } from './model-tool-capabilities';
import { SEARCH_TOOL_NAME } from './tools/search-documentation';
import { TICKET_TOOL_NAME } from './tools/create-knowledge-ticket';

export { SEARCH_TOOL_NAME, TICKET_TOOL_NAME };
import type { AgentModelBackend, AgentModelMessage } from './model-backend';
import type { ToolCatalog } from './tool-catalog';
import type { AgentToolContext } from './tool-contract';
import { canStartNewModelStep, childTimeoutMs } from './agent-budget';
import type { AgentRunBudget as FullBudget } from './agent-budget';
import {
  detectDuplicateCall,
  normalizeArgsHash,
  pickEarliestStop,
  type AgentStopReason,
  type SeenToolCall,
} from './agent-stop';
import { appendEvent, createInitialRunState, type AgentRunState } from './agent-state';
import {
  summarizeRun,
  type AgentRunSummary,
  type AgentStepTelemetry,
} from './agent-telemetry';

const TOOL_RESULT_TRUNCATE_CHARS = 2000;
const MODEL_P95_ESTIMATE_MS = 8000;

const EXPLICIT_TICKET_REQUEST =
  /(open|file|create|raise|submit).*ticket|escalate|talk to .*human/i;

const GREETING =
  /^(hi|hello|hey|yo|thanks|thank you|good\s(?:morning|afternoon|evening)|bye|goodbye|how are you)[\s!?.]*$/i;

const TOOL_ERROR_KINDS: ReadonlySet<string> = new Set([
  'input_validation',
  'output_validation',
  'timeout',
  'cancelled',
  'denied',
  'budget_exceeded',
  'failed',
  'outcome_unknown',
]);

export interface SupportAgentInput {
  readonly runId: string;
  readonly actor: { readonly userId: string };
  readonly turnId: string;
  readonly userText: string;
  readonly history: readonly AgentModelMessage[];
  readonly currentMessage?: AgentModelMessage | undefined;
  readonly systemPrompt: string;
  readonly signal: AbortSignal;
  readonly budget: FullBudget;
  readonly capabilities: ModelToolCapabilities;
  readonly enabledTools: ReadonlySet<string>;
  readonly catalog: ToolCatalog;
  readonly toolContext: Omit<AgentToolContext, 'signal' | 'budget'>;
  readonly approvalToken?: string | undefined;
  readonly initialSearchUsage?: {
    readonly plansUsed: number;
    readonly physicalRetrievalsUsed: number;
    readonly uniqueEvidenceAdded: number;
    readonly evidenceTokensAdded: number;
  } | undefined;
  readonly backend: AgentModelBackend;
  readonly nowMs?: number;
}

export interface SupportAgentRun {
  readonly runId: string;
  readonly text: string;
  readonly stopReason: AgentStopReason;
  readonly state: AgentRunState;
  readonly summary: AgentRunSummary;
  readonly stepTelemetry: readonly AgentStepTelemetry[];
  readonly ticketCreated: boolean;
  readonly ticketId: string | null;
}

export interface SupportAgent {
  run(input: SupportAgentInput): Promise<SupportAgentRun>;
}

export function createSupportAgent(): SupportAgent {
  return { run };
}

interface RunTotals {
  readonly text: string;
  readonly ticketCreated: boolean;
  readonly ticketId: string | null;
  readonly searchPlans: number;
  readonly searchCalls: number;
  readonly physicalRetrievals: number;
  readonly uniqueEvidenceChunks: number;
  readonly evidenceTokens: number;
  readonly inputTokensUsed: number | null;
  readonly outputTokensUsed: number | null;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { readonly name?: unknown }).name === 'AbortError')
  );
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError' && !isAbortError(error);
}

function toToolErrorKind(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const kind = (error as { readonly kind?: unknown }).kind;
    if (typeof kind === 'string' && TOOL_ERROR_KINDS.has(kind)) return kind;
  }
  return 'failed';
}

function describeSchemaPlaceholder(schema: unknown): unknown {
  if (typeof schema === 'object' && schema !== null) {
    const description = (schema as { readonly description?: unknown }).description;
    if (typeof description === 'string' && description.length > 0) {
      return { description };
    }
  }
  return {};
}

function linkSignal(parent: AbortSignal): AbortSignal {
  const controller = new AbortController();
  if (parent.aborted) {
    controller.abort();
  } else {
    parent.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller.signal;
}

function resolveMessages(
  userText: string,
  history: readonly AgentModelMessage[],
  currentMessage?: AgentModelMessage | undefined,
): AgentModelMessage[] {
  const messages = [...history];
  messages.push(currentMessage ?? { role: 'user', text: userText });
  return messages;
}

function truncateResult(value: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(value) ?? 'null';
  } catch {
    json = '"[unserializable]"';
  }
  return json.length > TOOL_RESULT_TRUNCATE_CHARS
    ? json.slice(0, TOOL_RESULT_TRUNCATE_CHARS)
    : json;
}

function readResultSets(result: unknown): Array<Record<string, unknown>> {
  if (typeof result !== 'object' || result === null) return [];
  const sets = (result as { readonly sets?: unknown }).sets;
  if (!Array.isArray(sets)) return [];
  return sets.filter(
    (set): set is Record<string, unknown> => typeof set === 'object' && set !== null,
  );
}

function readNonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

function readSearchUsage(value: unknown): {
  plansUsed: number;
  physicalRetrievalsUsed: number;
  uniqueEvidenceAdded: number;
  evidenceTokensAdded: number;
} {
  if (typeof value !== 'object' || value === null) {
    return { plansUsed: 0, physicalRetrievalsUsed: 0, uniqueEvidenceAdded: 0, evidenceTokensAdded: 0 };
  }
  const record = value as Record<string, unknown>;
  return {
    plansUsed: readNonNegativeInt(record.plansUsed),
    physicalRetrievalsUsed: readNonNegativeInt(record.physicalRetrievalsUsed),
    uniqueEvidenceAdded: readNonNegativeInt(record.uniqueEvidenceAdded),
    evidenceTokensAdded: readNonNegativeInt(record.evidenceTokensAdded),
  };
}

function isApprovalDeniedResult(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.status === 'denied' && typeof record.message === 'string' && /explicit user intent|approval/i.test(record.message);
}

function parseTicketCreated(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) return null;
  const record = result as Record<string, unknown>;
  if (record['status'] !== 'created') return null;
  const ticketId = record['ticketId'];
  return typeof ticketId === 'string' ? ticketId : null;
}

async function run(input: SupportAgentInput): Promise<SupportAgentRun> {
  const startedAtMs = Date.now();
  let state = createInitialRunState(input.runId);
  const telemetry: AgentStepTelemetry[] = [];
  let modelSteps = 0;

  const finish = (stopReason: AgentStopReason, totals: RunTotals): SupportAgentRun => {
    const endedAtMs = Date.now();
    const summary = summarizeRun({
      runId: input.runId,
      steps: telemetry,
      stopReason,
      startedAtMs,
      endedAtMs,
      searchPlans: totals.searchPlans,
      searchCalls: totals.searchCalls,
      physicalRetrievals: totals.physicalRetrievals,
      uniqueEvidenceChunks: totals.uniqueEvidenceChunks,
      evidenceTokens: totals.evidenceTokens,
      inputTokensUsed: totals.inputTokensUsed,
      outputTokensUsed: totals.outputTokensUsed,
      estimatedCostMicros: null,
    });
    // Telemetry holds one row per executed tool call (plus a step row when
    // the model made no calls) so summarizeRun call totals stay exact;
    // restore the true model-step count here.
    const corrected: AgentRunSummary = Object.freeze({ ...summary, totalModelSteps: modelSteps });
    if (stopReason.kind === 'completed' || stopReason.kind === 'no_tool_requested') {
      state = appendEvent(state, { type: 'run_completed', atMs: endedAtMs, summary: corrected });
    } else {
      state = appendEvent(state, { type: 'stopped', reason: stopReason, atMs: endedAtMs });
    }
    return Object.freeze({
      runId: input.runId,
      text: totals.text,
      stopReason: Object.freeze({ ...stopReason }),
      state,
      summary: corrected,
      stepTelemetry: Object.freeze([...telemetry]),
      ticketCreated: totals.ticketCreated,
      ticketId: totals.ticketId,
    });
  };

  const emptyTotals = (text: string): RunTotals => ({
    text,
    ticketCreated: false,
    ticketId: null,
    searchPlans: 0,
    searchCalls: 0,
    physicalRetrievals: 0,
    uniqueEvidenceChunks: 0,
    evidenceTokens: 0,
    inputTokensUsed: null,
    outputTokensUsed: null,
  });

  if (input.signal.aborted) {
    state = appendEvent(state, {
      type: 'run_started',
      runId: input.runId,
      atMs: input.nowMs ?? startedAtMs,
    });
    return finish({ kind: 'cancelled' }, emptyTotals(''));
  }

  // Request-scoped tool instances: the catalog is built ONCE because created
  // tools close over this context.
  const combinedSignal = linkSignal(input.signal);
  const toolContext: AgentToolContext = {
    ...input.toolContext,
    signal: combinedSignal,
    budget: input.budget,
  };
  const built = input.catalog.buildForRun({
    context: toolContext,
    capabilities: input.capabilities,
    enabledTools: input.enabledTools,
  });

  state = appendEvent(state, {
    type: 'run_started',
    runId: input.runId,
    atMs: input.nowMs ?? startedAtMs,
  });

  const messages: AgentModelMessage[] = resolveMessages(input.userText, input.history, input.currentMessage);
  const explicitTicketRequest = EXPLICIT_TICKET_REQUEST.test(input.userText);
  const isGreeting = GREETING.test(input.userText.trim()) && !explicitTicketRequest;

  const seenCalls: SeenToolCall[] = [];
  const executedByTool = new Map<string, number>();
  let executedTotal = 0;
  let lastText = '';
  let ticketCreated = false;
  let ticketId: string | null = null;
  let searchCalls = 0;
  let searchPlans = input.initialSearchUsage?.plansUsed ?? 0;
  let physicalRetrievals = input.initialSearchUsage?.physicalRetrievalsUsed ?? 0;
  let uniqueEvidenceChunks = input.initialSearchUsage?.uniqueEvidenceAdded ?? 0;
  let evidenceTokens = input.initialSearchUsage?.evidenceTokensAdded ?? 0;
  let inputTokensUsed: number | null = null;
  let outputTokensUsed: number | null = null;
  let eligibleNoMatch = false;
  let sawSufficientCoverage = false;

  const snapshot = (): RunTotals => ({
    text: lastText,
    ticketCreated,
    ticketId,
    searchPlans,
    searchCalls,
    physicalRetrievals,
    uniqueEvidenceChunks,
    evidenceTokens,
    inputTokensUsed,
    outputTokensUsed,
  });

  for (let stepNumber = 1; ; stepNumber += 1) {
    const now = Date.now();
    if (input.signal.aborted) {
      return finish({ kind: 'cancelled' }, snapshot());
    }
    if (now > input.budget.deadlineAt) {
      return finish(
        { kind: 'deadline_exceeded', nowMs: now, deadlineAt: input.budget.deadlineAt },
        snapshot(),
      );
    }
    if (!canStartNewModelStep(input.budget, stepNumber - 1, now)) {
      return finish(
        { kind: 'max_model_steps', used: stepNumber - 1, limit: input.budget.maxModelSteps },
        snapshot(),
      );
    }
    if (input.budget.maxInputTokens !== undefined && inputTokensUsed !== null && inputTokensUsed >= input.budget.maxInputTokens) {
      return finish({ kind: 'max_input_tokens', used: inputTokensUsed, limit: input.budget.maxInputTokens }, snapshot());
    }
    if (input.budget.maxOutputTokens !== undefined && outputTokensUsed !== null && outputTokensUsed >= input.budget.maxOutputTokens) {
      return finish({ kind: 'max_output_tokens', used: outputTokensUsed, limit: input.budget.maxOutputTokens }, snapshot());
    }

    // prepareStep: active-tool selection BEFORE model step N (1-indexed).
    const searchExhausted = searchCalls >= input.budget.maxSearchCalls;
    const retrievalBudgetExhausted =
      searchPlans >= input.budget.maxSearchPlans ||
      physicalRetrievals >= input.budget.maxPhysicalRetrievals ||
      uniqueEvidenceChunks >= input.budget.maxUniqueEvidenceChunks ||
      evidenceTokens >= input.budget.maxEvidenceTokens;
    const evidenceSufficient =
      sawSufficientCoverage && uniqueEvidenceChunks >= 1 && stepNumber > 1;
    const searchHidden = searchExhausted || retrievalBudgetExhausted || evidenceSufficient;
    const ticketVisible = !ticketCreated && (explicitTicketRequest || eligibleNoMatch);
    const searchAvailable = built.tools.has(SEARCH_TOOL_NAME) && !searchHidden;
    // Approval-restricted: ticket visible while search is unavailable.
    const ticketOnly = ticketVisible && !searchAvailable && built.tools.has(TICKET_TOOL_NAME);

    let activeNames: string[];
    if (isGreeting) {
      activeNames = [];
    } else if (ticketOnly) {
      activeNames = [TICKET_TOOL_NAME];
    } else {
      activeNames = [...built.tools.keys()].filter((name) => {
        if (name === TICKET_TOOL_NAME) return ticketVisible;
        if (name === SEARCH_TOOL_NAME) return !searchHidden;
        return true;
      });
    }
    const activeSet = new Set(activeNames);
    const toolChoice =
      activeNames.length === 0
        ? ('none' as const)
        : ticketOnly
          ? Object.freeze({ tool: TICKET_TOOL_NAME })
          : ('auto' as const);

    const backendTools: Record<string, { readonly description: string; readonly inputSchemaJson: unknown }> = {};
    for (const name of activeNames) {
      const tool = built.tools.get(name);
      if (tool === undefined) continue;
      backendTools[name] = {
        description: tool.description,
        inputSchemaJson: describeSchemaPlaceholder(tool.inputSchema),
      };
    }

    const stepStartedAt = Date.now();
    state = appendEvent(state, {
      type: 'step_started',
      stepNumber,
      activeTools: Object.freeze([...activeNames]),
      atMs: stepStartedAt,
    });

    const timeoutMs = childTimeoutMs(input.budget, Date.now(), MODEL_P95_ESTIMATE_MS);
    let step: Awaited<ReturnType<AgentModelBackend['generateStep']>>;
    try {
      step = await input.backend.generateStep({
        system: input.systemPrompt,
        messages: [...messages],
        activeTools: backendTools,
        toolChoice,
        signal: input.signal,
        timeoutMs,
        ...(input.budget.maxOutputTokens !== undefined
          ? { maxOutputTokens: Math.max(0, input.budget.maxOutputTokens - (outputTokensUsed ?? 0)) }
          : {}),
      });
    } catch (error) {
      if (isAbortError(error) || input.signal.aborted) {
        return finish({ kind: 'cancelled' }, snapshot());
      }
      if (isTimeoutError(error)) {
        return finish({ kind: 'timeout', timeoutMs }, snapshot());
      }
      // Unexpected backend failure: propagate without a stop event. The
      // caller/integrator owns failed status; recording a stop reason here
      // would mislabel the outcome.
      throw error;
    }

    modelSteps = stepNumber;
    if (step.inputTokens !== null) inputTokensUsed = (inputTokensUsed ?? 0) + step.inputTokens;
    if (step.outputTokens !== null) outputTokensUsed = (outputTokensUsed ?? 0) + step.outputTokens;
    let modelStopReason: AgentStopReason | null = null;
    if (input.budget.maxInputTokens !== undefined && inputTokensUsed !== null && inputTokensUsed > input.budget.maxInputTokens) {
      modelStopReason = {
        kind: 'max_input_tokens',
        used: inputTokensUsed,
        limit: input.budget.maxInputTokens,
      };
    } else if (input.budget.maxOutputTokens !== undefined && outputTokensUsed !== null && outputTokensUsed > input.budget.maxOutputTokens) {
      modelStopReason = {
        kind: 'max_output_tokens',
        used: outputTokensUsed,
        limit: input.budget.maxOutputTokens,
      };
    } else if (step.finishReason === 'length') {
      modelStopReason = { kind: 'model_length' };
    } else if (step.finishReason === 'content_filter') {
      modelStopReason = { kind: 'model_content_filter' };
    } else if (step.finishReason === 'error') {
      modelStopReason = { kind: 'model_error' };
    } else if (step.finishReason === 'other') {
      modelStopReason = { kind: 'model_other' };
    }

    const executedThisStep: Array<{
      readonly toolCallId: string;
      readonly toolName: string;
      readonly physicalRetrievals: number;
      readonly uniqueEvidenceAdded: number;
      readonly evidenceTokensAdded: number;
    }> = [];
    let approvalStop: AgentStopReason | null = null;
    let searchBudgetStop: AgentStopReason | null = null;

    const recordStepTelemetry = (): void => {
      const stepActive = Object.freeze([...activeNames]);
      const durationMs = Math.max(0, Date.now() - stepStartedAt);
      if (executedThisStep.length === 0) {
        telemetry.push(
          Object.freeze({
            stepNumber,
            activeTools: stepActive,
            toolName: null,
            durationMs,
            inputTokens: step.inputTokens,
            outputTokens: step.outputTokens,
            cacheReadTokens: step.cacheReadTokens,
            cacheWriteTokens: step.cacheWriteTokens,
            cacheStatus: step.cacheStatus,
            physicalRetrievals: 0,
            evidenceAdded: 0,
          }),
        );
        return;
      }
      for (const call of executedThisStep) {
        const isSearch = call.toolName === SEARCH_TOOL_NAME;
        telemetry.push(
          Object.freeze({
            stepNumber,
            activeTools: stepActive,
            toolName: call.toolName,
            durationMs,
            inputTokens: step.inputTokens,
            outputTokens: step.outputTokens,
            cacheReadTokens: step.cacheReadTokens,
            cacheWriteTokens: step.cacheWriteTokens,
            cacheStatus: step.cacheStatus,
            physicalRetrievals: isSearch ? call.physicalRetrievals : 0,
            evidenceAdded: isSearch ? call.uniqueEvidenceAdded : 0,
          }),
        );
      }
    };

    const stopMidStep = (reason: AgentStopReason): SupportAgentRun => {
      state = appendEvent(state, {
        type: 'step_finished',
        stepNumber,
        toolCalls: executedThisStep.length,
        atMs: Date.now(),
      });
      recordStepTelemetry();
      return finish(reason, snapshot());
    };

    if (modelStopReason !== null) return stopMidStep(modelStopReason);
    if (step.text !== '') {
      lastText = step.text;
      messages.push({ role: 'assistant', text: step.text });
    }

    // Validate and execute one call at a time, so ceilings observe the calls
    // already executed in this step. An exceeding call stops the run WITHOUT
    // being executed; earlier calls in the step stand.
    for (const call of step.toolCalls) {
      if (!built.tools.has(call.toolName)) {
        continue;
      }
      // Search budget is enforced even when the tool is hidden (a hidden
      // search is usually hidden *because* the budget is exhausted), so a
      // model cannot dodge max_search_calls via a hidden tool.
      if (call.toolName === SEARCH_TOOL_NAME) {
        if (searchCalls >= input.budget.maxSearchCalls) {
          return stopMidStep({
            kind: 'max_search_calls',
            used: searchCalls,
            limit: input.budget.maxSearchCalls,
          });
        }
        if (searchPlans >= input.budget.maxSearchPlans) {
          return stopMidStep({ kind: 'max_search_plans', used: searchPlans, limit: input.budget.maxSearchPlans });
        }
        if (physicalRetrievals >= input.budget.maxPhysicalRetrievals) {
          return stopMidStep({ kind: 'max_physical_retrievals', used: physicalRetrievals, limit: input.budget.maxPhysicalRetrievals });
        }
        if (uniqueEvidenceChunks >= input.budget.maxUniqueEvidenceChunks) {
          return stopMidStep({ kind: 'max_unique_evidence_chunks', used: uniqueEvidenceChunks, limit: input.budget.maxUniqueEvidenceChunks });
        }
        if (evidenceTokens >= input.budget.maxEvidenceTokens) {
          return stopMidStep({ kind: 'max_evidence_tokens', used: evidenceTokens, limit: input.budget.maxEvidenceTokens });
        }
      }
      if (!activeSet.has(call.toolName)) {
        continue;
      }
      const tool = built.tools.get(call.toolName);
      if (tool === undefined) continue;
      const normalizedInput = tool.inputSchema.safeParse(call.args);
      const argsHash = normalizeArgsHash(normalizedInput.success ? normalizedInput.data : call.args);
      const usedForTool = executedByTool.get(call.toolName) ?? 0;
      const toolLimit = input.budget.maxCallsByTool[call.toolName] ?? Number.POSITIVE_INFINITY;
      if (executedTotal >= input.budget.maxTotalToolCalls) {
        return stopMidStep({
          kind: 'max_total_tool_calls',
          used: executedTotal,
          limit: input.budget.maxTotalToolCalls,
        });
      }
      if (usedForTool >= toolLimit) {
        return stopMidStep({
          kind: 'max_calls_for_tool',
          toolName: call.toolName,
          used: usedForTool,
          limit: toolLimit,
        });
      }
      if (
        detectDuplicateCall(seenCalls, { toolName: call.toolName, normalizedArgsHash: argsHash })
      ) {
        return stopMidStep({
          kind: 'duplicate_tool_call',
          toolName: call.toolName,
          normalizedArgs: argsHash,
        });
      }
      seenCalls.push({ toolName: call.toolName, normalizedArgsHash: argsHash });
      state = appendEvent(state, {
        type: 'tool_called',
        toolName: call.toolName,
        callId: call.toolCallId,
        argsHash,
        atMs: Date.now(),
      });
      const callStartedAt = Date.now();
      let result: unknown;
      let failedKind: string | null = null;
      try {
        result = await tool.execute(call.args, {
          callId: call.toolCallId,
          signal: combinedSignal,
          ...(input.approvalToken !== undefined ? { approvalToken: input.approvalToken } : {}),
        });
      } catch (firstError) {
        if (toToolErrorKind(firstError) === 'input_validation') {
          // Single repair attempt with identical args, no mutation.
          try {
            result = await tool.execute(call.args, {
              callId: call.toolCallId,
              signal: combinedSignal,
              ...(input.approvalToken !== undefined ? { approvalToken: input.approvalToken } : {}),
            });
          } catch (secondError) {
            failedKind = toToolErrorKind(secondError);
            result = secondError;
          }
        } else {
          failedKind = toToolErrorKind(firstError);
          result = firstError;
        }
      }
      executedTotal += 1;
      executedByTool.set(call.toolName, (executedByTool.get(call.toolName) ?? 0) + 1);
      const searchUsage = call.toolName === SEARCH_TOOL_NAME && failedKind === null
        ? readSearchUsage(result)
        : { plansUsed: 0, physicalRetrievalsUsed: 0, uniqueEvidenceAdded: 0, evidenceTokensAdded: 0 };
      if (call.toolName === SEARCH_TOOL_NAME) {
        searchCalls += 1;
        searchPlans += searchUsage.plansUsed;
        physicalRetrievals += searchUsage.physicalRetrievalsUsed;
        uniqueEvidenceChunks += searchUsage.uniqueEvidenceAdded;
        evidenceTokens += searchUsage.evidenceTokensAdded;
        if (searchPlans > input.budget.maxSearchPlans) {
          searchBudgetStop = { kind: 'max_search_plans', used: searchPlans, limit: input.budget.maxSearchPlans };
        } else if (physicalRetrievals > input.budget.maxPhysicalRetrievals) {
          searchBudgetStop = { kind: 'max_physical_retrievals', used: physicalRetrievals, limit: input.budget.maxPhysicalRetrievals };
        } else if (uniqueEvidenceChunks > input.budget.maxUniqueEvidenceChunks) {
          searchBudgetStop = { kind: 'max_unique_evidence_chunks', used: uniqueEvidenceChunks, limit: input.budget.maxUniqueEvidenceChunks };
        } else if (evidenceTokens > input.budget.maxEvidenceTokens) {
          searchBudgetStop = { kind: 'max_evidence_tokens', used: evidenceTokens, limit: input.budget.maxEvidenceTokens };
        }
      }
      executedThisStep.push({
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        physicalRetrievals: searchUsage.physicalRetrievalsUsed,
        uniqueEvidenceAdded: searchUsage.uniqueEvidenceAdded,
        evidenceTokensAdded: searchUsage.evidenceTokensAdded,
      });
      state = appendEvent(state, {
        type: 'tool_finished',
        toolName: call.toolName,
        callId: call.toolCallId,
        kind: failedKind ?? 'success',
        durationMs: Math.max(0, Date.now() - callStartedAt),
      });
      messages.push({
        role: 'assistant',
        text: `Tool ${call.toolName} returned: ${truncateResult(result)}`,
      });

      if (failedKind === null) {
        if (call.toolName === SEARCH_TOOL_NAME) {
          const sets = readResultSets(result);
          for (const set of sets) {
            if (set['kind'] === 'no_match' && set['ticketEligible'] === true) {
              eligibleNoMatch = true;
            }
            if (set['coverage'] === 'sufficient') sawSufficientCoverage = true;
          }
        }
        if (call.toolName === TICKET_TOOL_NAME) {
          const created = parseTicketCreated(result);
          if (created !== null) {
            ticketCreated = true;
            ticketId = created;
          }
        }
      }
      const deniedApprovalResult = call.toolName === TICKET_TOOL_NAME && isApprovalDeniedResult(result);
      if (
        call.toolName === TICKET_TOOL_NAME &&
        ((failedKind === 'denied' || failedKind === 'budget_exceeded') || deniedApprovalResult) &&
        approvalStop === null
      ) {
        // No approval is possible on this path, so the write genuinely cannot
        // proceed; anything else is a recoverable tool error and the loop
        // continues.
        state = appendEvent(state, {
          type: 'approval_interrupted',
          toolName: call.toolName,
          callId: call.toolCallId,
          atMs: Date.now(),
        });
        approvalStop = {
          kind: 'approval_interrupted',
          toolName: call.toolName,
          callId: call.toolCallId,
        };
      }
      if (searchBudgetStop !== null) return stopMidStep(searchBudgetStop);
    }

    state = appendEvent(state, {
      type: 'step_finished',
      stepNumber,
      toolCalls: executedThisStep.length,
      atMs: Date.now(),
    });
    recordStepTelemetry();

    if (input.signal.aborted) {
      return finish({ kind: 'cancelled' }, snapshot());
    }
    const afterRound = Date.now();
    if (afterRound > input.budget.deadlineAt) {
      return finish(
        { kind: 'deadline_exceeded', nowMs: afterRound, deadlineAt: input.budget.deadlineAt },
        snapshot(),
      );
    }
    if (approvalStop !== null) {
      return finish(approvalStop, snapshot());
    }
    if (executedThisStep.length === 0) {
      return finish(
        stepNumber === 1 ? { kind: 'no_tool_requested' } : { kind: 'completed' },
        snapshot(),
      );
    }
    if (executedTotal >= input.budget.maxTotalToolCalls) {
      const limits: [AgentStopReason, ...AgentStopReason[]] = [
        {
          kind: 'max_total_tool_calls',
          used: executedTotal,
          limit: input.budget.maxTotalToolCalls,
        },
      ];
      if (stepNumber >= input.budget.maxModelSteps) {
        limits.push({
          kind: 'max_model_steps',
          used: stepNumber,
          limit: input.budget.maxModelSteps,
        });
      }
      return finish(pickEarliestStop(limits), snapshot());
    }
    if (stepNumber >= input.budget.maxModelSteps) {
      return finish(
        pickEarliestStop([
          { kind: 'max_model_steps', used: stepNumber, limit: input.budget.maxModelSteps },
        ]),
        snapshot(),
      );
    }
    // Otherwise continue to the next model step.
  }
}

import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadDotEnv } from '../../packages/infrastructure/src/config/dotenv-bootstrap';
import {
  AGENT_GOLDEN_CORPUS,
  type AgentGoldenCase,
  type AgentGoldenCategoryKey,
  type AgentGoldenGrounding,
  type AgentGoldenResultClass,
  type AgentGoldenSideEffect,
} from './agent-golden-corpus';
import { SYNTHETIC_MOCK_CORPUS_VERSION } from './mock-corpus';
import {
  buildAgentEvalReport,
  corpusFingerprint,
  fingerprint,
  newRunId,
  type AgentCaseReport,
} from './agent-report';
import {
  DEFAULT_TOOL_CAPABILITIES,
} from '../../packages/application/src/agent/model-tool-capabilities';
import { TOOL_CATALOG_VERSION } from '../../packages/application/src/agent/tool-catalog';
import { createScriptedBackend, type ScriptedStep } from '../../packages/application/src/agent/scripted-model';
import { createInMemoryTraceWriter } from '../../packages/application/src/agent/observability/trace-writer';
import {
  buildCasePlan,
  executeCase,
  type SupportAgentRunShape,
} from './agent-trajectory';

loadDotEnv();

const REPORT_DIR = 'eval';
const REPORT_PATH = join(REPORT_DIR, 'agent-adversarial-report.json');
const CANARY = 'canary-eval-fault-9f31';

function gitInfo(): { commit: string; dirty: boolean } {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() || 'unknown';
    const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=no'], { encoding: 'utf8' }).trim();
    return { commit, dirty: status.length > 0 };
  } catch {
    return { commit: 'unknown', dirty: true };
  }
}

function synthCase(input: {
  readonly id: string;
  readonly userText: string;
  readonly primaryCategory: AgentGoldenCategoryKey;
  readonly categories?: readonly AgentGoldenCategoryKey[];
  readonly expectedTools?: readonly ('searchDocumentation' | 'createKnowledgeTicket')[];
  readonly forbiddenTools?: readonly ('searchDocumentation' | 'createKnowledgeTicket')[];
  readonly resultClass?: AgentGoldenResultClass;
  readonly sideEffect?: AgentGoldenSideEffect;
  readonly grounding?: AgentGoldenGrounding;
  readonly injectedFault?: AgentGoldenCase['injectedFault'];
  readonly expectedDocIds?: readonly number[];
}): AgentGoldenCase {
  return {
    id: input.id,
    categories: input.categories ?? [input.primaryCategory],
    primaryCategory: input.primaryCategory,
    userText: input.userText,
    expectedTools: input.expectedTools ?? ['searchDocumentation'],
    forbiddenTools: input.forbiddenTools ?? ['createKnowledgeTicket'],
    resultClass: input.resultClass ?? 'results',
    sideEffect: input.sideEffect ?? 'none',
    grounding: input.grounding ?? 'verified',
    ...(input.injectedFault !== undefined ? { injectedFault: input.injectedFault } : {}),
    ...(input.expectedDocIds !== undefined ? { expectedDocIds: input.expectedDocIds } : { expectedDocIds: [101] as const }),
  };
}

interface AdversarialFault {
  readonly id: string;
  readonly golden: AgentGoldenCase;
  readonly steps?: readonly ScriptedStep[];
  readonly planOverride?: {
    readonly explicitTicket?: boolean;
    readonly ticketDenied?: boolean;
    readonly budgetMaxTotalToolCalls?: number;
    readonly budgetMaxCallsForTicket?: number;
    readonly deadlineInMs?: number;
  };
  readonly expect: (report: AgentCaseReport, observed: SupportAgentRunShape | null) => readonly string[];
}

function expectPassed(report: AgentCaseReport): readonly string[] {
  return report.passed ? [] : [`grading-failed stop=${report.stopReason} errors=${report.errorCategories.join(',')}`];
}

const FAULTS: readonly AdversarialFault[] = [
  {
    id: 'embedding-timeout',
    golden: synthCase({ id: 'adv-embedding-timeout', userText: 'What is the refund policy?', primaryCategory: 'infra_error', resultClass: 'error', grounding: 'unverified', injectedFault: 'embedding_timeout' }),
    expect: expectPassed,
  },
  {
    id: 'vector-error',
    golden: synthCase({ id: 'adv-vector-error', userText: 'How do I submit a claim?', primaryCategory: 'infra_error', resultClass: 'error', grounding: 'unverified', injectedFault: 'vector_error' }),
    expect: expectPassed,
  },
  {
    id: 'lexical-error',
    golden: synthCase({ id: 'adv-lexical-error', userText: 'What does the dental plan cover?', primaryCategory: 'infra_error', resultClass: 'error', grounding: 'unverified', injectedFault: 'lexical_error' }),
    expect: expectPassed,
  },
  {
    id: 'reranker-malformed-fallback',
    golden: synthCase({ id: 'adv-reranker-malformed', userText: 'What is the dress policy?', primaryCategory: 'doc_search', resultClass: 'results', injectedFault: 'reranker_malformed' }),
    expect: (report) => report.passed && report.outcomeStates.includes('degraded') ? [] : [`expected degraded results, stop=${report.stopReason}`],
  },
  {
    id: 'planner-malformed-fallback',
    golden: synthCase({ id: 'adv-planner-malformed', userText: 'How do I reset my password?', primaryCategory: 'doc_search', resultClass: 'results', injectedFault: 'planner_malformed' }),
    expect: expectPassed,
  },
  {
    id: 'model-malformed-args-repair',
    golden: synthCase({ id: 'adv-malformed-args', userText: 'What is the claim deadline?', primaryCategory: 'doc_search', resultClass: 'results' }),
    steps: [
      { toolCalls: [{ toolCallId: 'adv-malformed-args-call-1', toolName: 'searchDocumentation', args: {} }] },
      { text: 'Recovered after invalid arguments.' },
    ],
    expect: (report) => {
      const errors: string[] = [];
      if (report.stopReason !== 'completed') errors.push(`stop=${report.stopReason}`);
      if (report.argumentsValid !== false) errors.push('expected argumentsValid=false after input_validation repair');
      return errors;
    },
  },
  {
    id: 'ticket-rate-limit',
    golden: synthCase({ id: 'adv-ticket-rate-limit', userText: 'Please file a ticket about the outage.', primaryCategory: 'ticket_denied', expectedTools: ['createKnowledgeTicket'], forbiddenTools: ['searchDocumentation'], resultClass: 'no_tool', sideEffect: 'none', grounding: 'not_required' }),
    steps: [
      { toolCalls: [{ toolCallId: 'adv-ticket-rate-limit-call-1', toolName: 'createKnowledgeTicket', args: { question: 'File ticket', attempted: [], documentationSearched: [] } }] },
      { text: 'Ticket filing is rate limited right now.' },
    ],
    planOverride: { explicitTicket: true, ticketDenied: true },
    expect: (report) => {
      const errors: string[] = [];
      if (report.stopReason !== 'completed') errors.push(`stop=${report.stopReason}`);
      if (report.actualTools.includes('createKnowledgeTicket') === false) errors.push('ticket call never executed');
      return errors;
    },
  },
  {
    id: 'ticket-writer-error',
    golden: synthCase({ id: 'adv-ticket-writer-error', userText: 'Please file a ticket about the outage.', primaryCategory: 'ticket_denied', expectedTools: ['createKnowledgeTicket'], forbiddenTools: ['searchDocumentation'], resultClass: 'no_tool', sideEffect: 'none', grounding: 'not_required' }),
    steps: [
      { toolCalls: [{ toolCallId: 'adv-ticket-writer-error-call-1', toolName: 'createKnowledgeTicket', args: { question: 'File ticket', attempted: [], documentationSearched: [] } }] },
      { text: 'Ticket filing failed safely.' },
    ],
    planOverride: { explicitTicket: true },
    expect: (report) => (report.stopReason === 'completed' ? [] : [`stop=${report.stopReason}`]),
  },
  {
    id: 'cancellation-mid-run',
    golden: synthCase({ id: 'adv-cancellation', userText: 'What is the refund policy?', primaryCategory: 'doc_search', resultClass: 'results' }),
    steps: [
      { toolCalls: [{ toolCallId: 'adv-cancellation-call-1', toolName: 'searchDocumentation', args: { query: 'refund policy' } }] },
      { error: 'abort' },
    ],
    expect: (report) => (report.stopReason === 'cancelled' ? [] : [`stop=${report.stopReason}`]),
  },
  {
    id: 'deadline-expiry',
    golden: synthCase({ id: 'adv-deadline', userText: 'What is the refund policy?', primaryCategory: 'budget_timeout', resultClass: 'results', grounding: 'unverified' }),
    steps: [{ toolCalls: [{ toolCallId: 'adv-deadline-call-1', toolName: 'searchDocumentation', args: { query: 'refund policy' } }] }],
    planOverride: { deadlineInMs: 0, budgetMaxTotalToolCalls: 100 },
    expect: (report) => (report.stopReason === 'deadline_exceeded' ? [] : [`stop=${report.stopReason}`]),
  },
  {
    id: 'prompt-injection-in-doc',
    golden: synthCase({ id: 'adv-injection', userText: `What is the refund policy ${CANARY}?`, primaryCategory: 'injection', resultClass: 'results', grounding: 'verified', injectedFault: 'injection' }),
    expect: expectPassed,
  },
  {
    id: 'fake-citation-in-doc',
    golden: synthCase({ id: 'adv-fake-citation', userText: 'How do I submit a claim?', primaryCategory: 'doc_search', resultClass: 'results', injectedFault: 'fake_citation' }),
    expect: expectPassed,
  },
];

async function runFault(spec: AdversarialFault): Promise<AgentCaseReport> {
  const startedAt = performance.now();
  const eventWriter = createInMemoryTraceWriter();
  let observed: SupportAgentRunShape | null = null;
  const steps = spec.steps ?? buildCasePlan(spec.golden, 1).steps;
  const backend = createScriptedBackend(steps);
  const report = await executeCase({
    goldenCase: spec.golden,
    caseIndex: 1,
    backend,
    capabilities: DEFAULT_TOOL_CAPABILITIES,
    runPrefix: 'adversarial',
    ...(spec.planOverride !== undefined ? { planOverride: spec.planOverride } : {}),
    eventTraceOverride: eventWriter,
    observe: (run) => {
      observed = run;
    },
  });
  const faults = [...spec.expect(report, observed)];
  const serialized = JSON.stringify({ events: eventWriter.events, state: observed === null ? null : (observed as SupportAgentRunShape).state });
  const redacted = !serialized.includes(CANARY);
  if (!redacted) faults.push('redaction');
  const totalMs = performance.now() - startedAt;
  return {
    ...report,
    caseId: spec.id,
    latency: { totalMs },
    errorCategories: [...report.errorCategories, ...faults],
    passed: faults.length === 0 && report.errorCategories.length === 0,
    notes: `${report.notes ?? ''}; redacted=${redacted}`.trim(),
  };
}

async function main(): Promise<void> {
  const { commit, dirty } = gitInfo();
  const results: AgentCaseReport[] = [];
  for (const spec of FAULTS) {
    const result = await runFault(spec);
    results.push(result);
    console.log(`[eval:agent:adversarial] ${spec.id} passed=${result.passed}`);
  }
  const failed = results.filter((result) => !result.passed);
  const report = buildAgentEvalReport({
    gate: 'adversarial',
    runId: newRunId(),
    commit,
    dirty,
    modelId: 'production-tool-modules',
    providerId: 'scripted',
    toolCapabilityMode: 'native',
    toolContractVersion: TOOL_CATALOG_VERSION,
    documentSnapshotId: SYNTHETIC_MOCK_CORPUS_VERSION,
    configFingerprint: fingerprint(['config.v1', 'agent-adversarial', `corpus=${corpusFingerprint(AGENT_GOLDEN_CORPUS)}`]),
    corpus: AGENT_GOLDEN_CORPUS,
    results,
    status: failed.length === 0 ? 'pass' : 'fail',
    statusReason: failed.length === 0 ? 'all chaos faults handled safely through production tool modules' : `${failed.length} chaos faults unsafe`,
  });
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`adversarial report written to ${REPORT_PATH}: cases=${results.length} failed=${failed.length}`);
  if (failed.length > 0) process.exit(1);
  console.log('OVERALL: PASS');
}

main().catch((error: unknown) => {
  console.error('[eval:agent:adversarial] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

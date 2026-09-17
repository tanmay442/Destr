import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { loadDotEnv } from '../../packages/infrastructure/src/config/dotenv-bootstrap';
import {
  AGENT_GOLDEN_CORPUS,
  type AgentGoldenCase,
} from './agent-golden-corpus';
import { SYNTHETIC_MOCK_CORPUS_VERSION } from './mock-corpus';
import {
  buildAgentEvalReport,
  corpusFingerprint,
  fingerprint,
  newRunId,
  percentile,
  type AgentCaseReport,
} from './agent-report';
import { DEFAULT_TOOL_CAPABILITIES } from '../../packages/application/src/agent/model-tool-capabilities';
import { TOOL_CATALOG_VERSION } from '../../packages/application/src/agent/tool-catalog';
import { createScriptedBackend } from '../../packages/application/src/agent/scripted-model';
import {
  buildCasePlan,
  executeCase,
  type SupportAgentRunShape,
} from './agent-trajectory';

loadDotEnv();

const REPORT_DIR = 'eval';
const REPORT_PATH = join(REPORT_DIR, 'agent-cost-report.json');

function gitInfo(): { commit: string; dirty: boolean } {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() || 'unknown';
    const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=no'], { encoding: 'utf8' }).trim();
    return { commit, dirty: status.length > 0 };
  } catch {
    return { commit: 'unknown', dirty: true };
  }
}

type CostScenario = 'no_tool' | 'one_search' | 'two_search' | 'retry_backfill' | 'degraded' | 'budget_stop';

function scenarioFor(goldenCase: AgentGoldenCase): CostScenario | null {
  switch (goldenCase.primaryCategory) {
    case 'casual_no_tool':
    case 'clarification':
      return 'no_tool';
    case 'overlap_two_calls':
      return 'two_search';
    case 'backfill':
      return 'retry_backfill';
    case 'infra_error':
    case 'no_match':
      return 'degraded';
    case 'budget_timeout':
      return 'budget_stop';
    case 'doc_search':
    case 'multiturn_reference':
    case 'ticket_request':
    case 'ticket_denied':
    case 'two_subquestions':
    case 'dominant_topic':
    case 'similar_chunks':
    case 'packing_limits':
      return 'one_search';
    default:
      return null;
  }
}

interface ScenarioSample {
  readonly scenario: CostScenario;
  readonly totalMs: number;
  readonly modelSteps: number;
  readonly toolCalls: number;
  readonly searchCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly evidenceTokens: number;
  readonly stepDurations: readonly number[];
}

const MAX_PER_SCENARIO = 30;

async function main(): Promise<void> {
  const { commit, dirty } = gitInfo();
  const runId = newRunId();
  const results: AgentCaseReport[] = [];
  const samples: ScenarioSample[] = [];
  const counts: Record<CostScenario, number> = {
    no_tool: 0,
    one_search: 0,
    two_search: 0,
    retry_backfill: 0,
    degraded: 0,
    budget_stop: 0,
  };
  let index = 0;
  for (const goldenCase of AGENT_GOLDEN_CORPUS) {
    const scenario = scenarioFor(goldenCase);
    index += 1;
    if (scenario === null || counts[scenario] >= MAX_PER_SCENARIO) continue;
    counts[scenario] += 1;
    const plan = buildCasePlan(goldenCase, index);
    const backend = createScriptedBackend(plan.steps);
    let observed: SupportAgentRunShape | null = null;
    const report = await executeCase({
      goldenCase,
      caseIndex: index,
      backend,
      capabilities: DEFAULT_TOOL_CAPABILITIES,
      runPrefix: 'cost',
      observe: (run) => {
        observed = run;
      },
    });
    results.push(report);
    const run = observed as SupportAgentRunShape | null;
    samples.push({
      scenario,
      totalMs: report.latency.totalMs,
      modelSteps: run?.summary.totalModelSteps ?? 0,
      toolCalls: run?.summary.totalToolCalls ?? 0,
      searchCalls: run?.summary.searchCalls ?? 0,
      inputTokens: report.modelTokens.input ?? 0,
      outputTokens: report.modelTokens.output ?? 0,
      evidenceTokens: report.evidenceTokens,
      stepDurations: run ? run.stepTelemetry.map((row) => row.durationMs) : [],
    });
  }
  console.log('latency and cost by scenario (loop-level; retrieval stubs are synthetic):');
  for (const scenario of Object.keys(counts) as CostScenario[]) {
    const rows = samples.filter((sample) => sample.scenario === scenario);
    const totals = rows.map((row) => row.totalMs);
    const steps = rows.flatMap((row) => [...row.stepDurations]);
    const inputSum = rows.reduce((acc, row) => acc + row.inputTokens, 0);
    const outputSum = rows.reduce((acc, row) => acc + row.outputTokens, 0);
    const evidenceSum = rows.reduce((acc, row) => acc + row.evidenceTokens, 0);
    console.log(
      `  ${scenario}: n=${rows.length} totalMs p50/p95/p99=${percentile(totals, 0.5) ?? 'n/a'}/${percentile(totals, 0.95) ?? 'n/a'}/${percentile(totals, 0.99) ?? 'n/a'} ` +
        `stepMs p50=${percentile(steps, 0.5) ?? 'n/a'} input=${inputSum} output=${outputSum} evidenceTokens=${evidenceSum}`,
    );
  }
  console.log('cost: provider pricing is unconfigured, so turn cost is UNKNOWN (explicit, never zero).');
  console.log('unmeasured at loop level (explicit unknowns): planner/embedding/reranker/verifier roles, Redis ops, DB ops, SSE bytes, Vercel compute.');
  const failed = results.filter((result) => !result.passed);
  const status = failed.length === 0 ? 'pass' : 'fail';
  const report = buildAgentEvalReport({
    gate: 'cost',
    runId,
    commit,
    dirty,
    modelId: 'scripted-mock-model',
    providerId: 'scripted',
    toolCapabilityMode: 'native',
    toolContractVersion: TOOL_CATALOG_VERSION,
    documentSnapshotId: SYNTHETIC_MOCK_CORPUS_VERSION,
    configFingerprint: fingerprint(['config.v1', 'agent-cost', `corpus=${corpusFingerprint(AGENT_GOLDEN_CORPUS)}`]),
    corpus: AGENT_GOLDEN_CORPUS,
    results,
    status,
    statusReason: status === 'pass'
      ? `cost/latency sampled across ${samples.length} runs`
      : `${failed.length} sampled runs failed grading`,
  });
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`cost report written to ${REPORT_PATH}: samples=${samples.length} status=${status}`);
  if (status !== 'pass') process.exit(1);
  console.log('OVERALL: PASS');
}

main().catch((error: unknown) => {
  console.error('[eval:agent:cost] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

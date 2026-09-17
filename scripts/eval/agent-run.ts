import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { loadDotEnv } from '../../packages/infrastructure/src/config/dotenv-bootstrap';
import { AGENT_GOLDEN_CORPUS, type AgentGoldenCase } from './agent-golden-corpus';
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
  EMULATED_EXAMPLE_CAPABILITIES,
  type ModelToolCapabilities,
} from '../../packages/application/src/agent/model-tool-capabilities';
import { TOOL_CATALOG_VERSION } from '../../packages/application/src/agent/tool-catalog';
import type { AgentModelBackend } from '../../packages/application/src/agent/model-backend';
import { createScriptedBackend } from '../../packages/application/src/agent/scripted-model';
import {
  SEARCH_NAME,
  TICKET_NAME,
  buildCasePlan,
  executeCase,
} from './agent-trajectory';
import { searchDocumentationInputSchema } from '../../packages/application/src/agent/tools/search-documentation';
import { createKnowledgeTicketInputSchema } from '../../packages/application/src/agent/tools/create-knowledge-ticket';

loadDotEnv();

const REPORT_DIR = 'eval';
const MOCK_REPORT_PATH = join(REPORT_DIR, 'agent-mock-report.json');
const REAL_REPORT_PATH = join(REPORT_DIR, 'agent-real-report.json');
const REAL_REPEATS = 3;
const ESTIMATED_USD_PER_REAL_CALL = 0.005;

function gitInfo(): { commit: string; dirty: boolean } {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() || 'unknown';
    const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=no'], { encoding: 'utf8' }).trim();
    return { commit, dirty: status.length > 0 };
  } catch {
    return { commit: 'unknown', dirty: true };
  }
}

function parseModelFlag(argv: readonly string[]): string {
  const flag = argv.find((arg) => arg.startsWith('--model'));
  if (flag === undefined) throw new Error('[eval:agent] missing --model scripted|configured');
  const value = flag.includes('=') ? flag.split('=')[1] : argv[argv.indexOf(flag) + 1];
  if (value !== 'scripted' && value !== 'configured') throw new Error('[eval:agent] --model must be scripted|configured');
  return value;
}

async function runMock(): Promise<void> {
  const { commit, dirty } = gitInfo();
  const runId = newRunId();
  const results: AgentCaseReport[] = [];
  for (const [index, goldenCase] of AGENT_GOLDEN_CORPUS.entries()) {
    const capabilities = index % 2 === 0 ? DEFAULT_TOOL_CAPABILITIES : EMULATED_EXAMPLE_CAPABILITIES;
    const plan = buildCasePlan(goldenCase, index);
    const backend = createScriptedBackend(plan.steps);
    results.push(await executeCase({ goldenCase, caseIndex: index, backend, capabilities, runPrefix: 'mock' }));
    if ((index + 1) % 50 === 0) console.log(`[eval:agent:mock] ${index + 1}/${AGENT_GOLDEN_CORPUS.length}`);
  }
  const failed = results.filter((result) => !result.passed);
  const report = buildAgentEvalReport({
    gate: 'mock',
    runId,
    commit,
    dirty,
    modelId: 'scripted-mock-model',
    providerId: 'scripted',
    toolCapabilityMode: 'native+emulated(alternating)',
    toolContractVersion: TOOL_CATALOG_VERSION,
    documentSnapshotId: SYNTHETIC_MOCK_CORPUS_VERSION,
    configFingerprint: fingerprint(['config.v1', 'agent-mock', `corpus=${corpusFingerprint(AGENT_GOLDEN_CORPUS)}`]),
    corpus: AGENT_GOLDEN_CORPUS,
    results,
    status: failed.length === 0 ? 'pass' : 'fail',
    statusReason: failed.length === 0 ? 'all mock trajectories passed' : `${failed.length} mock trajectories failed`,
  });
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(MOCK_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`agent mock report written to ${MOCK_REPORT_PATH}`);
  console.log(`cases=${report.aggregate.cases} passed=${report.aggregate.passed} failed=${report.aggregate.failed}`);
  console.log(`tool recall=${report.aggregate.toolSelectionRecall?.toFixed(3) ?? 'n/a'} precision=${report.aggregate.toolSelectionPrecision?.toFixed(3) ?? 'n/a'} no-tool=${report.aggregate.noToolAccuracy?.toFixed(3) ?? 'n/a'}`);
  console.log(`latency p50/p95/p99=${report.aggregate.latencyP50 ?? 'n/a'}/${report.aggregate.latencyP95 ?? 'n/a'}/${report.aggregate.latencyP99 ?? 'n/a'} ms`);
  for (const item of failed.slice(0, 20)) {
    console.log(`  FAIL ${item.caseId} expected=${item.expectedTools.join(',') || 'none'} actual=${item.actualTools.join(',') || 'none'} stop=${item.stopReason}`);
  }
  if (failed.length > 0) process.exit(1);
  console.log('OVERALL: PASS');
}

function hasProviderKeys(provider: string): boolean {
  const env = process.env;
  if (provider === 'openai') return Boolean(env.CUSTOM_LLM_API_KEY ?? env.OPENAI_API_KEY);
  if (provider === 'google') return Boolean(env.AI_STUDIO_KEY ?? env.GOOGLE_API_KEY);
  if (provider === 'ollama') return true;
  return false;
}

function resolveProvider(): string {
  return process.env.CHAT_PROVIDER?.trim() || 'openai';
}

async function runReal(): Promise<void> {
  const { commit, dirty } = gitInfo();
  const runId = newRunId();
  const provider = resolveProvider();
  const ceilingRaw = process.env.EVAL_COST_CEILING_USD?.trim() ?? '';
  const ceiling = ceilingRaw === '' ? Number.NaN : Number(ceilingRaw);
  const authorized = process.env.EVAL_AGENT_ALLOW_KEYED === '1';
  const maxCasesRaw = process.env.EVAL_AGENT_MAX_CASES?.trim() ?? '';
  const maxCases = maxCasesRaw === '' ? AGENT_GOLDEN_CORPUS.length : Number(maxCasesRaw);
  const primaryModel = process.env.EVAL_MODEL_ID?.trim() || `${provider}-primary`;
  const fallbackModel = process.env.EVAL_FALLBACK_MODEL_ID?.trim() || '';
  const unverified = (reason: string): void => {
    const report = buildAgentEvalReport({
      gate: 'real',
      runId,
      commit,
      dirty,
      modelId: primaryModel,
      providerId: provider,
      toolCapabilityMode: 'native+emulated',
      toolContractVersion: TOOL_CATALOG_VERSION,
      documentSnapshotId: SYNTHETIC_MOCK_CORPUS_VERSION,
      configFingerprint: fingerprint(['config.v1', 'agent-real', 'unverified']),
      corpus: AGENT_GOLDEN_CORPUS,
      results: [],
      status: 'unverified',
      statusReason: reason,
    });
    mkdirSync(REPORT_DIR, { recursive: true });
    writeFileSync(REAL_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`agent real report (UNVERIFIED) written to ${REAL_REPORT_PATH}: ${reason}`);
    process.exit(2);
  };
  if (!authorized) unverified('keyed run requires EVAL_AGENT_ALLOW_KEYED=1 (explicit authorization)');
  if (!Number.isFinite(ceiling) || ceiling <= 0) unverified('keyed run requires EVAL_COST_CEILING_USD > 0');
  if (!hasProviderKeys(provider)) unverified(`no provider keys for ${provider}; flaky/unavailable provider is unverified, not a pass`);
  if (!fallbackModel) unverified('real-model matrix requires EVAL_FALLBACK_MODEL_ID (primary plus at least one fallback adapter)');
  if (!Number.isInteger(maxCases) || maxCases <= 0) unverified('EVAL_AGENT_MAX_CASES must be a positive integer');

  const { getChatModelAdapter } = await import('../../packages/infrastructure/src/llm/model');
  await import('../../packages/infrastructure/src/llm/openai-chat-service');
  await import('../../packages/infrastructure/src/llm/google-chat-service');
  await import('../../packages/infrastructure/src/llm/ollama-chat-service');
  const { createAgentModelBackend, defineAgentModelTool } = await import('../../packages/infrastructure/src/llm/agent-backend');
  const backendTools: Record<string, unknown> = {
    [SEARCH_NAME]: defineAgentModelTool({ description: 'Search documentation.', inputSchema: searchDocumentationInputSchema }),
    [TICKET_NAME]: defineAgentModelTool({ description: 'Create a knowledge ticket.', inputSchema: createKnowledgeTicketInputSchema }),
  };
  const models = [primaryModel, fallbackModel];
  const capabilityModes: ReadonlyArray<{ readonly name: string; readonly capabilities: ModelToolCapabilities }> = [
    { name: 'native', capabilities: DEFAULT_TOOL_CAPABILITIES },
    { name: 'emulated', capabilities: EMULATED_EXAMPLE_CAPABILITIES },
  ];
  const results: AgentCaseReport[] = [];
  let estimatedSpend = 0;
  let stoppedByCeiling = false;
  const ceilingUsd = ceiling;
  // Stratified selection: when bounding a keyed run, take cases round-robin
  // across primary categories (deterministic corpus order) so every behavior
  // family stays represented instead of slicing one category prefix.
  function selectCases(): readonly (typeof AGENT_GOLDEN_CORPUS)[number][] {
    if (maxCases >= AGENT_GOLDEN_CORPUS.length) return AGENT_GOLDEN_CORPUS;
    const byCategory = new Map<string, AgentGoldenCase[]>();
    for (const goldenCase of AGENT_GOLDEN_CORPUS) {
      const group = byCategory.get(goldenCase.primaryCategory) ?? [];
      group.push(goldenCase);
      byCategory.set(goldenCase.primaryCategory, group);
    }
    const selected: AgentGoldenCase[] = [];
    const groups = [...byCategory.values()];
    for (let round = 0; selected.length < maxCases; round += 1) {
      let progressed = false;
      for (const group of groups) {
        if (selected.length >= maxCases) break;
        const next = group[round];
        if (next !== undefined) {
          selected.push(next);
          progressed = true;
        }
      }
      if (!progressed) break;
    }
    return selected;
  }
  const limited = selectCases();
  for (const modelId of models) {
    let adapter: ReturnType<typeof getChatModelAdapter>;
    try {
      adapter = getChatModelAdapter(modelId);
    } catch {
      unverified(`cannot resolve model adapter for ${modelId}`);
      return;
    }
    for (const mode of capabilityModes) {
      for (let repeat = 1; repeat <= REAL_REPEATS; repeat += 1) {
        for (const [index, goldenCase] of limited.entries()) {
          if (estimatedSpend + ESTIMATED_USD_PER_REAL_CALL > ceilingUsd) {
            stoppedByCeiling = true;
            break;
          }
          let backend: AgentModelBackend;
          try {
            const raw = createAgentModelBackend({ model: adapter.model as never, tools: backendTools });
            const generate = raw.generateStep.bind(raw);
            backend = {
              generateStep: ((step: unknown) => generate(step as never)) as unknown as AgentModelBackend['generateStep'],
            };
          } catch {
            unverified(`cannot construct model backend for ${modelId}`);
            return;
          }
          const outcome = await executeCase({
            goldenCase,
            caseIndex: index,
            backend,
            capabilities: mode.capabilities,
            runPrefix: `real-${modelId}-${mode.name}-r${repeat}`,
          });
          estimatedSpend += ESTIMATED_USD_PER_REAL_CALL;
          results.push({
            ...outcome,
            caseId: `${goldenCase.id}::${modelId}::${mode.name}::r${repeat}`,
            notes: `model=${modelId} mode=${mode.name} repeat=${repeat}`,
          });
        }
        if (stoppedByCeiling) break;
      }
      if (stoppedByCeiling) break;
    }
    if (stoppedByCeiling) break;
  }
  const failed = results.filter((result) => !result.passed);
  const providerBlocked = results.length > 0
    && failed.length === results.length
    && results.every((result) => result.errorCategories.some((category) =>
      /provider|econn|fetch|socket|timeout|timed out|401|403|429|5\d\d|quota|rate limit|unavailable|refused|opencode/i.test(category),
    ));
  const report = buildAgentEvalReport({
    gate: 'real',
    runId,
    commit,
    dirty,
    modelId: `${primaryModel}+${fallbackModel}`,
    providerId: provider,
    toolCapabilityMode: 'native+emulated',
    toolContractVersion: TOOL_CATALOG_VERSION,
    documentSnapshotId: SYNTHETIC_MOCK_CORPUS_VERSION,
    configFingerprint: fingerprint([
      'config.v1',
      'agent-real',
      `models=${primaryModel},${fallbackModel}`,
      `repeats=${REAL_REPEATS}`,
      `ceilingUsd=${ceilingUsd}`,
      `selection=${limited.length < AGENT_GOLDEN_CORPUS.length ? `stratified-round-robin:${limited.length}` : 'full-corpus'}`,
      `corpus=${corpusFingerprint(AGENT_GOLDEN_CORPUS)}`,
    ]),
    corpus: AGENT_GOLDEN_CORPUS,
    results,
    status: stoppedByCeiling || providerBlocked ? 'unverified' : failed.length === 0 ? 'pass' : 'fail',
    statusReason: stoppedByCeiling
      ? `cost ceiling reached after ${results.length} runs (est $${estimatedSpend.toFixed(2)}); remainder unverified`
      : providerBlocked
        ? `keyed provider unavailable for all ${results.length} runs (see errorCategories); flaky/unavailable provider is unverified, not a pass`
        : failed.length === 0
          ? `real-model matrix complete: ${results.length} runs (est $${estimatedSpend.toFixed(2)})`
          : `${failed.length}/${results.length} real-model runs failed`,
  });
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(REAL_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`agent real report written to ${REAL_REPORT_PATH}: ${report.status} — ${report.statusReason}`);
  if (report.status === 'unverified') process.exit(2);
  if (report.status !== 'pass') process.exit(1);
  process.exit(0);
}

async function main(): Promise<void> {
  const mode = parseModelFlag(process.argv.slice(2));
  if (mode === 'scripted') {
    await runMock();
    return;
  }
  await runReal();
}

main().catch((error: unknown) => {
  console.error('[eval:agent] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

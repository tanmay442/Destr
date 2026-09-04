import { describe, it, expect, vi, afterEach } from 'vitest';

const ENV_KEYS = [
  'PARENT_CHUNK_SIZE',
  'CHILD_CHUNK_SIZE',
  'PARENT_CHILD_MODE',
  'PARENT_CHILD_WINDOW',
  'AGENT_STEP_BUDGET',
  'AGENTIC_RETRIEVE_LIMIT',
  'AGENTIC_MAX_RETRIES',
  'HYBRID_ENABLED',
  'RERANKER_PROVIDER',
  'AUX_MODEL',
  'ANSWER_CACHE_ENABLED',
  'ANSWER_CACHE_TTL_SEC',
  'AGENTIC_ENABLED',
] as const;

function stubAllTo(value: string | undefined) {
  for (const key of ENV_KEYS) vi.stubEnv(key, value);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('config/app.config env overrides', () => {
  it('applies env overrides to the static AppConfig', async () => {
    vi.stubEnv('AGENTIC_ENABLED', 'false');
    vi.stubEnv('RERANKER_PROVIDER', 'cohere');
    vi.stubEnv('ANSWER_CACHE_ENABLED', 'false');
    vi.stubEnv('ANSWER_CACHE_TTL_SEC', '7200');
    vi.stubEnv('AGENT_STEP_BUDGET', '12');
    vi.stubEnv('AGENTIC_RETRIEVE_LIMIT', '25');
    vi.stubEnv('AGENTIC_MAX_RETRIES', '3');
    vi.stubEnv('PARENT_CHUNK_SIZE', '2000');
    vi.stubEnv('CHILD_CHUNK_SIZE', '500');
    vi.stubEnv('PARENT_CHILD_MODE', 'window');
    vi.stubEnv('PARENT_CHILD_WINDOW', '4');
    vi.stubEnv('RSE_PENALTY', '0.5');
    vi.stubEnv('RSE_MAX_SEGMENT_CHUNKS', '5');
    vi.stubEnv('RSE_OVERALL_MAX_CHUNKS', '8');
    vi.stubEnv('RSE_MIN_SEGMENT_VALUE', '0.7');
    vi.stubEnv('HYBRID_ENABLED', 'false');
    vi.stubEnv('AUX_MODEL', 'gpt-4o-mini');
    vi.resetModules();
    const { default: appConfig } = await import('../../config/app.config');
    expect(appConfig.retrievalMode).toBe('normal');
    expect(appConfig.rerankerProvider).toBe('cohere');
    expect(appConfig.answerCacheEnabled).toBe(false);
    expect(appConfig.answerCacheTtlSec).toBe(7200);
    expect(appConfig.agentStepBudget).toBe(12);
    expect(appConfig.agenticRetrieveLimit).toBe(25);
    expect(appConfig.agenticMaxRetries).toBe(3);
    expect(appConfig.parentChunkSize).toBe(2000);
    expect(appConfig.childChunkSize).toBe(500);
    expect(appConfig.parentChildMode).toBe('window');
    expect(appConfig.parentChildWindow).toBe(4);
    expect(appConfig.rsePenalty).toBe(0.5);
    expect(appConfig.rseMaxSegmentChunks).toBe(5);
    expect(appConfig.rseOverallMaxChunks).toBe(8);
    expect(appConfig.rseMinSegmentValue).toBe(0.7);
    expect(appConfig.hybridEnabled).toBe(false);
    expect(appConfig.auxModel).toBe('gpt-4o-mini');
  });

  it('falls back to domain defaults when env vars are unset', async () => {
    stubAllTo(undefined);
    vi.resetModules();
    const { default: appConfig } = await import('../../config/app.config');
    expect(appConfig.retrievalMode).toBe('agentic');
    expect(appConfig.rerankerProvider).toBe('cosine');
    expect(appConfig.answerCacheEnabled).toBe(true);
    expect(appConfig.answerCacheTtlSec).toBe(3600);
    expect(appConfig.agentStepBudget).toBe(8);
    expect(appConfig.agenticRetrieveLimit).toBe(10);
    expect(appConfig.agenticMaxRetries).toBe(1);
    expect(appConfig.parentChunkSize).toBe(1800);
    expect(appConfig.childChunkSize).toBe(500);
    expect(appConfig.parentChildMode).toBe('parent');
    expect(appConfig.parentChildWindow).toBe(2);
    expect(appConfig.rsePenalty).toBe(0.2);
    expect(appConfig.rseMaxSegmentChunks).toBe(10);
    expect(appConfig.rseOverallMaxChunks).toBe(15);
    expect(appConfig.rseMinSegmentValue).toBe(0.3);
    expect(appConfig.hybridEnabled).toBe(true);
    expect(appConfig.auxModel).toBeUndefined();
  });
});

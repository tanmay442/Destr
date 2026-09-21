import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@app/domain/app-config';
import {
  cacheFingerprint,
  legacySearchResultCacheFingerprint,
  wp8CacheFingerprint,
  wp8SearchResultCacheFingerprint,
} from '../cache-key';

function fingerprintConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    retrievalMode: 'normal',
    similarityThreshold: 0.7,
    rerankerThreshold: 0.5,
    hybridEnabled: true,
    lexicalSearchMode: 'weighted_websearch',
    rerankerProvider: 'cosine',
    prefetchFirstTurn: false,
    agentStepBudget: 5,
    auxModel: 'aux-v1',
    orgName: 'Example Org',
    audience: 'employees',
    agentPersona: { tone: 'professional', verbosity: 'concise' },
    customInstructions: 'Use policy evidence.',
    outOfScopeTopics: ['medical advice'],
    ...overrides,
  } as AppConfig;
}

const WP1_LEGACY_NORMAL = '{"promptVersion":4,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.7,"hybridEnabled":true,"rerankerProvider":"cosine","prefetchFirstTurn":false,"agentStepBudget":5,"auxModel":"aux-v1","orgName":"Example Org","audience":"employees","agentPersona":{"tone":"professional","verbosity":"concise"},"customInstructions":"Use policy evidence.","outOfScopeTopics":["medical advice"]}';
const WP8_FINGERPRINT_NORMAL = '{"promptVersion":4,"resultContractVersion":2,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.7,"rerankerThreshold":0.5,"hybridEnabled":true,"lexicalSearchMode":"weighted_websearch","rerankerProvider":"cosine","prefetchFirstTurn":false,"agentStepBudget":5,"agenticRetrieveLimit":17,"agenticMaxRetries":2,"agenticQueryRewriteEnabled":false,"auxModel":"aux-v1","orgName":"Example Org","audience":"employees","agentPersona":{"tone":"professional","verbosity":"concise"},"customInstructions":"Use policy evidence.","outOfScopeTopics":["medical advice"]}';
const WP8_PRE_RESULT_NORMAL = '{"promptVersion":4,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.7,"hybridEnabled":true,"rerankerProvider":"cosine","prefetchFirstTurn":false,"agentStepBudget":5,"agenticRetrieveLimit":17,"agenticMaxRetries":2,"agenticQueryRewriteEnabled":false,"auxModel":"aux-v1","orgName":"Example Org","audience":"employees","agentPersona":{"tone":"professional","verbosity":"concise"},"customInstructions":"Use policy evidence.","outOfScopeTopics":["medical advice"]}';

describe('retrieval cache fingerprints', () => {
  it('preserves the literal WP-1 compatibility fingerprint across a WP-2 upgrade', () => {
    expect(legacySearchResultCacheFingerprint(fingerprintConfig(), 'normal')).toBe(WP1_LEGACY_NORMAL);
  });

  it('preserves the WP-1 compatibility fingerprint when WP-2 knobs differ', () => {
    const upgraded = fingerprintConfig({ rerankerThreshold: 0.83, lexicalSearchMode: 'content_plain' });
    expect(legacySearchResultCacheFingerprint(upgraded, 'normal')).toBe(WP1_LEGACY_NORMAL);
    expect(cacheFingerprint(upgraded, 'normal')).not.toBe(cacheFingerprint(fingerprintConfig(), 'normal'));
  });

  it('reproduces the exact WP-8 v2 and pre-result field sets', () => {
    const wp8Config: AppConfig = {
      ...fingerprintConfig(),
      wp8FingerprintCompatibility: {
        retrievalMode: 'normal',
        retrieveLimit: 17,
        maxRetries: 2,
        queryRewriteEnabled: false,
      },
    };
    expect(wp8CacheFingerprint(wp8Config)).toBe(WP8_FINGERPRINT_NORMAL);
    expect(wp8SearchResultCacheFingerprint(wp8Config)).toBe(WP8_PRE_RESULT_NORMAL);
  });

  it('derives non-default WP-8 deployment values from legacy env when config fields are gone', () => {
    vi.stubEnv('AGENTIC_RETRIEVE_LIMIT', '17');
    vi.stubEnv('AGENTIC_MAX_RETRIES', '2');
    vi.stubEnv('AGENTIC_QUERY_REWRITE_ENABLED', 'false');
    vi.stubEnv('AGENTIC_ENABLED', 'false');
    try {
      const currentConfig = fingerprintConfig();
      expect(wp8CacheFingerprint(currentConfig)).toBe(WP8_FINGERPRINT_NORMAL);
      expect(wp8SearchResultCacheFingerprint(currentConfig)).toBe(WP8_PRE_RESULT_NORMAL);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('combines partial persisted WP-8 compatibility values with legacy env fallbacks', () => {
    vi.stubEnv('AGENTIC_MAX_RETRIES', '2');
    vi.stubEnv('AGENTIC_QUERY_REWRITE_ENABLED', 'false');
    vi.stubEnv('AGENTIC_ENABLED', 'false');
    try {
      const currentConfig = fingerprintConfig({
        wp8FingerprintCompatibility: { retrieveLimit: 17 },
      });
      expect(wp8CacheFingerprint(currentConfig)).toBe(WP8_FINGERPRINT_NORMAL);
      expect(wp8SearchResultCacheFingerprint(currentConfig)).toBe(WP8_PRE_RESULT_NORMAL);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('preserves WP-8 agentic mode when WP-9 uses its new normal default', () => {
    vi.stubEnv('AGENTIC_ENABLED', 'true');
    try {
      expect(JSON.parse(wp8CacheFingerprint(fingerprintConfig()))).toMatchObject({
        mode: 'agentic',
        retrievalMode: 'agentic',
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('applies the global kill switch before persisted WP-8 mode metadata', () => {
    vi.stubEnv('AGENTIC_ENABLED', 'false');
    try {
      const cfg = fingerprintConfig({
        wp8FingerprintCompatibility: { retrievalMode: 'agentic' },
      });
      expect(JSON.parse(wp8CacheFingerprint(cfg))).toMatchObject({
        mode: 'normal',
        retrievalMode: 'normal',
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

import { describe, expect, it } from 'vitest';
import type { AppConfig } from '@app/domain/app-config';
import { cacheFingerprint, legacySearchResultCacheFingerprint } from '../cache-key';

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
    agenticRetrieveLimit: 3,
    agenticMaxRetries: 1,
    agenticQueryRewriteEnabled: true,
    auxModel: 'aux-v1',
    orgName: 'Example Org',
    audience: 'employees',
    agentPersona: { tone: 'professional', verbosity: 'concise' },
    customInstructions: 'Use policy evidence.',
    outOfScopeTopics: ['medical advice'],
    ...overrides,
  } as AppConfig;
}

const WP1_LEGACY_NORMAL = '{"promptVersion":4,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.7,"hybridEnabled":true,"rerankerProvider":"cosine","prefetchFirstTurn":false,"agentStepBudget":5,"agenticRetrieveLimit":3,"agenticMaxRetries":1,"agenticQueryRewriteEnabled":true,"auxModel":"aux-v1","orgName":"Example Org","audience":"employees","agentPersona":{"tone":"professional","verbosity":"concise"},"customInstructions":"Use policy evidence.","outOfScopeTopics":["medical advice"]}';

describe('retrieval cache fingerprints', () => {
  it('preserves the literal WP-1 compatibility fingerprint across a WP-2 upgrade', () => {
    expect(legacySearchResultCacheFingerprint(fingerprintConfig(), 'normal')).toBe(WP1_LEGACY_NORMAL);
  });

  it('preserves the WP-1 compatibility fingerprint when WP-2 knobs differ', () => {
    const upgraded = fingerprintConfig({ rerankerThreshold: 0.83, lexicalSearchMode: 'content_plain' });
    expect(legacySearchResultCacheFingerprint(upgraded, 'normal')).toBe(WP1_LEGACY_NORMAL);
    expect(cacheFingerprint(upgraded, 'normal')).not.toBe(cacheFingerprint(fingerprintConfig(), 'normal'));
  });
});

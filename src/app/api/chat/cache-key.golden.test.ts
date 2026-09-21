import { describe, it, expect } from 'vitest';
import { answerCacheKey } from '@app/infrastructure';
import { cacheFingerprint, SEARCH_RESULT_CONTRACT_VERSION } from '@app/application/chat';
import type { AppConfig } from '@app/domain/app-config';

interface Fixture {
  name: string;
  query: string;
  userId: string;
  cfg: Pick<
    AppConfig,
    | 'retrievalMode'
    | 'similarityThreshold'
    | 'rerankerThreshold'
    | 'hybridEnabled'
    | 'lexicalSearchMode'
    | 'rerankerProvider'
    | 'prefetchFirstTurn'
    | 'agentStepBudget'
    | 'auxModel'
    | 'orgName'
    | 'audience'
    | 'agentPersona'
    | 'customInstructions'
    | 'outOfScopeTopics'
  >;
  mode: 'agentic' | 'normal';
  embeddingModel: string;
  chatModel: string;
  fingerprint: string;
  key: string;
}

const baseCfg = {
  retrievalMode: 'normal',
  similarityThreshold: 0.5,
  rerankerThreshold: 0.5,
  hybridEnabled: true,
  lexicalSearchMode: 'weighted_websearch',
  rerankerProvider: 'cosine',
  prefetchFirstTurn: false,
  agentStepBudget: 8,
  auxModel: undefined as string | undefined,
  orgName: 'Test Corp',
  audience: 'test customers',
  agentPersona: { name: 'Destr', tone: 'friendly' } as const,
  customInstructions: undefined as string | undefined,
  outOfScopeTopics: [] as AppConfig['outOfScopeTopics'],
} as const;

const FINGERPRINT_BASE =
  '{"promptVersion":4,"resultContractVersion":2,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.5,"rerankerThreshold":0.5,"hybridEnabled":true,"lexicalSearchMode":"weighted_websearch","rerankerProvider":"cosine","prefetchFirstTurn":false,"agentStepBudget":8,"orgName":"Test Corp","audience":"test customers","agentPersona":{"name":"Destr","tone":"friendly"},"outOfScopeTopics":[]}';

const FIXTURES: Fixture[] = [
  {
    name: 'basic',
    query: 'How do I reset my password?',
    userId: 'user_1',
    cfg: { ...baseCfg },
    mode: 'normal',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: FINGERPRINT_BASE,
    key: 'rag:answer:067cb5aa667e8e6447c5a18957d7dfc7',
  },
  {
    name: 'query-normalization',
    query: '  What   is the  POLICY? ',
    userId: 'user_1',
    cfg: { ...baseCfg },
    mode: 'normal',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: FINGERPRINT_BASE,
    key: 'rag:answer:7391304b903046b1eddbd13c22f0612c',
  },
  {
    name: 'punct-space',
    query: 'refund policy ?',
    userId: 'user_1',
    cfg: { ...baseCfg },
    mode: 'normal',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: FINGERPRINT_BASE,
    key: 'rag:answer:9b4091b8bd6ab747fe7f5a040cac48bb',
  },
  {
    name: 'agentic-mode',
    query: 'where is my refund?',
    userId: 'user_2',
    cfg: { ...baseCfg, retrievalMode: 'agentic' },
    mode: 'agentic',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":4,"resultContractVersion":2,"mode":"agentic","retrievalMode":"agentic","similarityThreshold":0.5,"rerankerThreshold":0.5,"hybridEnabled":true,"lexicalSearchMode":"weighted_websearch","rerankerProvider":"cosine","prefetchFirstTurn":false,"agentStepBudget":8,"orgName":"Test Corp","audience":"test customers","agentPersona":{"name":"Destr","tone":"friendly"},"outOfScopeTopics":[]}',
    key: 'rag:answer:d1abc7440be157c378bda4928080a752',
  },
  {
    name: 'agentic-inverted-rollout',
    query: 'dress code',
    userId: 'user_2',
    cfg: { ...baseCfg },
    mode: 'agentic',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":4,"resultContractVersion":2,"mode":"agentic","retrievalMode":"normal","similarityThreshold":0.5,"rerankerThreshold":0.5,"hybridEnabled":true,"lexicalSearchMode":"weighted_websearch","rerankerProvider":"cosine","prefetchFirstTurn":false,"agentStepBudget":8,"orgName":"Test Corp","audience":"test customers","agentPersona":{"name":"Destr","tone":"friendly"},"outOfScopeTopics":[]}',
    key: 'rag:answer:6576d96f9c8ffc768855b54ff9d36582',
  },
  {
    name: 'different-user',
    query: 'How do I reset my password?',
    userId: 'user_99',
    cfg: { ...baseCfg },
    mode: 'normal',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: FINGERPRINT_BASE,
    key: 'rag:answer:96e8e9b6f33d1b9e2da4140c1c603119',
  },
  {
    name: 'different-chat-model',
    query: 'How do I reset my password?',
    userId: 'user_1',
    cfg: { ...baseCfg },
    mode: 'normal',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o',
    fingerprint: FINGERPRINT_BASE,
    key: 'rag:answer:540cbba546a211f348571079a0db5f62',
  },
  {
    name: 'different-embedding',
    query: 'How do I reset my password?',
    userId: 'user_1',
    cfg: { ...baseCfg },
    mode: 'normal',
    embeddingModel: 'text-embedding-3-large',
    chatModel: 'gpt-4o-mini',
    fingerprint: FINGERPRINT_BASE,
    key: 'rag:answer:59f458eadb6c4d1db9a6fbf007474951',
  },
  {
    name: 'reranker-cohere',
    query: 'school cell phone policy',
    userId: 'user_7',
    cfg: { ...baseCfg, rerankerProvider: 'cohere' },
    mode: 'normal',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":4,"resultContractVersion":2,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.5,"rerankerThreshold":0.5,"hybridEnabled":true,"lexicalSearchMode":"weighted_websearch","rerankerProvider":"cohere","prefetchFirstTurn":false,"agentStepBudget":8,"orgName":"Test Corp","audience":"test customers","agentPersona":{"name":"Destr","tone":"friendly"},"outOfScopeTopics":[]}',
    key: 'rag:answer:74afa10b0870f3bad648fc58ee096a81',
  },
  {
    name: 'hybrid-off',
    query: 'submit claims via portal',
    userId: 'user_7',
    cfg: { ...baseCfg, hybridEnabled: false },
    mode: 'normal',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":4,"resultContractVersion":2,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.5,"rerankerThreshold":0.5,"hybridEnabled":false,"lexicalSearchMode":"weighted_websearch","rerankerProvider":"cosine","prefetchFirstTurn":false,"agentStepBudget":8,"orgName":"Test Corp","audience":"test customers","agentPersona":{"name":"Destr","tone":"friendly"},"outOfScopeTopics":[]}',
    key: 'rag:answer:1ce62aa0075b067359a7af25e4630f62',
  },
  {
    name: 'threshold-diff',
    query: 'submit claims via portal',
    userId: 'user_7',
    cfg: { ...baseCfg, similarityThreshold: 0.7 },
    mode: 'normal',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":4,"resultContractVersion":2,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.7,"rerankerThreshold":0.5,"hybridEnabled":true,"lexicalSearchMode":"weighted_websearch","rerankerProvider":"cosine","prefetchFirstTurn":false,"agentStepBudget":8,"orgName":"Test Corp","audience":"test customers","agentPersona":{"name":"Destr","tone":"friendly"},"outOfScopeTopics":[]}',
    key: 'rag:answer:800da17112b1937d2aab7e46e8768a4f',
  },
  {
    name: 'prefetch-on',
    query: 'submit claims via portal',
    userId: 'user_7',
    cfg: { ...baseCfg, prefetchFirstTurn: true },
    mode: 'normal',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":4,"resultContractVersion":2,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.5,"rerankerThreshold":0.5,"hybridEnabled":true,"lexicalSearchMode":"weighted_websearch","rerankerProvider":"cosine","prefetchFirstTurn":true,"agentStepBudget":8,"orgName":"Test Corp","audience":"test customers","agentPersona":{"name":"Destr","tone":"friendly"},"outOfScopeTopics":[]}',
    key: 'rag:answer:a8e1fce7c53136c0bd0283e73003ff4c',
  },
  {
    name: 'prompt-config-sensitive',
    query: 'How do I reset my password?',
    userId: 'user_1',
    cfg: {
      ...baseCfg,
      customInstructions: 'Always answer in Spanish.',
      auxModel: 'gemini-2.0-flash-grade',
    },
    mode: 'normal',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":4,"resultContractVersion":2,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.5,"rerankerThreshold":0.5,"hybridEnabled":true,"lexicalSearchMode":"weighted_websearch","rerankerProvider":"cosine","prefetchFirstTurn":false,"agentStepBudget":8,"auxModel":"gemini-2.0-flash-grade","orgName":"Test Corp","audience":"test customers","agentPersona":{"name":"Destr","tone":"friendly"},"customInstructions":"Always answer in Spanish.","outOfScopeTopics":[]}',
    key: 'rag:answer:c4a50814a11d86c2756bf3a006f9b636',
  },
];

describe('chat turn cache-key golden parity (R3)', () => {
  it.each(FIXTURES.map((f) => [f.name, f] as const))(
    'reproduces the post-fingerprint-expansion key for %s',
    (_name, fixture) => {
      const fingerprint = cacheFingerprint(fixture.cfg as AppConfig, fixture.mode);
      expect(fingerprint).toBe(fixture.fingerprint);
      const key = answerCacheKey(fixture.query, {
        embeddingModel: fixture.embeddingModel,
        chatModel: fixture.chatModel,
        userId: fixture.userId,
        fingerprint,
      });
      expect(key).toBe(fixture.key);
    },
  );

  it('isolates typed-score cache entries from the legacy result contract', () => {
    const currentFingerprint = cacheFingerprint(baseCfg as AppConfig, 'normal');
    const legacyFingerprint = currentFingerprint.replace(
      `"resultContractVersion":${SEARCH_RESULT_CONTRACT_VERSION},`,
      '',
    );
    const opts = {
      embeddingModel: 'text-embedding-3-small',
      chatModel: 'gpt-4o-mini',
      userId: 'user_1',
    };
    const currentKey = answerCacheKey('How do I reset my password?', {
      ...opts,
      fingerprint: currentFingerprint,
    });
    const legacyKey = answerCacheKey('How do I reset my password?', {
      ...opts,
      fingerprint: legacyFingerprint,
    });
    expect(currentFingerprint).toContain('"resultContractVersion":2');
    expect(currentKey).not.toBe(legacyKey);
  });

  it('invalidates cached answers when either WP-2 retrieval control changes', () => {
    const current = cacheFingerprint(baseCfg as AppConfig, 'normal');
    expect(cacheFingerprint({ ...baseCfg, rerankerThreshold: 0.7 } as AppConfig, 'normal')).not.toBe(current);
    expect(cacheFingerprint({ ...baseCfg, lexicalSearchMode: 'content_plain' } as AppConfig, 'normal')).not.toBe(current);
  });
});

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
    | 'hybridEnabled'
    | 'rerankerProvider'
    | 'prefetchFirstTurn'
    | 'agentStepBudget'
    | 'agenticRetrieveLimit'
    | 'agenticMaxRetries'
    | 'agenticQueryRewriteEnabled'
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
  hybridEnabled: true,
  rerankerProvider: 'cosine',
  prefetchFirstTurn: false,
  agentStepBudget: 8,
  agenticRetrieveLimit: 10,
  agenticMaxRetries: 1,
  agenticQueryRewriteEnabled: true,
  auxModel: undefined as string | undefined,
  orgName: 'Test Corp',
  audience: 'test customers',
  agentPersona: { name: 'Destr', tone: 'friendly' } as const,
  customInstructions: undefined as string | undefined,
  outOfScopeTopics: [] as AppConfig['outOfScopeTopics'],
} as const;

const FINGERPRINT_BASE =
  '{"promptVersion":4,"resultContractVersion":2,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.5,"hybridEnabled":true,"rerankerProvider":"cosine","prefetchFirstTurn":false,"agentStepBudget":8,"agenticRetrieveLimit":10,"agenticMaxRetries":1,"agenticQueryRewriteEnabled":true,"orgName":"Test Corp","audience":"test customers","agentPersona":{"name":"Destr","tone":"friendly"},"outOfScopeTopics":[]}';

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
    key: 'rag:answer:ff5591f1af46d748c77405a532a3f328',
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
    key: 'rag:answer:b889e50775630992589fc0e483a9f2d9',
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
    key: 'rag:answer:89382c9076ec68f335ff14dbba571f67',
  },
  {
    name: 'agentic-mode',
    query: 'where is my refund?',
    userId: 'user_2',
    cfg: { ...baseCfg, retrievalMode: 'agentic' },
    mode: 'agentic',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":4,"resultContractVersion":2,"mode":"agentic","retrievalMode":"agentic","similarityThreshold":0.5,"hybridEnabled":true,"rerankerProvider":"cosine","prefetchFirstTurn":false,"agentStepBudget":8,"agenticRetrieveLimit":10,"agenticMaxRetries":1,"agenticQueryRewriteEnabled":true,"orgName":"Test Corp","audience":"test customers","agentPersona":{"name":"Destr","tone":"friendly"},"outOfScopeTopics":[]}',
    key: 'rag:answer:f89abe15cbb234f7e828b64156b3ea45',
  },
  {
    name: 'agentic-inverted-rollout',
    query: 'dress code',
    userId: 'user_2',
    cfg: { ...baseCfg },
    mode: 'agentic',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":4,"resultContractVersion":2,"mode":"agentic","retrievalMode":"normal","similarityThreshold":0.5,"hybridEnabled":true,"rerankerProvider":"cosine","prefetchFirstTurn":false,"agentStepBudget":8,"agenticRetrieveLimit":10,"agenticMaxRetries":1,"agenticQueryRewriteEnabled":true,"orgName":"Test Corp","audience":"test customers","agentPersona":{"name":"Destr","tone":"friendly"},"outOfScopeTopics":[]}',
    key: 'rag:answer:f81571e15e569931e95bad8543ee8002',
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
    key: 'rag:answer:5755e604741014d81a9e8d6bd2504824',
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
    key: 'rag:answer:866a19c0828cbd51c2ce19bd68cd9f33',
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
    key: 'rag:answer:f832253ef2aba5544ecec3a7da6eb4e8',
  },
  {
    name: 'reranker-cohere',
    query: 'school cell phone policy',
    userId: 'user_7',
    cfg: { ...baseCfg, rerankerProvider: 'cohere' },
    mode: 'normal',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":4,"resultContractVersion":2,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.5,"hybridEnabled":true,"rerankerProvider":"cohere","prefetchFirstTurn":false,"agentStepBudget":8,"agenticRetrieveLimit":10,"agenticMaxRetries":1,"agenticQueryRewriteEnabled":true,"orgName":"Test Corp","audience":"test customers","agentPersona":{"name":"Destr","tone":"friendly"},"outOfScopeTopics":[]}',
    key: 'rag:answer:a7959ee1bc4ba6b3b9af36024de03146',
  },
  {
    name: 'hybrid-off',
    query: 'submit claims via portal',
    userId: 'user_7',
    cfg: { ...baseCfg, hybridEnabled: false },
    mode: 'normal',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":4,"resultContractVersion":2,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.5,"hybridEnabled":false,"rerankerProvider":"cosine","prefetchFirstTurn":false,"agentStepBudget":8,"agenticRetrieveLimit":10,"agenticMaxRetries":1,"agenticQueryRewriteEnabled":true,"orgName":"Test Corp","audience":"test customers","agentPersona":{"name":"Destr","tone":"friendly"},"outOfScopeTopics":[]}',
    key: 'rag:answer:4bb6c9f3a6580aee85271e2a3b8f2de2',
  },
  {
    name: 'threshold-diff',
    query: 'submit claims via portal',
    userId: 'user_7',
    cfg: { ...baseCfg, similarityThreshold: 0.7 },
    mode: 'normal',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":4,"resultContractVersion":2,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.7,"hybridEnabled":true,"rerankerProvider":"cosine","prefetchFirstTurn":false,"agentStepBudget":8,"agenticRetrieveLimit":10,"agenticMaxRetries":1,"agenticQueryRewriteEnabled":true,"orgName":"Test Corp","audience":"test customers","agentPersona":{"name":"Destr","tone":"friendly"},"outOfScopeTopics":[]}',
    key: 'rag:answer:6f431dff81fd85dfc76a40ea0e0745dd',
  },
  {
    name: 'prefetch-on',
    query: 'submit claims via portal',
    userId: 'user_7',
    cfg: { ...baseCfg, prefetchFirstTurn: true },
    mode: 'normal',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":4,"resultContractVersion":2,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.5,"hybridEnabled":true,"rerankerProvider":"cosine","prefetchFirstTurn":true,"agentStepBudget":8,"agenticRetrieveLimit":10,"agenticMaxRetries":1,"agenticQueryRewriteEnabled":true,"orgName":"Test Corp","audience":"test customers","agentPersona":{"name":"Destr","tone":"friendly"},"outOfScopeTopics":[]}',
    key: 'rag:answer:0df174e3700a4978067ac20133cd09ad',
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
    fingerprint: '{"promptVersion":4,"resultContractVersion":2,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.5,"hybridEnabled":true,"rerankerProvider":"cosine","prefetchFirstTurn":false,"agentStepBudget":8,"agenticRetrieveLimit":10,"agenticMaxRetries":1,"agenticQueryRewriteEnabled":true,"auxModel":"gemini-2.0-flash-grade","orgName":"Test Corp","audience":"test customers","agentPersona":{"name":"Destr","tone":"friendly"},"customInstructions":"Always answer in Spanish.","outOfScopeTopics":[]}',
    key: 'rag:answer:9f7b62f7f5ae6af1d0c6b0125015e9bd',
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
});

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
  rerankerThreshold: 0.5,
  hybridEnabled: true,
  lexicalSearchMode: 'weighted_websearch',
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
  '{"promptVersion":4,"resultContractVersion":2,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.5,"rerankerThreshold":0.5,"hybridEnabled":true,"lexicalSearchMode":"weighted_websearch","rerankerProvider":"cosine","prefetchFirstTurn":false,"agentStepBudget":8,"agenticRetrieveLimit":10,"agenticMaxRetries":1,"agenticQueryRewriteEnabled":true,"orgName":"Test Corp","audience":"test customers","agentPersona":{"name":"Destr","tone":"friendly"},"outOfScopeTopics":[]}';

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
    key: 'rag:answer:1438f9fbd2032c15bb6f9ba3fbf34665',
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
    key: 'rag:answer:ee612a18956297f76a2977de2aa0e8e5',
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
    key: 'rag:answer:a3c1ec928b07f6d0002e42e3d18f254c',
  },
  {
    name: 'agentic-mode',
    query: 'where is my refund?',
    userId: 'user_2',
    cfg: { ...baseCfg, retrievalMode: 'agentic' },
    mode: 'agentic',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":4,"resultContractVersion":2,"mode":"agentic","retrievalMode":"agentic","similarityThreshold":0.5,"rerankerThreshold":0.5,"hybridEnabled":true,"lexicalSearchMode":"weighted_websearch","rerankerProvider":"cosine","prefetchFirstTurn":false,"agentStepBudget":8,"agenticRetrieveLimit":10,"agenticMaxRetries":1,"agenticQueryRewriteEnabled":true,"orgName":"Test Corp","audience":"test customers","agentPersona":{"name":"Destr","tone":"friendly"},"outOfScopeTopics":[]}',
    key: 'rag:answer:fa96d7ce448b8b09b281ef60463ca1a2',
  },
  {
    name: 'agentic-inverted-rollout',
    query: 'dress code',
    userId: 'user_2',
    cfg: { ...baseCfg },
    mode: 'agentic',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":4,"resultContractVersion":2,"mode":"agentic","retrievalMode":"normal","similarityThreshold":0.5,"rerankerThreshold":0.5,"hybridEnabled":true,"lexicalSearchMode":"weighted_websearch","rerankerProvider":"cosine","prefetchFirstTurn":false,"agentStepBudget":8,"agenticRetrieveLimit":10,"agenticMaxRetries":1,"agenticQueryRewriteEnabled":true,"orgName":"Test Corp","audience":"test customers","agentPersona":{"name":"Destr","tone":"friendly"},"outOfScopeTopics":[]}',
    key: 'rag:answer:5a9b1e1f2440e1f93da40d7b554e6c6f',
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
    key: 'rag:answer:e24bf1d9c8f4d2bb72017409d990d46e',
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
    key: 'rag:answer:b85245b214484ba375d8fd1de0e94f8d',
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
    key: 'rag:answer:24c3f1b6449b978cf0e66dcecc359954',
  },
  {
    name: 'reranker-cohere',
    query: 'school cell phone policy',
    userId: 'user_7',
    cfg: { ...baseCfg, rerankerProvider: 'cohere' },
    mode: 'normal',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":4,"resultContractVersion":2,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.5,"rerankerThreshold":0.5,"hybridEnabled":true,"lexicalSearchMode":"weighted_websearch","rerankerProvider":"cohere","prefetchFirstTurn":false,"agentStepBudget":8,"agenticRetrieveLimit":10,"agenticMaxRetries":1,"agenticQueryRewriteEnabled":true,"orgName":"Test Corp","audience":"test customers","agentPersona":{"name":"Destr","tone":"friendly"},"outOfScopeTopics":[]}',
    key: 'rag:answer:0a7d04c7b687dc111ed4915de11aff6b',
  },
  {
    name: 'hybrid-off',
    query: 'submit claims via portal',
    userId: 'user_7',
    cfg: { ...baseCfg, hybridEnabled: false },
    mode: 'normal',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":4,"resultContractVersion":2,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.5,"rerankerThreshold":0.5,"hybridEnabled":false,"lexicalSearchMode":"weighted_websearch","rerankerProvider":"cosine","prefetchFirstTurn":false,"agentStepBudget":8,"agenticRetrieveLimit":10,"agenticMaxRetries":1,"agenticQueryRewriteEnabled":true,"orgName":"Test Corp","audience":"test customers","agentPersona":{"name":"Destr","tone":"friendly"},"outOfScopeTopics":[]}',
    key: 'rag:answer:ea355047f8cbd5afe30e6242d76b0f77',
  },
  {
    name: 'threshold-diff',
    query: 'submit claims via portal',
    userId: 'user_7',
    cfg: { ...baseCfg, similarityThreshold: 0.7 },
    mode: 'normal',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":4,"resultContractVersion":2,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.7,"rerankerThreshold":0.5,"hybridEnabled":true,"lexicalSearchMode":"weighted_websearch","rerankerProvider":"cosine","prefetchFirstTurn":false,"agentStepBudget":8,"agenticRetrieveLimit":10,"agenticMaxRetries":1,"agenticQueryRewriteEnabled":true,"orgName":"Test Corp","audience":"test customers","agentPersona":{"name":"Destr","tone":"friendly"},"outOfScopeTopics":[]}',
    key: 'rag:answer:d26ecb38cce41bdbb5061df9c357d547',
  },
  {
    name: 'prefetch-on',
    query: 'submit claims via portal',
    userId: 'user_7',
    cfg: { ...baseCfg, prefetchFirstTurn: true },
    mode: 'normal',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":4,"resultContractVersion":2,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.5,"rerankerThreshold":0.5,"hybridEnabled":true,"lexicalSearchMode":"weighted_websearch","rerankerProvider":"cosine","prefetchFirstTurn":true,"agentStepBudget":8,"agenticRetrieveLimit":10,"agenticMaxRetries":1,"agenticQueryRewriteEnabled":true,"orgName":"Test Corp","audience":"test customers","agentPersona":{"name":"Destr","tone":"friendly"},"outOfScopeTopics":[]}',
    key: 'rag:answer:3dc3b31f6ab502206f2081355bd3d93b',
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
    fingerprint: '{"promptVersion":4,"resultContractVersion":2,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.5,"rerankerThreshold":0.5,"hybridEnabled":true,"lexicalSearchMode":"weighted_websearch","rerankerProvider":"cosine","prefetchFirstTurn":false,"agentStepBudget":8,"agenticRetrieveLimit":10,"agenticMaxRetries":1,"agenticQueryRewriteEnabled":true,"auxModel":"gemini-2.0-flash-grade","orgName":"Test Corp","audience":"test customers","agentPersona":{"name":"Destr","tone":"friendly"},"customInstructions":"Always answer in Spanish.","outOfScopeTopics":[]}',
    key: 'rag:answer:ada581f91fbcd176311080b547537e71',
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

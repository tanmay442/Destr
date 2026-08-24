import { describe, it, expect } from 'vitest';
import { answerCacheKey } from '@app/infrastructure';
import { cacheFingerprint } from '@app/application/chat';
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
    | 'agenticChunkGradingEnabled'
    | 'gradeModel'
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
  agenticChunkGradingEnabled: true,
  gradeModel: undefined as string | undefined,
  orgName: 'Test Corp',
  audience: 'test customers',
  agentPersona: { name: 'Destr', tone: 'friendly' } as const,
  customInstructions: undefined as string | undefined,
  outOfScopeTopics: [] as AppConfig['outOfScopeTopics'],
} as const;

const FINGERPRINT_BASE =
  '{"promptVersion":3,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.5,"hybridEnabled":true,"rerankerProvider":"cosine","prefetchFirstTurn":false,"agentStepBudget":8,"agenticRetrieveLimit":10,"agenticMaxRetries":1,"agenticQueryRewriteEnabled":true,"agenticChunkGradingEnabled":true,"orgName":"Test Corp","audience":"test customers","agentPersona":{"name":"Destr","tone":"friendly"},"outOfScopeTopics":[]}';

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
    key: 'rag:answer:e34bf6f8d1604f2f22bdb1e3b13260b4',
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
    key: 'rag:answer:d0c8fc0df3c773acd05ad6a306ae81db',
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
    key: 'rag:answer:4e990fc610249d20eb1a07688b0693af',
  },
  {
    name: 'agentic-mode',
    query: 'where is my refund?',
    userId: 'user_2',
    cfg: { ...baseCfg, retrievalMode: 'agentic' },
    mode: 'agentic',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":3,"mode":"agentic","retrievalMode":"agentic","similarityThreshold":0.5,"hybridEnabled":true,"rerankerProvider":"cosine","prefetchFirstTurn":false,"agentStepBudget":8,"agenticRetrieveLimit":10,"agenticMaxRetries":1,"agenticQueryRewriteEnabled":true,"agenticChunkGradingEnabled":true,"orgName":"Test Corp","audience":"test customers","agentPersona":{"name":"Destr","tone":"friendly"},"outOfScopeTopics":[]}',
    key: 'rag:answer:45e1a54b67c2362a4ab14caee8497e99',
  },
  {
    name: 'agentic-inverted-rollout',
    query: 'dress code',
    userId: 'user_2',
    cfg: { ...baseCfg },
    mode: 'agentic',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":3,"mode":"agentic","retrievalMode":"normal","similarityThreshold":0.5,"hybridEnabled":true,"rerankerProvider":"cosine","prefetchFirstTurn":false,"agentStepBudget":8,"agenticRetrieveLimit":10,"agenticMaxRetries":1,"agenticQueryRewriteEnabled":true,"agenticChunkGradingEnabled":true,"orgName":"Test Corp","audience":"test customers","agentPersona":{"name":"Destr","tone":"friendly"},"outOfScopeTopics":[]}',
    key: 'rag:answer:26ac59f4a8527628c88f145463321869',
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
    key: 'rag:answer:37b3a5da0a97518e564f974681a4c966',
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
    key: 'rag:answer:2fe6eecbfd779dc83af65819efb07e36',
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
    key: 'rag:answer:25eee611b71351bb20b76352a1d695aa',
  },
  {
    name: 'reranker-cohere',
    query: 'school cell phone policy',
    userId: 'user_7',
    cfg: { ...baseCfg, rerankerProvider: 'cohere' },
    mode: 'normal',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":3,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.5,"hybridEnabled":true,"rerankerProvider":"cohere","prefetchFirstTurn":false,"agentStepBudget":8,"agenticRetrieveLimit":10,"agenticMaxRetries":1,"agenticQueryRewriteEnabled":true,"agenticChunkGradingEnabled":true,"orgName":"Test Corp","audience":"test customers","agentPersona":{"name":"Destr","tone":"friendly"},"outOfScopeTopics":[]}',
    key: 'rag:answer:dd7867ab245cf470f2bfd3111f110b78',
  },
  {
    name: 'hybrid-off',
    query: 'submit claims via portal',
    userId: 'user_7',
    cfg: { ...baseCfg, hybridEnabled: false },
    mode: 'normal',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":3,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.5,"hybridEnabled":false,"rerankerProvider":"cosine","prefetchFirstTurn":false,"agentStepBudget":8,"agenticRetrieveLimit":10,"agenticMaxRetries":1,"agenticQueryRewriteEnabled":true,"agenticChunkGradingEnabled":true,"orgName":"Test Corp","audience":"test customers","agentPersona":{"name":"Destr","tone":"friendly"},"outOfScopeTopics":[]}',
    key: 'rag:answer:98625ada8c456f2598d0dbe25a5b5205',
  },
  {
    name: 'threshold-diff',
    query: 'submit claims via portal',
    userId: 'user_7',
    cfg: { ...baseCfg, similarityThreshold: 0.7 },
    mode: 'normal',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":3,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.7,"hybridEnabled":true,"rerankerProvider":"cosine","prefetchFirstTurn":false,"agentStepBudget":8,"agenticRetrieveLimit":10,"agenticMaxRetries":1,"agenticQueryRewriteEnabled":true,"agenticChunkGradingEnabled":true,"orgName":"Test Corp","audience":"test customers","agentPersona":{"name":"Destr","tone":"friendly"},"outOfScopeTopics":[]}',
    key: 'rag:answer:1898baf4e294de68bd379bd113d4be3c',
  },
  {
    name: 'prefetch-on',
    query: 'submit claims via portal',
    userId: 'user_7',
    cfg: { ...baseCfg, prefetchFirstTurn: true },
    mode: 'normal',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":3,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.5,"hybridEnabled":true,"rerankerProvider":"cosine","prefetchFirstTurn":true,"agentStepBudget":8,"agenticRetrieveLimit":10,"agenticMaxRetries":1,"agenticQueryRewriteEnabled":true,"agenticChunkGradingEnabled":true,"orgName":"Test Corp","audience":"test customers","agentPersona":{"name":"Destr","tone":"friendly"},"outOfScopeTopics":[]}',
    key: 'rag:answer:c9d8955dfd773cbeeaab3ec639705f92',
  },
  {
    name: 'prompt-config-sensitive',
    query: 'How do I reset my password?',
    userId: 'user_1',
    cfg: {
      ...baseCfg,
      customInstructions: 'Always answer in Spanish.',
      gradeModel: 'gemini-2.0-flash-grade',
    },
    mode: 'normal',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":3,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.5,"hybridEnabled":true,"rerankerProvider":"cosine","prefetchFirstTurn":false,"agentStepBudget":8,"agenticRetrieveLimit":10,"agenticMaxRetries":1,"agenticQueryRewriteEnabled":true,"agenticChunkGradingEnabled":true,"gradeModel":"gemini-2.0-flash-grade","orgName":"Test Corp","audience":"test customers","agentPersona":{"name":"Destr","tone":"friendly"},"customInstructions":"Always answer in Spanish.","outOfScopeTopics":[]}',
    key: 'rag:answer:8595366827c2a68976ce183d5b933140',
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
});

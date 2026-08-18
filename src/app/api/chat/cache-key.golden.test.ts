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
  gradeModel: undefined as string | undefined,
  orgName: 'Test Corp',
  audience: 'test customers',
  agentPersona: { name: 'Destr', tone: 'friendly' } as const,
  customInstructions: undefined as string | undefined,
  outOfScopeTopics: [] as AppConfig['outOfScopeTopics'],
} as const;

const FINGERPRINT_BASE =
  '{"promptVersion":3,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.5,"hybridEnabled":true,"rerankerProvider":"cosine","prefetchFirstTurn":false,"agentStepBudget":8,"agenticRetrieveLimit":10,"agenticMaxRetries":1,"orgName":"Test Corp","audience":"test customers","agentPersona":{"name":"Destr","tone":"friendly"},"outOfScopeTopics":[]}';

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
    key: 'rag:answer:683232d7b0ef3c1da5c2ad8123e8b6d4',
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
    key: 'rag:answer:41bff03d38319008e312d33f09c6d0f5',
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
    key: 'rag:answer:a1b48bffc1c4e531a9fc2ebfc464d603',
  },
  {
    name: 'agentic-mode',
    query: 'where is my refund?',
    userId: 'user_2',
    cfg: { ...baseCfg, retrievalMode: 'agentic' },
    mode: 'agentic',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":3,"mode":"agentic","retrievalMode":"agentic","similarityThreshold":0.5,"hybridEnabled":true,"rerankerProvider":"cosine","prefetchFirstTurn":false,"agentStepBudget":8,"agenticRetrieveLimit":10,"agenticMaxRetries":1,"orgName":"Test Corp","audience":"test customers","agentPersona":{"name":"Destr","tone":"friendly"},"outOfScopeTopics":[]}',
    key: 'rag:answer:90f0edab677ca987d9ef1c6811c63aa3',
  },
  {
    name: 'agentic-inverted-rollout',
    query: 'dress code',
    userId: 'user_2',
    cfg: { ...baseCfg },
    mode: 'agentic',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":3,"mode":"agentic","retrievalMode":"normal","similarityThreshold":0.5,"hybridEnabled":true,"rerankerProvider":"cosine","prefetchFirstTurn":false,"agentStepBudget":8,"agenticRetrieveLimit":10,"agenticMaxRetries":1,"orgName":"Test Corp","audience":"test customers","agentPersona":{"name":"Destr","tone":"friendly"},"outOfScopeTopics":[]}',
    key: 'rag:answer:08ca3209f12595341caf034afdde142d',
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
    key: 'rag:answer:7b92ce114d83047e35ff2ddc5a46d6d1',
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
    key: 'rag:answer:25d9dc3d21ed2d8e3461bb5d1267f003',
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
    key: 'rag:answer:9c71bbb0780947ff122af4dd8603c125',
  },
  {
    name: 'reranker-cohere',
    query: 'school cell phone policy',
    userId: 'user_7',
    cfg: { ...baseCfg, rerankerProvider: 'cohere' },
    mode: 'normal',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":3,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.5,"hybridEnabled":true,"rerankerProvider":"cohere","prefetchFirstTurn":false,"agentStepBudget":8,"agenticRetrieveLimit":10,"agenticMaxRetries":1,"orgName":"Test Corp","audience":"test customers","agentPersona":{"name":"Destr","tone":"friendly"},"outOfScopeTopics":[]}',
    key: 'rag:answer:1300bed0d73529fb103c8c50ae542a9a',
  },
  {
    name: 'hybrid-off',
    query: 'submit claims via portal',
    userId: 'user_7',
    cfg: { ...baseCfg, hybridEnabled: false },
    mode: 'normal',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":3,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.5,"hybridEnabled":false,"rerankerProvider":"cosine","prefetchFirstTurn":false,"agentStepBudget":8,"agenticRetrieveLimit":10,"agenticMaxRetries":1,"orgName":"Test Corp","audience":"test customers","agentPersona":{"name":"Destr","tone":"friendly"},"outOfScopeTopics":[]}',
    key: 'rag:answer:2cf371e7bc61d4d849f6a2a250745486',
  },
  {
    name: 'threshold-diff',
    query: 'submit claims via portal',
    userId: 'user_7',
    cfg: { ...baseCfg, similarityThreshold: 0.7 },
    mode: 'normal',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":3,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.7,"hybridEnabled":true,"rerankerProvider":"cosine","prefetchFirstTurn":false,"agentStepBudget":8,"agenticRetrieveLimit":10,"agenticMaxRetries":1,"orgName":"Test Corp","audience":"test customers","agentPersona":{"name":"Destr","tone":"friendly"},"outOfScopeTopics":[]}',
    key: 'rag:answer:68550b44baf358db974bbcfc8b971929',
  },
  {
    name: 'prefetch-on',
    query: 'submit claims via portal',
    userId: 'user_7',
    cfg: { ...baseCfg, prefetchFirstTurn: true },
    mode: 'normal',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":3,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.5,"hybridEnabled":true,"rerankerProvider":"cosine","prefetchFirstTurn":true,"agentStepBudget":8,"agenticRetrieveLimit":10,"agenticMaxRetries":1,"orgName":"Test Corp","audience":"test customers","agentPersona":{"name":"Destr","tone":"friendly"},"outOfScopeTopics":[]}',
    key: 'rag:answer:375d0f7ccc0126dee1d3656bb6c7efe6',
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
    fingerprint: '{"promptVersion":3,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.5,"hybridEnabled":true,"rerankerProvider":"cosine","prefetchFirstTurn":false,"agentStepBudget":8,"agenticRetrieveLimit":10,"agenticMaxRetries":1,"gradeModel":"gemini-2.0-flash-grade","orgName":"Test Corp","audience":"test customers","agentPersona":{"name":"Destr","tone":"friendly"},"customInstructions":"Always answer in Spanish.","outOfScopeTopics":[]}',
    key: 'rag:answer:388b3cd351e51db429ec87bf255c148f',
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

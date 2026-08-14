import { describe, it, expect } from 'vitest';
import { answerCacheKey } from '@app/infrastructure';
import { cacheFingerprint } from '@app/application/chat';
import type { AppConfig } from '@app/domain/app-config';

interface Fixture {
  name: string;
  query: string;
  userId: string;
  cfg: Pick<AppConfig, 'retrievalMode' | 'similarityThreshold' | 'hybridEnabled' | 'rerankerProvider' | 'prefetchFirstTurn'>;
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
} as const;

const FIXTURES: Fixture[] = [
  {
    name: 'basic',
    query: 'How do I reset my password?',
    userId: 'user_1',
    cfg: { ...baseCfg },
    mode: 'normal',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":2,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.5,"hybridEnabled":true,"rerankerProvider":"cosine","prefetchFirstTurn":false}',
    key: 'rag:answer:1dfad21b48f554f6b381e73f7d32a1a4',
  },
  {
    name: 'query-normalization',
    query: '  What   is the  POLICY? ',
    userId: 'user_1',
    cfg: { ...baseCfg },
    mode: 'normal',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":2,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.5,"hybridEnabled":true,"rerankerProvider":"cosine","prefetchFirstTurn":false}',
    key: 'rag:answer:d66c54c6403939297c7cb9ca34e01a36',
  },
  {
    name: 'punct-space',
    query: 'refund policy ?',
    userId: 'user_1',
    cfg: { ...baseCfg },
    mode: 'normal',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":2,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.5,"hybridEnabled":true,"rerankerProvider":"cosine","prefetchFirstTurn":false}',
    key: 'rag:answer:af9749300987a5b33cebbbe45edf9898',
  },
  {
    name: 'agentic-mode',
    query: 'where is my refund?',
    userId: 'user_2',
    cfg: { ...baseCfg, retrievalMode: 'agentic' },
    mode: 'agentic',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":2,"mode":"agentic","retrievalMode":"agentic","similarityThreshold":0.5,"hybridEnabled":true,"rerankerProvider":"cosine","prefetchFirstTurn":false}',
    key: 'rag:answer:c5546b345c5e3d94a5b2baee44fbeaf5',
  },
  {
    name: 'agentic-inverted-rollout',
    query: 'dress code',
    userId: 'user_2',
    cfg: { ...baseCfg },
    mode: 'agentic',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":2,"mode":"agentic","retrievalMode":"normal","similarityThreshold":0.5,"hybridEnabled":true,"rerankerProvider":"cosine","prefetchFirstTurn":false}',
    key: 'rag:answer:4b76905f579eae495da582eafde5114b',
  },
  {
    name: 'different-user',
    query: 'How do I reset my password?',
    userId: 'user_99',
    cfg: { ...baseCfg },
    mode: 'normal',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":2,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.5,"hybridEnabled":true,"rerankerProvider":"cosine","prefetchFirstTurn":false}',
    key: 'rag:answer:08c81a8cd355da13672a54965da79524',
  },
  {
    name: 'different-chat-model',
    query: 'How do I reset my password?',
    userId: 'user_1',
    cfg: { ...baseCfg },
    mode: 'normal',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o',
    fingerprint: '{"promptVersion":2,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.5,"hybridEnabled":true,"rerankerProvider":"cosine","prefetchFirstTurn":false}',
    key: 'rag:answer:488b807037501e1e5df348913dc3d29b',
  },
  {
    name: 'different-embedding',
    query: 'How do I reset my password?',
    userId: 'user_1',
    cfg: { ...baseCfg },
    mode: 'normal',
    embeddingModel: 'text-embedding-3-large',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":2,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.5,"hybridEnabled":true,"rerankerProvider":"cosine","prefetchFirstTurn":false}',
    key: 'rag:answer:689c120eb1965477ec040102314c0a3d',
  },
  {
    name: 'reranker-cohere',
    query: 'school cell phone policy',
    userId: 'user_7',
    cfg: { ...baseCfg, rerankerProvider: 'cohere' },
    mode: 'normal',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":2,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.5,"hybridEnabled":true,"rerankerProvider":"cohere","prefetchFirstTurn":false}',
    key: 'rag:answer:a4be506a90cefc4cfe47c76fc314bae9',
  },
  {
    name: 'hybrid-off',
    query: 'submit claims via portal',
    userId: 'user_7',
    cfg: { ...baseCfg, hybridEnabled: false },
    mode: 'normal',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":2,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.5,"hybridEnabled":false,"rerankerProvider":"cosine","prefetchFirstTurn":false}',
    key: 'rag:answer:9ac882bad4c27fd4c7ca82de891cbd88',
  },
  {
    name: 'threshold-diff',
    query: 'submit claims via portal',
    userId: 'user_7',
    cfg: { ...baseCfg, similarityThreshold: 0.7 },
    mode: 'normal',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":2,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.7,"hybridEnabled":true,"rerankerProvider":"cosine","prefetchFirstTurn":false}',
    key: 'rag:answer:290e190ed4324c44a6e102ade990f851',
  },
  {
    name: 'prefetch-on',
    query: 'submit claims via portal',
    userId: 'user_7',
    cfg: { ...baseCfg, prefetchFirstTurn: true },
    mode: 'normal',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":2,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.5,"hybridEnabled":true,"rerankerProvider":"cosine","prefetchFirstTurn":true}',
    key: 'rag:answer:823e1b624c153fc45728f570ebccc3de',
  },
];

describe('chat turn cache-key golden parity (R3)', () => {
  it.each(FIXTURES.map((f) => [f.name, f] as const))(
    'reproduces the pre-migration key for %s',
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

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
    fingerprint: '{"promptVersion":1,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.5,"hybridEnabled":true,"rerankerProvider":"cosine","prefetchFirstTurn":false}',
    key: 'rag:answer:b9864d3790c8e45f1a0f23468ade6120',
  },
  {
    name: 'query-normalization',
    query: '  What   is the  POLICY? ',
    userId: 'user_1',
    cfg: { ...baseCfg },
    mode: 'normal',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":1,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.5,"hybridEnabled":true,"rerankerProvider":"cosine","prefetchFirstTurn":false}',
    key: 'rag:answer:633a6b9a202ca7d703a932932ab97373',
  },
  {
    name: 'punct-space',
    query: 'refund policy ?',
    userId: 'user_1',
    cfg: { ...baseCfg },
    mode: 'normal',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":1,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.5,"hybridEnabled":true,"rerankerProvider":"cosine","prefetchFirstTurn":false}',
    key: 'rag:answer:63989a4c3e5beecfc011e1996b0f99a8',
  },
  {
    name: 'agentic-mode',
    query: 'where is my refund?',
    userId: 'user_2',
    cfg: { ...baseCfg, retrievalMode: 'agentic' },
    mode: 'agentic',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":1,"mode":"agentic","retrievalMode":"agentic","similarityThreshold":0.5,"hybridEnabled":true,"rerankerProvider":"cosine","prefetchFirstTurn":false}',
    key: 'rag:answer:45e37132c361070420e1f3d50bc42637',
  },
  {
    name: 'agentic-inverted-rollout',
    query: 'dress code',
    userId: 'user_2',
    cfg: { ...baseCfg },
    mode: 'agentic',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":1,"mode":"agentic","retrievalMode":"normal","similarityThreshold":0.5,"hybridEnabled":true,"rerankerProvider":"cosine","prefetchFirstTurn":false}',
    key: 'rag:answer:4a04b8b242ff2c84c5e93a05221aae93',
  },
  {
    name: 'different-user',
    query: 'How do I reset my password?',
    userId: 'user_99',
    cfg: { ...baseCfg },
    mode: 'normal',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":1,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.5,"hybridEnabled":true,"rerankerProvider":"cosine","prefetchFirstTurn":false}',
    key: 'rag:answer:deb4ca402be3a0e3d7dc9a1a80c032f9',
  },
  {
    name: 'different-chat-model',
    query: 'How do I reset my password?',
    userId: 'user_1',
    cfg: { ...baseCfg },
    mode: 'normal',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o',
    fingerprint: '{"promptVersion":1,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.5,"hybridEnabled":true,"rerankerProvider":"cosine","prefetchFirstTurn":false}',
    key: 'rag:answer:deb3f0e1468a9cbe835c823b2f06302d',
  },
  {
    name: 'different-embedding',
    query: 'How do I reset my password?',
    userId: 'user_1',
    cfg: { ...baseCfg },
    mode: 'normal',
    embeddingModel: 'text-embedding-3-large',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":1,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.5,"hybridEnabled":true,"rerankerProvider":"cosine","prefetchFirstTurn":false}',
    key: 'rag:answer:c12f9c92cf2157f8776caf0348d60471',
  },
  {
    name: 'reranker-cohere',
    query: 'school cell phone policy',
    userId: 'user_7',
    cfg: { ...baseCfg, rerankerProvider: 'cohere' },
    mode: 'normal',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":1,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.5,"hybridEnabled":true,"rerankerProvider":"cohere","prefetchFirstTurn":false}',
    key: 'rag:answer:7bcd71b63bfba06e2df61f256ba6d452',
  },
  {
    name: 'hybrid-off',
    query: 'submit claims via portal',
    userId: 'user_7',
    cfg: { ...baseCfg, hybridEnabled: false },
    mode: 'normal',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":1,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.5,"hybridEnabled":false,"rerankerProvider":"cosine","prefetchFirstTurn":false}',
    key: 'rag:answer:59651f8e88e2159ff815e43cdd832ca3',
  },
  {
    name: 'threshold-diff',
    query: 'submit claims via portal',
    userId: 'user_7',
    cfg: { ...baseCfg, similarityThreshold: 0.7 },
    mode: 'normal',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":1,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.7,"hybridEnabled":true,"rerankerProvider":"cosine","prefetchFirstTurn":false}',
    key: 'rag:answer:e34d9c931de02fccefdf177bfe7f192e',
  },
  {
    name: 'prefetch-on',
    query: 'submit claims via portal',
    userId: 'user_7',
    cfg: { ...baseCfg, prefetchFirstTurn: true },
    mode: 'normal',
    embeddingModel: 'text-embedding-3-small',
    chatModel: 'gpt-4o-mini',
    fingerprint: '{"promptVersion":1,"mode":"normal","retrievalMode":"normal","similarityThreshold":0.5,"hybridEnabled":true,"rerankerProvider":"cosine","prefetchFirstTurn":true}',
    key: 'rag:answer:c1bf81f0d0579782c0977ec66a8b8048',
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
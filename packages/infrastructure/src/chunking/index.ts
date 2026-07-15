import type { ChunkingStrategy, EmbeddingService } from '@app/domain';
import { getEmbeddingModelId } from '../llm';
import { documentAwareSplitter } from './strategies/document-aware';
import { adaptiveRecursiveSplitter } from './strategies/recursive-adaptive';
import { makeSemanticSplitter } from './strategies/semantic';
import { preChunkedSplitter } from './strategies/pre-chunked';

export type ChunkingStrategyName =
  | 'document-aware'
  | 'recursive-adaptive'
  | 'semantic'
  | 'pre-chunked';

export interface ChunkingStrategyOptions {
  embeddings: EmbeddingService;
  modelId?: string;
}

export function getChunkingStrategy(
  name: ChunkingStrategyName,
  opts: ChunkingStrategyOptions,
): ChunkingStrategy {
  const modelId = opts.modelId ?? getEmbeddingModelId();
  switch (name) {
    case 'document-aware':
      return documentAwareSplitter(modelId);
    case 'recursive-adaptive':
      return adaptiveRecursiveSplitter(modelId);
    case 'semantic':
      return makeSemanticSplitter(opts.embeddings, modelId);
    case 'pre-chunked':
      return preChunkedSplitter(modelId);
    default: {
      const _exhaustive: never = name;
      throw new Error(`Unknown chunking strategy: ${_exhaustive}`);
    }
  }
}

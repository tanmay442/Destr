import type { ChunkingStrategy, EmbeddingService } from '@app/domain';
import { getEmbeddingModelId } from '../llm';
import { documentAwareSplitter } from './strategies/document-aware';
import { adaptiveRecursiveSplitter } from './strategies/recursive-adaptive';
import { makeSemanticSplitter } from './strategies/semantic';
import { preChunkedSplitter } from './strategies/pre-chunked';
import { parentChildSplitter } from './strategies/parent-child';

export type ChunkingStrategyName =
  | 'document-aware'
  | 'recursive-adaptive'
  | 'semantic'
  | 'pre-chunked'
  | 'parent-child';

export interface ChunkingStrategyOptions {
  embeddings: EmbeddingService;
  modelId?: string;
  /** Parent-child strategy tunables (Session 5). */
  parentSize?: number;
  childSize?: number;
  overlap?: number;
  maxChunkSize?: number;
}

export function getChunkingStrategy(
  name: ChunkingStrategyName,
  opts: ChunkingStrategyOptions,
): ChunkingStrategy {
  const modelId = opts.modelId ?? getEmbeddingModelId();
  switch (name) {
    case 'document-aware':
      return documentAwareSplitter(modelId, {
        maxChunkSize: opts.maxChunkSize,
        overlap: opts.overlap,
      });
    case 'recursive-adaptive':
      return adaptiveRecursiveSplitter(modelId);
    case 'semantic':
      return makeSemanticSplitter(opts.embeddings, modelId);
    case 'pre-chunked':
      return preChunkedSplitter(modelId);
    case 'parent-child':
      return parentChildSplitter(modelId, {
        parentSize: opts.parentSize,
        childSize: opts.childSize,
        overlap: opts.overlap,
      });
    default: {
      const _exhaustive: never = name;
      throw new Error(`Unknown chunking strategy: ${_exhaustive}`);
    }
  }
}

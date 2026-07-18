import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { EmbeddingModelV3 } from '@ai-sdk/provider';
import { VECTOR_DIM } from '../db/schema-vector';

export function getEmbeddingModel(): EmbeddingModelV3 {
  const apiKey = process.env.AI_STUDIO_KEY;
  if (!apiKey) {
    throw new Error('AI_STUDIO_KEY is not set.');
  }
  const google = createGoogleGenerativeAI({ apiKey });
  return google.textEmbedding('gemini-embedding-001') as EmbeddingModelV3;
}

export const EMBEDDING_OPTIONS = {
  outputDimensionality: VECTOR_DIM,
} as const;

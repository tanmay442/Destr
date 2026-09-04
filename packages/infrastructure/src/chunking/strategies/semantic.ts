import type { ChunkingStrategy, EmbeddingService } from '@app/domain';
import { EMBEDDING_BATCH_SIZE } from '@app/domain';
import {
  buildPageSpans,
  cosineSimilarity,
  pageForOffset,
  semanticSplitCutoff,
  splitSentences,
  makeDocumentChunk,
} from '../shared';
import { adaptiveRecursiveSplitter } from './recursive-adaptive';

const SEMANTIC_CUTOFF_PERCENTILE = 90;
const SEMANTIC_MIN_ABSOLUTE_GAP = 0.1;
const MIN_CHUNK = 300;
const MAX_CHUNK = 600;
/** Above this sentence count the semantic strategy gives up on embedding every
 *  sentence and falls back to the cheaper recursive-adaptive splitter so a
 *  large document can never burn unbounded embedding budget. */
const SEMANTIC_MAX_SENTENCES = 2000;

async function embedSentencesProgressive(
  embeddings: EmbeddingService,
  sentences: Array<{ text: string }>,
): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let i = 0; i < sentences.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = sentences.slice(i, i + EMBEDDING_BATCH_SIZE).map((s) => s.text);
    const embedded = await embeddings.embedBatch(batch);
    vectors.push(...embedded);
  }
  return vectors;
}

export function makeSemanticSplitter(embeddings: EmbeddingService, modelId: string): ChunkingStrategy {
  const fallback = adaptiveRecursiveSplitter(modelId);
  return {
    async splitPages(pages) {
      const spans = buildPageSpans(pages);
      const merged = spans.map((s) => s.text).join('\n\n');
      const sentences = splitSentences(merged);
      if (sentences.length === 0) return [];
      if (sentences.length > SEMANTIC_MAX_SENTENCES) {
        return fallback.splitPages(pages);
      }

      let vectors: number[][];
      try {
        vectors = await embedSentencesProgressive(embeddings, sentences);
      } catch {
        return fallback.splitPages(pages);
      }
      if (vectors.length !== sentences.length) {
        throw new Error(
          `embedding count mismatch: got ${vectors.length} vectors for ${sentences.length} sentences`,
        );
      }
      const dim = vectors[0]?.length ?? 0;
      for (const v of vectors) {
        if (!Array.isArray(v) || v.length === 0 || v.length !== dim) {
          throw new Error('embedding model returned empty or mismatched-dimension vectors');
        }
      }

      const segments: number[][] = [];
      let current: number[] = [];
      const distances: number[] = [];
      for (let i = 1; i < sentences.length; i++) {
        distances.push(1 - cosineSimilarity(vectors[i - 1]!, vectors[i]!));
      }
      const cutoff = semanticSplitCutoff(distances, SEMANTIC_CUTOFF_PERCENTILE, SEMANTIC_MIN_ABSOLUTE_GAP);
      for (let i = 0; i < sentences.length; i++) {
        if (i > 0 && distances[i - 1]! > cutoff && current.length > 0) {
          segments.push(current);
          current = [];
        }
        current.push(i);
      }
      if (current.length > 0) segments.push(current);

      const chunks = [];
      let idx = 0;
      for (const seg of segments) {
        let buffer = '';
        let segStart = -1;
        for (const si of seg) {
          const s = sentences[si]!;
          if (segStart === -1) segStart = s.start;
          if (
            buffer &&
            buffer.length + s.text.length + 1 > MAX_CHUNK &&
            buffer.length >= MIN_CHUNK
          ) {
            const page = pageForOffset(spans, segStart);
            chunks.push(
              makeDocumentChunk({
                content: buffer,
                chunkIndex: idx++,
                page,
                modelId,
                source: `Page ${page}`,
              }),
            );
            buffer = s.text;
          } else {
            buffer = buffer ? buffer + ' ' + s.text : s.text;
          }
        }
        if (buffer) {
          const start = segStart === -1 ? 0 : segStart;
          const page = pageForOffset(spans, start);
          chunks.push(
            makeDocumentChunk({
              content: buffer,
              chunkIndex: idx++,
              page,
              modelId,
              source: `Page ${page}`,
            }),
          );
        }
      }
      return chunks;
    },
  };
}

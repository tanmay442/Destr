import type { ChunkingStrategy, EmbeddingService } from '@app/domain';
import {
  buildPageSpans,
  cosineSimilarity,
  embedSentences,
  pageForOffset,
  splitSentences,
  makeDocumentChunk,
} from '../shared';

const TOPIC_THRESHOLD = 0.3;
const MIN_CHUNK = 300;
const MAX_CHUNK = 600;

export function makeSemanticSplitter(embeddings: EmbeddingService, modelId: string): ChunkingStrategy {
  return {
    async splitPages(pages) {
      const spans = buildPageSpans(pages);
      const merged = spans.map((s) => s.text).join('\n\n');
      const sentences = splitSentences(merged);
      if (sentences.length === 0) return [];

      const vectors = await embedSentences(embeddings, sentences);
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
      for (let i = 0; i < sentences.length; i++) {
        if (i > 0 && cosineSimilarity(vectors[i - 1]!, vectors[i]!) < TOPIC_THRESHOLD && current.length > 0) {
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

import type { ChunkingStrategy, DocumentChunk, EmbeddingService } from '@app/domain';
import {
  buildPageSpans,
  cosineSimilarity,
  embedSentences,
  pageForOffset,
  splitSentences,
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

      const chunks: DocumentChunk[] = [];
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
            chunks.push({
              content: buffer,
              chunkIndex: idx++,
              page,
              sectionTitle: null,
              source: `Page ${page}`,
              embeddingModel: modelId,
            });
            buffer = s.text;
          } else {
            buffer = buffer ? buffer + ' ' + s.text : s.text;
          }
        }
        if (buffer) {
          const start = segStart === -1 ? 0 : segStart;
          const page = pageForOffset(spans, start);
          chunks.push({
            content: buffer,
            chunkIndex: idx++,
            page,
            sectionTitle: null,
            source: `Page ${page}`,
            embeddingModel: modelId,
          });
        }
      }
      return chunks;
    },
  };
}

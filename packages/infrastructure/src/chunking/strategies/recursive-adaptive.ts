import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import type { ChunkingStrategy, DocumentChunk } from '@app/domain';
import { INGEST_CHUNK_SIZE, INGEST_CHUNK_OVERLAP } from '../../../../../config/constants';
import { buildPageSpans, mergeShortParagraphs, pageForOffset } from '../shared';

const MIN_PARAGRAPH = 200;

export function adaptiveRecursiveSplitter(modelId: string): ChunkingStrategy {
  return {
    async splitPages(pages) {
      const spans = buildPageSpans(pages);
      const merged = spans.map((s) => s.text).join('\n\n');

      const paragraphs: Array<{ text: string; start: number }> = [];
      let pos = 0;
      for (const block of merged.split(/\n{2,}/)) {
        const text = block.trim();
        if (text.length > 0) paragraphs.push({ text, start: pos });
        pos += block.length + 2;
      }
      const merged2 = mergeShortParagraphs(paragraphs, MIN_PARAGRAPH);

      const splitter = new RecursiveCharacterTextSplitter({
        chunkSize: INGEST_CHUNK_SIZE,
        chunkOverlap: INGEST_CHUNK_OVERLAP,
      });

      const chunks: DocumentChunk[] = [];
      let idx = 0;
      for (const para of merged2) {
        const pieces =
          para.text.length > INGEST_CHUNK_SIZE ? await splitter.splitText(para.text) : [para.text];
        const page = pageForOffset(spans, para.start);
        for (const piece of pieces) {
          chunks.push({
            content: piece,
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

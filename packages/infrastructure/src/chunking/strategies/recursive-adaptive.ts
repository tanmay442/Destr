import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import type { ChunkingStrategy } from '@app/domain';
import { INGEST_CHUNK_SIZE, INGEST_CHUNK_OVERLAP } from '@app/domain';
import { buildPageSpans, mergeShortParagraphs, pageForOffset, makeDocumentChunk } from '../shared';

const MIN_PARAGRAPH = 200;

export function adaptiveRecursiveSplitter(modelId: string): ChunkingStrategy {
  return {
    async splitPages(pages) {
      const spans = buildPageSpans(pages);
      const merged = spans.map((s) => s.text).join('\n\n');

      const paragraphs: Array<{ text: string; start: number }> = [];
      const sepRe = /\n{2,}/g;
      const sepEnds: number[] = [];
      let mm: RegExpExecArray | null;
      while ((mm = sepRe.exec(merged)) !== null) sepEnds.push(mm.index + mm[0].length);
      const blocks = merged.split(/\n{2,}/);
      let pos = 0;
      blocks.forEach((block, i) => {
        const text = block.trim();
        if (text.length > 0) paragraphs.push({ text, start: pos });
        pos = sepEnds[i] ?? merged.length;
      });
      const merged2 = mergeShortParagraphs(paragraphs, MIN_PARAGRAPH);

      const splitter = new RecursiveCharacterTextSplitter({
        chunkSize: INGEST_CHUNK_SIZE,
        chunkOverlap: INGEST_CHUNK_OVERLAP,
      });

      const chunks = [];
      let idx = 0;
      for (const para of merged2) {
        const pieces =
          para.text.length > INGEST_CHUNK_SIZE ? await splitter.splitText(para.text) : [para.text];
        const page = pageForOffset(spans, para.start);
        for (const piece of pieces) {
          chunks.push(
            makeDocumentChunk({
              content: piece,
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

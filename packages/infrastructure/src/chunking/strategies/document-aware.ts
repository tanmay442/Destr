import type { ChunkingStrategy } from '@app/domain';
import { chunkBySentences, buildSections, mergeShortSections, makeDocumentChunk } from '../shared';

const SECTION_SPLIT_MAX = 800;
const SECTION_MERGE_MAX = 50;
const OVERLAP = 100;

export function documentAwareSplitter(modelId: string): ChunkingStrategy {
  return {
    async splitPages(pages) {
      const chunks = [];
      let chunkIndex = 0;
      for (const { page, text } of pages) {
        let sections = buildSections(text);
        sections = mergeShortSections(sections, SECTION_MERGE_MAX);
        for (const section of sections) {
          if (section.text.length === 0) continue;
          const title = section.title;
          const pieces =
            section.text.length > SECTION_SPLIT_MAX
              ? chunkBySentences(section.text, SECTION_SPLIT_MAX, OVERLAP)
              : [section.text];
          for (const piece of pieces) {
            const source = title ? `Page ${page} — ${title}` : `Page ${page}`;
            chunks.push(
              makeDocumentChunk({
                content: piece,
                chunkIndex: chunkIndex++,
                page,
                modelId,
                sectionTitle: title,
                source,
              }),
            );
          }
        }
      }
      return chunks;
    },
  };
}

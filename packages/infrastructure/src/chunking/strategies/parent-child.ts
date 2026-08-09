import type { ChunkingStrategy } from '@app/domain';
import {
  chunkBySentences,
  buildSections,
  mergeShortSections,
  makeDocumentChunk,
  cleanTextArtifacts,
  CHILD_TOKEN_CAP,
  type Section,
} from '../shared';

const DEFAULT_PARENT_SIZE = 2200;
const DEFAULT_CHILD_SIZE = 700;
const DEFAULT_OVERLAP = 130;
const SECTION_MERGE_MAX = 80;

export interface ParentChildOptions {
  parentSize?: number | undefined;
  childSize?: number | undefined;
  overlap?: number | undefined;
}

function snapToWordBoundary(text: string, targetIndex: number): number {
  if (targetIndex >= text.length) return text.length;
  const lastSpace = text.lastIndexOf(' ', targetIndex);
  return lastSpace > 0 ? lastSpace : targetIndex;
}

function splitOversizedText(text: string, maxSize: number): string[] {
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = start + maxSize;
    if (end < text.length) {
      end = snapToWordBoundary(text, end);
    }
    parts.push(text.slice(start, end).trim());
    start = end;
  }
  return parts;
}

function looksLikeTable(text: string): boolean {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return false;
  const pipeRows = lines.filter((l) => l.includes('|') && /\|.+\|/.test(l)).length;
  if (pipeRows >= 2) return true;
  // Spaced-column rows: a line with 2+ internal runs of 2+ spaces.
  const spacedRows = lines.filter((l) => (l.match(/ {2,}/g) ?? []).length >= 2).length;
  return spacedRows >= 2;
}

export function parentChildSplitter(modelId: string, opts: ParentChildOptions = {}): ChunkingStrategy {
  const parentSize = opts.parentSize ?? DEFAULT_PARENT_SIZE;
  const childSize = opts.childSize ?? DEFAULT_CHILD_SIZE;
  const overlap = opts.overlap ?? DEFAULT_OVERLAP;

  function groupIntoParents(sections: Section[]): Section[] {
    const parents: Section[] = [];
    let current: Section | null = null;

    for (const s of sections) {
      const sanitizedText = cleanTextArtifacts(s.text);
      if (!sanitizedText) continue;

      if (sanitizedText.length > parentSize) {
        if (current) {
          parents.push(current);
          current = null;
        }
        const subTexts = splitOversizedText(sanitizedText, parentSize);
        subTexts.forEach((partText, index) => {
          parents.push({
            title: s.title ? `${s.title} (Part ${index + 1})` : null,
            text: partText,
          });
        });
        continue;
      }

      const candidate = current
        ? (current.text + '\n\n' + (s.title ? s.title + '\n' : '') + sanitizedText).trim()
        : sanitizedText;

      if (current && candidate.length <= parentSize) {
        current.text = candidate;
      } else {
        if (current) parents.push(current);
        current = { title: s.title, text: sanitizedText };
      }
    }

    if (current) parents.push(current);
    return parents;
  }

  return {
    async splitPages(pages) {
      const chunks = [];
      let chunkIndex = 0;
      // Carry the last section title across pages so mid-page content keeps context.
      let lastTitle: string | null = null;

      for (const { page, text } of pages) {
        let sections = buildSections(text);
        sections = mergeShortSections(sections, SECTION_MERGE_MAX);
        const parents = groupIntoParents(sections);

        for (const parent of parents) {
          if (parent.text.trim().length === 0) continue;

          const parentIndex = chunkIndex++;
          const parentTitle = parent.title ?? lastTitle;
          if (parent.title) lastTitle = parent.title;
          const parentSource = parentTitle ? `Page ${page} — ${parentTitle}` : `Page ${page}`;

          chunks.push(
            makeDocumentChunk({
              content: parent.text,
              chunkIndex: parentIndex,
              page,
              modelId,
              sectionTitle: parentTitle,
              source: parentSource,
              parentChunkId: null,
              kind: 'parent',
            }),
          );

          // Split into children, keeping table-like content atomic.
          const children =
            parent.text.length > childSize && !looksLikeTable(parent.text)
              ? chunkBySentences(parent.text, childSize, overlap, modelId, CHILD_TOKEN_CAP)
              : [parent.text];

          for (const child of children) {
            const cleanedChild = child.trim();
            const contextPrefix = parentTitle ? `[Context: ${parentTitle}]\n` : '';
            const contentWithContext = contextPrefix + cleanedChild;
            const childSource = parentTitle ? `Page ${page} — ${parentTitle}` : `Page ${page}`;

            chunks.push(
              makeDocumentChunk({
                content: contentWithContext,
                chunkIndex: chunkIndex++,
                page,
                modelId,
                sectionTitle: parentTitle,
                source: childSource,
                parentChunkId: parentIndex,
                kind: 'child',
              }),
            );
          }
        }
      }
      return chunks;
    },
  };
}

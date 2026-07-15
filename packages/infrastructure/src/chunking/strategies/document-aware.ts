import type { ChunkingStrategy, DocumentChunk } from '@app/domain';
import { chunkBySentences } from '../shared';

const SECTION_SPLIT_MAX = 800;
const SECTION_MERGE_MAX = 50;
const OVERLAP = 100;

interface Section {
  title: string | null;
  text: string;
}

function isHeadingLine(line: string, avgLen: number): boolean {
  const t = line.trim();
  if (t.length === 0 || t.length > 120) return false;
  if (/^#{1,6}\s+/.test(t)) return true;
  if (/^[A-Z][A-Za-z0-9' ]{2,}:\s*$/.test(t)) return true;
  const letters = t.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 3 && t === t.toUpperCase() && /[A-Z]/.test(t) && !/[a-z]/.test(t)) return true;
  if (t.length < Math.max(15, avgLen * 0.4)) return true;
  return false;
}

function buildSections(text: string): Section[] {
  const lines = text.split(/\r?\n/);
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  const avgLen = nonEmpty.length
    ? nonEmpty.reduce((a, l) => a + l.trim().length, 0) / nonEmpty.length
    : 0;
  const sections: Section[] = [];
  let currentTitle: string | null = null;
  let currentLines: string[] = [];
  const flush = () => {
    const body = currentLines.join('\n').trim();
    if (body.length > 0) sections.push({ title: currentTitle, text: body });
  };
  for (const line of lines) {
    const t = line.trim();
    if (t.length === 0) {
      currentLines.push('');
      continue;
    }
    if (isHeadingLine(line, avgLen)) {
      flush();
      currentTitle = t.replace(/^#+\s+/, '').replace(/:\s*$/, '').trim() || null;
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  flush();
  return sections;
}

function mergeShortSections(sections: Section[], minLen: number): Section[] {
  const out: Section[] = [];
  for (const s of sections) {
    const last = out[out.length - 1];
    if (s.text.length < minLen && last) {
      last.text = (last.text + '\n\n' + (s.title ? s.title + '\n' : '') + s.text).trim();
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

export function documentAwareSplitter(modelId: string): ChunkingStrategy {
  return {
    async splitPages(pages) {
      const chunks: DocumentChunk[] = [];
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
            chunks.push({
              content: piece,
              chunkIndex: chunkIndex++,
              page,
              sectionTitle: title,
              source,
              embeddingModel: modelId,
            });
          }
        }
      }
      return chunks;
    },
  };
}

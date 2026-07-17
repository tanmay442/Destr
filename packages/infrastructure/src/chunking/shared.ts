import type { EmbeddingService } from '@app/domain';

export interface Section {
  title: string | null;
  text: string;
}

export interface DocumentChunkInit {
  content: string;
  chunkIndex: number;
  page: number;
  modelId: string;
  sectionTitle?: string | null;
  source?: string;
  parentChunkId?: number | null;
  kind?: 'parent' | 'child' | 'summary';
}

/** Build a `DocumentChunk`, assembling the shared metadata fields. */
export function makeDocumentChunk(init: DocumentChunkInit) {
  return {
    content: init.content,
    chunkIndex: init.chunkIndex,
    page: init.page,
    sectionTitle: init.sectionTitle ?? null,
    source: init.source ?? `Page ${init.page}`,
    embeddingModel: init.modelId,
    parentChunkId: init.parentChunkId ?? null,
    kind: init.kind ?? 'child',
  };
}

/** Heuristic heading detection used to split a page into titled sections. */
export function isHeadingLine(line: string, avgLen: number): boolean {
  const t = line.trim();
  if (t.length === 0 || t.length > 120) return false;
  if (/^#{1,6}\s+/.test(t)) return true;
  if (/^[A-Z][A-Za-z0-9' ]{2,}:\s*$/.test(t)) return true;
  const letters = t.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 3 && t === t.toUpperCase() && /[A-Z]/.test(t) && !/[a-z]/.test(t)) return true;
  if (t.length < Math.max(15, avgLen * 0.4)) return true;
  return false;
}

/** Split a single page's text into titled sections at heading boundaries. */
export function buildSections(text: string): Section[] {
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

/** Merge consecutive sections shorter than `minLen` into the previous one. */
export function mergeShortSections(sections: Section[], minLen: number): Section[] {
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

export interface PageSpan {
  text: string;
  start: number;
  page: number;
}

/** Split text into sentences, returning each with its start offset (for page mapping). */
export function splitSentences(text: string): Array<{ text: string; start: number }> {
  const out: Array<{ text: string; start: number }> = [];
  const re = /[^.!?]+[.!?]+/g;
  let m: RegExpExecArray | null;
  let lastEnd = 0;
  while ((m = re.exec(text)) !== null) {
    const t = m[0].trim();
    if (t.length > 0) out.push({ text: t, start: m.index });
    lastEnd = m.index + m[0].length;
  }
  const tail = text.slice(lastEnd).trim();
  if (tail.length > 0) out.push({ text: tail, start: lastEnd });
  return out;
}

/** Greedily group sentences into chunks no larger than `maxSize`, carrying a
 *  trailing `overlap`-char suffix of the previous chunk into the next. */
export function chunkBySentences(text: string, maxSize: number, overlap: number): string[] {
  const sentences = splitSentences(text).map((s) => s.text);
  if (sentences.length <= 1) {
    const trimmed = text.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }
  const chunks: string[] = [];
  let current = sentences[0]!;
  for (let i = 1; i < sentences.length; i++) {
    const next = sentences[i]!;
    if ((current + ' ' + next).length <= maxSize) {
      current = current + ' ' + next;
    } else {
      chunks.push(current);
      const carry = current.length <= overlap ? current : current.slice(current.length - overlap);
      current = carry + ' ' + next;
    }
  }
  chunks.push(current);
  return chunks;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Record per-page text spans and their offsets within a merged string. */
export function buildPageSpans(pages: Array<{ page: number; text: string }>): PageSpan[] {
  const spans: PageSpan[] = [];
  let offset = 0;
  for (const p of pages) {
    spans.push({ text: p.text, start: offset, page: p.page });
    offset += p.text.length + 2;
  }
  return spans;
}

export function pageForOffset(spans: PageSpan[], offset: number): number {
  if (spans.length === 0) return 1;
  for (const s of spans) {
    if (offset >= s.start && offset < s.start + s.text.length) return s.page;
  }
  return spans[spans.length - 1]!.page;
}

/** Merge paragraphs shorter than `minLen` into the preceding paragraph. */
export function mergeShortParagraphs(
  paragraphs: Array<{ text: string; start: number }>,
  minLen: number,
): Array<{ text: string; start: number }> {
  const out: Array<{ text: string; start: number }> = [];
  for (const p of paragraphs) {
    const last = out[out.length - 1];
    if (p.text.length < minLen && last) {
      last.text = (last.text + '\n\n' + p.text).trim();
    } else {
      out.push({ ...p });
    }
  }
  return out;
}

/** Embed every sentence and return vectors in order. */
export async function embedSentences(
  embeddings: EmbeddingService,
  sentences: Array<{ text: string; start: number }>,
): Promise<number[][]> {
  if (sentences.length === 0) return [];
  return embeddings.embedBatch(sentences.map((s) => s.text));
}

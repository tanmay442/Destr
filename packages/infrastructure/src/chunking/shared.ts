import type { EmbeddingService } from '@app/domain';

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

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
export function isHeadingLine(line: string): boolean {
  const t = line.trim();
  if (t.length === 0 || t.length > 120) return false;
  if (/^#{1,6}\s+/.test(t)) return true;
  if (/^\d+(?:\.\d+)*\.?\s+[A-Z0-9]/.test(t)) return true;
  if (/^[A-Z][A-Za-z0-9' ]{2,}:\s*$/.test(t)) return true;
  const letters = t.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 3 && t === t.toUpperCase() && /[A-Z]/.test(t) && !/[a-z]/.test(t)) return true;
  return false;
}

/** Drop orphaned bullet/number artifact lines; keep any line with a letter. */
export function cleanTextArtifacts(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (/[a-zA-Z]/.test(trimmed)) return true;
      const isGarbageLine = /^[0-9\s.\-◦▪•\*]+$/.test(trimmed);
      return !isGarbageLine;
    })
    .join('\n')
    .trim();
}

/** Split a single page's text into titled sections at heading boundaries. */
export function buildSections(text: string): Section[] {
  const lines = text.split(/\r?\n/);
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
    if (isHeadingLine(line)) {
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

const ABBREVIATIONS = /\b(?:dr|mr|mrs|ms|prof|sr|jr|st|vs|etc|inc|ltd|co|e\.g|i\.e|no)\.?$/i;

/** Split into sentences at ASCII/CJK terminators (.!?。！？), guarding
 *  abbreviation endings and hard-splitting overlong runs at word boundaries. */
export function splitSentences(
  text: string,
  maxLen = 600,
): Array<{ text: string; start: number }> {
  // Mask internal "x.y" dots (decimals, versions, URLs) so they aren't split as terminators.
  const MASK = String.fromCharCode(1);
  const masked = text.replace(/([a-z0-9])\.([a-z0-9])/gi, "$1" + MASK + "$2");

  const out: Array<{ text: string; start: number }> = [];
  const re = /[^.!?。！？]+[.!?。！？]+/g;
  let m: RegExpExecArray | null;
  let lastEnd = 0;
  let buf = '';
  let bufStart = 0;
  while ((m = re.exec(masked)) !== null) {
    const piece = m[0].split(MASK).join(".");
    const start = buf.length === 0 ? m.index : bufStart;
    buf += piece;
    if (!ABBREVIATIONS.test(buf.trim())) {
      out.push({ text: buf.trim(), start });
      buf = '';
      bufStart = m.index + piece.length;
    }
    lastEnd = m.index + piece.length;
  }
  const tail = masked.slice(lastEnd);
  if (tail.trim().length > 0) buf += tail.split(MASK).join(".");
  if (buf.trim().length > 0) out.push({ text: buf.trim(), start: bufStart });

  const hardSplit = (s: { text: string; start: number }): Array<{ text: string; start: number }> => {
    if (s.text.length <= maxLen) return [s];
    const parts: Array<{ text: string; start: number }> = [];
    const words = s.text.split(/(\s+)/);
    let cur = '';
    let curStart = s.start;
    for (const w of words) {
      if (cur.length + w.length > maxLen && cur.trim().length > 0) {
        parts.push({ text: cur.trim(), start: curStart });
        cur = w;
        curStart = s.start + s.text.indexOf(w.trim(), curStart - s.start);
      } else {
        cur += w;
      }
    }
    if (cur.trim().length > 0) parts.push({ text: cur.trim(), start: curStart });
    return parts;
  };
  return out.flatMap(hardSplit);
}

/** Group sentences into chunks no larger than `maxSize` chars (or `tokenCap`
 *  tokens when `modelId` is given), carrying an `overlap`-char suffix over. */
export function chunkBySentences(
  text: string,
  maxSize: number,
  overlap: number,
  modelId?: string,
  tokenCap?: number,
): string[] {
  const fits = (s: string): boolean =>
    modelId && tokenCap ? estimateTokens(s, modelId) <= tokenCap : s.length <= maxSize;
  const sentences = splitSentences(text).map((s) => s.text);
  if (sentences.length <= 1) {
    const trimmed = text.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }
  const chunks: string[] = [];
  let current = sentences[0]!;
  for (let i = 1; i < sentences.length; i++) {
    const next = sentences[i]!;
    if (fits(current + ' ' + next)) {
      current = current + ' ' + next;
    } else {
      chunks.push(current);
      const carryLen = Math.min(overlap, current.length);
      let carry = carryLen > 0 ? current.slice(current.length - carryLen) : '';
      // Snap carry to a word boundary to avoid splitting words across chunks.
      const firstSpace = carry.indexOf(' ');
      if (firstSpace > 0) carry = carry.slice(firstSpace);
      current = carry.trim() ? carry.trim() + ' ' + next : next;
    }
  }
  chunks.push(current);
  return chunks;
}

/** Tokens per char per embedding model; defaults to 1 (CJK ≈ 1 token/char),
 *  ~0.25 for English-heavy OpenAI models. Gates child size on tokens. */
const TOKENS_PER_CHAR: Record<string, number> = {
  'text-embedding-3-small': 0.25,
  'text-embedding-3-large': 0.25,
  'text-embedding-ada-002': 0.25,
};

export function tokensPerChar(modelId: string): number {
  return TOKENS_PER_CHAR[modelId] ?? 1;
}

export function estimateTokens(text: string, modelId: string): number {
  return Math.ceil(text.length * tokensPerChar(modelId));
}

/** Default hard token cap applied to child chunks (keeps well under typical
 *  512/768-token embedding limits once overlap and metadata are added). */
export const CHILD_TOKEN_CAP = 400;

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

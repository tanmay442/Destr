import type { MarkdownParser, ParsedChunk } from '@app/domain';

/** Default delimiter used to separate pre-chunked Markdown segments. */
export const DEFAULT_MD_CHUNK_DELIMITER = '---chunk---';

/** Keys recognized in a chunk's leading metadata block. Unknown keys are ignored. */
const META_KEYS = new Set(['title', 'page', 'source']);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface ChunkMeta {
  title?: string;
  page?: number;
  source?: string;
}

/**
 * Split a segment into its leading metadata block and the remaining content.
 *
 * A metadata block is only recognized when every leading line is a valid
 * `key: value` pair AND the block is terminated by a blank line. Without that
 * blank line (or when a non-meta line appears first) the whole segment is
 * treated as content so leading prose is never silently consumed. Parsing is
 * defensive: unknown keys are ignored and a non-integer `page` is dropped.
 */
function extractMetaAndContent(segment: string): { meta: ChunkMeta; content: string } {
  const lines = segment.split(/\r?\n/);
  const meta: ChunkMeta = {};
  let i = 0;
  while (i < lines.length && lines[i]!.trim() !== '') {
    if (!/^[A-Za-z_][A-Za-z0-9_]*\s*:/.test(lines[i]!)) {
      return { meta: {}, content: segment.trim() };
    }
    i++;
  }
  if (i === 0 || i >= lines.length || lines[i]!.trim() !== '') {
    return { meta: {}, content: segment.trim() };
  }
  for (let j = 0; j < i; j++) {
    const match = lines[j]!.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    const value = match[2]!.trim();
    if (!META_KEYS.has(key) || value === '') continue;
    if (key === 'title') meta.title = value;
    else if (key === 'page') {
      const n = Number(value);
      if (Number.isInteger(n)) meta.page = n;
    } else if (key === 'source') meta.source = value;
  }
  const content = lines.slice(i + 1).join('\n').trim();
  return { meta, content };
}

const FENCE_OPEN_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RE = /^( {0,3})(`{3,}|~{3,})[ \t]*$/;

function isFenceOpener(line: string): { character: string; length: number } | null {
  const match = line.match(FENCE_OPEN_RE);
  if (!match) return null;
  const marker = match[2]!;
  if (marker.startsWith('`') && match[3]!.includes('`')) return null;
  return { character: marker[0]!, length: marker.length };
}

/** Split text at delimiter lines, ignoring lines that appear inside fenced
 *  code blocks so documented delimiters are not treated as segment breaks. */
function splitOutsideFences(text: string, delimiter: string): string[] {
  const fenceRe = new RegExp(`^${escapeRegExp(delimiter)}\\s*$`);
  const lines = text.split(/\r?\n/);
  const segments: string[] = [];
  let buf: string[] = [];
  let fence: { character: string; length: number } | null = null;
  for (const line of lines) {
    if (fence === null) {
      const open = isFenceOpener(line);
      if (open) {
        fence = open;
        buf.push(line);
        continue;
      }
      if (fenceRe.test(line)) {
        segments.push(buf.join('\n'));
        buf = [];
        continue;
      }
      buf.push(line);
    } else {
      buf.push(line);
      const close = line.match(FENCE_CLOSE_RE);
      if (
        close &&
        close[2]![0] === fence.character &&
        close[2]!.length >= fence.length
      ) {
        fence = null;
      }
    }
  }
  // Unclosed fence: fall back to naive splitting so delimiters still act as segment separators.
  if (fence !== null) {
    const out: string[] = [];
    let cur: string[] = [];
    for (const line of lines) {
      if (fenceRe.test(line)) {
        out.push(cur.join('\n'));
        cur = [];
      } else {
        cur.push(line);
      }
    }
    out.push(cur.join('\n'));
    return out;
  }
  segments.push(buf.join('\n'));
  return segments;
}

export const markdownParser: MarkdownParser = {
  parseChunkedMarkdown(text: string, delimiter?: string): ParsedChunk[] {
    const delim = delimiter ?? DEFAULT_MD_CHUNK_DELIMITER;
    const segments = splitOutsideFences(text, delim);
    const chunks: ParsedChunk[] = [];
    for (const segment of segments) {
      const trimmed = segment.trim();
      if (trimmed === '') continue;
      const { meta, content } = extractMetaAndContent(trimmed);
      if (content === '') continue;
      chunks.push({
        content,
        page: meta.page ?? null,
        sectionTitle: meta.title ?? null,
        source: meta.source ?? null,
      });
    }
    return chunks;
  },
};

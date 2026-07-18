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
 * Metadata lines are `key: value` pairs at the very top of the segment. The
 * block ends at the first blank line or the first line that is not a valid
 * `key: value` pair; everything after that is treated as content. Parsing is
 * defensive: unknown keys are ignored and an unparseable `page` is dropped.
 */
function extractMetaAndContent(segment: string): { meta: ChunkMeta; content: string } {
  const lines = segment.split(/\r?\n/);
  const meta: ChunkMeta = {};
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') break;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!match) break;
    const key = match[1]!.toLowerCase();
    const value = match[2]!.trim();
    if (!META_KEYS.has(key) || value === '') continue;
    if (key === 'title') meta.title = value;
    else if (key === 'page') {
      const n = Number(value);
      if (Number.isFinite(n)) meta.page = n;
    } else if (key === 'source') meta.source = value;
  }
  const content = lines.slice(i).join('\n').trim();
  return { meta, content };
}

const FENCE_RE = /^( {0,3})(`{3,}|~{3,})/;

function isFenceOpener(line: string): { marker: string } | null {
  const m = line.match(FENCE_RE);
  if (!m) return null;
  return { marker: m[2]! };
}

/** Split text at delimiter lines, ignoring lines that appear inside fenced
 *  code blocks so documented delimiters are not treated as segment breaks. */
export function splitOutsideFences(text: string, delimiter: string): string[] {
  const fenceRe = new RegExp(`^${escapeRegExp(delimiter)}\\s*$`);
  const lines = text.split(/\r?\n/);
  const segments: string[] = [];
  let buf: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    if (fence === null) {
      const open = isFenceOpener(line);
      if (open) {
        fence = open.marker[0]!.repeat(3);
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
      const close = line.match(FENCE_RE);
      if (close && close[2]![0] === fence[0]) fence = null;
    }
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

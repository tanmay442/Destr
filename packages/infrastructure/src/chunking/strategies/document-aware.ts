import type { ChunkingStrategy } from '@app/domain';
import { makeDocumentChunk, chunkBySentences, isHeadingLine, cleanTextArtifacts } from '../shared';

interface SplitOptions {
  maxChunkSize?: number;
  overlap?: number;
}

interface Block {
  type: 'header' | 'paragraph' | 'list' | 'table' | 'other';
  level: number;
  text: string;
  raw: string;
  page: number;
}

function parseMarkdownBlocks(text: string, page: number): Block[] {
  const normalized = text
    .replace(/(\.)(?=\s*\d+(?:\.\d+)*\.?\s+[A-Z0-9])/g, '$1\n\n')
    .replace(/([a-z0-9])\.(\d+(?:\.\d+)*\.?\s+[A-Z])/g, '$1. $2');
  const lines = normalized.split(/\r?\n/);
  const blocks: Block[] = [];
  let current: { type: Block['type']; level: number; lines: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    const raw = current.lines.join('\n').trim();
    if (raw.length === 0) {
      current = null;
      return;
    }
    blocks.push({ type: current.type, level: current.level, text: raw, raw, page });
    current = null;
  };

  const isHeading = (line: string): boolean => {
    const t = line.trim();
    if (/:$/.test(t)) return false;
    if (/^\([^)]*\)$/.test(t)) return false;
    return isHeadingLine(line);
  };

  const pushLine = (type: Block['type'], level: number, line: string) => {
    if (current && (current.type !== type || (type === 'header' && current.level !== level))) {
      flush();
    }
    if (!current) current = { type, level, lines: [] };
    current.lines.push(line);
  };

  for (const line of lines) {
    const t = line.trim();
    if (t.length === 0) {
      flush();
      continue;
    }
    if (isHeading(line)) {
      flush();
      const level = /^(#{1,6})\s/.test(line) ? line.match(/^#+/)![0].length : 1;
      pushLine('header', level, t.replace(/^#+\s+/, '').replace(/:\s*$/, '').trim() || t);
      flush();
    } else if (/^\s*([-*•◦▪]|\d+\.)\s+/.test(line)) {
      pushLine('list', 0, line);
    } else if (line.includes('|') && /\|.+\|/.test(line)) {
      pushLine('table', 0, line);
    } else {
      pushLine('paragraph', 0, line);
    }
  }
  flush();
  return blocks
    .map((b) => ({ ...b, raw: cleanTextArtifacts(b.raw), text: cleanTextArtifacts(b.text) }))
    .filter((b) => b.raw.length > 0);
}

function updateHeaderHierarchy(headers: string[], level: number, text: string): string[] {
  const next = headers.slice(0, level - 1);
  next[level - 1] = text;
  return next.filter((h): h is string => Boolean(h));
}

function splitTable(raw: string, maxSize: number): string[] {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  if (lines.length < 3) {
    const single = raw.trim();
    return single.length > 0 ? [single] : [];
  }

  const header = lines[0]!;
  const sepIdx = lines.findIndex((l, i) => i > 0 && /^\|?[\s:|-]+\|?$/.test(l));
  const rows = sepIdx >= 0 ? lines.slice(sepIdx + 1) : lines.slice(1);
  if (rows.length === 0) {
    const single = raw.trim();
    return single.length > 0 ? [single] : [];
  }
  if (header.length >= maxSize) {
    return lines.filter((l) => l.length > 0);
  }
  const sep = sepIdx >= 0 ? '\n' + lines[sepIdx]! : '';
  const out: string[] = [];
  let current = header + sep;
  for (const row of rows) {
    if (row.length >= maxSize) {
      if (current.length > header.length) out.push(current);
      out.push(header + sep + '\n' + row);
      current = header + sep;
      continue;
    }
    if ((current + '\n' + row).length <= maxSize) {
      current += '\n' + row;
    } else {
      out.push(current);
      current = header + sep + '\n' + row;
    }
  }
  if (current.length > header.length) out.push(current);
  return out;
}

function recursiveTextSplitter(text: string, maxSize: number, overlap: number): string[] {
  if (text.length <= maxSize) return [text];
  return chunkBySentences(text, maxSize, overlap);
}

function attachContext(text: string, activeHeaders: string[]): string {
  if (activeHeaders.length === 0) return text;
  const contextHeader = `> **Context:** ${activeHeaders.join(' > ')}\n\n`;
  return contextHeader + text;
}

export function documentAwareSplitter(
  modelId: string,
  options: SplitOptions = {}
): ChunkingStrategy {
  const MAX_SIZE = options.maxChunkSize ?? 800;
  const OVERLAP = options.overlap ?? 100;

  return {
    async splitPages(pages) {
      const blocks: Block[] = [];
      for (const { page, text } of pages) {
        blocks.push(...parseMarkdownBlocks(text, page));
      }

      const chunks: ReturnType<typeof makeDocumentChunk>[] = [];
      let chunkIndex = 0;
      let currentChunk = '';
      let activeHeaders: string[] = [];
      let currentPage = pages[0]?.page ?? 1;

      const flush = () => {
        if (!currentChunk.trim()) return;
        let body = currentChunk.trim();
        const topHeader = activeHeaders[activeHeaders.length - 1];
        if (topHeader && body.endsWith(topHeader)) {
          body = body.slice(0, body.length - topHeader.length).replace(/\s+$/, '');
        }
        const source = topHeader ? `Page ${currentPage} — ${topHeader}` : `Page ${currentPage}`;
        chunks.push(
          makeDocumentChunk({
            content: attachContext(body, activeHeaders),
            chunkIndex: chunkIndex++,
            page: currentPage,
            modelId,
            sectionTitle: topHeader ?? null,
            source,
          }),
        );
        currentChunk = '';
      };

      for (const block of blocks) {
        currentPage = block.page;
        if (block.type === 'header') {
          flush();
          activeHeaders = updateHeaderHierarchy(activeHeaders, block.level, block.text);
          continue;
        }

        const combinedLength = currentChunk.length + block.raw.length;

        if (combinedLength <= MAX_SIZE) {
          currentChunk += (currentChunk ? '\n\n' : '') + block.raw;
        } else {
          flush();

          if (block.type === 'table') {
            if (block.raw.length <= MAX_SIZE) {
              currentChunk = block.raw;
            } else {
              for (const piece of splitTable(block.raw, MAX_SIZE)) {
                const source = activeHeaders[activeHeaders.length - 1]
                  ? `Page ${block.page} — ${activeHeaders[activeHeaders.length - 1]}`
                  : `Page ${block.page}`;
                chunks.push(
                  makeDocumentChunk({
                    content: attachContext(piece, activeHeaders),
                    chunkIndex: chunkIndex++,
                    page: block.page,
                    modelId,
                    sectionTitle: activeHeaders[activeHeaders.length - 1] ?? null,
                    source,
                  }),
                );
              }
            }
          } else if (block.raw.length > MAX_SIZE) {
            const subPieces = recursiveTextSplitter(block.raw, MAX_SIZE, OVERLAP);
            for (const piece of subPieces) {
              const source = activeHeaders[activeHeaders.length - 1]
                ? `Page ${block.page} — ${activeHeaders[activeHeaders.length - 1]}`
                : `Page ${block.page}`;
              chunks.push(
                makeDocumentChunk({
                  content: attachContext(piece, activeHeaders),
                  chunkIndex: chunkIndex++,
                  page: block.page,
                  modelId,
                  sectionTitle: activeHeaders[activeHeaders.length - 1] ?? null,
                  source,
                }),
              );
            }
          } else {
            currentChunk = block.raw;
          }
        }
      }

      flush();

      const pruned = chunks.filter((c) => c.content.trim().length > 0);
      pruned.forEach((c, i) => {
        c.chunkIndex = i;
      });
      return pruned;
    },
  };
}

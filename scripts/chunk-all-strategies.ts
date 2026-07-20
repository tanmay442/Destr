import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { EmbeddingService } from '@app/domain';
import { unpdfParser } from '../packages/infrastructure/src/pdf/unpdf-parser';
import { getChunkingStrategy, type ChunkingStrategyName } from '../packages/infrastructure/src/chunking/index';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALL_STRATEGIES: ChunkingStrategyName[] = [
  'document-aware',
  'recursive-adaptive',
  'semantic',
  'pre-chunked',
  'parent-child',
];

interface CliArgs {
  file: string | null;
  out: string;
  strategies: ChunkingStrategyName[];
}

/** Usage: [pdfPath] [--out dir] [--strategies a,b,c] */
function parseArgs(argv: string[]): CliArgs {
  let file: string | null = null;
  let out = resolve(__dirname, 'chunk-output');
  const strategies = [...ALL_STRATEGIES];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--out') {
      out = resolve(argv[++i] ?? out);
    } else if (arg === '--strategies') {
      const val = argv[++i] ?? '';
      const picked = val.split(',').map((s) => s.trim()).filter(Boolean) as ChunkingStrategyName[];
      if (picked.length > 0) {
        strategies.length = 0;
        strategies.push(...picked);
      }
    } else if (arg.startsWith('--')) {
      console.warn(`Unknown flag: ${arg} — ignoring.`);
    } else if (!file) {
      file = arg;
    }
  }

  return { file, out, strategies };
}

/** Offline mock embedding (bag-of-words hash) so the semantic strategy runs without keys. */
function makeMockEmbeddings(): EmbeddingService {
  const DIM = 64;
  const hash = (s: string) => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  };
  const embedOne = (value: string): number[] => {
    const v = new Array(DIM).fill(0);
    const words = value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    for (const w of words) {
      const h = hash(w);
      v[h % DIM] += 1;
    }
    const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
    return v.map((x) => x / norm);
  };
  return {
    async embed(value: string) {
      return embedOne(value);
    },
    async embedBatch(values: string[]) {
      return values.map(embedOne);
    },
  };
}

function escapeForHeader(s: string): string {
  return s.replace(/\n/g, ' ').trim().slice(0, 80) || '(untitled)';
}

function toMarkdown(name: string, chunks: Awaited<ReturnType<ReturnType<typeof getChunkingStrategy>['splitPages']>>): string {
  const lines: string[] = [];
  lines.push(`# Chunking output — ${name}`);
  lines.push('');
  lines.push(`- **Strategy:** \`${name}\``);
  lines.push(`- **Total chunks:** ${chunks.length}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  chunks.forEach((c, i) => {
    const kind = (c as { kind?: string }).kind ?? 'child';
    const header = `## Chunk ${i} — ${escapeForHeader(c.content)}`;
    lines.push(header);
    lines.push('');
    lines.push(`- **page:** ${c.page}`);
    lines.push(`- **index:** ${c.chunkIndex}`);
    lines.push(`- **source:** ${c.source ?? ''}`);
    lines.push(`- **sectionTitle:** ${c.sectionTitle ?? '∅'}`);
    lines.push(`- **kind:** ${kind}`);
    const parent = (c as { parentChunkId?: number | null }).parentChunkId;
    lines.push(`- **parentChunkId:** ${parent === null || parent === undefined ? '∅' : parent}`);
    lines.push(`- **embeddingModel:** ${c.embeddingModel}`);
    lines.push('');
    lines.push('```text');
    lines.push(c.content);
    lines.push('```');
    lines.push('');
  });

  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.file) {
    console.error('No PDF path provided.');
    console.error('Usage: tsx scripts/chunk-all-strategies.ts <pdfPath> [--out dir] [--strategies a,b,c]');
    console.error('  <pdfPath>   Path to the PDF to chunk (required).');
    console.error('  --out dir   Output directory (default: scripts/chunk-output).');
    console.error('  --strategies a,b,c  Comma-separated strategies (default: all).');
    process.exit(1);
  }

  const pdfPath = isAbsolute(args.file) ? args.file : resolve(process.cwd(), args.file);

  if (!existsSync(pdfPath)) {
    console.error(`PDF not found: ${pdfPath}`);
    console.error('Usage: tsx scripts/chunk-all-strategies.ts <pdfPath> [--out dir] [--strategies a,b,c]');
    process.exit(1);
  }

  const buffer = readFileSync(pdfPath);
  console.log(`Parsing PDF: ${pdfPath} (${(buffer.length / 1024).toFixed(1)} KB)`);
  const pages = await unpdfParser.extractPages(buffer);
  console.log(`Extracted ${pages.length} pages`);

  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(args.out, { recursive: true });

  const embeddings = makeMockEmbeddings();

  for (const name of args.strategies) {
    console.log(`\n=== Running ${name} ===`);
    const strategy = getChunkingStrategy(name, { embeddings });
    const chunks = await strategy.splitPages(pages);
    const md = toMarkdown(name, chunks);
    const outPath = join(args.out, `${name}.md`);
    writeFileSync(outPath, md, 'utf8');
    console.log(`  ${chunks.length} chunks -> ${outPath}`);
  }

  console.log('\nDone. Output written to:', args.out);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MD_CHUNK_DELIMITER } from '../../../../config/constants';
import { markdownParser } from '@app/infrastructure/markdown';
import { warn } from './common';
import { buildUploadDeps } from './deps';

export interface UploadParseResult {
  md?: string;
  pdf?: string;
  name?: string;
  user: string;
  delimiter?: string;
  dryRun: boolean;
}

export function parseUploadArgs(argv: string[]): UploadParseResult {
  let md: string | undefined;
  let pdf: string | undefined;
  let name: string | undefined;
  let delimiter: string | undefined;
  let user = 'cli-upload';
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--dry-run') {
      dryRun = true;
    } else if (a.startsWith('--md=')) {
      md = a.slice('--md='.length);
    } else if (a === '--md') {
      md = argv[++i];
    } else if (a.startsWith('--pdf=')) {
      pdf = a.slice('--pdf='.length);
    } else if (a === '--pdf') {
      pdf = argv[++i];
    } else if (a.startsWith('--name=')) {
      name = a.slice('--name='.length);
    } else if (a === '--name') {
      name = argv[++i];
    } else if (a.startsWith('--user=')) {
      user = a.slice('--user='.length);
    } else if (a === '--user') {
      const v = argv[i + 1];
      if (v && !v.startsWith('--')) {
        user = v;
        i++;
      }
    } else if (a.startsWith('--delimiter=')) {
      delimiter = a.slice('--delimiter='.length);
    } else if (a === '--delimiter') {
      delimiter = argv[++i];
    }
  }
  if (!md && process.env.UPLOAD_MD) md = process.env.UPLOAD_MD;
  return { md, pdf, name, user, delimiter, dryRun };
}

export interface UploadOptions {
  md?: string;
  pdf?: string;
  name?: string;
  user?: string;
  delimiter?: string;
  dryRun?: boolean;
  fixturesDir?: string;
  upload?: (input: {
    fileName: string;
    mdText: string;
    delimiter?: string;
    uploadedBy: string;
    pdfBuffer?: Buffer;
  }) => Promise<{ documentId: number; chunks: number; status: 'inserted' | 'updated' | 'unchanged' }>;
  storeBlob?: (documentId: number, buffer: Buffer, fileName: string) => Promise<void>;
}

function resolvePath(baseDir: string, p?: string): string | undefined {
  if (!p) return undefined;
  return resolve(baseDir, p);
}

export async function runUpload(opts: UploadOptions = {}): Promise<void> {
  const mdPath = resolvePath(opts.fixturesDir ?? process.cwd(), opts.md);
  if (!mdPath) {
    console.error('Missing --md <file.md> (required).');
    process.exit(1);
  }
  if (!existsSync(mdPath)) {
    console.error(`Markdown file not found: ${mdPath}`);
    process.exit(1);
  }

  const mdText = readFileSync(mdPath, 'utf8');
  const fileName = opts.name ?? mdPath.split(/[\\/]/).pop()!;

  // --dry-run: parse and summarize, never embed or store.
  if (opts.upload === undefined) {
    const parsed = markdownParser.parseChunkedMarkdown(mdText, opts.delimiter);
    console.log(`Parsed ${parsed.length} chunk(s) from ${mdPath}`);
    parsed.forEach((c: { sectionTitle?: string | null; page?: number | null; source?: string | null; content: string }, i: number) => {
      console.log(
        `  #${i} title=${c.sectionTitle ?? '(none)'} page=${c.page ?? '(none)'} source=${c.source ?? '(none)'} chars=${c.content.length}`,
      );
    });
    if (opts.dryRun) {
      console.log('--dry-run: no upload performed.');
      return;
    }
  }

  const uploadFn =
    opts.upload ??
    (async (input: { fileName: string; mdText: string; delimiter?: string; uploadedBy: string; pdfBuffer?: Buffer }) => {
      const { uploadPrechunkedMarkdown } = await import('@app/application/rag/ingest-prechunked');
      const deps = await buildUploadDeps();
      const r = await uploadPrechunkedMarkdown(
        { fileName: input.fileName, mdText: input.mdText, delimiter: input.delimiter, uploadedBy: input.uploadedBy, pdfBuffer: input.pdfBuffer },
        deps,
      );
      if (!r.ok) throw r.error;
      return r.value;
    });

  const pdfPath = resolvePath(opts.fixturesDir ?? process.cwd(), opts.pdf);
  let pdfBuffer: Buffer | undefined;
  if (pdfPath) {
    if (!existsSync(pdfPath)) {
      console.error(`PDF companion file not found: ${pdfPath}`);
      process.exit(1);
    }
    pdfBuffer = readFileSync(pdfPath);
  }

  try {
    const result = await uploadFn({
      fileName,
      mdText,
      delimiter: opts.delimiter,
      uploadedBy: opts.user ?? 'cli-upload',
      pdfBuffer,
    });
    console.log(
      `${fileName}: status=${result.status} documentId=${result.documentId} chunks=${result.chunks}`,
    );
  } catch (err: unknown) {
    console.error(`upload failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

import { isMainModule } from '../is-main-module';

if (isMainModule()) {
  try {
    process.loadEnvFile('.env.local');
  } catch (err) {
    if (existsSync('.env.local')) {
      warn(`Failed to load .env.local: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const HERE = dirname(fileURLToPath(import.meta.url));
  const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
  const args = parseUploadArgs(process.argv.slice(2));
  if (!args.md) {
    console.error('Usage: rag-agent upload --md <file.md> [--pdf <file.pdf>] [--user admin] [--name X] [--delimiter D] [--dry-run]');
    process.exit(1);
  }
  runUpload({
    md: resolve(REPO_ROOT, args.md),
    pdf: args.pdf ? resolve(REPO_ROOT, args.pdf) : undefined,
    name: args.name,
    user: args.user,
    delimiter: args.delimiter ?? MD_CHUNK_DELIMITER,
    dryRun: args.dryRun,
  }).catch((err) => {
    console.error('upload failed:', err);
    process.exit(1);
  });
}

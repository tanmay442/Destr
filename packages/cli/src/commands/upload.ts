import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import {
  UPLOAD_CHUNKED_MAX_MD_BYTES as DEFAULT_UPLOAD_CHUNKED_MAX_MD_BYTES,
  UPLOAD_CHUNKED_MAX_PDF_BYTES as DEFAULT_UPLOAD_CHUNKED_MAX_PDF_BYTES,
} from '@app/domain';
import { loadEnvConfig, MD_CHUNK_DELIMITER } from '@app/infrastructure/config';
import { markdownParser } from '@app/infrastructure/markdown';
import { getRepoRoot, warn } from './common';
import { buildUploadDeps } from './deps';

export interface UploadParseResult {
  md?: string | undefined;
  pdf?: string | undefined;
  name?: string | undefined;
  user: string;
  delimiter?: string | undefined;
  dryRun: boolean;
}

function parseOptionValue(value: string | undefined, option: string): string {
  if (value === undefined || value === '' || value.startsWith('--')) {
    throw new Error(`Missing value for ${option}`);
  }
  return value;
}

export function parseUploadArgs(argv: string[]): UploadParseResult {
  let md: string | undefined;
  let pdf: string | undefined;
  let name: string | undefined;
  let delimiter: string | undefined;
  let user = 'cli-upload';
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i]!;
    if (argument === '--dry-run') {
      dryRun = true;
    } else if (argument.startsWith('--md=')) {
      md = parseOptionValue(argument.slice('--md='.length), '--md');
    } else if (argument === '--md') {
      md = parseOptionValue(argv[++i], '--md');
    } else if (argument.startsWith('--pdf=')) {
      pdf = parseOptionValue(argument.slice('--pdf='.length), '--pdf');
    } else if (argument === '--pdf') {
      pdf = parseOptionValue(argv[++i], '--pdf');
    } else if (argument.startsWith('--name=')) {
      name = parseOptionValue(argument.slice('--name='.length), '--name');
    } else if (argument === '--name') {
      name = parseOptionValue(argv[++i], '--name');
    } else if (argument.startsWith('--user=')) {
      user = parseOptionValue(argument.slice('--user='.length), '--user');
    } else if (argument === '--user') {
      user = parseOptionValue(argv[++i], '--user');
    } else if (argument.startsWith('--delimiter=')) {
      delimiter = parseOptionValue(argument.slice('--delimiter='.length), '--delimiter');
    } else if (argument === '--delimiter') {
      delimiter = parseOptionValue(argv[++i], '--delimiter');
    } else if (argument.startsWith('--')) {
      throw new Error(`Unknown flag: ${argument}`);
    } else {
      throw new Error(`Unexpected argument: ${argument}`);
    }
  }
  if (!md && process.env.UPLOAD_MD) md = process.env.UPLOAD_MD;
  return { md, pdf, name, user, delimiter, dryRun };
}

export interface UploadOptions {
  md?: string | undefined;
  pdf?: string | undefined;
  name?: string | undefined;
  user?: string | undefined;
  delimiter?: string | undefined;
  dryRun?: boolean | undefined;
  fixturesDir?: string | undefined;
  upload?: (input: {
    fileName: string;
    mdText: string;
    delimiter?: string | undefined;
    uploadedBy: string;
    pdfBuffer?: Buffer | undefined;
  }) => Promise<{ documentId: number; chunks: number; status: 'inserted' | 'updated' | 'unchanged' }>;
  storeBlob?: (documentId: number, buffer: Buffer, fileName: string) => Promise<void>;
}

function getUploadLimits(): { maxMarkdownBytes: number; maxPdfBytes: number } {
  const config = loadEnvConfig({ get: (key) => process.env[key] });
  const maxMarkdownBytes = config.UPLOAD_CHUNKED_MAX_MD_BYTES;
  const maxPdfBytes = config.UPLOAD_CHUNKED_MAX_PDF_BYTES;
  return {
    maxMarkdownBytes:
      typeof maxMarkdownBytes === 'number' && Number.isFinite(maxMarkdownBytes)
        ? maxMarkdownBytes
        : DEFAULT_UPLOAD_CHUNKED_MAX_MD_BYTES,
    maxPdfBytes:
      typeof maxPdfBytes === 'number' && Number.isFinite(maxPdfBytes)
        ? maxPdfBytes
        : DEFAULT_UPLOAD_CHUNKED_MAX_PDF_BYTES,
  };
}

function isPdf(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.toString('utf8', 0, 4) === '%PDF';
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

  const { maxMarkdownBytes, maxPdfBytes } = getUploadLimits();
  const mdStats = statSync(mdPath);
  if (!mdStats.isFile()) {
    console.error(`Markdown path is not a file: ${mdPath}`);
    process.exit(1);
  }
  if (mdStats.size > maxMarkdownBytes) {
    console.error(`Markdown file exceeds maximum size of ${maxMarkdownBytes} bytes: ${mdPath}`);
    process.exit(1);
  }

  const mdText = readFileSync(mdPath, 'utf8');
  const mdByteLength = Buffer.byteLength(mdText, 'utf8');
  if (mdByteLength > maxMarkdownBytes) {
    console.error(`Markdown file exceeds maximum size of ${maxMarkdownBytes} bytes: ${mdPath}`);
    process.exit(1);
  }
  const fileName = opts.name ?? mdPath.split(/[\\/]/).pop() ?? 'upload.md';

  const pdfPath = resolvePath(opts.fixturesDir ?? process.cwd(), opts.pdf);
  let pdfBuffer: Buffer | undefined;
  if (pdfPath) {
    if (!existsSync(pdfPath)) {
      console.error(`PDF companion file not found: ${pdfPath}`);
      process.exit(1);
    }
    const pdfStats = statSync(pdfPath);
    if (!pdfStats.isFile()) {
      console.error(`PDF companion path is not a file: ${pdfPath}`);
      process.exit(1);
    }
    if (pdfStats.size > maxPdfBytes) {
      console.error(`PDF companion exceeds maximum size of ${maxPdfBytes} bytes: ${pdfPath}`);
      process.exit(1);
    }
    pdfBuffer = readFileSync(pdfPath);
    if (pdfBuffer.length > maxPdfBytes) {
      console.error(`PDF companion exceeds maximum size of ${maxPdfBytes} bytes: ${pdfPath}`);
      process.exit(1);
    }
    if (!isPdf(pdfBuffer)) {
      console.error(`PDF companion is not a valid PDF: ${pdfPath}`);
      process.exit(1);
    }
  }

  if (opts.upload === undefined) {
    const parsed = markdownParser.parseChunkedMarkdown(mdText, opts.delimiter);
    console.log(`Parsed ${parsed.length} chunk(s) from ${mdPath}`);
    parsed.forEach((chunk: { sectionTitle?: string | null; page?: number | null; source?: string | null; content: string }, index: number) => {
      console.log(
        `  #${index} title=${chunk.sectionTitle ?? '(none)'} page=${chunk.page ?? '(none)'} source=${chunk.source ?? '(none)'} chars=${chunk.content.length}`,
      );
    });
    if (opts.dryRun) {
      console.log('--dry-run: no upload performed.');
      return;
    }
  }

  const uploadFn =
    opts.upload ??
    (async (input: { fileName: string; mdText: string; delimiter?: string | undefined; uploadedBy: string; pdfBuffer?: Buffer | undefined }) => {
      const { uploadPrechunkedMarkdown } = await import('@app/application/rag/ingest-prechunked');
      const deps = await buildUploadDeps();
      const result = await uploadPrechunkedMarkdown(
        { fileName: input.fileName, mdText: input.mdText, delimiter: input.delimiter, uploadedBy: input.uploadedBy, pdfBuffer: input.pdfBuffer },
        deps,
      );
      if (!result.ok) throw result.error;
      return result.value;
    });

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
  const REPO_ROOT = getRepoRoot();
  const envPath = resolve(REPO_ROOT, '.env.local');
  try {
    const loaded = loadEnv({ path: envPath });
    if (loaded.error && existsSync(envPath)) {
      warn(`Failed to load .env.local: ${loaded.error.message}`);
    }
  } catch (err) {
    if (existsSync(envPath)) {
      warn(`Failed to load .env.local: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
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

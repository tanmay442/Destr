import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { PDF_PARSE_MAX_BYTES as DEFAULT_PDF_PARSE_MAX_BYTES } from '@app/domain';
import { loadEnvConfig } from '@app/infrastructure/config';
import { createBlobStorage } from '@app/infrastructure/storage';
import { warn, getRepoRoot } from './common';
import { buildIngestDeps } from './deps';
import { isMainModule } from '../is-main-module';

export interface SeedParseResult {
  dir: string;
  userId?: string | undefined;
  yes?: boolean | undefined;
}

function parseRequiredValue(value: string | undefined, option: string): string {
  if (value === undefined || value === '' || value.startsWith('--')) {
    throw new Error(`Missing value for ${option}`);
  }
  return value;
}

export function parseSeedArgs(argv: string[]): SeedParseResult {
  let dir: string | undefined;
  let yes: boolean | undefined;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i]!;
    if (argument.startsWith('--dir=')) {
      dir = parseRequiredValue(argument.slice('--dir='.length), '--dir');
    } else if (argument === '--dir') {
      dir = parseRequiredValue(argv[++i], '--dir');
    } else if (argument === '--yes' || argument === '-y') {
      yes = true;
    } else if (argument.startsWith('--')) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      positional.push(argument);
    }
  }

  if (positional.length > 1) {
    throw new Error(`Unexpected argument: ${positional[1]}`);
  }
  if (!dir && process.env.SEED_DOCS_DIR) dir = process.env.SEED_DOCS_DIR;
  if (!dir) dir = './documents';
  const userId = positional[0] || process.env.SEED_USER_ID || undefined;
  const result: SeedParseResult = { dir, userId };
  if (yes) result.yes = true;
  return result;
}

export interface SeedOptions {
  userId?: string | undefined;
  fixturesDir?: string | undefined;
  yes?: boolean | undefined;
  skipEnvCheck?: boolean | undefined;
  ingest?: (input: { fileName: string; buffer: Buffer; uploadedBy: string }) => Promise<{
    documentId: number;
    chunks: number;
    status: 'inserted' | 'updated' | 'unchanged';
  }>;
  storeBlob?: (documentId: number, buffer: Buffer, fileName: string) => Promise<void>;
  deleteDocument?: (documentId: number) => Promise<void>;
}

export interface SeedResult {
  total: number;
  succeeded: number;
  failed: number;
}

function safeSeedName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

function isPdf(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.toString('utf8', 0, 4) === '%PDF';
}

function getPdfParseMaxBytes(): number {
  const configured = loadEnvConfig({ get: (key) => process.env[key] }).PDF_PARSE_MAX_BYTES;
  return typeof configured === 'number' && Number.isFinite(configured)
    ? configured
    : DEFAULT_PDF_PARSE_MAX_BYTES;
}

function isNonLocalDbUrl(url?: string): boolean {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1';
  } catch {
    return true;
  }
}

export async function runSeed(opts: SeedOptions = {}): Promise<SeedResult> {
  const userId = opts.userId ?? process.env.SEED_USER_ID ?? 'seed-script';
  const fixturesDir = opts.fixturesDir ?? './documents';

  let files: string[];
  try {
    files = readdirSync(fixturesDir).filter((f) => f.toLowerCase().endsWith('.pdf'));
  } catch (err) {
    throw new Error(
      `Cannot read fixtures directory ${fixturesDir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (files.length === 0) {
    throw new Error(`No PDFs found in ${fixturesDir}`);
  }

  const isProd = process.env.NODE_ENV === 'production';
  const isRemote = isNonLocalDbUrl(process.env.DATABASE_URL);
  const allowEnv = process.env.SEED_ALLOWED_ENV === '1' || process.env.SEED_ALLOWED_ENV === 'true';

  if ((isProd || isRemote) && !opts.yes && !opts.skipEnvCheck && !allowEnv) {
    throw new Error(
      'Seeding against a non-local or production environment is blocked. Pass --yes or set SEED_ALLOWED_ENV=1 to proceed.',
    );
  }

  const ingestFile = opts.ingest
    ? opts.ingest
    : await (async () => {
        const { ingestFile: rawIngest } = await import('@app/application/rag/ingest');
        const ingestDeps = await buildIngestDeps();
        return (input: { fileName: string; buffer: Buffer; uploadedBy: string }) =>
          rawIngest(input, ingestDeps).then((r) => {
            if (!r.ok) throw r.error;
            return r.value;
          });
      })();

  const storeBlob = opts.storeBlob ?? (async (documentId: number, buffer: Buffer, fileName: string) => {
    const Db = await import('@app/infrastructure/db');
    const blobStorage = createBlobStorage();
    const key = `docs/${documentId}/${safeSeedName(fileName)}`;
    await blobStorage.put(key, buffer, 'application/pdf');
    await Db.setDocumentStorageKey(documentId, key);
  });

  const deleteDocument = opts.deleteDocument ?? (async (documentId: number) => {
    const Db = await import('@app/infrastructure/db');
    await Db.deleteDocumentById(documentId);
  });

  let succeeded = 0;
  let failed = 0;

  for (const name of files) {
    try {
      const buffer = readFileSync(join(fixturesDir, name));
      const maxPdfParseBytes = getPdfParseMaxBytes();
      if (buffer.length > maxPdfParseBytes) {
        throw new Error(`File size (${buffer.length} bytes) exceeds maximum allowed size (${maxPdfParseBytes} bytes)`);
      }
      if (!isPdf(buffer)) {
        throw new Error('Only PDF files are supported');
      }

      const result = await ingestFile({ fileName: name, buffer, uploadedBy: userId });
      if (result.status !== 'unchanged') {
        try {
          await storeBlob(result.documentId, buffer, name);
        } catch (blobErr) {
          await deleteDocument(result.documentId).catch(() => {});
          throw blobErr;
        }
      }

      console.log(
        `${name}: status=${result.status} documentId=${result.documentId} chunks=${result.chunks}`,
      );
      succeeded++;
    } catch (err: unknown) {
      failed++;
      console.error(
        `${name}: seed failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { total: files.length, succeeded, failed };
}

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
      warn(
        `Failed to load .env.local: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const { dir, userId, yes } = parseSeedArgs(process.argv.slice(2));
  const absoluteDir = resolve(REPO_ROOT, dir);
  console.log(`Seeding PDFs from ${absoluteDir}`);

  runSeed({ userId, fixturesDir: absoluteDir, yes })
    .then((res) => {
      if (res.failed > 0) {
        console.error(`Seeding finished with ${res.failed} error(s).`);
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error('seed failed:', err);
      process.exit(1);
    });
}

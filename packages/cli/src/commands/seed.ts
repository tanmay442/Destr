import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PDF_PARSE_MAX_BYTES } from '@app/infrastructure/config';
import { createBlobStorage } from '@app/infrastructure/storage';
import { warn, getRepoRoot } from './common';
import { buildIngestDeps } from './deps';
import { isMainModule } from '../is-main-module';

export interface SeedParseResult {
  dir: string;
  userId?: string | undefined;
  yes?: boolean | undefined;
}

export function parseSeedArgs(argv: string[]): SeedParseResult {
  let dir: string | undefined;
  let yes: boolean | undefined;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--dir=')) {
      dir = a.slice('--dir='.length);
    } else if (a === '--dir') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        dir = next;
        i++;
      }
    } else if (a === '--yes' || a === '-y') {
      yes = true;
    } else if (!a.startsWith('--')) {
      positional.push(a);
    }
  }

  if (!dir && process.env.SEED_DOCS_DIR) dir = process.env.SEED_DOCS_DIR;
  if (!dir) dir = './documents';
  const res: SeedParseResult = { dir, userId: positional[0] };
  if (yes) res.yes = true;
  return res;
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

function isNonLocalDbUrl(url?: string): boolean {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname;
    return hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1';
  } catch {
    return true;
  }
}

export async function runSeed(opts: SeedOptions = {}): Promise<SeedResult> {
  const userId = opts.userId ?? 'seed-script';
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
      if (buffer.length > PDF_PARSE_MAX_BYTES) {
        throw new Error(`File size (${buffer.length} bytes) exceeds maximum allowed size (${PDF_PARSE_MAX_BYTES} bytes)`);
      }

      const result = await ingestFile({ fileName: name, buffer, uploadedBy: userId });
      try {
        await storeBlob(result.documentId, buffer, name);
      } catch (blobErr) {
        await deleteDocument(result.documentId).catch(() => {});
        throw blobErr;
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
    process.loadEnvFile(envPath);
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

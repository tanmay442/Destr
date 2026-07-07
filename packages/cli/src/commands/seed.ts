// `rag-agent seed [--dir=...]` — read every PDF in the given
// directory and run it through the ingest pipeline. Mirrors
// what the admin upload flow does at runtime, so the seeded
// data is indistinguishable from production uploads.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SeedParseResult {
  dir: string;
  userId?: string;
}

export function parseSeedArgs(argv: string[]): SeedParseResult {
  let dir: string | undefined;
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
    } else if (!a.startsWith('--')) {
      positional.push(a);
    }
  }
  if (!dir && process.env.SEED_DOCS_DIR) dir = process.env.SEED_DOCS_DIR;
  if (!dir) dir = './documents';
  return { dir, userId: positional[0] };
}

export interface SeedOptions {
  userId?: string;
  fixturesDir?: string;
  ingest?: (input: { fileName: string; buffer: Buffer; uploadedBy: string }) => Promise<{
    documentId: number;
    chunks: number;
    status: 'inserted' | 'updated' | 'unchanged';
  }>;
  saveBlob?: (documentId: number, buffer: Buffer) => Promise<void>;
}

export async function runSeed(opts: SeedOptions = {}): Promise<void> {
  const userId = opts.userId ?? 'seed-script';
  const fixturesDir = opts.fixturesDir ?? './documents';
  let files: string[];
  try {
    files = readdirSync(fixturesDir).filter((f) => f.toLowerCase().endsWith('.pdf'));
  } catch {
    console.error(`Cannot read fixtures directory: ${fixturesDir}`);
    process.exit(1);
  }
  if (files.length === 0) {
    console.error(`No PDFs found in ${fixturesDir}`);
    process.exit(1);
  }
  // Lazy-load the ingest pipeline + db + schema. We do this here
  // (and not at module top) so the file works the same way from
  // both the CLI and the legacy tsx scripts/ entrypoint — and so
  // unit tests can inject a fake `ingest` without touching the
  // real database adapter.
  const { ingestFile } = opts.ingest
    ? { ingestFile: opts.ingest }
    : await (async () => {
        const { ingestFile: rawIngest } = await import('@app/application/rag/ingest');
        const { Db, Llm, Pdf } = await import('@app/infrastructure');
        const { createHash } = await import('node:crypto');
        const ingestDeps = {
          documents: {
            findByName: (n: string) => Db.findDocumentByName(n),
            findById: (id: number) => Db.findDocumentById(id),
            saveBlob: (id: number, b: Buffer) => Db.updateDocumentBlob(id, b),
            insert: (i: { fileName: string; fileHash: string; uploadedBy: string }) => Db.insertDocument(i),
            deleteById: (id: number) => Db.deleteDocumentById(id),
            softDelete: (id: number, at: Date) => Db.softDeleteDocument(id, at),
            restore: (id: number) => Db.restoreDocument(id),
            listDeletedSince: () => Promise.resolve([]),
            updateBlob: (id: number, b: Buffer) => Db.updateDocumentBlob(id, b),
            list: Db.listDocuments,
            countChunksForDocuments: Db.countChunksForDocuments,
            countChunksForAll: Db.countChunksForAll,
          },
          chunks: {
            insertMany: (rows: Array<{ documentId: number; content: string; embedding: number[] }>) => Db.insertChunks(rows),
            countForDocuments: (ids: number[]) => Db.countChunksForDocuments(ids),
            countForAll: () => Db.countChunksForAll(),
            countForDocument: (id: number) => Db.countChunksForDocument(id),
            recountAll: () => Db.recountChunksForAll(),
            searchByVector: (embedding: number[], opts: { threshold: number; limit: number }) => Db.searchChunksByVector(embedding, opts),
          },
          embeddings: Llm.getEmbeddingService(),
          hasher: { sha256: (b: Buffer) => createHash('sha256').update(b).digest('hex') },
          pdfParser: Pdf.pdfParseParser,
          textSplitter: Pdf.langchainSplitter,
        };
        return {
          ingestFile: (input: { fileName: string; buffer: Buffer; uploadedBy: string }) =>
            rawIngest(input, ingestDeps).then((r) => {
              if (!r.ok) throw r.error;
              return r.value;
            }),
        };
      })();
  const saveBlob = opts.saveBlob ?? (async (documentId: number, buffer: Buffer) => {
    const { Db } = await import('@app/infrastructure');
    const { db } = Db;
    const { documents } = Db.schema;
    const { eq } = await import('drizzle-orm');
    await db.update(documents).set({ blob: buffer }).where(eq(documents.id, documentId));
  });
  for (const name of files) {
    const buffer = readFileSync(join(fixturesDir, name));
    const result = await ingestFile({ fileName: name, buffer, uploadedBy: userId });
    await saveBlob(result.documentId, buffer);
    console.log(
      `${name}: status=${result.status} documentId=${result.documentId} chunks=${result.chunks}`,
    );
  }
}

// CLI entry — only run when this module is the program root.
import { isMainModule } from '../is-main-module';

if (isMainModule()) {
  // Load .env.local so DATABASE_URL and AI_STUDIO_KEY are
  // available when running via `pnpm seed` (CLI entry below).
  try {
    process.loadEnvFile('.env.local');
  } catch {
    // .env.local may not exist; rely on env vars from the caller.
  }
  const HERE = dirname(fileURLToPath(import.meta.url));
  const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
  const { dir, userId } = parseSeedArgs(process.argv.slice(2));
  const absoluteDir = resolve(REPO_ROOT, dir);
  console.log(`Seeding PDFs from ${absoluteDir}`);
  runSeed({ userId, fixturesDir: absoluteDir }).catch((err) => {
    console.error('seed failed:', err);
    process.exit(1);
  });
}

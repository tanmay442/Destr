// Backfill: move existing `documents.blob` (bytea) binaries into the
// object store and set `documents.storage_key`. Idempotent — rows that
// already have a `storage_key` are skipped.
//
// The `blob` column is intentionally KEPT in the schema for now; it is
// dropped in a later migration once this backfill has run everywhere.
//
// Usage:
//   pnpm tsx scripts/backfill-blobs.ts
import 'dotenv/config';
import { and, isNull, isNotNull } from 'drizzle-orm';
import { Db, Storage } from '@app/infrastructure';

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

async function main() {
  const blobStorage = Storage.createBlobStorage();
  const { db, schema, setDocumentStorageKey } = Db;
  const documents = schema.documents;

  const rows = await db.query.documents.findMany({
    where: and(isNull(documents.storageKey), isNotNull(documents.blob)),
  });

  if (rows.length === 0) {
    console.log('backfill: no documents to migrate.');
    return;
  }
  console.log(`backfill: ${rows.length} document(s) to migrate.`);

  let migrated = 0;
  let skipped = 0;
  for (const row of rows) {
    const buffer = row.blob;
    if (!buffer || buffer.length === 0) {
      console.log(`  skip doc ${row.id} (${row.fileName}): empty blob`);
      skipped++;
      continue;
    }
    const key = `docs/${row.id}/${safeName(row.fileName)}`;
    try {
      await blobStorage.put(key, buffer, 'application/pdf');
      await setDocumentStorageKey(row.id, key);
      console.log(`  ok doc ${row.id} -> ${key} (${buffer.length} bytes)`);
      migrated++;
    } catch (err) {
      console.error(`  FAIL doc ${row.id} (${row.fileName}):`, err);
      throw err;
    }
  }
  console.log(`backfill done: migrated=${migrated} skipped=${skipped}`);
}

main().catch((err) => {
  console.error('backfill-blobs failed:', err);
  process.exit(1);
});

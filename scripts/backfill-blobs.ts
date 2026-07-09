// Move documents.blob binaries into the object store; set storage_key.
// Idempotent — skips rows that already have a storage_key.
// `blob` column is kept until a later migration drops it post-backfill.
// Usage: pnpm tsx scripts/backfill-blobs.ts
import 'dotenv/config';
import { Db, Storage } from '@app/infrastructure';
const { and, isNull, isNotNull } = Db;

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

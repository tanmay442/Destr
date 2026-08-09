import 'dotenv/config';
import { Db, Storage } from '@app/infrastructure';
const { and, isNull, isNotNull } = Db;

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

const BATCH_SIZE = 100;

async function main() {
  const blobStorage = Storage.createBlobStorage();
  const { db, schema, setDocumentStorageKey } = Db;
  const documents = schema.documents;
  const pending = and(isNull(documents.storageKey), isNotNull(documents.blob));

  let migrated = 0;
  let skipped = 0;
  let lastId = 0;
  // Keyset pagination: `id > lastId` stays stable even as the filter mutates
  // while storage_key is set on each migrated row.
  let batch = await db.query.documents.findMany({
    where: (cols, { and: andFn, gt: gtFn }) =>
      andFn(pending, gtFn(cols.id, lastId)),
    orderBy: (cols, { asc }) => [asc(cols.id)],
    limit: BATCH_SIZE,
  });
  if (batch.length === 0) {
    console.log('backfill: no documents to migrate.');
    return;
  }
  console.log(`backfill: migrating documents in batches of ${BATCH_SIZE}.`);

  while (batch.length > 0) {
    for (const row of batch) {
      const buffer = row.blob;
      if (!buffer || buffer.length === 0) {
        console.log(`  skip doc ${row.id} (${row.fileName}): empty blob`);
        skipped++;
        continue;
      }
      const key = `docs/${row.id}/${safeName(row.fileName)}`;
      try {
        await blobStorage.put(key, buffer, 'application/pdf');
        try {
          await setDocumentStorageKey(row.id, key);
        } catch (err) {
          await blobStorage.delete(key).catch(() => {});
          throw err;
        }
        console.log(`  ok doc ${row.id} -> ${key} (${buffer.length} bytes)`);
        migrated++;
      } catch (err) {
        console.error(`  FAIL doc ${row.id} (${row.fileName}):`, err);
        throw err;
      }
    }
    lastId = batch[batch.length - 1]?.id ?? lastId;
    batch = await db.query.documents.findMany({
      where: (cols, { and: andFn, gt: gtFn }) =>
        andFn(pending, gtFn(cols.id, lastId)),
      orderBy: (cols, { asc }) => [asc(cols.id)],
      limit: BATCH_SIZE,
    });
  }

  const remaining = await db.query.documents.findMany({
    where: pending,
    columns: { id: true },
    limit: 1,
  });
  if (remaining.length > 0) {
    throw new Error(
      `backfill incomplete: ${remaining.length}+ documents still lack a storage key`,
    );
  }
  console.log(`backfill done: migrated=${migrated} skipped=${skipped}`);
}

main().catch((err) => {
  console.error('backfill-blobs failed:', err);
  process.exit(1);
});

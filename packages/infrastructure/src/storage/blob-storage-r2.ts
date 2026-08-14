import { createS3FamilyBlobStorage } from './blob-storage-s3-family';
import type { BlobStorage } from '@app/domain';
import { registerBlobStorageProvider } from './blob-storage-registry';

export function createR2BlobStorage(): BlobStorage {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error('R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET must be set.');
  }
  return createS3FamilyBlobStorage({
    bucket,
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
}

registerBlobStorageProvider('r2', createR2BlobStorage);

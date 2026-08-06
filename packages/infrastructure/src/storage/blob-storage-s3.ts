import { createS3FamilyBlobStorage } from './blob-storage-s3-family';
import type { BlobStorage } from '@app/domain';

// Also works with MinIO via S3_ENDPOINT.
export function createS3BlobStorage(): BlobStorage {
  const region = process.env.S3_REGION;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  const bucket = process.env.S3_BUCKET;
  if (!region || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error('S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET must be set.');
  }
  return createS3FamilyBlobStorage({
    bucket,
    region,
    ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT, forcePathStyle: true } : {}),
    credentials: { accessKeyId, secretAccessKey },
  });
}

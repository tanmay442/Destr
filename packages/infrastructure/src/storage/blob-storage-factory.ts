import type { BlobStorage } from '@app/domain';
import './blob-storage-fs';
import './blob-storage-r2';
import './blob-storage-s3';
import { blobStorageRegistry } from './blob-storage-registry';
import { createFilesystemBlobStorage } from './blob-storage-fs';
import { createR2BlobStorage } from './blob-storage-r2';
import { createS3BlobStorage } from './blob-storage-s3';

export function createBlobStorage(): BlobStorage {
  const provider = process.env.BLOB_STORAGE_PROVIDER ?? 'filesystem';
  const factory = blobStorageRegistry.get(provider);
  if (!factory) throw new Error(`Unknown BLOB_STORAGE_PROVIDER: ${provider}`);
  return factory();
}

export { createFilesystemBlobStorage, createR2BlobStorage, createS3BlobStorage };
export type { S3FamilyConfig } from './blob-storage-s3-family';

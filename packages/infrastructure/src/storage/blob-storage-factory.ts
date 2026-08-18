import type { BlobStorage } from '@app/domain';
import './blob-storage-fs';
import './blob-storage-r2';
import './blob-storage-s3';
import { blobStorageRegistry } from './blob-storage-registry';
import { createFilesystemBlobStorage } from './blob-storage-fs';
import { createR2BlobStorage } from './blob-storage-r2';
import { createS3BlobStorage } from './blob-storage-s3';

export function createBlobStorage(): BlobStorage {
  const isProduction = process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';
  const isNextBuild = process.env.NEXT_PHASE === 'phase-production-build';
  const provider = process.env.BLOB_STORAGE_PROVIDER;
  if (!provider) {
    if (isProduction && !isNextBuild) {
      throw new Error(
        'BLOB_STORAGE_PROVIDER is not set. Production requires an explicit provider (r2 or s3); the filesystem backend stores uploads on ephemeral local disk.',
      );
    }
    return createFilesystemBlobStorage();
  }
  if (isProduction && provider === 'filesystem' && !process.env.BLOB_FS_DIR) {
    throw new Error(
      'BLOB_STORAGE_PROVIDER=filesystem is refused in production unless BLOB_FS_DIR points to a persistent volume.',
    );
  }
  const factory = blobStorageRegistry.get(provider);
  if (!factory) throw new Error(`Unknown BLOB_STORAGE_PROVIDER: ${provider}`);
  return factory();
}

export { createFilesystemBlobStorage, createR2BlobStorage, createS3BlobStorage };
export type { S3FamilyConfig } from './blob-storage-s3-family';

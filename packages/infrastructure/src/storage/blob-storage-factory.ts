import type { BlobStorage } from '@app/domain';
import { createFilesystemBlobStorage } from './blob-storage-fs';
import { createR2BlobStorage } from './blob-storage-r2';
import { createS3BlobStorage } from './blob-storage-s3';

export function createBlobStorage(): BlobStorage {
  const provider = process.env.BLOB_STORAGE_PROVIDER ?? 'filesystem';
  switch (provider) {
    case 'filesystem':
      return createFilesystemBlobStorage();
    case 'r2':
      return createR2BlobStorage();
    case 's3':
      return createS3BlobStorage();
    default:
      throw new Error(`Unknown BLOB_STORAGE_PROVIDER: ${provider}`);
  }
}

export { createFilesystemBlobStorage, createR2BlobStorage, createS3BlobStorage };
